import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function commandResult(command, args, options = {}) {
  const runner = options.commandRunner ?? execFileSync;
  try {
    return {
      ok: true,
      stdout: String(runner(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: options.timeoutMs ?? 15_000,
      })).trim(),
    };
  } catch (error) {
    return {
      error: error?.stderr?.toString("utf8").trim() || error?.message || String(error),
      ok: false,
      stdout: error?.stdout?.toString("utf8").trim() || "",
    };
  }
}

function numericVersionAtLeast(version, requiredMajor) {
  const major = Number.parseInt(String(version).split(".")[0], 10);
  return Number.isInteger(major) && major >= requiredMajor;
}

function nearestExistingAncestor(destination) {
  let candidate = path.resolve(destination);
  while (!fs.existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      return null;
    }
    candidate = parent;
  }
  return candidate;
}

function pathPrerequisite(id, destination, summary) {
  const ancestor = nearestExistingAncestor(destination);
  if (!ancestor) {
    return {
      details: { destination },
      id,
      remediationCommands: [],
      status: "blocked",
      summary: `No existing ancestor was found for ${summary}.`,
    };
  }
  try {
    fs.accessSync(ancestor, fs.constants.W_OK);
    return {
      details: { checkedPath: ancestor, destination },
      id,
      remediationCommands: [],
      status: "ready",
      summary: `${summary} is writable.`,
    };
  } catch {
    return {
      details: { checkedPath: ancestor, destination },
      id,
      remediationCommands: [`chmod u+w "${ancestor}"`],
      status: "blocked",
      summary: `${summary} is not writable by the current user.`,
    };
  }
}

function diskPrerequisite(stateRoot) {
  const ancestor = nearestExistingAncestor(stateRoot);
  if (!ancestor || typeof fs.statfsSync !== "function") {
    return {
      id: "disk-space",
      remediationCommands: [],
      status: "info",
      summary: "Available disk space could not be read on this system.",
    };
  }
  try {
    const stats = fs.statfsSync(ancestor);
    const availableBytes = Number(stats.bavail) * Number(stats.bsize);
    return {
      details: {
        availableBytes,
        availableGiB: `${(availableBytes / (1024 ** 3)).toFixed(1)} GiB`,
        checkedPath: ancestor,
      },
      id: "disk-space",
      remediationCommands: [],
      status: "info",
      summary: `${(availableBytes / (1024 ** 3)).toFixed(1)} GiB is available for Simulator data.`,
    };
  } catch {
    return {
      id: "disk-space",
      remediationCommands: [],
      status: "info",
      summary: "Available disk space could not be read on this system.",
    };
  }
}

function fixturePrerequisites(paths, options) {
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  return [
    { id: "node", status: "ready", summary: `Node.js ${nodeVersion} is available.`, remediationCommands: [] },
    { id: "macos", status: "ready", summary: "macOS 14 or newer is available.", remediationCommands: [] },
    { id: "xcode", status: "ready", summary: "A full Xcode developer directory is selected.", remediationCommands: [] },
    { id: "xcode-first-launch", status: "ready", summary: "Xcode first-launch tasks are complete.", remediationCommands: [] },
    { id: "simctl", status: "ready", summary: "The simctl command is available.", remediationCommands: [] },
    pathPrerequisite("host-config-path", paths.hostConfigPath, "The host configuration destination"),
    pathPrerequisite("state-root-path", paths.stateRoot, "The broker state destination"),
    diskPrerequisite(paths.stateRoot),
  ];
}

export function evaluateSetupPrerequisites(paths, options = {}) {
  const env = options.env ?? process.env;
  if (env.SIMBROKER_SIMCTL_FIXTURE_STATE) {
    return fixturePrerequisites(paths, options);
  }

  const prerequisites = [];
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  prerequisites.push(numericVersionAtLeast(nodeVersion, 20)
    ? { id: "node", status: "ready", summary: `Node.js ${nodeVersion} is available.`, remediationCommands: [] }
    : {
        id: "node",
        status: "blocked",
        summary: `Node.js 20 or newer is required; found ${nodeVersion}.`,
        remediationCommands: ["brew install node@20"],
      });

  const platform = options.platform ?? process.platform;
  const macosVersionResult = platform === "darwin"
    ? commandResult("/usr/bin/sw_vers", ["-productVersion"], options)
    : { ok: false, stdout: "", error: `platform ${platform}` };
  prerequisites.push(macosVersionResult.ok && numericVersionAtLeast(macosVersionResult.stdout, 14)
    ? {
        details: { version: macosVersionResult.stdout },
        id: "macos",
        status: "ready",
        summary: `macOS ${macosVersionResult.stdout} is supported.`,
        remediationCommands: [],
      }
    : {
        details: { detected: macosVersionResult.stdout || platform },
        id: "macos",
        status: "blocked",
        summary: "macOS 14 or newer is required.",
        remediationCommands: [],
      });

  const developerDir = commandResult("/usr/bin/xcode-select", ["-p"], options);
  const fullXcodeSelected = developerDir.ok && developerDir.stdout.endsWith("/Contents/Developer");
  prerequisites.push(fullXcodeSelected
    ? {
        details: { developerDirectory: developerDir.stdout },
        id: "xcode",
        status: "ready",
        summary: "A full Xcode developer directory is selected.",
        remediationCommands: [],
      }
    : {
        details: { developerDirectory: developerDir.stdout || null },
        id: "xcode",
        status: "blocked",
        summary: "Select a full Xcode installation before setup.",
        remediationCommands: ["sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer"],
      });

  const firstLaunch = fullXcodeSelected
    ? commandResult("/usr/bin/xcodebuild", ["-checkFirstLaunchStatus"], options)
    : { ok: false, error: "Xcode is not selected", stdout: "" };
  prerequisites.push(firstLaunch.ok
    ? {
        id: "xcode-first-launch",
        status: "ready",
        summary: "Xcode first-launch tasks are complete.",
        remediationCommands: [],
      }
    : {
        details: { error: firstLaunch.error },
        id: "xcode-first-launch",
        status: "blocked",
        summary: "Complete Xcode first-launch tasks manually.",
        remediationCommands: ["sudo xcodebuild -runFirstLaunch"],
      });

  const simctl = fullXcodeSelected
    ? commandResult("/usr/bin/xcrun", ["--find", "simctl"], options)
    : { ok: false, error: "Xcode is not selected", stdout: "" };
  prerequisites.push(simctl.ok
    ? {
        details: { path: simctl.stdout },
        id: "simctl",
        status: "ready",
        summary: "The simctl command is available.",
        remediationCommands: [],
      }
    : {
        details: { error: simctl.error },
        id: "simctl",
        status: "blocked",
        summary: "simctl is unavailable from the selected developer directory.",
        remediationCommands: ["sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer"],
      });

  prerequisites.push(pathPrerequisite(
    "host-config-path",
    paths.hostConfigPath,
    "The host configuration destination",
  ));
  prerequisites.push(pathPrerequisite(
    "state-root-path",
    paths.stateRoot,
    "The broker state destination",
  ));
  prerequisites.push(diskPrerequisite(paths.stateRoot));
  return prerequisites;
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function blockedSetupPreview(paths, prerequisites, options = {}) {
  const mutationState = {
    hostConfigured: fs.existsSync(paths.hostConfigPath),
    hostId: options.hostId ?? null,
    iosVersion: options.iosVersion ?? null,
    schemaVersion: 1,
  };
  const planId = `sha256:${crypto.createHash("sha256")
    .update(JSON.stringify(canonicalize(mutationState)))
    .digest("hex")}`;
  return {
    command: "setup",
    confirmation: { createCount: 0, required: false, reuseCount: 0 },
    devices: [],
    host: {
      action: fs.existsSync(paths.hostConfigPath) ? "keep" : "create",
      configured: fs.existsSync(paths.hostConfigPath),
      hostId: options.hostId ?? null,
    },
    mode: "preview",
    nextSteps: prerequisites.flatMap((prerequisite) => prerequisite.remediationCommands ?? []),
    ok: true,
    planId,
    prerequisites,
    runtime: null,
    schemaVersion: 1,
    service: { action: "blocked", running: false },
    status: "blocked",
  };
}

export function completeSetupPreview(corePreview, prerequisites, options = {}) {
  const blocked = corePreview.status === "blocked"
    || prerequisites.some((prerequisite) => prerequisite.status === "blocked");
  const serviceRunning = options.serviceRunning === true;
  const snapshotReady = options.snapshotReady === true;
  const finishingRequired = corePreview.host.configured && (!serviceRunning || !snapshotReady);
  const status = blocked
    ? "blocked"
    : (corePreview.host.configured && !finishingRequired ? "ready" : "changes_required");
  return {
    ...corePreview,
    nextSteps: status === "ready"
      ? ["simbroker project init", "simbroker project validate"]
      : corePreview.nextSteps,
    prerequisites: [...prerequisites, ...corePreview.prerequisites],
    service: {
      action: blocked ? "blocked" : (serviceRunning ? "keep" : "start"),
      running: serviceRunning,
    },
    status,
  };
}
