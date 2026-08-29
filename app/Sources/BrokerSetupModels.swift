import Foundation

enum BrokerSetupStatus: String, Decodable, Sendable {
  case blocked
  case changesRequired = "changes_required"
  case ready
}

enum BrokerSetupPhase: Equatable, Sendable {
  case idle
  case previewing
  case awaitingConfirmation
  case applying
}

struct BrokerSetupPrerequisiteDetails: Decodable, Equatable, Sendable {
  let availableBytes: Int64?
  let availableGiB: String?
  let developerDirectory: String?
  let error: String?
  let version: String?
}

struct BrokerSetupPrerequisite: Decodable, Equatable, Identifiable, Sendable {
  let details: BrokerSetupPrerequisiteDetails?
  let id: String
  let remediationCommands: [String]
  let status: String
  let summary: String
}

struct BrokerSetupHostPlan: Decodable, Equatable, Sendable {
  let action: String
  let configured: Bool
  let hostId: String?
}

struct BrokerSetupRuntimePlan: Decodable, Equatable, Sendable {
  let buildVersion: String?
  let identifier: String
  let selectionSource: String
  let version: String
}

struct BrokerSetupDevicePlan: Decodable, Equatable, Identifiable, Sendable {
  var id: String { alias }

  let action: String
  let alias: String
  let capabilities: [String]
  let deviceFamily: String
  let deviceTypeIdentifier: String?
  let deviceTypeName: String
  let displayName: String
  let resetPolicy: String
  let runtimeIdentifier: String?
  let runtimeVersion: String
  let simulatorName: String?
}

struct BrokerSetupServicePlan: Decodable, Equatable, Sendable {
  let action: String
  let running: Bool
}

struct BrokerSetupConfirmation: Decodable, Equatable, Sendable {
  let createCount: Int
  let required: Bool
  let reuseCount: Int
}

struct BrokerSetupPlan: Decodable, Equatable, Identifiable, Sendable {
  static let supportedSchemaVersion = 1

  var id: String { planId }

  let command: String
  let confirmation: BrokerSetupConfirmation
  let devices: [BrokerSetupDevicePlan]
  let host: BrokerSetupHostPlan
  let mode: String
  let nextSteps: [String]
  let ok: Bool
  let planId: String
  let prerequisites: [BrokerSetupPrerequisite]
  let runtime: BrokerSetupRuntimePlan?
  let schemaVersion: Int
  let service: BrokerSetupServicePlan
  let status: BrokerSetupStatus

  init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
    guard schemaVersion == Self.supportedSchemaVersion else {
      throw DecodingError.dataCorruptedError(
        forKey: .schemaVersion,
        in: container,
        debugDescription: "Unsupported setup schema version \(schemaVersion)."
      )
    }
    command = try container.decode(String.self, forKey: .command)
    confirmation = try container.decode(BrokerSetupConfirmation.self, forKey: .confirmation)
    devices = try container.decode([BrokerSetupDevicePlan].self, forKey: .devices)
    host = try container.decode(BrokerSetupHostPlan.self, forKey: .host)
    mode = try container.decode(String.self, forKey: .mode)
    nextSteps = try container.decode([String].self, forKey: .nextSteps)
    ok = try container.decode(Bool.self, forKey: .ok)
    planId = try container.decode(String.self, forKey: .planId)
    prerequisites = try container.decode([BrokerSetupPrerequisite].self, forKey: .prerequisites)
    runtime = try container.decodeIfPresent(BrokerSetupRuntimePlan.self, forKey: .runtime)
    service = try container.decode(BrokerSetupServicePlan.self, forKey: .service)
    status = try container.decode(BrokerSetupStatus.self, forKey: .status)
  }

  private enum CodingKeys: String, CodingKey {
    case command
    case confirmation
    case devices
    case host
    case mode
    case nextSteps
    case ok
    case planId
    case prerequisites
    case runtime
    case schemaVersion
    case service
    case status
  }
}
