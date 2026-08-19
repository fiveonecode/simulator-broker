import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { getDetachedRunArtifactProtocolName } from "../src/lib/detached-run.js";
import { executeVerifyProfile } from "../src/lib/verify.js";
import type { VerifyProfile } from "../src/lib/types.js";

describe("verify profile execution", () => {
  it("writes artifacts and returns a passing result", async () => {
    const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "agent-harness-verify-"));
    const profile: VerifyProfile = {
      advisory: false,
      covers_boundaries: [],
      covers_scenarios: [],
      commands: [
        {
          id: "write-artifact",
          run: "node -e \"require('node:fs').writeFileSync(process.argv[1] + '/proof.txt', 'ok\\n')\" {artifactsDir}",
        },
      ],
      evidence_extractors: ["artifact-manifest"],
      failure_patterns: ["FAILED"],
      id: "test-profile",
      proof_kind: "contract",
      required_artifacts: ["proof.txt"],
      required_pass_signals: ["write-artifact"],
    };

    const result = await executeVerifyProfile({
      artifactsDir: temporaryDirectory,
      paths: ["spec/README.md"],
      profile,
      repoRoot: process.cwd(),
      taskContractId: "task-contract-123",
      taskTreeFingerprint: "sha256:test-task-tree",
    });

    expect(result.passed).toBe(true);
    expect(result.advisory).toBe(false);
    expect(result.proofKind).toBe("contract");
    expect(result.requiredArtifactsPresent).toContain("proof.txt");
    expect(result.taskContractId).toBe("task-contract-123");
    expect(result.taskTreeFingerprint).toBe("sha256:test-task-tree");
    rmSync(temporaryDirectory, { force: true, recursive: true });
  });

  it("shell-quotes template substitutions", async () => {
    const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "agent-harness-verify-quote-"));
    const artifactsDir = path.join(temporaryDirectory, "artifacts dir");
    const repoRoot = path.join(temporaryDirectory, "repo root; touch repo-injected");
    const injectedPath = path.join(temporaryDirectory, "injected");
    const maliciousPath = `safe-path'; touch ${injectedPath}; echo '`;
    mkdirSync(repoRoot, { recursive: true });
    const profile: VerifyProfile = {
      advisory: false,
      covers_boundaries: [],
      covers_scenarios: [],
      commands: [
        {
          id: "capture-args",
          run: [
            "node",
            "-e",
            "\"const fs=require('node:fs'); fs.writeFileSync(process.argv[1] + '/quoted.txt', process.argv.slice(2).join('\\n'))\"",
            "{artifactsDir}",
            "{repoRoot}",
            "{pathsCsv}",
            "{pathsFile}",
          ].join(" "),
        },
      ],
      evidence_extractors: ["artifact-manifest"],
      failure_patterns: [],
      id: "quote-profile",
      proof_kind: "contract",
      required_artifacts: ["quoted.txt"],
      required_pass_signals: ["capture-args"],
    };

    const result = await executeVerifyProfile({
      artifactsDir,
      paths: ["normal path.js", maliciousPath],
      profile,
      repoRoot,
    });

    const capturedArgs = readFileSync(path.join(artifactsDir, "quoted.txt"), "utf8").split("\n");
    expect(result.passed).toBe(true);
    expect(capturedArgs[0]).toBe(repoRoot);
    expect(capturedArgs[1]).toBe(["normal path.js", maliciousPath].join(","));
    expect(capturedArgs[2]).toBe(path.join(realpathSync(temporaryDirectory), "artifacts dir", "paths.txt"));
    expect(existsSync(injectedPath)).toBe(false);
    rmSync(temporaryDirectory, { force: true, recursive: true });
  });

  it("clears stale artifacts before checking rerun output", async () => {
    const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "agent-harness-verify-stale-"));
    const artifactsDir = path.join(temporaryDirectory, "verify", "implementation");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(path.join(artifactsDir, "proof.txt"), "stale\n");
    const profile: VerifyProfile = {
      advisory: false,
      covers_boundaries: [],
      covers_scenarios: [],
      commands: [
        {
          id: "skip-artifact",
          run: "node -e \"process.exit(0)\"",
        },
      ],
      evidence_extractors: ["artifact-manifest"],
      failure_patterns: [],
      id: "implementation",
      proof_kind: "code",
      required_artifacts: ["proof.txt"],
      required_pass_signals: ["skip-artifact"],
    };

    const result = await executeVerifyProfile({
      artifactsDir,
      paths: ["agent-harness/src/lib/verify.ts"],
      profile,
      repoRoot: process.cwd(),
    });

    expect(result.passed).toBe(false);
    expect(result.requiredArtifactsMissing).toContain("proof.txt");
    expect(result.requiredArtifactsPresent).not.toContain("proof.txt");
    expect(existsSync(path.join(artifactsDir, "proof.txt"))).toBe(false);
    rmSync(temporaryDirectory, { force: true, recursive: true });
  });

  it("rejects unsafe artifact directories before recursive cleanup", async () => {
    const repoRoot = mkdtempSync(path.join(os.tmpdir(), "agent-harness-verify-repo-"));
    const sourceRoot = path.join(repoRoot, "agent-harness");
    const markerPath = path.join(sourceRoot, "keep.txt");
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(markerPath, "do not delete\n");
    const profile: VerifyProfile = {
      advisory: false,
      covers_boundaries: [],
      covers_scenarios: [],
      commands: [],
      evidence_extractors: ["artifact-manifest"],
      failure_patterns: [],
      id: "implementation",
      proof_kind: "code",
      required_artifacts: [],
      required_pass_signals: [],
    };

    await expect(
      executeVerifyProfile({
        artifactsDir: sourceRoot,
        paths: ["agent-harness/src/lib/verify.ts"],
        profile,
        repoRoot,
      }),
    ).rejects.toThrow(/Refusing to clear repository source path/);
    expect(existsSync(markerPath)).toBe(true);
    rmSync(repoRoot, { force: true, recursive: true });
  });

  it("allows nested Codex harness session artifact directories", async () => {
    const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "verify-codex-home-"));
    const previousCodexHome = process.env.CODEX_HOME;
    const profile: VerifyProfile = {
      advisory: false,
      covers_boundaries: [],
      covers_scenarios: [],
      commands: [],
      evidence_extractors: ["artifact-manifest"],
      failure_patterns: [],
      id: "implementation",
      proof_kind: "code",
      required_artifacts: ["paths.txt"],
      required_pass_signals: [],
    };

    try {
      const codexHome = path.join(temporaryDirectory, "codex-home");
      process.env.CODEX_HOME = codexHome;
      const artifactsDir = path.join(
        codexHome,
        "agent-harness",
        "simulator-broker-app",
        "session",
        "verify",
        "implementation",
      );
      const result = await executeVerifyProfile({
        artifactsDir,
        paths: ["agent-harness/src/lib/verify.ts"],
        profile,
        repoRoot: process.cwd(),
      });

      expect(result.passed).toBe(true);
      expect(result.artifactsDir).toBe(path.join(
        realpathSync(temporaryDirectory),
        "codex-home",
        "agent-harness",
        "simulator-broker-app",
        "session",
        "verify",
        "implementation",
      ));
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it("keeps configured Codex home artifact directories trusted when AGENT_HOME is set", async () => {
    const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "verify-codex-home-compat-"));
    const agentHomeDirectory = mkdtempSync(path.join(os.tmpdir(), "verify-agent-home-"));
    const previousCodexHome = process.env.CODEX_HOME;
    const previousAgentHome = process.env.AGENT_HOME;
    const profile: VerifyProfile = {
      advisory: false,
      covers_boundaries: [],
      covers_scenarios: [],
      commands: [],
      evidence_extractors: ["artifact-manifest"],
      failure_patterns: [],
      id: "implementation",
      proof_kind: "code",
      required_artifacts: ["paths.txt"],
      required_pass_signals: [],
    };

    try {
      const codexHome = path.join(temporaryDirectory, "codex-home");
      process.env.CODEX_HOME = codexHome;
      process.env.AGENT_HOME = agentHomeDirectory;
      const artifactsDir = path.join(
        codexHome,
        "agent-harness",
        "simulator-broker-app",
        "session",
        "verify",
        "implementation",
      );
      const result = await executeVerifyProfile({
        artifactsDir,
        paths: ["agent-harness/src/lib/verify.ts"],
        profile,
        repoRoot: process.cwd(),
      });

      expect(result.passed).toBe(true);
      expect(result.artifactsDir).toBe(path.join(
        realpathSync(temporaryDirectory),
        "codex-home",
        "agent-harness",
        "simulator-broker-app",
        "session",
        "verify",
        "implementation",
      ));
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      if (previousAgentHome === undefined) {
        delete process.env.AGENT_HOME;
      } else {
        process.env.AGENT_HOME = previousAgentHome;
      }
      rmSync(temporaryDirectory, { force: true, recursive: true });
      rmSync(agentHomeDirectory, { force: true, recursive: true });
    }
  });

  it("rejects Codex harness artifact directories with symlinked ancestors", async () => {
    const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "agent-harness-verify-codex-link-"));
    const outsideTarget = mkdtempSync(path.join(os.tmpdir(), "verify-outside-target-"));
    const previousCodexHome = process.env.CODEX_HOME;
    const profile: VerifyProfile = {
      advisory: false,
      covers_boundaries: [],
      covers_scenarios: [],
      commands: [],
      evidence_extractors: ["artifact-manifest"],
      failure_patterns: [],
      id: "implementation",
      proof_kind: "code",
      required_artifacts: [],
      required_pass_signals: [],
    };

    try {
      const codexHome = path.join(temporaryDirectory, "codex-home");
      const harnessRoot = path.join(codexHome, "agent-harness");
      const markerPath = path.join(outsideTarget, "keep.txt");
      process.env.CODEX_HOME = codexHome;
      mkdirSync(harnessRoot, { recursive: true });
      writeFileSync(markerPath, "do not delete\n");
      symlinkSync(outsideTarget, path.join(harnessRoot, "link"));

      await expect(
        executeVerifyProfile({
          artifactsDir: path.join(harnessRoot, "link", "run"),
          paths: ["agent-harness/src/lib/verify.ts"],
          profile,
          repoRoot: process.cwd(),
        }),
      ).rejects.toThrow(/Refusing to clear untrusted verification artifacts directory/);
      expect(existsSync(markerPath)).toBe(true);
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      rmSync(temporaryDirectory, { force: true, recursive: true });
      rmSync(outsideTarget, { force: true, recursive: true });
    }
  });

  it("downgrades failures to warnings for advisory profiles", async () => {
    const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "agent-harness-verify-advisory-"));
    const profile: VerifyProfile = {
      advisory: true,
      covers_boundaries: [],
      covers_scenarios: ["broker-advisory-matrix"],
      commands: [
        {
          id: "legacy-check",
          run: "node -e \"process.stderr.write('FAILED legacy check\\n'); process.exit(1)\"",
        },
      ],
      evidence_extractors: ["command-stdout"],
      failure_patterns: ["FAILED"],
      id: "legacy-profile",
      proof_kind: "simulated-flow",
      required_artifacts: [],
      required_pass_signals: ["legacy-check"],
    };

    const result = await executeVerifyProfile({
      artifactsDir: temporaryDirectory,
      paths: ["spec/README.md"],
      profile,
      repoRoot: process.cwd(),
    });

    expect(result.passed).toBe(true);
    expect(result.advisory).toBe(true);
    expect(result.warnings.map((entry) => entry.name)).toContain("legacy-check");
    rmSync(temporaryDirectory, { force: true, recursive: true });
  });

  it("does not flag successful scenario artifact paths as failures when the pattern targets real xcodebuild output", async () => {
    const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "agent-harness-verify-scenarios-"));
    const profile: VerifyProfile = {
      advisory: false,
      covers_boundaries: [],
      covers_scenarios: ["scenario-wrapper"],
      commands: [
        {
          id: "scenario-wrapper",
          run: "node -e \"process.stdout.write(process.argv[1] + '/variant-b-first-failed/result.json\\n')\" {artifactsDir}",
        },
      ],
      evidence_extractors: ["command-stdout"],
      failure_patterns: ["\\*\\* TEST EXECUTE FAILED \\*\\*"],
      id: "scenario-profile",
      proof_kind: "simulated-flow",
      required_artifacts: [],
      required_pass_signals: ["scenario-wrapper"],
    };

    const result = await executeVerifyProfile({
      artifactsDir: temporaryDirectory,
      paths: ["spec/README.md"],
      profile,
      repoRoot: process.cwd(),
    });

    expect(result.passed).toBe(true);
    expect(result.summary.find((entry) => entry.name === "scenario-wrapper")?.passed).toBe(true);
    rmSync(temporaryDirectory, { force: true, recursive: true });
  });

  it("does not count detached protocol files as required proof artifacts", async () => {
    const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "agent-harness-verify-detached-protocol-"));
    const artifactPath = path.join(temporaryDirectory, "detached-run.json");
    const resultPath = path.join(temporaryDirectory, "verify-result.json");
    const protocolDirectory = path.join(temporaryDirectory, "detached", getDetachedRunArtifactProtocolName(artifactPath));
    const stdoutPath = path.join(protocolDirectory, "stdout.log");
    const stderrPath = path.join(protocolDirectory, "stderr.log");
    const profile: VerifyProfile = {
      advisory: false,
      covers_boundaries: [],
      covers_scenarios: [],
      commands: [
        {
          id: "no-proof",
          run: "node -e \"process.exit(0)\"",
        },
      ],
      evidence_extractors: ["artifact-manifest"],
      failure_patterns: [],
      id: "detached-protocol-profile",
      proof_kind: "contract",
      required_artifacts: ["*.json", "**/*.log"],
      required_pass_signals: ["no-proof"],
    };

    try {
      mkdirSync(protocolDirectory, { recursive: true });
      writeFileSync(stdoutPath, "protocol stdout\n");
      writeFileSync(stderrPath, "protocol stderr\n");
      writeFileSync(`${artifactPath}.launch.lock`, "protocol lock\n");
      writeFileSync(
        artifactPath,
        JSON.stringify({
          artifactPath,
          command: "npm run agent:verify -- --detach",
          commentaryPolicy: "event-only",
          cwd: temporaryDirectory,
          lastMaterialEvent: {
            at: new Date().toISOString(),
            status: "running",
            type: "started",
          },
          logPaths: {
            stderr: stderrPath,
            stdout: stdoutPath,
          },
          pid: process.pid,
          resultPath,
          resumeCommand: "npm run agent:detached-status -- --wait",
          startedAt: new Date().toISOString(),
          status: "running",
          statusCommand: "npm run agent:detached-status",
          statusUpdatedAt: new Date().toISOString(),
          stderrPath,
          stdoutPath,
          version: 1,
        }),
      );

      const result = await executeVerifyProfile({
        artifactsDir: temporaryDirectory,
        detachedRunArtifactPath: artifactPath,
        paths: ["spec/README.md"],
        preserveDetachedRunArtifact: true,
        profile,
        repoRoot: process.cwd(),
      });

      expect(result.passed).toBe(false);
      expect(result.requiredArtifactsMissing).toEqual(["**/*.log", "*.json"]);
      expect(result.requiredArtifactsPresent).toEqual([]);
      expect(result.artifacts).not.toContain("detached-run.json");
      expect(result.artifacts).not.toContain("detached-run.json.launch.lock");
      expect(result.artifacts).not.toContain(`detached/${getDetachedRunArtifactProtocolName(artifactPath)}/stdout.log`);
    } finally {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it("does not count stale detached protocol directories as required proof artifacts", async () => {
    const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "agent-harness-verify-stale-detached-protocol-"));
    const artifactPath = path.join(temporaryDirectory, "detached-run.json");
    const staleProtocolDirectory = path.join(temporaryDirectory, "detached", "detached-run-stale");
    const profile: VerifyProfile = {
      advisory: false,
      covers_boundaries: [],
      covers_scenarios: [],
      commands: [
        {
          id: "no-proof",
          run: "node -e \"process.exit(0)\"",
        },
      ],
      evidence_extractors: ["artifact-manifest"],
      failure_patterns: [],
      id: "stale-detached-protocol-profile",
      proof_kind: "contract",
      required_artifacts: ["**/*.log"],
      required_pass_signals: ["no-proof"],
    };

    try {
      mkdirSync(staleProtocolDirectory, { recursive: true });
      writeFileSync(path.join(staleProtocolDirectory, "stdout.log"), "stale protocol stdout\n");

      const result = await executeVerifyProfile({
        artifactsDir: temporaryDirectory,
        detachedRunArtifactPath: artifactPath,
        paths: ["spec/README.md"],
        profile,
        repoRoot: process.cwd(),
      });

      expect(result.passed).toBe(false);
      expect(result.requiredArtifactsMissing).toEqual(["**/*.log"]);
      expect(result.requiredArtifactsPresent).toEqual([]);
      expect(result.artifacts).not.toContain("detached/detached-run-stale/stdout.log");
    } finally {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it("bounds relayed detached stdout logs to the retained output budget", async () => {
    const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "agent-harness-verify-detached-log-bound-"));
    const profile: VerifyProfile = {
      advisory: false,
      covers_boundaries: [],
      covers_scenarios: [],
      commands: [
        {
          id: "verbose-output",
          maxStdoutBytes: 10,
          run: "node -e \"process.stdout.write('x'.repeat(1000))\"",
        },
      ],
      evidence_extractors: ["command-stdout"],
      failure_patterns: [],
      id: "detached-log-bound-profile",
      proof_kind: "contract",
      required_artifacts: [],
      required_pass_signals: ["verbose-output"],
    };
    const originalStdoutWrite = process.stdout.write;
    let relayedStdout = "";

    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      relayedStdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stdout.write;

    try {
      const result = await executeVerifyProfile({
        artifactsDir: temporaryDirectory,
        detachedRunArtifactPath: path.join(temporaryDirectory, "detached-run.json"),
        paths: ["spec/README.md"],
        preserveDetachedRunArtifact: true,
        profile,
        repoRoot: process.cwd(),
      });

      expect(result.commands[0]?.stdoutBytes).toBe(1000);
      expect(result.commands[0]?.stdoutTruncated).toBe(true);
      expect(relayedStdout).toContain("xxxxxxxxxx");
      expect(relayedStdout).toContain("detached stdout log truncated");
      expect(relayedStdout.length).toBeLessThan(300);
    } finally {
      process.stdout.write = originalStdoutWrite;
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  });
});
