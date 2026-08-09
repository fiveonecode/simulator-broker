import { describe, expect, it } from "vitest";

import { checkSoakThresholds, makeSoakReport } from "../src/lib/soak.js";
import type { EvalRunResult, SoakRun } from "../src/lib/types.js";

describe("soak aggregation", () => {
  it("summarizes case pass rates and flaky cases across iterations", () => {
    const runOne: EvalRunResult = {
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
          verifyDurationMs: 10,
          verifyPassed: true,
        },
        {
          attemptCount: 1,
          caseId: "two",
          changedFiles: ["spec/README.md"],
          contextBytes: 100,
          gradingResults: [],
          passed: false,
          profileId: "spec-only",
          runner: "codex",
          surface: "specs",
          title: "Two",
          verifyDurationMs: 20,
          verifyPassed: false,
        },
      ],
      generatedAt: "2026-03-13T00:00:00.000Z",
      graderFalseFailureCount: 0,
      runner: "codex",
      suiteId: "scenario-ui",
    };
    const runTwo: EvalRunResult = {
      ...runOne,
      attemptCount: 2,
      caseResults: [
        {
          ...runOne.caseResults[0],
          attemptCount: 2,
          verifyDurationMs: 30,
        },
        {
          ...runOne.caseResults[1],
          attemptCount: 2,
          passed: true,
          verifyPassed: true,
          verifyDurationMs: 40,
        },
      ],
    };
    const soakRuns: SoakRun[] = [
      {
        artifactsDir: "one",
        failedCaseIds: ["two"],
        iteration: 1,
        passed: false,
        resultPath: "one/eval-result.json",
      },
      {
        artifactsDir: "two",
        failedCaseIds: [],
        iteration: 2,
        passed: true,
        resultPath: "two/eval-result.json",
      },
    ];

    const summary = makeSoakReport("scenario-ui", "codex", soakRuns, [runOne, runTwo]);
    const caseTwo = summary.caseSummaries.find((candidate) => candidate.caseId === "two");

    expect(summary.overallPassRate).toBe(0.5);
    expect(summary.flakyCaseCount).toBe(1);
    expect(caseTwo?.flaky).toBe(true);
    expect(caseTwo?.passRate).toBe(0.5);
    expect(caseTwo?.passedIterations).toEqual([2]);
  });

  it("records passed soak iterations independently from attempt counts", () => {
    const evalRuns: EvalRunResult[] = [5, 6].map((attemptCount) => ({
      attemptCount,
      caseResults: [
        {
          attemptCount,
          caseId: "offset",
          changedFiles: ["spec/README.md"],
          contextBytes: 100,
          gradingResults: [],
          passed: true,
          profileId: "spec-only",
          runner: "codex",
          surface: "specs",
          title: "Offset",
          verifyDurationMs: 10,
          verifyPassed: true,
        },
      ],
      generatedAt: "2026-03-13T00:00:00.000Z",
      graderFalseFailureCount: 0,
      runner: "codex",
      suiteId: "scenario-ui",
    }));
    const soakRuns: SoakRun[] = [
      {
        artifactsDir: "one",
        failedCaseIds: [],
        iteration: 1,
        passed: true,
        resultPath: "one/eval-result.json",
      },
      {
        artifactsDir: "two",
        failedCaseIds: [],
        iteration: 2,
        passed: true,
        resultPath: "two/eval-result.json",
      },
    ];

    const summary = makeSoakReport("scenario-ui", "codex", soakRuns, evalRuns);
    const caseSummary = summary.caseSummaries.find((candidate) => candidate.caseId === "offset");

    expect(caseSummary?.passedIterations).toEqual([1, 2]);
  });

  it("flags soak threshold violations", () => {
    const summary = makeSoakReport(
      "scenario-ui",
      "codex",
      [
        {
          artifactsDir: "one",
          failedCaseIds: ["two"],
          iteration: 1,
          passed: false,
          resultPath: "one/eval-result.json",
        },
      ],
      [
        {
          attemptCount: 1,
          caseResults: [
            {
              attemptCount: 1,
              caseId: "two",
              changedFiles: ["spec/README.md"],
              contextBytes: 100,
              gradingResults: [],
              passed: false,
              profileId: "spec-only",
              runner: "codex",
              surface: "specs",
              title: "Two",
              verifyDurationMs: 20,
              verifyPassed: false,
            },
          ],
          generatedAt: "2026-03-13T00:00:00.000Z",
          graderFalseFailureCount: 0,
          runner: "codex",
          suiteId: "scenario-ui",
        },
      ],
    );

    const violations = checkSoakThresholds(summary, {
      maxCaseFailureRate: 0.2,
      maxFlakyCases: 0,
    });

    expect(violations).toEqual([
      {
        actual: 1,
        limit: 0.2,
        metric: "maxCaseFailureRate",
      },
    ]);
  });
});
