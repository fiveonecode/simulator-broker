import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "simbroker-install-test-"));
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

test("install_distribution serializes metadata safely for JSON-sensitive paths", () => {
  const root = makeTempDir();
  const payloadRoot = path.join(root, "payload");
  const runtimeRoot = path.join(payloadRoot, "runtime");
  const appRoot = path.join(payloadRoot, "app", "Simulator Broker.app");
  const envMarker = path.join(root, "env-helper-was-not-escaped");
  const prefix = path.join(root, `prefix $(touch ${envMarker}) "quoted"`);
  const binDir = path.join(root, `bin $(touch ${envMarker}) "quoted"`);
  const applicationsDir = path.join(root, 'Applications "quoted"');

  fs.mkdirSync(path.join(runtimeRoot, "broker-core"), { recursive: true });
  fs.mkdirSync(path.join(runtimeRoot, "client"), { recursive: true });
  fs.mkdirSync(appRoot, { recursive: true });
  writeJson(path.join(runtimeRoot, "package.json"), {
    name: "simulator-broker-test-runtime",
    version: "0.0.0",
  });

  const result = spawnSync("bash", [
    path.resolve("scripts/install_distribution.sh"),
    "--payload-root",
    payloadRoot,
    "--prefix",
    prefix,
    "--bin-dir",
    binDir,
    "--applications-dir",
    applicationsDir,
    "--install-source",
    'source "quoted"',
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: root,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const metadata = JSON.parse(fs.readFileSync(path.join(prefix, "install.json"), "utf8"));
  const defaultMetadata = JSON.parse(fs.readFileSync(path.join(root, "Library/Application Support/SimulatorBroker/install/install.json"), "utf8"));
  assert.equal(metadata.appPath, path.join(applicationsDir, "Simulator Broker.app"));
  assert.equal(metadata.binDir, binDir);
  assert.equal(metadata.cliPath, path.join(binDir, "simbroker"));
  assert.equal(metadata.installSource, 'source "quoted"');
  assert.equal(metadata.libDir, path.join(prefix, "lib", "simulator-broker-app"));
  assert.equal(metadata.payloadRoot, payloadRoot);
  assert.equal(metadata.prefix, prefix);
  assert.match(metadata.installedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.deepEqual(defaultMetadata, metadata);

  const envResult = spawnSync("bash", [
    "-c",
    'source "$1"; printf "%s\\n%s\\n" "$SIMBROKER_APP" "$SIMBROKER_INSTALL_ROOT"',
    "bash",
    path.join(prefix, "env.sh"),
  ], {
    encoding: "utf8",
  });
  assert.equal(envResult.status, 0, envResult.stderr);
  assert.deepEqual(envResult.stdout.trimEnd().split("\n"), [
    path.join(applicationsDir, "Simulator Broker.app"),
    prefix,
  ]);
  assert.equal(fs.existsSync(envMarker), false);
});

test("install_distribution restarts a running service around runtime replacement", () => {
  const root = makeTempDir();
  const payloadRoot = path.join(root, "payload");
  const runtimeRoot = path.join(payloadRoot, "runtime");
  const appRoot = path.join(payloadRoot, "app", "Simulator Broker.app");
  const prefix = path.join(root, "prefix");
  const binDir = path.join(root, "bin");
  const applicationsDir = path.join(root, "Applications");
  const cliWrapper = path.join(binDir, "simbroker");
  const logPath = path.join(root, "service.log");

  fs.mkdirSync(path.join(runtimeRoot, "broker-core"), { recursive: true });
  fs.mkdirSync(path.join(runtimeRoot, "client", "bin"), { recursive: true });
  fs.mkdirSync(appRoot, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  writeJson(path.join(runtimeRoot, "package.json"), {
    name: "simulator-broker-test-runtime",
    version: "0.0.0",
  });
  fs.writeFileSync(path.join(runtimeRoot, "client", "bin", "simbroker.mjs"), `#!/usr/bin/env node
import fs from "node:fs";

fs.appendFileSync(process.env.SIMBROKER_INSTALL_TEST_LOG, \`new \${process.argv.slice(2).join(" ")}\\n\`);
process.exit(0);
`);
  fs.chmodSync(path.join(runtimeRoot, "client", "bin", "simbroker.mjs"), 0o755);
  fs.writeFileSync(cliWrapper, `#!/usr/bin/env bash
set -euo pipefail
printf 'old %s\\n' "$*" >> "$SIMBROKER_INSTALL_TEST_LOG"
if [[ "$1 $2 \${3:-}" == "service status --json" ]]; then
  printf '{"running":true,"ok":true}\\n'
fi
`);
  fs.chmodSync(cliWrapper, 0o755);

  const result = spawnSync("bash", [
    path.resolve("scripts/install_distribution.sh"),
    "--payload-root",
    payloadRoot,
    "--prefix",
    prefix,
    "--bin-dir",
    binDir,
    "--applications-dir",
    applicationsDir,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: root,
      SIMBROKER_INSTALL_TEST_LOG: logPath,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(logPath, "utf8").trim().split("\n"), [
    "old service status --json",
    "old service stop",
    "new service start",
  ]);
});

test("install_distribution aborts when existing service status cannot be verified", () => {
  const root = makeTempDir();
  const payloadRoot = path.join(root, "payload");
  const runtimeRoot = path.join(payloadRoot, "runtime");
  const appRoot = path.join(payloadRoot, "app", "Simulator Broker.app");
  const prefix = path.join(root, "prefix");
  const binDir = path.join(root, "bin");
  const applicationsDir = path.join(root, "Applications");
  const cliWrapper = path.join(binDir, "simbroker");
  const oldLibRoot = path.join(prefix, "lib", "simulator-broker-app");

  fs.mkdirSync(path.join(runtimeRoot, "broker-core"), { recursive: true });
  fs.mkdirSync(path.join(runtimeRoot, "client"), { recursive: true });
  fs.mkdirSync(appRoot, { recursive: true });
  fs.mkdirSync(path.join(oldLibRoot, "broker-core"), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  writeJson(path.join(runtimeRoot, "package.json"), {
    name: "simulator-broker-test-runtime",
    version: "0.0.1",
  });
  fs.writeFileSync(path.join(runtimeRoot, "broker-core", "new-runtime.txt"), "new runtime\n");
  fs.writeFileSync(path.join(oldLibRoot, "broker-core", "old-runtime.txt"), "old runtime\n");
  fs.writeFileSync(cliWrapper, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2 \${3:-}" == "service status --json" ]]; then
  printf 'status probe timed out\\n' >&2
  exit 42
fi
exit 0
`);
  fs.chmodSync(cliWrapper, 0o755);

  const result = spawnSync("bash", [
    path.resolve("scripts/install_distribution.sh"),
    "--payload-root",
    payloadRoot,
    "--prefix",
    prefix,
    "--bin-dir",
    binDir,
    "--applications-dir",
    applicationsDir,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: root,
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Cannot verify existing Simulator Broker service status/);
  assert.equal(fs.existsSync(path.join(oldLibRoot, "broker-core", "old-runtime.txt")), true);
  assert.equal(fs.existsSync(path.join(oldLibRoot, "broker-core", "new-runtime.txt")), false);
});

test("install_distribution rolls back runtime replacement and restarts the old service on failure", () => {
  const root = makeTempDir();
  const payloadRoot = path.join(root, "payload");
  const runtimeRoot = path.join(payloadRoot, "runtime");
  const appRoot = path.join(payloadRoot, "app", "Simulator Broker.app");
  const prefix = path.join(root, "prefix");
  const binDir = path.join(root, "bin");
  const applicationsDir = path.join(root, "Applications");
  const cliWrapper = path.join(binDir, "simbroker");
  const oldLibRoot = path.join(prefix, "lib", "simulator-broker-app");
  const oldAppRoot = path.join(applicationsDir, "Simulator Broker.app");
  const logPath = path.join(root, "service.log");

  fs.mkdirSync(path.join(runtimeRoot, "broker-core"), { recursive: true });
  fs.mkdirSync(path.join(runtimeRoot, "client", "bin"), { recursive: true });
  fs.mkdirSync(appRoot, { recursive: true });
  fs.mkdirSync(path.join(oldLibRoot, "broker-core"), { recursive: true });
  fs.mkdirSync(oldAppRoot, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  writeJson(path.join(runtimeRoot, "package.json"), {
    name: "simulator-broker-test-runtime",
    version: "0.0.1",
  });
  fs.writeFileSync(path.join(runtimeRoot, "broker-core", "new-runtime.txt"), "new runtime\n");
  fs.writeFileSync(path.join(appRoot, "new-app.txt"), "new app\n");
  fs.writeFileSync(path.join(oldLibRoot, "broker-core", "old-runtime.txt"), "old runtime\n");
  fs.writeFileSync(path.join(oldAppRoot, "old-app.txt"), "old app\n");
  fs.writeFileSync(cliWrapper, `#!/usr/bin/env bash
set -euo pipefail
printf 'old %s\\n' "$*" >> "$SIMBROKER_INSTALL_TEST_LOG"
if [[ "$1 $2 \${3:-}" == "service status --json" ]]; then
  printf '{"running":true,"ok":true}\\n'
fi
`);
  fs.chmodSync(cliWrapper, 0o755);

  const result = spawnSync("bash", [
    path.resolve("scripts/install_distribution.sh"),
    "--payload-root",
    payloadRoot,
    "--prefix",
    prefix,
    "--bin-dir",
    binDir,
    "--applications-dir",
    applicationsDir,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: root,
      SIMBROKER_INSTALL_TEST_FAIL_STAGE: "after-runtime-swap",
      SIMBROKER_INSTALL_TEST_LOG: logPath,
    },
  });

  assert.equal(result.status, 97, result.stderr);
  assert.match(result.stderr, /after-runtime-swap/);
  assert.equal(fs.existsSync(path.join(oldLibRoot, "broker-core", "old-runtime.txt")), true);
  assert.equal(fs.existsSync(path.join(oldLibRoot, "broker-core", "new-runtime.txt")), false);
  assert.equal(fs.existsSync(path.join(oldAppRoot, "old-app.txt")), true);
  assert.deepEqual(fs.readFileSync(logPath, "utf8").trim().split("\n"), [
    "old service status --json",
    "old service stop",
    "old service start",
  ]);
});

test("install_distribution rejects unsupported Node versions before staging install", () => {
  const root = makeTempDir();
  const payloadRoot = path.join(root, "payload");
  const runtimeRoot = path.join(payloadRoot, "runtime");
  const appRoot = path.join(payloadRoot, "app", "Simulator Broker.app");
  const prefix = path.join(root, "prefix");
  const binDir = path.join(root, "bin");
  const applicationsDir = path.join(root, "Applications");
  const fakePathDir = path.join(root, "fake-path");
  const fakeNodePath = path.join(fakePathDir, "node");

  fs.mkdirSync(path.join(runtimeRoot, "broker-core"), { recursive: true });
  fs.mkdirSync(path.join(runtimeRoot, "client"), { recursive: true });
  fs.mkdirSync(appRoot, { recursive: true });
  fs.mkdirSync(fakePathDir, { recursive: true });
  writeJson(path.join(runtimeRoot, "package.json"), {
    name: "simulator-broker-test-runtime",
    version: "0.0.1",
  });
  fs.writeFileSync(fakeNodePath, [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "if [[ \"${1:-}\" == \"--version\" ]]; then",
    "  printf 'v18.19.0\\n'",
    "  exit 0",
    "fi",
    "if [[ \"${1:-}\" == \"-e\" ]]; then",
    "  exit 1",
    "fi",
    "exit 42",
    "",
  ].join("\n"));
  fs.chmodSync(fakeNodePath, 0o755);

  const result = spawnSync("bash", [
    path.resolve("scripts/install_distribution.sh"),
    "--payload-root",
    payloadRoot,
    "--prefix",
    prefix,
    "--bin-dir",
    binDir,
    "--applications-dir",
    applicationsDir,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: root,
      PATH: `${fakePathDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires Node\.js 20 or newer/);
  assert.match(result.stderr, /v18\.19\.0/);
  assert.equal(fs.existsSync(path.join(prefix, "lib", "simulator-broker-app")), false);
  assert.equal(fs.existsSync(path.join(binDir, "simbroker")), false);
});

test("package_distribution rejects symlinks copied into the runtime payload", (t) => {
  const root = makeTempDir();
  const outputDir = path.join(root, "out");
  const fakePathDir = path.join(root, "fake-path");
  const fakeSecurityPath = path.join(fakePathDir, "security");
  const symlinkTargetDir = path.join(root, "private-home");
  const symlinkTargetPath = path.join(symlinkTargetDir, "target.txt");
  const symlinkPath = path.resolve("client/.package-distribution-public-surface-symlink-test");
  const appSource = path.resolve("DerivedData/SimulatorBrokerApp/Build/Products/Release/SimulatorBrokerApp.app");
  const createdAppSource = !fs.existsSync(appSource);

  assert.equal(fs.existsSync(symlinkPath), false);
  fs.mkdirSync(fakePathDir, { recursive: true });
  fs.mkdirSync(symlinkTargetDir, { recursive: true });
  fs.writeFileSync(symlinkTargetPath, "private target\n");
  fs.writeFileSync(fakeSecurityPath, [
    "#!/usr/bin/env bash",
    "printf '  1) ABC \"Developer ID Application: Example (TEAMID)\"\\n'",
    "",
  ].join("\n"));
  fs.chmodSync(fakeSecurityPath, 0o755);
  fs.mkdirSync(appSource, { recursive: true });
  fs.symlinkSync(symlinkTargetPath, symlinkPath);
  t.after(() => {
    fs.rmSync(symlinkPath, { force: true });
    if (createdAppSource) {
      fs.rmSync(path.resolve("DerivedData/SimulatorBrokerApp"), { force: true, recursive: true });
    }
  });

  const result = spawnSync("bash", [
    path.resolve("scripts/package_distribution.sh"),
    "--skip-build",
    "--output-dir",
    outputDir,
    "--team-id",
    "TEAMID",
    "--signing-identity",
    "Developer ID Application: Example (TEAMID)",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: root,
      PATH: `${fakePathDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Distribution public surface verification failed/);
  assert.match(result.stderr, /payload\/runtime\/client\/\.package-distribution-public-surface-symlink-test:1 \[prohibited-symlink\]/);
  assert.equal(result.stderr.includes(symlinkTargetDir), false);
});

test("package_distribution scans copied payload filenames containing newlines", (t) => {
  const root = makeTempDir();
  const outputDir = path.join(root, "out");
  const fakePathDir = path.join(root, "fake-path");
  const fakeSecurityPath = path.join(fakePathDir, "security");
  const newlinePayloadPath = path.resolve("client/.package-distribution-public-surface-newline-test\nsecret.txt");
  const appSource = path.resolve("DerivedData/SimulatorBrokerApp/Build/Products/Release/SimulatorBrokerApp.app");
  const createdAppSource = !fs.existsSync(appSource);

  assert.equal(fs.existsSync(newlinePayloadPath), false);
  fs.mkdirSync(fakePathDir, { recursive: true });
  fs.writeFileSync(fakeSecurityPath, [
    "#!/usr/bin/env bash",
    "printf '  1) ABC \"Developer ID Application: Example (TEAMID)\"\\n'",
    "",
  ].join("\n"));
  fs.chmodSync(fakeSecurityPath, 0o755);
  fs.mkdirSync(appSource, { recursive: true });
  fs.writeFileSync(newlinePayloadPath, `${path.join(root, "private-token")}\n`);
  t.after(() => {
    fs.rmSync(newlinePayloadPath, { force: true });
    if (createdAppSource) {
      fs.rmSync(path.resolve("DerivedData/SimulatorBrokerApp"), { force: true, recursive: true });
    }
  });

  const result = spawnSync("bash", [
    path.resolve("scripts/package_distribution.sh"),
    "--skip-build",
    "--output-dir",
    outputDir,
    "--team-id",
    "TEAMID",
    "--signing-identity",
    "Developer ID Application: Example (TEAMID)",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: root,
      PATH: `${fakePathDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Distribution public surface verification failed/);
  assert.match(result.stderr, /payload\/runtime\/client\/\.package-distribution-public-surface-newline-test/);
  assert.match(result.stderr, /\[local-home-path\]/);
  assert.equal(result.stderr.includes(root), false);
});

test("package scripts reject path-like archive names before cleanup", () => {
  for (const scriptPath of ["scripts/package_local.sh", "scripts/package_distribution.sh"]) {
    const root = makeTempDir();
    const outputDir = path.join(root, "out");
    const victimDir = path.join(root, "victim");
    fs.mkdirSync(victimDir, { recursive: true });
    fs.writeFileSync(path.join(victimDir, "sentinel.txt"), "preserve\n");

    const result = spawnSync("bash", [
      path.resolve(scriptPath),
      "--output-dir",
      outputDir,
      "--archive-name",
      "../victim",
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: root,
      },
    });

    assert.notEqual(result.status, 0, scriptPath);
    assert.match(result.stderr, /Archive name must be a non-dot basename/);
    assert.equal(fs.existsSync(path.join(victimDir, "sentinel.txt")), true);
  }
});

test("app test script rejects unsafe result bundle paths before cleanup", () => {
  const root = makeTempDir();
  const victimDir = path.join(root, "victim");
  fs.mkdirSync(victimDir, { recursive: true });
  fs.writeFileSync(path.join(victimDir, "sentinel.txt"), "preserve\n");

  const result = spawnSync("bash", [
    path.resolve("scripts/test_app.sh"),
    "--result-bundle-path",
    victimDir,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: root,
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must name a \.xcresult bundle/);
  assert.equal(fs.existsSync(path.join(victimDir, "sentinel.txt")), true);
});
