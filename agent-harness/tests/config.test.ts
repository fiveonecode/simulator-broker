import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  getRepoRoot,
  listArtifactFiles,
  loadEvalCases,
  loadManifests,
  loadVerifyProfiles,
  matchManifestIdsForPath,
  resolveOperationalVerificationProfiles,
  validateEvalCases,
  validateManifestIds,
  validateVerifyProfiles,
} from "../src/lib/config.js";

const COMPLEX_SYSTEMS_INSTRUCTION_MARKERS = [
  "https://how.complexsystems.fail",
  "latent faults and degraded operation",
  "defense combinations, near misses, and recovery paths",
  "single root cause or blame an operator",
  "Record residual risk",
  "possible new coupling and failure mode",
  "recurring or high-consequence risk",
  "reduces net coupling and operational complexity",
] as const;

function getMissingComplexSystemsInstructionMarkers(source: string): string[] {
  return COMPLEX_SYSTEMS_INSTRUCTION_MARKERS.filter((marker) => source.includes(marker) === false);
}

describe("agent harness config", () => {
  const repoRoot = getRepoRoot();

  it("loads manifests and profiles with valid references", () => {
    const manifests = loadManifests(repoRoot);
    const profiles = loadVerifyProfiles(repoRoot);

    expect(manifests.map((manifest) => manifest.id)).toEqual([
      "agent-harness-runtime",
      "broker-runtime",
      "harness-contract",
      "implementation-foundation",
      "specs",
    ]);
    expect(profiles.map((profile) => profile.id)).toEqual([
      "implementation",
      "spec-only",
    ]);
    expect(validateManifestIds(manifests, profiles).passed).toBe(true);
    expect(validateVerifyProfiles(profiles).passed).toBe(true);
  });

  it("checks both staged and unstaged diffs in the spec-only profile", () => {
    const profile = loadVerifyProfiles(repoRoot).find((candidate) => candidate.id === "spec-only");

    expect(profile?.commands.find((command) => command.id === "spec-diff-check")?.run).toContain(
      "git diff --cached --check",
    );
  });

  it("routes repo paths to the expected manifests", () => {
    const manifests = loadManifests(repoRoot);

    expect(matchManifestIdsForPath(manifests, "broker-core/index.mjs")).toEqual(["broker-runtime"]);
    expect(matchManifestIdsForPath(manifests, "client/bin/simbroker.mjs")).toEqual(["broker-runtime"]);
    expect(matchManifestIdsForPath(manifests, "app/Sources/RootView.swift")).toEqual(["implementation-foundation"]);
    expect(matchManifestIdsForPath(manifests, "agent-harness/src/cli.ts")).toEqual(["agent-harness-runtime"]);
    expect(matchManifestIdsForPath(manifests, "examples/harness-adoption/README.md")).toEqual(["specs"]);
    expect(matchManifestIdsForPath(manifests, "examples/harness-adoption/sample-consumer-repo/scripts/with-broker-lease.sh")).toEqual(["broker-runtime"]);
    expect(matchManifestIdsForPath(manifests, "examples/harness-adoption/test/harness-adoption.test.mjs")).toEqual(["broker-runtime"]);
    expect(matchManifestIdsForPath(manifests, "README.md")).toEqual(["specs"]);
    expect(matchManifestIdsForPath(manifests, "WORKFLOW.md")).toEqual(["harness-contract"]);
  });

  it("resolves operational profiles from selected manifests", () => {
    const manifests = loadManifests(repoRoot);
    const profiles = loadVerifyProfiles(repoRoot);
    const readmePaths = ["README.md"];
    const readmeManifestIds = readmePaths.flatMap((candidatePath) => matchManifestIdsForPath(manifests, candidatePath));
    const readmeSelection = resolveOperationalVerificationProfiles(manifests, readmeManifestIds, readmePaths, profiles);
    const brokerPaths = ["broker-core/index.mjs"];
    const brokerManifestIds = brokerPaths.flatMap((candidatePath) => matchManifestIdsForPath(manifests, candidatePath));
    const brokerSelection = resolveOperationalVerificationProfiles(manifests, brokerManifestIds, brokerPaths, profiles);
    const agentHarnessPaths = ["agent-harness/src/cli.ts"];
    const agentHarnessManifestIds = agentHarnessPaths.flatMap((candidatePath) => matchManifestIdsForPath(manifests, candidatePath));
    const agentHarnessSelection = resolveOperationalVerificationProfiles(manifests, agentHarnessManifestIds, agentHarnessPaths, profiles);

    expect(readmeSelection.requiredProfiles).toEqual(["spec-only"]);
    expect(brokerSelection.requiredProfiles).toEqual(["implementation"]);
    expect(agentHarnessSelection.requiredProfiles).toEqual(["implementation"]);

    const executableExamplePaths = ["examples/harness-adoption/sample-consumer-repo/scripts/with-broker-lease.sh"];
    const executableExampleManifestIds = executableExamplePaths.flatMap((candidatePath) => matchManifestIdsForPath(manifests, candidatePath));
    const executableExampleSelection = resolveOperationalVerificationProfiles(manifests, executableExampleManifestIds, executableExamplePaths, profiles);
    expect(executableExampleSelection.requiredProfiles).toEqual(["implementation"]);
  });

  it("loads the optional eval suite when present", () => {
    const manifests = loadManifests(repoRoot);
    const evalCases = loadEvalCases(repoRoot);
    const profiles = loadVerifyProfiles(repoRoot);

    expect(evalCases).toHaveLength(0);
    expect(validateEvalCases(evalCases, manifests, profiles).passed).toBe(true);
  });

  it("keeps AGENTS and CLAUDE identical", () => {
    const agentsSource = readFileSync(`${repoRoot}/AGENTS.md`, "utf8");
    const claudeSource = readFileSync(`${repoRoot}/CLAUDE.md`, "utf8");

    expect(agentsSource).toBe(claudeSource);
  });

  it("anchors the compact complex-system failure discipline in shared instructions", () => {
    const agentsSource = readFileSync(`${repoRoot}/AGENTS.md`, "utf8");

    expect(getMissingComplexSystemsInstructionMarkers(agentsSource)).toEqual([]);
  });

  it("rejects incomplete complex-system failure guidance", () => {
    const agentsSource = readFileSync(`${repoRoot}/AGENTS.md`, "utf8");
    const incompleteSource = agentsSource.replace("latent faults and degraded operation", "degraded operation");

    expect(getMissingComplexSystemsInstructionMarkers(incompleteSource)).toEqual([
      "latent faults and degraded operation",
    ]);
  });

  it("rejects symlinks when listing artifact files", () => {
    const fixtureDir = mkdtempSync(path.join(tmpdir(), "agent-harness-artifacts-"));
    const existingArtifact = path.join(fixtureDir, "result.json");
    const brokenSymlink = path.join(fixtureDir, "missing-artifact");

    writeFileSync(existingArtifact, "{}\n");
    symlinkSync(path.join(fixtureDir, "does-not-exist"), brokenSymlink);

    try {
      expect(() => listArtifactFiles(fixtureDir)).toThrow(/Refusing to inventory symlinked verification artifact: missing-artifact/);
    } finally {
      rmSync(fixtureDir, { force: true, recursive: true });
    }
  });

  it("does not follow directory symlinks when listing artifact files", () => {
    const fixtureDir = mkdtempSync(path.join(tmpdir(), "agent-harness-artifacts-"));
    const externalDir = mkdtempSync(path.join(tmpdir(), "agent-harness-external-artifacts-"));
    const linkedDirectory = path.join(fixtureDir, "external");

    writeFileSync(path.join(externalDir, "result.json"), "{}\n");
    symlinkSync(externalDir, linkedDirectory);

    try {
      expect(() => listArtifactFiles(fixtureDir)).toThrow(/Refusing to inventory symlinked verification artifact: external/);
    } finally {
      rmSync(fixtureDir, { force: true, recursive: true });
      rmSync(externalDir, { force: true, recursive: true });
    }
  });
});
