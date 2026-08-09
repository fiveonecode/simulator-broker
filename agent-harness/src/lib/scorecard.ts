// -------------------------------------------------------------------------- //
//                                  IMPORTS                                   //
// -------------------------------------------------------------------------- //

import dayjs from "dayjs";

import type {
  EvalRunResult,
  Scorecard,
  ScorecardComparison,
  ScorecardThresholds,
  ScorecardViolation,
} from "./types.js";

// -------------------------------------------------------------------------- //
//                                 SCORECARD                                  //
// -------------------------------------------------------------------------- //

export function makeScorecard(evalRunResult: EvalRunResult): Scorecard {
  const caseCount = evalRunResult.caseResults.length;
  const passRateBySurface = Object.fromEntries(
    [...new Set(evalRunResult.caseResults.map((result) => result.surface))]
      .sort()
      .map((surface) => {
        const relevantResults = evalRunResult.caseResults.filter((result) => result.surface === surface);
        const passCount = relevantResults.filter((result) => result.passed).length;
        return [surface, relevantResults.length === 0 ? 0 : passCount / relevantResults.length];
      }),
  );

  return {
    averageContextBytes: caseCount === 0 ? 0 : evalRunResult.caseResults.reduce((sum, result) => sum + result.contextBytes, 0) / caseCount,
    averageVerifyRuntimeMs: caseCount === 0 ? 0 : evalRunResult.caseResults.reduce((sum, result) => sum + result.verifyDurationMs, 0) / caseCount,
    caseCount,
    firstPassSuccessRate: caseCount === 0 ? 0 : evalRunResult.caseResults.filter((result) => result.passed && result.attemptCount === 1).length / caseCount,
    generatedAt: dayjs().toISOString(),
    graderFalseFailureCount: evalRunResult.graderFalseFailureCount,
    passRateBySurface,
    suiteId: evalRunResult.suiteId,
    withinThreeAttemptsRate: caseCount === 0 ? 0 : evalRunResult.caseResults.filter((result) => result.passed && result.attemptCount <= 3).length / caseCount,
  };
}

export function compareScorecards(baseline: Scorecard, current: Scorecard): ScorecardComparison {
  const surfaces = [...new Set([
    ...Object.keys(baseline.passRateBySurface),
    ...Object.keys(current.passRateBySurface),
  ])].sort();

  return {
    baseline,
    current,
    deltas: {
      averageContextBytes: current.averageContextBytes - baseline.averageContextBytes,
      averageVerifyRuntimeMs: current.averageVerifyRuntimeMs - baseline.averageVerifyRuntimeMs,
      firstPassSuccessRate: current.firstPassSuccessRate - baseline.firstPassSuccessRate,
      graderFalseFailureCount: current.graderFalseFailureCount - baseline.graderFalseFailureCount,
      passRateBySurface: Object.fromEntries(
        surfaces.map((surface) => [
          surface,
          (current.passRateBySurface[surface] ?? 0) - (baseline.passRateBySurface[surface] ?? 0),
        ]),
      ),
      withinThreeAttemptsRate: current.withinThreeAttemptsRate - baseline.withinThreeAttemptsRate,
    },
  };
}

export function checkScorecardThresholds(
  comparison: ScorecardComparison,
  thresholds: ScorecardThresholds,
): ScorecardViolation[] {
  const violations: ScorecardViolation[] = [];

  if (
    thresholds.maxAverageContextBytesIncrease !== undefined &&
    comparison.deltas.averageContextBytes > thresholds.maxAverageContextBytesIncrease
  ) {
    violations.push({
      actual: comparison.deltas.averageContextBytes,
      limit: thresholds.maxAverageContextBytesIncrease,
      metric: "maxAverageContextBytesIncrease",
    });
  }

  if (
    thresholds.maxAverageVerifyRuntimeMsIncrease !== undefined &&
    comparison.deltas.averageVerifyRuntimeMs > thresholds.maxAverageVerifyRuntimeMsIncrease
  ) {
    violations.push({
      actual: comparison.deltas.averageVerifyRuntimeMs,
      limit: thresholds.maxAverageVerifyRuntimeMsIncrease,
      metric: "maxAverageVerifyRuntimeMsIncrease",
    });
  }

  if (
    thresholds.maxFirstPassSuccessRateDrop !== undefined &&
    -comparison.deltas.firstPassSuccessRate > thresholds.maxFirstPassSuccessRateDrop
  ) {
    violations.push({
      actual: -comparison.deltas.firstPassSuccessRate,
      limit: thresholds.maxFirstPassSuccessRateDrop,
      metric: "maxFirstPassSuccessRateDrop",
    });
  }

  if (
    thresholds.maxWithinThreeAttemptsRateDrop !== undefined &&
    -comparison.deltas.withinThreeAttemptsRate > thresholds.maxWithinThreeAttemptsRateDrop
  ) {
    violations.push({
      actual: -comparison.deltas.withinThreeAttemptsRate,
      limit: thresholds.maxWithinThreeAttemptsRateDrop,
      metric: "maxWithinThreeAttemptsRateDrop",
    });
  }

  if (
    thresholds.maxGraderFalseFailureCountIncrease !== undefined &&
    comparison.deltas.graderFalseFailureCount > thresholds.maxGraderFalseFailureCountIncrease
  ) {
    violations.push({
      actual: comparison.deltas.graderFalseFailureCount,
      limit: thresholds.maxGraderFalseFailureCountIncrease,
      metric: "maxGraderFalseFailureCountIncrease",
    });
  }

  return violations;
}
