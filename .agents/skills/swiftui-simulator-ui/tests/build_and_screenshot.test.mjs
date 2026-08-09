import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(".");

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source);
  fs.chmodSync(filePath, 0o755);
}

test("build and screenshot installs the selected scheme app product", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "swiftui-build-screenshot-"));
  try {
    const binDir = path.join(tempRoot, "bin");
    const xcrunLogPath = path.join(tempRoot, "xcrun.log");
    const xcodebuildLogPath = path.join(tempRoot, "xcodebuild.log");
    const derivedData = path.join(tempRoot, "DerivedData");
    const targetBuildDir = path.join(tempRoot, "SelectedProducts");
    const screenshotDir = path.join(tempRoot, "screenshots");
    const projectPath = path.join(tempRoot, "Example.xcodeproj");
    const expectedAppPath = path.join(targetBuildDir, "Correct.app");
    const simulatorUDID = "A1B2C3D4-E5F6";
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(projectPath, { recursive: true });

    writeExecutable(
      path.join(binDir, "xcodebuild"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$XCODEBUILD_LOG"
show_build_settings=0
derived_data=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -showBuildSettings)
      show_build_settings=1
      shift
      ;;
    -derivedDataPath)
      derived_data="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
if [[ "$show_build_settings" == "1" ]]; then
  cat <<SETTINGS
Build settings for action build and target Wrong:
    PRODUCT_BUNDLE_IDENTIFIER = com.example.other
    TARGET_BUILD_DIR = $derived_data/Build/Products/Debug-iphonesimulator
    WRAPPER_NAME = Wrong.app

Build settings for action build and target Example:
    PRODUCT_BUNDLE_IDENTIFIER = com.example.correct
    TARGET_BUILD_DIR = $MOCK_TARGET_BUILD_DIR
    WRAPPER_NAME = Correct.app
SETTINGS
  exit 0
fi
mkdir -p "$derived_data/Build/Products/Debug-iphonesimulator/Wrong.app"
mkdir -p "$MOCK_TARGET_BUILD_DIR/Correct.app"
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
if [[ "$1" == "simctl" && "$2" == "list" && "$3" == "devices" && "$4" == "available" ]]; then
  cat <<'DEVICES'
== Devices ==
-- iOS 18.0 --
    iPhone 16 (A1B2C3D4-E5F6) (Shutdown)
DEVICES
  exit 0
fi
if [[ "$1" == "simctl" && "$2" == "list" && "$3" == "devices" && "$4" == "booted" ]]; then
  exit 0
fi
if [[ "$1" == "simctl" && "$2" == "io" && "$4" == "screenshot" ]]; then
  mkdir -p "$(dirname "$5")"
  : > "$5"
fi
`,
    );

    const result = spawnSync("bash", [".agents/skills/swiftui-simulator-ui/assets/build_and_screenshot.sh"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        BUNDLE_ID: "com.example.correct",
        DERIVED_DATA: derivedData,
        MOCK_TARGET_BUILD_DIR: targetBuildDir,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        PROJECT_PATH: projectPath,
        SCHEME: "Example",
        SCREENSHOT_DELAY: "0",
        SCREENSHOT_DIR: screenshotDir,
        XCODEBUILD_LOG: xcodebuildLogPath,
        XCRUN_LOG: xcrunLogPath,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const xcrunLog = fs.readFileSync(xcrunLogPath, "utf8");
    assert.match(xcrunLog, new RegExp(`simctl install ${simulatorUDID} ${escapeRegExp(expectedAppPath)}`));
    assert.doesNotMatch(xcrunLog, new RegExp(`simctl install ${simulatorUDID} .*Wrong\\.app`));
    assert.equal(fs.readdirSync(screenshotDir).filter((entry) => entry.endsWith(".png")).length, 1);
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});
