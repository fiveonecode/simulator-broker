import Foundation
import Darwin
import Dispatch

private let processTerminationEscalationNanoseconds: UInt64 = 1_000_000_000
private let processDiscoveryTimeoutNanoseconds: UInt64 = 500_000_000

private final class ProcessOutputBuffer: @unchecked Sendable {
  private let lock = NSLock()
  private var data = Data()

  func drainAvailableData(from fileHandle: FileHandle) {
    lock.lock()
    let chunk = fileHandle.availableData
    if chunk.isEmpty == false {
      data.append(chunk)
    }
    lock.unlock()
  }

  func snapshot(appendingRemainderFrom fileHandle: FileHandle? = nil) -> Data {
    lock.lock()
    if let fileHandle {
      data.append(fileHandle.readDataToEndOfFile())
    }
    let snapshot = data
    lock.unlock()
    return snapshot
  }
}

private final class ProcessRunState: @unchecked Sendable {
  private let lock = NSLock()
  private let process: Process
  private let stdoutPipe: Pipe
  private let stderrPipe: Pipe
  private let stdoutBuffer: ProcessOutputBuffer
  private let stderrBuffer: ProcessOutputBuffer
  private let processTreeResolver: @Sendable (pid_t) -> [pid_t]
  private var continuation: CheckedContinuation<BrokerCLICommandEnvelope, Error>?
  private var completedResult: Result<BrokerCLICommandEnvelope, Error>?
  private var requestedFailure: Error?
  private var timeoutTask: Task<Void, Never>?
  private var killEscalationTask: Task<Void, Never>?

  init(
    process: Process,
    stdoutPipe: Pipe,
    stderrPipe: Pipe,
    stdoutBuffer: ProcessOutputBuffer,
    stderrBuffer: ProcessOutputBuffer,
    processTreeResolver: @escaping @Sendable (pid_t) -> [pid_t]
  ) {
    self.process = process
    self.stdoutPipe = stdoutPipe
    self.stderrPipe = stderrPipe
    self.stdoutBuffer = stdoutBuffer
    self.stderrBuffer = stderrBuffer
    self.processTreeResolver = processTreeResolver
  }

  func installContinuation(_ continuation: CheckedContinuation<BrokerCLICommandEnvelope, Error>) -> Bool {
    let completedResult: Result<BrokerCLICommandEnvelope, Error>?
    lock.lock()
    if let result = self.completedResult {
      completedResult = result
    } else {
      self.continuation = continuation
      completedResult = nil
    }
    lock.unlock()

    if let completedResult {
      resume(continuation, with: completedResult)
      return false
    }
    return true
  }

  func markProcessStarted() {
    var shouldTerminate = false
    lock.lock()
    if completedResult == nil {
      shouldTerminate = requestedFailure != nil
    }
    lock.unlock()

    if process.isRunning {
      _ = setpgid(process.processIdentifier, process.processIdentifier)
    }
    if shouldTerminate {
      terminateProcess(signal: SIGTERM)
    }
  }

  func installTimeoutTask(_ task: Task<Void, Never>) {
    var shouldCancel = false
    lock.lock()
    if completedResult == nil {
      timeoutTask = task
    } else {
      shouldCancel = true
    }
    lock.unlock()

    if shouldCancel {
      task.cancel()
    }
  }

  func finishFromTermination(_ completedProcess: Process, cliPath: URL) {
    guard isCompleted == false else { return }

    clearProcessHandlers()

    let stdoutData = stdoutBuffer.snapshot(appendingRemainderFrom: stdoutPipe.fileHandleForReading)
    let stderrData = stderrBuffer.snapshot(appendingRemainderFrom: stderrPipe.fileHandleForReading)
    let stderrText = String(decoding: stderrData, as: UTF8.self)
      .trimmingCharacters(in: .whitespacesAndNewlines)

    if let requestedFailure = requestedFailureSnapshot() {
      finish(.failure(requestedFailure))
      return
    }

    guard stdoutData.isEmpty == false else {
      let message = stderrText.isEmpty ? "Broker CLI failed without any output." : stderrText
      finish(.failure(BrokerCLICommandError.processFailure(message)))
      return
    }

    do {
      let envelope = try JSONDecoder().decode(BrokerCLICommandEnvelope.self, from: stdoutData)
      if completedProcess.terminationStatus == 0, envelope.ok != false {
        finish(.success(envelope))
        return
      }

      var message = envelope.error ?? (stderrText.isEmpty ? "Broker CLI command failed." : stderrText)
      if let failedStage = envelope.failedStage {
        message += " Failed stage: \(failedStage)."
      }
      if let completedStages = envelope.completedStages, completedStages.isEmpty == false {
        message += " Completed: \(completedStages.joined(separator: ", "))."
      }
      if let recoveryCommand = envelope.recoveryCommand {
        message += " Recovery: \(recoveryCommand)"
      }
      finish(.failure(BrokerCLICommandError.commandFailed(message)))
    } catch {
      finish(.failure(BrokerCLICommandError.invalidJSONResponse(cliPath)))
    }
  }

  func terminateAndFail(_ error: Error) {
    var shouldInstallEscalationTask = false
    lock.lock()
    if completedResult == nil {
      if requestedFailure == nil {
        requestedFailure = error
      }
      shouldInstallEscalationTask = killEscalationTask == nil
    }
    lock.unlock()

    terminateProcess(signal: SIGTERM)
    if shouldInstallEscalationTask {
      installKillEscalationTask(Task { [weak self] in
        do {
          try await Task.sleep(nanoseconds: processTerminationEscalationNanoseconds)
        } catch {
          return
        }
        self?.killIfStillRunning()
      })
    }
  }

  func finish(_ result: Result<BrokerCLICommandEnvelope, Error>) {
    let activeContinuation: CheckedContinuation<BrokerCLICommandEnvelope, Error>?
    let activeTimeoutTask: Task<Void, Never>?
    let activeKillEscalationTask: Task<Void, Never>?
    lock.lock()
    if completedResult != nil {
      lock.unlock()
      return
    }
    completedResult = result
    activeContinuation = continuation
    continuation = nil
    activeTimeoutTask = timeoutTask
    timeoutTask = nil
    activeKillEscalationTask = killEscalationTask
    killEscalationTask = nil
    lock.unlock()

    clearProcessHandlers()
    activeTimeoutTask?.cancel()
    activeKillEscalationTask?.cancel()
    if let activeContinuation {
      resume(activeContinuation, with: result)
    }
  }

  private var isCompleted: Bool {
    lock.lock()
    let completed = completedResult != nil
    lock.unlock()
    return completed
  }

  private func requestedFailureSnapshot() -> Error? {
    lock.lock()
    let error = requestedFailure
    lock.unlock()
    return error
  }

  private func installKillEscalationTask(_ task: Task<Void, Never>) {
    var shouldCancel = false
    lock.lock()
    if completedResult == nil && killEscalationTask == nil {
      killEscalationTask = task
    } else {
      shouldCancel = true
    }
    lock.unlock()

    if shouldCancel {
      task.cancel()
    }
  }

  private func killIfStillRunning() {
    guard isCompleted == false else { return }
    terminateProcess(signal: SIGKILL)
  }

  private func terminateProcess(signal: Int32) {
    if process.isRunning {
      signalProcessTree(rootPID: process.processIdentifier, signal: signal)
      if signal == SIGTERM {
        process.terminate()
      }
    }
  }

  private func signalProcessTree(rootPID: pid_t, signal: Int32) {
    guard rootPID > 0 else { return }
    let descendants = processTreeResolver(rootPID)
    _ = Darwin.kill(-rootPID, signal)
    _ = Darwin.kill(rootPID, signal)
    for pid in descendants.reversed() {
      _ = Darwin.kill(pid, signal)
    }
  }

  private func clearProcessHandlers() {
    process.terminationHandler = nil
    stdoutPipe.fileHandleForReading.readabilityHandler = nil
    stderrPipe.fileHandleForReading.readabilityHandler = nil
  }

  private func resume(
    _ continuation: CheckedContinuation<BrokerCLICommandEnvelope, Error>,
    with result: Result<BrokerCLICommandEnvelope, Error>
  ) {
    switch result {
    case let .success(envelope):
      continuation.resume(returning: envelope)
    case let .failure(error):
      continuation.resume(throwing: error)
    }
  }
}

struct BrokerCLICommandEnvelope: Decodable, Sendable {
  let completedStages: [String]?
  let error: String?
  let exitCode: Int?
  let failedStage: String?
  let hostCommitted: Bool?
  let ok: Bool?
  let reasonCode: String?
  let recoveryCommand: String?
  let setupPlan: BrokerSetupPlan?
  let started: Bool?
  let status: String?
  let unchanged: Bool?

  init(
    completedStages: [String]? = nil,
    error: String?,
    exitCode: Int?,
    failedStage: String? = nil,
    hostCommitted: Bool? = nil,
    ok: Bool?,
    reasonCode: String?,
    recoveryCommand: String? = nil,
    setupPlan: BrokerSetupPlan? = nil,
    started: Bool?,
    status: String? = nil,
    unchanged: Bool?
  ) {
    self.completedStages = completedStages
    self.error = error
    self.exitCode = exitCode
    self.failedStage = failedStage
    self.hostCommitted = hostCommitted
    self.ok = ok
    self.reasonCode = reasonCode
    self.recoveryCommand = recoveryCommand
    self.setupPlan = setupPlan
    self.started = started
    self.status = status
    self.unchanged = unchanged
  }

  init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    completedStages = try container.decodeIfPresent([String].self, forKey: .completedStages)
    error = try container.decodeIfPresent(String.self, forKey: .error)
    exitCode = try container.decodeIfPresent(Int.self, forKey: .exitCode)
    failedStage = try container.decodeIfPresent(String.self, forKey: .failedStage)
    hostCommitted = try container.decodeIfPresent(Bool.self, forKey: .hostCommitted)
    ok = try container.decodeIfPresent(Bool.self, forKey: .ok)
    reasonCode = try container.decodeIfPresent(String.self, forKey: .reasonCode)
    recoveryCommand = try container.decodeIfPresent(String.self, forKey: .recoveryCommand)
    setupPlan = try? BrokerSetupPlan(from: decoder)
    started = try container.decodeIfPresent(Bool.self, forKey: .started)
    status = try container.decodeIfPresent(String.self, forKey: .status)
    unchanged = try container.decodeIfPresent(Bool.self, forKey: .unchanged)
  }

  private enum CodingKeys: String, CodingKey {
    case completedStages
    case error
    case exitCode
    case failedStage
    case hostCommitted
    case ok
    case reasonCode
    case recoveryCommand
    case started
    case status
    case unchanged
  }
}

enum BrokerCLICommandError: LocalizedError, Sendable {
  case commandFailed(String)
  case invalidJSONResponse(URL)
  case missingCLI(URL)
  case processTimedOut(URL)
  case processFailure(String)

  var errorDescription: String? {
    switch self {
    case let .commandFailed(message):
      return message
    case let .invalidJSONResponse(url):
      return "Broker CLI at \(url.path) returned invalid JSON."
    case let .missingCLI(url):
      return "Broker CLI was not found at \(url.path). Reinstall Simulator Broker or set SIMBROKER_CLI_PATH."
    case let .processTimedOut(url):
      return "Broker CLI at \(url.path) did not finish before the timeout."
    case let .processFailure(message):
      return message
    }
  }
}

private func descendantProcessIdentifiers(
  of rootPID: pid_t,
  timeoutNanoseconds: UInt64 = processDiscoveryTimeoutNanoseconds
) -> [pid_t] {
  let process = Process()
  let stdoutPipe = Pipe()
  let stdoutBuffer = ProcessOutputBuffer()
  process.executableURL = URL(fileURLWithPath: "/bin/ps")
  process.arguments = ["-axo", "pid=,ppid="]
  process.standardOutput = stdoutPipe
  process.standardError = Pipe()
  stdoutPipe.fileHandleForReading.readabilityHandler = { handle in
    stdoutBuffer.drainAvailableData(from: handle)
  }
  let didTerminate = DispatchSemaphore(value: 0)
  process.terminationHandler = { _ in
    didTerminate.signal()
  }

  do {
    try process.run()
  } catch {
    process.terminationHandler = nil
    stdoutPipe.fileHandleForReading.readabilityHandler = nil
    return []
  }

  let boundedTimeout = Int(min(timeoutNanoseconds, UInt64(Int.max)))
  if didTerminate.wait(timeout: .now() + .nanoseconds(boundedTimeout)) == .timedOut {
    process.terminationHandler = nil
    stdoutPipe.fileHandleForReading.readabilityHandler = nil
    if process.isRunning {
      process.terminate()
    }
    return []
  }
  process.terminationHandler = nil
  stdoutPipe.fileHandleForReading.readabilityHandler = nil
  guard process.terminationStatus == 0 else {
    return []
  }

  let output = String(
    decoding: stdoutBuffer.snapshot(appendingRemainderFrom: stdoutPipe.fileHandleForReading),
    as: UTF8.self
  )
  var childrenByParent: [pid_t: [pid_t]] = [:]
  for line in output.split(separator: "\n") {
    let columns = line.split(whereSeparator: { $0 == " " || $0 == "\t" })
    guard columns.count >= 2,
          let pid = pid_t(columns[0]),
          let parentPID = pid_t(columns[1])
    else {
      continue
    }
    childrenByParent[parentPID, default: []].append(pid)
  }

  var descendants: [pid_t] = []
  var stack = childrenByParent[rootPID] ?? []
  while let pid = stack.popLast() {
    descendants.append(pid)
    stack.append(contentsOf: childrenByParent[pid] ?? [])
  }
  return descendants
}

protocol BrokerLocalCommandRunning: Sendable {
  func run(cliPath: URL, arguments: [String]) async throws -> BrokerCLICommandEnvelope
}

struct ProcessBrokerLocalCommandRunner: BrokerLocalCommandRunning {
  var timeoutNanoseconds: UInt64?
  private let processTreeResolver: @Sendable (pid_t) -> [pid_t]

  init(
    timeoutNanoseconds: UInt64? = nil,
    processTreeResolver: @escaping @Sendable (pid_t) -> [pid_t] = {
      descendantProcessIdentifiers(of: $0)
    }
  ) {
    self.timeoutNanoseconds = timeoutNanoseconds
    self.processTreeResolver = processTreeResolver
  }

  func resolvedTimeoutNanoseconds(for arguments: [String]) -> UInt64 {
    timeoutNanoseconds ?? BrokerLocalCommandTimeouts.timeoutNanoseconds(for: arguments)
  }

  func run(cliPath: URL, arguments: [String]) async throws -> BrokerCLICommandEnvelope {
    guard FileManager.default.isExecutableFile(atPath: cliPath.path) else {
      throw BrokerCLICommandError.missingCLI(cliPath)
    }

    let process = Process()
    let stdoutPipe = Pipe()
    let stderrPipe = Pipe()
    let stdoutBuffer = ProcessOutputBuffer()
    let stderrBuffer = ProcessOutputBuffer()

    process.executableURL = cliPath
    process.arguments = arguments
    process.standardOutput = stdoutPipe
    process.standardError = stderrPipe

    let state = ProcessRunState(
      process: process,
      stdoutPipe: stdoutPipe,
      stderrPipe: stderrPipe,
      stdoutBuffer: stdoutBuffer,
      stderrBuffer: stderrBuffer,
      processTreeResolver: processTreeResolver
    )
    let effectiveTimeoutNanoseconds = resolvedTimeoutNanoseconds(for: arguments)

    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        guard state.installContinuation(continuation) else { return }

        stdoutPipe.fileHandleForReading.readabilityHandler = { handle in
          stdoutBuffer.drainAvailableData(from: handle)
        }
        stderrPipe.fileHandleForReading.readabilityHandler = { handle in
          stderrBuffer.drainAvailableData(from: handle)
        }

        process.terminationHandler = { completedProcess in
          state.finishFromTermination(completedProcess, cliPath: cliPath)
        }

        do {
          try process.run()
          state.markProcessStarted()
        } catch {
          state.finish(.failure(BrokerCLICommandError.processFailure(error.localizedDescription)))
          return
        }

        state.installTimeoutTask(Task { [state, cliPath, effectiveTimeoutNanoseconds] in
          do {
            try await Task.sleep(nanoseconds: effectiveTimeoutNanoseconds)
          } catch {
            return
          }
          state.terminateAndFail(BrokerCLICommandError.processTimedOut(cliPath))
        })
      }
    } onCancel: {
      state.terminateAndFail(CancellationError())
    }
  }
}

private enum BrokerLocalCommandTimeouts {
  private static let commandTransferWindowCount = 2
  private static let commandLauncherOverheadSeconds = 5
  private static let defaultContainmentPostKillWaitMilliseconds = 50
  private static let defaultContainmentTermWaitMilliseconds = 250
  private static let defaultCommandTimeoutNanoseconds: UInt64 = 30 * 1_000_000_000
  private static let defaultLockTimeoutSeconds = 60
  private static let processSamplerInvocationsPerStateLoad = 1
  private static let processSamplerTimeoutSeconds = 10
  private static let serviceStartHostAliasCount = 6
  private static let serviceStartLeaseLockWaits = 2
  private static let serviceStartLockProcessSamplerInvocations = 2
  private static let serviceStartStateLoads = 2
  private static let simctlCommandTimeoutSeconds = 120
  private static let simctlInventoryCommandsPerStateLoad = 3
  private static let staleContainmentProcessSamplerInvocations = 8
  private static let stateLoadBudgetSeconds = (simctlInventoryCommandsPerStateLoad * simctlCommandTimeoutSeconds)
    + (processSamplerInvocationsPerStateLoad * processSamplerTimeoutSeconds)
  private static let knownGroups = Set([
    "app",
    "capacity",
    "doctor",
    "host",
    "lease",
    "pin",
    "project",
    "service",
    "simulators",
  ])
  private enum ParsedFlagValue {
    case present
    case value(String)
  }

  static func timeoutNanoseconds(for arguments: [String]) -> UInt64 {
    let flags = flagMap(from: arguments)
    if let setupIndex = arguments.firstIndex(of: "setup") {
      let isApply = arguments[(setupIndex + 1)...].contains("--apply")
      return secondsToNanoseconds(isApply ? 7_200 : 600)
    }
    if let commandGroup = localCommandGroup(in: arguments),
       commandGroup == ("service", "start") {
      let paths = runtimePaths(from: flags)
      let hostAliasCount = serviceStartHostAliasCount(from: paths)
      return secondsToNanoseconds(
        serviceStartTimeoutSeconds(paths: paths, hostAliasCount: hostAliasCount) + commandLauncherOverheadSeconds
      )
    }
    guard let request = brokerCommandRequest(from: arguments, flags: flags) else {
      return defaultCommandTimeoutNanoseconds
    }
    let paths = runtimePaths(from: flags)
    return secondsToNanoseconds((request.timeoutBudget(paths: paths).transferTimeoutSeconds * commandTransferWindowCount) + commandLauncherOverheadSeconds)
  }

  private static func secondsToNanoseconds(_ seconds: Int) -> UInt64 {
    UInt64(max(1, seconds)) * 1_000_000_000
  }

  private static func serviceStartTimeoutSeconds(paths: BrokerRuntimePaths?, hostAliasCount: Int) -> Int {
    (serviceStartStateLoads * stateLoadBudgetSeconds)
      + staleContainmentBudgetSeconds(paths: paths)
      + (serviceStartLeaseLockWaits * defaultLockTimeoutSeconds)
      + (max(0, hostAliasCount) * simctlCommandTimeoutSeconds)
      + (serviceStartLockProcessSamplerInvocations * processSamplerTimeoutSeconds)
  }

  private static func staleContainmentBudgetSeconds(paths: BrokerRuntimePaths?) -> Int {
    let staleLeaseCount = staleContainmentLeaseCount(paths: paths)
    guard staleLeaseCount > 0 else {
      return 0
    }
    let budgetMilliseconds = staleLeaseCount * (
      (staleContainmentProcessSamplerInvocations * processSamplerTimeoutSeconds * 1000)
        + defaultContainmentTermWaitMilliseconds
        + defaultContainmentPostKillWaitMilliseconds
    )
    return Int(ceil(Double(budgetMilliseconds) / 1000.0))
  }

  private static func staleContainmentLeaseCount(paths: BrokerRuntimePaths?) -> Int {
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

  private static func serviceStartHostAliasCount(from paths: BrokerRuntimePaths?) -> Int {
    guard let paths,
          let data = try? Data(contentsOf: paths.hostConfigURL),
          let hostConfig = try? JSONDecoder().decode(BrokerServiceStartHostConfigTimeoutSummary.self, from: data),
          let aliases = hostConfig.aliases else {
      return serviceStartHostAliasCount
    }
    return aliases.count
  }

  private static func brokerCommandRequest(from arguments: [String], flags: [String: ParsedFlagValue]) -> BrokerCommandRequest? {
    guard let (group, command) = localCommandGroup(in: arguments) else {
      return nil
    }
    var options: [String: BrokerJSONValue] = [:]
    if group == "host", command == "init" {
      options["bootstrapConfig"] = .bool(booleanFlag(named: "bootstrap-config", in: flags))
      options["force"] = .bool(booleanFlag(named: "force", in: flags))
    }
    if group == "capacity", command == "reconcile" {
      options["apply"] = .bool(booleanFlag(named: "apply", in: flags))
    }
    if group == "lease", command == "contain" {
      options["captureDiagnostics"] = .bool(booleanFlag(named: "capture-diagnostics", in: flags))
      if let termWait = integerFlag(named: "term-wait-ms", in: flags) {
        options["termWaitMs"] = .int(termWait)
      }
    }
    return BrokerCommandRequest(command: command, group: group, options: options)
  }

  private static func runtimePaths(from flags: [String: ParsedFlagValue]) -> BrokerRuntimePaths? {
    guard let stateRoot = stringFlag(named: "state-root", in: flags),
          let hostConfigPath = stringFlag(named: "host-config", in: flags) else {
      return nil
    }
    return BrokerRuntimePaths(
      stateRoot: URL(fileURLWithPath: stateRoot),
      hostConfigURL: URL(fileURLWithPath: hostConfigPath)
    )
  }

  private static func localCommandGroup(in arguments: [String]) -> (String, String)? {
    for (index, argument) in arguments.enumerated() where knownGroups.contains(argument) {
      if argument == "doctor" {
        return ("doctor", "status")
      }
      for candidate in arguments.dropFirst(index + 1) where candidate.hasPrefix("--") == false {
        return (argument, candidate)
      }
      return nil
    }
    return nil
  }

  private static func flagMap(from arguments: [String]) -> [String: ParsedFlagValue] {
    var flags: [String: ParsedFlagValue] = [:]
    var index = 0
    while index < arguments.count {
      let argument = arguments[index]
      guard argument.hasPrefix("--") else {
        index += 1
        continue
      }
      let trimmed = String(argument.dropFirst(2))
      if let equalsIndex = trimmed.firstIndex(of: "=") {
        let key = String(trimmed[..<equalsIndex])
        let value = String(trimmed[trimmed.index(after: equalsIndex)...])
        flags[key] = .value(value)
        index += 1
        continue
      }
      if arguments.indices.contains(index + 1),
         arguments[index + 1].hasPrefix("--") == false {
        flags[trimmed] = .value(arguments[index + 1])
        index += 2
      } else {
        flags[trimmed] = .present
        index += 1
      }
    }
    return flags
  }

  private static func booleanFlag(named name: String, in flags: [String: ParsedFlagValue]) -> Bool {
    guard let value = flags[name] else {
      return false
    }
    switch value {
    case .present:
      return true
    case let .value(value):
      return value == "true"
    }
  }

  private static func integerFlag(named name: String, in flags: [String: ParsedFlagValue]) -> Int? {
    guard let value = flags[name] else {
      return nil
    }
    switch value {
    case .present:
      return nil
    case let .value(value):
      return Int(value)
    }
  }

  private static func stringFlag(named name: String, in flags: [String: ParsedFlagValue]) -> String? {
    guard let value = flags[name] else {
      return nil
    }
    switch value {
    case .present:
      return nil
    case let .value(value):
      return value.isEmpty ? nil : value
    }
  }
}

private struct BrokerServiceStartHostConfigTimeoutSummary: Decodable {
  let aliases: [BrokerServiceStartHostConfigTimeoutAlias]?
}

private struct BrokerServiceStartHostConfigTimeoutAlias: Decodable {}
