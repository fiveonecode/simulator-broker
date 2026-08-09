// -------------------------------------------------------------------------- //
//                                  IMPORTS                                   //
// -------------------------------------------------------------------------- //

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import dayjs from "dayjs";
import picomatch from "picomatch";

import {
  buildHarnessCatalog,
  renderCatalogMarkdown,
  syncCatalogDocs,
  validateCatalogDocs,
  validateInstructionCommands,
} from "./lib/catalog.js";
import {
  getRepoRoot,
  loadEvalCases,
  loadManifests,
  loadVerifyProfiles,
  matchManifestIdsForPath,
  resolveOperationalVerificationProfiles,
  resolvePaths,
  validateEvalCases,
  validateManifestCoverage,
  validateManifestIds,
  validateVerifyProfiles,
} from "./lib/config.js";
import { buildContextPack, renderContextMarkdown } from "./lib/context.js";
import {
  getDetachedVerifyResultReadLimitBytes,
  getDetachedVerifyTimeoutMs,
} from "./lib/detached-verify.js";
import {
  assertProtocolPathDoesNotAlias,
  buildDetachedRunReservedProtocolPaths,
  buildDetachedRunResultClaimPath,
  buildWindowsObservedProcessIdentityPath,
  findActiveDetachedRun,
  getDetachedRunArtifactProtocolName,
  inspectDetachedRun,
  shouldPreserveDetachedRunArtifactForCurrentProcess,
  startDetachedRun,
  waitForDetachedRunEvent,
  withDetachedRunLaunchClaim,
} from "./lib/detached-run.js";
import { resolveEvalCasePaths } from "./lib/eval.js";
import { getTaskTreeFingerprint, getTrackedFiles, getWorkingTreeChangedFiles, prepareWorktreeForRef } from "./lib/git.js";
import {
  evaluateTaskCompletion,
  getAdvisoryEvaluationPath,
  getAdvisoryEvaluationRubricPath,
  getSessionVerifyArtifactsDir,
  getSessionHandoffPath,
  getTaskContractPath,
  getTaskPlanPath,
  loadSessionVerifyResults,
  readAdvisoryEvaluation,
  readSessionHandoff,
  readTaskContract,
  readTaskContextPack,
  readTaskPlan,
  resolveSessionDir,
  taskContractMatchesPaths,
  writeAdvisoryEvaluation,
  writeSessionHandoff,
  writeTaskPlan,
  writeTaskSession,
} from "./lib/task-session.js";
import {
  createArtifactsDirectory,
  finalizeJsonOutput,
  getExplicitFlagValue,
  getFlagValue,
  getListFlag,
  makeRuleResult,
  parseArguments,
  shellQuote,
} from "./lib/runtime.js";
import { checkScorecardThresholds, compareScorecards, makeScorecard } from "./lib/scorecard.js";
import { checkSoakThresholds, makeSoakReport } from "./lib/soak.js";
import { validateRelatedLines } from "./lib/spec.js";
import { executeVerifyProfile } from "./lib/verify.js";
import type {
  AdvisoryEvaluation,
  AdvisoryEvaluationCriterionId,
  ContextPack,
  EvalCase,
  EvalCaseResult,
  EvalRunResult,
  ManifestRecord,
  PreflightResult,
  RuleResult,
  Scorecard,
  ScorecardThresholds,
  SessionHandoff,
  SessionMode,
  TaskBlocker,
  TaskBlockerReason,
  TaskPlan,
  SoakThresholds,
  VerifyProfile,
} from "./lib/types.js";

// -------------------------------------------------------------------------- //
//                                 HELPERS                                    //
// -------------------------------------------------------------------------- //

function failWithUsage(message: string): never {
  throw new Error(message);
}

function getExplicitPaths(flags: Map<string, string[]>, repoRoot: string): string[] {
  const inlinePaths = getListFlag(flags, "paths");
  const pathsFile = getFlagValue(flags, "paths-file");

  if (inlinePaths.length > 0) {
    return inlinePaths;
  }

  if (pathsFile) {
    const source = readFileSync(path.resolve(repoRoot, pathsFile), "utf8");
    return source
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .sort();
  }

  return [];
}

function getPaths(flags: Map<string, string[]>, repoRoot: string): string[] {
  const explicitPaths = getExplicitPaths(flags, repoRoot);

  if (explicitPaths.length > 0) {
    return explicitPaths;
  }

  return getWorkingTreeChangedFiles(repoRoot);
}

function getProfileById(profileId: string, profiles: VerifyProfile[]): VerifyProfile {
  const profile = profiles.find((candidate) => candidate.id === profileId);

  if (profile === undefined) {
    throw new Error(`Unknown verify profile '${profileId}'.`);
  }

  return profile;
}

const TASK_BLOCKER_REASONS: TaskBlockerReason[] = [
  "environment-misconfigured",
  "missing-credentials",
  "network-unavailable",
  "provider-outage",
  "simulator-prereq",
  "user-dependency",
];

const SESSION_MODES: SessionMode[] = ["standard", "long-running"];
const ADVISORY_CRITERIA_IDS: AdvisoryEvaluationCriterionId[] = [
  "product-completeness",
  "ux-clarity",
  "visual-quality",
  "code-quality",
];
const PREFLIGHT_AUTORUN_PROFILES = new Set([
  "implementation",
  "spec-only",
]);

function getOrderedListFlag(flags: Map<string, string[]>, key: string): string[] {
  const values = flags.get(key) ?? [];

  return values
    .map((value) => value.trim())
    .filter(Boolean);
}

function ensureTwinInstructionsMatch(repoRoot: string): RuleResult {
  const agentsPath = path.join(repoRoot, "AGENTS.md");
  const claudePath = path.join(repoRoot, "CLAUDE.md");
  const agentsSource = readFileSync(agentsPath, "utf8");
  const claudeSource = readFileSync(claudePath, "utf8");

  return makeRuleResult(
    agentsSource === claudeSource ? [] : ["AGENTS.md and CLAUDE.md differ."],
    "instruction-twins",
    agentsSource === claudeSource,
  );
}

function ensureRelatedLines(paths: string[], repoRoot: string): RuleResult {
  const checks = paths
    .filter((candidate) => candidate.startsWith("spec/2.0/") && candidate.endsWith(".md"))
    .map((candidate) => validateRelatedLines(path.join(repoRoot, candidate)));
  const details = checks.flatMap((result, index) => {
    const candidatePath = paths.filter((candidate) => candidate.startsWith("spec/2.0/") && candidate.endsWith(".md"))[index] ?? "spec/2.0";
    return result.details.map((detail) => `${candidatePath}: ${detail}`);
  });

  return makeRuleResult(details, "related-lines", checks.every((result) => result.passed));
}

function loadScorecardInput(inputPath: string, repoRoot: string): EvalRunResult {
  const resolvedPath = path.resolve(repoRoot, inputPath);
  const candidatePath = existsSync(resolvedPath) && resolvedPath.endsWith(".json")
    ? resolvedPath
    : path.join(resolvedPath, "eval-result.json");

  if (existsSync(candidatePath) === false) {
    throw new Error(`Could not find eval-result.json at ${candidatePath}.`);
  }

  return JSON.parse(readFileSync(candidatePath, "utf8")) as EvalRunResult;
}

function parseOptionalNumberFlag(flags: Map<string, string[]>, key: string): number | undefined {
  const value = getFlagValue(flags, key);

  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (Number.isFinite(parsed) === false) {
    throw new Error(`Expected --${key} to be a number.`);
  }

  return parsed;
}

function parsePositiveIntegerFlag(flags: Map<string, string[]>, key: string): number | undefined {
  const value = parseOptionalNumberFlag(flags, key);
  if (value === undefined) {
    return undefined;
  }

  if (Number.isInteger(value) === false || value <= 0) {
    throw new Error(`Expected --${key} to be a positive integer.`);
  }

  return value;
}

function getScorecardThresholds(flags: Map<string, string[]>): ScorecardThresholds {
  return {
    maxAverageContextBytesIncrease: parseOptionalNumberFlag(flags, "max-context-increase-bytes"),
    maxAverageVerifyRuntimeMsIncrease: parseOptionalNumberFlag(flags, "max-runtime-increase-ms"),
    maxFirstPassSuccessRateDrop: parseOptionalNumberFlag(flags, "max-first-pass-drop"),
    maxGraderFalseFailureCountIncrease: parseOptionalNumberFlag(flags, "max-grader-false-failure-increase"),
    maxWithinThreeAttemptsRateDrop: parseOptionalNumberFlag(flags, "max-within-three-drop"),
  };
}

function hasScorecardThresholds(thresholds: ScorecardThresholds): boolean {
  return Object.values(thresholds).some((value) => value !== undefined);
}

function getSoakThresholds(flags: Map<string, string[]>): SoakThresholds {
  return {
    maxCaseFailureRate: parseOptionalNumberFlag(flags, "max-case-failure-rate"),
    maxFlakyCases: parseOptionalNumberFlag(flags, "max-flaky-cases"),
  };
}

function hasSoakThresholds(thresholds: SoakThresholds): boolean {
  return Object.values(thresholds).some((value) => value !== undefined);
}

function getSessionDirectory(flags: Map<string, string[]>, repoRoot: string): string | undefined {
  const sessionDir = getFlagValue(flags, "session-dir");

  if (sessionDir === undefined) {
    return undefined;
  }

  return resolveSessionDir(sessionDir, repoRoot);
}

function getSessionMode(flags: Map<string, string[]>, sessionDir?: string): SessionMode {
  const persistedSessionMode = sessionDir && existsSync(getTaskContractPath(sessionDir))
    ? readTaskContract(sessionDir).sessionMode
    : undefined;
  const sessionMode = getFlagValue(flags, "session-mode") ?? persistedSessionMode ?? "standard";

  if (SESSION_MODES.includes(sessionMode as SessionMode) === false) {
    throw new Error(`Expected --session-mode to be one of ${SESSION_MODES.join(", ")}.`);
  }

  return sessionMode as SessionMode;
}

function stripStandardSessionScaffolding(contextPack: ContextPack): ContextPack {
  const {
    advisoryEvaluationCommand: _advisoryEvaluationCommand,
    advisoryEvaluationPath: _advisoryEvaluationPath,
    advisoryEvaluationRubricPath: _advisoryEvaluationRubricPath,
    handoffCommand: _handoffCommand,
    planCommand: _planCommand,
    sessionCommands: _sessionCommands,
    sessionHandoffPath: _sessionHandoffPath,
    taskPlanPath: _taskPlanPath,
    ...slimmedContextPack
  } = contextPack;

  return slimmedContextPack;
}

function buildSessionCommandSet(sessionDir: string): {
  advisoryEvaluationCommand: string;
  advisoryEvaluationPath: string;
  advisoryEvaluationRubricPath: string;
  handoffCommand: string;
  planCommand: string;
  sessionCommands: string[];
  sessionHandoffPath: string;
  taskPlanPath: string;
} {
  const quotedSessionDir = shellQuote(sessionDir);
  const planCommand = `npm run agent:plan -- --session-dir ${quotedSessionDir}`;
  const handoffCommand = `npm run agent:handoff -- --session-dir ${quotedSessionDir}`;
  const advisoryEvaluationCommand = `npm run agent:evaluate -- --session-dir ${quotedSessionDir}`;

  return {
    advisoryEvaluationCommand,
    advisoryEvaluationPath: getAdvisoryEvaluationPath(sessionDir),
    advisoryEvaluationRubricPath: getAdvisoryEvaluationRubricPath(sessionDir),
    handoffCommand,
    planCommand,
    sessionCommands: [
      planCommand,
      handoffCommand,
      advisoryEvaluationCommand,
    ],
    sessionHandoffPath: getSessionHandoffPath(sessionDir),
    taskPlanPath: getTaskPlanPath(sessionDir),
  };
}

function parseAdvisoryScores(flags: Map<string, string[]>): Partial<Record<AdvisoryEvaluationCriterionId, number>> {
  const scores: Partial<Record<AdvisoryEvaluationCriterionId, number>> = {};

  getOrderedListFlag(flags, "score").forEach((entry) => {
    const [criterionId, rawValue] = entry.split("=", 2);
    if (!criterionId || !rawValue) {
      throw new Error(`Expected --score entries to look like criterion=number. Received: ${entry}`);
    }

    if (ADVISORY_CRITERIA_IDS.includes(criterionId as AdvisoryEvaluationCriterionId) === false) {
      throw new Error(`Unknown advisory criterion ${criterionId}.`);
    }

    const score = Number(rawValue);
    if (Number.isInteger(score) === false || score < 1 || score > 5) {
      throw new Error(`Expected advisory score for ${criterionId} to be an integer between 1 and 5.`);
    }

    scores[criterionId as AdvisoryEvaluationCriterionId] = score;
  });

  return scores;
}

function parseNotApplicableCriteria(flags: Map<string, string[]>): AdvisoryEvaluationCriterionId[] {
  return getOrderedListFlag(flags, "not-applicable").map((criterionId) => {
    if (ADVISORY_CRITERIA_IDS.includes(criterionId as AdvisoryEvaluationCriterionId) === false) {
      throw new Error(`Unknown advisory criterion ${criterionId}.`);
    }

    return criterionId as AdvisoryEvaluationCriterionId;
  });
}

function getTaskBlockers(flags: Map<string, string[]>): TaskBlocker[] {
  const reason = getFlagValue(flags, "blocked-reason");
  const note = getFlagValue(flags, "blocked-note");

  if (reason === undefined) {
    return [];
  }

  if (TASK_BLOCKER_REASONS.includes(reason as TaskBlockerReason) === false) {
    throw new Error(`Expected --blocked-reason to be one of ${TASK_BLOCKER_REASONS.join(", ")}.`);
  }

  return [{
    note,
    reason: reason as TaskBlockerReason,
  }];
}

function applyPlanFlags(existing: TaskPlan, flags: Map<string, string[]>): TaskPlan {
  const objective = getFlagValue(flags, "objective");

  return {
    ...existing,
    assumptions: flags.has("assumption") ? getOrderedListFlag(flags, "assumption") : existing.assumptions,
    deliverables: flags.has("deliverable") ? getOrderedListFlag(flags, "deliverable") : existing.deliverables,
    implementationSlices: flags.has("slice") ? getOrderedListFlag(flags, "slice") : existing.implementationSlices,
    objective: objective ?? existing.objective,
    openQuestions: flags.has("open-question") ? getOrderedListFlag(flags, "open-question") : existing.openQuestions,
    outOfScope: flags.has("out-of-scope") ? getOrderedListFlag(flags, "out-of-scope") : existing.outOfScope,
    risks: flags.has("risk") ? getOrderedListFlag(flags, "risk") : existing.risks,
    verificationPlan: flags.has("verification-step") ? getOrderedListFlag(flags, "verification-step") : existing.verificationPlan,
  };
}

function applyHandoffFlags(existing: SessionHandoff, flags: Map<string, string[]>): SessionHandoff {
  const status = getFlagValue(flags, "status");
  const currentFocus = getFlagValue(flags, "current-focus");
  const summary = getFlagValue(flags, "summary");

  if (status && ["not-started", "in-progress", "blocked", "ready-for-handoff", "completed"].includes(status) === false) {
    throw new Error("Expected --status to be one of not-started, in-progress, blocked, ready-for-handoff, completed.");
  }

  return {
    ...existing,
    artifacts: flags.has("artifact") ? getOrderedListFlag(flags, "artifact") : existing.artifacts,
    completedWork: flags.has("completed-work") ? getOrderedListFlag(flags, "completed-work") : existing.completedWork,
    currentFocus: currentFocus ?? existing.currentFocus,
    decisions: flags.has("decision") ? getOrderedListFlag(flags, "decision") : existing.decisions,
    nextSteps: flags.has("next-step") ? getOrderedListFlag(flags, "next-step") : existing.nextSteps,
    openRisks: flags.has("open-risk") ? getOrderedListFlag(flags, "open-risk") : existing.openRisks,
    resumeCommands: flags.has("resume-command") ? getOrderedListFlag(flags, "resume-command") : existing.resumeCommands,
    status: (status as SessionHandoff["status"] | undefined) ?? existing.status,
    summary: summary ?? existing.summary,
  };
}

function applyAdvisoryEvaluationFlags(existing: AdvisoryEvaluation, flags: Map<string, string[]>): AdvisoryEvaluation {
  const status = getFlagValue(flags, "status");
  const recommendedAction = getFlagValue(flags, "recommended-action");
  const summary = getFlagValue(flags, "summary");

  if (status && ["not-run", "pass", "needs-follow-up"].includes(status) === false) {
    throw new Error("Expected --status to be one of not-run, pass, needs-follow-up.");
  }

  if (recommendedAction && ["continue", "revise", "escalate"].includes(recommendedAction) === false) {
    throw new Error("Expected --recommended-action to be one of continue, revise, escalate.");
  }

  return {
    ...existing,
    findings: flags.has("finding") ? getOrderedListFlag(flags, "finding") : existing.findings,
    gaps: flags.has("gap") ? getOrderedListFlag(flags, "gap") : existing.gaps,
    notApplicableCriteria: flags.has("not-applicable") ? parseNotApplicableCriteria(flags) : existing.notApplicableCriteria,
    recommendedAction: (recommendedAction as AdvisoryEvaluation["recommendedAction"] | undefined) ?? existing.recommendedAction,
    scores: flags.has("score")
      ? {
          ...existing.scores,
          ...parseAdvisoryScores(flags),
        }
      : existing.scores,
    status: (status as AdvisoryEvaluation["status"] | undefined) ?? existing.status,
    strengths: flags.has("strength") ? getOrderedListFlag(flags, "strength") : existing.strengths,
    summary: summary ?? existing.summary,
  };
}

async function runVerifyForProfile(
  artifactsDir: string,
  paths: string[],
  profileId: string,
  profiles: VerifyProfile[],
  repoRoot: string,
  taskContractId?: string,
  taskTreeFingerprint?: string,
): Promise<ReturnType<typeof executeVerifyProfile>> {
  const profile = getProfileById(profileId, profiles);
  const detachedRunArtifactPath = path.join(artifactsDir, "detached-run.json");
  const preserveDetachedRunArtifact = await shouldPreserveDetachedRunArtifactForCurrentProcess(
    detachedRunArtifactPath,
  );
  return await executeVerifyProfile({
    artifactsDir,
    detachedRunArtifactPath,
    paths,
    preserveDetachedRunArtifact,
    profile,
    repoRoot,
    taskContractId,
    taskTreeFingerprint,
  });
}

async function runEvalSuiteAtRepoRoot(
  artifactsDir: string,
  attemptCount: number,
  caseId: string | undefined,
  explicitPaths: string[],
  graderFalseFailureCount: number,
  repoRoot: string,
  runner: string,
  suiteId: string,
): Promise<EvalRunResult> {
  const manifests = loadManifests(repoRoot);
  const profiles = loadVerifyProfiles(repoRoot);
  const fallbackPaths = explicitPaths.length > 0 ? explicitPaths : getWorkingTreeChangedFiles(repoRoot);
  const evalCases = loadEvalCases(repoRoot);
  const selectedCases = evalCases.filter((candidateCase) => {
    if (caseId) {
      return candidateCase.id === caseId;
    }

    if (suiteId === "all") {
      return true;
    }

    return candidateCase.suite === suiteId;
  });

  if (selectedCases.length === 0) {
    failWithUsage("eval requires --case <case-id> or --suite <suite-id> that resolves to at least one case.");
  }

  const caseResults: EvalCaseResult[] = [];

  for (const candidateCase of selectedCases) {
    const casePaths = resolveEvalCasePaths(candidateCase, explicitPaths, fallbackPaths);
    const matchedManifestIds = [...new Set(casePaths.flatMap((candidatePath) => matchManifestIdsForPath(manifests, candidatePath)))].sort();
    caseResults.push(
      await evaluateCase(
        artifactsDir,
        attemptCount,
        candidateCase,
        graderFalseFailureCount,
        manifests,
        matchedManifestIds,
        casePaths,
        profiles,
        repoRoot,
        runner,
      ),
    );
  }

  const result: EvalRunResult = {
    attemptCount,
    caseResults,
    generatedAt: dayjs().toISOString(),
    graderFalseFailureCount,
    runner,
    suiteId,
  };

  writeFileSync(path.join(artifactsDir, "eval-result.json"), JSON.stringify(result, null, 2));
  return result;
}

async function resolveScorecardSubject(
  artifactsRoot: string,
  input: string,
  repoRoot: string,
  runner: string,
  suiteId: string,
): Promise<{ cleanup?: () => void; evalRun: EvalRunResult; source: { artifactsDir?: string; input: string; type: "eval-result" | "git-ref" | "worktree" } }> {
  const resolvedPath = path.resolve(repoRoot, input);

  if (existsSync(resolvedPath)) {
    return {
      evalRun: loadScorecardInput(input, repoRoot),
      source: {
        input,
        type: "eval-result",
      },
    };
  }

  if (input === "worktree") {
    const artifactsDir = path.join(artifactsRoot, "current-worktree");
    return {
      evalRun: await runEvalSuiteAtRepoRoot(artifactsDir, 1, undefined, [], 0, repoRoot, runner, suiteId),
      source: {
        artifactsDir,
        input,
        type: "worktree",
      },
    };
  }

  const preparedWorktree = prepareWorktreeForRef(repoRoot, input);
  const artifactsDir = path.join(artifactsRoot, `ref-${input.replace(/[^a-zA-Z0-9._-]+/g, "-")}`);

  return {
    cleanup: preparedWorktree.cleanup,
    evalRun: await runEvalSuiteAtRepoRoot(artifactsDir, 1, undefined, [], 0, preparedWorktree.repoPath, runner, suiteId),
    source: {
      artifactsDir,
      input,
      type: "git-ref",
    },
  };
}

async function evaluateCase(
  artifactsDir: string,
  attemptCount: number,
  candidateCase: EvalCase,
  graderFalseFailureCount: number,
  manifests: ManifestRecord[],
  matchedManifestIds: string[],
  paths: string[],
  profiles: VerifyProfile[],
  repoRoot: string,
  runner: string,
): Promise<EvalCaseResult> {
  const caseArtifactsDir = path.join(artifactsDir, candidateCase.id);
  const contextPack = buildContextPack(manifests, profiles, matchedManifestIds, paths);
  const gradingResults: RuleResult[] = [];
  const verifyResult = await runVerifyForProfile(caseArtifactsDir, paths, candidateCase.verification_profile, profiles, repoRoot);

  candidateCase.grading_rules.forEach((rule) => {
    if (rule.kind === "changed_files_within_allowed") {
      const invalidPaths = paths.filter((candidatePath) => candidateCase.allowed_paths.some((pattern) => pathMatches(pattern, candidatePath)) === false);
      gradingResults.push(makeRuleResult(invalidPaths, "changed-files-within-allowed", invalidPaths.length === 0));
      return;
    }

    if (rule.kind === "forbid_paths") {
      const forbiddenMatches = paths.filter((candidatePath) => rule.values.some((pattern) => pathMatches(pattern, candidatePath)));
      gradingResults.push(makeRuleResult(forbiddenMatches, "forbid-paths", forbiddenMatches.length === 0));
      return;
    }

    if (rule.kind === "require_artifacts") {
      const missingArtifacts = rule.values.filter((pattern) => verifyResult.artifacts.some((artifactPath) => pathMatches(pattern, artifactPath)) === false);
      gradingResults.push(makeRuleResult(missingArtifacts, "require-artifacts", missingArtifacts.length === 0));
      return;
    }

    if (rule.kind === "require_changed_paths") {
      const missingPaths = rule.values.filter((pattern) => paths.some((candidatePath) => pathMatches(pattern, candidatePath)) === false);
      gradingResults.push(makeRuleResult(missingPaths, "require-changed-paths", missingPaths.length === 0));
      return;
    }

    if (rule.kind === "require_manifests") {
      const missingManifestIds = rule.values.filter((manifestId) => matchedManifestIds.includes(manifestId) === false);
      gradingResults.push(makeRuleResult(missingManifestIds, "require-manifests", missingManifestIds.length === 0));
      return;
    }

    if (rule.kind === "require_profile_pass") {
      gradingResults.push(makeRuleResult(
        verifyResult.passed ? [] : [`Verification profile ${candidateCase.verification_profile} failed.`],
        "require-profile-pass",
        verifyResult.passed,
      ));
    }
  });

  void graderFalseFailureCount;

  return {
    attemptCount,
    caseId: candidateCase.id,
    changedFiles: [...paths].sort(),
    contextBytes: Buffer.byteLength(JSON.stringify(contextPack), "utf8"),
    gradingResults,
    passed: gradingResults.every((result) => result.passed),
    profileId: candidateCase.verification_profile,
    runner,
    surface: candidateCase.surface,
    title: candidateCase.title,
    verifyDurationMs: verifyResult.commands.reduce((sum, result) => sum + result.durationMs, 0),
    verifyPassed: verifyResult.passed,
  };
}

function pathMatches(pattern: string, candidatePath: string): boolean {
  return picomatch(pattern, { dot: true })(candidatePath);
}

function writeDetachedVerifyPathsFile(filePath: string, paths: string[]): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${dayjs().valueOf()}-${Math.random().toString(16).slice(2)}`;
  try {
    writeFileSync(temporaryPath, `${paths.join("\n")}\n`, { flag: "wx" });
    renameSync(temporaryPath, filePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function buildDetachedCliLogPaths(artifactPath: string): { stderr: string; stdout: string } {
  const protocolName = getDetachedRunArtifactProtocolName(artifactPath);
  const detachedDir = path.join(path.dirname(artifactPath), "detached", protocolName);
  return {
    stderr: path.join(detachedDir, "stderr.log"),
    stdout: path.join(detachedDir, "stdout.log"),
  };
}

function buildDetachedCliResultPath(artifactPath: string): string {
  return path.join(path.dirname(artifactPath), "detached", getDetachedRunArtifactProtocolName(artifactPath), "verify-result.json");
}

function assertSummaryFileDoesNotAliasProtocolPath(
  repoRoot: string,
  summaryFile: string | undefined,
  protocolDescription: string,
  protocolPath: string | undefined,
): void {
  if (summaryFile === undefined || protocolPath === undefined) {
    return;
  }

  assertProtocolPathDoesNotAlias(
    "Summary file",
    path.resolve(repoRoot, summaryFile),
    protocolDescription,
    protocolPath,
  );
}

function resolveSummaryFilePath(repoRoot: string, summaryFile: string | undefined): string | undefined {
  return summaryFile === undefined ? undefined : path.resolve(repoRoot, summaryFile);
}

function assertSummaryFileDoesNotAliasDetachedProtocolPaths(
  repoRoot: string,
  summaryFile: string | undefined,
  protocolPaths: Array<{ description: string; filePath: string | undefined }>,
): void {
  protocolPaths.forEach((protocolPath) => {
    assertSummaryFileDoesNotAliasProtocolPath(repoRoot, summaryFile, protocolPath.description, protocolPath.filePath);
  });
}

// -------------------------------------------------------------------------- //
//                                  COMMANDS                                  //
// -------------------------------------------------------------------------- //

async function main(): Promise<void> {
  const repoRoot = getRepoRoot();
  const parsedArguments = parseArguments(process.argv.slice(2));
  const artifactsDirFlag = getFlagValue(parsedArguments.flags, "artifacts-dir");
  const outputFormat = getFlagValue(parsedArguments.flags, "format") ?? "json";
  const summaryFile = resolveSummaryFilePath(repoRoot, getFlagValue(parsedArguments.flags, "summary-file"));

  if (parsedArguments.command === "detached-start") {
    const command = getExplicitFlagValue(parsedArguments.flags, "command");
    if (command === undefined || command.trim().length === 0) {
      failWithUsage("detached-start requires --command <shell-command>.");
    }

    const artifactFlag = getFlagValue(parsedArguments.flags, "artifact");
    const artifactPath = path.resolve(
      repoRoot,
      artifactFlag ?? path.join(createArtifactsDirectory(repoRoot, artifactsDirFlag), "detached-run.json"),
    );
    const cwd = path.resolve(repoRoot, getFlagValue(parsedArguments.flags, "cwd") ?? repoRoot);
    const resultPath = getFlagValue(parsedArguments.flags, "result-path");
    const phasePath = getFlagValue(parsedArguments.flags, "phase-path");
    const resolvedResultPath = resultPath === undefined ? buildDetachedCliResultPath(artifactPath) : path.resolve(repoRoot, resultPath);
    const resolvedPhasePath = phasePath === undefined ? undefined : path.resolve(repoRoot, phasePath);
    const logPaths = buildDetachedCliLogPaths(artifactPath);
    const detachedProtocolPaths = [
      { description: "detached run artifact", filePath: artifactPath },
      { description: "result artifact", filePath: resolvedResultPath },
      { description: "result artifact ownership lock", filePath: buildDetachedRunResultClaimPath(resolvedResultPath) },
      { description: "phase artifact", filePath: resolvedPhasePath },
      { description: "stdout log", filePath: logPaths.stdout },
      { description: "stderr log", filePath: logPaths.stderr },
      { description: "Windows process sidecar", filePath: buildWindowsObservedProcessIdentityPath(artifactPath) },
      ...buildDetachedRunReservedProtocolPaths(artifactPath, resolvedResultPath, resolvedPhasePath, logPaths),
    ];
    if (summaryFile !== undefined) {
      assertSummaryFileDoesNotAliasDetachedProtocolPaths(repoRoot, summaryFile, detachedProtocolPaths);
    }
    const result = await withDetachedRunLaunchClaim(artifactPath, async () => {
      return startDetachedRun({
        artifactPath,
        command,
        cwd,
        phasePath: resolvedPhasePath,
        resultReadLimitBytes: parsePositiveIntegerFlag(parsedArguments.flags, "result-read-limit-bytes"),
        resultPath: resolvedResultPath,
        timeoutMs: parsePositiveIntegerFlag(parsedArguments.flags, "timeout-ms"),
      });
    });

    if (summaryFile !== undefined) {
      assertSummaryFileDoesNotAliasDetachedProtocolPaths(repoRoot, summaryFile, detachedProtocolPaths);
    }
    finalizeJsonOutput(summaryFile, {
      detached: true,
      run: result,
    });
    if (result.status !== "passed" && result.status !== "running") {
      process.exitCode = 1;
    }
    return;
  }

  if (parsedArguments.command === "detached-status") {
    const artifact = getFlagValue(parsedArguments.flags, "artifact");
    if (artifact === undefined) {
      failWithUsage("detached-status requires --artifact <detached-run.json>.");
    }

    const artifactPath = path.resolve(repoRoot, artifact);
    assertSummaryFileDoesNotAliasProtocolPath(repoRoot, summaryFile, "detached run artifact", artifactPath);
    assertSummaryFileDoesNotAliasProtocolPath(
      repoRoot,
      summaryFile,
      "Windows process sidecar",
      buildWindowsObservedProcessIdentityPath(artifactPath),
    );
    const statusResult = parsedArguments.flags.has("wait")
      ? await waitForDetachedRunEvent({
          artifactPath,
          pollIntervalMs: parsePositiveIntegerFlag(parsedArguments.flags, "poll-interval-ms"),
          waitTimeoutMs: parsePositiveIntegerFlag(parsedArguments.flags, "wait-timeout-ms"),
        })
      : inspectDetachedRun({ artifactPath });

    if (statusResult === undefined || statusResult.shouldOutput === false) {
      return;
    }

    if (summaryFile !== undefined) {
      assertSummaryFileDoesNotAliasDetachedProtocolPaths(repoRoot, summaryFile, [
        { description: "detached run artifact", filePath: statusResult.artifact.artifactPath },
        { description: "result artifact", filePath: statusResult.artifact.resultPath },
        {
          description: "result artifact ownership lock",
          filePath: statusResult.artifact.resultPath === undefined ? undefined : buildDetachedRunResultClaimPath(statusResult.artifact.resultPath),
        },
        { description: "phase artifact", filePath: statusResult.artifact.phasePath },
        { description: "stdout log", filePath: statusResult.artifact.stdoutPath },
        { description: "stderr log", filePath: statusResult.artifact.stderrPath },
        { description: "Windows process sidecar", filePath: buildWindowsObservedProcessIdentityPath(statusResult.artifact.artifactPath) },
        ...buildDetachedRunReservedProtocolPaths(
          statusResult.artifact.artifactPath,
          statusResult.artifact.resultPath,
          statusResult.artifact.phasePath,
          {
            stderr: statusResult.artifact.stderrPath,
            stdout: statusResult.artifact.stdoutPath,
          },
        ),
      ]);
    }
    finalizeJsonOutput(summaryFile, statusResult);
    if (statusResult.artifact.status !== "passed" && statusResult.artifact.status !== "running") {
      process.exitCode = 1;
    }
    return;
  }

  const evalCases = loadEvalCases(repoRoot);
  const manifests = loadManifests(repoRoot);
  const profiles = loadVerifyProfiles(repoRoot);
  const catalog = buildHarnessCatalog(repoRoot, manifests, profiles, evalCases);

  if (parsedArguments.command === "doctor") {
    const hasExplicitPaths = parsedArguments.flags.has("paths") || parsedArguments.flags.has("paths-file");
    const paths = hasExplicitPaths ? getPaths(parsedArguments.flags, repoRoot) : [];
    const relevantManifestIds = [...new Set(paths.flatMap((candidatePath) => matchManifestIdsForPath(manifests, candidatePath)))].sort();
    const toolMap: Record<string, string[]> = {
      implementation: ["bash", "node", "npm", "xcodegen", "xcodebuild"],
      "spec-only": ["git", "node", "npm", "rg"],
    };
    const {
      baseProfiles,
      obligationProfiles,
      requiredProfiles,
    } = relevantManifestIds.length === 0
      ? {
          baseProfiles: profiles.map((profile) => profile.id).sort(),
          obligationProfiles: [] as string[],
          requiredProfiles: profiles.map((profile) => profile.id).sort(),
        }
      : resolveOperationalVerificationProfiles(manifests, relevantManifestIds, paths, profiles);

    const checks = requiredProfiles.map((profileId) => ({
      missingTools: (toolMap[profileId] ?? []).filter((toolName) => {
        try {
          execFileSync("bash", ["-lc", `command -v ${toolName}`], {
            cwd: repoRoot,
            stdio: "ignore",
          });
          return false;
        } catch {
          return true;
        }
      }),
      profileId,
      requiredTools: toolMap[profileId] ?? [],
    }));

    finalizeJsonOutput(summaryFile, {
      baseProfiles,
      checks,
      generatedAt: dayjs().toISOString(),
      obligationProfiles,
      paths,
      passed: checks.every((check) => check.missingTools.length === 0),
      relevantManifestIds,
    });
    return;
  }

  if (parsedArguments.command === "context") {
    const paths = getPaths(parsedArguments.flags, repoRoot);
    const resolution = resolvePaths(manifests, paths);

    if (resolution.overlaps.length > 0 || resolution.uncovered.length > 0) {
      finalizeJsonOutput(summaryFile, {
        paths,
        resolution,
      });
      process.exitCode = 1;
      return;
    }

    const matchedManifestIds = [...new Set(paths.flatMap((candidatePath) => matchManifestIdsForPath(manifests, candidatePath)))].sort();
    const sessionDir = getSessionDirectory(parsedArguments.flags, repoRoot);
    const sessionMode = getSessionMode(parsedArguments.flags, sessionDir);
    const contextPack = {
      ...buildContextPack(manifests, profiles, matchedManifestIds, paths),
      sessionMode,
      sessionModeArtifactRequirement: sessionMode === "long-running" ? "required" as const : "optional" as const,
    };
    const sessionAwareContextPack = sessionDir === undefined
      ? contextPack
      : (() => {
          const contract = writeTaskSession(sessionDir, contextPack, repoRoot);
          const sessionCommands = buildSessionCommandSet(sessionDir);

          return {
            ...contextPack,
            ...sessionCommands,
            completionCommand: `npm run agent:complete -- --session-dir ${shellQuote(sessionDir)}`,
            sessionDir,
            taskContractId: contract.contractId,
            taskContractPath: getTaskContractPath(sessionDir),
          };
        })();
    const publicContextPack = sessionDir !== undefined && sessionMode === "standard"
      ? stripStandardSessionScaffolding(sessionAwareContextPack)
      : sessionAwareContextPack;

    if (outputFormat === "md") {
      const markdown = renderContextMarkdown(publicContextPack);
      if (summaryFile) {
        writeFileSync(path.resolve(repoRoot, summaryFile), markdown);
      }
      process.stdout.write(markdown);
      return;
    }

    finalizeJsonOutput(summaryFile, publicContextPack);
    return;
  }

  if (parsedArguments.command === "plan") {
    const sessionDir = getSessionDirectory(parsedArguments.flags, repoRoot);
    if (sessionDir === undefined) {
      failWithUsage("plan requires --session-dir <dir>.");
    }

    readTaskContract(sessionDir);
    readTaskContextPack(sessionDir);
    const nextPlan = writeTaskPlan(sessionDir, applyPlanFlags(readTaskPlan(sessionDir), parsedArguments.flags));

    finalizeJsonOutput(summaryFile, {
      planPath: getTaskPlanPath(sessionDir),
      sessionDir,
      taskPlan: nextPlan,
    });
    return;
  }

  if (parsedArguments.command === "handoff") {
    const sessionDir = getSessionDirectory(parsedArguments.flags, repoRoot);
    if (sessionDir === undefined) {
      failWithUsage("handoff requires --session-dir <dir>.");
    }

    readTaskContract(sessionDir);
    readTaskContextPack(sessionDir);
    const nextHandoff = writeSessionHandoff(sessionDir, applyHandoffFlags(readSessionHandoff(sessionDir), parsedArguments.flags));

    finalizeJsonOutput(summaryFile, {
      handoffPath: getSessionHandoffPath(sessionDir),
      sessionDir,
      sessionHandoff: nextHandoff,
    });
    return;
  }

  if (parsedArguments.command === "evaluate") {
    const sessionDir = getSessionDirectory(parsedArguments.flags, repoRoot);
    if (sessionDir === undefined) {
      failWithUsage("evaluate requires --session-dir <dir>.");
    }

    readTaskContract(sessionDir);
    readTaskContextPack(sessionDir);
    const nextEvaluation = writeAdvisoryEvaluation(
      sessionDir,
      applyAdvisoryEvaluationFlags(readAdvisoryEvaluation(sessionDir), parsedArguments.flags),
    );

    finalizeJsonOutput(summaryFile, {
      advisoryEvaluation: nextEvaluation,
      advisoryEvaluationPath: getAdvisoryEvaluationPath(sessionDir),
      advisoryEvaluationRubricPath: getAdvisoryEvaluationRubricPath(sessionDir),
      sessionDir,
    });
    return;
  }

  if (parsedArguments.command === "catalog") {
    const writeDocs = getFlagValue(parsedArguments.flags, "write-docs") === "true";
    const format = getFlagValue(parsedArguments.flags, "format") ?? "json";

    if (writeDocs) {
      syncCatalogDocs(repoRoot, catalog);
    }

    if (format === "md") {
      const markdown = renderCatalogMarkdown(catalog);
      if (summaryFile) {
        const summaryPath = path.resolve(repoRoot, summaryFile);
        mkdirSync(path.dirname(summaryPath), { recursive: true });
        writeFileSync(summaryPath, markdown);
      }
      process.stdout.write(markdown);
      return;
    }

    finalizeJsonOutput(summaryFile, catalog);
    return;
  }

  if (parsedArguments.command === "config-contract") {
    const manifestValidation = validateManifestIds(manifests, profiles);
    const verifyProfileValidation = validateVerifyProfiles(profiles);
    const evalCaseValidation = validateEvalCases(evalCases, manifests, profiles);
    const result = {
      evalCaseValidation,
      manifestValidation,
      passed: manifestValidation.passed && verifyProfileValidation.passed && evalCaseValidation.passed,
      verifyProfileValidation,
    };

    finalizeJsonOutput(summaryFile, result);
    if (result.passed === false) {
      process.exitCode = 1;
    }
    return;
  }

  if (parsedArguments.command === "verify") {
    const profileId = getFlagValue(parsedArguments.flags, "profile");

    if (profileId === undefined) {
      failWithUsage("verify requires --profile <profile-id>");
    }

    const paths = getPaths(parsedArguments.flags, repoRoot);
    const sessionDir = getSessionDirectory(parsedArguments.flags, repoRoot);
    const taskContract = sessionDir ? readTaskContract(sessionDir) : undefined;
    if (taskContract && taskContractMatchesPaths(taskContract, paths) === false) {
      throw new Error(
        `Verify paths do not match the active task contract. Expected: ${taskContract.paths.join(", ")}. Received: ${[...paths].sort().join(", ")}.`,
      );
    }
    const artifactsDir = sessionDir
      ? getSessionVerifyArtifactsDir(sessionDir, profileId)
      : createArtifactsDirectory(repoRoot, artifactsDirFlag);
    const profile = getProfileById(profileId, profiles);
    if (parsedArguments.flags.has("detach")) {
      mkdirSync(artifactsDir, { recursive: true });
      const detachedDir = path.join(artifactsDir, "detached");
      mkdirSync(detachedDir, { recursive: true });
      const detachedPathsFilePath = path.join(detachedDir, "paths.txt");
      const artifactPath = path.join(artifactsDir, "detached-run.json");
      const resultPath = path.join(artifactsDir, "verify-result.json");
      const verifyPathsFilePath = path.join(artifactsDir, "paths.txt");
      const logPaths = buildDetachedCliLogPaths(artifactPath);
      if (summaryFile !== undefined) {
        assertSummaryFileDoesNotAliasDetachedProtocolPaths(repoRoot, summaryFile, [
          { description: "detached run artifact", filePath: artifactPath },
          { description: "result artifact", filePath: resultPath },
          { description: "result artifact ownership lock", filePath: buildDetachedRunResultClaimPath(resultPath) },
          { description: "detached verify paths file", filePath: detachedPathsFilePath },
          { description: "verification paths artifact", filePath: verifyPathsFilePath },
          { description: "stdout log", filePath: logPaths.stdout },
          { description: "stderr log", filePath: logPaths.stderr },
          { description: "Windows process sidecar", filePath: buildWindowsObservedProcessIdentityPath(artifactPath) },
          ...buildDetachedRunReservedProtocolPaths(artifactPath, resultPath, undefined, logPaths),
        ]);
      }
      const result = await withDetachedRunLaunchClaim(artifactPath, async () => {
        const activeRun = findActiveDetachedRun(artifactPath);
        if (activeRun !== undefined) {
          throw new Error(
            `Detached verification run already active for profile ${profileId} at ${artifactPath} with pid ${activeRun.pid}. Resume it with: ${activeRun.resumeCommand}`,
          );
        }
        writeDetachedVerifyPathsFile(detachedPathsFilePath, paths);

        const cliPath = path.join(repoRoot, "agent-harness", "src", "cli.ts");
        const tsxEntryPath = path.join(repoRoot, "agent-harness", "node_modules", "tsx", "dist", "cli.mjs");
        const commandArgs = [
          tsxEntryPath,
          cliPath,
          "verify",
          "--profile",
          profileId,
          "--paths-file",
          detachedPathsFilePath,
        ];
        if (sessionDir) {
          commandArgs.push("--session-dir", sessionDir);
        } else {
          commandArgs.push("--artifacts-dir", artifactsDir);
        }

        return startDetachedRun({
          artifactPath,
          beforeSpawn: () => {
            rmSync(resultPath, { force: true });
          },
          command: process.execPath,
          commandArgs,
          commentaryPolicy: "event-only",
          cwd: repoRoot,
          resultReadLimitBytes: getDetachedVerifyResultReadLimitBytes(profile),
          resultPath,
          timeoutMs: getDetachedVerifyTimeoutMs(profile),
        });
      });

      finalizeJsonOutput(summaryFile, {
        detached: true,
        profileId,
        run: result,
      });
      if (result.status !== "passed" && result.status !== "running") {
        process.exitCode = 1;
      }
      return;
    }

    const result = await runVerifyForProfile(
      artifactsDir,
      paths,
      profileId,
      profiles,
      repoRoot,
      taskContract?.contractId,
      taskContract ? getTaskTreeFingerprint(repoRoot, paths) : undefined,
    );

    finalizeJsonOutput(summaryFile, result);
    if (result.passed === false) {
      process.exitCode = 1;
    }
    return;
  }

  if (parsedArguments.command === "complete") {
    const sessionDir = getSessionDirectory(parsedArguments.flags, repoRoot);
    if (sessionDir === undefined) {
      failWithUsage("complete requires --session-dir <dir>");
    }

    const contract = readTaskContract(sessionDir);
    const verifyResults = loadSessionVerifyResults(sessionDir);
    const result = evaluateTaskCompletion(sessionDir, repoRoot, contract, verifyResults, getTaskBlockers(parsedArguments.flags));

    finalizeJsonOutput(summaryFile, result);
    if (result.status === "failed") {
      process.exitCode = 1;
    }
    if (result.status === "blocked") {
      process.exitCode = 2;
    }
    return;
  }

  if (parsedArguments.command === "preflight") {
    const artifactsDir = createArtifactsDirectory(repoRoot, artifactsDirFlag);
    const paths = getPaths(parsedArguments.flags, repoRoot);
    const docsSyncCheck = validateCatalogDocs(repoRoot, catalog);
    const evalCaseValidation = validateEvalCases(evalCases, manifests, profiles);
    const instructionCommandCheck = validateInstructionCommands(repoRoot, catalog);
    const manifestResolution = resolvePaths(manifests, paths);
    const matchedManifestIds = [...new Set(paths.flatMap((candidatePath) => matchManifestIdsForPath(manifests, candidatePath)))].sort();
    const trackedCoverage = validateManifestCoverage(manifests, getTrackedFiles(repoRoot));
    const manifestValidation = validateManifestIds(manifests, profiles);
    const twinInstructionCheck = ensureTwinInstructionsMatch(repoRoot);
    const verifyProfileValidation = validateVerifyProfiles(profiles);
    const relatedLineCheck = ensureRelatedLines(paths, repoRoot);
    const {
      baseProfiles,
      obligationProfiles,
      requiredProfiles,
    } = resolveOperationalVerificationProfiles(manifests, matchedManifestIds, paths, profiles);
    const requiredButSkippedProfiles = requiredProfiles
      .filter((profileId) => PREFLIGHT_AUTORUN_PROFILES.has(profileId) === false)
      .map((profileId) => ({
        profileId,
        reason: "heavy-simulator-proof",
      }));
    const verifyResults = [];
    const relevantProfileIds = requiredProfiles
      .filter((profileId) => PREFLIGHT_AUTORUN_PROFILES.has(profileId))
      .sort();

    for (const profileId of relevantProfileIds) {
      verifyResults.push(
        await runVerifyForProfile(path.join(artifactsDir, profileId), paths, profileId, profiles, repoRoot),
      );
    }

    const result: PreflightResult = {
      baseProfiles,
      changedPaths: paths,
      docsSyncCheck,
      evalCaseValidation,
      instructionCommandCheck,
      manifestCoverage: manifestResolution,
      manifestValidation,
      obligationProfiles,
      relatedLineCheck,
      requiredButSkippedProfiles,
      trackedCoverage,
      twinInstructionCheck,
      verifyResults,
      verifyProfileValidation,
    };

    finalizeJsonOutput(summaryFile, result);
    if (
      manifestResolution.overlaps.length > 0 ||
      manifestResolution.uncovered.length > 0 ||
      docsSyncCheck.passed === false ||
      evalCaseValidation.passed === false ||
      instructionCommandCheck.passed === false ||
      twinInstructionCheck.passed === false ||
      trackedCoverage.passed === false ||
      manifestValidation.passed === false ||
      relatedLineCheck.passed === false ||
      verifyProfileValidation.passed === false ||
      verifyResults.some((verifyResult) => verifyResult.passed === false)
    ) {
      process.exitCode = 1;
    }
    return;
  }

  if (parsedArguments.command === "eval") {
    const attemptCount = Number(getFlagValue(parsedArguments.flags, "attempt-count") ?? "1");
    const caseId = getFlagValue(parsedArguments.flags, "case");
    const explicitPaths = getExplicitPaths(parsedArguments.flags, repoRoot);
    const graderFalseFailureCount = Number(getFlagValue(parsedArguments.flags, "grader-false-failure-count") ?? "0");
    const runner = getFlagValue(parsedArguments.flags, "runner") ?? "unknown";
    const suiteId = getFlagValue(parsedArguments.flags, "suite") ?? "all";
    const artifactsDir = createArtifactsDirectory(repoRoot, artifactsDirFlag);
    const result = await runEvalSuiteAtRepoRoot(
      artifactsDir,
      attemptCount,
      caseId,
      explicitPaths,
      graderFalseFailureCount,
      repoRoot,
      runner,
      suiteId,
    );

    finalizeJsonOutput(summaryFile, result);
    if (result.caseResults.some((caseResult) => caseResult.passed === false)) {
      process.exitCode = 1;
    }
    return;
  }

  if (parsedArguments.command === "scorecard") {
    const baselineInput = getFlagValue(parsedArguments.flags, "baseline");
    const currentInput = getFlagValue(parsedArguments.flags, "current");
    const runner = getFlagValue(parsedArguments.flags, "runner") ?? "codex";
    const suiteId = getFlagValue(parsedArguments.flags, "suite") ?? "foundation";
    const thresholds = getScorecardThresholds(parsedArguments.flags);

    if (baselineInput === undefined || currentInput === undefined) {
      failWithUsage("scorecard requires --baseline <eval-result.json|dir|git-ref> and --current <eval-result.json|dir|git-ref|worktree>");
    }

    const artifactsDir = createArtifactsDirectory(repoRoot, artifactsDirFlag);
    let baselineSubject: Awaited<ReturnType<typeof resolveScorecardSubject>> | undefined;
    let currentSubject: Awaited<ReturnType<typeof resolveScorecardSubject>> | undefined;
    try {
      baselineSubject = await resolveScorecardSubject(artifactsDir, baselineInput, repoRoot, runner, suiteId);
      currentSubject = await resolveScorecardSubject(artifactsDir, currentInput, repoRoot, runner, suiteId);
      const baselineScorecard = makeScorecard(baselineSubject.evalRun);
      const currentScorecard = makeScorecard(currentSubject.evalRun);
      const comparison = compareScorecards(baselineScorecard, currentScorecard);
      const violations = checkScorecardThresholds(comparison, thresholds);

      finalizeJsonOutput(summaryFile, {
        ...comparison,
        baselineSource: baselineSubject.source,
        currentSource: currentSubject.source,
        thresholds,
        violations,
      });

      if (hasScorecardThresholds(thresholds) && violations.length > 0) {
        process.exitCode = 1;
      }
    } finally {
      currentSubject?.cleanup?.();
      baselineSubject?.cleanup?.();
    }
    return;
  }

  if (parsedArguments.command === "soak") {
    const attemptCount = Number(getFlagValue(parsedArguments.flags, "attempt-count") ?? "1");
    const caseId = getFlagValue(parsedArguments.flags, "case");
    const explicitPaths = getExplicitPaths(parsedArguments.flags, repoRoot);
    const graderFalseFailureCount = Number(getFlagValue(parsedArguments.flags, "grader-false-failure-count") ?? "0");
    const iterations = Number(getFlagValue(parsedArguments.flags, "iterations") ?? "3");
    const runner = getFlagValue(parsedArguments.flags, "runner") ?? "codex";
    const suiteId = getFlagValue(parsedArguments.flags, "suite") ?? "all";
    const thresholds = getSoakThresholds(parsedArguments.flags);

    if (Number.isInteger(iterations) === false || iterations <= 0) {
      failWithUsage("soak requires --iterations <positive-integer>.");
    }

    const artifactsDir = createArtifactsDirectory(repoRoot, artifactsDirFlag);
    const evalRuns: EvalRunResult[] = [];
    const runs = [];

    for (let iteration = 1; iteration <= iterations; iteration += 1) {
      const iterationArtifactsDir = path.join(artifactsDir, `iteration-${String(iteration).padStart(2, "0")}`);
      const iterationResult = await runEvalSuiteAtRepoRoot(
        iterationArtifactsDir,
        attemptCount + iteration - 1,
        caseId,
        explicitPaths,
        graderFalseFailureCount,
        repoRoot,
        runner,
        suiteId,
      );

      evalRuns.push(iterationResult);
      runs.push({
        artifactsDir: iterationArtifactsDir,
        failedCaseIds: iterationResult.caseResults.filter((caseResult) => caseResult.passed === false).map((caseResult) => caseResult.caseId),
        iteration,
        passed: iterationResult.caseResults.every((caseResult) => caseResult.passed),
        resultPath: path.join(iterationArtifactsDir, "eval-result.json"),
      });
    }

    const result = makeSoakReport(suiteId, runner, runs, evalRuns);
    const violations = checkSoakThresholds(result, thresholds);

    finalizeJsonOutput(summaryFile, {
      ...result,
      thresholds,
      violations,
    });

    if (
      result.runs.some((run) => run.passed === false) ||
      (hasSoakThresholds(thresholds) && violations.length > 0)
    ) {
      process.exitCode = 1;
    }
    return;
  }

  failWithUsage(`Unsupported command '${parsedArguments.command}'.`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown failure.";
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
