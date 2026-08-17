import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildHarnessCatalog } from "../src/lib/catalog.js";
import { getRepoRoot, loadVerifyProfiles } from "../src/lib/config.js";
import {
  getDetachedVerifyResultReadLimitBytes,
  getDetachedVerifyTimeoutMs,
} from "../src/lib/detached-verify.js";
import {
  buildDetachedRunBoundedLogScriptPath,
  buildDetachedRunWatchdogScriptPath,
  buildWindowsDetachedMonitorSpawnArgs,
  inspectDetachedRun,
  readDetachedRunArtifact,
  startDetachedRun,
  waitForDetachedRunEvent,
} from "../src/lib/detached-run.js";
import { DEFAULT_COMMAND_MAX_STDERR_BYTES, DEFAULT_COMMAND_MAX_STDOUT_BYTES, DEFAULT_COMMAND_TIMEOUT_MS, shellQuote } from "../src/lib/runtime.js";
import type { VerifyProfile } from "../src/lib/types.js";

describe("detached harness rollout", () => {
  const repoRoot = getRepoRoot();

  function isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function waitForPidToExit(pid: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && isPidAlive(pid)) {
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
    }
  }

  it("exposes detached commands while keeping status dependency-free", () => {
    const rootPackage = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const harnessPackage = JSON.parse(readFileSync(path.join(repoRoot, "agent-harness", "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(rootPackage.scripts["agent:detached-start"]).toContain("detached-start");
    expect(rootPackage.scripts["agent:detached-status"]).toBe("node ./scripts/agent_detached_status.cjs");
    expect(harnessPackage.scripts["detached-start"]).toBe("tsx src/cli.ts detached-start");
    expect(harnessPackage.scripts["detached-status"]).toBe("tsx src/cli.ts detached-status");
  });

  it("surfaces long-running commentary metadata from project profile config", () => {
    const temporaryRepoRoot = mkdtempSync(path.join(os.tmpdir(), "agent-harness-detached-metadata-"));
    const verifyDir = path.join(temporaryRepoRoot, ".agents", "verify");

    try {
      mkdirSync(verifyDir, { recursive: true });
      writeFileSync(
        path.join(temporaryRepoRoot, "package.json"),
        JSON.stringify({
          scripts: {
            "agent:detached-start": "agent-harness detached-start",
            "agent:detached-status": "agent-harness detached-status",
            "agent:verify": "agent-harness verify",
          },
        }),
      );
      writeFileSync(
        path.join(verifyDir, "long-running.yaml"),
        [
          "id: long-running",
          "proof_kind: contract",
          "longRunning: true",
          "commentaryPolicy: event-only",
          "covers_scenarios: []",
          "covers_boundaries: []",
          "commands:",
          "  - id: proof",
          "    run: npm test",
          "required_artifacts: []",
          "required_pass_signals:",
          "  - proof",
          "failure_patterns: []",
          "evidence_extractors:",
          "  - command-stdout",
          "",
        ].join("\n"),
      );

      const profiles = loadVerifyProfiles(temporaryRepoRoot);
      const catalog = buildHarnessCatalog(temporaryRepoRoot, [], profiles, []);

      expect(profiles[0]).toEqual(
        expect.objectContaining({
          commentaryPolicy: "event-only",
          longRunning: true,
        }),
      );
      expect(catalog.verificationProfiles[0]).toEqual(
        expect.objectContaining({
          commentaryPolicy: "event-only",
          longRunning: true,
        }),
      );
    } finally {
      rmSync(temporaryRepoRoot, { force: true, recursive: true });
    }
  });

  it("keeps existing simulator profiles standard until a project opts in", () => {
    const profiles = loadVerifyProfiles(repoRoot);
    const catalog = buildHarnessCatalog(repoRoot, [], profiles, []);

    expect(
      catalog.verificationProfiles.filter((profile) => ["implementation", "spec-only"].includes(profile.id)),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "implementation", commentaryPolicy: "standard", longRunning: false }),
        expect.objectContaining({ id: "spec-only", commentaryPolicy: "standard", longRunning: false }),
      ]),
    );
  });

  it("budgets detached verify timeout across every command effective timeout", () => {
    const profile: VerifyProfile = {
      advisory: false,
      covers_boundaries: [],
      covers_scenarios: [],
      commands: [
        { id: "default-timeout", run: "npm test" },
        { id: "profile-timeout", run: "npm run lint" },
        { id: "command-timeout", run: "npm run e2e", timeoutMs: 3_000 },
      ],
      evidence_extractors: [],
      failure_patterns: [],
      id: "timeout-profile",
      proof_kind: "code",
      required_artifacts: [],
      required_pass_signals: [],
      timeoutMs: 2_000,
    };

    const profileWithoutDefaultTimeout = { ...profile };
    delete profileWithoutDefaultTimeout.timeoutMs;

    expect(getDetachedVerifyTimeoutMs(profile)).toBe(60_000 + (3 * 5_000) + 2_000 + 2_000 + 3_000);
    expect(getDetachedVerifyTimeoutMs(profileWithoutDefaultTimeout)).toBe(
      60_000 + (3 * 5_000) + DEFAULT_COMMAND_TIMEOUT_MS + DEFAULT_COMMAND_TIMEOUT_MS + 3_000,
    );
  });

  it("sizes detached verify result reads from retained command output budgets", () => {
    const profile: VerifyProfile = {
      advisory: false,
      covers_boundaries: [],
      covers_scenarios: [],
      commands: [
        { id: "default-output", run: "npm test" },
        { id: "small-output", maxStderrBytes: 20, maxStdoutBytes: 10, run: "npm run lint" },
      ],
      evidence_extractors: [],
      failure_patterns: [],
      id: "result-limit-profile",
      proof_kind: "code",
      required_artifacts: [],
      required_pass_signals: [],
    };

    expect(getDetachedVerifyResultReadLimitBytes(profile)).toBe(
      ((DEFAULT_COMMAND_MAX_STDOUT_BYTES + DEFAULT_COMMAND_MAX_STDERR_BYTES + 10 + 20) * 6)
        + 1_048_576
        + (2 * 131_072),
    );
  });

  it("uses the artifact result-read limit when discovering oversized final results", async () => {
    const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "agent-harness-detached-large-result-"));
    const artifactPath = path.join(temporaryDirectory, "detached-run.json");
    const resultPath = path.join(temporaryDirectory, "verify-result.json");
    const resultReadLimitBytes = 12 * 1024 * 1024;
    const payloadBytes = 9 * 1024 * 1024;
    const script = [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ passed: true, payload: 'x'.repeat(${payloadBytes}) }));`,
    ].join("");

    try {
      const artifact = startDetachedRun({
        artifactPath,
        command: `${shellQuote(process.execPath)} -e ${shellQuote(script)}`,
        cwd: temporaryDirectory,
        resultPath,
        resultReadLimitBytes,
        resumeCommand: "resume",
        statusCommand: "status",
        timeoutMs: 10_000,
      });

      expect(artifact.resultReadLimitBytes).toBe(resultReadLimitBytes);

      const status = await waitForDetachedRunEvent({
        artifactPath,
        pollIntervalMs: 100,
        waitTimeoutMs: 10_000,
      });

      expect(status?.artifact.status).toBe("passed");
    } finally {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  }, 15_000);

  it("honors the result-read limit in the standalone status command", () => {
    const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "agent-harness-detached-standalone-large-result-"));
    const artifactPath = path.join(temporaryDirectory, "detached-run.json");
    const resultPath = path.join(temporaryDirectory, "verify-result.json");
    const resultReadLimitBytes = 12 * 1024 * 1024;
    const payloadBytes = 9 * 1024 * 1024;
    const script = [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ passed: true, payload: 'x'.repeat(${payloadBytes}) }));`,
    ].join("");

    try {
      startDetachedRun({
        artifactPath,
        command: `${shellQuote(process.execPath)} -e ${shellQuote(script)}`,
        cwd: temporaryDirectory,
        resultPath,
        resultReadLimitBytes,
        resumeCommand: "resume",
        statusCommand: "status",
        timeoutMs: 10_000,
      });

      const output = execFileSync(
        process.execPath,
        [
          path.join(repoRoot, "scripts", "agent_detached_status.cjs"),
          "--artifact",
          artifactPath,
          "--wait",
          "--poll-interval-ms",
          "100",
          "--wait-timeout-ms",
          "10000",
        ],
        { encoding: "utf8" },
      );
      const status = JSON.parse(output) as { artifact: { status: string } };

      expect(status.artifact.status).toBe("passed");
    } finally {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  }, 15_000);

  it("runs the timeout watchdog from a protocol script file", async () => {
    const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "agent-harness-detached-watchdog-script-"));
    const artifactPath = path.join(temporaryDirectory, "detached-run.json");
    const resultPath = path.join(temporaryDirectory, "verify-result.json");

    try {
      const artifact = startDetachedRun({
        artifactPath,
        command: `${shellQuote(process.execPath)} -e ${shellQuote("setTimeout(() => {}, 10000)")}`,
        cwd: temporaryDirectory,
        resultPath,
        resumeCommand: "resume",
        statusCommand: "status",
        timeoutMs: 100,
      });
      const watchdogScriptPath = buildDetachedRunWatchdogScriptPath(artifactPath);

      expect(artifact.watchdogPid).toBeDefined();
      expect(existsSync(watchdogScriptPath)).toBe(true);
      expect(path.relative(temporaryDirectory, watchdogScriptPath)).toMatch(/^detached[/\\]/);

      const status = await waitForDetachedRunEvent({
        artifactPath,
        pollIntervalMs: 50,
        waitTimeoutMs: 4_000,
      });

      expect(status?.artifact.status).toBe("timeout");
    } finally {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  }, 20_000);

  it("bounds generic detached stdout logs", async () => {
    const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "agent-harness-detached-log-limit-"));
    const artifactPath = path.join(temporaryDirectory, "detached-run.json");
    const resultPath = path.join(temporaryDirectory, "verify-result.json");
    const script = [
      "const fs = require('node:fs');",
      "process.stdout.write('x'.repeat(1000));",
      `fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ passed: true }));`,
    ].join("");

    try {
      const artifact = startDetachedRun({
        artifactPath,
        command: `${shellQuote(process.execPath)} -e ${shellQuote(script)}`,
        cwd: temporaryDirectory,
        logLimitBytes: 64,
        resultPath,
        resumeCommand: "resume",
        statusCommand: "status",
        timeoutMs: 10_000,
      });

      const status = await waitForDetachedRunEvent({
        artifactPath,
        pollIntervalMs: 50,
        waitTimeoutMs: 10_000,
      });
      const stdoutLog = readFileSync(artifact.stdoutPath, "utf8");

      expect(status?.artifact.status).toBe("passed");
      expect(status?.artifact.logLimitBytes).toBe(64);
      expect(stdoutLog).toContain("x".repeat(64));
      expect(stdoutLog).toContain("detached stdout log truncated");
      expect(stdoutLog.length).toBeLessThan(300);
      expect(existsSync(buildDetachedRunBoundedLogScriptPath(artifactPath))).toBe(true);
    } finally {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  }, 15_000);

  it("launches the Windows detached monitor from files instead of an encoded command payload", () => {
    const args = buildWindowsDetachedMonitorSpawnArgs(
      "C:\\agent-harness\\detached\\windows-monitor.ps1",
      "C:\\agent-harness\\detached\\windows-monitor-launch.json",
    );

    expect(args).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "C:\\agent-harness\\detached\\windows-monitor.ps1",
      "C:\\agent-harness\\detached\\windows-monitor-launch.json",
    ]);
    expect(args).not.toContain("-EncodedCommand");
    expect(args.join(" ").length).toBeLessThan(200);
  });

  it("reserves the root verify paths artifact from detached summary output", () => {
    const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "agent-harness-detached-summary-paths-"));
    const cliPath = path.join(repoRoot, "agent-harness", "src", "cli.ts");
    const tsxEntryPath = path.join(repoRoot, "agent-harness", "node_modules", "tsx", "dist", "cli.mjs");
    let failure: unknown;

    try {
      try {
        execFileSync(
          process.execPath,
          [
            tsxEntryPath,
            cliPath,
            "verify",
            "--profile",
            "spec-only",
            "--paths",
            "AGENTS.md",
            "--artifacts-dir",
            temporaryDirectory,
            "--summary-file",
            path.join(temporaryDirectory, "paths.txt"),
            "--detach",
          ],
          {
            cwd: repoRoot,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
      } catch (error) {
        failure = error;
      }

      const stderr = (failure as { stderr?: Buffer | string } | undefined)?.stderr?.toString() ?? "";
      expect(failure).toBeDefined();
      expect(stderr).toContain("Summary file");
      expect(stderr).toContain("verification paths artifact");
      expect(existsSync(path.join(temporaryDirectory, "detached-run.json"))).toBe(false);
    } finally {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it("accepts a trusted completed result inspected after its deadline", async () => {
    const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "agent-harness-detached-predeadline-result-"));
    const artifactPath = path.join(temporaryDirectory, "detached-run.json");
    const resultPath = path.join(temporaryDirectory, "verify-result.json");
    const script = [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ generatedAt: new Date().toISOString(), passed: true }));`,
    ].join("");

    try {
      const startedArtifact = startDetachedRun({
        artifactPath,
        command: `${shellQuote(process.execPath)} -e ${shellQuote(script)}`,
        cwd: temporaryDirectory,
        resultPath,
        resumeCommand: "resume",
        statusCommand: "status",
      });
      await waitForPidToExit(startedArtifact.pid, 5_000);
      expect(isPidAlive(startedArtifact.pid)).toBe(false);

      const artifact = readDetachedRunArtifact(artifactPath);
      const deadlineAt = new Date(Date.parse(artifact.startedAt) + 10_000).toISOString();
      writeFileSync(artifactPath, `${JSON.stringify({
        ...artifact,
        deadlineAt,
        timeoutMs: 10_000,
      }, null, 2)}\n`);
      const status = inspectDetachedRun({
        artifactPath,
        now: new Date(Date.parse(deadlineAt) + 1).toISOString(),
      });

      expect(status.artifact.status).toBe("passed");
    } finally {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  }, 10_000);
});
