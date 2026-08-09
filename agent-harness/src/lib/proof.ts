import type { VerifyProofKind } from "./types.js";

type ObligationDescriptor = {
  boundary?: string;
  requiredProofKind: VerifyProofKind;
  scenario: string;
};

type CoverageDescriptor = {
  advisory?: boolean;
  coversBoundaries: string[];
  coversScenarios: string[];
  proofKind: VerifyProofKind;
};

const PROOF_COMPATIBILITY: Record<VerifyProofKind, VerifyProofKind[]> = {
  code: ["code"],
  contract: ["contract"],
  "live-e2e": ["live-e2e", "simulated-flow", "state-render"],
  "runtime-observability": ["runtime-observability"],
  "simulated-flow": ["simulated-flow", "state-render"],
  "state-render": ["state-render"],
};

export function canProofKindSatisfy(requiredProofKind: VerifyProofKind, candidateProofKind: VerifyProofKind): boolean {
  return PROOF_COMPATIBILITY[candidateProofKind].includes(requiredProofKind);
}

export function canCoverageSatisfyObligation(
  obligation: ObligationDescriptor,
  coverage: CoverageDescriptor,
): boolean {
  if (coverage.advisory) {
    return false;
  }

  if (canProofKindSatisfy(obligation.requiredProofKind, coverage.proofKind) === false) {
    return false;
  }

  const scenarioMatches = coverage.coversScenarios.length === 0
    || coverage.coversScenarios.includes(obligation.scenario);
  if (scenarioMatches === false) {
    return false;
  }

  return obligation.boundary === undefined
    || coverage.coversBoundaries.length === 0
    || coverage.coversBoundaries.includes(obligation.boundary);
}
