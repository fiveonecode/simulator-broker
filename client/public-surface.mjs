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
    .map((value, index) => ({ index: index + 1, value: value.trim() }))
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

function normalizeJsonSlashEscapes(text) {
  let normalized = "";
  const originalOffsets = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\\" && text[index + 1] === "/") {
      originalOffsets.push(index);
      normalized += "/";
      index += 1;
      continue;
    }
    originalOffsets.push(index);
    normalized += text[index];
  }
  return {
    normalized,
    originalOffsets,
  };
}

function indexOfJsonEscapedHomePath(text, value) {
  const { normalized, originalOffsets } = normalizeJsonSlashEscapes(text);
  const normalizedOffset = indexOfHomePath(normalized, value);
  return normalizedOffset === -1 ? -1 : originalOffsets[normalizedOffset];
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
      ? [{ label: "local-home-path", value: path.resolve(homePath) }]
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
    for (const rule of denylistRules) {
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
      let offset = indexOfHomePath(text, rule.value);
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
      const offset = text.indexOf(rule.value);
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
    const normalizedRelativeFile = relativeFile.split(path.sep).join("/");
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
