#!/usr/bin/env bash
set -euo pipefail

fail_macos_build_prereq() {
  echo "error: $1" >&2
  return 1
}

require_macos_build_prereqs() {
  if ! command -v xcodegen >/dev/null 2>&1; then
    fail_macos_build_prereq "xcodegen was not found in PATH. Install XcodeGen first, then rerun this command. Example: brew install xcodegen"
  fi

  if ! command -v xcodebuild >/dev/null 2>&1; then
    fail_macos_build_prereq "xcodebuild was not found in PATH. Install Xcode with macOS development support, then ensure Command Line Tools are configured."
  fi

  if ! xcodebuild -version >/dev/null 2>&1; then
    fail_macos_build_prereq "xcodebuild is installed but not usable. Finish Xcode setup, then ensure the active developer directory points at Xcode. Example: sudo xcode-select --switch /Applications/Xcode.app"
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  require_macos_build_prereqs
fi
