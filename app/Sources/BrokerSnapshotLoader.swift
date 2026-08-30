import Foundation
import Darwin

struct BrokerRuntimePaths: Sendable {
  static let cliPathArgumentName = "--cli-path"
  static let cliPathEnvironmentKey = "SIMBROKER_CLI_PATH"
  static let cliPathUserDefaultsKey = "SIMBROKER_CLI_PATH"
  static let hostConfigArgumentName = "--host-config"
  static let hostConfigEnvironmentKey = "SIMBROKER_HOST_CONFIG"
  static let hostConfigUserDefaultsKey = "SIMBROKER_HOST_CONFIG"
  static let serviceSocketArgumentName = "--service-socket"
  static let serviceSocketEnvironmentKey = "SIMBROKER_SERVICE_SOCKET"
  static let stateRootArgumentName = "--state-root"
  static let stateRootEnvironmentKey = "SIMBROKER_STATE_ROOT"
  static let stateRootUserDefaultsKey = "SIMBROKER_STATE_ROOT"

  let configuredCLIURL: URL?
  let hostConfigURL: URL
  let serviceSocketURL: URL?
  let stateRoot: URL

  init(
    stateRoot: URL,
    hostConfigURL: URL? = nil,
    configuredCLIURL: URL? = nil,
    serviceSocketURL: URL? = nil
  ) {
    self.configuredCLIURL = configuredCLIURL
    self.hostConfigURL = hostConfigURL ?? Self.defaultHostConfig()
    self.serviceSocketURL = serviceSocketURL
    self.stateRoot = stateRoot
  }

  var serviceMetadataURL: URL {
    stateRoot.appending(path: "brokerd.json")
  }

  var installMetadataURL: URL {
    FileManager.default.homeDirectoryForCurrentUser
      .appending(path: "Library")
      .appending(path: "Application Support")
      .appending(path: "SimulatorBroker")
      .appending(path: "install")
      .appending(path: "install.json")
  }

  var snapshotURL: URL {
    stateRoot.appending(path: "app-snapshot.json")
  }

  static func defaultCLIURL() -> URL {
    FileManager.default.homeDirectoryForCurrentUser
      .appending(path: ".local")
      .appending(path: "bin")
      .appending(path: "simbroker")
  }

  static func defaultHomebrewPrefixRoots(
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) -> [URL] {
    var roots: [URL] = []
    if let prefix = environment["HOMEBREW_PREFIX"], prefix.isEmpty == false {
      roots.append(URL(fileURLWithPath: (prefix as NSString).expandingTildeInPath))
    }
    roots.append(URL(fileURLWithPath: "/opt/homebrew"))
    roots.append(URL(fileURLWithPath: "/usr/local"))
    var seen = Set<String>()
    return roots.filter { seen.insert($0.standardizedFileURL.path).inserted }
  }

  static func cliCandidateURLs(
    configuredCLIURL: URL?,
    installMetadataCLIPath: String?,
    homebrewPrefixRoots: [URL] = defaultHomebrewPrefixRoots(),
    defaultCLIURL: URL = defaultCLIURL()
  ) -> [URL] {
    var candidates: [URL] = []
    if let configuredCLIURL {
      candidates.append(configuredCLIURL)
    }
    if let installMetadataCLIPath, installMetadataCLIPath.isEmpty == false {
      candidates.append(URL(fileURLWithPath: (installMetadataCLIPath as NSString).expandingTildeInPath))
    }
    for root in homebrewPrefixRoots {
      candidates.append(root.appending(path: "bin").appending(path: "simbroker"))
    }
    candidates.append(defaultCLIURL)
    var seen = Set<String>()
    return candidates.filter { seen.insert($0.standardizedFileURL.path).inserted }
  }

  static func firstExecutableCLIURL(
    among candidates: [URL],
    isExecutable: (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) }
  ) -> URL? {
    candidates.first { isExecutable($0.path) }
  }

  static func defaultInstallRoot() -> URL {
    FileManager.default.homeDirectoryForCurrentUser
      .appending(path: "Library")
      .appending(path: "Application Support")
      .appending(path: "SimulatorBroker")
      .appending(path: "install")
  }

  static func defaultHostConfig() -> URL {
    FileManager.default.homeDirectoryForCurrentUser
      .appending(path: "Library")
      .appending(path: "Application Support")
      .appending(path: "SimulatorBroker")
      .appending(path: "host-config.json")
  }

  static func defaultStateRoot() -> URL {
    FileManager.default.homeDirectoryForCurrentUser
      .appending(path: "Library")
      .appending(path: "Application Support")
      .appending(path: "SimulatorBroker")
      .appending(path: "state")
  }

  static func fromEnvironment(_ environment: [String: String] = ProcessInfo.processInfo.environment) -> BrokerRuntimePaths {
    BrokerRuntimePaths(
      stateRoot: resolvedURL(
        override: environment[stateRootEnvironmentKey],
        fallback: defaultStateRoot()
      ),
      hostConfigURL: resolvedURL(
        override: environment[hostConfigEnvironmentKey],
        fallback: defaultHostConfig()
      ),
      configuredCLIURL: resolvedOptionalURL(override: environment[cliPathEnvironmentKey]),
      serviceSocketURL: resolvedOptionalURL(override: environment[serviceSocketEnvironmentKey])
    )
  }

  static func fromLaunchContext(
    arguments: [String] = CommandLine.arguments,
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) -> BrokerRuntimePaths {
    BrokerRuntimePaths(
      stateRoot: resolvedURL(
        override: argumentValue(named: stateRootArgumentName, from: arguments)
          ?? environment[stateRootEnvironmentKey],
        fallback: defaultStateRoot()
      ),
      hostConfigURL: resolvedURL(
        override: argumentValue(named: hostConfigArgumentName, from: arguments)
          ?? environment[hostConfigEnvironmentKey],
        fallback: defaultHostConfig()
      ),
      configuredCLIURL: resolvedOptionalURL(
        override: argumentValue(named: cliPathArgumentName, from: arguments)
          ?? environment[cliPathEnvironmentKey]
      ),
      serviceSocketURL: resolvedOptionalURL(
        override: argumentValue(named: serviceSocketArgumentName, from: arguments)
          ?? environment[serviceSocketEnvironmentKey]
      )
    )
  }

  private static func normalizedURL(from rawValue: String) -> URL {
    URL(fileURLWithPath: (rawValue as NSString).expandingTildeInPath)
  }

  private static func resolvedOptionalURL(override rawValue: String?) -> URL? {
    guard let rawValue, rawValue.isEmpty == false else {
      return nil
    }
    return normalizedURL(from: rawValue)
  }

  private static func resolvedURL(override rawValue: String?, fallback: URL) -> URL {
    resolvedOptionalURL(override: rawValue) ?? fallback
  }

  private static func argumentValue(named name: String, from arguments: [String]) -> String? {
    var index = 0
    while index < arguments.count {
      let argument = arguments[index]
      if argument == name {
        let nextIndex = index + 1
        guard nextIndex < arguments.count else {
          return nil
        }
        return arguments[nextIndex]
      }

      if argument.hasPrefix("\(name)=") {
        return String(argument.dropFirst(name.count + 1))
      }

      index += 1
    }

    return nil
  }
}

struct BrokerInstallMetadata: Decodable, Sendable {
  let appPath: String?
  let cliPath: String?
  let installSource: String?
  let installedAt: String?
  let nodePath: String?
  let prefix: String?
}

struct BrokerToolingState: Sendable {
  let cliPath: URL?
  let hostConfigExists: Bool
  let installMetadata: BrokerInstallMetadata?
}

struct BrokerLoadedState: Sendable {
  let paths: BrokerRuntimePaths
  let tooling: BrokerToolingState
  let service: BrokerServiceMetadata?
  let snapshot: BrokerAppSnapshot?
  let serviceRequiresRestart: Bool

  init(
    paths: BrokerRuntimePaths,
    tooling: BrokerToolingState,
    service: BrokerServiceMetadata?,
    snapshot: BrokerAppSnapshot?,
    serviceRequiresRestart: Bool = false
  ) {
    self.paths = paths
    self.tooling = tooling
    self.service = service
    self.snapshot = snapshot
    self.serviceRequiresRestart = serviceRequiresRestart
  }
}

enum BrokerSnapshotLoaderError: LocalizedError {
  case unreadableFile(URL, Error)
  case unverifiedServiceStatus(String)

  var errorDescription: String? {
    switch self {
    case let .unreadableFile(url, underlying):
      return "Failed to read \(url.lastPathComponent): \(underlying.localizedDescription)"
    case let .unverifiedServiceStatus(reason):
      return "Failed to verify brokerd status: \(reason)"
    }
  }
}

struct BrokerSnapshotPartialLoadError: LocalizedError, Sendable {
  let recoveredState: BrokerLoadedState
  let message: String

  var errorDescription: String? {
    message
  }
}

struct BrokerServiceRestartRequiredStatus: Error, Sendable {
  let service: BrokerServiceMetadata
}

protocol BrokerSnapshotLoading: Sendable {
  func load() async throws -> BrokerLoadedState
}

private struct BrokerSnapshotServiceStatusEnvelope: Decodable, Sendable {
  let reasonCode: String?
  let running: Bool?
  let service: BrokerServiceMetadata?
}

private struct BrokerServiceLoadResult: Sendable {
  let service: BrokerServiceMetadata
  let requiresRestart: Bool
}

actor FileBrokerSnapshotLoader: BrokerSnapshotLoading {
  private let decoder = JSONDecoder()
  private let expectedRuntimeVersion: String
  private let paths: BrokerRuntimePaths
  private let processIdentifierExists: @Sendable (Int) -> Bool
  private let serviceStatusProbe: @Sendable (BrokerServiceMetadata) async throws -> BrokerServiceMetadata

  init(
    paths: BrokerRuntimePaths = .fromLaunchContext(),
    processIdentifierExists: @escaping @Sendable (Int) -> Bool = FileBrokerSnapshotLoader.defaultProcessIdentifierExists,
    serviceStatusProbe: @escaping @Sendable (BrokerServiceMetadata) async throws -> BrokerServiceMetadata = FileBrokerSnapshotLoader.defaultServiceStatusProbe,
    expectedRuntimeVersion: String = BrokerRuntimeBuildVersion.current
  ) {
    self.expectedRuntimeVersion = expectedRuntimeVersion
    self.paths = paths
    self.processIdentifierExists = processIdentifierExists
    self.serviceStatusProbe = serviceStatusProbe
  }

  func load() async throws -> BrokerLoadedState {
    let installMetadata = try decodeIfPresent(BrokerInstallMetadata.self, from: paths.installMetadataURL)
    let hostConfigExists = FileManager.default.fileExists(atPath: paths.hostConfigURL.path)
    let serviceResult = try await loadServiceMetadata()
    let tooling = BrokerToolingState(
      cliPath: resolveCLIPath(installMetadata: installMetadata),
      hostConfigExists: hostConfigExists,
      installMetadata: installMetadata
    )
    let snapshot: BrokerAppSnapshot?
    do {
      snapshot = try loadSnapshot(hostConfigExists: hostConfigExists)
    } catch {
      throw BrokerSnapshotPartialLoadError(
        recoveredState: BrokerLoadedState(
          paths: paths,
          tooling: tooling,
          service: serviceResult?.service,
          snapshot: nil,
          serviceRequiresRestart: serviceResult?.requiresRestart ?? false
        ),
        message: error.localizedDescription
      )
    }
    return BrokerLoadedState(
      paths: paths,
      tooling: tooling,
      service: serviceResult?.service,
      snapshot: snapshot,
      serviceRequiresRestart: serviceResult?.requiresRestart ?? false
    )
  }

  private func loadServiceMetadata() async throws -> BrokerServiceLoadResult? {
    guard let service = try decodeIfPresent(BrokerServiceMetadata.self, from: paths.serviceMetadataURL) else {
      return nil
    }

    guard service.runtimeVersion != nil,
          normalizedPath(service.stateRoot) == normalizedPath(paths.stateRoot.path),
          normalizedPath(service.hostConfigPath) == normalizedPath(paths.hostConfigURL.path),
          configuredServiceSocketMatches(service.socketPath) else {
      return nil
    }

    guard let liveService = try await liveServiceMetadata(for: service) else {
      return nil
    }

    return liveService
  }

  private func liveServiceMetadata(for service: BrokerServiceMetadata) async throws -> BrokerServiceLoadResult? {
    guard service.pid > 1,
          processIdentifierExists(service.pid),
          FileManager.default.fileExists(atPath: service.socketPath) else {
      return nil
    }
    let result: BrokerServiceLoadResult
    do {
      result = BrokerServiceLoadResult(
        service: try await serviceStatusProbe(service),
        requiresRestart: false
      )
    } catch let restartStatus as BrokerServiceRestartRequiredStatus {
      result = BrokerServiceLoadResult(service: restartStatus.service, requiresRestart: true)
    }
    let liveService = result.service

    let selectedIdentityMatches = normalizedPath(liveService.stateRoot) == normalizedPath(paths.stateRoot.path)
      && normalizedPath(liveService.hostConfigPath) == normalizedPath(paths.hostConfigURL.path)
      && normalizedPath(liveService.socketPath) == normalizedPath(service.socketPath)
      && configuredServiceSocketMatches(liveService.socketPath)
      && liveService.runtimeVersion == service.runtimeVersion

    guard selectedIdentityMatches else {
      if result.requiresRestart {
        throw BrokerSnapshotLoaderError.unverifiedServiceStatus(
          "brokerd restart status did not match the selected runtime identity."
        )
      }
      return nil
    }

    guard result.requiresRestart || liveService.runtimeVersion == expectedRuntimeVersion else {
      return nil
    }

    return result
  }

  private func configuredServiceSocketMatches(_ socketPath: String) -> Bool {
    guard let serviceSocketURL = paths.serviceSocketURL else {
      return true
    }
    return normalizedPath(socketPath) == normalizedPath(serviceSocketURL.path)
  }

  private func loadSnapshot(hostConfigExists: Bool) throws -> BrokerAppSnapshot? {
    guard let snapshot = try decodeIfPresent(BrokerAppSnapshot.self, from: paths.snapshotURL) else {
      return nil
    }

    guard let snapshotHostConfigPath = snapshot.hostConfigPath,
          hostConfigExists,
          normalizedPath(snapshot.stateRoot) == normalizedPath(paths.stateRoot.path),
          normalizedPath(snapshotHostConfigPath) == normalizedPath(paths.hostConfigURL.path) else {
      return nil
    }

    return snapshot
  }

  private func decodeIfPresent<T: Decodable>(_ type: T.Type, from url: URL) throws -> T? {
    guard FileManager.default.fileExists(atPath: url.path) else {
      return nil
    }

    do {
      let data = try Data(contentsOf: url)
      return try decoder.decode(type, from: data)
    } catch {
      throw BrokerSnapshotLoaderError.unreadableFile(url, error)
    }
  }

  private func resolveCLIPath(installMetadata: BrokerInstallMetadata?) -> URL? {
    BrokerRuntimePaths.firstExecutableCLIURL(
      among: BrokerRuntimePaths.cliCandidateURLs(
        configuredCLIURL: paths.configuredCLIURL,
        installMetadataCLIPath: installMetadata?.cliPath
      )
    )
  }

  private func normalizedPath(_ rawPath: String) -> String {
    URL(fileURLWithPath: (rawPath as NSString).expandingTildeInPath)
      .standardizedFileURL
      .path
  }

  private static func defaultProcessIdentifierExists(_ pid: Int) -> Bool {
    guard pid > 1, pid <= Int(Int32.max) else {
      return false
    }

    if kill(pid_t(pid), 0) == 0 {
      return true
    }

    return errno == EPERM
  }

  private static func defaultServiceStatusProbe(_ service: BrokerServiceMetadata) async throws -> BrokerServiceMetadata {
    let response = try await CurlBrokerServiceTransport(transferTimeoutSeconds: 2).perform(
      socketPath: service.socketPath,
      requestPath: "/v1/service/status",
      method: "GET",
      bodyData: nil,
      transferTimeoutSeconds: 2
    )
    return try decodeServiceStatusResponse(response)
  }

  static func decodeServiceStatusResponse(_ response: BrokerHTTPResponse) throws -> BrokerServiceMetadata {
    guard response.statusCode == 200 || response.statusCode == 409 else {
      throw BrokerSnapshotLoaderError.unverifiedServiceStatus(
        "brokerd returned HTTP status \(response.statusCode)."
      )
    }
    let envelope: BrokerSnapshotServiceStatusEnvelope
    do {
      envelope = try JSONDecoder().decode(BrokerSnapshotServiceStatusEnvelope.self, from: response.bodyData)
    } catch {
      throw BrokerSnapshotLoaderError.unverifiedServiceStatus("brokerd returned malformed status JSON.")
    }
    if response.statusCode == 200 {
      guard let service = envelope.service else {
        throw BrokerSnapshotLoaderError.unverifiedServiceStatus("brokerd status omitted service metadata.")
      }
      guard envelope.running == true else {
        throw BrokerSnapshotLoaderError.unverifiedServiceStatus(
          "brokerd status did not confirm a running service."
        )
      }
      return service
    }

    guard envelope.reasonCode == "service-runtime-incompatible",
          envelope.running == true else {
      throw BrokerSnapshotLoaderError.unverifiedServiceStatus(
        "brokerd returned HTTP status \(response.statusCode)."
      )
    }
    guard let service = envelope.service else {
      throw BrokerSnapshotLoaderError.unverifiedServiceStatus("brokerd status omitted service metadata.")
    }
    throw BrokerServiceRestartRequiredStatus(service: service)
  }
}
