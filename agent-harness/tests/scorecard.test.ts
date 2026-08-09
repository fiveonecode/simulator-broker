import { describe, expect, it } from "vitest";

import { checkScorecardThresholds, compareScorecards, makeScorecard } from "../src/lib/scorecard.js";
import type { EvalRunResult } from "../src/lib/types.js";

describe("scorecard aggregation", () => {
  it("aggregates and compares eval runs", () => {
    const baselineRun: EvalRunResult = {
      attemptCount: 1,
      caseResults: [
        {
          attemptCount: 1,
          caseId: "one",
          changedFiles: ["spec/README.md"],
          contextBytes: 100,
          gradingResults: [],
          passed: true,
          profileId: "spec-only",
          runner: "codex",
          surface: "specs",
          title: "One",
          verifyDurationMs: 50,
          verifyPassed: true,
        },
      ],
      generatedAt: "2026-03-13T00:00:00.000Z",
      graderFalseFailureCount: 0,
      runner: "codex",
      suiteId: "foundation",
    };

    const currentRun: EvalRunResult = {
      ...baselineRun,
      caseResults: [
        {
          ...baselineRun.caseResults[0],
          contextBytes: 90,
          verifyDurationMs: 40,
        },
      ],
    };

    const comparison = compareScorecards(makeScorecard(baselineRun), makeScorecard(currentRun));

    expect(comparison.deltas.averageContextBytes).toBe(-10);
    expect(comparison.deltas.averageVerifyRuntimeMs).toBe(-10);
    expect(comparison.deltas.passRateBySurface).toEqual({
      specs: 0,
    });
  });

  it("flags threshold regressions", () => {
    const baselineRun: EvalRunResult = {
      attemptCount: 1,
      caseResults: [
        {
          attemptCount: 1,
          caseId: "one",
          changedFiles: ["spec/README.md"],
          contextBytes: 100,
          gradingResults: [],
          passed: true,
          profileId: "spec-only",
          runner: "codex",
          surface: "specs",
          title: "One",
          verifyDurationMs: 50,
          verifyPassed: true,
        },
      ],
      generatedAt: "2026-03-13T00:00:00.000Z",
      graderFalseFailureCount: 0,
      runner: "codex",
      suiteId: "foundation",
    };
    const currentRun: EvalRunResult = {
      ...baselineRun,
      caseResults: [
        {
          ...baselineRun.caseResults[0],
          passed: false,
          verifyPassed: false,
        },
      ],
      graderFalseFailureCount: 2,
    };

    const comparison = compareScorecards(makeScorecard(baselineRun), makeScorecard(currentRun));
    const violations = checkScorecardThresholds(comparison, {
      maxFirstPassSuccessRateDrop: 0.1,
      maxGraderFalseFailureCountIncrease: 1,
    });

    expect(violations).toEqual([
      {
        actual: 1,
        limit: 0.1,
        metric: "maxFirstPassSuccessRateDrop",
      },
      {
        actual: 2,
        limit: 1,
        metric: "maxGraderFalseFailureCountIncrease",
      },
    ]);
  });
});
