import Foundation

struct BrokerAppSnapshot: Decodable, Sendable {
  let activeLeases: [BrokerLease]
  let generatedAt: String
  let hostConfigPath: String?
  let hostId: String
  let idle: BrokerIdleSummary
  let ok: Bool
  let overview: BrokerOverview
  let pins: [BrokerPin]
  let projects: [BrokerProjectSummary]
  let recentEvents: [BrokerEvent]
  let simulators: [BrokerSimulator]
  let stateRoot: String

  private enum CodingKeys: String, CodingKey {
    case activeLeases
    case generatedAt
    case hostConfigPath
    case hostId
    case idle
    case ok
    case overview
    case pins
    case projects
    case recentEvents
    case simulators
    case stateRoot
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    activeLeases = try container.decode([BrokerLease].self, forKey: .activeLeases)
    generatedAt = try container.decode(String.self, forKey: .generatedAt)
    hostConfigPath = try container.decodeIfPresent(String.self, forKey: .hostConfigPath)
    hostId = try container.decode(String.self, forKey: .hostId)
    idle = try container.decodeIfPresent(BrokerIdleSummary.self, forKey: .idle) ?? .unconfigured
    ok = try container.decode(Bool.self, forKey: .ok)
    overview = try container.decode(BrokerOverview.self, forKey: .overview)
    pins = try container.decode([BrokerPin].self, forKey: .pins)
    projects = try container.decode([BrokerProjectSummary].self, forKey: .projects)
    recentEvents = try container.decode([BrokerEvent].self, forKey: .recentEvents)
    simulators = try container.decode([BrokerSimulator].self, forKey: .simulators)
    stateRoot = try container.decode(String.self, forKey: .stateRoot)
  }
}

struct BrokerIdleSummary: Decodable, Sendable {
  let configured: Bool
  let eligibleCount: Int
  let graceSeconds: Int?
  let lastCleanupResult: BrokerIdleCleanupResult?
  let nextScheduledCleanupAt: String?

  static let unconfigured = BrokerIdleSummary(
    configured: false,
    eligibleCount: 0,
    graceSeconds: nil,
    lastCleanupResult: nil,
    nextScheduledCleanupAt: nil
  )
}

struct BrokerIdleCleanupResult: Decodable, Sendable {
  let completedAt: String
  let eligibleCount: Int
  let failureCount: Int
  let shutdownCount: Int
  let source: String
  let status: String
}

struct BrokerOverview: Decodable, Sendable {
  let leaseSaturation: Double
  let leasedAliases: Int
  let pinnedAliases: Int
  let totalAliases: Int
  let unhealthyAliases: Int
}

struct BrokerLeaseSummary: Decodable, Sendable {
  let actorId: String
  let actorType: String
  let jobId: String?
  let leaseId: String
  let projectId: String
  let purposeId: String
}

struct BrokerPinSummary: Decodable, Sendable {
  let pinId: String
  let projectId: String
  let purposeId: String?
}

struct BrokerSimulator: Decodable, Identifiable, Sendable {
  let activeLeaseId: String?
  let activeLeaseSummary: BrokerLeaseSummary?
  let alias: String
  let capabilities: [String]
  let deviceFamily: String
  let displayName: String
  let driftReason: String?
  let health: String
  let iosVersion: String
  let lastBootedAt: String?
  let lastErasedAt: String?
  let lastLeaseReleasedAt: String?
  let lastLeaseStartedAt: String?
  let lastRepairedAt: String?
  let lastShutdownAt: String?
  let pin: BrokerPinSummary?
  let powerState: String
  let resetPolicy: String?
  let simulatorId: String

  var id: String { alias }
}

struct BrokerLease: Decodable, Identifiable, Sendable {
  let actorId: String
  let actorType: String
  let alias: String
  let artifactPath: String?
  let displayName: String
  let expiresAt: String?
  let jobId: String?
  let jobKind: String?
  let leaseId: String
  let leaseKind: String
  let ownerPid: Int
  let pinId: String?
  let projectId: String
  let projectName: String
  let purposeId: String
  let repoRoot: String
  let resetPolicy: String?
  let sessionDir: String?
  let simulatorId: String
  let startedAt: String

  var id: String { leaseId }
}

struct BrokerPin: Decodable, Identifiable, Sendable {
  let actorId: String
  let actorType: String
  let alias: String
  let createdAt: String
  let note: String?
  let pinId: String
  let projectId: String
  let projectName: String
  let purposeId: String?
  let repoRoot: String

  var id: String { pinId }
}

struct BrokerPurposeRequires: Decodable, Sendable {
  let deviceFamily: String?
  let iosVersion: String?
}

struct BrokerProjectPurposeSummary: Decodable, Identifiable, Sendable {
  let activeLeaseCount: Int
  let capability: String?
  let defaultActorType: String?
  let displayName: String
  let pinnedAliasCount: Int
  let purposeId: String
  let requires: BrokerPurposeRequires?

  var id: String { purposeId }
}

struct BrokerProjectSummary: Decodable, Identifiable, Sendable {
  let activeAliases: [String]
  let activeLeaseCount: Int
  let lastEventAt: String?
  let pinnedAliasCount: Int
  let projectFilePath: String?
  let projectId: String
  let projectName: String
  let purposes: [BrokerProjectPurposeSummary]
  let repoRoot: String?

  var id: String { projectId }
}

struct BrokerEvent: Decodable, Identifiable, Sendable {
  let actorId: String?
  let actorType: String?
  let alias: String?
  let eventId: String
  let jobId: String?
  let leaseId: String?
  let projectId: String?
  let purposeId: String?
  let timestamp: String
  let type: String

  var id: String { eventId }

  private enum CodingKeys: String, CodingKey {
    case actorId
    case actorType
    case alias
    case eventId
    case jobId
    case leaseId
    case payload
    case projectId
    case purposeId
    case timestamp
    case type
  }

  private struct Payload: Decodable {
    let actorId: String?
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let payload = try container.decodeIfPresent(Payload.self, forKey: .payload)
    actorId = try container.decodeIfPresent(String.self, forKey: .actorId) ?? payload?.actorId
    actorType = try container.decodeIfPresent(String.self, forKey: .actorType)
    alias = try container.decodeIfPresent(String.self, forKey: .alias)
    eventId = try container.decode(String.self, forKey: .eventId)
    jobId = try container.decodeIfPresent(String.self, forKey: .jobId)
    leaseId = try container.decodeIfPresent(String.self, forKey: .leaseId)
    projectId = try container.decodeIfPresent(String.self, forKey: .projectId)
    purposeId = try container.decodeIfPresent(String.self, forKey: .purposeId)
    timestamp = try container.decode(String.self, forKey: .timestamp)
    type = try container.decode(String.self, forKey: .type)
  }
}

struct BrokerServiceMetadata: Decodable, Sendable {
  let hostConfigPath: String
  let pid: Int
  let socketPath: String
  let startedAt: String
  let stateRoot: String
  let transport: String
}
