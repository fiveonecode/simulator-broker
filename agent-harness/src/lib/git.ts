// -------------------------------------------------------------------------- //
//                                  IMPORTS                                   //
// -------------------------------------------------------------------------- //

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { WorkingTreeStatusEntry } from "./types.js";

// -------------------------------------------------------------------------- //
//                              GIT OPERATIONS                                //
// -------------------------------------------------------------------------- //

type TrackedFileEntry = {
  mode: string;
  objectId: string;
};

export const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

function runGit(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  }).replace(/\r?\n$/, "");
}

function runGitRaw(repoRoot: string, args: string[]): Buffer {
  return execFileSync("git", args, {
    cwd: repoRoot,
    maxBuffer: GIT_MAX_BUFFER_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function sanitizeRefName(ref: string): string {
  return ref.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function getWorktreeEntryFingerprint(repoRoot: string, entry: Pick<WorkingTreeStatusEntry, "originalPath" | "path" | "status">): string {
  const hash = createHash("sha256");
  hash.update(entry.status, "utf8");
  hash.update("\0", "utf8");
  hash.update(entry.originalPath ?? "", "utf8");
  hash.update("\0", "utf8");
  hash.update(entry.path, "utf8");
  hash.update("\0", "utf8");

  for (const candidatePath of [entry.path, entry.originalPath]) {
    if (candidatePath === undefined) {
      continue;
    }

    const absolutePath = path.join(repoRoot, candidatePath);
    let stats;
    try {
      stats = lstatSync(absolutePath);
    } catch {
      continue;
    }

    hash.update(candidatePath, "utf8");
    hash.update("\0", "utf8");
    if (stats.isDirectory()) {
      hash.update("directory", "utf8");
      hash.update("\0", "utf8");
    } else if (stats.isSymbolicLink()) {
      hash.update("symlink", "utf8");
      hash.update("\0", "utf8");
      hash.update(readlinkSync(absolutePath), "utf8");
    } else {
      hash.update(readFileSync(absolutePath));
    }
    break;
  }

  return hash.digest("hex");
}

export function getTrackedFiles(repoRoot: string): string[] {
  const output = runGit(repoRoot, ["ls-files"]);
  return output.length === 0 ? [] : output.split("\n").filter(Boolean).sort();
}

export function getHeadCommit(repoRoot: string): string {
  return runGit(repoRoot, ["rev-parse", "HEAD"]);
}

export function getCommitMessage(repoRoot: string, sha: string): string {
  return runGit(repoRoot, ["show", "-s", "--format=%B", sha]);
}

export function getCommitShasForPaths(repoRoot: string, range: string, paths: string[]): string[] {
  if (paths.length === 0) {
    return [];
  }

  const output = runGit(repoRoot, ["log", "--format=%H", range, "--", ...paths]);
  return output.length === 0 ? [] : output.split("\n").filter(Boolean);
}

export function getFirstParentCommitShasForPaths(repoRoot: string, range: string, paths: string[]): string[] {
  if (paths.length === 0) {
    return [];
  }

  const output = runGit(repoRoot, ["log", "--first-parent", "--no-merges", "--format=%H", range, "--", ...paths]);
  return output.length === 0 ? [] : output.split("\n").filter(Boolean);
}

function parseNulSeparatedOutput(output: Buffer): string[] {
  if (output.length === 0) {
    return [];
  }

  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function getTrackedFileEntries(repoRoot: string, paths: string[]): Map<string, TrackedFileEntry> {
  const entries = new Map<string, TrackedFileEntry>();
  const output = parseNulSeparatedOutput(runGitRaw(repoRoot, ["ls-files", "-s", "-z", "--", ...paths]));
  for (const entry of output) {
    const tabIndex = entry.indexOf("\t");
    if (tabIndex === -1) {
      continue;
    }
    const metadata = entry.slice(0, tabIndex).split(" ");
    const filePath = entry.slice(tabIndex + 1);
    const mode = metadata[0];
    const objectId = metadata[1];
    if (mode && objectId) {
      entries.set(filePath, { mode, objectId });
    }
  }
  return entries;
}

function getWorktreeGitMode(filePath: string, trackedMode?: string): string {
  if (trackedMode === "160000") {
    return trackedMode;
  }

  const stats = lstatSync(filePath);
  if (stats.isSymbolicLink()) {
    return "120000";
  }
  if (stats.isFile()) {
    return (stats.mode & 0o111) === 0 ? "100644" : "100755";
  }
  if (stats.isDirectory()) {
    return "040000";
  }
  return trackedMode ?? "unknown";
}

function getSubmoduleCheckoutFingerprint(submodulePath: string): string {
  try {
    const head = runGit(submodulePath, ["rev-parse", "HEAD"]);
    const status = runGitRaw(submodulePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).toString("utf8");
    return JSON.stringify({ head, status });
  } catch {
    return "submodule-checkout-unavailable";
  }
}

export function getChangedFilesForRange(repoRoot: string, range: string, paths: string[] = []): string[] {
  const args = ["diff", "--name-only", range];
  if (paths.length > 0) {
    args.push("--", ...paths);
  }
  const output = runGit(repoRoot, args);
  return output.length === 0 ? [] : output.split("\n").filter(Boolean).sort();
}

export function getTaskTreeFingerprint(repoRoot: string, paths: string[]): string {
  const hash = createHash("sha256");
  const trackedEntries = getTrackedFileEntries(repoRoot, paths);
  const tracked = parseNulSeparatedOutput(runGitRaw(repoRoot, ["ls-files", "-z", "--", ...paths]));
  const untracked = parseNulSeparatedOutput(runGitRaw(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...paths]));
  const candidates = [...new Set([...tracked, ...untracked])].sort();

  hash.update(JSON.stringify([...paths].sort()), "utf8");
  hash.update("\0", "utf8");

  candidates.forEach((candidatePath) => {
    const absolutePath = path.join(repoRoot, candidatePath);
    hash.update(candidatePath, "utf8");
    hash.update("\0", "utf8");
    const trackedEntry = trackedEntries.get(candidatePath);
    const trackedMode = trackedEntry?.mode;
    let stats;
    try {
      stats = lstatSync(absolutePath);
    } catch {
      hash.update("missing", "utf8");
      hash.update("\0", "utf8");
      return;
    }
    hash.update(trackedMode ?? "untracked", "utf8");
    hash.update("\0", "utf8");
    hash.update(getWorktreeGitMode(absolutePath, trackedMode), "utf8");
    hash.update("\0", "utf8");
    if (trackedEntry?.mode === "160000") {
      hash.update(trackedEntry.objectId, "utf8");
      hash.update("\0", "utf8");
      if (stats.isDirectory() && existsSync(path.join(absolutePath, ".git"))) {
        hash.update(getSubmoduleCheckoutFingerprint(absolutePath), "utf8");
      }
    } else if (stats.isSymbolicLink()) {
      hash.update("symlink", "utf8");
      hash.update("\0", "utf8");
      hash.update(readlinkSync(absolutePath), "utf8");
    } else {
      if (stats.isDirectory()) {
        hash.update("directory", "utf8");
      } else {
        hash.update(readFileSync(absolutePath));
      }
    }
    hash.update("\0", "utf8");
  });

  return `sha256:${hash.digest("hex")}`;
}

export function getWorkingTreeStatus(repoRoot: string): WorkingTreeStatusEntry[] {
  const output = runGitRaw(repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);

  if (output.length === 0) {
    return [];
  }

  const records = output
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const entries: WorkingTreeStatusEntry[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const status = record.slice(0, 2);
    const candidate = record.slice(3);
    const isRenameOrCopy = status.includes("R") || status.includes("C");

    if (isRenameOrCopy) {
      const originalPath = records[index + 1];
      if (originalPath === undefined) {
        throw new Error(`Malformed git status --porcelain=v1 -z output: missing original path for ${candidate}.`);
      }

      entries.push({
        fingerprint: getWorktreeEntryFingerprint(repoRoot, {
          originalPath,
          path: candidate,
          status,
        }),
        originalPath,
        path: candidate,
        status,
      });
      index += 1;
      continue;
    }

    entries.push({
      fingerprint: getWorktreeEntryFingerprint(repoRoot, { path: candidate, status }),
      path: candidate,
      status,
    });
  }

  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export function getWorkingTreeChangedFiles(repoRoot: string): string[] {
  return getWorkingTreeStatus(repoRoot)
    .map((entry) => entry.path)
    .filter(Boolean)
    .sort();
}

export function prepareWorktreeForRef(repoRoot: string, ref: string): { cleanup: () => void; ref: string; repoPath: string } {
  runGit(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`]);

  const worktreePath = path.join(os.tmpdir(), `agent-harness-scorecard-${sanitizeRefName(ref)}-${Date.now()}`);
  runGit(repoRoot, ["worktree", "add", "--detach", worktreePath, ref]);

  const sourceNodeModulesPath = path.join(repoRoot, "agent-harness", "node_modules");
  const targetNodeModulesPath = path.join(worktreePath, "agent-harness", "node_modules");
  if (existsSync(sourceNodeModulesPath) && existsSync(targetNodeModulesPath) === false) {
    mkdirSync(path.dirname(targetNodeModulesPath), { recursive: true });
    symlinkSync(sourceNodeModulesPath, targetNodeModulesPath, "dir");
  }

  return {
    cleanup: () => {
      try {
        runGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
      } finally {
        rmSync(worktreePath, { force: true, recursive: true });
      }
    },
    ref,
    repoPath: worktreePath,
  };
}
