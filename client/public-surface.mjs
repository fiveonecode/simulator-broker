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
  "host-config.json",
  "idle-policy.json",
  "registry.json",
]);

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

function textFileContent(filePath) {
  const content = fs.readFileSync(filePath);
  if (content.includes(0)) {
    return null;
  }
  return content.toString("utf8");
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
  const resolvedDenylistPath = denylistPath ?? path.join(resolvedRoot, LOCAL_DENYLIST_NAME);
  const denylistRules = localDenylistRules(resolvedDenylistPath);
  const builtInRules = [
    ...(typeof homePath === "string" && homePath.trim() !== ""
      ? [{ label: "local-home-path", value: path.resolve(homePath) }]
      : []),
  ];
  const issues = [];

  for (const relativeFile of candidateFiles) {
    const normalizedRelativeFile = relativeFile.split(path.sep).join("/");
    if (PROHIBITED_TRACKED_BASENAMES.has(path.posix.basename(normalizedRelativeFile))) {
      issues.push({
        line: 1,
        path: normalizedRelativeFile,
        rule: "prohibited-local-artifact",
      });
      continue;
    }
    const absoluteFile = path.resolve(resolvedRoot, relativeFile);
    if (!absoluteFile.startsWith(`${resolvedRoot}${path.sep}`) || !fs.existsSync(absoluteFile) || !fs.statSync(absoluteFile).isFile()) {
      continue;
    }
    const text = textFileContent(absoluteFile);
    if (text === null) {
      continue;
    }
    for (const rule of builtInRules) {
      const offset = text.indexOf(rule.value);
      if (offset !== -1) {
        issues.push({
          line: lineNumberForOffset(text, offset),
          path: normalizedRelativeFile,
          rule: rule.label,
        });
      }
    }
    for (const rule of denylistRules) {
      const offset = text.indexOf(rule.value);
      if (offset !== -1) {
        issues.push({
          line: lineNumberForOffset(text, offset),
          path: normalizedRelativeFile,
          rule: `local-denylist-rule-${rule.index}`,
        });
      }
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
