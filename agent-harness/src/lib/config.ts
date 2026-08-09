// -------------------------------------------------------------------------- //
//                                  IMPORTS                                   //
// -------------------------------------------------------------------------- //

import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import picomatch from "picomatch";
import YAML from "yaml";

import { canCoverageSatisfyObligation } from "./proof.js";
import type {
  CommentaryPolicy,
  EvalCase,
  ManifestRecord,
  PathsResolution,
  ResolvedVerificationObligation,
  RuleResult,
  VerificationObligation,
  VerifyProfile,
  VerifyProofKind,
} from "./types.js";

// -------------------------------------------------------------------------- //
//                                 CONSTANTS                                  //
// -------------------------------------------------------------------------- //

const ACTIVE_ROOTS = [
  ".agents",
  ".codex",
  ".github/workflows",
  ".gitignore",
  "AGENTS.md",
  "CLAUDE.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "WORKFLOW.md",
  "agent-harness",
  "app",
  "broker-core",
  "client",
  "examples",
  "package-lock.json",
  "package.json",
  "references",
  "script",
  "scripts",
  "spec",
];

const VERIFY_PROOF_KINDS: VerifyProofKind[] = [
  "code",
  "contract",
  "live-e2e",
  "runtime-observability",
  "simulated-flow",
  "state-render",
];
const COMMENTARY_POLICIES: CommentaryPolicy[] = ["event-only", "standard"];
const NODE_TIMER_MAX_TIMEOUT_MS = 2_147_483_647;

// -------------------------------------------------------------------------- //
//                               REPO HELPERS                                 //
// -------------------------------------------------------------------------- //

export function getAgentHarnessRoot(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFile), "..", "..");
}

export function getRepoRoot(): string {
  return path.resolve(getAgentHarnessRoot(), "..");
}

function assertArrayOfStrings(input: unknown, fieldName: string): string[] {
  if (Array.isArray(input) === false || input.some((value) => typeof value !== "string")) {
    throw new Error(`Expected ${fieldName} to be a string array.`);
  }

  return [...input].sort();
}

function assertBoolean(input: unknown, fieldName: string): boolean {
  if (typeof input !== "boolean") {
    throw new Error(`Expected ${fieldName} to be a boolean.`);
  }

  return input;
}

function assertNumber(input: unknown, fieldName: string): number {
  if (typeof input !== "number") {
    throw new Error(`Expected ${fieldName} to be a number.`);
  }

  return input;
}

function assertOptionalPositiveInteger(input: unknown, fieldName: string): number | undefined {
  if (input === undefined) {
    return undefined;
  }

  if (typeof input !== "number" || Number.isInteger(input) === false || input <= 0) {
    throw new Error(`Expected ${fieldName} to be a positive integer.`);
  }

  return input;
}

function assertTimerTimeoutMs(input: unknown, fieldName: string): number {
  const timeoutMs = assertOptionalPositiveInteger(input, fieldName);
  if (timeoutMs === undefined) {
    throw new Error(`Expected ${fieldName} to be a positive integer.`);
  }
  if (timeoutMs > NODE_TIMER_MAX_TIMEOUT_MS) {
    throw new Error(`Expected ${fieldName} to be no more than ${NODE_TIMER_MAX_TIMEOUT_MS}.`);
  }

  return timeoutMs;
}

function assertCommentaryPolicy(input: unknown, fieldName: string): CommentaryPolicy {
  const value = assertString(input, fieldName);

  if (COMMENTARY_POLICIES.includes(value as CommentaryPolicy) === false) {
    throw new Error(`Expected ${fieldName} to be one of ${COMMENTARY_POLICIES.join(", ")}.`);
  }

  return value as CommentaryPolicy;
}

function assertProofKind(input: unknown, fieldName: string): VerifyProofKind {
  const value = assertString(input, fieldName);

  if (VERIFY_PROOF_KINDS.includes(value as VerifyProofKind) === false) {
    throw new Error(
      `Expected ${fieldName} to be one of ${VERIFY_PROOF_KINDS.join(", ")}.`,
    );
  }

  return value as VerifyProofKind;
}

function assertObject(input: unknown, filePath: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`Expected ${filePath} to parse to an object.`);
  }

  return input as Record<string, unknown>;
}

function assertString(input: unknown, fieldName: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error(`Expected ${fieldName} to be a non-empty string.`);
  }

  return input;
}

function loadYamlObject(filePath: string): Record<string, unknown> {
  const source = readFileSync(filePath, "utf8");
  return assertObject(YAML.parse(source), filePath);
}

function listYamlFiles(directoryPath: string): string[] {
  return readdirSync(directoryPath)
    .filter((entry) => entry.endsWith(".yaml"))
    .map((entry) => path.join(directoryPath, entry))
    .sort();
}

function loadRequiredYamlFiles(directoryPath: string): string[] {
  if (existsSync(directoryPath) === false) {
    throw new Error(`Required harness config directory not found: ${directoryPath}`);
  }

  return listYamlFiles(directoryPath);
}

function loadOptionalYamlFiles(directoryPath: string): string[] {
  if (existsSync(directoryPath) === false) {
    return [];
  }

  return listYamlFiles(directoryPath);
}

function parseEvalCase(filePath: string): EvalCase {
  const raw = loadYamlObject(filePath);
  const gradingRules = raw.grading_rules;

  if (Array.isArray(gradingRules) === false) {
    throw new Error(`Expected grading_rules array in ${filePath}.`);
  }

  return {
    allowed_paths: assertArrayOfStrings(raw.allowed_paths, `${filePath}:allowed_paths`),
    difficulty: assertString(raw.difficulty, `${filePath}:difficulty`),
    evaluation_paths: raw.evaluation_paths === undefined
      ? undefined
      : assertArrayOfStrings(raw.evaluation_paths, `${filePath}:evaluation_paths`),
    grading_rules: gradingRules.map((rule, index) => {
      const candidate = assertObject(rule, `${filePath}:grading_rules[${index}]`);
      const kind = assertString(candidate.kind, `${filePath}:grading_rules[${index}].kind`);

      if (kind === "changed_files_within_allowed" || kind === "require_profile_pass") {
        return { kind };
      }

      if (kind === "forbid_paths" || kind === "require_artifacts" || kind === "require_changed_paths" || kind === "require_manifests") {
        return {
          kind,
          values: assertArrayOfStrings(candidate.values, `${filePath}:grading_rules[${index}].values`),
        };
      }

      throw new Error(`Unsupported grading rule kind '${kind}' in ${filePath}.`);
    }),
    id: assertString(raw.id, `${filePath}:id`),
    max_attempts: assertNumber(raw.max_attempts, `${filePath}:max_attempts`),
    prompt: assertString(raw.prompt, `${filePath}:prompt`),
    required_manifests: assertArrayOfStrings(raw.required_manifests, `${filePath}:required_manifests`),
    setup_steps: assertArrayOfStrings(raw.setup_steps, `${filePath}:setup_steps`),
    suite: raw.suite === undefined ? undefined : assertString(raw.suite, `${filePath}:suite`),
    surface: assertString(raw.surface, `${filePath}:surface`),
    title: assertString(raw.title, `${filePath}:title`),
    verification_profile: assertString(raw.verification_profile, `${filePath}:verification_profile`),
  };
}

function parseManifest(filePath: string): ManifestRecord {
  const raw = loadYamlObject(filePath);
  const verificationObligations = raw.verification_obligations;

  if (verificationObligations !== undefined && Array.isArray(verificationObligations) === false) {
    throw new Error(`Expected verification_obligations array in ${filePath}.`);
  }

  return {
    allowed_paths: assertArrayOfStrings(raw.allowed_paths, `${filePath}:allowed_paths`),
    canonical_roots: raw.canonical_roots === undefined
      ? []
      : assertArrayOfStrings(raw.canonical_roots, `${filePath}:canonical_roots`),
    commit_required: assertBoolean(raw.commit_required, `${filePath}:commit_required`),
    default_commands: assertArrayOfStrings(raw.default_commands, `${filePath}:default_commands`),
    editing_hints: raw.editing_hints === undefined
      ? []
      : assertArrayOfStrings(raw.editing_hints, `${filePath}:editing_hints`),
    forbidden_paths: assertArrayOfStrings(raw.forbidden_paths, `${filePath}:forbidden_paths`),
    globs: assertArrayOfStrings(raw.globs, `${filePath}:globs`),
    id: assertString(raw.id, `${filePath}:id`),
    owner: assertString(raw.owner, `${filePath}:owner`),
    primary_specs: assertArrayOfStrings(raw.primary_specs, `${filePath}:primary_specs`),
    required_evidence: assertArrayOfStrings(raw.required_evidence, `${filePath}:required_evidence`),
    required_skills: assertArrayOfStrings(raw.required_skills, `${filePath}:required_skills`),
    verification_obligations: (verificationObligations ?? []).map((obligation, index) => {
      const candidate = assertObject(obligation, `${filePath}:verification_obligations[${index}]`);

      return {
        applies_to: assertArrayOfStrings(
          candidate.applies_to,
          `${filePath}:verification_obligations[${index}].applies_to`,
        ),
        boundary: candidate.boundary === undefined
          ? undefined
          : assertString(candidate.boundary, `${filePath}:verification_obligations[${index}].boundary`),
        description: assertString(
          candidate.description,
          `${filePath}:verification_obligations[${index}].description`,
        ),
        id: assertString(candidate.id, `${filePath}:verification_obligations[${index}].id`),
        required_proof_kind: assertProofKind(
          candidate.required_proof_kind,
          `${filePath}:verification_obligations[${index}].required_proof_kind`,
        ),
        scenario: assertString(
          candidate.scenario,
          `${filePath}:verification_obligations[${index}].scenario`,
        ),
      };
    }),
    verification_profile: assertString(raw.verification_profile, `${filePath}:verification_profile`),
  };
}

function parseProfile(filePath: string): VerifyProfile {
  const raw = loadYamlObject(filePath);
  const commands = raw.commands;

  if (Array.isArray(commands) === false) {
    throw new Error(`Expected commands array in ${filePath}.`);
  }

  return {
    advisory: raw.advisory === undefined ? false : assertBoolean(raw.advisory, `${filePath}:advisory`),
    commentaryPolicy: raw.commentaryPolicy === undefined
      ? undefined
      : assertCommentaryPolicy(raw.commentaryPolicy, `${filePath}:commentaryPolicy`),
    covers_boundaries: raw.covers_boundaries === undefined
      ? []
      : assertArrayOfStrings(raw.covers_boundaries, `${filePath}:covers_boundaries`),
    covers_scenarios: raw.covers_scenarios === undefined
      ? []
      : assertArrayOfStrings(raw.covers_scenarios, `${filePath}:covers_scenarios`),
    commands: commands.map((command, index) => {
      const candidate = assertObject(command, `${filePath}:commands[${index}]`);

      return {
        commentaryPolicy: candidate.commentaryPolicy === undefined
          ? undefined
          : assertCommentaryPolicy(candidate.commentaryPolicy, `${filePath}:commands[${index}].commentaryPolicy`),
        cwd: candidate.cwd === undefined ? undefined : assertString(candidate.cwd, `${filePath}:commands[${index}].cwd`),
        id: assertString(candidate.id, `${filePath}:commands[${index}].id`),
        longRunning: candidate.longRunning === undefined
          ? false
          : assertBoolean(candidate.longRunning, `${filePath}:commands[${index}].longRunning`),
        maxStderrBytes: assertOptionalPositiveInteger(candidate.maxStderrBytes, `${filePath}:commands[${index}].maxStderrBytes`),
        maxStdoutBytes: assertOptionalPositiveInteger(candidate.maxStdoutBytes, `${filePath}:commands[${index}].maxStdoutBytes`),
        run: assertString(candidate.run, `${filePath}:commands[${index}].run`),
        timeoutMs: candidate.timeoutMs === undefined
          ? undefined
          : assertTimerTimeoutMs(candidate.timeoutMs, `${filePath}:commands[${index}].timeoutMs`),
      };
    }),
    evidence_extractors: assertArrayOfStrings(raw.evidence_extractors, `${filePath}:evidence_extractors`),
    failure_patterns: assertArrayOfStrings(raw.failure_patterns, `${filePath}:failure_patterns`),
    id: assertString(raw.id, `${filePath}:id`),
    longRunning: raw.longRunning === undefined ? false : assertBoolean(raw.longRunning, `${filePath}:longRunning`),
    proof_kind: assertProofKind(raw.proof_kind, `${filePath}:proof_kind`),
    required_artifacts: assertArrayOfStrings(raw.required_artifacts, `${filePath}:required_artifacts`),
    required_pass_signals: assertArrayOfStrings(raw.required_pass_signals, `${filePath}:required_pass_signals`),
    timeoutMs: raw.timeoutMs === undefined ? undefined : assertTimerTimeoutMs(raw.timeoutMs, `${filePath}:timeoutMs`),
  };
}

// -------------------------------------------------------------------------- //
//                                LOADERS                                     //
// -------------------------------------------------------------------------- //

export function loadEvalCases(repoRoot: string): EvalCase[] {
  const directoryPath = path.join(repoRoot, ".agents", "evals");
  return loadOptionalYamlFiles(directoryPath).map(parseEvalCase);
}

export function loadManifests(repoRoot: string): ManifestRecord[] {
  const directoryPath = path.join(repoRoot, ".agents", "manifests");
  return loadRequiredYamlFiles(directoryPath).map(parseManifest);
}

export function loadVerifyProfiles(repoRoot: string): VerifyProfile[] {
  const directoryPath = path.join(repoRoot, ".agents", "verify");
  return loadRequiredYamlFiles(directoryPath).map(parseProfile);
}

// -------------------------------------------------------------------------- //
//                              MATCHING LOGIC                                //
// -------------------------------------------------------------------------- //

export function isActiveTrackedPath(repoRelativePath: string): boolean {
  return ACTIVE_ROOTS.some((root) => repoRelativePath === root || repoRelativePath.startsWith(`${root}/`));
}

export function matchManifestIdsForPath(manifests: ManifestRecord[], repoRelativePath: string): string[] {
  return manifests
    .filter((manifest) => manifest.globs.some((glob) => picomatch(glob, { dot: true })(repoRelativePath)))
    .map((manifest) => manifest.id)
    .sort();
}

export function resolvePaths(manifests: ManifestRecord[], repoRelativePaths: string[]): PathsResolution {
  const overlaps: Array<{ manifests: string[]; path: string }> = [];
  const uncovered: string[] = [];

  repoRelativePaths.forEach((repoRelativePath) => {
    const manifestIds = matchManifestIdsForPath(manifests, repoRelativePath);

    if (manifestIds.length === 0) {
      uncovered.push(repoRelativePath);
      return;
    }

    if (manifestIds.length > 1) {
      overlaps.push({
        manifests: manifestIds,
        path: repoRelativePath,
      });
    }
  });

  return {
    overlaps,
    uncovered: uncovered.sort(),
  };
}

export function validateManifestCoverage(manifests: ManifestRecord[], trackedFiles: string[]): RuleResult {
  const activeTrackedFiles = trackedFiles.filter(isActiveTrackedPath);
  const resolution = resolvePaths(manifests, activeTrackedFiles);
  const details: string[] = [];

  resolution.uncovered.forEach((uncoveredPath) => {
    details.push(`Uncovered tracked file: ${uncoveredPath}`);
  });

  resolution.overlaps.forEach((overlap) => {
    details.push(`Overlapping manifests for ${overlap.path}: ${overlap.manifests.join(", ")}`);
  });

  return {
    details,
    name: "tracked-coverage",
    passed: details.length === 0,
  };
}

export function validateManifestIds(manifests: ManifestRecord[], verifyProfiles: VerifyProfile[]): RuleResult {
  const details: string[] = [];
  const profileIds = new Set(verifyProfiles.map((profile) => profile.id));
  const seenManifestIds = new Set<string>();
  const seenObligationIds = new Set<string>();

  manifests.forEach((manifest) => {
    if (seenManifestIds.has(manifest.id)) {
      details.push(`Duplicate manifest id: ${manifest.id}`);
    }
    seenManifestIds.add(manifest.id);

    if (profileIds.has(manifest.verification_profile) === false) {
      details.push(`Manifest ${manifest.id} references missing profile ${manifest.verification_profile}`);
    }

    if (manifest.globs.length === 0) {
      details.push(`Manifest ${manifest.id} has no globs.`);
    }

    manifest.verification_obligations.forEach((obligation) => {
      if (seenObligationIds.has(obligation.id)) {
        details.push(`Duplicate verification obligation id: ${obligation.id}`);
      }
      seenObligationIds.add(obligation.id);

      if (obligation.applies_to.length === 0) {
        details.push(`Manifest ${manifest.id} obligation ${obligation.id} has no applies_to globs.`);
      }

      const matchingProfiles = resolveVerificationProfilesForObligation(
        obligation,
        verifyProfiles,
      );
      if (matchingProfiles.length === 0) {
        details.push(
          `Manifest ${manifest.id} obligation ${obligation.id} has no satisfying profile for proof kind ${obligation.required_proof_kind} scenario ${obligation.scenario}.`,
        );
      }
    });
  });

  return {
    details,
    name: "manifest-validation",
    passed: details.length === 0,
  };
}

export function validateVerifyProfiles(verifyProfiles: VerifyProfile[]): RuleResult {
  const details: string[] = [];
  const seenProfileIds = new Set<string>();

  verifyProfiles.forEach((profile) => {
    if (seenProfileIds.has(profile.id)) {
      details.push(`Duplicate verify profile id: ${profile.id}`);
    }
    seenProfileIds.add(profile.id);

    const seenCommandIds = new Set<string>();
    profile.commands.forEach((command) => {
      if (seenCommandIds.has(command.id)) {
        details.push(`Verify profile ${profile.id} has duplicate command id ${command.id}`);
      }
      seenCommandIds.add(command.id);
    });

    profile.required_pass_signals.forEach((signalId) => {
      if (seenCommandIds.has(signalId) === false) {
        details.push(`Verify profile ${profile.id} requires missing pass signal ${signalId}`);
      }
    });

    const requiresExplicitCoverage = profile.proof_kind === "live-e2e"
      || profile.proof_kind === "runtime-observability"
      || profile.proof_kind === "simulated-flow"
      || profile.proof_kind === "state-render";
    if (requiresExplicitCoverage && profile.covers_scenarios.length === 0 && profile.covers_boundaries.length === 0) {
      details.push(
        `Verify profile ${profile.id} must declare covers_scenarios or covers_boundaries for proof kind ${profile.proof_kind}.`,
      );
    }
  });

  return {
    details,
    name: "verify-profile-validation",
    passed: details.length === 0,
  };
}

function matchesPatternSet(patterns: string[], candidatePath: string): boolean {
  return patterns.some((pattern) => picomatch(pattern, { dot: true })(candidatePath));
}

function countExplicitCoverageMatches(
  obligation: Pick<ResolvedVerificationObligation, "boundary" | "scenario">,
  profile: VerifyProfile,
): number {
  let matchCount = 0;

  if (profile.covers_scenarios.includes(obligation.scenario)) {
    matchCount += 1;
  }

  if (obligation.boundary !== undefined && profile.covers_boundaries.includes(obligation.boundary)) {
    matchCount += 1;
  }

  return matchCount;
}

function compareOperationalProfiles(
  obligation: Pick<ResolvedVerificationObligation, "boundary" | "scenario">,
  left: VerifyProfile,
  right: VerifyProfile,
): number {
  const leftExplicitMatches = countExplicitCoverageMatches(obligation, left);
  const rightExplicitMatches = countExplicitCoverageMatches(obligation, right);
  if (leftExplicitMatches !== rightExplicitMatches) {
    return rightExplicitMatches - leftExplicitMatches;
  }

  const leftScopeSize = left.covers_scenarios.length + left.covers_boundaries.length;
  const rightScopeSize = right.covers_scenarios.length + right.covers_boundaries.length;
  if (leftScopeSize !== rightScopeSize) {
    return leftScopeSize - rightScopeSize;
  }

  if (left.commands.length !== right.commands.length) {
    return left.commands.length - right.commands.length;
  }

  return left.id.localeCompare(right.id);
}

function selectOperationalProfilesForObligation(
  obligation: ResolvedVerificationObligation,
  baseProfileIds: string[],
  verifyProfiles: VerifyProfile[],
): VerifyProfile[] {
  const acceptableProfiles = obligation.acceptableProfiles
    .map((profileId) => verifyProfiles.find((profile) => profile.id === profileId))
    .filter((profile): profile is VerifyProfile => profile !== undefined && profile.advisory === false);
  const explicitlyMatchedProfiles = acceptableProfiles.filter(
    (profile) => countExplicitCoverageMatches(obligation, profile) > 0,
  );

  if (explicitlyMatchedProfiles.length > 0) {
    return explicitlyMatchedProfiles;
  }

  const baseProfiles = acceptableProfiles.filter((profile) => baseProfileIds.includes(profile.id));
  if (baseProfiles.length > 0) {
    return baseProfiles;
  }

  const narrowestProfile = acceptableProfiles
    .slice()
    .sort((left, right) => compareOperationalProfiles(obligation, left, right))[0];

  return narrowestProfile === undefined ? [] : [narrowestProfile];
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export function resolveVerificationProfilesForObligation(
  obligation: VerificationObligation,
  verifyProfiles: VerifyProfile[],
): string[] {
  return verifyProfiles
    .filter((profile) => {
      return canCoverageSatisfyObligation(
        {
          boundary: obligation.boundary,
          requiredProofKind: obligation.required_proof_kind,
          scenario: obligation.scenario,
        },
        {
          advisory: profile.advisory,
          coversBoundaries: profile.covers_boundaries,
          coversScenarios: profile.covers_scenarios,
          proofKind: profile.proof_kind,
        },
      );
    })
    .map((profile) => profile.id)
    .sort();
}

export function resolveVerificationObligations(
  manifests: ManifestRecord[],
  matchedManifestIds: string[],
  paths: string[],
  verifyProfiles: VerifyProfile[],
): ResolvedVerificationObligation[] {
  return manifests
    .filter((manifest) => matchedManifestIds.includes(manifest.id))
    .flatMap((manifest) =>
      manifest.verification_obligations.flatMap((obligation) => {
        const matchedPaths = paths.filter((candidatePath) => matchesPatternSet(obligation.applies_to, candidatePath));
        if (matchedPaths.length === 0) {
          return [];
        }

        return [{
          acceptableProfiles: resolveVerificationProfilesForObligation(obligation, verifyProfiles),
          boundary: obligation.boundary,
          description: obligation.description,
          id: obligation.id,
          matchedPaths: matchedPaths.sort(),
          requiredProofKind: obligation.required_proof_kind,
          scenario: obligation.scenario,
        }];
      }),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function resolveOperationalVerificationProfiles(
  manifests: ManifestRecord[],
  matchedManifestIds: string[],
  paths: string[],
  verifyProfiles: VerifyProfile[],
): {
  baseProfiles: string[];
  obligationProfiles: string[];
  requiredProfiles: string[];
  verificationObligations: ResolvedVerificationObligation[];
} {
  const baseProfiles = uniqueSorted(
    manifests
      .filter((manifest) => matchedManifestIds.includes(manifest.id))
      .map((manifest) => manifest.verification_profile),
  );
  const verificationObligations = resolveVerificationObligations(
    manifests,
    matchedManifestIds,
    paths,
    verifyProfiles,
  );
  const obligationProfiles = uniqueSorted(
    verificationObligations.flatMap((obligation) => {
      const selectedProfiles = selectOperationalProfilesForObligation(obligation, baseProfiles, verifyProfiles);

      return selectedProfiles
        .map((profile) => profile.id)
        .filter((profileId) => baseProfiles.includes(profileId) === false);
    }),
  );

  return {
    baseProfiles,
    obligationProfiles,
    requiredProfiles: uniqueSorted([...baseProfiles, ...obligationProfiles]),
    verificationObligations,
  };
}

export function validateEvalCases(
  evalCases: EvalCase[],
  manifests: ManifestRecord[],
  verifyProfiles: VerifyProfile[],
): RuleResult {
  const details: string[] = [];
  const manifestIds = new Set(manifests.map((manifest) => manifest.id));
  const profileIds = new Set(verifyProfiles.map((profile) => profile.id));
  const seenCaseIds = new Set<string>();

  evalCases.forEach((candidateCase) => {
    if (seenCaseIds.has(candidateCase.id)) {
      details.push(`Duplicate eval case id: ${candidateCase.id}`);
    }
    seenCaseIds.add(candidateCase.id);

    if (profileIds.has(candidateCase.verification_profile) === false) {
      details.push(`Eval case ${candidateCase.id} references missing profile ${candidateCase.verification_profile}`);
    }

    candidateCase.required_manifests.forEach((manifestId) => {
      if (manifestIds.has(manifestId) === false) {
        details.push(`Eval case ${candidateCase.id} references missing manifest ${manifestId}`);
      }
    });

    candidateCase.grading_rules.forEach((rule) => {
      if (rule.kind !== "require_manifests") {
        return;
      }

      rule.values.forEach((manifestId) => {
        if (manifestIds.has(manifestId) === false) {
          details.push(`Eval case ${candidateCase.id} requires unknown manifest ${manifestId}`);
        }
      });
    });
  });

  return {
    details,
    name: "eval-case-validation",
    passed: details.length === 0,
  };
}

export function listArtifactFiles(directoryPath: string): string[] {
  const discoveredFiles: string[] = [];

  function isMissingFileError(error: unknown): boolean {
    return typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ENOENT";
  }

  function walk(currentPath: string): void {
    let currentStats;
    try {
      currentStats = lstatSync(currentPath);
    } catch (error) {
      if (isMissingFileError(error)) {
        return;
      }
      throw error;
    }

    if (currentStats.isSymbolicLink()) {
      throw new Error(`Refusing to inventory symlinked verification artifact: ${path.relative(directoryPath, currentPath)}`);
    }

    if (currentStats.isDirectory()) {
      let entries: string[];
      try {
        entries = readdirSync(currentPath).sort();
      } catch (error) {
        if (isMissingFileError(error)) {
          return;
        }
        throw error;
      }
      entries.forEach((entry) => walk(path.join(currentPath, entry)));
      return;
    }

    discoveredFiles.push(path.relative(directoryPath, currentPath));
  }

  if (lstatSync(directoryPath).isDirectory()) {
    walk(directoryPath);
  }

  return discoveredFiles.sort();
}
