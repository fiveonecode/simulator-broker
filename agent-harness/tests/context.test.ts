import { describe, expect, it } from "vitest";

import { buildContextPack, renderContextMarkdown } from "../src/lib/context.js";
import { getRepoRoot, loadManifests, loadVerifyProfiles, matchManifestIdsForPath } from "../src/lib/config.js";

describe("context rendering", () => {
  const repoRoot = getRepoRoot();
  const manifests = loadManifests(repoRoot);
  const profiles = loadVerifyProfiles(repoRoot);

  function buildPack(paths: string[]) {
    const manifestIds = [...new Set(paths.flatMap((candidatePath) => matchManifestIdsForPath(manifests, candidatePath)))].sort();

    return buildContextPack(manifests, profiles, manifestIds, paths);
  }

  it("renders public docs through the specs manifest", () => {
    const markdown = renderContextMarkdown(buildPack(["README.md", "SECURITY.md"]));

    expect(markdown).toContain("Manifests: specs");
    expect(markdown).toContain("Owners: spec-steward");
    expect(markdown).toContain("Verification profiles: spec-only");
    expect(markdown).toContain("- harness-engineering");
    expect(markdown).toContain("- spec-creation-updating");
    expect(markdown).toContain("- verify:spec-only");
    expect(markdown).toContain("- none\n\n## Obligation Commands");
  });

  it("routes broker runtime paths to implementation verification", () => {
    const contextPack = buildPack(["broker-core/index.mjs", "client/bin/simbroker.mjs"]);

    expect(contextPack.manifests).toEqual(["broker-runtime"]);
    expect(contextPack.manifestPathConstraints).toEqual([{
      allowedPaths: [
        "broker-core/**",
        "client/**",
        "examples/harness-adoption/sample-consumer-repo/.github/workflows/**",
        "examples/harness-adoption/sample-consumer-repo/ci/**",
        "examples/harness-adoption/sample-consumer-repo/scripts/**",
        "examples/harness-adoption/test/**",
        "spec/**",
      ],
      forbiddenPaths: [".agents/**", "WORKFLOW.md", "scripts/validate.sh"],
      manifestId: "broker-runtime",
    }]);
    expect(contextPack.verificationProfiles).toEqual(["implementation"]);
    expect(contextPack.requiredEvidence).toContain("verify:implementation");
    expect(contextPack.defaultCommands).toContain(
      "npm run agent:verify -- --profile implementation --paths <files> --session-dir <session-dir>",
    );
  });

  it("routes executable harness work through implementation verification", () => {
    const contextPack = buildPack(["agent-harness/src/cli.ts"]);

    expect(contextPack.manifests).toEqual(["agent-harness-runtime"]);
    expect(contextPack.verificationProfiles).toEqual(["implementation"]);
    expect(contextPack.requiredSkills).toEqual(["harness-engineering", "spec-creation-updating"]);
    expect(contextPack.requiredEvidence).toContain("verify:implementation");
  });

  it("routes harness contract files through spec-only verification", () => {
    const contextPack = buildPack(["package-lock.json"]);

    expect(contextPack.manifests).toEqual(["harness-contract"]);
    expect(contextPack.verificationProfiles).toEqual(["spec-only"]);
    expect(contextPack.requiredEvidence).toContain("verify:spec-only");
  });

  it("shell-quotes git-history paths that contain spaces", () => {
    const contextPack = buildPack(["examples/harness-adoption/sample consumer/README.md"]);

    expect(contextPack.gitHistoryCommands).toEqual([
      "git log --oneline --decorate -n 10 -- 'examples/harness-adoption/sample consumer/README.md'",
      "git log --format=fuller -n 5 -- 'examples/harness-adoption/sample consumer/README.md'",
      "git show <sha> --stat -- 'examples/harness-adoption/sample consumer/README.md'",
    ]);
  });

  it("renders session artifact paths and commands when a session-aware context is provided", () => {
    const markdown = renderContextMarkdown({
      ...buildPack(["agent-harness/src/cli.ts"]),
      advisoryEvaluationCommand: "npm run agent:evaluate -- --session-dir /tmp/session",
      advisoryEvaluationPath: "/tmp/session/advisory-evaluation.json",
      advisoryEvaluationRubricPath: "/tmp/session/advisory-evaluation-rubric.json",
      completionCommand: "npm run agent:complete -- --session-dir /tmp/session",
      handoffCommand: "npm run agent:handoff -- --session-dir /tmp/session",
      planCommand: "npm run agent:plan -- --session-dir /tmp/session",
      sessionCommands: [
        "npm run agent:plan -- --session-dir /tmp/session",
        "npm run agent:handoff -- --session-dir /tmp/session",
        "npm run agent:evaluate -- --session-dir /tmp/session",
      ],
      sessionDir: "/tmp/session",
      sessionHandoffPath: "/tmp/session/session-handoff.json",
      sessionMode: "long-running",
      sessionModeArtifactRequirement: "required",
      taskContractPath: "/tmp/session/task-contract.json",
      taskPlanPath: "/tmp/session/task-plan.json",
    });

    expect(markdown).toContain("Session mode: long-running");
    expect(markdown).toContain("Task plan: /tmp/session/task-plan.json");
    expect(markdown).toContain("## Session Commands");
    expect(markdown).toContain("npm run agent:evaluate -- --session-dir /tmp/session");
  });
});
