#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const appLogSubsystem = "dev.codex.simulator-broker-app";
export const appLaunchCategory = "AppLifecycle";
export const appRefreshCategory = "Refresh";

export class InstalledAppSmokeEvidenceError extends Error {
  constructor(message, kind = "malformed-log") {
    super(message);
    this.name = "InstalledAppSmokeEvidenceError";
    this.kind = kind;
  }
}

function assertExpectedString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new InstalledAppSmokeEvidenceError(`${label} must be a non-empty string.`, "invalid-expectation");
  }
}

function canonicalISOTimestampMilliseconds(value) {
  if (typeof value !== "string") {
    return null;
  }
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (match === null) {
    return null;
  }
  const normalized = `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`;
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== normalized) {
    return null;
  }
  return milliseconds;
}

function isKnownStreamPreamble(line) {
  return line.startsWith("Filtering the log data using ")
    && line.includes(`subsystem == "${appLogSubsystem}"`)
    && line.includes(`category == "${appLaunchCategory}"`)
    && line.includes(`category == "${appRefreshCategory}"`)
    && line.includes("processImagePath == ");
}

function isCountSentinel(record) {
  return record !== null
    && typeof record === "object"
    && Number.isInteger(record.count)
    && record.count >= 0
    && record.finished === 1;
}

function assertLogRecord(record, lineNumber) {
  const valid = record !== null
    && typeof record === "object"
    && typeof record.subsystem === "string"
    && typeof record.category === "string"
    && typeof record.processImagePath === "string"
    && Number.isInteger(record.processID)
    && typeof record.eventMessage === "string";

  if (!valid) {
    throw new InstalledAppSmokeEvidenceError(
      `Unified-log line ${lineNumber} is neither an event record nor a count sentinel.`,
    );
  }
}

function parseLogText(logText, expectedProcessImagePath, allowIncompleteFinalLine) {
  if (typeof logText !== "string") {
    throw new InstalledAppSmokeEvidenceError("logText must be a string.", "invalid-expectation");
  }

  const terminated = logText.endsWith("\n");
  const lines = logText.split("\n");
  if (terminated) {
    lines.pop();
  }

  let ignoredIncompleteFinalLine = false;
  if (!terminated && lines.length > 0 && allowIncompleteFinalLine) {
    lines.pop();
    ignoredIncompleteFinalLine = true;
  }

  const records = [];
  let preambleSeen = false;
  let countSentinelSeen = false;

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index].endsWith("\r") ? lines[index].slice(0, -1) : lines[index];
    if (line.length === 0) {
      throw new InstalledAppSmokeEvidenceError(`Unified-log line ${lineNumber} is empty.`);
    }
    if (isKnownStreamPreamble(line)) {
      if (line.includes(`processImagePath == "${expectedProcessImagePath}"`)) {
        preambleSeen = true;
      }
      continue;
    }

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw new InstalledAppSmokeEvidenceError(`Unified-log line ${lineNumber} is malformed JSON.`);
    }

    if (isCountSentinel(record)) {
      countSentinelSeen = true;
      continue;
    }
    assertLogRecord(record, lineNumber);
    records.push(record);
  }

  return {
    countSentinelSeen,
    ignoredIncompleteFinalLine,
    preambleSeen,
    records,
  };
}

export function verifyInstalledAppSmokeEvidence({
  logText,
  expectedProcessID,
  expectedProcessImagePath,
  expectedStateRoot,
  minimumGeneratedAt,
  allowIncompleteFinalLine = false,
}) {
  if (!Number.isInteger(expectedProcessID) || expectedProcessID <= 0) {
    throw new InstalledAppSmokeEvidenceError(
      "expectedProcessID must be a positive integer.",
      "invalid-expectation",
    );
  }
  assertExpectedString(expectedProcessImagePath, "expectedProcessImagePath");
  assertExpectedString(expectedStateRoot, "expectedStateRoot");
  assertExpectedString(minimumGeneratedAt, "minimumGeneratedAt");
  if (!path.isAbsolute(expectedProcessImagePath) || !path.isAbsolute(expectedStateRoot)) {
    throw new InstalledAppSmokeEvidenceError(
      "Expected executable and state-root paths must be absolute.",
      "invalid-expectation",
    );
  }
  const minimumGeneratedAtMilliseconds = canonicalISOTimestampMilliseconds(minimumGeneratedAt);
  if (minimumGeneratedAtMilliseconds === null) {
    throw new InstalledAppSmokeEvidenceError(
      "minimumGeneratedAt must be a canonical ISO-8601 UTC timestamp, not none.",
      "invalid-expectation",
    );
  }

  const parsed = parseLogText(logText, expectedProcessImagePath, allowIncompleteFinalLine);
  const matchingRecords = parsed.records.filter((record) => (
    record.subsystem === appLogSubsystem
      && record.processID === expectedProcessID
      && record.processImagePath === expectedProcessImagePath
  ));
  const expectedLaunchMessage = `App launch prepared stateRoot=${expectedStateRoot}`;
  const launchRecord = matchingRecords.find((record) => (
    record.category === appLaunchCategory && record.eventMessage === expectedLaunchMessage
  ));
  const refreshMessagePrefix = "Refresh succeeded mode=manual snapshotGeneratedAt=";
  const observedManualRefreshGeneratedAtValues = matchingRecords
    .filter((record) => record.category === appRefreshCategory && record.eventMessage.startsWith(refreshMessagePrefix))
    .map((record) => record.eventMessage.slice(refreshMessagePrefix.length));
  const refreshRecord = matchingRecords.find((record) => {
    if (record.category !== appRefreshCategory || !record.eventMessage.startsWith(refreshMessagePrefix)) {
      return false;
    }
    const observedGeneratedAt = record.eventMessage.slice(refreshMessagePrefix.length);
    const observedMilliseconds = canonicalISOTimestampMilliseconds(observedGeneratedAt);
    return observedMilliseconds !== null && observedMilliseconds >= minimumGeneratedAtMilliseconds;
  });
  const observedRefreshGeneratedAt = refreshRecord === undefined
    ? null
    : refreshRecord.eventMessage.slice(refreshMessagePrefix.length);
  const launchPreparedVerified = launchRecord !== undefined;
  const refreshVerified = refreshRecord !== undefined;
  const snapshotDecodeVerified = launchPreparedVerified && refreshVerified;
  const missingEvidence = [];
  if (!parsed.preambleSeen) {
    missingEvidence.push("stream-preamble");
  }
  if (!launchPreparedVerified) {
    missingEvidence.push("launch-prepared-event");
  }
  if (!refreshVerified) {
    missingEvidence.push("manual-refresh-success-event");
  }

  return {
    schemaVersion: 1,
    snapshotDecodeVerified: snapshotDecodeVerified && parsed.preambleSeen,
    refreshVerified: refreshVerified && parsed.preambleSeen,
    launchPreparedVerified: launchPreparedVerified && parsed.preambleSeen,
    processID: expectedProcessID,
    processImagePath: expectedProcessImagePath,
    stateRoot: expectedStateRoot,
    preparedSnapshotGeneratedAt: minimumGeneratedAt,
    snapshotGeneratedAt: observedRefreshGeneratedAt,
    observedManualRefreshGeneratedAtValues,
    launchPreparedTimestamp: typeof launchRecord?.timestamp === "string" ? launchRecord.timestamp : null,
    refreshSucceededTimestamp: typeof refreshRecord?.timestamp === "string" ? refreshRecord.timestamp : null,
    parsedEventCount: parsed.records.length,
    matchingProcessEventCount: matchingRecords.length,
    streamPreambleSeen: parsed.preambleSeen,
    countSentinelSeen: parsed.countSentinelSeen,
    ignoredIncompleteFinalLine: parsed.ignoredIncompleteFinalLine,
    missingEvidence,
  };
}

function parseCommandLine(argv) {
  const values = new Map();
  let allowIncompleteFinalLine = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-incomplete-final-line") {
      allowIncompleteFinalLine = true;
      continue;
    }
    if (!argument.startsWith("--") || index + 1 >= argv.length) {
      throw new InstalledAppSmokeEvidenceError(`Unknown or incomplete argument: ${argument}`, "invalid-expectation");
    }
    values.set(argument, argv[index + 1]);
    index += 1;
  }

  for (const name of ["--log", "--process-id", "--process-image-path", "--state-root", "--minimum-generated-at"]) {
    if (!values.has(name)) {
      throw new InstalledAppSmokeEvidenceError(`Missing required argument: ${name}`, "invalid-expectation");
    }
  }

  return {
    allowIncompleteFinalLine,
    minimumGeneratedAt: values.get("--minimum-generated-at"),
    expectedProcessID: Number(values.get("--process-id")),
    expectedProcessImagePath: values.get("--process-image-path"),
    expectedStateRoot: values.get("--state-root"),
    logPath: values.get("--log"),
  };
}

function runCommandLine() {
  try {
    const options = parseCommandLine(process.argv.slice(2));
    const proof = verifyInstalledAppSmokeEvidence({
      ...options,
      logText: fs.readFileSync(options.logPath, "utf8"),
    });
    process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
    if (!proof.snapshotDecodeVerified) {
      process.exitCode = 2;
    }
  } catch (error) {
    const kind = error instanceof InstalledAppSmokeEvidenceError ? error.kind : "io-error";
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ kind, message })}\n`);
    process.exitCode = 3;
  }
}

const invokedPath = process.argv[1] === undefined ? "" : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCommandLine();
}
