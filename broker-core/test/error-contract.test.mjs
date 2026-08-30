import test from "node:test";
import assert from "node:assert/strict";

import {
  BROKER_EXIT_CODES,
  INTERNAL_ERROR_REASON_CODE,
  resolveBrokerExitCode,
  resolveBrokerHttpStatus,
} from "../error-contract.mjs";
import { BrokerError } from "../index.mjs";

test("broker error contract maps reason codes to stable exit codes", () => {
  assert.equal(resolveBrokerExitCode("unknown-command"), BROKER_EXIT_CODES.invalidRequest);
  assert.equal(resolveBrokerExitCode("capacity-unsupported-capability"), BROKER_EXIT_CODES.invalidRequest);
  assert.equal(resolveBrokerExitCode("invalid-lease-artifact-path"), BROKER_EXIT_CODES.invalidRequest);
  assert.equal(resolveBrokerExitCode("no-matching-alias"), BROKER_EXIT_CODES.unavailable);
  assert.equal(resolveBrokerExitCode("capacity-apply-blocked"), BROKER_EXIT_CODES.unavailable);
  assert.equal(resolveBrokerExitCode("process-sampler-timeout"), BROKER_EXIT_CODES.unavailable);
  assert.equal(resolveBrokerExitCode("simctl-timeout"), BROKER_EXIT_CODES.unavailable);
  assert.equal(resolveBrokerExitCode("force-override-forbidden"), BROKER_EXIT_CODES.unavailable);
  assert.equal(resolveBrokerExitCode("service-command-expired"), BROKER_EXIT_CODES.unavailable);
  assert.equal(resolveBrokerExitCode("service-identity-mismatch"), BROKER_EXIT_CODES.unavailable);
  assert.equal(resolveBrokerExitCode("service-runtime-incompatible"), BROKER_EXIT_CODES.unavailable);
  assert.equal(resolveBrokerExitCode("service-stop-timeout"), BROKER_EXIT_CODES.unavailable);
  assert.equal(resolveBrokerExitCode("project-in-use"), BROKER_EXIT_CODES.unavailable);
  assert.equal(resolveBrokerExitCode("unhealthy-alias"), BROKER_EXIT_CODES.repairNeeded);
  assert.equal(resolveBrokerExitCode("capacity-repair-required"), BROKER_EXIT_CODES.repairNeeded);
  assert.equal(resolveBrokerExitCode("human-override-required"), BROKER_EXIT_CODES.overrideRequired);
  assert.equal(resolveBrokerExitCode("capacity-plan-stale"), BROKER_EXIT_CODES.overrideRequired);
  assert.equal(resolveBrokerExitCode(INTERNAL_ERROR_REASON_CODE), BROKER_EXIT_CODES.internal);
});

test("broker error payloads always include the resolved exit code", () => {
  const brokerError = new BrokerError("Alias is unhealthy.", {
    reasonCode: "unhealthy-alias",
  });

  assert.equal(brokerError.exitCode, BROKER_EXIT_CODES.repairNeeded);
  assert.equal(brokerError.payload.exitCode, BROKER_EXIT_CODES.repairNeeded);
});

test("service-facing HTTP status mapping stays aligned with the exit code contract", () => {
  assert.equal(resolveBrokerHttpStatus("route-not-found"), 404);
  assert.equal(resolveBrokerHttpStatus("unknown-command"), 400);
  assert.equal(resolveBrokerHttpStatus("invalid-lease-artifact-path"), 400);
  assert.equal(resolveBrokerHttpStatus("no-matching-alias"), 409);
  assert.equal(resolveBrokerHttpStatus("capacity-apply-blocked"), 409);
  assert.equal(resolveBrokerHttpStatus("process-sampler-timeout"), 409);
  assert.equal(resolveBrokerHttpStatus("simctl-timeout"), 409);
  assert.equal(resolveBrokerHttpStatus("force-override-forbidden"), 409);
  assert.equal(resolveBrokerHttpStatus("service-command-expired"), 409);
  assert.equal(resolveBrokerHttpStatus("service-identity-mismatch"), 409);
  assert.equal(resolveBrokerHttpStatus("service-stop-timeout"), 409);
  assert.equal(resolveBrokerHttpStatus("project-in-use"), 409);
  assert.equal(resolveBrokerHttpStatus("unhealthy-alias"), 423);
  assert.equal(resolveBrokerHttpStatus("capacity-repair-required"), 423);
  assert.equal(resolveBrokerHttpStatus("human-override-required"), 412);
  assert.equal(resolveBrokerHttpStatus("capacity-plan-stale"), 412);
  assert.equal(resolveBrokerHttpStatus(INTERNAL_ERROR_REASON_CODE), 500);
});
