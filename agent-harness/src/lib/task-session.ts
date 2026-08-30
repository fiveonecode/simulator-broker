import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import dayjs from "dayjs";
import picomatch from "picomatch";

import { getRepoRoot, listArtifactFiles, loadVerifyProfiles } from "./config.js";
import { readDetachedRunArtifact } from "./detached-run.js";
import {
  getChangedFilesForRange,
  getCommitMessage,
  getFirstParentCommitShasForPaths,
  getHeadCommit,
  getTaskTreeFingerprint,
  getWorkingTreeStatus,
} from "./git.js";
import { canCoverageSatisfyObligation } from "./proof.js";
import { makeRuleResult } from "./runtime.js";
import type {
  AdvisoryEvaluation,
  AdvisoryEvaluationCriterionId,
  AdvisoryEvaluationRubric,
  ContextPack,
  ResolvedVerificationObligation,
  SessionHandoff,
  SessionMode,
  TaskBlocker,
  TaskCompletionObligationResult,
  TaskCompletionRequiredProfileResult,
  TaskCompletionResult,
  TaskContract,
  TaskPlan,
  DetachedRunStatus,
  VerifyRunResult,
  WorkingTreeStatusEntry,
} from "./types.js";

const CONTEXT_FILE_NAME = "context.json";
const TASK_CONTRACT_FILE_NAME = "task-contract.json";
const TASK_COMPLETION_FILE_NAME = "completion-result.json";
const TASK_PLAN_FILE_NAME = "task-plan.json";
const TASK_PLAN_MARKDOWN_FILE_NAME = "task-plan.md";
const SESSION_HANDOFF_FILE_NAME = "session-handoff.json";
const SESSION_HANDOFF_MARKDOWN_FILE_NAME = "session-handoff.md";
const ADVISORY_EVALUATION_FILE_NAME = "advisory-evaluation.json";
const ADVISORY_EVALUATION_MARKDOWN_FILE_NAME = "advisory-evaluation.md";
const ADVISORY_EVALUATION_RUBRIC_FILE_NAME = "advisory-evaluation-rubric.json";
const VERIFY_RESULTS_DIRECTORY = "verify";
const COMMIT_SECTION_HEADERS = ["Why:", "Changed:", "Verification:", "Affected:", "Refs:", "Session:"];
const STRUCTURED_COMMIT_LOCAL_PATH_MESSAGE =
  "Commit message contains local machine path(s). Use repo-relative paths, GitHub URLs, commit SHAs, or public task artifact labels instead of local paths.";
const STRUCTURED_COMMIT_LOCAL_PATH_PATTERNS = [
  /(^|[\s("'<=:[,;-])\/Users\/[^\s`"'<>),;]*/u,
  /(^|[\s("'<=:[,;-])\/home\/[^\s`"'<>),;]*/u,
  /(^|[\s("'<=:[,;-])\/root\/[^\s`"'<>),;]*/u,
  /(^|[\s("'<=:[,;-])\/tmp\/[^\s`"'<>),;]*/u,
  /(^|[\s("'<=:[,;-])\/var\/(?:tmp|folders)\/[^\s`"'<>),;]*/u,
  /(^|[\s("'<=:[,;-])\/private\/var\/[^\s`"'<>),;]*/u,
  /(^|[\s("'<=:[,;-])\/(?:workspace|workspaces|opt|scratch)\/[^\s`"'<>),;]*/u,
  /(^|[\s("'<=:[,;-])\/nix\/store\/[^\s`"'<>),;]*/u,
  /(^|[\s("'<=:[,;-])~[A-Za-z0-9_-]*[\\/][^\s`"'<>),;]*/u,
  /\bfile:\/\/(?:localhost)?\/[^\s`"'<>),;]*/iu,
  /(^|[\s("'<=:[,;-])[A-Za-z]:[\\/][^\s`"'<>),;]*/u,
  /(^|[\s("'<=:[,;-])\\\\[^\\\s]+\\[^\s`"'<>),;]*/u,
  /(^|[\s("'<=:[,;-])\.\.[\\/][^\s`"'<>),;]*/u,
];
const WORKTREE_ALLOWLIST = ["artifacts/agent-harness/**"];
const DETACHED_RECOVERY_BLOCKING_STATUSES = new Set<DetachedRunStatus>([
  "failed",
  "failed-to-start",
  "process-exited-without-result",
  "running",
  "timeout",
]);
const ADVISORY_CRITERIA: AdvisoryEvaluationCriterionId[] = [
  "product-completeness",
  "ux-clarity",
  "visual-quality",
  "code-quality",
];

function buildContractFingerprint(contextPack: ContextPack, baseHead: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        baseHead,
        commitRequired: contextPack.commitRequired,
        manifests: contextPack.manifests,
        paths: contextPack.paths,
        requiredVerificationProfiles: contextPack.verificationProfiles,
        sessionMode: contextPack.sessionMode ?? "standard",
        verificationObligations: contextPack.verificationObligations,
        version: 4,
      }),
      "utf8",
    )
    .digest("hex");
}

function buildTaskContract(contextPack: ContextPack, repoRoot: string): TaskContract {
  const baseHead = getHeadCommit(repoRoot);
  const contractId = buildContractFingerprint(contextPack, baseHead);

  return {
    baseHead,
    baselineWorkingTree: getWorkingTreeStatus(repoRoot),
    commitRequired: contextPack.commitRequired,
    contractId,
    createdAt: dayjs().toISOString(),
    manifestPathConstraints: contextPack.manifestPathConstraints,
    manifests: [...contextPack.manifests].sort(),
    paths: [...contextPack.paths].sort(),
    requiredVerificationProfiles: [...contextPack.verificationProfiles].sort(),
    sessionMode: contextPack.sessionMode ?? "standard",
    verificationObligations: [...contextPack.verificationObligations].sort((left, right) => left.id.localeCompare(right.id)),
    version: 4,
  };
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function getVerifyResultPath(sessionDir: string, profileId: string): string {
  return path.join(sessionDir, VERIFY_RESULTS_DIRECTORY, profileId, "verify-result.json");
}

function matchArtifactPatterns(artifactFiles: string[], patterns: string[]): { missing: string[]; present: string[] } {
  const missing: string[] = [];
  const present: string[] = [];

  patterns.forEach((pattern) => {
    const matches = artifactFiles.filter((artifactFile) => picomatch(pattern)(artifactFile));
    if (matches.length === 0) {
      missing.push(pattern);
      return;
    }

    present.push(...matches);
  });

  return {
    missing: [...new Set(missing)].sort(),
    present: [...new Set(present)].sort(),
  };
}

function isDetachedProtocolArtifact(artifactPath: string): boolean {
  return artifactPath === "detached-run.json"
    || artifactPath === "detached-run.json.lock"
    || artifactPath === "detached-run.json.launch.lock"
    || artifactPath.startsWith("detached/")
    || artifactPath.endsWith(".detached-result.lock")
    || artifactPath.endsWith(".detached-log.lock")
    || artifactPath.endsWith(".detached-phase.lock");
}

function listRecoverableArtifactFiles(artifactsDir: string): string[] {
  return listArtifactFiles(artifactsDir)
    .filter((artifactPath) => artifactPath !== "verify-result.json")
    .filter((artifactPath) => isDetachedProtocolArtifact(artifactPath) === false);
}

function readDetachedRunRecoveryBlocker(artifactsDir: string): string[] {
  const artifactPath = path.join(artifactsDir, "detached-run.json");
  if (existsSync(artifactPath) === false) {
    return [];
  }

  try {
    const artifact = readDetachedRunArtifact(artifactPath);
    if (DETACHED_RECOVERY_BLOCKING_STATUSES.has(artifact.status) === false) {
      return [];
    }

    return [
      artifact.status === "running"
        ? `Detached run ${artifactPath} is still running. Resume it with: ${artifact.resumeCommand}`
        : `Detached run ${artifactPath} ended with status ${artifact.status}${artifact.failureReason ? `: ${artifact.failureReason}` : "."}`,
    ];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [`Could not recover verification while detached run artifact ${artifactPath} is unreadable: ${message}`];
  }
}

function buildDetachedRunStatusBlockedVerifyResult(
  sessionDir: string,
  profileId: string,
  existingResult: VerifyRunResult,
): { result: VerifyRunResult; resultPath: string } | undefined {
  const artifactsDir = getSessionVerifyArtifactsDir(sessionDir, profileId);
  const detachedRunBlockers = readDetachedRunRecoveryBlocker(artifactsDir);
  if (detachedRunBlockers.length === 0) {
    return undefined;
  }

  return {
    result: {
      ...existingResult,
      passed: false,
      summary: [
        ...existingResult.summary.filter((entry) => entry.name !== "detached-run-status"),
        makeRuleResult(detachedRunBlockers, "detached-run-status", false),
      ],
    },
    resultPath: getVerifyResultPath(sessionDir, profileId),
  };
}

function collectArtifactResultFailures(artifactsDir: string, artifactFiles: string[]): {
  details: string[];
  inspectedCount: number;
  passed: boolean;
} {
  const resultArtifactPaths = artifactFiles
    .filter((artifactPath) => artifactPath.endsWith("result.json"))
    .filter((artifactPath) => artifactPath !== "verify-result.json")
    .sort();
  const details: string[] = [];
  let inspectedCount = 0;

  resultArtifactPaths.forEach((artifactPath) => {
    const absolutePath = path.join(artifactsDir, artifactPath);
    const payload = readJsonFile<unknown>(absolutePath);
    if (typeof payload !== "object" || payload === null || "passed" in payload === false) {
      return;
    }

    const passed = (payload as { passed?: unknown }).passed;
    if (typeof passed !== "boolean") {
      return;
    }

    inspectedCount += 1;
    if (passed === false) {
      details.push(`Artifact result ${artifactPath} reports passed=false.`);
    }
  });

  if (inspectedCount === 0) {
    details.push("Could not reconstruct verify result because no nested result.json files reported a boolean passed state.");
  }

  return {
    details,
    inspectedCount,
    passed: inspectedCount > 0 && details.length === 0,
  };
}

function buildRecoveredVerifyResult(sessionDir: string, profileId: string): { result: VerifyRunResult; resultPath: string } | undefined {
  const repoRoot = getRepoRoot();
  const profile = loadVerifyProfiles(repoRoot).find((candidate) => candidate.id === profileId);
  if (profile === undefined) {
    return undefined;
  }

  const artifactsDir = getSessionVerifyArtifactsDir(sessionDir, profileId);
  if (existsSync(artifactsDir) === false) {
    return undefined;
  }

  const artifactFiles = listRecoverableArtifactFiles(artifactsDir);
  const artifactCheck = matchArtifactPatterns(artifactFiles, profile.required_artifacts);
  const detachedRunBlockers = readDetachedRunRecoveryBlocker(artifactsDir);
  const nestedResults = detachedRunBlockers.length > 0
    ? undefined
    : collectArtifactResultFailures(artifactsDir, artifactFiles);
  const taskContract = existsSync(getTaskContractPath(sessionDir))
    ? readTaskContract(sessionDir)
    : undefined;
  const resultPath = getVerifyResultPath(sessionDir, profileId);
  const summary = [
    makeRuleResult(
      artifactCheck.missing.map((artifactPattern) => `Missing artifact pattern ${artifactPattern}`),
      "required-artifacts",
      artifactCheck.missing.length === 0,
    ),
    makeRuleResult(
      detachedRunBlockers.length > 0
        ? detachedRunBlockers
        : nestedResults && nestedResults.details.length > 0
          ? nestedResults.details
          : [`Recovered missing verify-result.json from ${nestedResults?.inspectedCount ?? 0} nested artifact result file(s).`],
      detachedRunBlockers.length > 0 ? "detached-run-status" : "reconstructed-from-artifacts",
      nestedResults?.passed ?? false,
    ),
  ];
  const result: VerifyRunResult = {
    advisory: profile.advisory,
    artifacts: artifactFiles,
    artifactsDir,
    commands: [],
    coversBoundaries: profile.covers_boundaries,
    coversScenarios: profile.covers_scenarios,
    generatedAt: dayjs().toISOString(),
    passed: profile.advisory || summary.every((entry) => entry.passed),
    paths: taskContract?.paths ?? [],
    profileId,
    proofKind: profile.proof_kind,
    requiredArtifactsMissing: artifactCheck.missing,
    requiredArtifactsPresent: artifactCheck.present,
    summary,
    taskContractId: taskContract?.contractId,
    warnings: [],
  };

  writeFileSync(resultPath, JSON.stringify(result, null, 2));
  return {
    result,
    resultPath,
  };
}

function hasFreshArtifactsSince(artifactsDir: string, baselinePath: string): boolean {
  if (existsSync(baselinePath) === false) {
    return true;
  }

  const baselineMtimeMs = statSync(baselinePath).mtimeMs;
  return listArtifactFiles(artifactsDir)
    .filter((artifactPath) => artifactPath !== "verify-result.json")
    .filter((artifactPath) => isDetachedProtocolArtifact(artifactPath) === false)
    .some((artifactPath) => statSync(path.join(artifactsDir, artifactPath)).mtimeMs > baselineMtimeMs);
}

function getLegacyBaselineEntryKey(entry: WorkingTreeStatusEntry): string {
  return `${entry.status}::${entry.originalPath ?? ""}::${entry.path}`;
}

function getFingerprintBaselineEntryKey(entry: WorkingTreeStatusEntry): string | undefined {
  return entry.fingerprint
    ? `${entry.status}::${entry.originalPath ?? ""}::${entry.path}::${entry.fingerprint}`
    : undefined;
}

function entryTouchesKnownBaseline(
  entry: WorkingTreeStatusEntry,
  baselineEntries: Set<string>,
  legacyBaselineEntries: Set<string>,
): boolean {
  const fingerprintKey = getFingerprintBaselineEntryKey(entry);
  if (fingerprintKey) {
    return baselineEntries.has(fingerprintKey);
  }

  return legacyBaselineEntries.has(getLegacyBaselineEntryKey(entry));
}

function isWorktreeEntryAllowed(entry: WorkingTreeStatusEntry): boolean {
  return WORKTREE_ALLOWLIST.some((pattern) =>
    picomatch(pattern, { dot: true })(entry.path)
      || (entry.originalPath ? picomatch(pattern, { dot: true })(entry.originalPath) : false),
  );
}

function getCommitMessageLocalPathIssues(message: string): string[] {
  return STRUCTURED_COMMIT_LOCAL_PATH_PATTERNS.some((pattern) => pattern.test(message))
    ? [STRUCTURED_COMMIT_LOCAL_PATH_MESSAGE]
    : [];
}

function getStructuredCommitSectionIssues(message: string): string[] {
  const sections = getStructuredCommitSections(message);

  return COMMIT_SECTION_HEADERS.flatMap((header) => {
    const sectionBody = sections.get(header);
    if (sectionBody === undefined) {
      return [`Missing commit section ${header}`];
    }

    return sectionBody.length === 0 ? [`Commit section ${header} is empty.`] : [];
  });
}

function getStructuredCommitMessageIssues(message: string): string[] {
  return [
    ...getStructuredCommitSectionIssues(message),
    ...getCommitMessageLocalPathIssues(message),
  ];
}

function getStructuredCommitSections(message: string): Map<string, string> {
  const lines = message.split(/\r?\n/);
  const sections = new Map<string, string>();

  for (const [index, header] of COMMIT_SECTION_HEADERS.entries()) {
    const startIndex = lines.findIndex((line) => line.startsWith(header));
    if (startIndex === -1) {
      continue;
    }

    const nextHeaderIndex = COMMIT_SECTION_HEADERS
      .slice(index + 1)
      .map((candidateHeader) => lines.findIndex((line, lineIndex) => lineIndex > startIndex && line.startsWith(candidateHeader)))
      .find((candidateIndex) => candidateIndex !== -1);
    sections.set(
      header,
      lines
        .slice(startIndex, nextHeaderIndex === undefined ? lines.length : nextHeaderIndex)
        .join("\n")
        .replace(header, "")
        .trim(),
    );
  }

  return sections;
}

function normalizeSessionIdentifier(value: string): string {
  return value.trim().replaceAll("\\", "/");
}

function getSessionIdentifiers(sessionDir: string, repoRoot: string): string[] {
  const absoluteSessionDir = normalizeSessionIdentifier(path.resolve(sessionDir));
  const relativeSessionDir = normalizeSessionIdentifier(path.relative(repoRoot, absoluteSessionDir));
  const taskSessionMatch = /\/agent-harness\/simulator-broker(?:-app)?\/([^/]+)(?:\/.*)?$/u.exec(absoluteSessionDir);
  const publicSessionIdentifiers = [
    taskSessionMatch ? `task-sessions/${taskSessionMatch[1]}` : undefined,
    taskSessionMatch?.[1],
  ];

  return [...new Set(
    [absoluteSessionDir, relativeSessionDir, ...publicSessionIdentifiers]
      .filter((identifier): identifier is string => typeof identifier === "string" && identifier.length > 0),
  )];
}

function isSessionIdentifierLeadingBoundary(character: string | undefined): boolean {
  return character === undefined || /[\s"'`()\[\]{}<>,;:=/]/u.test(character);
}

function isSessionIdentifierTrailingBoundary(character: string | undefined): boolean {
  return character === undefined || /[\s"'`()\[\]{}<>,;:=]/u.test(character);
}

function lineReferencesSessionIdentifier(line: string, identifier: string): boolean {
  let startIndex = line.indexOf(identifier);
  while (startIndex !== -1) {
    const endIndex = startIndex + identifier.length;
    if (isSessionIdentifierLeadingBoundary(line[startIndex - 1]) && isSessionIdentifierTrailingBoundary(line[endIndex])) {
      return true;
    }
    startIndex = line.indexOf(identifier, startIndex + 1);
  }
  return false;
}

function commitBelongsToSession(message: string, sessionIdentifiers: string[]): boolean {
  const sessionSection = getStructuredCommitSections(message).get("Session:");
  if (sessionSection === undefined) {
    return false;
  }

  const sessionLines = sessionSection
    .split(/\r?\n/)
    .map((line) => normalizeSessionIdentifier(line.replace(/^[\s*-]+/, "")))
    .filter(Boolean);

  return sessionLines.some((line) =>
    sessionIdentifiers.some((identifier) =>
      line === identifier || lineReferencesSessionIdentifier(line, identifier)));
}

function pathMatchesAnyPattern(repoRelativePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => picomatch(pattern, { dot: true })(repoRelativePath));
}

function collectManifestPathConstraintFailures(contract: TaskContract, repoRoot: string): string[] {
  const constraints = contract.manifestPathConstraints ?? [];
  if (constraints.length === 0) {
    return [];
  }

  const changedFiles = getChangedFilesForRange(repoRoot, `${contract.baseHead}..HEAD`);
  const allowedPatterns = [...new Set(constraints.flatMap((constraint) => constraint.allowedPaths))].sort();

  return changedFiles.flatMap((changedFile) => {
    const allowed = pathMatchesAnyPattern(changedFile, allowedPatterns);
    const details: string[] = [];
    if (!allowed) {
      details.push(`${changedFile}: not allowed by selected manifests ${constraints.map((constraint) => constraint.manifestId).join(", ")}`);
    }
    details.push(...constraints
      .filter((constraint) => pathMatchesAnyPattern(changedFile, constraint.forbiddenPaths))
      .map((constraint) => `${changedFile}: forbidden by selected manifest ${constraint.manifestId}`));
    return details;
  });
}

function resolvePassingVerifyResult(
  verifyResults: Array<{ result: VerifyRunResult; resultPath: string }>,
  profileId: string,
  contractId: string,
  taskTreeFingerprint: string,
): { result: VerifyRunResult; resultPath: string } | undefined {
  return verifyResults.find((candidate) =>
    candidate.result.profileId === profileId
      && candidate.result.taskContractId === contractId
      && candidate.result.taskTreeFingerprint === taskTreeFingerprint
      && candidate.result.passed,
  );
}

function collectRequiredProfileResult(
  contractId: string,
  profileId: string,
  taskTreeFingerprint: string,
  verifyResults: Array<{ result: VerifyRunResult; resultPath: string }>,
): TaskCompletionRequiredProfileResult {
  const passingResult = resolvePassingVerifyResult(verifyResults, profileId, contractId, taskTreeFingerprint);
  if (passingResult) {
    return {
      details: [],
      profileId,
      resultPath: passingResult.resultPath,
      satisfied: true,
    };
  }

  const profileResults = verifyResults.filter((candidate) => candidate.result.profileId === profileId);
  if (profileResults.length === 0) {
    return {
      details: [`Missing verify result for required profile ${profileId}.`],
      profileId,
      satisfied: false,
    };
  }

  const contractMismatches = profileResults.filter((candidate) => candidate.result.taskContractId !== contractId);
  if (contractMismatches.length === profileResults.length) {
    return {
      details: [`Profile ${profileId} was run outside this task session or against a stale task contract.`],
      profileId,
      satisfied: false,
    };
  }

  const missingFingerprints = profileResults.filter((candidate) =>
    candidate.result.taskContractId === contractId
      && candidate.result.taskTreeFingerprint === undefined
      && candidate.result.passed,
  );
  if (missingFingerprints.length > 0) {
    return {
      details: [`Profile ${profileId} passed without recording a task tree fingerprint. Rerun verification after the latest task changes.`],
      profileId,
      resultPath: missingFingerprints[0]?.resultPath,
      satisfied: false,
    };
  }

  const fingerprintMismatches = profileResults.filter((candidate) =>
    candidate.result.taskContractId === contractId
      && candidate.result.passed
      && candidate.result.taskTreeFingerprint !== undefined
      && candidate.result.taskTreeFingerprint !== taskTreeFingerprint,
  );
  if (fingerprintMismatches.length > 0) {
    return {
      details: [`Profile ${profileId} passed against a stale task tree. Rerun verification after the latest task changes.`],
      profileId,
      resultPath: fingerprintMismatches[0]?.resultPath,
      satisfied: false,
    };
  }

  return {
    details: [`Required profile ${profileId} did not pass in this task session.`],
    profileId,
    resultPath: profileResults[0]?.resultPath,
    satisfied: false,
  };
}

function collectObligationResult(
  contractId: string,
  obligation: ResolvedVerificationObligation,
  taskTreeFingerprint: string,
  verifyResults: Array<{ result: VerifyRunResult; resultPath: string }>,
): TaskCompletionObligationResult {
  const satisfyingResults = verifyResults.filter((candidate) =>
    obligation.acceptableProfiles.includes(candidate.result.profileId)
      && candidate.result.taskContractId === contractId
      && candidate.result.taskTreeFingerprint === taskTreeFingerprint
      && candidate.result.passed
      && canCoverageSatisfyObligation(
        {
          boundary: obligation.boundary,
          requiredProofKind: obligation.requiredProofKind,
          scenario: obligation.scenario,
        },
        {
          advisory: candidate.result.advisory,
          coversBoundaries: candidate.result.coversBoundaries,
          coversScenarios: candidate.result.coversScenarios,
          proofKind: candidate.result.proofKind,
        },
      ),
  );

  if (satisfyingResults.length > 0) {
    return {
      acceptableProfiles: [...obligation.acceptableProfiles],
      boundary: obligation.boundary,
      details: [],
      matchedPaths: [...obligation.matchedPaths],
      obligationId: obligation.id,
      requiredProofKind: obligation.requiredProofKind,
      resultPaths: satisfyingResults.map((candidate) => candidate.resultPath).sort(),
      satisfied: true,
      scenario: obligation.scenario,
    };
  }

  const acceptableProfileResults = verifyResults.filter((candidate) =>
    obligation.acceptableProfiles.includes(candidate.result.profileId),
  );
  const detailMessages = [`Missing passing verify result that satisfies obligation ${obligation.id}.`];

  if (acceptableProfileResults.some((candidate) => candidate.result.taskContractId !== contractId)) {
    detailMessages.push("Some acceptable profiles were run against a stale or different task contract.");
  }

  if (acceptableProfileResults.some((candidate) =>
    candidate.result.taskContractId === contractId
      && candidate.result.taskTreeFingerprint === undefined
      && candidate.result.passed,
  )) {
    detailMessages.push("Some acceptable profiles passed without recording a task tree fingerprint.");
  }

  if (acceptableProfileResults.some((candidate) =>
    candidate.result.taskContractId === contractId
      && candidate.result.passed
      && candidate.result.taskTreeFingerprint !== undefined
      && candidate.result.taskTreeFingerprint !== taskTreeFingerprint,
  )) {
    detailMessages.push("Some acceptable profiles passed against a stale task tree.");
  }

  if (acceptableProfileResults.some((candidate) => candidate.result.advisory)) {
    detailMessages.push("Advisory profiles do not satisfy blocking verification obligations.");
  }

  if (acceptableProfileResults.some((candidate) => candidate.result.passed === false)) {
    detailMessages.push("Acceptable profiles ran but did not pass.");
  }

  return {
    acceptableProfiles: [...obligation.acceptableProfiles],
    boundary: obligation.boundary,
    details: detailMessages,
    matchedPaths: [...obligation.matchedPaths],
    obligationId: obligation.id,
    requiredProofKind: obligation.requiredProofKind,
    resultPaths: acceptableProfileResults.map((candidate) => candidate.resultPath).sort(),
    satisfied: false,
    scenario: obligation.scenario,
  };
}

function listToMarkdown(items: string[], fallback = "- none"): string[] {
  return items.length === 0 ? [fallback] : items.map((item) => `- ${item}`);
}

function buildDefaultTaskPlan(contextPack: ContextPack): TaskPlan {
  const timestamp = dayjs().toISOString();
  return {
    assumptions: [],
    contextSummary: {
      manifests: [...contextPack.manifests].sort(),
      paths: [...contextPack.paths].sort(),
      primarySpecs: [...contextPack.primarySpecs].sort(),
      verificationObligations: contextPack.verificationObligations.map((obligation) => obligation.id).sort(),
      verificationProfiles: [...contextPack.verificationProfiles].sort(),
    },
    createdAt: timestamp,
    deliverables: [],
    implementationSlices: [],
    objective: "",
    openQuestions: [],
    outOfScope: [],
    risks: [],
    sessionMode: contextPack.sessionMode ?? "standard",
    updatedAt: timestamp,
    verificationPlan: [],
    version: 1,
  };
}

function buildDefaultSessionHandoff(): SessionHandoff {
  const timestamp = dayjs().toISOString();
  return {
    artifacts: [],
    completedWork: [],
    createdAt: timestamp,
    currentFocus: "",
    decisions: [],
    nextSteps: [],
    openRisks: [],
    resumeCommands: [],
    status: "not-started",
    summary: "",
    updatedAt: timestamp,
    version: 1,
  };
}

function buildDefaultAdvisoryEvaluation(): AdvisoryEvaluation {
  return {
    findings: [],
    gaps: [],
    notApplicableCriteria: [],
    recommendedAction: "continue",
    scores: {},
    status: "not-run",
    strengths: [],
    summary: "",
    updatedAt: dayjs().toISOString(),
    version: 1,
  };
}

function buildAdvisoryEvaluationRubric(): AdvisoryEvaluationRubric {
  const timestamp = dayjs().toISOString();
  return {
    createdAt: timestamp,
    criteria: [
      {
        id: "product-completeness",
        prompt: "Does the delivered work implement the core interaction depth promised by the task/spec instead of stopping at chrome or stubs?",
        summary: "Product completeness and absence of stubbed or fake behavior.",
      },
      {
        id: "ux-clarity",
        prompt: "Can a user or reviewer understand what to do next and complete the core flow without guessing?",
        summary: "Usability, flow clarity, and interaction coherence.",
      },
      {
        id: "visual-quality",
        prompt: "Does the visible UI feel intentional and polished rather than default, sloppy, or inconsistent?",
        summary: "Visual polish and design coherence when the task has a user-facing UI.",
      },
      {
        id: "code-quality",
        prompt: "Does the implementation avoid obvious fragility, hidden stub logic, and low-signal complexity?",
        summary: "Implementation quality, maintainability, and obvious correctness concerns.",
      },
    ],
    scale: {
      max: 5,
      min: 1,
    },
    updatedAt: timestamp,
    version: 1,
  };
}

function renderTaskPlanMarkdown(plan: TaskPlan): string {
  const lines = [
    "# Task Plan",
    "",
    `Session mode: ${plan.sessionMode}`,
    `Updated: ${plan.updatedAt}`,
    "",
    "## Objective",
    plan.objective || "_Unspecified_",
    "",
    "## Deliverables",
    ...listToMarkdown(plan.deliverables),
    "",
    "## Implementation Slices",
    ...listToMarkdown(plan.implementationSlices),
    "",
    "## Verification Plan",
    ...listToMarkdown(plan.verificationPlan),
    "",
    "## Risks",
    "Document interacting conditions, degraded or latent state, and change-induced coupling; if none is known, state that with the evidence basis.",
    ...listToMarkdown(plan.risks),
    "",
    "## Assumptions",
    ...listToMarkdown(plan.assumptions),
    "",
    "## Out Of Scope",
    ...listToMarkdown(plan.outOfScope),
    "",
    "## Open Questions",
    ...listToMarkdown(plan.openQuestions),
    "",
  ];

  return `${lines.join("\n")}\n`;
}

function renderSessionHandoffMarkdown(handoff: SessionHandoff): string {
  const lines = [
    "# Session Handoff",
    "",
    `Status: ${handoff.status}`,
    `Updated: ${handoff.updatedAt}`,
    "",
    "## Summary",
    handoff.summary || "_Unspecified_",
    "",
    "## Current Focus",
    handoff.currentFocus || "_Unspecified_",
    "",
    "## Completed Work",
    ...listToMarkdown(handoff.completedWork),
    "",
    "## Decisions",
    ...listToMarkdown(handoff.decisions),
    "",
    "## Artifacts",
    ...listToMarkdown(handoff.artifacts),
    "",
    "## Next Steps",
    ...listToMarkdown(handoff.nextSteps),
    "",
    "## Open Risks",
    "Document residual risk and recovery evidence; if none is known, state that with the evidence basis.",
    ...listToMarkdown(handoff.openRisks),
    "",
    "## Resume Commands",
    ...listToMarkdown(handoff.resumeCommands),
    "",
  ];

  return `${lines.join("\n")}\n`;
}

function renderAdvisoryEvaluationMarkdown(evaluation: AdvisoryEvaluation): string {
  const scoreLines = ADVISORY_CRITERIA.map((criterionId) => {
    const score = evaluation.scores[criterionId];
    const notApplicable = evaluation.notApplicableCriteria.includes(criterionId);
    return `- ${criterionId}: ${notApplicable ? "n/a" : (score ?? "unset")}`;
  });

  const lines = [
    "# Advisory Evaluation",
    "",
    `Status: ${evaluation.status}`,
    `Recommended action: ${evaluation.recommendedAction}`,
    `Updated: ${evaluation.updatedAt}`,
    "",
    "## Summary",
    evaluation.summary || "_Unspecified_",
    "",
    "## Scores",
    ...scoreLines,
    "",
    "## Findings",
    ...listToMarkdown(evaluation.findings),
    "",
    "## Gaps",
    ...listToMarkdown(evaluation.gaps),
    "",
    "## Strengths",
    ...listToMarkdown(evaluation.strengths),
    "",
  ];

  return `${lines.join("\n")}\n`;
}

export function resolveSessionDir(sessionDir: string, repoRoot: string): string {
  return path.resolve(repoRoot, sessionDir);
}

export function getTaskContractPath(sessionDir: string): string {
  return path.join(sessionDir, TASK_CONTRACT_FILE_NAME);
}

export function getTaskCompletionPath(sessionDir: string): string {
  return path.join(sessionDir, TASK_COMPLETION_FILE_NAME);
}

export function getTaskPlanPath(sessionDir: string): string {
  return path.join(sessionDir, TASK_PLAN_FILE_NAME);
}

export function getTaskPlanMarkdownPath(sessionDir: string): string {
  return path.join(sessionDir, TASK_PLAN_MARKDOWN_FILE_NAME);
}

export function getSessionHandoffPath(sessionDir: string): string {
  return path.join(sessionDir, SESSION_HANDOFF_FILE_NAME);
}

export function getSessionHandoffMarkdownPath(sessionDir: string): string {
  return path.join(sessionDir, SESSION_HANDOFF_MARKDOWN_FILE_NAME);
}

export function getAdvisoryEvaluationPath(sessionDir: string): string {
  return path.join(sessionDir, ADVISORY_EVALUATION_FILE_NAME);
}

export function getAdvisoryEvaluationMarkdownPath(sessionDir: string): string {
  return path.join(sessionDir, ADVISORY_EVALUATION_MARKDOWN_FILE_NAME);
}

export function getAdvisoryEvaluationRubricPath(sessionDir: string): string {
  return path.join(sessionDir, ADVISORY_EVALUATION_RUBRIC_FILE_NAME);
}

export function readTaskContextPack(sessionDir: string): ContextPack {
  const contextPath = path.join(sessionDir, CONTEXT_FILE_NAME);
  if (existsSync(contextPath) === false) {
    throw new Error(`Missing task context at ${contextPath}. Run agent:context with --session-dir first.`);
  }

  return readJsonFile<ContextPack>(contextPath);
}

export function writeTaskPlan(sessionDir: string, plan: TaskPlan): TaskPlan {
  const nextPlan = {
    ...plan,
    updatedAt: dayjs().toISOString(),
  };
  writeFileSync(getTaskPlanPath(sessionDir), JSON.stringify(nextPlan, null, 2));
  writeFileSync(getTaskPlanMarkdownPath(sessionDir), renderTaskPlanMarkdown(nextPlan));
  return nextPlan;
}

export function readTaskPlan(sessionDir: string): TaskPlan {
  return readJsonFile<TaskPlan>(getTaskPlanPath(sessionDir));
}

export function writeSessionHandoff(sessionDir: string, handoff: SessionHandoff): SessionHandoff {
  const nextHandoff = {
    ...handoff,
    updatedAt: dayjs().toISOString(),
  };
  writeFileSync(getSessionHandoffPath(sessionDir), JSON.stringify(nextHandoff, null, 2));
  writeFileSync(getSessionHandoffMarkdownPath(sessionDir), renderSessionHandoffMarkdown(nextHandoff));
  return nextHandoff;
}

export function readSessionHandoff(sessionDir: string): SessionHandoff {
  return readJsonFile<SessionHandoff>(getSessionHandoffPath(sessionDir));
}

export function writeAdvisoryEvaluation(sessionDir: string, evaluation: AdvisoryEvaluation): AdvisoryEvaluation {
  const nextEvaluation = {
    ...evaluation,
    updatedAt: dayjs().toISOString(),
  };
  writeFileSync(getAdvisoryEvaluationPath(sessionDir), JSON.stringify(nextEvaluation, null, 2));
  writeFileSync(getAdvisoryEvaluationMarkdownPath(sessionDir), renderAdvisoryEvaluationMarkdown(nextEvaluation));
  return nextEvaluation;
}

export function readAdvisoryEvaluation(sessionDir: string): AdvisoryEvaluation {
  return readJsonFile<AdvisoryEvaluation>(getAdvisoryEvaluationPath(sessionDir));
}

function ensureTaskSessionArtifacts(sessionDir: string, contextPack: ContextPack): void {
  if (existsSync(getTaskPlanPath(sessionDir)) === false) {
    writeTaskPlan(sessionDir, buildDefaultTaskPlan(contextPack));
  } else if (existsSync(getTaskPlanMarkdownPath(sessionDir)) === false) {
    writeFileSync(getTaskPlanMarkdownPath(sessionDir), renderTaskPlanMarkdown(readTaskPlan(sessionDir)));
  }

  if (existsSync(getSessionHandoffPath(sessionDir)) === false) {
    writeSessionHandoff(sessionDir, buildDefaultSessionHandoff());
  } else if (existsSync(getSessionHandoffMarkdownPath(sessionDir)) === false) {
    writeFileSync(getSessionHandoffMarkdownPath(sessionDir), renderSessionHandoffMarkdown(readSessionHandoff(sessionDir)));
  }

  if (existsSync(getAdvisoryEvaluationPath(sessionDir)) === false) {
    writeAdvisoryEvaluation(sessionDir, buildDefaultAdvisoryEvaluation());
  } else if (existsSync(getAdvisoryEvaluationMarkdownPath(sessionDir)) === false) {
    writeFileSync(
      getAdvisoryEvaluationMarkdownPath(sessionDir),
      renderAdvisoryEvaluationMarkdown(readAdvisoryEvaluation(sessionDir)),
    );
  }

  if (existsSync(getAdvisoryEvaluationRubricPath(sessionDir)) === false) {
    writeFileSync(
      getAdvisoryEvaluationRubricPath(sessionDir),
      JSON.stringify(buildAdvisoryEvaluationRubric(), null, 2),
    );
  }
}

export function writeTaskSession(sessionDir: string, contextPack: ContextPack, repoRoot: string): TaskContract {
  mkdirSync(sessionDir, { recursive: true });
  const contract = buildTaskContract(contextPack, repoRoot);
  writeFileSync(path.join(sessionDir, CONTEXT_FILE_NAME), JSON.stringify(contextPack, null, 2));
  writeFileSync(path.join(sessionDir, TASK_CONTRACT_FILE_NAME), JSON.stringify(contract, null, 2));
  ensureTaskSessionArtifacts(sessionDir, contextPack);
  return contract;
}

export function readTaskContract(sessionDir: string): TaskContract {
  const contractPath = path.join(sessionDir, TASK_CONTRACT_FILE_NAME);
  if (existsSync(contractPath) === false) {
    throw new Error(`Missing task contract at ${contractPath}. Run agent:context with --session-dir first.`);
  }

  return readJsonFile<TaskContract>(contractPath);
}

export function taskContractMatchesPaths(contract: TaskContract, paths: string[]): boolean {
  return JSON.stringify(contract.paths) === JSON.stringify([...paths].sort());
}

export function getSessionVerifyArtifactsDir(sessionDir: string, profileId: string): string {
  return path.join(sessionDir, VERIFY_RESULTS_DIRECTORY, profileId);
}

export function loadSessionVerifyResults(sessionDir: string): Array<{ result: VerifyRunResult; resultPath: string }> {
  const verifyRoot = path.join(sessionDir, VERIFY_RESULTS_DIRECTORY);
  if (existsSync(verifyRoot) === false) {
    return [];
  }
  const taskContract = existsSync(getTaskContractPath(sessionDir))
    ? readTaskContract(sessionDir)
    : undefined;

  return readdirSync(verifyRoot)
    .sort()
    .flatMap((entry) => {
      const candidatePath = path.join(verifyRoot, entry);
      if (statSync(candidatePath).isDirectory() === false) {
        return [];
      }

      const resultPath = getVerifyResultPath(sessionDir, entry);
      if (existsSync(resultPath) === false) {
        const recovered = buildRecoveredVerifyResult(sessionDir, entry);
        return recovered ? [recovered] : [];
      }

      const existingResult = readJsonFile<VerifyRunResult>(resultPath);
      const detachedStatusBlockedResult = buildDetachedRunStatusBlockedVerifyResult(sessionDir, entry, existingResult);
      if (detachedStatusBlockedResult !== undefined) {
        return [detachedStatusBlockedResult];
      }

      if (
        taskContract
        && existingResult.taskContractId !== taskContract.contractId
        && hasFreshArtifactsSince(candidatePath, resultPath)
      ) {
        const recovered = buildRecoveredVerifyResult(sessionDir, entry);
        if (recovered) {
          return [recovered];
        }
      }

      return [{
        result: existingResult,
        resultPath,
      }];
    });
}

function makeMissingArtifactResult(
  artifactId: "task-plan" | "session-handoff" | "advisory-evaluation",
  artifactPath: string,
  required: boolean,
): TaskCompletionResult["sessionArtifactResults"][number] {
  return {
    artifactId,
    details: required ? [`Missing required session artifact at ${artifactPath}.`] : [],
    path: artifactPath,
    required,
    satisfied: required === false,
  };
}

function validateTaskPlanArtifact(
  sessionDir: string,
  required: boolean,
): TaskCompletionResult["sessionArtifactResults"][number] {
  const artifactPath = getTaskPlanPath(sessionDir);
  if (existsSync(artifactPath) === false) {
    return makeMissingArtifactResult("task-plan", artifactPath, required);
  }

  const plan = readTaskPlan(sessionDir);
  const details = [
    ...(plan.version === 1 ? [] : ["Task plan version must equal 1."]),
    ...(plan.objective.trim().length > 0 ? [] : ["Task plan objective must be populated."]),
    ...(plan.deliverables.length > 0 ? [] : ["Task plan must list at least one deliverable."]),
    ...(plan.verificationPlan.length > 0 ? [] : ["Task plan must include at least one verification step."]),
    ...(plan.risks.length > 0 ? [] : ["Task plan must include at least one risk entry or an explicit none-with-basis entry."]),
  ];

  return {
    artifactId: "task-plan",
    details,
    path: artifactPath,
    required,
    satisfied: details.length === 0,
  };
}

function validateSessionHandoffArtifact(
  sessionDir: string,
  required: boolean,
): TaskCompletionResult["sessionArtifactResults"][number] {
  const artifactPath = getSessionHandoffPath(sessionDir);
  if (existsSync(artifactPath) === false) {
    return makeMissingArtifactResult("session-handoff", artifactPath, required);
  }

  const handoff = readSessionHandoff(sessionDir);
  const details = [
    ...(handoff.version === 1 ? [] : ["Session handoff version must equal 1."]),
    ...(handoff.summary.trim().length > 0 ? [] : ["Session handoff summary must be populated."]),
    ...(handoff.status !== "not-started" ? [] : ["Session handoff status must move past not-started."]),
    ...(handoff.nextSteps.length > 0 ? [] : ["Session handoff must include at least one next step."]),
    ...(handoff.openRisks.length > 0 ? [] : ["Session handoff must include at least one residual-risk entry or an explicit none-with-basis entry."]),
  ];

  return {
    artifactId: "session-handoff",
    details,
    path: artifactPath,
    required,
    satisfied: details.length === 0,
  };
}

function validateAdvisoryEvaluationArtifact(
  sessionDir: string,
  required: boolean,
): TaskCompletionResult["sessionArtifactResults"][number] {
  const artifactPath = getAdvisoryEvaluationPath(sessionDir);
  if (existsSync(artifactPath) === false) {
    return makeMissingArtifactResult("advisory-evaluation", artifactPath, required);
  }

  const evaluation = readAdvisoryEvaluation(sessionDir);
  const details = [
    ...(evaluation.version === 1 ? [] : ["Advisory evaluation version must equal 1."]),
    ...(evaluation.status !== "not-run" ? [] : ["Advisory evaluation status must be pass or needs-follow-up."]),
    ...(evaluation.summary.trim().length > 0 ? [] : ["Advisory evaluation summary must be populated."]),
  ];

  ADVISORY_CRITERIA.forEach((criterionId) => {
    const score = evaluation.scores[criterionId];
    const notApplicable = evaluation.notApplicableCriteria.includes(criterionId);
    if (notApplicable) {
      return;
    }

    if (typeof score !== "number" || Number.isInteger(score) === false || score < 1 || score > 5) {
      details.push(`Advisory evaluation criterion ${criterionId} must have an integer score between 1 and 5 or be marked not applicable.`);
    }
  });

  return {
    artifactId: "advisory-evaluation",
    details,
    path: artifactPath,
    required,
    satisfied: details.length === 0,
  };
}

function shouldRequireSessionArtifacts(sessionMode: SessionMode): boolean {
  return sessionMode === "long-running";
}

export function evaluateTaskCompletion(
  sessionDir: string,
  repoRoot: string,
  contract: TaskContract,
  verifyResults: Array<{ result: VerifyRunResult; resultPath: string }>,
  blockers: TaskBlocker[] = [],
): TaskCompletionResult {
  const taskRange = `${contract.baseHead}..HEAD`;
  const committedFiles = getChangedFilesForRange(repoRoot, taskRange);
  const coveredCommittedFiles = new Set(getChangedFilesForRange(repoRoot, taskRange, contract.paths));
  const uncoveredCommittedFiles = committedFiles.filter((changedFile) => coveredCommittedFiles.has(changedFile) === false);
  const taskPathCoverageCheck = makeRuleResult(
    uncoveredCommittedFiles.map((changedFile) => `${changedFile}: committed path is not covered by this task contract.`),
    "task-path-coverage",
    uncoveredCommittedFiles.length === 0,
  );
  const currentTaskTreeFingerprint = getTaskTreeFingerprint(repoRoot, contract.paths);
  const requiredProfileResults = contract.requiredVerificationProfiles.map((profileId) =>
    collectRequiredProfileResult(contract.contractId, profileId, currentTaskTreeFingerprint, verifyResults),
  );
  const obligationResults = contract.verificationObligations.map((obligation) =>
    collectObligationResult(contract.contractId, obligation, currentTaskTreeFingerprint, verifyResults),
  );

  const requiredProfileFailures = requiredProfileResults
    .filter((result) => result.satisfied === false)
    .map((result) => result.details.join(" "));
  const obligationFailures = obligationResults
    .filter((result) => result.satisfied === false)
    .map((result) => result.details.join(" "));
  const baselineEntries = new Set(
    contract.baselineWorkingTree
      .map((entry) => getFingerprintBaselineEntryKey(entry))
      .filter((entry): entry is string => Boolean(entry)),
  );
  const legacyBaselineEntries = new Set(
    contract.baselineWorkingTree
      .filter((entry) => entry.fingerprint === undefined)
      .map((entry) => getLegacyBaselineEntryKey(entry)),
  );
  const sessionIdentifiers = getSessionIdentifiers(sessionDir, repoRoot);
  const introducedWorktreeEntries = getWorkingTreeStatus(repoRoot)
    .filter((entry) => entryTouchesKnownBaseline(entry, baselineEntries, legacyBaselineEntries) === false)
    .filter((entry) => isWorktreeEntryAllowed(entry) === false);
  const worktreeCheck = makeRuleResult(
    introducedWorktreeEntries.map((entry) => `${entry.status} ${entry.originalPath ? `${entry.originalPath} -> ` : ""}${entry.path}`),
    "clean-worktree-closeout",
    introducedWorktreeEntries.length === 0,
  );
  const manifestPathConstraintFailures = collectManifestPathConstraintFailures(contract, repoRoot);
  const manifestPathConstraintCheck = makeRuleResult(
    manifestPathConstraintFailures,
    "manifest-path-constraints",
    manifestPathConstraintFailures.length === 0,
  );
  const commitMessages = new Map(
    getFirstParentCommitShasForPaths(repoRoot, taskRange, contract.paths)
      .map((sha) => [sha, getCommitMessage(repoRoot, sha)] as const),
  );
  const taskCommitShas = [...commitMessages.entries()]
    .filter(([, message]) => commitBelongsToSession(message, sessionIdentifiers))
    .map(([sha]) => sha);
  const invalidCommitMessages = [...commitMessages.entries()].flatMap(([sha, message]) => {
    const issues = getStructuredCommitMessageIssues(message).map((issue) => `${sha}: ${issue}`);
    if (issues.length > 0) {
      return issues;
    }
    if (commitBelongsToSession(message, sessionIdentifiers)) {
      return [];
    }
    return [`${sha}: Session section does not reference this task session.`];
  });
  const commitCheck = makeRuleResult(
    [
      ...(contract.commitRequired && taskCommitShas.length === 0 ? ["No new commit touching task paths was created after the task session started."] : []),
      ...invalidCommitMessages,
    ],
    "structured-task-commits",
    contract.commitRequired === false || (taskCommitShas.length > 0 && invalidCommitMessages.length === 0),
  );
  const requireSessionArtifacts = shouldRequireSessionArtifacts(contract.sessionMode);
  const sessionArtifactResults: TaskCompletionResult["sessionArtifactResults"] = [
    validateTaskPlanArtifact(sessionDir, requireSessionArtifacts),
    validateSessionHandoffArtifact(sessionDir, requireSessionArtifacts),
    validateAdvisoryEvaluationArtifact(sessionDir, requireSessionArtifacts),
  ];
  const sessionArtifactFailures = sessionArtifactResults
    .filter((result) => result.required && result.satisfied === false)
    .map((result) => result.details.join(" "));
  const hasUnsatisfiedRequirements = requiredProfileFailures.length > 0
    || obligationFailures.length > 0
    || sessionArtifactFailures.length > 0
    || commitCheck.passed === false
    || taskPathCoverageCheck.passed === false
    || manifestPathConstraintCheck.passed === false
    || worktreeCheck.passed === false;
  const status = hasUnsatisfiedRequirements
    ? (blockers.length > 0 ? "blocked" : "failed")
    : "passed";

  const result: TaskCompletionResult = {
    blockers,
    commitCheck,
    contractId: contract.contractId,
    contractPath: getTaskContractPath(sessionDir),
    generatedAt: dayjs().toISOString(),
    obligationResults,
    passed: status === "passed",
    requiredProfileResults,
    sessionArtifactResults,
    sessionDir,
    status,
    summary: [
      makeRuleResult([], "task-contract", true),
      makeRuleResult(requiredProfileFailures, "required-verification-profiles", requiredProfileFailures.length === 0),
      makeRuleResult(obligationFailures, "verification-obligations", obligationFailures.length === 0),
      makeRuleResult(sessionArtifactFailures, "session-artifacts", sessionArtifactFailures.length === 0),
      commitCheck,
      taskPathCoverageCheck,
      manifestPathConstraintCheck,
      worktreeCheck,
      makeRuleResult(
        status === "blocked"
          ? blockers.map((blocker) => `${blocker.reason}${blocker.note ? `: ${blocker.note}` : ""}`)
          : [],
        "blocker-declaration",
        status !== "blocked",
      ),
    ],
    taskCommitShas,
    verifyResults: verifyResults.map((candidate) => ({
      advisory: candidate.result.advisory,
      generatedAt: candidate.result.generatedAt,
      passed: candidate.result.passed,
      profileId: candidate.result.profileId,
      proofKind: candidate.result.proofKind,
      resultPath: candidate.resultPath,
      taskContractId: candidate.result.taskContractId,
    })),
    worktreeCheck,
  };

  writeFileSync(getTaskCompletionPath(sessionDir), JSON.stringify(result, null, 2));
  return result;
}
