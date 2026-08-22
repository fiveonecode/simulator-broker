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
}
