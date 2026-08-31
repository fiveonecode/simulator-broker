import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const skipMacOS = process.platform !== "darwin";
const verifierPath = path.resolve("script/verify_release_app_binary.sh");

function run(command, args) {
  return spawnSync(command, args, {
    encoding: "utf8",
  });
}

function compileSlice(root, architecture, marker, { debuggingSymbols = false } = {}) {
  const variant = [
    marker === null ? "clean" : "leaking",
    debuggingSymbols ? "debug" : null,
  ].filter(Boolean).join("-");
  const sourcePath = path.join(root, `${architecture}-${variant}.c`);
  const executablePath = path.join(root, `${architecture}-${variant}`);
  const markerDeclaration = marker === null
    ? ""
    : `__attribute__((used)) static const char local_build_root[] = ${JSON.stringify(`${marker}/`)};\n`;

  fs.writeFileSync(sourcePath, `${markerDeclaration}int main(void) { return 0; }\n`);
  const args = [
    "clang",
    "-arch",
    architecture,
    "-mmacosx-version-min=14.0",
    "-Os",
    sourcePath,
    "-o",
    executablePath,
  ];
  if (debuggingSymbols) {
    args.splice(6, 0, "-g");
  }
  const result = run("xcrun", args);
  assert.equal(result.status, 0, result.stderr);
  return executablePath;
}

function createUniversal(root, name, ...slices) {
  const executablePath = path.join(root, name);
  const result = run("xcrun", ["lipo", "-create", ...slices, "-output", executablePath]);
  assert.equal(result.status, 0, result.stderr);
  return executablePath;
}

test("Release executable verifier rejects leaked paths and unstripped or unexpected content", { skip: skipMacOS }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simbroker-release-path-test-"));
  const forbiddenRoot = path.join(root, "synthetic-local-build-root");
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));

  const cleanArm64 = compileSlice(root, "arm64", null);
  const cleanX86 = compileSlice(root, "x86_64", null);
  const leakingArm64 = compileSlice(root, "arm64", forbiddenRoot);
  const leakingX86 = compileSlice(root, "x86_64", forbiddenRoot);
  const leakingArm64e = compileSlice(root, "arm64e", forbiddenRoot);
  const debugArm64 = compileSlice(root, "arm64", null, { debuggingSymbols: true });

  const cleanUniversal = createUniversal(root, "clean-universal", cleanArm64, cleanX86);
  const cleanResult = run("bash", [verifierPath, cleanUniversal, forbiddenRoot]);
  assert.equal(cleanResult.status, 0, cleanResult.stderr);
  assert.match(cleanResult.stdout, /passed for arm64 and x86_64/);

  const arm64Leak = createUniversal(root, "arm64-leak", leakingArm64, cleanX86);
  const arm64Result = run("bash", [verifierPath, arm64Leak, forbiddenRoot]);
  assert.notEqual(arm64Result.status, 0);
  assert.match(arm64Result.stderr, /arm64 slice contains the local build root/);
  assert.equal(arm64Result.stderr.includes(forbiddenRoot), false);

  const x86Leak = createUniversal(root, "x86-leak", cleanArm64, leakingX86);
  const x86Result = run("bash", [verifierPath, x86Leak, forbiddenRoot]);
  assert.notEqual(x86Result.status, 0);
  assert.match(x86Result.stderr, /x86_64 slice contains the local build root/);
  assert.equal(x86Result.stderr.includes(forbiddenRoot), false);

  const universalOnlyLeak = path.join(root, "universal-only-leak");
  fs.copyFileSync(cleanUniversal, universalOnlyLeak);
  fs.appendFileSync(universalOnlyLeak, `${forbiddenRoot}/`);
  const universalResult = run("bash", [verifierPath, universalOnlyLeak, forbiddenRoot]);
  assert.notEqual(universalResult.status, 0);
  assert.match(universalResult.stderr, /universal file contains the local build root/);
  assert.equal(universalResult.stderr.includes(forbiddenRoot), false);

  const unexpectedArchitecture = createUniversal(
    root,
    "unexpected-architecture",
    cleanArm64,
    cleanX86,
    leakingArm64e,
  );
  const unexpectedArchitectureResult = run("bash", [verifierPath, unexpectedArchitecture, forbiddenRoot]);
  assert.notEqual(unexpectedArchitectureResult.status, 0);
  assert.match(unexpectedArchitectureResult.stderr, /must contain exactly arm64 and x86_64 slices/);
  assert.equal(unexpectedArchitectureResult.stderr.includes(forbiddenRoot), false);

  const unstrippedUniversal = createUniversal(root, "unstripped-universal", debugArm64, cleanX86);
  const unstrippedResult = run("bash", [verifierPath, unstrippedUniversal, forbiddenRoot]);
  assert.notEqual(unstrippedResult.status, 0);
  assert.match(unstrippedResult.stderr, /arm64 slice retains debugging symbols/);
  assert.equal(unstrippedResult.stderr.includes(root), false);

  const missingArchitectureResult = run("bash", [verifierPath, cleanArm64, forbiddenRoot]);
  assert.notEqual(missingArchitectureResult.status, 0);
  assert.match(missingArchitectureResult.stderr, /must contain exactly arm64 and x86_64 slices/);
});
