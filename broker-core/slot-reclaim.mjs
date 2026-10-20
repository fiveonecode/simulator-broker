export const SLOT_RECLAIM_SCHEMA_VERSION = 1;
export const DEFAULT_SLOT_RECLAIM_MAX_LEASES_SINCE_ERASE = 8;
export const DEFAULT_SLOT_RECLAIM_MAX_AGE_SECONDS = 86_400;
export const DEFAULT_SLOT_RECLAIM_MAX_DISK_BYTES = 8 * 1024 * 1024 * 1024;
export const SLOT_RECLAIM_CLASS_BUILD = "build";
export const SLOT_RECLAIM_CLASS_MANUAL = "manual";
export const SLOT_RECLAIM_REASONS = Object.freeze(["disk", "leases", "age"]);

export const DEFAULT_SLOT_RECLAIM_CLASS_POLICY = Object.freeze({
  enabled: true,
  maxAgeSeconds: DEFAULT_SLOT_RECLAIM_MAX_AGE_SECONDS,
  maxDiskBytes: DEFAULT_SLOT_RECLAIM_MAX_DISK_BYTES,
  maxLeasesSinceErase: DEFAULT_SLOT_RECLAIM_MAX_LEASES_SINCE_ERASE,
});

export const DEFAULT_SLOT_RECLAIM_POLICY = Object.freeze({
  enabled: true,
  build: Object.freeze({
    ...DEFAULT_SLOT_RECLAIM_CLASS_POLICY,
    enabled: true,
  }),
  manual: Object.freeze({
    ...DEFAULT_SLOT_RECLAIM_CLASS_POLICY,
    enabled: false,
  }),
});

function cloneClassPolicy(policy) {
  return {
    enabled: policy.enabled,
    maxAgeSeconds: policy.maxAgeSeconds,
    maxDiskBytes: policy.maxDiskBytes,
    maxLeasesSinceErase: policy.maxLeasesSinceErase,
  };
}

export function resolveSlotReclaimPolicy(rawPolicy = null) {
  const source = rawPolicy && typeof rawPolicy === "object" && !Array.isArray(rawPolicy)
    ? rawPolicy
    : {};
  const buildSource = source.build && typeof source.build === "object" && !Array.isArray(source.build)
    ? source.build
    : {};
  const manualSource = source.manual && typeof source.manual === "object" && !Array.isArray(source.manual)
    ? source.manual
    : {};
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : DEFAULT_SLOT_RECLAIM_POLICY.enabled,
    build: {
      ...cloneClassPolicy(DEFAULT_SLOT_RECLAIM_POLICY.build),
      ...pickDefined(buildSource, ["enabled", "maxAgeSeconds", "maxDiskBytes", "maxLeasesSinceErase"]),
    },
    manual: {
      ...cloneClassPolicy(DEFAULT_SLOT_RECLAIM_POLICY.manual),
      ...pickDefined(manualSource, ["enabled", "maxAgeSeconds", "maxDiskBytes", "maxLeasesSinceErase"]),
    },
  };
}

function pickDefined(source, keys) {
  const selected = {};
  for (const key of keys) {
    if (source[key] !== undefined) {
      selected[key] = source[key];
    }
  }
  return selected;
}

export function classifyReclaimSlot(hostAlias) {
  if (!hostAlias || hostAlias.resetPolicy === "erase-on-acquire") {
    return null;
  }
  const capabilities = Array.isArray(hostAlias.capabilities) ? hostAlias.capabilities : [];
  if (capabilities.includes("manual-persistent")) {
    return SLOT_RECLAIM_CLASS_MANUAL;
  }
  if (capabilities.includes("build-fast")) {
    return SLOT_RECLAIM_CLASS_BUILD;
  }
  return null;
}

export function isSlotHeldForReclaim({
  acquiring = false,
  activeLease = null,
  activePin = null,
  registryEntry = null,
} = {}) {
  if (acquiring === true) {
    return true;
  }
  if (activeLease) {
    return true;
  }
  if (typeof registryEntry?.activeLeaseId === "string" && registryEntry.activeLeaseId.trim() !== "") {
    return true;
  }
  if (activePin) {
    return true;
  }
  return false;
}

export function lastUsedAtForSlot(registryEntry) {
  if (!registryEntry || typeof registryEntry !== "object") {
    return null;
  }
  for (const field of ["lastLeaseReleasedAt", "lastLeaseStartedAt", "lastBootedAt"]) {
    if (typeof registryEntry[field] === "string" && registryEntry[field].trim() !== "") {
      return registryEntry[field];
    }
  }
  return null;
}

export function evaluateSlotReclaim({
  className,
  diskBytes = null,
  held = false,
  lastErasedAt = null,
  lastUsedAt = null,
  leasesSinceErase = 0,
  nowMs,
  policy,
} = {}) {
  if (held) {
    return { reclaim: false, skipReason: "held" };
  }
  if (!className) {
    return { reclaim: false, skipReason: "not-reclaimable" };
  }
  const resolvedPolicy = resolveSlotReclaimPolicy(policy);
  if (resolvedPolicy.enabled !== true) {
    return { reclaim: false, skipReason: "disabled" };
  }
  const classPolicy = resolvedPolicy[className];
  if (!classPolicy || classPolicy.enabled !== true) {
    return { reclaim: false, skipReason: "class-disabled" };
  }

  if (Number.isFinite(diskBytes) && diskBytes >= classPolicy.maxDiskBytes) {
    return { className, reason: "disk", reclaim: true };
  }
  if (Number.isFinite(leasesSinceErase) && leasesSinceErase >= classPolicy.maxLeasesSinceErase) {
    return { className, reason: "leases", reclaim: true };
  }

  const ageAnchor = typeof lastErasedAt === "string" && lastErasedAt.trim() !== ""
    ? lastErasedAt
    : lastUsedAt;
  if (typeof ageAnchor === "string") {
    const anchorMs = Date.parse(ageAnchor);
    if (Number.isFinite(anchorMs) && Number.isFinite(nowMs)
      && nowMs - anchorMs >= classPolicy.maxAgeSeconds * 1_000) {
      return { className, reason: "age", reclaim: true };
    }
  }

  return { reclaim: false, skipReason: "below-threshold" };
}

function formatBytes(bytes) {
  const gib = bytes / (1024 * 1024 * 1024);
  if (Number.isInteger(gib)) {
    return `${gib} GiB`;
  }
  return `${bytes} bytes`;
}

function formatClassPolicy(classPolicy) {
  if (classPolicy.enabled !== true) {
    return "off";
  }
  return `on (every ${classPolicy.maxLeasesSinceErase} leases, ${classPolicy.maxAgeSeconds}s, or ${formatBytes(classPolicy.maxDiskBytes)})`;
}

export function formatSlotReclaimPolicyLine(policy) {
  const resolved = resolveSlotReclaimPolicy(policy);
  if (resolved.enabled !== true) {
    return "disabled";
  }
  return `build ${formatClassPolicy(resolved.build)}, manual ${formatClassPolicy(resolved.manual)}`;
}

export function summarizeSlotReclaimPolicy(policy) {
  const resolved = resolveSlotReclaimPolicy(policy);
  return {
    build: cloneClassPolicy(resolved.build),
    enabled: resolved.enabled,
    manual: cloneClassPolicy(resolved.manual),
    schemaVersion: SLOT_RECLAIM_SCHEMA_VERSION,
  };
}
