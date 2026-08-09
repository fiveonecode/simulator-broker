export const BROKER_EXIT_CODES = Object.freeze({
  internal: 1,
  invalidRequest: 2,
  unavailable: 3,
  repairNeeded: 4,
  overrideRequired: 5,
  success: 0,
});

export const INTERNAL_ERROR_REASON_CODE = "internal-error";

const INVALID_REQUEST_REASON_CODES = new Set([
  "alias-purpose-mismatch",
  "capacity-unsupported-capability",
  "event-cursor-not-found",
  "inactive-lease-reference",
  "invalid-command-request",
  "invalid-config",
  "invalid-flag",
  "invalid-json",
  "invalid-lease-artifact-path",
  "lease-alias-mismatch",
  "lease-not-found",
  "missing-flag",
  "missing-host-config",
  "missing-lease-reference",
  "missing-project-file",
  "pin-not-found",
  "project-config-exists",
  "route-not-found",
  "unknown-alias",
  "unknown-command",
  "unknown-purpose",
  "unsupported-simulator-action",
]);

const UNAVAILABLE_REASON_CODES = new Set([
  "alias-busy",
  "capacity-apply-blocked",
  "containment-incomplete",
  "device-type-not-found",
  "force-override-forbidden",
  "lease-conflict",
  "no-matching-alias",
  "pin-conflict",
  "process-sampler-timeout",
  "runtime-not-found",
  "simctl-timeout",
  "service-start-timeout",
  "service-stop-timeout",
  "service-command-expired",
  "service-identity-mismatch",
  "service-unavailable",
  "reset-lock-timeout",
]);

const REPAIR_NEEDED_REASON_CODES = new Set([
  "reset-on-acquire-failed",
  "capacity-repair-required",
  "unhealthy-alias",
]);

const OVERRIDE_REQUIRED_REASON_CODES = new Set([
  "capacity-confirmation-required",
  "capacity-human-required",
  "capacity-plan-stale",
  "human-override-required",
  "missing-override-reason",
  "override-alias-mismatch",
  "override-lease-mismatch",
  "override-required",
]);

export function resolveBrokerExitCode(reasonCode, fallback = BROKER_EXIT_CODES.internal) {
  if (OVERRIDE_REQUIRED_REASON_CODES.has(reasonCode)) {
    return BROKER_EXIT_CODES.overrideRequired;
  }
  if (REPAIR_NEEDED_REASON_CODES.has(reasonCode)) {
    return BROKER_EXIT_CODES.repairNeeded;
  }
  if (UNAVAILABLE_REASON_CODES.has(reasonCode)) {
    return BROKER_EXIT_CODES.unavailable;
  }
  if (INVALID_REQUEST_REASON_CODES.has(reasonCode)) {
    return BROKER_EXIT_CODES.invalidRequest;
  }
  return fallback;
}

export function resolveBrokerHttpStatus(reasonCode, fallback = 500) {
  if (reasonCode === "route-not-found") {
    return 404;
  }
  if (OVERRIDE_REQUIRED_REASON_CODES.has(reasonCode)) {
    return 412;
  }
  if (REPAIR_NEEDED_REASON_CODES.has(reasonCode)) {
    return 423;
  }
  if (UNAVAILABLE_REASON_CODES.has(reasonCode)) {
    return 409;
  }
  if (INVALID_REQUEST_REASON_CODES.has(reasonCode)) {
    return 400;
  }
  return fallback;
}
