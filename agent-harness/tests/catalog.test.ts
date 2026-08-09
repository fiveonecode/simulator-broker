import { describe, expect, it } from "vitest";

import { buildHarnessCatalog, validateCatalogDocs, validateInstructionCommands } from "../src/lib/catalog.js";
import { getRepoRoot, loadEvalCases, loadManifests, loadVerifyProfiles } from "../src/lib/config.js";

describe("catalog sync", () => {
  it("builds a live catalog with agent commands and suites", () => {
    const repoRoot = getRepoRoot();
    const catalog = buildHarnessCatalog(repoRoot, loadManifests(repoRoot), loadVerifyProfiles(repoRoot), loadEvalCases(repoRoot));

    expect(catalog.agentCommands.map((command) => command.command)).toContain("npm run agent:catalog");
    expect(catalog.agentCommands.map((command) => command.command)).toContain("npm run agent:complete");
    expect(catalog.agentCommands.map((command) => command.command)).toContain("npm run agent:plan");
    expect(catalog.agentCommands.map((command) => command.command)).toContain("npm run agent:handoff");
    expect(catalog.agentCommands.map((command) => command.command)).toContain("npm run agent:evaluate");
    expect(catalog.verificationProfiles.map((profile) => profile.id)).toEqual(["implementation", "spec-only"]);
    expect(catalog.evalSuites).toEqual([]);
  });

  it("keeps generated docs and instruction commands in sync", () => {
    const repoRoot = getRepoRoot();
    const catalog = buildHarnessCatalog(repoRoot, loadManifests(repoRoot), loadVerifyProfiles(repoRoot), loadEvalCases(repoRoot));

    expect(validateCatalogDocs(repoRoot, catalog).passed).toBe(true);
    expect(validateInstructionCommands(repoRoot, catalog).passed).toBe(true);
  });
});
