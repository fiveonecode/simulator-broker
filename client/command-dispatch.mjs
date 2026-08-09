import process from "node:process";
import path from "node:path";

import {
  BrokerError,
  DEFAULT_PROJECT_FILE,
  acquireLeaseBroker,
  appSnapshotBroker,
  bootSimulatorBroker,
  checkCapacityBroker,
  clearPinBroker,
  createPinBroker,
  doctorBroker,
  eraseSimulatorBroker,
  explainLeaseBroker,
  forgetKnownProjectBroker,
  hostStatusBroker,
  initBroker,
  initProjectBroker,
  listSimulatorsBroker,
  containLeaseBroker,
  readEventsBroker,
  registerLeaseProcessBroker,
  reconcileCapacityBroker,
  repairSimulatorBroker,
  releaseLeaseBroker,
  shutdownSimulatorBroker,
  showLeaseBroker,
  showProjectBroker,
  validateProjectBroker,
  writeAppSnapshotArtifactUnderMutationLock,
} from "../broker-core/index.mjs";

export function parseArgs(argv) {
  const positionals = [];
  const flags = new Map();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const equalsIndex = token.indexOf("=");
    if (equalsIndex > 2) {
      flags.set(token.slice(2, equalsIndex), token.slice(equalsIndex + 1));
      continue;
    }
    const key = token.slice(2);
    const nextValue = argv[index + 1];
    if (nextValue === undefined || nextValue.startsWith("--")) {
      flags.set(key, true);
      continue;
    }
    flags.set(key, nextValue);
    index += 1;
  }

  return { flags, positionals };
}

export function flagValue(flags, key) {
  const value = flags.get(key);
  return value === true ? null : value ?? null;
}

export function requireFlag(flags, key) {
  const value = flagValue(flags, key);
  if (!value) {
    throw new BrokerError(`Missing required flag --${key}.`, {
      reasonCode: "missing-flag",
    });
  }
  return value;
}

export function parseIntegerFlag(flags, key) {
  const value = flagValue(flags, key);
  if (value === null) {
    return null;
  }

  const normalizedValue = String(value).trim();
  if (/^[+-]?\d+$/.test(normalizedValue) === false) {
    throw new BrokerError(`Flag --${key} must be an integer.`, {
      reasonCode: "invalid-flag",
    });
  }
  const parsed = Number.parseInt(normalizedValue, 10);
  if (!Number.isInteger(parsed)) {
    throw new BrokerError(`Flag --${key} must be an integer.`, {
      reasonCode: "invalid-flag",
    });
  }
  return parsed;
}

function requirePositiveIntegerFlag(flags, key) {
  const parsed = parseIntegerFlag(flags, key);
  if (parsed === null) {
    throw new BrokerError(`Missing required flag --${key}.`, {
      reasonCode: "missing-flag",
    });
  }
  if (parsed <= 0) {
    throw new BrokerError(`Flag --${key} must be a positive integer.`, {
      reasonCode: "invalid-flag",
    });
  }
  return parsed;
}

function requireNonNegativeIntegerFlag(flags, key) {
  const parsed = parseIntegerFlag(flags, key);
  if (parsed === null) {
    throw new BrokerError(`Missing required flag --${key}.`, {
      reasonCode: "missing-flag",
    });
  }
  if (parsed < 0) {
    throw new BrokerError(`Flag --${key} must be a nonnegative integer.`, {
      reasonCode: "invalid-flag",
    });
  }
  return parsed;
}

function optionalFlagValue(flags, key) {
  if (!flags.has(key)) {
    return undefined;
  }
  const value = flagValue(flags, key);
  if (value === null) {
    throw new BrokerError(`Missing required flag --${key}.`, {
      reasonCode: "missing-flag",
    });
  }
  return value;
}

function parseStringListFlag(flags, key) {
  if (!flags.has(key)) {
    return undefined;
  }
  const value = flagValue(flags, key);
  if (value === null) {
    throw new BrokerError(`Missing required flag --${key}.`, {
      reasonCode: "missing-flag",
    });
  }
  const entries = String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    throw new BrokerError(`Missing required flag --${key}.`, {
      reasonCode: "missing-flag",
    });
  }
  return entries;
}

function parseOptionalPositiveIntegerFlag(flags, key) {
  if (!flags.has(key)) {
    return undefined;
  }
  const parsed = parseIntegerFlag(flags, key);
  if (parsed === null) {
    throw new BrokerError(`Missing required flag --${key}.`, {
      reasonCode: "missing-flag",
    });
  }
  if (parsed <= 0) {
    throw new BrokerError(`Flag --${key} must be a positive integer.`, {
      reasonCode: "invalid-flag",
    });
  }
  return parsed;
}

function parseExplicitIntegerFlag(flags, key) {
  if (!flags.has(key)) {
    return undefined;
  }
  const parsed = parseIntegerFlag(flags, key);
  if (parsed === null) {
    throw new BrokerError(`Missing required flag --${key}.`, {
      reasonCode: "missing-flag",
    });
  }
  return parsed;
}

function parseMemoryCeilingBytes(flags) {
  const bytes = parseOptionalPositiveIntegerFlag(flags, "memory-ceiling-bytes");
  if (bytes !== undefined) {
    return bytes;
  }
  const mib = parseOptionalPositiveIntegerFlag(flags, "memory-ceiling-mib");
  if (mib !== undefined) {
    return mib * 1024 * 1024;
  }
  return undefined;
}

function rejectUnknownFlags(flags, allowedFlags) {
  for (const key of flags.keys()) {
    if (!allowedFlags.has(key)) {
      throw new BrokerError(`Unknown flag --${key}.`, {
        flag: key,
        reasonCode: "invalid-flag",
      });
    }
  }
}

function commonRequestFlags() {
  return [
    "help",
    "host-config",
    "json",
    "project-file",
    "repo-root",
    "service-socket",
    "state-root",
  ];
}

function parseBooleanFlag(flags, key, { defaultValue = false } = {}) {
  if (!flags.has(key)) {
    return defaultValue;
  }
  const value = flags.get(key);
  if (value === true) {
    return true;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new BrokerError(`Flag --${key} must be passed without a value or with true/false.`, {
    flag: key,
    reasonCode: "invalid-flag",
  });
}

function hostInitOptions(flags) {
  rejectUnknownFlags(flags, new Set([
    "bootstrap-config",
    "force",
    "host-config",
    "host-id",
    "ios-version",
    "project-file",
    "repo-root",
    "service-socket",
    "state-root",
    ...commonRequestFlags(),
  ]));
  return {
    bootstrapConfig: parseBooleanFlag(flags, "bootstrap-config"),
    force: parseBooleanFlag(flags, "force"),
    hostId: flagValue(flags, "host-id"),
    iosVersion: flagValue(flags, "ios-version"),
  };
}

export function format(payload) {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function eventFilters(flags) {
  const limit = flags.has("limit") ? requireNonNegativeIntegerFlag(flags, "limit") : null;
  return {
    afterEventId: flagValue(flags, "after-event-id"),
    alias: flagValue(flags, "alias"),
    limit: limit === null ? undefined : limit,
    projectId: flagValue(flags, "project-id"),
    purposeId: flagValue(flags, "purpose"),
    type: flagValue(flags, "type"),
  };
}

function eventWatchOptions(flags) {
  rejectUnknownFlags(flags, new Set([
    ...commonRequestFlags(),
    "after-event-id",
    "alias",
    "follow",
    "idle-timeout-ms",
    "json-lines",
    "limit",
    "poll-interval-ms",
    "project-id",
    "purpose",
    "type",
  ]));
  return eventFilters(flags);
}

function lifecycleOptions(flags) {
  rejectUnknownFlags(flags, new Set([
    "actor-id",
    "actor-type",
    "alias",
    "expected-alias",
    "expected-lease-id",
    "force-override",
    "job-id",
    "lease-file",
    "lease-id",
    "override-reason",
    ...commonRequestFlags(),
  ]));
  return {
    actorId: flagValue(flags, "actor-id"),
    actorType: flagValue(flags, "actor-type"),
    alias: requireFlag(flags, "alias"),
    expectedAlias: flagValue(flags, "expected-alias"),
    expectedLeaseId: flagValue(flags, "expected-lease-id"),
    forceOverride: parseBooleanFlag(flags, "force-override"),
    jobId: flagValue(flags, "job-id"),
    leaseFile: flagValue(flags, "lease-file"),
    leaseId: flagValue(flags, "lease-id"),
    overrideReason: flagValue(flags, "override-reason"),
  };
}

function projectInitOptions(paths, flags) {
  const repoRoot = flagValue(flags, "repo-root");
  const resolvedRepoRoot = repoRoot ? path.resolve(repoRoot) : null;
  return {
    iosVersion: flagValue(flags, "ios-version"),
    overwrite: parseBooleanFlag(flags, "overwrite"),
    projectFilePath: paths.projectFilePath ?? path.join(resolvedRepoRoot ?? process.cwd(), DEFAULT_PROJECT_FILE),
    projectId: flagValue(flags, "project-id"),
    projectName: flagValue(flags, "project-name"),
    repoRoot: resolvedRepoRoot,
  };
}

function capacityOptions(paths, flags, { applyAllowed = false } = {}) {
  const allowed = new Set([
    "actor-id",
    "actor-type",
    "apply",
    "confirm",
    "help",
    "host-config",
    "json",
    "project-file",
    "purpose",
    "repo-root",
    "service-socket",
    "state-root",
  ]);
  rejectUnknownFlags(flags, allowed);
  if (flags.has("apply") && applyAllowed === false) {
    throw new BrokerError("--apply is only valid for capacity reconcile.", {
      reasonCode: "invalid-flag",
    });
  }
  return {
    actorId: flagValue(flags, "actor-id"),
    actorType: flagValue(flags, "actor-type"),
    apply: parseBooleanFlag(flags, "apply"),
    confirmPlanId: flagValue(flags, "confirm"),
    projectFilePath: paths.projectFilePath,
    purposeId: flagValue(flags, "purpose"),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function helpPayload(group) {
  const help = {
    capacity: {
      commands: [
        "capacity check --repo-root <repo> [--purpose <purpose>] [--json]",
        "capacity reconcile --repo-root <repo> [--purpose <purpose>] [--json]",
        "capacity reconcile --repo-root <repo> [--purpose <purpose>] --apply --confirm <plan-id> --actor-type human --actor-id <operator-id> [--json]",
      ],
      group: "capacity",
      usage: "simbroker capacity <command>",
    },
    host: {
      commands: [
        "host init [--bootstrap-config] [--host-id <id>] [--ios-version <version>]",
        "host status",
      ],
      group: "host",
      usage: "simbroker host <command>",
    },
    project: {
      commands: [
        "project validate --repo-root <repo> [--json]",
        "project show --repo-root <repo> [--json]",
        "project init --repo-root <repo> [--project-id <id>] [--project-name <name>]",
        "project forget --project-id <id> [--json]",
      ],
      group: "project",
      usage: "simbroker project <command>",
    },
    lease: {
      commands: [
        "lease acquire --purpose <purpose> [--lease-file <path>] [--owner-pid <pid>] [--owner-pgid <pgid>]",
        "lease register-process --lease-file <path> --pid <pid> [--pgid <pgid>] [--command <command>]",
        "lease contain --lease-file <path> --reason <memory-ceiling|forced-abort|timeout|manual-cleanup>",
        "lease explain --purpose <purpose>",
        "lease show --lease-file <path>|--lease-id <id>",
        "lease release --lease-file <path>|--lease-id <id>",
      ],
      group: "lease",
      usage: "simbroker lease <command>",
    },
  };
  return {
    ok: true,
    ...(help[group] ?? {
      commands: [
        "host",
        "project",
        "lease",
        "capacity",
        "events",
        "pin",
        "simulators",
        "service",
      ],
      group: "global",
      usage: "simbroker <group> <command> [flags]",
    }),
  };
}

export function createCommandRequest(paths, group, command, flags) {
  if (flags.has("help") || group === "help" || command === "help") {
    return {
      group: "help",
      command: group && group !== "help" ? group : "global",
      options: {},
      type: "command",
    };
  }

  switch (`${group ?? ""}:${command ?? ""}`) {
    case ":":
    case "undefined:undefined":
      return {
        group: "help",
        command: "global",
        options: {},
        type: "command",
      };
    case "host:":
    case "project:":
    case "lease:":
    case "capacity:":
      return {
        group: "help",
        command: group,
        options: {},
        type: "command",
      };
    case "doctor:":
    case "doctor:status":
    case "doctor:doctor":
      return {
        group: "doctor",
        command: "status",
        options: {},
        type: "command",
      };
    case "project:validate":
      return {
        group: "project",
        command: "validate",
        options: {
          projectFilePath: paths.projectFilePath,
        },
        type: "command",
      };
    case "project:show":
      return {
        group: "project",
        command: "show",
        options: {
          projectFilePath: paths.projectFilePath,
        },
        type: "command",
      };
    case "project:init":
      return {
        group: "project",
        command: "init",
        options: projectInitOptions(paths, flags),
        type: "command",
      };
    case "project:forget":
      rejectUnknownFlags(flags, new Set([
        "project-id",
        ...commonRequestFlags(),
      ]));
      return {
        group: "project",
        command: "forget",
        options: {
          projectId: requireFlag(flags, "project-id"),
        },
        type: "command",
      };
    case "host:init":
      return {
        group: "host",
        command: "init",
        options: hostInitOptions(flags),
        type: "command",
      };
    case "host:status":
      return {
        group: "host",
        command: "status",
        options: {},
        type: "command",
      };
    case "capacity:check":
      return {
        group: "capacity",
        command: "check",
        options: capacityOptions(paths, flags),
        type: "command",
      };
    case "capacity:reconcile":
      return {
        group: "capacity",
        command: "reconcile",
        options: capacityOptions(paths, flags, { applyAllowed: true }),
        type: "command",
      };
    case "simulators:list":
      return {
        group: "simulators",
        command: "list",
        options: {},
        type: "command",
      };
    case "simulators:boot":
      return {
        group: "simulators",
        command: "boot",
        options: lifecycleOptions(flags),
        type: "command",
      };
    case "simulators:shutdown":
      return {
        group: "simulators",
        command: "shutdown",
        options: lifecycleOptions(flags),
        type: "command",
      };
    case "simulators:erase":
      return {
        group: "simulators",
        command: "erase",
        options: lifecycleOptions(flags),
        type: "command",
      };
    case "simulators:repair":
      return {
        group: "simulators",
        command: "repair",
        options: lifecycleOptions(flags),
        type: "command",
      };
    case "lease:acquire":
      {
        rejectUnknownFlags(flags, new Set([
          "actor-id",
          "actor-type",
          "alias",
          "evidence-dir",
          "job-id",
          "job-kind",
          "lease-file",
          "memory-ceiling-bytes",
          "memory-ceiling-mib",
          "monitor-interval-ms",
          "owner-pgid",
          "owner-pid",
          "purpose",
          "session-dir",
          "simulator-process-names",
          ...commonRequestFlags(),
        ]));
        const ownerPid = parseExplicitIntegerFlag(flags, "owner-pid");
        const ownerPgid = parseExplicitIntegerFlag(flags, "owner-pgid");
        const monitorIntervalMs = parseExplicitIntegerFlag(flags, "monitor-interval-ms");
        const options = {
          actorId: flagValue(flags, "actor-id"),
          actorType: flagValue(flags, "actor-type"),
          alias: flagValue(flags, "alias"),
          clientPid: process.pid,
          evidenceDir: flagValue(flags, "evidence-dir"),
          jobId: flagValue(flags, "job-id"),
          jobKind: flagValue(flags, "job-kind"),
          leaseFile: flagValue(flags, "lease-file"),
          memoryCeilingBytes: parseMemoryCeilingBytes(flags),
          ownerPid: ownerPid ?? process.ppid,
          projectFilePath: paths.projectFilePath,
          purposeId: requireFlag(flags, "purpose"),
          sessionDir: flagValue(flags, "session-dir"),
          simulatorProcessNames: parseStringListFlag(flags, "simulator-process-names"),
        };
        if (monitorIntervalMs !== undefined) {
          options.monitorIntervalMs = monitorIntervalMs;
        }
        if (ownerPgid !== undefined) {
          options.ownerPgid = ownerPgid;
        }
        return {
          group: "lease",
          command: "acquire",
          options,
          type: "command",
        };
      }
    case "lease:register-process":
      {
        rejectUnknownFlags(flags, new Set([
          "command",
          "evidence-dir",
          "lease-file",
          "lease-id",
          "memory-ceiling-bytes",
          "memory-ceiling-mib",
          "monitor-interval-ms",
          "owner-pgid",
          "owner-pid",
          "pgid",
          "pid",
          "simulator-process-names",
          ...commonRequestFlags(),
        ]));
        const command = optionalFlagValue(flags, "command");
        const commandPgid = parseExplicitIntegerFlag(flags, "pgid");
        const monitorIntervalMs = parseExplicitIntegerFlag(flags, "monitor-interval-ms");
        const ownerPgid = parseExplicitIntegerFlag(flags, "owner-pgid");
        const ownerPid = parseExplicitIntegerFlag(flags, "owner-pid");
        const options = {
          commandPid: requirePositiveIntegerFlag(flags, "pid"),
          evidenceDir: flagValue(flags, "evidence-dir"),
          leaseFile: flagValue(flags, "lease-file"),
          leaseId: flagValue(flags, "lease-id"),
          memoryCeilingBytes: parseMemoryCeilingBytes(flags),
          simulatorProcessNames: parseStringListFlag(flags, "simulator-process-names"),
        };
        if (command !== undefined) {
          options.command = command;
        }
        if (commandPgid !== undefined) {
          options.commandPgid = commandPgid;
        }
        if (monitorIntervalMs !== undefined) {
          options.monitorIntervalMs = monitorIntervalMs;
        }
        if (ownerPgid !== undefined) {
          options.ownerPgid = ownerPgid;
        }
        if (ownerPid !== undefined) {
          options.ownerPid = ownerPid;
        }
        return {
          group: "lease",
          command: "register-process",
          options,
          type: "command",
        };
      }
    case "lease:contain":
      {
        rejectUnknownFlags(flags, new Set([
          "capture-diagnostics",
          "kill-owner",
          "lease-file",
          "lease-id",
          "reason",
          "term-wait-ms",
          ...commonRequestFlags(),
        ]));
        return {
          group: "lease",
          command: "contain",
          options: {
            captureDiagnostics: parseBooleanFlag(flags, "capture-diagnostics"),
            killOwner: parseBooleanFlag(flags, "kill-owner"),
            leaseFile: flagValue(flags, "lease-file"),
            leaseId: flagValue(flags, "lease-id"),
            reason: optionalFlagValue(flags, "reason") ?? "manual-cleanup",
            requesterPid: process.pid,
            termWaitMs: flags.has("term-wait-ms")
              ? requireNonNegativeIntegerFlag(flags, "term-wait-ms")
              : undefined,
          },
          type: "command",
        };
      }
    case "lease:release":
      {
        rejectUnknownFlags(flags, new Set([
          "actor-id",
          "actor-type",
          "lease-file",
          "lease-id",
          ...commonRequestFlags(),
        ]));
        return {
          group: "lease",
          command: "release",
          options: {
            actorId: flagValue(flags, "actor-id"),
            actorType: flagValue(flags, "actor-type"),
            leaseFile: flagValue(flags, "lease-file"),
            leaseId: flagValue(flags, "lease-id"),
          },
          type: "command",
        };
      }
    case "pin:create":
      {
        rejectUnknownFlags(flags, new Set([
          "actor-id",
          "actor-type",
          "alias",
          "note",
          "purpose",
          ...commonRequestFlags(),
        ]));
        return {
          group: "pin",
          command: "create",
          options: {
            actorId: flagValue(flags, "actor-id"),
            actorType: flagValue(flags, "actor-type"),
            alias: requireFlag(flags, "alias"),
            note: flagValue(flags, "note"),
            projectFilePath: paths.projectFilePath,
            purposeId: requireFlag(flags, "purpose"),
          },
          type: "command",
        };
      }
    case "pin:clear":
      {
        rejectUnknownFlags(flags, new Set([
          "actor-id",
          "actor-type",
          "alias",
          ...commonRequestFlags(),
        ]));
        return {
          group: "pin",
          command: "clear",
          options: {
            actorId: flagValue(flags, "actor-id"),
            actorType: flagValue(flags, "actor-type"),
            alias: requireFlag(flags, "alias"),
          },
          type: "command",
        };
      }
    case "lease:explain":
      return {
        group: "lease",
        command: "explain",
        options: {
          alias: flagValue(flags, "alias"),
          projectFilePath: paths.projectFilePath,
          purposeId: requireFlag(flags, "purpose"),
        },
        type: "command",
      };
    case "lease:show":
      return {
        group: "lease",
        command: "show",
        options: {
          actorId: flagValue(flags, "actor-id"),
          actorType: flagValue(flags, "actor-type"),
          leaseFile: flagValue(flags, "lease-file"),
          leaseId: flagValue(flags, "lease-id"),
        },
        type: "command",
      };
    case "events:watch":
      {
        const follow = parseBooleanFlag(flags, "follow");
        const jsonLines = parseBooleanFlag(flags, "json-lines");
        const options = eventWatchOptions(flags);
        if (follow || jsonLines) {
          return {
            group: "events",
            command: "watch",
            options: {
              ...options,
              follow,
              idleTimeoutMs: parseIntegerFlag(flags, "idle-timeout-ms"),
              jsonLines,
              pollIntervalMs: flags.has("poll-interval-ms")
                ? requirePositiveIntegerFlag(flags, "poll-interval-ms")
                : 250,
            },
            type: "events-stream",
          };
        }
        return {
          group: "events",
          command: "watch",
          options,
          type: "command",
        };
      }
    case "app:snapshot":
      return {
        group: "app",
        command: "snapshot",
        options: {
          eventLimit: flags.has("event-limit")
            ? requireNonNegativeIntegerFlag(flags, "event-limit")
            : 50,
        },
        type: "command",
      };
    default:
      throw new BrokerError("Unknown simbroker command.", {
        command: [group, command].filter(Boolean).join(" "),
        reasonCode: "unknown-command",
      });
  }
}

function contractSnapshotRefreshError(error) {
  if (error instanceof BrokerError || typeof error?.reasonCode === "string") {
    return error;
  }
  if (error?.timedOut === true) {
    return new BrokerError("simctl timed out while refreshing the app snapshot.", {
      cause: error?.message ?? String(error),
      command: Array.isArray(error?.command) ? error.command : undefined,
      reasonCode: "simctl-timeout",
      timeoutMs: error?.timeoutMs,
    });
  }
  return null;
}

export function executeBrokerCommand(paths, request) {
  const options = request.options ?? {};
  let payload = null;

  switch (`${request.group}:${request.command}`) {
    case "help:global":
    case "help:host":
    case "help:project":
    case "help:lease":
    case "help:capacity":
      return helpPayload(request.command);
    case "doctor:status":
      payload = doctorBroker(paths, options);
      break;
    case "project:validate":
      payload = validateProjectBroker(paths, options);
      break;
    case "project:show":
      payload = showProjectBroker(paths, options);
      break;
    case "project:init":
      payload = initProjectBroker(paths, options);
      break;
    case "project:forget":
      payload = forgetKnownProjectBroker(paths, options);
      break;
    case "host:init":
      payload = initBroker(paths, options);
      break;
    case "host:status":
      payload = hostStatusBroker(paths, options);
      break;
    case "capacity:check":
      payload = checkCapacityBroker(paths, options);
      break;
    case "capacity:reconcile":
      payload = reconcileCapacityBroker(paths, options);
      break;
    case "simulators:list":
      payload = listSimulatorsBroker(paths, options);
      break;
    case "simulators:boot":
      payload = bootSimulatorBroker(paths, options);
      break;
    case "simulators:shutdown":
      payload = shutdownSimulatorBroker(paths, options);
      break;
    case "simulators:erase":
      payload = eraseSimulatorBroker(paths, options);
      break;
    case "simulators:repair":
      payload = repairSimulatorBroker(paths, options);
      break;
    case "lease:acquire":
      payload = acquireLeaseBroker(paths, options);
      break;
    case "lease:register-process":
      payload = registerLeaseProcessBroker(paths, options);
      break;
    case "lease:contain":
      payload = containLeaseBroker(paths, options);
      break;
    case "lease:explain":
      payload = explainLeaseBroker(paths, options);
      break;
    case "lease:show":
      payload = showLeaseBroker(paths, options);
      break;
    case "lease:release":
      payload = releaseLeaseBroker(paths, options);
      break;
    case "events:watch":
      return readEventsBroker(paths, options);
    case "app:snapshot":
      payload = appSnapshotBroker(paths, options);
      break;
    case "pin:create":
      payload = createPinBroker(paths, options);
      break;
    case "pin:clear":
      payload = clearPinBroker(paths, options);
      break;
    default:
      throw new BrokerError("Unknown broker command request.", {
        command: `${request.group}:${request.command}`,
        reasonCode: "unknown-command",
      });
  }

  const snapshotOptions = {
    leaseLockTimeoutMilliseconds: options.leaseLockTimeoutMilliseconds,
    processExists: options.processExists,
    processSampler: options.processSampler,
    simctlAdapter: options.simctlAdapter,
  };
  const snapshotLeaseId = request.group === "lease" && request.command === "contain"
    ? payload?.leaseId
    : request.group === "lease" && request.command === "register-process"
      ? payload?.lease?.leaseId
      : null;
  if (snapshotLeaseId) {
    snapshotOptions.skipLeaseIds = [snapshotLeaseId];
  }
  const isReadOnlyCapacityCommand = request.group === "capacity" && options.apply !== true;
  if (!isReadOnlyCapacityCommand) {
    try {
      writeAppSnapshotArtifactUnderMutationLock(paths, snapshotOptions);
    } catch (error) {
      const contractError = contractSnapshotRefreshError(error);
      if (contractError) {
        throw contractError;
      }
      payload = {
        ...payload,
        snapshotRefresh: {
          error: error?.message ?? String(error),
          ok: false,
        },
      };
    }
  }
  return payload;
}

function defaultWriteEventLine(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

export async function streamEventsLocal(paths, options = {}, { signal, sleepFn = sleep, writeEventLine = defaultWriteEventLine } = {}) {
  let cursor = options.afterEventId ?? null;
  let didInitialRead = false;
  let lastEmissionAt = Date.now();

  while (true) {
    if (signal?.aborted) {
      return {
        cancelled: true,
        cursor,
        handled: true,
      };
    }

    const payload = readEventsBroker(paths, {
      alias: options.alias ?? null,
      afterEventId: cursor,
      limit: options.limit,
      limitMode: options.follow && (didInitialRead || cursor !== null) ? "head" : "tail",
      projectId: options.projectId ?? null,
      purposeId: options.purposeId ?? null,
      type: options.type ?? null,
    });
    didInitialRead = true;
    const nextCursor = payload.nextCursor ?? payload.scannedCursor ?? payload.cursor;

    if (payload.events.length > 0) {
      for (const event of payload.events) {
        await writeEventLine(event);
      }
      lastEmissionAt = Date.now();
    }
    cursor = nextCursor;

    if (!options.follow) {
      return {
        cursor,
        handled: true,
      };
    }
    if (options.idleTimeoutMs !== null && options.idleTimeoutMs !== undefined
      && Date.now() - lastEmissionAt >= options.idleTimeoutMs) {
      return {
        cursor,
        handled: true,
      };
    }
    await sleepFn(options.pollIntervalMs ?? 250);
  }
}
