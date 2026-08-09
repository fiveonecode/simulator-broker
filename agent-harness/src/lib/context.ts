// -------------------------------------------------------------------------- //
//                                  IMPORTS                                   //
// -------------------------------------------------------------------------- //

import { resolveVerificationObligations } from "./config.js";
import { shellQuote } from "./runtime.js";
import type { CommentaryPolicy, ContextPack, ManifestRecord, VerificationProfileExecutionMetadata } from "./types.js";
import type { VerifyProfile } from "./types.js";

// -------------------------------------------------------------------------- //
//                                 CONTEXT                                    //
// -------------------------------------------------------------------------- //

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function buildGitHistoryCommands(paths: string[]): string[] {
  const joinedPaths = paths.map(shellQuote).join(" ");

  return [
    `git log --oneline --decorate -n 10 -- ${joinedPaths}`,
    `git log --format=fuller -n 5 -- ${joinedPaths}`,
    `git show <sha> --stat -- ${joinedPaths}`,
  ];
}

function getProfileCommentaryPolicy(profile: VerifyProfile): CommentaryPolicy {
  if (profile.commentaryPolicy === "event-only" || profile.commands.some((command) => command.commentaryPolicy === "event-only")) {
    return "event-only";
  }

  return "standard";
}

export function getVerificationProfileMetadata(
  verifyProfiles: VerifyProfile[],
  profileIds: string[],
): VerificationProfileExecutionMetadata[] {
  return profileIds
    .map((profileId) => verifyProfiles.find((profile) => profile.id === profileId))
    .filter((profile): profile is VerifyProfile => profile !== undefined)
    .map((profile) => ({
      commentaryPolicy: getProfileCommentaryPolicy(profile),
      id: profile.id,
      longRunning: profile.longRunning === true || profile.commands.some((command) => command.longRunning === true),
      proofKind: profile.proof_kind,
    }));
}

function renderVerificationProfileLabel(profile: VerificationProfileExecutionMetadata): string {
  const labels = [
    profile.longRunning === true ? "long-running" : undefined,
    profile.commentaryPolicy === "event-only" ? "event-only" : undefined,
  ].filter(Boolean);

  return `${profile.id}${labels.length > 0 ? ` (${labels.join(", ")})` : ""}`;
}

export function buildContextPack(
  manifests: ManifestRecord[],
  verifyProfiles: VerifyProfile[],
  matchedManifestIds: string[],
  paths: string[],
): ContextPack {
  const selectedManifests = manifests.filter((manifest) => matchedManifestIds.includes(manifest.id));
  const verificationObligations = resolveVerificationObligations(
    manifests,
    matchedManifestIds,
    paths,
    verifyProfiles,
  );
  const obligationCommands = uniqueSorted(
    verificationObligations.flatMap((obligation) =>
      obligation.acceptableProfiles.map(
        (profileId) => `npm run agent:verify -- --profile ${profileId} --paths <files>`,
      )),
  );
  const verificationProfiles = uniqueSorted(selectedManifests.map((manifest) => manifest.verification_profile));
  const verificationProfileMetadataIds = uniqueSorted([
    ...verificationProfiles,
    ...verificationObligations.flatMap((obligation) => obligation.acceptableProfiles),
  ]);

  return {
    canonicalRoots: uniqueSorted(selectedManifests.flatMap((manifest) => manifest.canonical_roots)),
    commitRequired: selectedManifests.some((manifest) => manifest.commit_required),
    defaultCommands: uniqueSorted(selectedManifests.flatMap((manifest) => manifest.default_commands)),
    editingHints: uniqueSorted(selectedManifests.flatMap((manifest) => manifest.editing_hints)),
    gitHistoryCommands: buildGitHistoryCommands([...paths].sort()),
    manifestPathConstraints: selectedManifests
      .map((manifest) => ({
        allowedPaths: [...manifest.allowed_paths].sort(),
        forbiddenPaths: [...manifest.forbidden_paths].sort(),
        manifestId: manifest.id,
      }))
      .sort((left, right) => left.manifestId.localeCompare(right.manifestId)),
    manifests: uniqueSorted(matchedManifestIds),
    obligationCommands,
    owners: uniqueSorted(selectedManifests.map((manifest) => manifest.owner)),
    paths: [...paths].sort(),
    primarySpecs: uniqueSorted(selectedManifests.flatMap((manifest) => manifest.primary_specs)),
    requiredEvidence: uniqueSorted(selectedManifests.flatMap((manifest) => manifest.required_evidence)),
    requiredSkills: uniqueSorted(selectedManifests.flatMap((manifest) => manifest.required_skills)),
    verificationObligations,
    verificationProfileMetadata: getVerificationProfileMetadata(verifyProfiles, verificationProfileMetadataIds),
    verificationProfiles,
  };
}

export function renderContextMarkdown(contextPack: ContextPack): string {
  const verificationProfileMetadata = contextPack.verificationProfileMetadata ?? [];
  const verificationProfileSummary = verificationProfileMetadata.length > 0
    ? verificationProfileMetadata.map(renderVerificationProfileLabel).join(", ")
    : contextPack.verificationProfiles.join(", ");
  const lines = [
    "# Agent Context Pack",
    "",
    `Paths: ${contextPack.paths.join(", ")}`,
    `Manifests: ${contextPack.manifests.join(", ")}`,
    `Owners: ${contextPack.owners.join(", ")}`,
    `Verification profiles: ${verificationProfileSummary}`,
    `Blocking verification obligations: ${contextPack.verificationObligations.length > 0 ? "yes" : "no"}`,
    `Commit required: ${contextPack.commitRequired ? "yes" : "no"}`,
    ...(contextPack.sessionMode ? [`Session mode: ${contextPack.sessionMode}`] : []),
    ...(contextPack.sessionModeArtifactRequirement
      ? [`Long-running session artifacts required: ${contextPack.sessionModeArtifactRequirement === "required" ? "yes" : "no"}`]
      : []),
    ...(contextPack.sessionDir ? [`Task session: ${contextPack.sessionDir}`] : []),
    ...(contextPack.taskContractPath ? [`Task contract: ${contextPack.taskContractPath}`] : []),
    ...(contextPack.taskPlanPath ? [`Task plan: ${contextPack.taskPlanPath}`] : []),
    ...(contextPack.sessionHandoffPath ? [`Session handoff: ${contextPack.sessionHandoffPath}`] : []),
    ...(contextPack.advisoryEvaluationPath ? [`Advisory evaluation: ${contextPack.advisoryEvaluationPath}`] : []),
    ...(contextPack.advisoryEvaluationRubricPath ? [`Advisory rubric: ${contextPack.advisoryEvaluationRubricPath}`] : []),
    ...(contextPack.completionCommand ? [`Completion gate: ${contextPack.completionCommand}`] : []),
    "",
    "## Canonical Roots",
    ...(contextPack.canonicalRoots.length === 0
      ? ["- none"]
      : contextPack.canonicalRoots.map((rootPath) => `- ${rootPath}`)),
    "",
    "## Editing Hints",
    ...(contextPack.editingHints.length === 0
      ? ["- none"]
      : contextPack.editingHints.map((hint) => `- ${hint}`)),
    "",
    "## Git History Commands",
    ...contextPack.gitHistoryCommands.map((command) => `- ${command}`),
    "",
    "## Primary Specs",
    ...contextPack.primarySpecs.map((specPath) => `- ${specPath}`),
    "",
    "## Required Skills",
    ...contextPack.requiredSkills.map((skillId) => `- ${skillId}`),
    "",
    "## Required Evidence",
    ...contextPack.requiredEvidence.map((evidence) => `- ${evidence}`),
    "",
    "## Verification Obligations",
    ...(contextPack.verificationObligations.length === 0
      ? ["- none"]
      : contextPack.verificationObligations.map((obligation) => {
          const details = [
            `scenario \`${obligation.scenario}\``,
            `proof \`${obligation.requiredProofKind}\``,
          ];

          if (obligation.boundary) {
            details.push(`boundary \`${obligation.boundary}\``);
          }

          details.push(`matched paths ${obligation.matchedPaths.join(", ")}`);
          details.push(
            obligation.acceptableProfiles.length > 0
              ? `acceptable profiles ${obligation.acceptableProfiles.join(", ")}`
              : "acceptable profiles none",
          );

          return `- \`${obligation.id}\` — ${obligation.description} (${details.join("; ")})`;
        })),
    "",
    "## Obligation Commands",
    ...(contextPack.obligationCommands.length === 0
      ? ["- none"]
      : contextPack.obligationCommands.map((command) => `- ${command}`)),
    "",
    ...(contextPack.sessionCommands
      ? [
          "## Session Commands",
          ...contextPack.sessionCommands.map((command) => `- ${command}`),
          "",
        ]
      : []),
    "## Default Commands",
    ...contextPack.defaultCommands.map((command) => `- ${command}`),
  ];

  return `${lines.join("\n")}\n`;
}
