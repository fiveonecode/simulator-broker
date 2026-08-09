import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  getRepoRoot,
  isActiveTrackedPath,
  loadEvalCases,
  loadManifests,
  loadVerifyProfiles,
} from "../src/lib/config.js";

describe("simulator broker repo adaptation", () => {
  const repoRoot = getRepoRoot();

  it("treats a missing evals directory as empty config", () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), "simbroker-agent-harness-"));

    try {
      expect(loadEvalCases(repoRoot)).toEqual([]);
    } finally {
      rmSync(repoRoot, { force: true, recursive: true });
    }
  });

  it("fails fast when required harness config directories are missing", () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), "simbroker-agent-harness-"));

    try {
      expect(() => loadManifests(repoRoot)).toThrowError(
        /Required harness config directory not found: .*\.agents[\\/]+manifests/,
      );
      expect(() => loadVerifyProfiles(repoRoot)).toThrowError(
        /Required harness config directory not found: .*\.agents[\\/]+verify/,
      );
    } finally {
      rmSync(repoRoot, { force: true, recursive: true });
    }
  });

  it("tracks the repo's macOS app and harness roots", () => {
    expect(isActiveTrackedPath(".codex/environments/environment.toml")).toBe(true);
    expect(isActiveTrackedPath("app/Sources/SimulatorBrokerApp.swift")).toBe(true);
    expect(isActiveTrackedPath("broker-core/index.mjs")).toBe(true);
    expect(isActiveTrackedPath("client/bin/simbroker.mjs")).toBe(true);
    expect(isActiveTrackedPath("examples/harness-adoption/README.md")).toBe(true);
    expect(isActiveTrackedPath("references/README.md")).toBe(true);
    expect(isActiveTrackedPath("script/build_and_run.sh")).toBe(true);
    expect(isActiveTrackedPath("WORKFLOW.md")).toBe(true);
    expect(isActiveTrackedPath("outside-root/file.txt")).toBe(false);
  });

  it("rejects unknown build_and_run launch modes before building", () => {
    try {
      execFileSync("/bin/bash", ["./script/build_and_run.sh", "--verfiy"], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      throw new Error("Expected build_and_run.sh to reject unknown launch modes.");
    } catch (error) {
      const execError = error as Error & { status?: number; stderr?: string | Buffer };

      expect(execError.status).toBe(2);
      expect(String(execError.stderr)).toContain("Unknown launch mode: --verfiy");
      expect(String(execError.stderr)).toContain(
        "usage: ./script/build_and_run.sh [run|--debug|--logs|--telemetry|--verify] [-- <app args>]",
      );
    }
  });

  it("waits for verify launch with bounded retries", () => {
    const output = execFileSync(
      "/bin/bash",
      [
        "-lc",
        `
          DERIVED_DATA_PATH="$(mktemp -d)"
          attempts_file="$(mktemp)"
          trap 'rm -rf "$DERIVED_DATA_PATH"; rm -f "$attempts_file"' EXIT
          source ./script/build_and_run.sh
          printf "0" > "$attempts_file"
          pgrep() {
            local attempts
            attempts="$(cat "$attempts_file")"
            attempts=$((attempts + 1))
            printf "%s" "$attempts" > "$attempts_file"
            if [[ "$attempts" -ge 3 ]]; then
              printf "123\\n"
              return 0
            fi
            return 1
          }
          ps() {
            printf "%s\\n" "$app_binary"
          }
          sleep() { :; }
          BUILD_AND_RUN_VERIFY_ATTEMPTS=5
          BUILD_AND_RUN_VERIFY_DELAY_SECONDS=0
          BUILD_AND_RUN_LAUNCH_RECORD_ATTEMPTS=1
          wait_for_app_launch
          printf "%s" "$(cat "$attempts_file")"
        `,
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    expect(output).toBe("3");
  });

  it("stops verify launch polling after the configured retry budget", () => {
    const output = execFileSync(
      "/bin/bash",
      [
        "-lc",
        `
          source ./script/build_and_run.sh
          attempts_file="$(mktemp)"
          trap 'rm -f "$attempts_file"' EXIT
          printf "0" > "$attempts_file"
          pgrep() {
            local attempts
            attempts="$(cat "$attempts_file")"
            attempts=$((attempts + 1))
            printf "%s" "$attempts" > "$attempts_file"
            return 1
          }
          sleep() { :; }
          BUILD_AND_RUN_VERIFY_ATTEMPTS=4
          BUILD_AND_RUN_VERIFY_DELAY_SECONDS=0
          set +e
          wait_for_app_launch
          status=$?
          set -e
          printf "%s:%s" "$status" "$(cat "$attempts_file")"
        `,
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    expect(output).toBe("1:4");
  });

  it("finds only the app process launched from this checkout", () => {
    const output = execFileSync(
      "/bin/bash",
      [
        "-lc",
        `
          source ./script/build_and_run.sh
          pgrep() {
            printf "123\\n456\\n"
          }
          ps() {
            if [[ "$2" == "456" ]]; then
              printf "%s --state-root /tmp/fixture\\n" "$app_binary"
            else
              printf "/Applications/SimulatorBrokerApp.app/Contents/MacOS/SimulatorBrokerApp\\n"
            fi
          }
          find_checkout_app_pid
        `,
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    expect(output).toBe("456\n");
  });
});
