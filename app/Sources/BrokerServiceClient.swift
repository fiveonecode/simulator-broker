import Foundation

enum BrokerLifecycleAction: String, CaseIterable, Identifiable, Sendable {
  case boot
  case shutdown
  case erase
  case repair

  var id: String { rawValue }

  var commandName: String { rawValue }

  var confirmationButtonTitle: String {
    switch self {
    case .boot:
      return "Boot simulator"
    case .shutdown:
      return "Shutdown simulator"
    case .erase:
      return "Erase simulator"
    case .repair:
      return "Repair simulator"
    }
  }

  var successMessage: String {
    switch self {
    case .boot:
      return "Simulator booted."
    case .shutdown:
      return "Simulator shut down."
    case .erase:
      return "Simulator erased."
    case .repair:
      return "Simulator repaired."
    }
  }

  var requiresDestructiveConfirmation: Bool {
    self == .erase || self == .repair
  }
}

enum BrokerJSONValue: Sendable {
  case bool(Bool)
  case int(Int)
  case null
  case string(String)

  var jsonObject: Any {
    switch self {
    case let .bool(value):
      return value
    case let .int(value):
      return value
    case .null:
      return NSNull()
    case let .string(value):
      return value
    }
  }

  var boolValue: Bool? {
    guard case let .bool(value) = self else {
      return nil
    }
    return value
  }

  var intValue: Int? {
    guard case let .int(value) = self else {
      return nil
    }
    return value
  }

  var stringValue: String? {
    guard case let .string(value) = self else {
      return nil
    }
    return value
  }
}

struct BrokerCommandTimeoutBudget: Sendable {
  let executionTimeoutSeconds: Int
  let queueTimeoutSeconds: Int

  var transferTimeoutSeconds: Int {
    executionTimeoutSeconds + queueTimeoutSeconds
  }
}

struct BrokerCommandRequest: Sendable {
  private static let capacityApplyFinalSnapshotStateLoads = 1
  private static let capacityApplyFinalizationStateLoads = 1
  private static let capacityApplyPlanEvaluations = 2
  private static let capacityApplyTimeoutSeconds = 5 * 60
  private static let capacityRollbackInventoryCommands = 3
  private static let capacityRollbackSimctlCommandsPerAction = 4
  private static let containmentDiagnosticTimeoutSeconds = 20
  private static let defaultContainmentPostKillWaitMilliseconds = 50
  private static let defaultContainmentTermWaitMilliseconds = 250
  private static let defaultCommandQueueTimeoutSeconds = 60
  private static let defaultCommandTimeoutSeconds = 30
  private static let defaultLockTimeoutMilliseconds = 60_000
  private static let defaultResetSettleMilliseconds = 250
  private static let hostBootstrapAliasCount = 6
  private static let hostBootstrapBaselineStateLoads = 1
  private static let hostBootstrapReplacementStateLoads = 1
  private static let hostBootstrapRetirementStateLoads = 1
  private static let hostBootstrapSimctlCommandsPerAlias = 5
  private static let leaseAcquireSimctlCommands = 4
  private static let processSamplerInvocationsPerStateLoad = 1
  private static let processSamplerTimeoutSeconds = 10
  private static let simctlInventoryCommandsPerStateLoad = 3
  private static let capacitySimctlCommandsPerAction = 4
  private static let simctlCommandTimeoutSeconds = 120
  private static let staleContainmentProcessSamplerInvocations = 8
  private static let stateLoadBudgetSeconds = (simctlInventoryCommandsPerStateLoad * simctlCommandTimeoutSeconds)
    + (processSamplerInvocationsPerStateLoad * processSamplerTimeoutSeconds)

  let command: String
  let group: String
  let options: [String: BrokerJSONValue]

  var executionTimeoutSeconds: Int {
    timeoutBudget().executionTimeoutSeconds
  }

  var transferTimeoutSeconds: Int {
    timeoutBudget().transferTimeoutSeconds
  }

  func timeoutBudget(paths: BrokerRuntimePaths? = nil) -> BrokerCommandTimeoutBudget {
    let executionTimeoutSeconds = calculatedExecutionTimeoutSeconds(paths: paths)
    return BrokerCommandTimeoutBudget(
      executionTimeoutSeconds: executionTimeoutSeconds,
      queueTimeoutSeconds: commandQueueTimeoutSeconds
    )
  }

  func calculatedExecutionTimeoutSeconds(paths: BrokerRuntimePaths? = nil) -> Int {
    let stateLoadBudget = brokerStateLoadBudgetSeconds(paths: paths)
    let snapshotLockBudget = finalSnapshotLeaseLockTimeoutSeconds
    if group == "host", command == "init" {
      return Self.defaultCommandTimeoutSeconds
        + leaseLockTimeoutSeconds
        + snapshotLockBudget
        + stateLoadBudget
        + hostInitBootstrapBudgetSeconds(paths: paths)
    }
    if group == "lease", command == "acquire" {
      return Self.defaultCommandTimeoutSeconds
        + leaseLockTimeoutSeconds
        + timeoutSeconds(option: "resetLockTimeoutMilliseconds", fallbackMilliseconds: Self.defaultLockTimeoutMilliseconds)
        + timeoutSeconds(option: "resetSettleMilliseconds", fallbackMilliseconds: Self.defaultResetSettleMilliseconds)
        + leaseAcquireResetSimctlBudgetSeconds
        + snapshotLockBudget
        + stateLoadBudget
    }
    if group == "lease", command == "contain" {
      let diagnosticTimeout = options["captureDiagnostics"]?.boolValue == true
        ? Self.containmentDiagnosticTimeoutSeconds
        : 0
      return Self.defaultCommandTimeoutSeconds
        + leaseLockTimeoutSeconds
        + timeoutSeconds(option: "termWaitMs")
        + diagnosticTimeout
        + snapshotLockBudget
        + stateLoadBudget
    }
    if group == "capacity", command == "reconcile", options["apply"]?.boolValue == true {
      return max(
        Self.capacityApplyTimeoutSeconds,
        Self.defaultCommandTimeoutSeconds
          + capacityLockTimeoutSeconds
          + leaseLockTimeoutSeconds
          + snapshotLockBudget
          + capacityReconcileSimctlBudgetSeconds(paths: paths)
      )
    }
    if group == "capacity", command == "check" {
      return Self.defaultCommandTimeoutSeconds + capacityCheckSimctlBudgetSeconds
    }
    if group == "capacity", command == "reconcile" {
      return Self.defaultCommandTimeoutSeconds + capacityReconcileSimctlBudgetSeconds(paths: paths)
    }
    if group == "simulators", command == "repair" {
      return Self.defaultCommandTimeoutSeconds
        + capacityLockTimeoutSeconds
        + leaseLockTimeoutSeconds
        + snapshotLockBudget
        + stateLoadBudget
        + simulatorLifecycleSimctlBudgetSeconds(paths: paths)
    }
    if group == "simulators" {
      return Self.defaultCommandTimeoutSeconds
        + leaseLockTimeoutSeconds
        + snapshotLockBudget
        + stateLoadBudget
        + simulatorLifecycleSimctlBudgetSeconds(paths: paths)
    }
    if group == "idle" {
      return Self.defaultCommandTimeoutSeconds
        + leaseLockTimeoutSeconds
        + snapshotLockBudget
        + stateLoadBudget
        + idleShutdownSimctlBudgetSeconds(paths: paths)
    }
    if usesLeaseMutationLock {
      return Self.defaultCommandTimeoutSeconds
        + leaseLockTimeoutSeconds
        + snapshotLockBudget
        + stateLoadBudget
    }
    return Self.defaultCommandTimeoutSeconds
      + serializedStateReadLockTimeoutSeconds
      + snapshotLockBudget
      + stateLoadBudget
  }

  func makeBodyData(
    expectedServiceIdentity: BrokerServiceMetadata? = nil,
    timeoutBudget: BrokerCommandTimeoutBudget? = nil
  ) throws -> Data {
    var jsonObject: [String: Any] = [
      "type": "command",
      "group": group,
      "command": command,
      "options": options.reduce(into: [String: Any]()) { partialResult, item in
        partialResult[item.key] = item.value.jsonObject
      },
    ]
    if let expectedServiceIdentity {
      jsonObject["expectedServiceIdentity"] = expectedServiceIdentity.commandIdentityObject
    }
    if let timeoutBudget {
      jsonObject["clientRequestStartedAtMilliseconds"] = Int(Date().timeIntervalSince1970 * 1000)
      jsonObject["clientCommandExecutionTimeoutMilliseconds"] = timeoutBudget.executionTimeoutSeconds * 1000
      jsonObject["clientCommandQueueTimeoutMilliseconds"] = timeoutBudget.queueTimeoutSeconds * 1000
    }
    return try JSONSerialization.data(withJSONObject: jsonObject, options: [.prettyPrinted, .sortedKeys])
  }

  private func brokerStateLoadBudgetSeconds(paths: BrokerRuntimePaths?) -> Int {
    brokerStateLoadBudgetSeconds(for: commandStateLoadCount, paths: paths)
  }

  private func brokerStateLoadBudgetSeconds(for stateLoadCount: Int, paths: BrokerRuntimePaths?) -> Int {
    let loadCount = max(0, stateLoadCount)
    return (loadCount * Self.stateLoadBudgetSeconds)
      + staleContainmentBudgetSeconds(paths: paths, stateLoadCount: loadCount)
  }

  private var capacityActionCount: Int {
    max(1, options["capacityActionCount"]?.intValue ?? 1)
  }

  private var capacityLockTimeoutSeconds: Int {
    timeoutSeconds(option: "capacityLockTimeoutMilliseconds", fallbackMilliseconds: Self.defaultLockTimeoutMilliseconds)
  }

  private var capacityRecoveryAdditionCount: Int {
    max(0, options["capacityRecoveryAdditionCount"]?.intValue ?? 0)
  }

  private var capacityRecoveryTransactionCount: Int {
    max(0, options["capacityRecoveryTransactionCount"]?.intValue ?? 0)
  }

  private func capacityReconcileSimctlBudgetSeconds(paths: BrokerRuntimePaths?) -> Int {
    guard group == "capacity", command == "reconcile" else {
      return 0
    }
    if options["apply"]?.boolValue != true {
      return brokerStateLoadBudgetSeconds(for: 1, paths: paths)
    }
    let stateLoadCount = Self.capacityApplyPlanEvaluations
      + Self.capacityApplyFinalizationStateLoads
      + Self.capacityApplyFinalSnapshotStateLoads
      + capacityRecoveryTransactionCount
    let commandCount = (capacityActionCount * Self.capacitySimctlCommandsPerAction)
      + Self.capacityRollbackInventoryCommands
      + (capacityActionCount * Self.capacityRollbackSimctlCommandsPerAction)
      + (capacityRecoveryAdditionCount * Self.capacitySimctlCommandsPerAction)
    return brokerStateLoadBudgetSeconds(for: stateLoadCount, paths: paths)
      + (commandCount * Self.simctlCommandTimeoutSeconds)
  }

  private var capacityCheckSimctlBudgetSeconds: Int {
    group == "capacity" && command == "check"
      ? Self.stateLoadBudgetSeconds
      : 0
  }

  private var commandQueueTimeoutSeconds: Int {
    timeoutSeconds(option: "serviceCommandQueueTimeoutMilliseconds", fallbackMilliseconds: Self.defaultCommandQueueTimeoutSeconds * 1000)
  }

  private var commandStateLoadCount: Int {
    if group == "help" || group == "events" || group == "capacity" {
      return 0
    }
    return 1 + (writesFinalSnapshot ? 1 : 0)
  }

  private var mayRunStaleContainment: Bool {
    if group == "help" || group == "events" {
      return false
    }
    if group == "capacity" {
      return command == "reconcile" && options["apply"]?.boolValue == true
    }
    return true
  }

  private func staleContainmentBudgetSeconds(paths: BrokerRuntimePaths?, stateLoadCount: Int = 1) -> Int {
    guard mayRunStaleContainment else {
      return 0
    }
    let loadCount = max(0, stateLoadCount)
    guard loadCount > 0 else {
      return 0
    }
    let staleLeaseCount = staleContainmentLeaseCount(paths: paths)
    guard staleLeaseCount > 0 else {
      return 0
    }
    let termWaitMilliseconds = timeoutMilliseconds(
      option: "termWaitMs",
      fallbackMilliseconds: Self.defaultContainmentTermWaitMilliseconds
    )
    let budgetMilliseconds = loadCount * staleLeaseCount * (
      (Self.staleContainmentProcessSamplerInvocations * Self.processSamplerTimeoutSeconds * 1000)
        + termWaitMilliseconds
        + Self.defaultContainmentPostKillWaitMilliseconds
    )
    return Int(ceil(Double(budgetMilliseconds) / 1000.0))
  }

  private func staleContainmentLeaseCount(paths: BrokerRuntimePaths?) -> Int {
    if let explicitCount = options["staleContainmentLeaseCount"]?.intValue {
      return max(0, explicitCount)
    }
    guard let leasesURL = paths?.stateRoot.appending(path: "leases"),
          let leaseURLs = try? FileManager.default.contentsOfDirectory(
            at: leasesURL,
            includingPropertiesForKeys: nil
          ) else {
      return 0
    }
    let decoder = JSONDecoder()
    return leaseURLs
      .filter { $0.pathExtension == "json" }
      .compactMap { url -> BrokerLeaseTimeoutSummary? in
        guard let data = try? Data(contentsOf: url) else {
          return nil
        }
        return try? decoder.decode(BrokerLeaseTimeoutSummary.self, from: data)
      }
      .count { $0.hasContainmentProcessMetadata }
  }

  private func hostBootstrapRetirementCount(paths: BrokerRuntimePaths?) -> Int {
    if let explicitCount = options["hostBootstrapRetirementCount"]?.intValue {
      return max(0, explicitCount)
    }
    guard let paths else {
      return Self.hostBootstrapAliasCount
    }
    guard let data = try? Data(contentsOf: paths.hostConfigURL),
          let hostConfig = try? JSONDecoder().decode(BrokerHostConfigTimeoutSummary.self, from: data) else {
      return 0
    }
    var simulatorIds = Set<String>()
    for alias in hostConfig.aliases ?? [] {
      if let simulatorId = alias.simulatorId, simulatorId.isEmpty == false {
        simulatorIds.insert(simulatorId)
      }
    }
    for simulatorId in hostConfig.pendingRetirements ?? [] where simulatorId.isEmpty == false {
      simulatorIds.insert(simulatorId)
    }
    return simulatorIds.count
  }

  private func hostInitWillProvisionBootstrap(paths: BrokerRuntimePaths?) -> Bool {
    guard group == "host", command == "init", options["bootstrapConfig"]?.boolValue == true else {
      return false
    }
    if options["force"]?.boolValue == true {
      return true
    }
    guard let paths else {
      return true
    }
    return FileManager.default.fileExists(atPath: paths.hostConfigURL.path) == false
  }

  private func hostInitBootstrapBudgetSeconds(paths: BrokerRuntimePaths? = nil) -> Int {
    guard hostInitWillProvisionBootstrap(paths: paths) else {
      return 0
    }
    let retirementCount = hostBootstrapRetirementCount(paths: paths)
    let stateLoadCount = Self.hostBootstrapBaselineStateLoads
      + Self.hostBootstrapReplacementStateLoads
      + (retirementCount > 0 ? Self.hostBootstrapRetirementStateLoads : 0)
    let commandCount = (Self.hostBootstrapAliasCount * Self.hostBootstrapSimctlCommandsPerAlias)
      + (retirementCount * 2)
    return capacityLockTimeoutSeconds
      + brokerStateLoadBudgetSeconds(for: stateLoadCount, paths: paths)
      + (commandCount * Self.simctlCommandTimeoutSeconds)
  }

  private var finalSnapshotLeaseLockTimeoutSeconds: Int {
    writesFinalSnapshot ? leaseLockTimeoutSeconds : 0
  }

  private var leaseAcquireResetSimctlBudgetSeconds: Int {
    group == "lease" && command == "acquire"
      ? Self.leaseAcquireSimctlCommands * Self.simctlCommandTimeoutSeconds
      : 0
  }

  private var leaseLockTimeoutSeconds: Int {
    timeoutSeconds(option: "leaseLockTimeoutMilliseconds", fallbackMilliseconds: Self.defaultLockTimeoutMilliseconds)
  }

  private var serializedStateReadLockTimeoutSeconds: Int {
    usesSerializedStateReadLock ? leaseLockTimeoutSeconds : 0
  }

  private var usesLeaseMutationLock: Bool {
    if group == "lease" {
      return ["acquire", "contain", "register-process", "release"].contains(command)
    }
    if group == "pin" {
      return ["clear", "create"].contains(command)
    }
    if group == "simulators" {
      return ["boot", "erase", "repair", "shutdown"].contains(command)
    }
    if group == "idle" {
      return true
    }
    return false
  }

  private var usesSerializedStateReadLock: Bool {
    if group == "doctor" {
      return true
    }
    if group == "host" {
      return command == "status"
    }
    if group == "lease" {
      return command == "explain"
    }
    return false
  }

  private var writesFinalSnapshot: Bool {
    if group == "help" || group == "events" {
      return false
    }
    if group == "capacity", options["apply"]?.boolValue != true {
      return false
    }
    return true
  }

  private func pendingRetirementCount(paths: BrokerRuntimePaths?) -> Int {
    guard let paths,
          let data = try? Data(contentsOf: paths.hostConfigURL),
          let hostConfig = try? JSONDecoder().decode(BrokerHostConfigTimeoutSummary.self, from: data) else {
      return 0
    }
    return hostConfig.pendingRetirements?.count ?? 0
  }

  private func simulatorLifecycleSimctlBudgetSeconds(paths: BrokerRuntimePaths? = nil) -> Int {
    guard group == "simulators" else {
      return 0
    }
    var commandCount: Int
    switch command {
    case "boot", "erase":
      commandCount = 2
    case "shutdown":
      commandCount = 1
    case "repair":
      commandCount = 10 + (pendingRetirementCount(paths: paths) * 2)
    default:
      commandCount = 0
    }
    guard commandCount > 0 else {
      return 0
    }
    return commandCount * Self.simctlCommandTimeoutSeconds
  }

  private func idleShutdownSimctlBudgetSeconds(paths: BrokerRuntimePaths?) -> Int {
    guard group == "idle",
          command == "reconcile" || (command == "cleanup" && options["apply"]?.boolValue == true)
    else {
      return 0
    }
    guard let paths,
          let data = try? Data(contentsOf: paths.hostConfigURL),
          let hostConfig = try? JSONDecoder().decode(BrokerHostConfigTimeoutSummary.self, from: data)
    else {
      return Self.hostBootstrapAliasCount * Self.simctlCommandTimeoutSeconds
    }
    return (hostConfig.aliases?.count ?? Self.hostBootstrapAliasCount) * Self.simctlCommandTimeoutSeconds
  }

  private func timeoutSeconds(option: String, fallbackMilliseconds: Int = 0) -> Int {
    let milliseconds = timeoutMilliseconds(option: option, fallbackMilliseconds: fallbackMilliseconds)
    guard milliseconds > 0 else {
      return 0
    }
    return Int(ceil(Double(milliseconds) / 1000.0))
  }

  private func timeoutMilliseconds(option: String, fallbackMilliseconds: Int = 0) -> Int {
    max(0, options[option]?.intValue ?? fallbackMilliseconds)
  }
}

struct BrokerLeaseRuntimeTimeoutSummary: Decodable {
  let commandPgid: Int?
  let commandPid: Int?
  let memoryCeilingBytes: Int?
  let ownerPgid: Int?
  let simulatorProcessNames: [String]?
}

struct BrokerLeaseTimeoutSummary: Decodable {
  let runtime: BrokerLeaseRuntimeTimeoutSummary?

  var hasContainmentProcessMetadata: Bool {
    guard let runtime else {
      return false
    }
    return (runtime.commandPid ?? 0) > 0
      || (runtime.commandPgid ?? 0) > 0
      || (runtime.memoryCeilingBytes ?? 0) > 0
      || (runtime.ownerPgid ?? 0) > 0
      || runtime.simulatorProcessNames?.isEmpty == false
  }
}

private struct BrokerHostConfigTimeoutAlias: Decodable {
  let simulatorId: String?
}

private struct BrokerHostConfigTimeoutSummary: Decodable {
  let aliases: [BrokerHostConfigTimeoutAlias]?
  let pendingRetirements: [String]?
}

struct BrokerCommandEnvelope: Decodable, Sendable {
  let currentHolder: BrokerLeaseSummary?
  let eligibleCount: Int?
  let error: String?
  let exitCode: Int?
  let failureCount: Int?
  let ok: Bool?
  let planId: String?
  let reasonCode: String?
  let requiredConfirmationFields: [String]?
  let shutdownCount: Int?
  let status: String?
  let unchanged: Bool?

  init(
    currentHolder: BrokerLeaseSummary?,
    eligibleCount: Int? = nil,
    error: String?,
    exitCode: Int?,
    failureCount: Int? = nil,
    ok: Bool?,
    planId: String? = nil,
    reasonCode: String?,
    requiredConfirmationFields: [String]?,
    shutdownCount: Int? = nil,
    status: String? = nil,
    unchanged: Bool?
  ) {
    self.currentHolder = currentHolder
    self.eligibleCount = eligibleCount
    self.error = error
    self.exitCode = exitCode
    self.failureCount = failureCount
    self.ok = ok
    self.planId = planId
    self.reasonCode = reasonCode
    self.requiredConfirmationFields = requiredConfirmationFields
    self.shutdownCount = shutdownCount
    self.status = status
    self.unchanged = unchanged
  }
}

struct BrokerLifecycleOverrideRequest: Identifiable, Sendable {
  let action: BrokerLifecycleAction
  let alias: String
  let currentHolder: BrokerLeaseSummary

  var id: String {
    "\(action.rawValue):\(alias):\(currentHolder.leaseId)"
  }
}

struct BrokerHTTPResponse: Sendable {
  let bodyData: Data
  let statusCode: Int
}

private extension BrokerServiceMetadata {
  var commandIdentityObject: [String: String] {
    [
      "hostConfigPath": hostConfigPath,
      "socketPath": socketPath,
      "stateRoot": stateRoot,
    ]
  }
}

private struct BrokerServiceStatusEnvelope: Decodable, Sendable {
  let service: BrokerServiceMetadata?
}

enum BrokerServiceCommandClientError: LocalizedError, Sendable {
  case invalidHTTPStatusOutput
  case invalidJSONResponse
  case missingServiceMetadata(URL)
  case serviceIdentityMismatch(expected: [String: String], actual: [String: String], mismatchedFields: [String])
  case unreadableServiceMetadata(URL, String)
  case transportFailure(String)

  var errorDescription: String? {
    switch self {
    case .invalidHTTPStatusOutput:
      return "Broker service returned an unreadable HTTP response."
    case .invalidJSONResponse:
      return "Broker service returned invalid JSON."
    case let .missingServiceMetadata(url):
      return "brokerd metadata is missing at \(url.path). Start brokerd to enable operator actions."
    case let .serviceIdentityMismatch(expected, actual, mismatchedFields):
      let fieldList = mismatchedFields.joined(separator: ", ")
      return "brokerd is running with different broker paths (\(fieldList)). Expected \(expected), received \(actual)."
    case let .transportFailure(message):
      return message
    case let .unreadableServiceMetadata(url, message):
      return "Failed to read brokerd metadata at \(url.path): \(message)"
    }
  }
}

struct BrokerServiceCommandError: LocalizedError, Sendable {
  let currentHolder: BrokerLeaseSummary?
  let message: String
  let reasonCode: String?
  let requiredConfirmationFields: [String]?
  let statusCode: Int

  var errorDescription: String? { message }

  var needsOverrideConfirmation: Bool {
    reasonCode == "override-required" || reasonCode == "human-override-required"
  }

  func overrideRequest(for action: BrokerLifecycleAction, alias: String) -> BrokerLifecycleOverrideRequest? {
    guard needsOverrideConfirmation, let currentHolder else {
      return nil
    }
    return BrokerLifecycleOverrideRequest(
      action: action,
      alias: alias,
      currentHolder: currentHolder
    )
  }
}

protocol BrokerCommandSending: Sendable {
  func send(_ request: BrokerCommandRequest) async throws -> BrokerCommandEnvelope
}

protocol BrokerServiceTransporting: Sendable {
  func perform(
    socketPath: String,
    requestPath: String,
    method: String,
    bodyData: Data?,
    transferTimeoutSeconds: Int?
  ) async throws -> BrokerHTTPResponse
}

final class CurlProcessBox: @unchecked Sendable {
  private let lock = NSLock()
  private var process: Process?
  private var cancelled = false

  func launch(_ process: Process) throws -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard cancelled == false else {
      return false
    }
    self.process = process
    do {
      try process.run()
    } catch {
      self.process = nil
      throw error
    }
    return true
  }

  func cancelAndTerminate() {
    lock.lock()
    cancelled = true
    let currentProcess = process
    lock.unlock()
    if currentProcess?.isRunning == true {
      currentProcess?.terminate()
    }
  }

  func finishWasCancelled() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    process = nil
    return cancelled
  }
}

final class PipeDrainBuffer: @unchecked Sendable {
  private let lock = NSLock()
  private var data = Data()

  func drainAvailableData(from fileHandle: FileHandle) {
    lock.lock()
    defer { lock.unlock() }
    let nextData = fileHandle.availableData
    if nextData.isEmpty == false {
      data.append(nextData)
    }
  }

  func snapshot(appendingRemainderFrom fileHandle: FileHandle) -> Data {
    lock.lock()
    defer { lock.unlock() }
    let tailData = fileHandle.readDataToEndOfFile()
    if tailData.isEmpty == false {
      data.append(tailData)
    }
    return data
  }
}

struct CurlBrokerServiceTransport: BrokerServiceTransporting {
  let executableURL: URL
  let transferTimeoutSeconds: Int

  init(executableURL: URL = URL(fileURLWithPath: "/usr/bin/curl"), transferTimeoutSeconds: Int = 90) {
    self.executableURL = executableURL
    self.transferTimeoutSeconds = max(1, transferTimeoutSeconds)
  }

  func perform(
    socketPath: String,
    requestPath: String,
    method: String,
    bodyData: Data?,
    transferTimeoutSeconds: Int?
  ) async throws -> BrokerHTTPResponse {
    let process = Process()
    let processBox = CurlProcessBox()
    let stdoutPipe = Pipe()
    let stderrPipe = Pipe()
    let stdinPipe = bodyData == nil ? nil : Pipe()
    let stdoutBuffer = PipeDrainBuffer()
    let stderrBuffer = PipeDrainBuffer()

    process.executableURL = executableURL
    process.arguments = curlArguments(
      socketPath: socketPath,
      requestPath: requestPath,
      method: method,
      hasBody: bodyData != nil,
      transferTimeoutSeconds: transferTimeoutSeconds
    )
    process.standardInput = stdinPipe
    process.standardOutput = stdoutPipe
    process.standardError = stderrPipe
    stdoutPipe.fileHandleForReading.readabilityHandler = { fileHandle in
      stdoutBuffer.drainAvailableData(from: fileHandle)
    }
    stderrPipe.fileHandleForReading.readabilityHandler = { fileHandle in
      stderrBuffer.drainAvailableData(from: fileHandle)
    }

    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        process.terminationHandler = { completedProcess in
          stdoutPipe.fileHandleForReading.readabilityHandler = nil
          stderrPipe.fileHandleForReading.readabilityHandler = nil
          let stdoutData = stdoutBuffer.snapshot(appendingRemainderFrom: stdoutPipe.fileHandleForReading)
          let stderrData = stderrBuffer.snapshot(appendingRemainderFrom: stderrPipe.fileHandleForReading)
          let stderrText = String(decoding: stderrData, as: UTF8.self)
          if processBox.finishWasCancelled() {
            continuation.resume(throwing: CancellationError())
            return
          }

          guard completedProcess.terminationStatus == 0 else {
            let message = stderrText.isEmpty ? "Failed to contact brokerd." : stderrText.trimmingCharacters(in: .whitespacesAndNewlines)
            continuation.resume(throwing: BrokerServiceCommandClientError.transportFailure(message))
            return
          }

          do {
            let response = try parseHTTPResponse(stdoutData)
            continuation.resume(returning: response)
          } catch {
            continuation.resume(throwing: error)
          }
        }

        do {
          guard try processBox.launch(process) else {
            stdoutPipe.fileHandleForReading.readabilityHandler = nil
            stderrPipe.fileHandleForReading.readabilityHandler = nil
            continuation.resume(throwing: CancellationError())
            return
          }
          if let bodyData, let stdinPipe {
            stdinPipe.fileHandleForWriting.write(bodyData)
            try? stdinPipe.fileHandleForWriting.close()
          }
        } catch {
          stdoutPipe.fileHandleForReading.readabilityHandler = nil
          stderrPipe.fileHandleForReading.readabilityHandler = nil
          _ = processBox.finishWasCancelled()
          continuation.resume(throwing: BrokerServiceCommandClientError.transportFailure(error.localizedDescription))
        }
      }
    } onCancel: {
      processBox.cancelAndTerminate()
    }
  }

  func curlArguments(
    socketPath: String,
    requestPath: String,
    method: String,
    hasBody: Bool,
    transferTimeoutSeconds requestedTransferTimeoutSeconds: Int? = nil
  ) -> [String] {
    let effectiveTransferTimeoutSeconds = max(1, requestedTransferTimeoutSeconds ?? transferTimeoutSeconds)
    var arguments = [
      "--silent",
      "--show-error",
      "--max-time",
      "\(effectiveTransferTimeoutSeconds)",
      "--write-out",
      "\n%{http_code}",
      "--unix-socket",
      socketPath,
      "--request",
      method,
      "http://brokerd.local\(requestPath)",
    ]
    if hasBody {
      arguments.append(contentsOf: [
        "--header",
        "content-type: application/json",
        "--data-binary",
        "@-",
      ])
    }
    return arguments
  }

  private func parseHTTPResponse(_ outputData: Data) throws -> BrokerHTTPResponse {
    let output = String(decoding: outputData, as: UTF8.self)
    guard let separator = output.range(of: "\n", options: .backwards) else {
      throw BrokerServiceCommandClientError.invalidHTTPStatusOutput
    }

    let bodyString = String(output[..<separator.lowerBound])
    let statusString = String(output[separator.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
    guard let statusCode = Int(statusString) else {
      throw BrokerServiceCommandClientError.invalidHTTPStatusOutput
    }

    return BrokerHTTPResponse(
      bodyData: Data(bodyString.utf8),
      statusCode: statusCode
    )
  }
}

struct BrokerServiceCommandClient: BrokerCommandSending {
  private static let serviceStatusTimeoutSeconds = 10

  let paths: BrokerRuntimePaths
  let transport: any BrokerServiceTransporting

  init(
    paths: BrokerRuntimePaths = .fromLaunchContext(),
    transport: any BrokerServiceTransporting = CurlBrokerServiceTransport()
  ) {
    self.paths = paths
    self.transport = transport
  }

  func send(_ request: BrokerCommandRequest) async throws -> BrokerCommandEnvelope {
    let metadata = try loadServiceMetadata()
    try validateServiceIdentity(
      metadata,
      expectedSocketPath: paths.serviceSocketURL?.path ?? metadata.socketPath
    )
    let service = try await validateLiveServiceIdentity(metadata: metadata)
    let timeoutBudget = request.timeoutBudget(paths: paths)
    let response = try await transport.perform(
      socketPath: metadata.socketPath,
      requestPath: "/v1/command",
      method: "POST",
      bodyData: try request.makeBodyData(expectedServiceIdentity: service, timeoutBudget: timeoutBudget),
      transferTimeoutSeconds: timeoutBudget.transferTimeoutSeconds
    )

    guard let envelope = try? JSONDecoder().decode(BrokerCommandEnvelope.self, from: response.bodyData) else {
      throw BrokerServiceCommandClientError.invalidJSONResponse
    }

    if (200 ... 299).contains(response.statusCode), envelope.ok != false {
      return envelope
    }

    throw BrokerServiceCommandError(
      currentHolder: envelope.currentHolder,
      message: envelope.error ?? "Broker command failed.",
      reasonCode: envelope.reasonCode,
      requiredConfirmationFields: envelope.requiredConfirmationFields,
      statusCode: response.statusCode
    )
  }

  private func loadServiceMetadata() throws -> BrokerServiceMetadata {
    guard FileManager.default.fileExists(atPath: paths.serviceMetadataURL.path) else {
      throw BrokerServiceCommandClientError.missingServiceMetadata(paths.serviceMetadataURL)
    }

    do {
      let data = try Data(contentsOf: paths.serviceMetadataURL)
      return try JSONDecoder().decode(BrokerServiceMetadata.self, from: data)
    } catch {
      throw BrokerServiceCommandClientError.unreadableServiceMetadata(paths.serviceMetadataURL, error.localizedDescription)
    }
  }

  private func validateLiveServiceIdentity(metadata: BrokerServiceMetadata) async throws -> BrokerServiceMetadata {
    let response = try await transport.perform(
      socketPath: metadata.socketPath,
      requestPath: "/v1/service/status",
      method: "GET",
      bodyData: nil,
      transferTimeoutSeconds: Self.serviceStatusTimeoutSeconds
    )

    guard (200 ... 299).contains(response.statusCode) else {
      throw BrokerServiceCommandClientError.transportFailure("brokerd status check failed with HTTP \(response.statusCode).")
    }
    guard let envelope = try? JSONDecoder().decode(BrokerServiceStatusEnvelope.self, from: response.bodyData),
          let service = envelope.service else {
      throw BrokerServiceCommandClientError.invalidJSONResponse
    }

    try validateServiceIdentity(
      service,
      expectedSocketPath: paths.serviceSocketURL?.path ?? metadata.socketPath
    )
    return service
  }

  private func validateServiceIdentity(_ service: BrokerServiceMetadata, expectedSocketPath: String) throws {
    let expected = [
      "hostConfigPath": normalizedPath(paths.hostConfigURL.path),
      "socketPath": normalizedPath(expectedSocketPath),
      "stateRoot": normalizedPath(paths.stateRoot.path),
    ]
    let actual = [
      "hostConfigPath": normalizedPath(service.hostConfigPath),
      "socketPath": normalizedPath(service.socketPath),
      "stateRoot": normalizedPath(service.stateRoot),
    ]
    let mismatchedFields = expected.keys
      .sorted()
      .filter { actual[$0] != expected[$0] }

    guard mismatchedFields.isEmpty else {
      throw BrokerServiceCommandClientError.serviceIdentityMismatch(
        expected: expected,
        actual: actual,
        mismatchedFields: mismatchedFields
      )
    }
  }

  private func normalizedPath(_ rawPath: String) -> String {
    URL(fileURLWithPath: (rawPath as NSString).expandingTildeInPath)
      .standardizedFileURL
      .path
  }
}
