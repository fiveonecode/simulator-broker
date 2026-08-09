import {
  DEFAULT_COMMAND_MAX_STDERR_BYTES,
  DEFAULT_COMMAND_MAX_STDOUT_BYTES,
  DEFAULT_COMMAND_TIMEOUT_MS,
} from "./runtime.js";
import type { VerifyProfile } from "./types.js";

const DETACHED_VERIFY_LIFECYCLE_TIMEOUT_ALLOWANCE_MS = 60 * 1000;
const DETACHED_VERIFY_COMMAND_TERMINATION_GRACE_MS = 5 * 1000;
const DETACHED_VERIFY_RESULT_READ_LIMIT_FLOOR_BYTES = 8 * 1024 * 1024;

export function getDetachedVerifyTimeoutMs(profile: VerifyProfile): number | undefined {
  if (profile.commands.length === 0) {
    return profile.timeoutMs;
  }

  const terminationAllowanceMs = profile.commands.length * DETACHED_VERIFY_COMMAND_TERMINATION_GRACE_MS;
  return profile.commands.reduce(
    (sum, command) => sum + (command.timeoutMs ?? profile.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS),
    DETACHED_VERIFY_LIFECYCLE_TIMEOUT_ALLOWANCE_MS + terminationAllowanceMs,
  );
}

export function getDetachedVerifyResultReadLimitBytes(profile: VerifyProfile): number | undefined {
  if (profile.commands.length === 0) {
    return undefined;
  }

  const retainedCommandOutputBudgetBytes = profile.commands.reduce(
    (sum, command) => {
      return sum
        + (command.maxStdoutBytes ?? DEFAULT_COMMAND_MAX_STDOUT_BYTES)
        + (command.maxStderrBytes ?? DEFAULT_COMMAND_MAX_STDERR_BYTES);
    },
    0,
  );
  const jsonExpansionAllowanceBytes = retainedCommandOutputBudgetBytes * 6;
  const resultMetadataAllowanceBytes = 1_048_576 + (profile.commands.length * 131_072);

  return Math.max(
    DETACHED_VERIFY_RESULT_READ_LIMIT_FLOOR_BYTES,
    jsonExpansionAllowanceBytes + resultMetadataAllowanceBytes,
  );
}
