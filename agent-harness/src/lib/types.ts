// -------------------------------------------------------------------------- //
//                                   TYPES                                    //
// -------------------------------------------------------------------------- //

export type CommandBudget = {
  maxStderrBytes?: number;
  maxStdoutBytes?: number;
  timeoutMs?: number;
};

export type CommandResult = {
  commandId: string;
  cwd: string;
  durationMs: number;
  exitCode: number;
  failurePatternMatches: string[];
  maxStderrBytes: number;
  maxStdoutBytes: number;
  stderr: string;
  stderrBytes: number;
  stderrTruncated: boolean;
  stdout: string;
  stdoutBytes: number;
  stdoutTruncated: boolean;
  success: boolean;
  timedOut: boolean;
  timeoutMs: number;
};

export type CommentaryPolicy = "event-only" | "standard";

export type DetachedRunStatus =
  | "failed"
  | "failed-to-start"
  | "passed"
  | "process-exited-without-result"
  | "running"
  | "timeout";

export type DetachedRunMaterialEvent =
  | "failed"
  | "failed-to-start"
  | "passed"
  | "phase-change"
  | "process-exited-without-result"
  | "started"
  | "timeout";

export type DetachedRunArtifact = {
  artifactPath: string;
  command: string;
  commentaryPolicy: CommentaryPolicy;
  cwd: string;
  deadlineAt?: string;
  failureReason?: string;
  finishedAt?: string;
  lastMaterialEvent: {
    at: string;
    phase?: string;
    status: DetachedRunStatus;
    type: DetachedRunMaterialEvent;
  };
  lastObservedAt?: string;
  logPaths: {
    stderr: string;
    stdout: string;
  };
  logLimitBytes?: number;
  phase?: string;
  phaseArtifactBaseline?: {
    existed?: boolean;
    mtimeMs?: number;
    path: string;
    sha256?: string;
    size?: number;
  };
  phasePath?: string;
  phaseUpdatedAt?: string;
  pid: number;
  processIdentity?: {
    pid: number;
    startTime?: string;
  };
  processGroupIdentities?: Array<{
    pid: number;
    startTime?: string;
  }>;
  processGroupId?: number;
  processOwnerTokenSha256?: string;
  resultArtifactBaselines?: Array<{
    existed?: boolean;
    mtimeMs?: number;
    path: string;
    sha256?: string;
    size?: number;
  }>;
  resultObservedWhileRunningAt?: string;
  resultReadLimitBytes?: number;
  resultPath?: string;
  resumeCommand: string;
  startedAt: string;
  status: DetachedRunStatus;
  statusCommand: string;
  statusUpdatedAt: string;
  startupCleanupUnverified?: boolean;
  stderrPath: string;
  stdoutPath: string;
  timeoutMs?: number;
  version: 1;
  watchdogPid?: number;
};

export type DetachedRunStatusResult = {
  artifact: DetachedRunArtifact;
  changed: boolean;
  event?: DetachedRunMaterialEvent;
  message?: string;
  shouldOutput: boolean;
};

export type VerifyProofKind =
  | "code"
  | "contract"
  | "live-e2e"
  | "runtime-observability"
  | "simulated-flow"
  | "state-render";

export type VerificationObligation = {
  applies_to: string[];
  boundary?: string;
  description: string;
  id: string;
  required_proof_kind: VerifyProofKind;
  scenario: string;
};

export type ResolvedVerificationObligation = {
  acceptableProfiles: string[];
  boundary?: string;
  description: string;
  id: string;
  matchedPaths: string[];
  requiredProofKind: VerifyProofKind;
  scenario: string;
};

export type WorkingTreeStatusEntry = {
  fingerprint?: string;
  originalPath?: string;
  path: string;
  status: string;
};

export type SessionMode = "standard" | "long-running";

export type ContextPack = {
  advisoryEvaluationCommand?: string;
  advisoryEvaluationPath?: string;
  advisoryEvaluationRubricPath?: string;
  canonicalRoots: string[];
  commitRequired: boolean;
  completionCommand?: string;
  defaultCommands: string[];
  editingHints: string[];
  gitHistoryCommands: string[];
  handoffCommand?: string;
  manifestPathConstraints: Array<{
    allowedPaths: string[];
    forbiddenPaths: string[];
    manifestId: string;
  }>;
  manifests: string[];
  obligationCommands: string[];
  owners: string[];
  paths: string[];
  planCommand?: string;
  primarySpecs: string[];
  requiredEvidence: string[];
  requiredSkills: string[];
  sessionDir?: string;
  sessionCommands?: string[];
  sessionMode?: SessionMode;
  sessionModeArtifactRequirement?: "optional" | "required";
  sessionHandoffPath?: string;
  taskContractId?: string;
  taskContractPath?: string;
  taskPlanPath?: string;
  verificationObligations: ResolvedVerificationObligation[];
  verificationProfileMetadata?: VerificationProfileExecutionMetadata[];
  verificationProfiles: string[];
};

export type HarnessCatalogCommand = {
  command: string;
  description: string;
};

export type HarnessCatalog = {
  agentCommands: HarnessCatalogCommand[];
  automationCommands: HarnessCatalogCommand[];
  evalSuites: Array<{
    caseCount: number;
    caseIds: string[];
    id: string;
  }>;
  manifests: Array<{
    commitRequired: boolean;
    id: string;
    owner: string;
    verificationProfile: string;
  }>;
  verificationProfiles: Array<{
    advisory: boolean;
    commentaryPolicy: CommentaryPolicy;
    id: string;
    longRunning: boolean;
    proofKind: VerifyProofKind;
  }>;
};

export type VerificationProfileExecutionMetadata = {
  commentaryPolicy: CommentaryPolicy;
  id: string;
  longRunning: boolean;
  proofKind: VerifyProofKind;
};

export type EvalCase = {
  allowed_paths: string[];
  difficulty: string;
  evaluation_paths?: string[];
  grading_rules: EvalRule[];
  id: string;
  max_attempts: number;
  prompt: string;
  required_manifests: string[];
  setup_steps: string[];
  suite?: string;
  surface: string;
  title: string;
  verification_profile: string;
};

export type EvalRule =
  | {
      kind: "changed_files_within_allowed";
    }
  | {
      kind: "forbid_paths";
      values: string[];
    }
  | {
      kind: "require_artifacts";
      values: string[];
    }
  | {
      kind: "require_changed_paths";
      values: string[];
    }
  | {
      kind: "require_manifests";
      values: string[];
    }
  | {
      kind: "require_profile_pass";
    };

export type EvalCaseResult = {
  attemptCount: number;
  caseId: string;
  changedFiles: string[];
  contextBytes: number;
  gradingResults: RuleResult[];
  passed: boolean;
  profileId: string;
  runner: string;
  surface: string;
  title: string;
  verifyDurationMs: number;
  verifyPassed: boolean;
};

export type EvalRunResult = {
  attemptCount: number;
  caseResults: EvalCaseResult[];
  generatedAt: string;
  graderFalseFailureCount: number;
  runner: string;
  suiteId: string;
};

export type ManifestRecord = {
  allowed_paths: string[];
  canonical_roots: string[];
  commit_required: boolean;
  default_commands: string[];
  editing_hints: string[];
  forbidden_paths: string[];
  globs: string[];
  id: string;
  owner: string;
  primary_specs: string[];
  required_evidence: string[];
  required_skills: string[];
  verification_obligations: VerificationObligation[];
  verification_profile: string;
};

export type PathsResolution = {
  overlaps: Array<{ manifests: string[]; path: string }>;
  uncovered: string[];
};

export type PreflightResult = {
  baseProfiles: string[];
  changedPaths: string[];
  docsSyncCheck: RuleResult;
  evalCaseValidation: RuleResult;
  instructionCommandCheck: RuleResult;
  manifestCoverage: PathsResolution;
  manifestValidation: RuleResult;
  obligationProfiles: string[];
  relatedLineCheck: RuleResult;
  requiredButSkippedProfiles: Array<{
    profileId: string;
    reason: string;
  }>;
  trackedCoverage: RuleResult;
  twinInstructionCheck: RuleResult;
  verifyResults: VerifyRunResult[];
  verifyProfileValidation: RuleResult;
};

export type TaskBlockerReason =
  | "environment-misconfigured"
  | "missing-credentials"
  | "network-unavailable"
  | "provider-outage"
  | "simulator-prereq"
  | "user-dependency";

export type TaskContract = {
  baseHead: string;
  baselineWorkingTree: WorkingTreeStatusEntry[];
  commitRequired: boolean;
  contractId: string;
  createdAt: string;
  manifestPathConstraints: Array<{
    allowedPaths: string[];
    forbiddenPaths: string[];
    manifestId: string;
  }>;
  manifests: string[];
  paths: string[];
  requiredVerificationProfiles: string[];
  sessionMode: SessionMode;
  verificationObligations: ResolvedVerificationObligation[];
  version: 4;
};

export type TaskPlan = {
  assumptions: string[];
  contextSummary: {
    manifests: string[];
    paths: string[];
    primarySpecs: string[];
    verificationObligations: string[];
    verificationProfiles: string[];
  };
  createdAt: string;
  deliverables: string[];
  implementationSlices: string[];
  objective: string;
  openQuestions: string[];
  outOfScope: string[];
  risks: string[];
  sessionMode: SessionMode;
  updatedAt: string;
  verificationPlan: string[];
  version: 1;
};

export type SessionHandoffStatus =
  | "not-started"
  | "in-progress"
  | "blocked"
  | "ready-for-handoff"
  | "completed";

export type SessionHandoff = {
  artifacts: string[];
  completedWork: string[];
  createdAt: string;
  currentFocus: string;
  decisions: string[];
  nextSteps: string[];
  openRisks: string[];
  resumeCommands: string[];
  status: SessionHandoffStatus;
  summary: string;
  updatedAt: string;
  version: 1;
};

export type AdvisoryEvaluationRecommendedAction = "continue" | "revise" | "escalate";

export type AdvisoryEvaluationStatus = "not-run" | "pass" | "needs-follow-up";

export type AdvisoryEvaluationCriterionId =
  | "product-completeness"
  | "ux-clarity"
  | "visual-quality"
  | "code-quality";

export type AdvisoryEvaluationRubric = {
  createdAt: string;
  criteria: Array<{
    id: AdvisoryEvaluationCriterionId;
    prompt: string;
    summary: string;
  }>;
  scale: {
    max: number;
    min: number;
  };
  updatedAt: string;
  version: 1;
};

export type AdvisoryEvaluation = {
  findings: string[];
  gaps: string[];
  notApplicableCriteria: AdvisoryEvaluationCriterionId[];
  recommendedAction: AdvisoryEvaluationRecommendedAction;
  scores: Partial<Record<AdvisoryEvaluationCriterionId, number>>;
  status: AdvisoryEvaluationStatus;
  strengths: string[];
  summary: string;
  updatedAt: string;
  version: 1;
};

export type TaskBlocker = {
  note?: string;
  reason: TaskBlockerReason;
};

export type TaskCompletionRequiredProfileResult = {
  details: string[];
  profileId: string;
  resultPath?: string;
  satisfied: boolean;
};

export type TaskCompletionObligationResult = {
  acceptableProfiles: string[];
  boundary?: string;
  details: string[];
  matchedPaths: string[];
  obligationId: string;
  requiredProofKind: VerifyProofKind;
  resultPaths: string[];
  satisfied: boolean;
  scenario: string;
};

export type TaskCompletionResult = {
  blockers: TaskBlocker[];
  commitCheck: RuleResult;
  contractId: string;
  contractPath: string;
  generatedAt: string;
  obligationResults: TaskCompletionObligationResult[];
  passed: boolean;
  requiredProfileResults: TaskCompletionRequiredProfileResult[];
  sessionArtifactResults: Array<{
    artifactId: "task-plan" | "session-handoff" | "advisory-evaluation";
    details: string[];
    path: string;
    required: boolean;
    satisfied: boolean;
  }>;
  sessionDir: string;
  status: "blocked" | "failed" | "passed";
  summary: RuleResult[];
  taskCommitShas: string[];
  verifyResults: Array<{
    advisory: boolean;
    generatedAt: string;
    passed: boolean;
    profileId: string;
    proofKind: VerifyProofKind;
    resultPath: string;
    taskContractId?: string;
  }>;
  worktreeCheck: RuleResult;
};

export type RuleResult = {
  details: string[];
  name: string;
  passed: boolean;
};

export type Scorecard = {
  averageContextBytes: number;
  averageVerifyRuntimeMs: number;
  caseCount: number;
  firstPassSuccessRate: number;
  generatedAt: string;
  graderFalseFailureCount: number;
  passRateBySurface: Record<string, number>;
  suiteId: string;
  withinThreeAttemptsRate: number;
};

export type ScorecardComparison = {
  baseline: Scorecard;
  current: Scorecard;
  deltas: {
    averageContextBytes: number;
    averageVerifyRuntimeMs: number;
    firstPassSuccessRate: number;
    graderFalseFailureCount: number;
    passRateBySurface: Record<string, number>;
    withinThreeAttemptsRate: number;
  };
};

export type ScorecardThresholds = {
  maxAverageContextBytesIncrease?: number;
  maxAverageVerifyRuntimeMsIncrease?: number;
  maxFirstPassSuccessRateDrop?: number;
  maxGraderFalseFailureCountIncrease?: number;
  maxWithinThreeAttemptsRateDrop?: number;
};

export type ScorecardViolation = {
  actual: number;
  limit: number;
  metric: keyof ScorecardThresholds;
};

export type SoakCaseSummary = {
  averageVerifyRuntimeMs: number;
  caseId: string;
  failCount: number;
  failureRate: number;
  flaky: boolean;
  passedIterations: number[];
  passCount: number;
  passRate: number;
  profileId: string;
  runner: string;
  surface: string;
  title: string;
};

export type SoakProfileSummary = {
  averageVerifyRuntimeMs: number;
  failCount: number;
  failureRate: number;
  flakyCaseCount: number;
  passCount: number;
  passRate: number;
  profileId: string;
};

export type SoakRun = {
  artifactsDir: string;
  failedCaseIds: string[];
  iteration: number;
  passed: boolean;
  resultPath: string;
};

export type SoakThresholds = {
  maxCaseFailureRate?: number;
  maxFlakyCases?: number;
};

export type SoakViolation = {
  actual: number;
  limit: number;
  metric: keyof SoakThresholds;
};

export type SoakRunResult = {
  caseSummaries: SoakCaseSummary[];
  flakyCaseCount: number;
  generatedAt: string;
  iterationCount: number;
  overallPassRate: number;
  profileSummaries: SoakProfileSummary[];
  runner: string;
  runs: SoakRun[];
  suiteId: string;
};

export type VerifyProfile = {
  advisory: boolean;
  commentaryPolicy?: CommentaryPolicy;
  covers_boundaries: string[];
  covers_scenarios: string[];
  commands: VerifyProfileCommand[];
  evidence_extractors: string[];
  failure_patterns: string[];
  id: string;
  longRunning?: boolean;
  proof_kind: VerifyProofKind;
  required_artifacts: string[];
  required_pass_signals: string[];
  timeoutMs?: number;
};

export type VerifyProfileCommand = CommandBudget & {
  commentaryPolicy?: CommentaryPolicy;
  cwd?: string;
  id: string;
  longRunning?: boolean;
  run: string;
};

export type VerifyRunResult = {
  advisory: boolean;
  artifacts: string[];
  artifactsDir: string;
  commands: CommandResult[];
  coversBoundaries: string[];
  coversScenarios: string[];
  generatedAt: string;
  passed: boolean;
  paths: string[];
  profileId: string;
  proofKind: VerifyProofKind;
  requiredArtifactsPresent: string[];
  requiredArtifactsMissing: string[];
  summary: RuleResult[];
  taskContractId?: string;
  taskTreeFingerprint?: string;
  warnings: RuleResult[];
};
