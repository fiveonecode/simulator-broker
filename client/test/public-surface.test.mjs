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

test("public surface scan rejects tracked broker state artifacts and ignores binary content", () => {
  const root = makeTempDir();
  fs.mkdirSync(path.join(root, "fixtures"));
  fs.writeFileSync(path.join(root, "fixtures", "idle-policy.json"), "{}\n");
  fs.writeFileSync(path.join(root, "image.bin"), Buffer.from([0, 1, 2, 3]));

  const report = scanPublicSurface({
    files: ["fixtures/idle-policy.json", "image.bin"],
    homePath: "",
    root,
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.issues, [{
    line: 1,
    path: "fixtures/idle-policy.json",
    rule: "prohibited-local-artifact",
  }]);
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
