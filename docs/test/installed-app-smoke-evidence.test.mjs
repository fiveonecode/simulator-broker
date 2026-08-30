import assert from "node:assert/strict";
import test from "node:test";

import {
  InstalledAppSmokeEvidenceError,
  verifyInstalledAppSmokeEvidence,
} from "../../scripts/installed_app_smoke_evidence.mjs";

const expected = {
  expectedProcessID: 4242,
  expectedProcessImagePath: "/Applications/Simulator Broker.app/Contents/MacOS/SimulatorBrokerApp",
  expectedStateRoot: "/tmp/public-smoke/state",
  minimumGeneratedAt: "2026-08-30T01:02:03.456Z",
};

function preamble(processImagePath = expected.expectedProcessImagePath) {
  return `Filtering the log data using "subsystem == "dev.codex.simulator-broker-app" AND (category == "AppLifecycle" OR category == "Refresh") AND processImagePath == "${processImagePath}""`;
}

function event(overrides = {}) {
  return {
    timestamp: "2026-08-30 01:02:04.000000+0000",
    subsystem: "dev.codex.simulator-broker-app",
    category: "AppLifecycle",
    processImagePath: expected.expectedProcessImagePath,
    processID: expected.expectedProcessID,
    eventMessage: `App launch prepared stateRoot=${expected.expectedStateRoot}`,
    ...overrides,
  };
}

function passingLog() {
  return [
    preamble(),
    JSON.stringify(event()),
    JSON.stringify(event({
      category: "Refresh",
      timestamp: "2026-08-30 01:02:04.100000+0000",
      eventMessage: `Refresh succeeded mode=manual snapshotGeneratedAt=${expected.minimumGeneratedAt}`,
    })),
    JSON.stringify({ count: 2, finished: 1 }),
    "",
  ].join("\n");
}

test("accepts the known preamble, NDJSON events, and count sentinel", () => {
  const proof = verifyInstalledAppSmokeEvidence({ logText: passingLog(), ...expected });

  assert.equal(proof.snapshotDecodeVerified, true);
  assert.equal(proof.launchPreparedVerified, true);
  assert.equal(proof.refreshVerified, true);
  assert.equal(proof.streamPreambleSeen, true);
  assert.equal(proof.countSentinelSeen, true);
  assert.equal(proof.processID, expected.expectedProcessID);
  assert.equal(proof.processImagePath, expected.expectedProcessImagePath);
  assert.equal(proof.stateRoot, expected.expectedStateRoot);
  assert.equal(proof.preparedSnapshotGeneratedAt, expected.minimumGeneratedAt);
  assert.equal(proof.snapshotGeneratedAt, expected.minimumGeneratedAt);
});

test("accepts a newer canonical snapshot generation from the same process", () => {
  const newerGeneratedAt = "2026-08-30T01:02:04.000Z";
  const proof = verifyInstalledAppSmokeEvidence({
    logText: passingLog().replace(expected.minimumGeneratedAt, newerGeneratedAt),
    ...expected,
  });

  assert.equal(proof.snapshotDecodeVerified, true);
  assert.equal(proof.preparedSnapshotGeneratedAt, expected.minimumGeneratedAt);
  assert.equal(proof.snapshotGeneratedAt, newerGeneratedAt);
});

test("rejects evidence from the wrong process ID", () => {
  const proof = verifyInstalledAppSmokeEvidence({
    logText: passingLog(),
    ...expected,
    expectedProcessID: expected.expectedProcessID + 1,
  });

  assert.equal(proof.snapshotDecodeVerified, false);
  assert.deepEqual(proof.missingEvidence, ["launch-prepared-event", "manual-refresh-success-event"]);
});

test("rejects evidence from the wrong canonical executable path", () => {
  const wrongPath = "/Applications/Other.app/Contents/MacOS/SimulatorBrokerApp";
  const proof = verifyInstalledAppSmokeEvidence({
    logText: passingLog().replaceAll(expected.expectedProcessImagePath, wrongPath),
    ...expected,
  });

  assert.equal(proof.snapshotDecodeVerified, false);
  assert.deepEqual(proof.missingEvidence, ["stream-preamble", "launch-prepared-event", "manual-refresh-success-event"]);
});

test("rejects a launch event for the wrong state root", () => {
  const logText = passingLog().replace(
    `App launch prepared stateRoot=${expected.expectedStateRoot}`,
    "App launch prepared stateRoot=/tmp/public-smoke/wrong-state",
  );
  const proof = verifyInstalledAppSmokeEvidence({ logText, ...expected });

  assert.equal(proof.snapshotDecodeVerified, false);
  assert.equal(proof.launchPreparedVerified, false);
  assert.equal(proof.refreshVerified, true);
});

test("rejects an earlier, invalid, or none generatedAt value", () => {
  const earlierGeneratedAtProof = verifyInstalledAppSmokeEvidence({
    logText: passingLog(),
    ...expected,
    minimumGeneratedAt: "2026-08-30T09:09:09.000Z",
  });
  const noneEventProof = verifyInstalledAppSmokeEvidence({
    logText: passingLog().replace(expected.minimumGeneratedAt, "none"),
    ...expected,
  });
  const invalidEventProof = verifyInstalledAppSmokeEvidence({
    logText: passingLog().replace(expected.minimumGeneratedAt, "not-a-date"),
    ...expected,
  });

  assert.equal(earlierGeneratedAtProof.snapshotDecodeVerified, false);
  assert.equal(noneEventProof.snapshotDecodeVerified, false);
  assert.equal(invalidEventProof.snapshotDecodeVerified, false);
  assert.throws(
    () => verifyInstalledAppSmokeEvidence({
      logText: passingLog(),
      ...expected,
      minimumGeneratedAt: "none",
    }),
    (error) => error instanceof InstalledAppSmokeEvidenceError && error.kind === "invalid-expectation",
  );
});

test("rejects launch and refresh evidence split across process IDs", () => {
  const splitLog = passingLog().replace(
    `"category":"Refresh","processImagePath":"${expected.expectedProcessImagePath}","processID":${expected.expectedProcessID}`,
    `"category":"Refresh","processImagePath":"${expected.expectedProcessImagePath}","processID":5151`,
  );
  const proof = verifyInstalledAppSmokeEvidence({ logText: splitLog, ...expected });

  assert.equal(proof.launchPreparedVerified, true);
  assert.equal(proof.refreshVerified, false);
  assert.equal(proof.snapshotDecodeVerified, false);
});

test("returns incomplete proof when no matching events exist", () => {
  const logText = `${preamble()}\n${JSON.stringify({ count: 0, finished: 1 })}\n`;
  const proof = verifyInstalledAppSmokeEvidence({ logText, ...expected });

  assert.equal(proof.snapshotDecodeVerified, false);
  assert.deepEqual(proof.missingEvidence, ["launch-prepared-event", "manual-refresh-success-event"]);
});

test("rejects a malformed complete record", () => {
  assert.throws(
    () => verifyInstalledAppSmokeEvidence({
      logText: `${preamble()}\n{malformed}\n`,
      ...expected,
    }),
    (error) => error instanceof InstalledAppSmokeEvidenceError && error.kind === "malformed-log",
  );
});

test("ignores only an unterminated final line while polling", () => {
  const completeLines = [preamble(), JSON.stringify(event())];
  const refreshLine = JSON.stringify(event({
    category: "Refresh",
    eventMessage: `Refresh succeeded mode=manual snapshotGeneratedAt=${expected.minimumGeneratedAt}`,
  }));
  const pollingProof = verifyInstalledAppSmokeEvidence({
    logText: `${completeLines.join("\n")}\n${refreshLine.slice(0, -4)}`,
    ...expected,
    allowIncompleteFinalLine: true,
  });

  assert.equal(pollingProof.snapshotDecodeVerified, false);
  assert.equal(pollingProof.ignoredIncompleteFinalLine, true);
  assert.throws(
    () => verifyInstalledAppSmokeEvidence({
      logText: `${completeLines.join("\n")}\n${refreshLine.slice(0, -4)}`,
      ...expected,
    }),
    (error) => error instanceof InstalledAppSmokeEvidenceError && error.kind === "malformed-log",
  );
});
