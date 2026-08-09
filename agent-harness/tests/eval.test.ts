import { describe, expect, it } from "vitest";

import { resolveEvalCasePaths } from "../src/lib/eval.js";
import type { EvalCase } from "../src/lib/types.js";

describe("eval path resolution", () => {
  const baseCase: EvalCase = {
    allowed_paths: ["spec/**"],
    difficulty: "medium",
    grading_rules: [],
    id: "spec-related-line-fix",
    max_attempts: 3,
    prompt: "Update a spec file and preserve the Related graph.",
    required_manifests: ["specs"],
    setup_steps: ["Read the spec."],
    surface: "specs",
    title: "Spec related-line fix",
    verification_profile: "spec-only",
  };

  it("uses explicit paths when provided", () => {
    const resolvedPaths = resolveEvalCasePaths(
      baseCase,
      ["spec/README.md", "spec/build-and-test.md"],
      ["spec/architecture.md"],
    );

    expect(resolvedPaths).toEqual([
      "spec/README.md",
      "spec/build-and-test.md",
    ]);
  });

  it("expands synthetic eval paths when no explicit paths are provided", () => {
    const resolvedPaths = resolveEvalCasePaths(
      {
        ...baseCase,
        evaluation_paths: ["spec/2.0/README.md", "spec/build-and-test.md"],
      },
      [],
      ["spec/architecture.md"],
    );

    expect(resolvedPaths).toEqual([
      "spec/2.0/README.md",
      "spec/build-and-test.md",
    ]);
  });
});
