import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { scanPublicSurface } from "../public-surface.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "simbroker-public-surface-test-"));
}

test("public surface scan reports a local home path without echoing the matched value", () => {
  const root = makeTempDir();
  const localHome = path.join(root, "private-home");
  fs.writeFileSync(path.join(root, "README.md"), `machine path: ${localHome}/state\n`);

  const report = scanPublicSurface({
    files: ["README.md"],
    homePath: localHome,
    root,
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.issues, [{
    line: 1,
    path: "README.md",
    rule: "local-home-path",
  }]);
  assert.equal(JSON.stringify(report).includes(localHome), false);
});

test("public surface scan matches complete home paths instead of raw prefixes", () => {
  const root = makeTempDir();
  const rootHome = path.posix.join(path.posix.sep, "root");
  const escapedRootHome = rootHome.replaceAll(path.posix.sep, String.raw`\/`);
  fs.writeFileSync(path.join(root, "README.md"), [
    "route: composition/root-layout",
    `pattern: ${escapedRootHome}${String.raw`\/`}`,
    `actual: ${rootHome}/.simulator-broker/state`,
    "",
  ].join("\n"));

  const report = scanPublicSurface({
    files: ["README.md"],
    homePath: rootHome,
    root,
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.issues, [{
    line: 3,
    path: "README.md",
    rule: "local-home-path",
  }]);
});

test("public surface scan treats sentence-ending periods as home path boundaries", () => {
  const root = makeTempDir();
  const localHome = path.posix.join(path.posix.sep, "Users", "alice");
  fs.writeFileSync(path.join(root, "README.md"), `Home: ${localHome}.\n`);

  const report = scanPublicSurface({
    files: ["README.md"],
    homePath: localHome,
    root,
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.issues, [{
    line: 1,
    path: "README.md",
    rule: "local-home-path",
  }]);
});

test("public surface scan ignores home path prefixes in dot-suffixed path fragments", () => {
  const root = makeTempDir();
  const localHome = path.posix.join(path.posix.sep, "Users", "alice");
  fs.writeFileSync(path.join(root, "README.md"), `Config: ${localHome}.config\n`);

  const report = scanPublicSurface({
    files: ["README.md"],
    homePath: localHome,
    root,
  });

  assert.equal(report.ok, true);
  assert.deepEqual(report.issues, []);
});

test("public surface scan detects JSON slash-escaped home paths", () => {
  const root = makeTempDir();
  const localHome = path.posix.join(path.posix.sep, "Users", "alice");
  const escapedHome = localHome.replaceAll(path.posix.sep, String.raw`\/`);
  fs.writeFileSync(path.join(root, "snapshot.json"), `{"projectPath":"${escapedHome}${String.raw`\/`}project"}\n`);

  const report = scanPublicSurface({
    files: ["snapshot.json"],
    homePath: localHome,
    root,
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.issues, [{
    line: 1,
    path: "snapshot.json",
    rule: "local-home-path",
  }]);
});

test("public surface scan detects home paths inside file URLs", () => {
  const root = makeTempDir();
  const localHome = path.join(root, "private-home");
  fs.writeFileSync(path.join(root, "README.md"), [
    `diagnostic: file://${localHome}/project/file.swift`,
    `route: composition${localHome}/layout`,
    "",
  ].join("\n"));

  const report = scanPublicSurface({
    files: ["README.md"],
    homePath: localHome,
    root,
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.issues, [{
    line: 1,
    path: "README.md",
    rule: "local-home-path",
  }]);
});

test("public surface scan treats colon-delimited labels as home path boundaries", () => {
  const root = makeTempDir();
  const localHome = path.join(root, "private-home");
  fs.writeFileSync(path.join(root, "diagnostics.log"), [
    `cwd:${localHome}/project`,
    `route: composition${localHome}/layout`,
    "",
  ].join("\n"));

  const report = scanPublicSurface({
    files: ["diagnostics.log"],
    homePath: localHome,
    root,
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.issues, [{
    line: 1,
    path: "diagnostics.log",
    rule: "local-home-path",
  }]);
  assert.equal(JSON.stringify(report).includes(localHome), false);
});

test("public surface scan applies an ignored operator denylist without echoing its values", () => {
  const root = makeTempDir();
  const privateMarker = "operator-private-alias";
  fs.writeFileSync(path.join(root, ".public-safety.local"), `# local only\n${privateMarker}\n`);
  fs.writeFileSync(path.join(root, "notes.md"), `do not publish ${privateMarker}\n`);

  const report = scanPublicSurface({
    denylistPath: path.join(root, ".public-safety.local"),
    files: ["notes.md"],
    homePath: "",
    root,
  });

  assert.equal(report.ok, false);
  assert.equal(report.issues[0].rule, "local-denylist-rule-2");
  assert.equal(JSON.stringify(report).includes(privateMarker), false);
});

test("public surface scan detects JSON slash-escaped local denylist values", () => {
  const root = makeTempDir();
  const privateMarker = "https://private.example.local/task/123";
  const escapedMarker = privateMarker.replaceAll("/", String.raw`\/`);
  fs.writeFileSync(path.join(root, ".public-safety.local"), `# local only\n${privateMarker}\n`);
  fs.writeFileSync(path.join(root, "snapshot.json"), `{"taskUrl":"${escapedMarker}"}\n`);

  const report = scanPublicSurface({
    denylistPath: path.join(root, ".public-safety.local"),
    files: ["snapshot.json"],
    homePath: "",
    root,
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.issues, [{
    line: 1,
    path: "snapshot.json",
    rule: "local-denylist-rule-2",
  }]);
  assert.equal(JSON.stringify(report).includes(privateMarker), false);
  assert.equal(JSON.stringify(report).includes(escapedMarker), false);
});

test("public surface scan applies local denylist values to relative filenames without echoing them", () => {
  const root = makeTempDir();
  const privateMarker = "operator-private-alias";
  const privateFilename = `${privateMarker}-notes.md`;
  fs.writeFileSync(path.join(root, ".public-safety.local"), `# local only\n${privateMarker}\n`);
  fs.writeFileSync(path.join(root, privateFilename), "public notes\n");

  const report = scanPublicSurface({
    denylistPath: path.join(root, ".public-safety.local"),
    files: [privateFilename],
    homePath: "",
    root,
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.issues, [{
    line: 1,
    path: "[redacted]-notes.md",
    rule: "local-denylist-rule-2",
  }]);
  assert.equal(JSON.stringify(report).includes(privateMarker), false);
});

test("public surface scan normalizes local denylist filename matches and redaction", () => {
  const root = makeTempDir();
  const privateMarker = "caf\u00e9-product";
  const decomposedMarker = privateMarker.normalize("NFD");
  const privateFilename = `${decomposedMarker}-notes.md`;
  fs.writeFileSync(path.join(root, ".public-safety.local"), `# local only\n${privateMarker}\n`);
  fs.writeFileSync(path.join(root, privateFilename), "public notes\n");

  const report = scanPublicSurface({
    denylistPath: path.join(root, ".public-safety.local"),
    files: [privateFilename],
    homePath: "",
    root,
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.issues, [{
    line: 1,
    path: "[redacted]-notes.md",
    rule: "local-denylist-rule-2",
  }]);
  assert.equal(JSON.stringify(report).includes(privateMarker), false);
  assert.equal(JSON.stringify(report).includes(decomposedMarker), false);
});

test("public surface scan applies the built-in home rule to relative filenames without echoing it", () => {
  const root = makeTempDir();
  const localHome = path.posix.join(path.posix.sep, "Users", "synthetic-operator");
  const relativeFile = `captures${localHome}/notes.md`;
  fs.mkdirSync(path.dirname(path.join(root, relativeFile)), { recursive: true });
  fs.writeFileSync(path.join(root, relativeFile), "public notes\n");

  const report = scanPublicSurface({
    files: [relativeFile],
    homePath: localHome,
    root,
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.issues, [{
    line: 1,
    path: "captures[redacted]/notes.md",
    rule: "local-home-path",
  }]);
  assert.equal(JSON.stringify(report).includes(localHome), false);
});

test("public surface scan rejects tracked broker state artifacts and ignores binary content", () => {
  const root = makeTempDir();
  fs.mkdirSync(path.join(root, "fixtures"));
  fs.mkdirSync(path.join(root, "state", "capacity-transactions"), { recursive: true });
  fs.mkdirSync(path.join(root, "state", "evidence", "lease-1"), { recursive: true });
  fs.mkdirSync(path.join(root, "state", "leases"), { recursive: true });
  fs.mkdirSync(path.join(root, "state", "locks", "lease-mutation.lock"), { recursive: true });
  fs.mkdirSync(path.join(root, "state", "pins"), { recursive: true });
  fs.mkdirSync(path.join(root, "state", "audit-append-failures"), { recursive: true });
  fs.writeFileSync(path.join(root, "fixtures", "idle-policy.json"), "{}\n");
  fs.writeFileSync(path.join(root, "state", "audit-append-failures", "event.json"), "{}\n");
  fs.writeFileSync(path.join(root, "state", "capacity-transactions", "txn.json"), "{}\n");
  fs.writeFileSync(path.join(root, "state", "events.ndjson"), "{}\n");
  fs.writeFileSync(path.join(root, "state", "evidence", "lease-1", "broker-status-after.json"), "{}\n");
  fs.writeFileSync(path.join(root, "state", "known-projects.json"), "{}\n");
  fs.writeFileSync(path.join(root, "state", "leases", "lease-1.json"), "{}\n");
  fs.writeFileSync(path.join(root, "state", "locks", "lease-mutation.lock", "owner.json"), "{}\n");
  fs.writeFileSync(path.join(root, "state", "pins", "pin-1.json"), "{}\n");
  fs.writeFileSync(path.join(root, "image.bin"), Buffer.from([0, 1, 2, 3]));

  const report = scanPublicSurface({
    files: [
      "fixtures/idle-policy.json",
      "state/audit-append-failures/event.json",
      "state/capacity-transactions/txn.json",
      "state/events.ndjson",
      "state/evidence/lease-1/broker-status-after.json",
      "state/known-projects.json",
      "state/leases/lease-1.json",
      "state/locks/lease-mutation.lock/owner.json",
      "state/pins/pin-1.json",
      "image.bin",
    ],
    homePath: "",
    root,
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.issues, [
    {
      line: 1,
      path: "fixtures/idle-policy.json",
      rule: "prohibited-local-artifact",
    },
    {
      line: 1,
      path: "state/audit-append-failures/event.json",
      rule: "prohibited-local-artifact",
    },
    {
      line: 1,
      path: "state/capacity-transactions/txn.json",
      rule: "prohibited-local-artifact",
    },
    {
      line: 1,
      path: "state/events.ndjson",
      rule: "prohibited-local-artifact",
    },
    {
      line: 1,
      path: "state/evidence/lease-1/broker-status-after.json",
      rule: "prohibited-local-artifact",
    },
    {
      line: 1,
      path: "state/known-projects.json",
      rule: "prohibited-local-artifact",
    },
    {
      line: 1,
      path: "state/leases/lease-1.json",
      rule: "prohibited-local-artifact",
    },
    {
      line: 1,
      path: "state/locks/lease-mutation.lock/owner.json",
      rule: "prohibited-local-artifact",
    },
    {
      line: 1,
      path: "state/pins/pin-1.json",
      rule: "prohibited-local-artifact",
    },
  ]);
});

test("public surface scan rejects symlinks without reading link targets", () => {
  const root = makeTempDir();
  const localHome = path.join(root, "private-home");
  const targetPath = path.join(localHome, "target.txt");
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, "private target\n");
  fs.symlinkSync(targetPath, path.join(root, "runtime-link"));

  const report = scanPublicSurface({
    files: ["runtime-link"],
    homePath: localHome,
    root,
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.issues, [{
    line: 1,
    path: "runtime-link",
    rule: "prohibited-symlink",
  }]);
  assert.equal(JSON.stringify(report).includes(localHome), false);
});

test("public surface scan rejects broken symlinks without checking target existence", () => {
  const root = makeTempDir();
  const localHome = path.join(root, "private-home");
  fs.symlinkSync(path.join(localHome, "missing-target.txt"), path.join(root, "runtime-link"));

  const report = scanPublicSurface({
    files: ["runtime-link"],
    homePath: localHome,
    root,
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.issues, [{
    line: 1,
    path: "runtime-link",
    rule: "prohibited-symlink",
  }]);
  assert.equal(JSON.stringify(report).includes(localHome), false);
});

test("default public surface scan rejects symlinks staged only in the Git index", () => {
  const root = makeTempDir();
  const localHome = path.join(root, "private-home");
  const targetPath = path.join(localHome, "target.txt");
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, "private target\n");
  fs.symlinkSync(targetPath, path.join(root, "runtime-link"));
  execFileSync("git", ["add", "runtime-link"], { cwd: root, stdio: "ignore" });
  fs.rmSync(path.join(root, "runtime-link"));
  fs.writeFileSync(path.join(root, "runtime-link"), "public docs\n");

  const report = scanPublicSurface({
    homePath: localHome,
    root,
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.issues, [{
    line: 1,
    path: "runtime-link",
    rule: "prohibited-symlink",
  }]);
  assert.equal(JSON.stringify(report).includes(localHome), false);
});

test("default public surface scan decodes staged BOM-marked UTF-16 text", () => {
  const root = makeTempDir();
  const localHome = path.join(root, "private-home");
  const utf16Content = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(`intro\nmachine path: ${localHome}/state\n`, "utf16le"),
  ]);
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "Localizable.strings"), utf16Content);
  execFileSync("git", ["add", "Localizable.strings"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "Localizable.strings"), "public docs\n");

  const report = scanPublicSurface({
    homePath: localHome,
    root,
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.issues, [{
    line: 2,
    path: "Localizable.strings",
    rule: "local-home-path",
  }]);
  assert.equal(JSON.stringify(report).includes(localHome), false);
});

test("default public surface candidates ignore untracked scratch files", () => {
  const root = makeTempDir();
  const localHome = path.join(root, "private-home");
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "README.md"), "public docs\n");
  fs.writeFileSync(path.join(root, "release-notes.md"), `machine path: ${localHome}/state\n`);
  fs.writeFileSync(path.join(root, "scratch.md"), `local scratch: ${localHome}/scratch\n`);
  execFileSync("git", ["add", "README.md", "release-notes.md"], { cwd: root, stdio: "ignore" });

  const report = scanPublicSurface({
    homePath: localHome,
    root,
  });

  assert.equal(report.ok, false);
  assert.equal(report.filesScanned, 2);
  assert.deepEqual(report.issues, [{
    line: 1,
    path: "release-notes.md",
    rule: "local-home-path",
  }]);
});

test("default public surface scan inspects staged blobs even after worktree cleanup", () => {
  const root = makeTempDir();
  const localHome = path.join(root, "private-home");
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "README.md"), `machine path: ${localHome}/state\n`);
  execFileSync("git", ["add", "README.md"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "README.md"), "public docs\n");

  const report = scanPublicSurface({
    homePath: localHome,
    root,
  });

  assert.equal(report.ok, false);
  assert.equal(report.filesScanned, 1);
  assert.deepEqual(report.issues, [{
    line: 1,
    path: "README.md",
    rule: "local-home-path",
  }]);
  assert.equal(JSON.stringify(report).includes(localHome), false);
});
