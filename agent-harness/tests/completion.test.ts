import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  evaluateTaskCompletion,
  getSessionVerifyArtifactsDir,
  loadSessionVerifyResults,
  readAdvisoryEvaluation,
  readSessionHandoff,
  readTaskContract,
  readTaskPlan,
  taskContractMatchesPaths,
  writeAdvisoryEvaluation,
  writeSessionHandoff,
  writeTaskPlan,
  writeTaskSession,
} from "../src/lib/task-session.js";
import { GIT_MAX_BUFFER_BYTES, getTaskTreeFingerprint } from "../src/lib/git.js";
import type { AdvisoryEvaluation, ContextPack, SessionMode, VerifyRunResult } from "../src/lib/types.js";

function makeContextPack(taskPath = "broker-core/index.mjs", sessionMode: SessionMode = "standard"): ContextPack {
  return {
    canonicalRoots: ["broker-core"],
    commitRequired: true,
    defaultCommands: ["npm run agent:context -- --paths <files>"],
    editingHints: ["Broker state mutation must go through the broker-core authority."],
    gitHistoryCommands: [`git log --oneline -- ${taskPath}`],
    manifestPathConstraints: [{
      allowedPaths: ["broker-core/**"],
      forbiddenPaths: [".agents/**"],
      manifestId: "broker-runtime",
    }],
    manifests: ["broker-runtime"],
    obligationCommands: ["npm run agent:verify -- --profile broker-live-proof --paths <files>"],
    owners: ["broker-runtime"],
    paths: [taskPath],
    primarySpecs: ["spec/README.md"],
    requiredEvidence: ["verify:implementation"],
    requiredSkills: ["spec-creation-updating"],
    sessionMode,
    verificationObligations: [{
      acceptableProfiles: ["broker-live-proof"],
      boundary: "broker-authority",
      description: "Exercise the broker capacity reconcile proof.",
      id: "broker-capacity-reconcile-proof",
      matchedPaths: [taskPath],
      requiredProofKind: "simulated-flow",
      scenario: "capacity-reconcile",
    }],
    verificationProfiles: ["implementation"],
  };
}

function populateLongRunningArtifacts(sessionDir: string, evaluationOverrides: Partial<AdvisoryEvaluation> = {}): void {
  writeTaskPlan(sessionDir, {
    ...readTaskPlan(sessionDir),
    deliverables: ["Implement the required harness change."],
    implementationSlices: ["Update session artifacts and completion logic."],
    objective: "Land the requested long-running harness improvement.",
    verificationPlan: ["npm run agent:verify -- --profile implementation --paths <files>"],
  });
  writeSessionHandoff(sessionDir, {
    ...readSessionHandoff(sessionDir),
    nextSteps: ["Finalize verification and close the task session."],
    status: "in-progress",
    summary: "Long-running session is active and resumable.",
  });
  writeAdvisoryEvaluation(sessionDir, {
    ...readAdvisoryEvaluation(sessionDir),
    findings: ["No blocking completeness gaps in this fixture."],
    recommendedAction: "continue",
    scores: {
      "code-quality": 4,
      "product-completeness": 4,
      "ux-clarity": 4,
      "visual-quality": 3,
    },
    status: "pass",
    summary: "Advisory review passed for the fixture.",
    ...evaluationOverrides,
  });
}

function runGit(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).replace(/\r?\n$/, "");
}

function makeStructuredCommitMessage(
  summary: string,
  session = "artifacts/agent-harness/test-session",
  verification = "Harness unit test fixture only.",
): string {
  return [
    summary,
    "",
    "Why:",
    "- Exercise the task close-out contract in tests.",
    "Changed:",
    "- Updated the task path fixture for this test case.",
    "Verification:",
    `- ${verification}`,
    "Affected:",
    "- broker-core/index.mjs",
    "Refs:",
    "- spec/build-and-test.md",
    "Session:",
    `- ${session}`,
  ].join("\n");
}

function makeMalformedStructuredCommitMessage(summary: string): string {
  return [
    summary,
    "",
    "Changed:",
    "- Updated the task path fixture for this test case.",
    "Verification:",
    "- Harness unit test fixture only.",
    "Affected:",
    "- broker-core/index.mjs",
    "Refs:",
    "- spec/build-and-test.md",
    "Session:",
    "- artifacts/agent-harness/test-session",
  ].join("\n");
}

function createRepoFixture(taskRelativePath = "broker-core/index.mjs"): {
  repoRoot: string;
  sessionDir: string;
  taskFilePath: string;
} {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "agent-harness-task-repo-"));
  const taskFilePath = path.join(repoRoot, taskRelativePath);
  const sessionDir = path.join(repoRoot, "artifacts/agent-harness/test-session");

  mkdirSync(path.dirname(taskFilePath), { recursive: true });
  writeFileSync(taskFilePath, "initial\n");
  runGit(repoRoot, ["init"]);
  runGit(repoRoot, ["config", "user.name", "Agent Harness"]);
  runGit(repoRoot, ["config", "user.email", "agent-harness@example.com"]);
  runGit(repoRoot, ["add", "."]);
  runGit(repoRoot, ["commit", "-m", makeStructuredCommitMessage("Initial fixture commit")]);

  return { repoRoot, sessionDir, taskFilePath };
}

function commitTaskChange(repoRoot: string, taskFilePath: string, message = makeStructuredCommitMessage("Update task fixture")): void {
  const current = readFileSync(taskFilePath, "utf8");
  writeFileSync(taskFilePath, `${current}${path.basename(taskFilePath)} updated\n`);
  runGit(repoRoot, ["add", path.relative(repoRoot, taskFilePath)]);
  runGit(repoRoot, ["commit", "-m", message]);
}

function writeVerifyResult(sessionDir: string, profileId: string, result: VerifyRunResult): void {
  const artifactsDir = getSessionVerifyArtifactsDir(sessionDir, profileId);
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(path.join(artifactsDir, "verify-result.json"), JSON.stringify(result, null, 2));
}

function makeVerifyResult(overrides: Partial<VerifyRunResult> & Pick<VerifyRunResult, "profileId" | "proofKind">): VerifyRunResult {
  return {
    advisory: false,
    artifacts: [],
    artifactsDir: "/tmp/unused",
    commands: [],
    coversBoundaries: [],
    coversScenarios: [],
    generatedAt: "2026-03-14T00:00:00.000Z",
    passed: true,
    paths: ["broker-core/index.mjs"],
    requiredArtifactsMissing: [],
    requiredArtifactsPresent: [],
    summary: [],
    warnings: [],
    ...overrides,
  };
}

function makeCurrentVerifyResult(
  repoRoot: string,
  contract: ReturnType<typeof writeTaskSession>,
  overrides: Partial<VerifyRunResult> & Pick<VerifyRunResult, "profileId" | "proofKind">,
): VerifyRunResult {
  return makeVerifyResult({
    taskContractId: contract.contractId,
    taskTreeFingerprint: getTaskTreeFingerprint(repoRoot, contract.paths),
    ...overrides,
  });
}

describe("task completion gate", () => {
  it("configures Git subprocesses for large repository outputs", () => {
    expect(GIT_MAX_BUFFER_BYTES).toBeGreaterThan(16 * 1024 * 1024);
  });

  it("changes the task tree fingerprint when a tracked executable bit changes", () => {
    const { repoRoot, taskFilePath } = createRepoFixture("scripts/task.sh");
    const before = getTaskTreeFingerprint(repoRoot, ["scripts/task.sh"]);

    chmodSync(taskFilePath, 0o755);
    const after = getTaskTreeFingerprint(repoRoot, ["scripts/task.sh"]);

    expect(after).not.toBe(before);
    rmSync(repoRoot, { force: true, recursive: true });
  });

  it("changes the task tree fingerprint when a tracked dangling symlink target changes", () => {
    const repoRoot = mkdtempSync(path.join(os.tmpdir(), "agent-harness-symlink-"));
    const symlinkPath = path.join(repoRoot, "links/dangling");

    runGit(repoRoot, ["init"]);
    runGit(repoRoot, ["config", "user.name", "Agent Harness"]);
    runGit(repoRoot, ["config", "user.email", "agent-harness@example.com"]);
    mkdirSync(path.dirname(symlinkPath), { recursive: true });
    symlinkSync("missing-one", symlinkPath);
    runGit(repoRoot, ["add", "links/dangling"]);
    runGit(repoRoot, ["commit", "-m", makeStructuredCommitMessage("Add dangling symlink fixture")]);
    const before = getTaskTreeFingerprint(repoRoot, ["links/dangling"]);

    rmSync(symlinkPath);
    symlinkSync("missing-two", symlinkPath);
    const after = getTaskTreeFingerprint(repoRoot, ["links/dangling"]);

    expect(before).toMatch(/^sha256:/);
    expect(after).toMatch(/^sha256:/);
    expect(after).not.toBe(before);
    rmSync(repoRoot, { force: true, recursive: true });
  });

  it("fingerprints tracked submodule gitlinks without reading the checkout directory", () => {
    const repoRoot = mkdtempSync(path.join(os.tmpdir(), "agent-harness-gitlink-"));
    const gitlinkPath = "vendor/submodule";
    const firstObjectId = "0123456789012345678901234567890123456789";
    const secondObjectId = "1111111111111111111111111111111111111111";

    runGit(repoRoot, ["init"]);
    mkdirSync(path.join(repoRoot, gitlinkPath), { recursive: true });
    runGit(repoRoot, ["update-index", "--add", "--cacheinfo", `160000,${firstObjectId},${gitlinkPath}`]);
    const before = getTaskTreeFingerprint(repoRoot, [gitlinkPath]);

    runGit(repoRoot, ["update-index", "--add", "--cacheinfo", `160000,${secondObjectId},${gitlinkPath}`]);
    const after = getTaskTreeFingerprint(repoRoot, [gitlinkPath]);

    expect(before).toMatch(/^sha256:/);
    expect(after).toMatch(/^sha256:/);
    expect(after).not.toBe(before);
    rmSync(repoRoot, { force: true, recursive: true });
  });

  it("changes the task tree fingerprint when a submodule checkout head or dirty state changes", () => {
    const repoRoot = mkdtempSync(path.join(os.tmpdir(), "agent-harness-submodule-state-"));
    const gitlinkPath = "vendor/submodule";
    const submoduleRoot = path.join(repoRoot, gitlinkPath);

    runGit(repoRoot, ["init"]);
    mkdirSync(submoduleRoot, { recursive: true });
    runGit(submoduleRoot, ["init"]);
    runGit(submoduleRoot, ["config", "user.name", "Agent Harness"]);
    runGit(submoduleRoot, ["config", "user.email", "agent-harness@example.com"]);
    writeFileSync(path.join(submoduleRoot, "file.txt"), "one\n");
    runGit(submoduleRoot, ["add", "file.txt"]);
    runGit(submoduleRoot, ["commit", "-m", "Initial submodule commit"]);
    const firstHead = runGit(submoduleRoot, ["rev-parse", "HEAD"]);
    runGit(repoRoot, ["update-index", "--add", "--cacheinfo", `160000,${firstHead},${gitlinkPath}`]);
    const before = getTaskTreeFingerprint(repoRoot, [gitlinkPath]);

    writeFileSync(path.join(submoduleRoot, "file.txt"), "two\n");
    runGit(submoduleRoot, ["add", "file.txt"]);
    runGit(submoduleRoot, ["commit", "-m", "Move submodule checkout"]);
    const afterHeadMove = getTaskTreeFingerprint(repoRoot, [gitlinkPath]);

    writeFileSync(path.join(submoduleRoot, "file.txt"), "dirty\n");
    const afterDirtyChange = getTaskTreeFingerprint(repoRoot, [gitlinkPath]);

    expect(before).toMatch(/^sha256:/);
    expect(afterHeadMove).toMatch(/^sha256:/);
    expect(afterDirtyChange).toMatch(/^sha256:/);
    expect(afterHeadMove).not.toBe(before);
    expect(afterDirtyChange).not.toBe(afterHeadMove);
    rmSync(repoRoot, { force: true, recursive: true });
  });

  it("passes when required profiles and stronger compatible proof obligations are satisfied in-session", () => {
    const { repoRoot, sessionDir, taskFilePath } = createRepoFixture();
    const contextPack = makeContextPack();
    contextPack.verificationObligations[0]!.acceptableProfiles = ["broker-live-proof"];

    const contract = writeTaskSession(sessionDir, contextPack, repoRoot);
    commitTaskChange(repoRoot, taskFilePath);
    writeVerifyResult(sessionDir, "implementation", makeCurrentVerifyResult(repoRoot, contract, {
      profileId: "implementation",
      proofKind: "code",
    }));
    writeVerifyResult(sessionDir, "broker-live-proof", makeCurrentVerifyResult(repoRoot, contract, {
      coversBoundaries: ["broker-authority"],
      coversScenarios: ["capacity-reconcile"],
      profileId: "broker-live-proof",
      proofKind: "live-e2e",
    }));

    const result = evaluateTaskCompletion(sessionDir, repoRoot, readTaskContract(sessionDir), loadSessionVerifyResults(sessionDir));

    expect(result.status).toBe("passed");
    expect(result.passed).toBe(true);
    expect(result.requiredProfileResults.every((entry) => entry.satisfied)).toBe(true);
    expect(result.obligationResults.every((entry) => entry.satisfied)).toBe(true);
    rmSync(repoRoot, { force: true, recursive: true });
  });

  it("fails a long-running session when the required planning artifacts stay as placeholders", () => {
    const { repoRoot, sessionDir, taskFilePath } = createRepoFixture();
    const contextPack = makeContextPack("broker-core/index.mjs", "long-running");
    contextPack.verificationObligations = [];

    const contract = writeTaskSession(sessionDir, contextPack, repoRoot);
    commitTaskChange(repoRoot, taskFilePath);
    writeVerifyResult(sessionDir, "implementation", makeCurrentVerifyResult(repoRoot, contract, {
      profileId: "implementation",
      proofKind: "code",
    }));

    const result = evaluateTaskCompletion(sessionDir, repoRoot, readTaskContract(sessionDir), loadSessionVerifyResults(sessionDir));

    expect(result.status).toBe("failed");
    expect(result.summary.find((entry) => entry.name === "session-artifacts")?.passed).toBe(false);
    expect(result.sessionArtifactResults.filter((entry) => entry.required && entry.satisfied === false)).toHaveLength(3);
    rmSync(repoRoot, { force: true, recursive: true });
  });

  it("passes a long-running session when plan, handoff, and advisory evaluation are populated", () => {
    const { repoRoot, sessionDir, taskFilePath } = createRepoFixture();
    const contextPack = makeContextPack("broker-core/index.mjs", "long-running");
    contextPack.verificationObligations = [];

    const contract = writeTaskSession(sessionDir, contextPack, repoRoot);
    populateLongRunningArtifacts(sessionDir);
    commitTaskChange(repoRoot, taskFilePath);
    writeVerifyResult(sessionDir, "implementation", makeCurrentVerifyResult(repoRoot, contract, {
      profileId: "implementation",
      proofKind: "code",
    }));

    const result = evaluateTaskCompletion(sessionDir, repoRoot, readTaskContract(sessionDir), loadSessionVerifyResults(sessionDir));

    expect(result.status).toBe("passed");
    expect(result.sessionArtifactResults.every((entry) => entry.satisfied)).toBe(true);
    rmSync(repoRoot, { force: true, recursive: true });
  });

  it("does not recover a missing verify result as passing when detached status is terminal failure", () => {
    const { repoRoot, sessionDir } = createRepoFixture("spec/README.md");
    const contextPack = makeContextPack("spec/README.md");
    contextPack.requiredEvidence = ["verify:spec-only"];
    contextPack.verificationObligations = [];
    contextPack.verificationProfiles = ["spec-only"];

    writeTaskSession(sessionDir, contextPack, repoRoot);
    const artifactsDir = getSessionVerifyArtifactsDir(sessionDir, "spec-only");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(path.join(artifactsDir, "paths.txt"), "spec/README.md\n");
    writeFileSync(path.join(artifactsDir, "result.json"), JSON.stringify({ passed: true }));
    writeFileSync(
      path.join(artifactsDir, "detached-run.json"),
      JSON.stringify({
        artifactPath: path.join(artifactsDir, "detached-run.json"),
        command: "npm run agent:verify -- --detach",
        commentaryPolicy: "event-only",
        cwd: repoRoot,
        failureReason: "Run timed out after 1000ms.",
        lastMaterialEvent: {
          at: "2026-03-14T00:00:02.000Z",
          status: "timeout",
          type: "timeout",
        },
        logPaths: {
          stderr: path.join(artifactsDir, "detached", "run", "stderr.log"),
          stdout: path.join(artifactsDir, "detached", "run", "stdout.log"),
        },
        pid: 12345,
        resultPath: path.join(artifactsDir, "verify-result.json"),
        resumeCommand: "npm run agent:detached-status -- --wait",
        startedAt: "2026-03-14T00:00:00.000Z",
        status: "timeout",
        statusCommand: "npm run agent:detached-status",
        statusUpdatedAt: "2026-03-14T00:00:02.000Z",
        stderrPath: path.join(artifactsDir, "detached", "run", "stderr.log"),
        stdoutPath: path.join(artifactsDir, "detached", "run", "stdout.log"),
        timeoutMs: 1000,
        version: 1,
      }),
    );

    const recovered = loadSessionVerifyResults(sessionDir).find((entry) => entry.result.profileId === "spec-only");

    expect(recovered?.result.passed).toBe(false);
    expect(recovered?.result.summary.find((entry) => entry.name === "detached-run-status")?.passed).toBe(false);
    expect(recovered?.result.summary.find((entry) => entry.name === "detached-run-status")?.details.join(" ")).toContain("timeout");
    rmSync(repoRoot, { force: true, recursive: true });
  });

  it("does not accept an existing passing verify result while detached status blocks completion", () => {
    const { repoRoot, sessionDir } = createRepoFixture("spec/README.md");
    const contextPack = makeContextPack("spec/README.md");
    contextPack.requiredEvidence = ["verify:spec-only"];
    contextPack.verificationObligations = [];
    contextPack.verificationProfiles = ["spec-only"];

    writeTaskSession(sessionDir, contextPack, repoRoot);
    const artifactsDir = getSessionVerifyArtifactsDir(sessionDir, "spec-only");
    writeVerifyResult(sessionDir, "spec-only", makeVerifyResult({
      profileId: "spec-only",
      proofKind: "contract",
    }));
    writeFileSync(
      path.join(artifactsDir, "detached-run.json"),
      JSON.stringify({
        artifactPath: path.join(artifactsDir, "detached-run.json"),
        command: "npm run agent:verify -- --detach",
        commentaryPolicy: "event-only",
        cwd: repoRoot,
        lastMaterialEvent: {
          at: "2026-03-14T00:00:00.000Z",
          status: "running",
          type: "started",
        },
        logPaths: {
          stderr: path.join(artifactsDir, "detached", "run", "stderr.log"),
          stdout: path.join(artifactsDir, "detached", "run", "stdout.log"),
        },
        pid: 12345,
        resultPath: path.join(artifactsDir, "verify-result.json"),
        resumeCommand: "npm run agent:detached-status -- --wait",
        startedAt: "2026-03-14T00:00:00.000Z",
        status: "running",
        statusCommand: "npm run agent:detached-status",
        statusUpdatedAt: "2026-03-14T00:00:00.000Z",
        stderrPath: path.join(artifactsDir, "detached", "run", "stderr.log"),
        stdoutPath: path.join(artifactsDir, "detached", "run", "stdout.log"),
        timeoutMs: 1000,
        version: 1,
      }),
    );

    const loaded = loadSessionVerifyResults(sessionDir).find((entry) => entry.result.profileId === "spec-only");

    expect(loaded?.result.passed).toBe(false);
    expect(loaded?.result.summary.find((entry) => entry.name === "detached-run-status")?.passed).toBe(false);
    expect(loaded?.result.summary.find((entry) => entry.name === "detached-run-status")?.details.join(" ")).toContain("still running");
    rmSync(repoRoot, { force: true, recursive: true });
  });

  it("fails when only advisory proof is present for a blocking obligation", () => {
    const { repoRoot, sessionDir, taskFilePath } = createRepoFixture();
    const contextPack = makeContextPack();
    contextPack.verificationObligations[0]!.acceptableProfiles = ["broker-advisory-proof"];

    const contract = writeTaskSession(sessionDir, contextPack, repoRoot);
    commitTaskChange(repoRoot, taskFilePath);
    writeVerifyResult(sessionDir, "implementation", makeCurrentVerifyResult(repoRoot, contract, {
      profileId: "implementation",
      proofKind: "code",
    }));
    writeVerifyResult(sessionDir, "broker-advisory-proof", makeCurrentVerifyResult(repoRoot, contract, {
      advisory: true,
      coversBoundaries: ["broker-authority"],
      coversScenarios: ["capacity-reconcile"],
      profileId: "broker-advisory-proof",
      proofKind: "simulated-flow",
    }));

    const result = evaluateTaskCompletion(sessionDir, repoRoot, readTaskContract(sessionDir), loadSessionVerifyResults(sessionDir));

    expect(result.status).toBe("failed");
    expect(result.obligationResults[0]?.details.join(" ")).toContain("Advisory profiles do not satisfy blocking verification obligations.");
    rmSync(repoRoot, { force: true, recursive: true });
  });

  it("returns blocked when requirements are unsatisfied but the session is explicitly marked blocked", () => {
    const { repoRoot, sessionDir } = createRepoFixture();
    const contract = writeTaskSession(sessionDir, makeContextPack(), repoRoot);

    const result = evaluateTaskCompletion(
      sessionDir,
      repoRoot,
      contract,
      loadSessionVerifyResults(sessionDir),
      [{ note: "external credential is unavailable in this environment.", reason: "missing-credentials" }],
    );

    expect(result.status).toBe("blocked");
    expect(result.passed).toBe(false);
    expect(result.summary.find((entry) => entry.name === "blocker-declaration")?.passed).toBe(false);
    rmSync(repoRoot, { force: true, recursive: true });
  });

  it("requires verify runs to use the same normalized path set as the task contract", () => {
    const { repoRoot, sessionDir } = createRepoFixture();
    const contract = writeTaskSession(sessionDir, makeContextPack(), repoRoot);

    expect(taskContractMatchesPaths(contract, ["broker-core/index.mjs"])).toBe(true);
    expect(taskContractMatchesPaths(contract, ["spec/README.md"])).toBe(false);
    rmSync(repoRoot, { force: true, recursive: true });
  });

  it("fails when the task commit message is not structured", () => {
    const { repoRoot, sessionDir, taskFilePath } = createRepoFixture();
    const contract = writeTaskSession(sessionDir, makeContextPack(), repoRoot);

    commitTaskChange(repoRoot, taskFilePath, makeMalformedStructuredCommitMessage("Bad message"));
    writeVerifyResult(sessionDir, "implementation", makeCurrentVerifyResult(repoRoot, contract, {
      profileId: "implementation",
      proofKind: "code",
    }));

    const result = evaluateTaskCompletion(sessionDir, repoRoot, readTaskContract(sessionDir), loadSessionVerifyResults(sessionDir));

    expect(result.status).toBe("failed");
    expect(result.commitCheck.details.join(" ")).toContain("Missing commit section Why:");
    rmSync(repoRoot, { force: true, recursive: true });
  });

  it("rejects local machine paths in every new commit touching task paths", () => {
    const { repoRoot, sessionDir, taskFilePath } = createRepoFixture();
    const syntheticHomePath = path.join(path.parse(repoRoot).root, "Users", "synthetic-user", ".codex", "private-task-session");
    const contextPack = makeContextPack();
    contextPack.verificationObligations = [];
    const contract = writeTaskSession(sessionDir, contextPack, repoRoot);

    expect(path.isAbsolute(syntheticHomePath)).toBe(true);
    commitTaskChange(
      repoRoot,
      taskFilePath,
      makeStructuredCommitMessage("Leaky task commit", undefined, `Evidence at ${syntheticHomePath}.`),
    );
    commitTaskChange(repoRoot, taskFilePath);
    writeVerifyResult(sessionDir, "implementation", makeCurrentVerifyResult(repoRoot, contract, {
      profileId: "implementation",
      proofKind: "code",
    }));

    const result = evaluateTaskCompletion(sessionDir, repoRoot, readTaskContract(sessionDir), loadSessionVerifyResults(sessionDir));

    expect(result.status).toBe("failed");
    expect(result.commitCheck.details.join(" ")).toContain("Commit message contains local machine path(s).");
    rmSync(repoRoot, { force: true, recursive: true });
  });

  it("rejects parent-relative task-session paths in commit messages", () => {
    const { repoRoot, sessionDir, taskFilePath } = createRepoFixture();
    const contextPack = makeContextPack();
    contextPack.verificationObligations = [];
    const contract = writeTaskSession(sessionDir, contextPack, repoRoot);

    commitTaskChange(
      repoRoot,
      taskFilePath,
      makeStructuredCommitMessage("Escaping task-session reference", undefined, "Evidence at ../../.codex/private-task-session."),
    );
    writeVerifyResult(sessionDir, "implementation", makeCurrentVerifyResult(repoRoot, contract, {
      profileId: "implementation",
      proofKind: "code",
    }));

    const result = evaluateTaskCompletion(sessionDir, repoRoot, readTaskContract(sessionDir), loadSessionVerifyResults(sessionDir));

    expect(result.status).toBe("failed");
    expect(result.commitCheck.details.join(" ")).toContain("Commit message contains local machine path(s).");
    rmSync(repoRoot, { force: true, recursive: true });
  });

  it("accepts public-safe artifact labels for simulator-broker task sessions", () => {
    const { repoRoot, taskFilePath } = createRepoFixture();
    const sessionRoot = mkdtempSync(path.join(os.tmpdir(), "agent-harness-public-session-root-"));
    const sessionName = "public-safe-commit-metadata";
    const sessionDir = path.join(sessionRoot, "agent-harness", "simulator-broker", sessionName);
    const contextPack = makeContextPack();
    contextPack.verificationObligations = [];
    const contract = writeTaskSession(sessionDir, contextPack, repoRoot);

    commitTaskChange(
      repoRoot,
      taskFilePath,
      makeStructuredCommitMessage(
        "Public-safe task commit",
        `task-session: [task artifact: task-sessions/${sessionName}]`,
        `Verification recorded in [task artifact: task-sessions/${sessionName}/verify/implementation].`,
      ),
    );
    writeVerifyResult(sessionDir, "implementation", makeCurrentVerifyResult(repoRoot, contract, {
      profileId: "implementation",
      proofKind: "code",
    }));

    const result = evaluateTaskCompletion(sessionDir, repoRoot, readTaskContract(sessionDir), loadSessionVerifyResults(sessionDir));

    expect(result.status).toBe("passed");
    expect(result.commitCheck.passed).toBe(true);
    rmSync(repoRoot, { force: true, recursive: true });
    rmSync(sessionRoot, { force: true, recursive: true });
  });

  it("accepts public-safe artifact labels for historical simulator-broker-app session paths", () => {
    const { repoRoot, taskFilePath } = createRepoFixture();
    const sessionRoot = mkdtempSync(path.join(os.tmpdir(), "agent-harness-legacy-session-root-"));
    const sessionName = "legacy-app-slug-commit-metadata";
    const sessionDir = path.join(sessionRoot, "agent-harness", "simulator-broker-app", sessionName);
    const contextPack = makeContextPack();
    contextPack.verificationObligations = [];
    const contract = writeTaskSession(sessionDir, contextPack, repoRoot);

    commitTaskChange(
      repoRoot,
      taskFilePath,
      makeStructuredCommitMessage(
        "Public-safe task commit",
        `task-session: [task artifact: task-sessions/${sessionName}]`,
        `Verification recorded in [task artifact: task-sessions/${sessionName}/verify/implementation].`,
      ),
    );
    writeVerifyResult(sessionDir, "implementation", makeCurrentVerifyResult(repoRoot, contract, {
      profileId: "implementation",
      proofKind: "code",
    }));

    const result = evaluateTaskCompletion(sessionDir, repoRoot, readTaskContract(sessionDir), loadSessionVerifyResults(sessionDir));

    expect(result.status).toBe("passed");
    expect(result.commitCheck.passed).toBe(true);
    rmSync(repoRoot, { force: true, recursive: true });
    rmSync(sessionRoot, { force: true, recursive: true });
  });

  it("does not match task session identifiers by prefix", () => {
    const { repoRoot, sessionDir, taskFilePath } = createRepoFixture();
    const contextPack = makeContextPack();
    contextPack.verificationObligations = [];
    const contract = writeTaskSession(sessionDir, contextPack, repoRoot);
    const wrongSessionMessage = makeStructuredCommitMessage("Wrong session reference")
      .replaceAll("artifacts/agent-harness/test-session", "artifacts/agent-harness/test-session-10");

    commitTaskChange(repoRoot, taskFilePath, wrongSessionMessage);
    writeVerifyResult(sessionDir, "implementation", makeCurrentVerifyResult(repoRoot, contract, {
      profileId: "implementation",
      proofKind: "code",
    }));

    const result = evaluateTaskCompletion(sessionDir, repoRoot, readTaskContract(sessionDir), loadSessionVerifyResults(sessionDir));

    expect(result.status).toBe("failed");
    expect(result.commitCheck.passed).toBe(false);
    expect(result.commitCheck.details.join(" ")).toContain("No new commit touching task paths was created");
    expect(result.commitCheck.details.join(" ")).toContain("Session section does not reference this task session.");
    rmSync(repoRoot, { force: true, recursive: true });
  });

  it("does not match parent task sessions from nested child session paths", () => {
    const { repoRoot, sessionDir, taskFilePath } = createRepoFixture();
    const contextPack = makeContextPack();
    contextPack.verificationObligations = [];
    const contract = writeTaskSession(sessionDir, contextPack, repoRoot);
    const nestedSessionMessage = makeStructuredCommitMessage("Nested session reference")
      .replaceAll("artifacts/agent-harness/test-session", "artifacts/agent-harness/test-session/retry");

    commitTaskChange(repoRoot, taskFilePath, nestedSessionMessage);
    writeVerifyResult(sessionDir, "implementation", makeCurrentVerifyResult(repoRoot, contract, {
      profileId: "implementation",
      proofKind: "code",
    }));

    const result = evaluateTaskCompletion(sessionDir, repoRoot, readTaskContract(sessionDir), loadSessionVerifyResults(sessionDir));

    expect(result.status).toBe("failed");
    expect(result.commitCheck.passed).toBe(false);
    expect(result.commitCheck.details.join(" ")).toContain("No new commit touching task paths was created");
    expect(result.commitCheck.details.join(" ")).toContain("Session section does not reference this task session.");
    rmSync(repoRoot, { force: true, recursive: true });
  });

  it("fails clean close-out for new untracked junk outside the task path set", () => {
    const { repoRoot, sessionDir, taskFilePath } = createRepoFixture();
    const contextPack = makeContextPack();
    contextPack.verificationObligations = [];
    const contract = writeTaskSession(sessionDir, contextPack, repoRoot);

    commitTaskChange(repoRoot, taskFilePath);
    writeFileSync(path.join(repoRoot, "debug-notes.txt"), "temporary\n");
    writeVerifyResult(sessionDir, "implementation", makeCurrentVerifyResult(repoRoot, contract, {
      profileId: "implementation",
      proofKind: "code",
    }));

    const result = evaluateTaskCompletion(sessionDir, repoRoot, readTaskContract(sessionDir), loadSessionVerifyResults(sessionDir));

    expect(result.status).toBe("failed");
    expect(result.worktreeCheck.passed).toBe(false);
    expect(result.worktreeCheck.details.join(" ")).toContain("debug-notes.txt");
    rmSync(repoRoot, { force: true, recursive: true });
  });

  it("fails when an unstructured direct task commit is followed by a structured one", () => {
    const { repoRoot, sessionDir, taskFilePath } = createRepoFixture();
    const contextPack = makeContextPack();
    contextPack.verificationObligations = [];
    const contract = writeTaskSession(sessionDir, contextPack, repoRoot);

    commitTaskChange(repoRoot, taskFilePath, "Unstructured task change");
    commitTaskChange(repoRoot, taskFilePath);
    writeVerifyResult(sessionDir, "implementation", makeCurrentVerifyResult(repoRoot, contract, {
      profileId: "implementation",
      proofKind: "code",
    }));

    const result = evaluateTaskCompletion(sessionDir, repoRoot, readTaskContract(sessionDir), loadSessionVerifyResults(sessionDir));

    expect(result.status).toBe("failed");
    expect(result.commitCheck.passed).toBe(false);
    expect(result.commitCheck.details.join(" ")).toContain("Missing commit section Why:");
    rmSync(repoRoot, { force: true, recursive: true });
  });

  it("fails when task files change after a passing verify result is recorded", () => {
    const { repoRoot, sessionDir, taskFilePath } = createRepoFixture();
    const contextPack = makeContextPack();
    contextPack.verificationObligations = [];
    const contract = writeTaskSession(sessionDir, contextPack, repoRoot);

    commitTaskChange(repoRoot, taskFilePath);
    writeVerifyResult(sessionDir, "implementation", makeVerifyResult({
      profileId: "implementation",
      proofKind: "code",
      taskContractId: contract.contractId,
      taskTreeFingerprint: getTaskTreeFingerprint(repoRoot, contract.paths),
    }));
    commitTaskChange(repoRoot, taskFilePath, makeStructuredCommitMessage("Post verify change"));

    const result = evaluateTaskCompletion(sessionDir, repoRoot, readTaskContract(sessionDir), loadSessionVerifyResults(sessionDir));

    expect(result.status).toBe("failed");
    expect(result.requiredProfileResults[0]?.details.join(" ")).toContain("stale task tree");
    rmSync(repoRoot, { force: true, recursive: true });
  });

  it("fails when a committed file is allowed by the manifest but outside the task contract paths", () => {
    const { repoRoot, sessionDir, taskFilePath } = createRepoFixture();
    const contextPack = makeContextPack();
    contextPack.verificationObligations = [];
    const contract = writeTaskSession(sessionDir, contextPack, repoRoot);
    const adjacentFilePath = path.join(repoRoot, "broker-core/adjacent.mjs");

    commitTaskChange(repoRoot, taskFilePath);
    writeVerifyResult(sessionDir, "implementation", makeVerifyResult({
      profileId: "implementation",
      proofKind: "code",
      taskContractId: contract.contractId,
      taskTreeFingerprint: getTaskTreeFingerprint(repoRoot, contract.paths),
    }));
    writeFileSync(adjacentFilePath, "export const adjacent = true;\n");
    runGit(repoRoot, ["add", "broker-core/adjacent.mjs"]);
    runGit(repoRoot, ["commit", "-m", makeStructuredCommitMessage("Adjacent manifest path")]);

    const result = evaluateTaskCompletion(sessionDir, repoRoot, readTaskContract(sessionDir), loadSessionVerifyResults(sessionDir));

    expect(result.status).toBe("failed");
    expect(result.summary.find((entry) => entry.name === "task-path-coverage")?.passed).toBe(false);
    expect(result.summary.find((entry) => entry.name === "task-path-coverage")?.details.join(" ")).toContain("broker-core/adjacent.mjs");
    rmSync(repoRoot, { force: true, recursive: true });
  });

  it("fails when a passing required profile omits the task tree fingerprint", () => {
    const { repoRoot, sessionDir, taskFilePath } = createRepoFixture();
    const contextPack = makeContextPack();
    contextPack.verificationObligations = [];
    const contract = writeTaskSession(sessionDir, contextPack, repoRoot);

    commitTaskChange(repoRoot, taskFilePath);
    writeVerifyResult(sessionDir, "implementation", makeVerifyResult({
      profileId: "implementation",
      proofKind: "code",
      taskContractId: contract.contractId,
    }));

    const result = evaluateTaskCompletion(sessionDir, repoRoot, readTaskContract(sessionDir), loadSessionVerifyResults(sessionDir));

    expect(result.status).toBe("failed");
    expect(result.requiredProfileResults[0]?.details.join(" ")).toContain("without recording a task tree fingerprint");
    rmSync(repoRoot, { force: true, recursive: true });
  });

  it("fails when a blocking obligation proof omits the task tree fingerprint", () => {
    const { repoRoot, sessionDir, taskFilePath } = createRepoFixture();
    const contextPack = makeContextPack();
    contextPack.verificationObligations[0]!.acceptableProfiles = ["broker-live-proof"];

    const contract = writeTaskSession(sessionDir, contextPack, repoRoot);
    commitTaskChange(repoRoot, taskFilePath);
    writeVerifyResult(sessionDir, "implementation", makeCurrentVerifyResult(repoRoot, contract, {
      profileId: "implementation",
      proofKind: "code",
    }));
    writeVerifyResult(sessionDir, "broker-live-proof", makeVerifyResult({
      coversBoundaries: ["broker-authority"],
      coversScenarios: ["capacity-reconcile"],
      profileId: "broker-live-proof",
      proofKind: "live-e2e",
      taskContractId: contract.contractId,
    }));

    const result = evaluateTaskCompletion(sessionDir, repoRoot, readTaskContract(sessionDir), loadSessionVerifyResults(sessionDir));

    expect(result.status).toBe("failed");
    expect(result.obligationResults[0]?.details.join(" ")).toContain("without recording a task tree fingerprint");
    rmSync(repoRoot, { force: true, recursive: true });
  });

  it("fails when committed paths violate selected manifest path constraints", () => {
    const { repoRoot, sessionDir, taskFilePath } = createRepoFixture();
    const contextPack = makeContextPack();
    contextPack.verificationObligations = [];
    const contract = writeTaskSession(sessionDir, contextPack, repoRoot);
    const forbiddenPath = path.join(repoRoot, ".agents/manifests/runtime.yaml");
    mkdirSync(path.dirname(forbiddenPath), { recursive: true });

    commitTaskChange(repoRoot, taskFilePath);
    writeFileSync(forbiddenPath, "id: runtime\n");
    runGit(repoRoot, ["add", ".agents/manifests/runtime.yaml"]);
    runGit(repoRoot, ["commit", "-m", makeStructuredCommitMessage("Forbidden harness path")]);
    writeVerifyResult(sessionDir, "implementation", makeVerifyResult({
      profileId: "implementation",
      proofKind: "code",
      taskContractId: contract.contractId,
      taskTreeFingerprint: getTaskTreeFingerprint(repoRoot, contract.paths),
    }));

    const result = evaluateTaskCompletion(sessionDir, repoRoot, readTaskContract(sessionDir), loadSessionVerifyResults(sessionDir));

    expect(result.status).toBe("failed");
    expect(result.summary.find((entry) => entry.name === "manifest-path-constraints")?.passed).toBe(false);
    expect(result.summary.find((entry) => entry.name === "manifest-path-constraints")?.details.join(" ")).toContain(".agents/manifests/runtime.yaml");
    rmSync(repoRoot, { force: true, recursive: true });
  });

  it("fails when any selected manifest forbids a committed path that another selected manifest allows", () => {
    const { repoRoot, sessionDir, taskFilePath } = createRepoFixture();
    const contextPack = makeContextPack();
    contextPack.verificationObligations = [];
    contextPack.manifests = ["broker-runtime", "harness-contract"];
    contextPack.manifestPathConstraints = [
      {
        allowedPaths: ["broker-core/**"],
        forbiddenPaths: [],
        manifestId: "broker-runtime",
      },
      {
        allowedPaths: [".agents/**"],
        forbiddenPaths: ["broker-core/**"],
        manifestId: "harness-contract",
      },
    ];
    const contract = writeTaskSession(sessionDir, contextPack, repoRoot);

    commitTaskChange(repoRoot, taskFilePath);
    writeVerifyResult(sessionDir, "implementation", makeCurrentVerifyResult(repoRoot, contract, {
      profileId: "implementation",
      proofKind: "code",
    }));

    const result = evaluateTaskCompletion(sessionDir, repoRoot, readTaskContract(sessionDir), loadSessionVerifyResults(sessionDir));

    expect(result.status).toBe("failed");
    expect(result.summary.find((entry) => entry.name === "manifest-path-constraints")?.passed).toBe(false);
    expect(result.summary.find((entry) => entry.name === "manifest-path-constraints")?.details.join(" ")).toContain("broker-core/index.mjs: forbidden by selected manifest harness-contract");
    rmSync(repoRoot, { force: true, recursive: true });
  });

  it("fails when a dirty baseline task file changes again after the session starts", () => {
    const { repoRoot, sessionDir, taskFilePath } = createRepoFixture();
    writeFileSync(taskFilePath, "dirty before session\n");
    const contract = writeTaskSession(sessionDir, makeContextPack(), repoRoot);

    commitTaskChange(repoRoot, taskFilePath);
    writeFileSync(taskFilePath, "dirty after structured commit\n");
    writeVerifyResult(sessionDir, "implementation", makeCurrentVerifyResult(repoRoot, contract, {
      profileId: "implementation",
      proofKind: "code",
    }));

    const result = evaluateTaskCompletion(sessionDir, repoRoot, readTaskContract(sessionDir), loadSessionVerifyResults(sessionDir));

    expect(result.status).toBe("failed");
    expect(result.worktreeCheck.passed).toBe(false);
    expect(result.worktreeCheck.details.join(" ")).toContain("broker-core/index.mjs");
    rmSync(repoRoot, { force: true, recursive: true });
  });

  it("ignores merged upstream commits that touch task paths when validating task commits", () => {
    const { repoRoot, sessionDir, taskFilePath } = createRepoFixture();
    const currentBranch = runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const contextPack = makeContextPack();
    contextPack.verificationObligations = [];
    const contract = writeTaskSession(sessionDir, contextPack, repoRoot);

    runGit(repoRoot, ["checkout", "-b", "upstream-sync"]);
    writeFileSync(taskFilePath, "upstream change\n");
    runGit(repoRoot, ["add", path.relative(repoRoot, taskFilePath)]);
    runGit(repoRoot, ["commit", "-m", "Upstream sync commit"]);
    runGit(repoRoot, ["checkout", currentBranch]);
    runGit(repoRoot, ["merge", "--no-ff", "upstream-sync", "-m", "Merge upstream-sync"]);

    commitTaskChange(repoRoot, taskFilePath);
    writeVerifyResult(sessionDir, "implementation", makeCurrentVerifyResult(repoRoot, contract, {
      profileId: "implementation",
      proofKind: "code",
    }));

    const result = evaluateTaskCompletion(sessionDir, repoRoot, readTaskContract(sessionDir), loadSessionVerifyResults(sessionDir));

    expect(result.status).toBe("passed");
    expect(result.commitCheck.passed).toBe(true);
    expect(result.taskCommitShas).toHaveLength(1);
    rmSync(repoRoot, { force: true, recursive: true });
  });

  it("fails clean close-out for task paths with spaces", () => {
    const taskRelativePath = "examples/harness-adoption/sample consumer/README.md";
    const { repoRoot, sessionDir, taskFilePath } = createRepoFixture(taskRelativePath);
    const contextPack = makeContextPack(taskRelativePath);
    contextPack.verificationObligations = [];
    const contract = writeTaskSession(sessionDir, contextPack, repoRoot);

    commitTaskChange(repoRoot, taskFilePath);
    writeFileSync(taskFilePath, "dirty after structured commit\n");
    writeVerifyResult(sessionDir, "implementation", makeCurrentVerifyResult(repoRoot, contract, {
      paths: [taskRelativePath],
      profileId: "implementation",
      proofKind: "code",
    }));

    const result = evaluateTaskCompletion(sessionDir, repoRoot, readTaskContract(sessionDir), loadSessionVerifyResults(sessionDir));

    expect(result.status).toBe("failed");
    expect(result.worktreeCheck.passed).toBe(false);
    expect(result.worktreeCheck.details.join(" ")).toContain(taskRelativePath);
    rmSync(repoRoot, { force: true, recursive: true });
  });
});
