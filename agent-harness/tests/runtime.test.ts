import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getRepoRoot } from "../src/lib/config.js";
import {
  buildWindowsTaskkillArgs,
  createArtifactsDirectory,
  getAgentHome,
  getDefaultArtifactsRoot,
  getFlagValue,
  getLegacyArtifactsRoot,
  getListFlag,
  parseArguments,
  runCommand,
  shellQuote,
  windowsProcessIdentityStillMatches,
} from "../src/lib/runtime.js";

describe("runtime argument parsing", () => {
  const repoRoot = getRepoRoot();
  const sessionDirWithSpaces = path.join(repoRoot, "artifacts", "agent-harness", "runtime test session");
  const originalArtifactsRoot = process.env.AGENT_HARNESS_ARTIFACTS_ROOT;
  const originalAgentHome = process.env.AGENT_HOME;
  const originalCodexHome = process.env.CODEX_HOME;

  function runHarnessCommand(args: string[]): string {
    return execFileSync(
      "npm",
      ["run", "--silent", ...args],
      {
        cwd: path.join(repoRoot, "agent-harness"),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  }

  function runHarnessCommandAllowingFailure(args: string[]): string {
    try {
      return runHarnessCommand(args);
    } catch (error) {
      const stdout = (error as { stdout?: Buffer | string }).stdout;
      if (Buffer.isBuffer(stdout)) {
        return stdout.toString("utf8");
      }
      if (typeof stdout === "string") {
        return stdout;
      }
      throw error;
    }
  }

  afterEach(() => {
    if (originalArtifactsRoot === undefined) {
      delete process.env.AGENT_HARNESS_ARTIFACTS_ROOT;
    } else {
      process.env.AGENT_HARNESS_ARTIFACTS_ROOT = originalArtifactsRoot;
    }

    if (originalAgentHome === undefined) {
      delete process.env.AGENT_HOME;
    } else {
      process.env.AGENT_HOME = originalAgentHome;
    }

    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalCodexHome;
    }

    if (existsSync(sessionDirWithSpaces)) {
      rmSync(sessionDirWithSpaces, { force: true, recursive: true });
    }
  });

  it("captures all bare values that follow a list flag", () => {
    const parsed = parseArguments([
      "context",
      "--paths",
      "README.md",
      "broker-core/index.mjs",
      "--session-dir",
      "artifacts/agent-harness/runtime-test",
    ]);

    expect(getListFlag(parsed.flags, "paths")).toEqual([
      "README.md",
      "broker-core/index.mjs",
    ]);
    expect(getFlagValue(parsed.flags, "session-dir")).toBe("artifacts/agent-harness/runtime-test");
  });

  it("keeps boolean flags working when no value follows", () => {
    const parsed = parseArguments(["catalog", "--write-docs", "--format", "md"]);

    expect(getFlagValue(parsed.flags, "write-docs")).toBe("true");
    expect(getFlagValue(parsed.flags, "format")).toBe("md");
  });

  it("shell-quotes values for copy-paste-safe commands", () => {
    expect(shellQuote("/tmp/session dir")).toBe("'/tmp/session dir'");
    expect(shellQuote("/tmp/it's-here")).toBe("'/tmp/it'\\''s-here'");
  });

  it("quotes session-dir commands in context output", () => {
    const output = runHarnessCommand([
      "context",
      "--",
      "--paths",
      "agent-harness/src/cli.ts",
      "--session-dir",
      sessionDirWithSpaces,
      "--session-mode",
      "long-running",
    ]);

    const contextJson = JSON.parse(output) as {
      advisoryEvaluationCommand: string;
      completionCommand: string;
      handoffCommand: string;
      planCommand: string;
      sessionCommands: string[];
    };
    const quotedSessionDir = shellQuote(sessionDirWithSpaces);

    expect(contextJson.planCommand).toBe(`npm run agent:plan -- --session-dir ${quotedSessionDir}`);
    expect(contextJson.handoffCommand).toBe(`npm run agent:handoff -- --session-dir ${quotedSessionDir}`);
    expect(contextJson.advisoryEvaluationCommand).toBe(`npm run agent:evaluate -- --session-dir ${quotedSessionDir}`);
    expect(contextJson.completionCommand).toBe(`npm run agent:complete -- --session-dir ${quotedSessionDir}`);
    expect(contextJson.sessionCommands).toEqual([
      `npm run agent:plan -- --session-dir ${quotedSessionDir}`,
      `npm run agent:handoff -- --session-dir ${quotedSessionDir}`,
      `npm run agent:evaluate -- --session-dir ${quotedSessionDir}`,
    ]);
  });

  it("keeps standard session context output slim when a session-dir is provided", () => {
    const output = runHarnessCommand([
      "context",
      "--",
      "--paths",
      "agent-harness/src/cli.ts",
      "--session-dir",
      sessionDirWithSpaces,
    ]);

    const contextJson = JSON.parse(output) as Record<string, unknown>;

    expect(contextJson.sessionDir).toBe(sessionDirWithSpaces);
    expect(contextJson.completionCommand).toBe(`npm run agent:complete -- --session-dir ${shellQuote(sessionDirWithSpaces)}`);
    expect(contextJson.taskContractPath).toBe(path.join(sessionDirWithSpaces, "task-contract.json"));
    expect(contextJson).not.toHaveProperty("advisoryEvaluationCommand");
    expect(contextJson).not.toHaveProperty("advisoryEvaluationPath");
    expect(contextJson).not.toHaveProperty("advisoryEvaluationRubricPath");
    expect(contextJson).not.toHaveProperty("handoffCommand");
    expect(contextJson).not.toHaveProperty("planCommand");
    expect(contextJson).not.toHaveProperty("sessionCommands");
    expect(contextJson).not.toHaveProperty("sessionHandoffPath");
    expect(contextJson).not.toHaveProperty("taskPlanPath");
  });

  it("reports harness manifest profiles in doctor output", () => {
    const output = runHarnessCommand([
      "doctor",
      "--",
      "--paths",
      ".agents/manifests/specs.yaml",
    ]);

    const doctorJson = JSON.parse(output) as {
      baseProfiles: string[];
      obligationProfiles: string[];
    };

    expect(doctorJson.baseProfiles).toEqual(["spec-only"]);
    expect(doctorJson.obligationProfiles).toEqual([]);
  });

  it("does not fan out obligations beyond the base implementation profile in doctor output", () => {
    const output = runHarnessCommand([
      "doctor",
      "--",
      "--paths",
      "broker-core/index.mjs",
    ]);

    const doctorJson = JSON.parse(output) as {
      baseProfiles: string[];
      obligationProfiles: string[];
    };

    expect(doctorJson.baseProfiles).toEqual(["implementation"]);
    expect(doctorJson.obligationProfiles).toEqual([]);
  }, 15_000);

  it("reports macOS build tools for app implementation doctor output", () => {
    const output = runHarnessCommand([
      "doctor",
      "--",
      "--paths",
      "app/Sources/RootView.swift",
    ]);

    const doctorJson = JSON.parse(output) as {
      checks: Array<{
        profileId: string;
        requiredTools: string[];
      }>;
    };

    expect(
      doctorJson.checks.map(({ profileId, requiredTools }) => ({ profileId, requiredTools })),
    ).toEqual([
      {
        profileId: "implementation",
        requiredTools: ["bash", "node", "npm", "xcodegen", "xcodebuild"],
      },
    ]);
  });

  it("runs selected deterministic proof profiles in preflight", () => {
    const artifactsDir = path.join(os.tmpdir(), `agent-harness-preflight-${process.pid}-${Date.now()}`);

    try {
      const output = runHarnessCommandAllowingFailure([
        "preflight",
        "--",
        "--paths",
        ".agents/manifests/specs.yaml",
        "--artifacts-dir",
        artifactsDir,
      ]);

      const preflightJson = JSON.parse(output) as {
        baseProfiles: string[];
        requiredButSkippedProfiles: Array<{ profileId: string; reason: string }>;
        verifyResults: Array<{ profileId: string }>;
      };

      expect(preflightJson.baseProfiles).toEqual(["spec-only"]);
      expect(preflightJson.verifyResults.map((result) => result.profileId)).toEqual(["spec-only"]);
      expect(preflightJson.requiredButSkippedProfiles).toEqual([]);
    } finally {
      if (existsSync(artifactsDir)) {
        rmSync(artifactsDir, { force: true, recursive: true });
      }
    }
  }, 20_000);

  it("preserves long-running mode when rerunning context without an explicit session-mode", () => {
    runHarnessCommand([
      "context",
      "--",
      "--paths",
      "agent-harness/src/cli.ts",
      "--session-dir",
      sessionDirWithSpaces,
      "--session-mode",
      "long-running",
    ]);

    const output = runHarnessCommand([
      "context",
      "--",
      "--paths",
      "agent-harness/src/cli.ts",
      "--session-dir",
      sessionDirWithSpaces,
    ]);

    const contextJson = JSON.parse(output) as {
      sessionMode: string;
      sessionModeArtifactRequirement: string;
    };
    const taskContract = JSON.parse(readFileSync(path.join(sessionDirWithSpaces, "task-contract.json"), "utf8")) as {
      sessionMode: string;
    };

    expect(contextJson.sessionMode).toBe("long-running");
    expect(contextJson.sessionModeArtifactRequirement).toBe("required");
    expect(taskContract.sessionMode).toBe("long-running");
  });

  it("defaults legacy session contracts without a sessionMode back to standard", () => {
    runHarnessCommand([
      "context",
      "--",
      "--paths",
      "agent-harness/src/cli.ts",
      "--session-dir",
      sessionDirWithSpaces,
    ]);

    const taskContractPath = path.join(sessionDirWithSpaces, "task-contract.json");
    const legacyTaskContract = JSON.parse(readFileSync(taskContractPath, "utf8")) as {
      sessionMode?: string;
      version: number;
    };
    delete legacyTaskContract.sessionMode;
    legacyTaskContract.version = 2;
    writeFileSync(taskContractPath, JSON.stringify(legacyTaskContract, null, 2));

    const output = runHarnessCommand([
      "context",
      "--",
      "--paths",
      "agent-harness/src/cli.ts",
      "--session-dir",
      sessionDirWithSpaces,
    ]);

    const contextJson = JSON.parse(output) as {
      sessionMode: string;
      sessionModeArtifactRequirement: string;
    };

    expect(contextJson.sessionMode).toBe("standard");
    expect(contextJson.sessionModeArtifactRequirement).toBe("optional");
  });

  it("merges advisory score updates instead of dropping untouched criteria", () => {
    runHarnessCommand([
      "context",
      "--",
      "--paths",
      "agent-harness/src/cli.ts",
      "--session-dir",
      sessionDirWithSpaces,
      "--session-mode",
      "long-running",
    ]);

    runHarnessCommand([
      "evaluate",
      "--",
      "--session-dir",
      sessionDirWithSpaces,
      "--status",
      "pass",
      "--recommended-action",
      "continue",
      "--summary",
      "Initial advisory pass.",
      "--score",
      "product-completeness=4",
      "--score",
      "ux-clarity=4",
      "--score",
      "visual-quality=3",
      "--score",
      "code-quality=4",
    ]);

    runHarnessCommand([
      "evaluate",
      "--",
      "--session-dir",
      sessionDirWithSpaces,
      "--score",
      "ux-clarity=5",
    ]);

    const evaluationJson = JSON.parse(readFileSync(path.join(sessionDirWithSpaces, "advisory-evaluation.json"), "utf8")) as {
      scores: Record<string, number>;
    };

    expect(evaluationJson.scores).toEqual({
      "code-quality": 4,
      "product-completeness": 4,
      "ux-clarity": 5,
      "visual-quality": 3,
    });
  });

  it("defaults harness artifacts outside the repo worktree", () => {
    delete process.env.AGENT_HARNESS_ARTIFACTS_ROOT;
    delete process.env.AGENT_HOME;
    delete process.env.CODEX_HOME;

    expect(getAgentHome()).toBe(path.join(os.homedir(), ".agents"));
    expect(getDefaultArtifactsRoot(repoRoot)).toBe(path.join(os.homedir(), ".agents", "agent-harness", "simulator-broker-app"));
    expect(getLegacyArtifactsRoot(repoRoot)).toBe(path.join(repoRoot, "artifacts", "agent-harness"));
  });

  it("uses package identity instead of checkout directory for the artifact namespace", () => {
    const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "agent-harness-runtime-checkout-"));
    delete process.env.AGENT_HARNESS_ARTIFACTS_ROOT;
    delete process.env.AGENT_HOME;
    delete process.env.CODEX_HOME;

    try {
      mkdirSync(temporaryRoot, { recursive: true });
      writeFileSync(path.join(temporaryRoot, "package.json"), JSON.stringify({ name: "simulator-broker-app" }));

      expect(getDefaultArtifactsRoot(temporaryRoot)).toBe(path.join(os.homedir(), ".agents", "agent-harness", "simulator-broker-app"));
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true });
    }
  });

  it("prefers AGENT_HOME over CODEX_HOME for the default artifacts root", () => {
    const agentHome = mkdtempSync(path.join(os.tmpdir(), "agent-harness-runtime-agent-home-"));
    const codexHome = mkdtempSync(path.join(os.tmpdir(), "agent-harness-runtime-codex-home-"));
    delete process.env.AGENT_HARNESS_ARTIFACTS_ROOT;

    try {
      process.env.AGENT_HOME = agentHome;
      process.env.CODEX_HOME = codexHome;
      expect(getDefaultArtifactsRoot(repoRoot)).toBe(path.join(agentHome, "agent-harness", "simulator-broker-app"));

      delete process.env.AGENT_HOME;
      expect(getDefaultArtifactsRoot(repoRoot)).toBe(path.join(codexHome, "agent-harness", "simulator-broker-app"));
    } finally {
      rmSync(agentHome, { force: true, recursive: true });
      rmSync(codexHome, { force: true, recursive: true });
    }
  });

  it("uses the configured harness artifacts root override for new artifact directories", () => {
    const overrideRoot = path.join(repoRoot, ".tmp-runtime-artifacts");
    process.env.AGENT_HARNESS_ARTIFACTS_ROOT = overrideRoot;

    const createdDir = createArtifactsDirectory(repoRoot);

    expect(createdDir.startsWith(`${overrideRoot}${path.sep}`)).toBe(true);
    expect(existsSync(createdDir)).toBe(true);

    rmSync(overrideRoot, { force: true, recursive: true });
  });

  it("preserves split UTF-8 characters while streaming command output", async () => {
    const chunks: string[] = [];
    const script = [
      "const bytes = Buffer.from('€');",
      "process.stdout.write(bytes.subarray(0, 1));",
      "setTimeout(() => process.stdout.write(bytes.subarray(1)), 10);",
    ].join("");

    const result = await runCommand(
      "utf8-boundary",
      `${shellQuote(process.execPath)} -e ${shellQuote(script)}`,
      repoRoot,
      { stdout: (chunk) => chunks.push(chunk) },
    );

    expect(result.success).toBe(true);
    expect(chunks.join("")).toBe("€");
  });

  it("matches failure patterns across split UTF-8 characters", async () => {
    const script = [
      "const bytes = Buffer.from('€');",
      "process.stdout.write(bytes.subarray(0, 1));",
      "setTimeout(() => process.stdout.write(bytes.subarray(1)), 10);",
    ].join("");

    const result = await runCommand(
      "split-utf8-failure-pattern",
      `${shellQuote(process.execPath)} -e ${shellQuote(script)}`,
      repoRoot,
      {
        failurePatterns: ["€"],
        maxStdoutBytes: 1,
      },
    );

    expect(result.failurePatternMatches).toEqual(["€"]);
  });

  it("builds Windows command tree termination arguments", () => {
    expect(buildWindowsTaskkillArgs(1234)).toEqual(["/PID", "1234", "/T"]);
    expect(buildWindowsTaskkillArgs(1234, true)).toEqual(["/PID", "1234", "/T", "/F"]);
  });

  it("does not trust Windows process tree termination without a captured process identity", () => {
    expect(windowsProcessIdentityStillMatches(undefined)).toBe(false);
    expect(windowsProcessIdentityStillMatches({ pid: 1234 })).toBe(false);
  });
});
