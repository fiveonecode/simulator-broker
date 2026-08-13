#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const LOCAL_DENYLIST_NAME = ".public-safety.local";
const PROHIBITED_TRACKED_BASENAMES = new Set([
  ".DS_Store",
  LOCAL_DENYLIST_NAME,
  "app-snapshot.json",
  "brokerd.json",
  "brokerd.log",
  "events.ndjson",
  "host-config.json",
  "idle-policy.json",
  "known-projects.json",
  "registry.json",
]);

const PROHIBITED_TRACKED_STATE_DIRS = new Set([
  "audit-append-failures",
  "capacity-transactions",
  "evidence",
  "leases",
  "locks",
  "pins",
]);

function isProhibitedTrackedArtifact(relativeFile) {
  if (PROHIBITED_TRACKED_BASENAMES.has(path.posix.basename(relativeFile))) {
    return true;
  }
  const segments = relativeFile.split("/");
  return segments.some((segment) => PROHIBITED_TRACKED_STATE_DIRS.has(segment));
}

function lineNumberForOffset(text, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) {
      line += 1;
    }
  }
  return line;
}

function localDenylistRules(denylistPath) {
  if (!denylistPath || !fs.existsSync(denylistPath)) {
    return [];
  }
  return fs.readFileSync(denylistPath, "utf8")
    .split(/\r?\n/u)
    .map((value, index) => ({ index: index + 1, value: canonicalText(value.trim()) }))
    .filter((rule) => rule.value !== "" && !rule.value.startsWith("#"));
}

function defaultCandidateFiles(root) {
  const output = execFileSync("git", [
    "ls-files",
    "-z",
    "--cached",
    "--exclude-standard",
  ], {
    cwd: root,
    encoding: "utf8",
  });
  return output.split("\0").filter(Boolean);
}

function defaultCandidateIndexModes(root) {
  const output = execFileSync("git", [
    "ls-files",
    "-sz",
    "--cached",
    "--exclude-standard",
  ], {
    cwd: root,
    encoding: "utf8",
  });
  const modes = new Map();
  for (const entry of output.split("\0")) {
    if (!entry) {
      continue;
    }
    const separatorIndex = entry.indexOf("\t");
    if (separatorIndex === -1) {
      continue;
    }
    const metadata = entry.slice(0, separatorIndex).split(/\s+/u);
    const relativeFile = entry.slice(separatorIndex + 1);
    if (metadata[0] && relativeFile) {
      modes.set(relativeFile, metadata[0]);
    }
  }
  return modes;
}

function decodeUtf16BigEndian(content) {
  const littleEndian = Buffer.allocUnsafe(content.length);
  for (let index = 0; index + 1 < content.length; index += 2) {
    littleEndian[index] = content[index + 1];
    littleEndian[index + 1] = content[index];
  }
  if (content.length % 2 === 1) {
    littleEndian[content.length - 1] = content[content.length - 1];
  }
  return littleEndian.toString("utf16le");
}

function textContentFromBuffer(content) {
  if (content.length >= 2 && content[0] === 0xff && content[1] === 0xfe) {
    return content.subarray(2).toString("utf16le");
  }
  if (content.length >= 2 && content[0] === 0xfe && content[1] === 0xff) {
    return decodeUtf16BigEndian(content.subarray(2));
  }
  if (content.includes(0)) {
    return null;
  }
  return content.toString("utf8");
}

function textFileContent(filePath) {
  return textContentFromBuffer(fs.readFileSync(filePath));
}

function indexBlobContent(root, relativeFile) {
  try {
    return textContentFromBuffer(execFileSync("git", [
      "cat-file",
      "blob",
      `:${relativeFile}`,
    ], {
      cwd: root,
    }));
  } catch {
    return null;
  }
}

function isHomePathBoundary(text, offset, value) {
  const before = offset > 0 ? text[offset - 1] : "";
  const after = text[offset + value.length] ?? "";
  const pathFragment = /[A-Za-z0-9._~\\/-]/u;
  const uriPrefixBoundary = /(?:^|[^A-Za-z0-9._~\\/-])[A-Za-z][A-Za-z0-9+.-]*:\/\/$/u;
  const hasUriPrefixBoundary = before === "/" && uriPrefixBoundary.test(text.slice(0, offset));
  const afterSentencePeriod = after === "."
    && !pathFragment.test(text[offset + value.length + 1] ?? "");
  return (!pathFragment.test(before) || hasUriPrefixBoundary)
    && (after === "" || after === path.posix.sep || !pathFragment.test(after) || afterSentencePeriod);
}

function indexOfHomePath(text, value) {
  let offset = text.indexOf(value);
  while (offset !== -1) {
    if (isHomePathBoundary(text, offset, value)) {
      return offset;
    }
    offset = text.indexOf(value, offset + value.length);
  }
  return -1;
}

function normalizeJsonEscapes(text) {
  let normalized = "";
  const originalOffsets = [];
  const pushDecoded = (decoded, originalOffset) => {
    for (let offset = 0; offset < decoded.length; offset += 1) {
      originalOffsets.push(originalOffset);
    }
    normalized += decoded;
  };
  const jsonEscapes = new Map([
    ['"', '"'],
    ["\\", "\\"],
    ["/", "/"],
    ["b", "\b"],
    ["f", "\f"],
    ["n", "\n"],
    ["r", "\r"],
    ["t", "\t"],
  ]);

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\\") {
      originalOffsets.push(index);
      normalized += text[index];
      continue;
    }

    const escape = text[index + 1];
    if (jsonEscapes.has(escape)) {
      pushDecoded(jsonEscapes.get(escape), index);
      index += 1;
      continue;
    }

    if (escape === "u") {
      const hex = text.slice(index + 2, index + 6);
      if (/^[0-9A-Fa-f]{4}$/u.test(hex)) {
        const highCodeUnit = Number.parseInt(hex, 16);
        const lowEscape = text.slice(index + 6, index + 8);
        const lowHex = text.slice(index + 8, index + 12);
        if (highCodeUnit >= 0xd800
          && highCodeUnit <= 0xdbff
          && lowEscape === "\\u"
          && /^[0-9A-Fa-f]{4}$/u.test(lowHex)) {
          const lowCodeUnit = Number.parseInt(lowHex, 16);
          if (lowCodeUnit >= 0xdc00 && lowCodeUnit <= 0xdfff) {
            pushDecoded(String.fromCharCode(highCodeUnit, lowCodeUnit), index);
            index += 11;
            continue;
          }
        }
        pushDecoded(String.fromCharCode(highCodeUnit), index);
        index += 5;
        continue;
      }
    }

    originalOffsets.push(index);
    normalized += text[index];
  }
  return {
    normalized,
    originalOffsets,
  };
}

function canonicalTextWithOffsets(text, sourceOffsets) {
  let normalized = "";
  const originalOffsets = [];
  const pushSegment = (segment, index) => {
    const normalizedSegment = canonicalText(segment);
    const originalOffset = sourceOffsets?.[index] ?? index;
    for (let segmentOffset = 0; segmentOffset < normalizedSegment.length; segmentOffset += 1) {
      originalOffsets.push(originalOffset);
    }
    normalized += normalizedSegment;
  };

  if (typeof Intl?.Segmenter === "function") {
    const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
    for (const { segment, index } of segmenter.segment(text)) {
      pushSegment(segment, index);
    }
  } else {
    for (let index = 0; index < text.length;) {
      const start = index;
      let segment = text[index];
      index += 1;
      while (index < text.length && /\p{Mark}/u.test(text[index])) {
        segment += text[index];
        index += 1;
      }
      pushSegment(segment, start);
    }
  }

  return {
    normalized,
    originalOffsets,
  };
}

function indexOfCanonicalHomePath(text, value) {
  const { normalized, originalOffsets } = canonicalTextWithOffsets(text);
  const normalizedOffset = indexOfHomePath(normalized, value);
  return normalizedOffset === -1 ? -1 : originalOffsets[normalizedOffset];
}

function indexOfJsonEscapedHomePath(text, value) {
  const slashNormalized = normalizeJsonEscapes(text);
  const { normalized, originalOffsets } = canonicalTextWithOffsets(
    slashNormalized.normalized,
    slashNormalized.originalOffsets,
  );
  const normalizedOffset = indexOfHomePath(normalized, value);
  return normalizedOffset === -1 ? -1 : originalOffsets[normalizedOffset];
}

function indexOfJsonEscapedValue(text, value) {
  const canonicalValue = canonicalText(value);
  const jsonNormalized = normalizeJsonEscapes(text);
  const { normalized, originalOffsets } = canonicalTextWithOffsets(
    jsonNormalized.normalized,
    jsonNormalized.originalOffsets,
  );
  const normalizedOffset = normalized.indexOf(canonicalValue);
  return normalizedOffset === -1 ? -1 : originalOffsets[normalizedOffset];
}

function canonicalText(value) {
  return String(value).normalize("NFC");
}

export function scanPublicSurface({
  denylistPath,
  files,
  homePath = os.homedir(),
  root,
} = {}) {
  const resolvedRoot = path.resolve(root ?? execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim());
  const candidateFiles = files ?? defaultCandidateFiles(resolvedRoot);
  const scanIndexBlobs = files === undefined;
  const indexModes = scanIndexBlobs ? defaultCandidateIndexModes(resolvedRoot) : new Map();
  const resolvedDenylistPath = denylistPath ?? path.join(resolvedRoot, LOCAL_DENYLIST_NAME);
  const denylistRules = localDenylistRules(resolvedDenylistPath);
  const builtInRules = [
    ...(typeof homePath === "string" && homePath.trim() !== ""
      ? [{ label: "local-home-path", value: canonicalText(path.resolve(homePath)) }]
      : []),
  ];
  const issues = [];
  const issueKeys = new Set();

  const addIssue = (issue) => {
    const issueKey = `${issue.path}\0${issue.line}\0${issue.rule}`;
    if (issueKeys.has(issueKey)) {
      return;
    }
    issueKeys.add(issueKey);
    issues.push(issue);
  };

  const diagnosticPathFor = (normalizedRelativeFile) => {
    let diagnosticPath = normalizedRelativeFile;
    for (const rule of [...builtInRules, ...denylistRules]) {
      diagnosticPath = diagnosticPath.split(rule.value).join("[redacted]");
    }
    return diagnosticPath;
  };

  const scanText = (normalizedRelativeFile, text) => {
    if (text === null) {
      return;
    }
    const diagnosticPath = diagnosticPathFor(normalizedRelativeFile);
    for (const rule of builtInRules) {
      let offset = indexOfCanonicalHomePath(text, rule.value);
      if (offset === -1) {
        offset = indexOfJsonEscapedHomePath(text, rule.value);
      }
      if (offset !== -1) {
        addIssue({
          line: lineNumberForOffset(text, offset),
          path: diagnosticPath,
          rule: rule.label,
        });
      }
    }
    for (const rule of denylistRules) {
      const offset = indexOfJsonEscapedValue(text, rule.value);
      if (offset !== -1) {
        addIssue({
          line: lineNumberForOffset(text, offset),
          path: diagnosticPath,
          rule: `local-denylist-rule-${rule.index}`,
        });
      }
    }
  };

  const scanRelativePath = (normalizedRelativeFile) => {
    const diagnosticPath = diagnosticPathFor(normalizedRelativeFile);
    for (const rule of builtInRules) {
      if (normalizedRelativeFile.includes(rule.value)) {
        addIssue({
          line: 1,
          path: diagnosticPath,
          rule: rule.label,
        });
      }
    }
    for (const rule of denylistRules) {
      if (normalizedRelativeFile.includes(rule.value)) {
        addIssue({
          line: 1,
          path: diagnosticPath,
          rule: `local-denylist-rule-${rule.index}`,
        });
      }
    }
  };

  for (const relativeFile of candidateFiles) {
    const normalizedRelativeFile = canonicalText(relativeFile.split(path.sep).join("/"));
    const diagnosticPath = diagnosticPathFor(normalizedRelativeFile);
    scanRelativePath(normalizedRelativeFile);
    if (isProhibitedTrackedArtifact(normalizedRelativeFile)) {
      addIssue({
        line: 1,
        path: diagnosticPath,
        rule: "prohibited-local-artifact",
      });
      continue;
    }
    if (indexModes.get(relativeFile) === "120000") {
      addIssue({
        line: 1,
        path: diagnosticPath,
        rule: "prohibited-symlink",
      });
      continue;
    }
    const absoluteFile = path.resolve(resolvedRoot, relativeFile);
    if (!absoluteFile.startsWith(`${resolvedRoot}${path.sep}`)) {
      continue;
    }
    try {
      const fileStats = fs.lstatSync(absoluteFile);
      if (fileStats.isSymbolicLink()) {
        addIssue({
          line: 1,
          path: diagnosticPath,
          rule: "prohibited-symlink",
        });
        continue;
      }
      if (fileStats.isFile()) {
        scanText(normalizedRelativeFile, textFileContent(absoluteFile));
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    if (scanIndexBlobs) {
      scanText(normalizedRelativeFile, indexBlobContent(resolvedRoot, relativeFile));
    }
  }

  return {
    filesScanned: candidateFiles.length,
    issues,
    ok: issues.length === 0,
  };
}

function runCLI() {
  const report = scanPublicSurface();
  if (report.ok) {
    process.stdout.write(`Public surface verified (${report.filesScanned} files scanned).\n`);
    return;
  }
  process.stderr.write(`Public surface verification failed with ${report.issues.length} issue(s).\n`);
  for (const issue of report.issues) {
    process.stderr.write(`${issue.path}:${issue.line} [${issue.rule}]\n`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCLI();
}
