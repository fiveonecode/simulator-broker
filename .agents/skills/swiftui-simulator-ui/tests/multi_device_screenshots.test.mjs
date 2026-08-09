import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(".");

function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source);
  fs.chmodSync(filePath, 0o755);
}

test("multi-device screenshots resolve names literally and preserve preexisting booted simulators", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "swiftui-multi-device-"));
  try {
    const binDir = path.join(tempRoot, "bin");
    const logPath = path.join(tempRoot, "xcrun.log");
    const derivedData = path.join(tempRoot, "DerivedData");
    const screenshotDir = path.join(tempRoot, "screenshots");
    const projectPath = path.join(tempRoot, "Example.xcodeproj");
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(projectPath, { recursive: true });

    writeExecutable(
      path.join(binDir, "xcodebuild"),
      `#!/usr/bin/env bash
set -euo pipefail
derived_data=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-derivedDataPath" ]]; then
    derived_data="$2"
    shift 2
    continue
  fi
  shift
done
mkdir -p "$derived_data/Build/Products/Debug-iphonesimulator/Example.app"
`,
    );
    writeExecutable(
      path.join(binDir, "sleep"),
      `#!/usr/bin/env bash
exit 0
`,
    );
    writeExecutable(
      path.join(binDir, "xcrun"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$XCRUN_LOG"
if [[ "$1" == "simctl" && "$2" == "list" && "$3" == "devices" && "$4" == "available" && "$5" == "--json" ]]; then
  cat <<'JSON'
{"devices":{"iOS 18.0":[{"name":"iPhone SE (3rd generation)","udid":"SE-UDID","isAvailable":true},{"name":"iPhone 16","udid":"IPHONE16-UDID","isAvailable":true},{"name":"iPhone 16 Pro Max","udid":"16PM-UDID","isAvailable":true}]}}
JSON
  exit 0
fi
if [[ "$1" == "simctl" && "$2" == "list" && "$3" == "devices" && "$4" == "booted" && "$5" == "--json" ]]; then
  cat <<'JSON'
{"devices":{"iOS 18.0":[{"name":"iPhone 16","udid":"IPHONE16-UDID","state":"Booted"}]}}
JSON
  exit 0
fi
if [[ "$1" == "simctl" && "$2" == "io" && "$4" == "screenshot" ]]; then
  mkdir -p "$(dirname "$5")"
  : > "$5"
fi
`,
    );

    const result = spawnSync("bash", [".agents/skills/swiftui-simulator-ui/assets/multi_device_screenshots.sh"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        BUNDLE_ID: "com.example.app",
        DERIVED_DATA: derivedData,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        PROJECT_PATH: projectPath,
        SCHEME: "Example",
        SCREENSHOT_DIR: screenshotDir,
        XCRUN_LOG: logPath,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const log = fs.readFileSync(logPath, "utf8");
    assert.equal(log.includes("simctl shutdown all"), false);
    assert.match(log, /simctl boot SE-UDID/);
    assert.match(log, /simctl shutdown SE-UDID/);
    assert.doesNotMatch(log, /simctl boot IPHONE16-UDID/);
    assert.doesNotMatch(log, /simctl shutdown IPHONE16-UDID/);
    assert.match(log, /simctl boot 16PM-UDID/);
    assert.match(log, /simctl shutdown 16PM-UDID/);
    assert.equal(fs.readdirSync(screenshotDir).filter((entry) => entry.endsWith(".png")).length, 3);
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});
