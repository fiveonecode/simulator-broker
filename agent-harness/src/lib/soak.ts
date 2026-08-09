// -------------------------------------------------------------------------- //
//                                    SOAK                                    //
// -------------------------------------------------------------------------- //

import dayjs from "dayjs";

import type {
  EvalCaseResult,
  EvalRunResult,
  SoakCaseSummary,
  SoakProfileSummary,
  SoakRun,
  SoakRunResult,
  SoakThresholds,
  SoakViolation,
} from "./types.js";

type SoakCaseResult = EvalCaseResult & {
  soakIteration: number;
};

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function makeCaseSummary(caseId: string, results: SoakCaseResult[]): SoakCaseSummary {
  const [firstResult] = results;
  const passCount = results.filter((result) => result.passed).length;
  const failCount = results.length - passCount;
  const passedIterations = results
    .filter((result) => result.passed)
    .map((result) => result.soakIteration)
    .sort((left, right) => left - right);

  return {
    averageVerifyRuntimeMs: average(results.map((result) => result.verifyDurationMs)),
    caseId,
    failCount,
    failureRate: results.length === 0 ? 0 : failCount / results.length,
    flaky: passCount > 0 && failCount > 0,
    passedIterations,
    passCount,
    passRate: results.length === 0 ? 0 : passCount / results.length,
    profileId: firstResult?.profileId ?? "unknown",
    runner: firstResult?.runner ?? "unknown",
    surface: firstResult?.surface ?? "unknown",
    title: firstResult?.title ?? caseId,
  };
}

function makeProfileSummary(profileId: string, caseSummaries: SoakCaseSummary[]): SoakProfileSummary {
  const passCount = caseSummaries.reduce((sum, summary) => sum + summary.passCount, 0);
  const failCount = caseSummaries.reduce((sum, summary) => sum + summary.failCount, 0);
  const totalRuns = passCount + failCount;

  return {
    averageVerifyRuntimeMs: average(caseSummaries.map((summary) => summary.averageVerifyRuntimeMs)),
    failCount,
    failureRate: totalRuns === 0 ? 0 : failCount / totalRuns,
    flakyCaseCount: caseSummaries.filter((summary) => summary.flaky).length,
    passCount,
    passRate: totalRuns === 0 ? 0 : passCount / totalRuns,
    profileId,
  };
}

export function makeSoakReport(
  suiteId: string,
  runner: string,
  runs: SoakRun[],
  evalRuns: EvalRunResult[],
): SoakRunResult {
  const caseResults = evalRuns.flatMap((run, index) =>
    run.caseResults.map((result) => ({
      ...result,
      soakIteration: runs[index]?.iteration ?? index + 1,
    })),
  );
  const caseIds = [...new Set(caseResults.map((result) => result.caseId))].sort();
  const caseSummaries = caseIds.map((caseId) =>
    makeCaseSummary(
      caseId,
      caseResults
        .filter((result) => result.caseId === caseId)
        .sort((left, right) => left.soakIteration - right.soakIteration),
    ),
  );
  const profileSummaries = [...new Set(caseSummaries.map((summary) => summary.profileId))]
    .sort()
    .map((profileId) => makeProfileSummary(profileId, caseSummaries.filter((summary) => summary.profileId === profileId)));
  const passedRuns = runs.filter((run) => run.passed).length;

  return {
    caseSummaries,
    flakyCaseCount: caseSummaries.filter((summary) => summary.flaky).length,
    generatedAt: dayjs().toISOString(),
    iterationCount: runs.length,
    overallPassRate: runs.length === 0 ? 0 : passedRuns / runs.length,
    profileSummaries,
    runner,
    runs,
    suiteId,
  };
}

export function checkSoakThresholds(result: SoakRunResult, thresholds: SoakThresholds): SoakViolation[] {
  const violations: SoakViolation[] = [];
  const maxObservedFailureRate = result.caseSummaries.reduce((currentMax, summary) => Math.max(currentMax, summary.failureRate), 0);

  if (
    thresholds.maxCaseFailureRate !== undefined &&
    maxObservedFailureRate > thresholds.maxCaseFailureRate
  ) {
    violations.push({
      actual: maxObservedFailureRate,
      limit: thresholds.maxCaseFailureRate,
      metric: "maxCaseFailureRate",
    });
  }

  if (
    thresholds.maxFlakyCases !== undefined &&
    result.flakyCaseCount > thresholds.maxFlakyCases
  ) {
    violations.push({
      actual: result.flakyCaseCount,
      limit: thresholds.maxFlakyCases,
      metric: "maxFlakyCases",
    });
  }

  return violations;
}
