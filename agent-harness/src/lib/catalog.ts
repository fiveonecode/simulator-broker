// -------------------------------------------------------------------------- //
//                                  CATALOG                                   //
// -------------------------------------------------------------------------- //

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { CommentaryPolicy, EvalCase, HarnessCatalog, ManifestRecord, RuleResult, VerifyProfile } from "./types.js";

const SPEC_AGENTS_PROFILES_START = "<!-- agent-harness-profiles:start -->";
const SPEC_AGENTS_PROFILES_END = "<!-- agent-harness-profiles:end -->";
const SPEC_AGENTS_SUITES_START = "<!-- agent-harness-suites:start -->";
const SPEC_AGENTS_SUITES_END = "<!-- agent-harness-suites:end -->";
const BUILD_TEST_COMMANDS_START = "<!-- agent-harness-commands:start -->";
const BUILD_TEST_COMMANDS_END = "<!-- agent-harness-commands:end -->";
const BUILD_TEST_PROFILES_START = "<!-- agent-harness-build-profiles:start -->";
const BUILD_TEST_PROFILES_END = "<!-- agent-harness-build-profiles:end -->";

const AGENT_COMMAND_DESCRIPTIONS: Record<string, string> = {
  "agent:catalog": "Prints the live harness catalog and can sync generated doc sections.",
  "agent:complete": "Checks that the current task session ran the required verification proofs before close-out.",
  "agent:context": "Resolves changed files to manifests and emits the minimal context pack.",
  "agent:detached-start": "Starts a shell command detached with machine-readable run state and redirected logs.",
  "agent:detached-status": "Reports or waits for material state changes from a detached-run artifact.",
  "agent:doctor": "Checks local prerequisites for the relevant verification profiles.",
  "agent:evaluate": "Writes an advisory evaluator result for completeness, UX, visual quality, and code quality.",
  "agent:eval": "Grades the current worktree against benchmark rules.",
  "agent:handoff": "Updates the structured session handoff artifact used for resume/reset-safe long-running work.",
  "agent:plan": "Writes the task plan artifact that turns a scoped task session into an implementation contract.",
  "agent:scorecard": "Compares eval result bundles and reports metric deltas.",
  "agent:soak": "Repeats eval runs and reports flaky cases plus repeated-run stability.",
  "agent:verify": "Runs a deterministic verification profile and writes artifacts.",
};

const AUTOMATION_COMMANDS: Array<{ command: string; description: string }> = [
  {
    command: "npm --prefix agent-harness run preflight -- --paths-file <file>",
    description: "Runs the repo-wide gate for manifest coverage, doc sync, and selected deterministic checks.",
  },
];

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function replaceSection(source: string, startMarker: string, endMarker: string, content: string): string {
  const startIndex = source.indexOf(startMarker);
  const endIndex = source.indexOf(endMarker);

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error(`Missing catalog markers ${startMarker} / ${endMarker}.`);
  }

  const before = source.slice(0, startIndex + startMarker.length);
  const after = source.slice(endIndex);
  return `${before}\n${content}\n${after}`;
}

function renderAgentCommandsSection(catalog: HarnessCatalog): string {
  const commands = [...catalog.agentCommands, ...catalog.automationCommands].map((command) => command.command);
  return ["```bash", ...commands, "```"].join("\n");
}

function renderVerificationProfilesSection(catalog: HarnessCatalog): string {
  return catalog.verificationProfiles
    .map((profile) => {
      const labels = [
        profile.advisory ? "advisory" : undefined,
        profile.longRunning === true ? "long-running" : undefined,
        profile.commentaryPolicy === "event-only" ? "event-only" : undefined,
      ].filter(Boolean);
      return `- \`${profile.id}\`${labels.length > 0 ? ` (${labels.join(", ")})` : ""} — proof \`${profile.proofKind}\``;
    })
    .join("\n");
}

function getProfileCommentaryPolicy(profile: VerifyProfile): CommentaryPolicy {
  if (profile.commentaryPolicy === "event-only" || profile.commands.some((command) => command.commentaryPolicy === "event-only")) {
    return "event-only";
  }

  return "standard";
}

function isProfileLongRunning(profile: VerifyProfile): boolean {
  return profile.longRunning === true || profile.commands.some((command) => command.longRunning === true);
}

function renderEvalSuitesSection(catalog: HarnessCatalog): string {
  return catalog.evalSuites
    .map((suite) => `- \`${suite.id}\` — ${suite.caseCount} case${suite.caseCount === 1 ? "" : "s"}`)
    .join("\n");
}

function syncSpecAgents(source: string, catalog: HarnessCatalog): string {
  let nextSource = replaceSection(source, SPEC_AGENTS_PROFILES_START, SPEC_AGENTS_PROFILES_END, renderVerificationProfilesSection(catalog));
  nextSource = replaceSection(nextSource, SPEC_AGENTS_SUITES_START, SPEC_AGENTS_SUITES_END, renderEvalSuitesSection(catalog));
  return nextSource;
}

function syncBuildAndTest(source: string, catalog: HarnessCatalog): string {
  let nextSource = replaceSection(source, BUILD_TEST_COMMANDS_START, BUILD_TEST_COMMANDS_END, renderAgentCommandsSection(catalog));
  nextSource = replaceSection(nextSource, BUILD_TEST_PROFILES_START, BUILD_TEST_PROFILES_END, renderVerificationProfilesSection(catalog));
  return nextSource;
}

export function buildHarnessCatalog(
  repoRoot: string,
  manifests: ManifestRecord[],
  verifyProfiles: VerifyProfile[],
  evalCases: EvalCase[],
): HarnessCatalog {
  const rootPackage = readJsonFile<{ scripts?: Record<string, string> }>(path.join(repoRoot, "package.json"));
  const agentCommands = Object.keys(rootPackage.scripts ?? {})
    .filter((scriptName) => scriptName.startsWith("agent:"))
    .sort()
    .map((commandName) => {
      const description = AGENT_COMMAND_DESCRIPTIONS[commandName];
      if (description === undefined) {
        throw new Error(`Missing catalog description for ${commandName}.`);
      }

      return {
        command: `npm run ${commandName}`,
        description,
      };
    });
  const suiteIds = [...new Set(evalCases.map((candidateCase) => candidateCase.suite ?? "unspecified"))].sort();

  return {
    agentCommands,
    automationCommands: AUTOMATION_COMMANDS,
    evalSuites: suiteIds.map((suiteId) => {
      const caseIds = evalCases
        .filter((candidateCase) => (candidateCase.suite ?? "unspecified") === suiteId)
        .map((candidateCase) => candidateCase.id)
        .sort();

      return {
        caseCount: caseIds.length,
        caseIds,
        id: suiteId,
      };
    }),
    manifests: manifests.map((manifest) => ({
      commitRequired: manifest.commit_required,
      id: manifest.id,
      owner: manifest.owner,
      verificationProfile: manifest.verification_profile,
    })),
    verificationProfiles: verifyProfiles.map((profile) => ({
      advisory: profile.advisory,
      commentaryPolicy: getProfileCommentaryPolicy(profile),
      id: profile.id,
      longRunning: isProfileLongRunning(profile),
      proofKind: profile.proof_kind,
    })),
  };
}

export function renderCatalogMarkdown(catalog: HarnessCatalog): string {
  const lines = [
    "# Agent Harness Catalog",
    "",
    "Generated from live harness config. Use `npm run agent:catalog -- --write-docs` to sync mirrored doc sections.",
    "",
    "## Commands",
    ...catalog.agentCommands.map((command) => `- \`${command.command}\` — ${command.description}`),
    ...catalog.automationCommands.map((command) => `- \`${command.command}\` — ${command.description}`),
    "",
    "## Verification profiles",
    ...renderVerificationProfilesSection(catalog).split("\n").filter(Boolean),
    "",
    "## Eval suites",
    ...catalog.evalSuites.map((suite) => `- \`${suite.id}\` — ${suite.caseCount} case${suite.caseCount === 1 ? "" : "s"} (${suite.caseIds.join(", ")})`),
    "",
    "## Manifests",
    ...catalog.manifests.map((manifest) =>
      `- \`${manifest.id}\` — owner \`${manifest.owner}\`, profile \`${manifest.verificationProfile}\`, commitRequired=\`${manifest.commitRequired}\``,
    ),
  ];

  return `${lines.join("\n")}\n`;
}

export function syncCatalogDocs(repoRoot: string, catalog: HarnessCatalog): string[] {
  const specAgentsPath = path.join(repoRoot, "spec", "agents.md");
  const buildAndTestPath = path.join(repoRoot, "spec", "build-and-test.md");
  const nextSpecAgents = syncSpecAgents(readFileSync(specAgentsPath, "utf8"), catalog);
  const nextBuildAndTest = syncBuildAndTest(readFileSync(buildAndTestPath, "utf8"), catalog);

  writeFileSync(specAgentsPath, nextSpecAgents);
  writeFileSync(buildAndTestPath, nextBuildAndTest);

  return [specAgentsPath, buildAndTestPath];
}

export function validateCatalogDocs(repoRoot: string, catalog: HarnessCatalog): RuleResult {
  const details: string[] = [];
  const specAgentsPath = path.join(repoRoot, "spec", "agents.md");
  const buildAndTestPath = path.join(repoRoot, "spec", "build-and-test.md");
  const currentSpecAgents = readFileSync(specAgentsPath, "utf8");
  const currentBuildAndTest = readFileSync(buildAndTestPath, "utf8");
  const expectedSpecAgents = syncSpecAgents(currentSpecAgents, catalog);
  const expectedBuildAndTest = syncBuildAndTest(currentBuildAndTest, catalog);

  if (currentSpecAgents !== expectedSpecAgents) {
    details.push("spec/agents.md generated harness sections are out of sync. Run `npm run agent:catalog -- --write-docs`.");
  }

  if (currentBuildAndTest !== expectedBuildAndTest) {
    details.push("spec/build-and-test.md generated harness sections are out of sync. Run `npm run agent:catalog -- --write-docs`.");
  }

  return {
    details,
    name: "docs-sync",
    passed: details.length === 0,
  };
}

export function validateInstructionCommands(repoRoot: string, catalog: HarnessCatalog): RuleResult {
  const details: string[] = [];
  const instructionPaths = ["AGENTS.md", "CLAUDE.md"].map((relativePath) => path.join(repoRoot, relativePath));
  const requiredCommandSnippets = [
    ...catalog.agentCommands.map((command) => command.command),
    ...catalog.automationCommands.map((command) => command.command),
  ];

  instructionPaths.forEach((instructionPath) => {
    const source = readFileSync(instructionPath, "utf8");
    requiredCommandSnippets.forEach((snippet) => {
      if (source.includes(snippet) === false) {
        details.push(`${path.relative(repoRoot, instructionPath)} is missing command reference: ${snippet}`);
      }
    });
  });

  return {
    details,
    name: "instruction-commands",
    passed: details.length === 0,
  };
}
