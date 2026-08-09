import Foundation
import Darwin

struct BrokerRuntimePaths: Sendable {
  static let cliPathArgumentName = "--cli-path"
  static let cliPathEnvironmentKey = "SIMBROKER_CLI_PATH"
  static let cliPathUserDefaultsKey = "SIMBROKER_CLI_PATH"
  static let hostConfigArgumentName = "--host-config"
  static let hostConfigEnvironmentKey = "SIMBROKER_HOST_CONFIG"
  static let hostConfigUserDefaultsKey = "SIMBROKER_HOST_CONFIG"
  static let stateRootArgumentName = "--state-root"
  static let stateRootEnvironmentKey = "SIMBROKER_STATE_ROOT"
  static let stateRootUserDefaultsKey = "SIMBROKER_STATE_ROOT"

  let configuredCLIURL: URL?
  let hostConfigURL: URL
  let stateRoot: URL

  init(
    stateRoot: URL,
    hostConfigURL: URL? = nil,
    configuredCLIURL: URL? = nil
  ) {
    self.configuredCLIURL = configuredCLIURL
    self.hostConfigURL = hostConfigURL ?? Self.defaultHostConfig()
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
      configuredCLIURL: resolvedOptionalURL(override: environment[cliPathEnvironmentKey])
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
}

enum BrokerSnapshotLoaderError: LocalizedError {
  case unreadableFile(URL, Error)

  var errorDescription: String? {
    switch self {
    case let .unreadableFile(url, underlying):
      return "Failed to read \(url.lastPathComponent): \(underlying.localizedDescription)"
    }
  }
}

protocol BrokerSnapshotLoading: Sendable {
  func load() async throws -> BrokerLoadedState
}

private struct BrokerSnapshotServiceStatusEnvelope: Decodable, Sendable {
  let service: BrokerServiceMetadata?
}

actor FileBrokerSnapshotLoader: BrokerSnapshotLoading {
  private let decoder = JSONDecoder()
  private let paths: BrokerRuntimePaths
  private let processIdentifierExists: @Sendable (Int) -> Bool
  private let serviceStatusProbe: @Sendable (BrokerServiceMetadata) async -> BrokerServiceMetadata?

  init(
    paths: BrokerRuntimePaths = .fromLaunchContext(),
    processIdentifierExists: @escaping @Sendable (Int) -> Bool = FileBrokerSnapshotLoader.defaultProcessIdentifierExists,
    serviceStatusProbe: @escaping @Sendable (BrokerServiceMetadata) async -> BrokerServiceMetadata? = FileBrokerSnapshotLoader.defaultServiceStatusProbe
  ) {
    self.paths = paths
    self.processIdentifierExists = processIdentifierExists
    self.serviceStatusProbe = serviceStatusProbe
  }

  func load() async throws -> BrokerLoadedState {
    let installMetadata = try decodeIfPresent(BrokerInstallMetadata.self, from: paths.installMetadataURL)
    let hostConfigExists = FileManager.default.fileExists(atPath: paths.hostConfigURL.path)
    let service = try await loadServiceMetadata()
    let snapshot = try loadSnapshot(hostConfigExists: hostConfigExists)
    return BrokerLoadedState(
      paths: paths,
      tooling: BrokerToolingState(
        cliPath: resolveCLIPath(installMetadata: installMetadata),
        hostConfigExists: hostConfigExists,
        installMetadata: installMetadata
      ),
      service: service,
      snapshot: snapshot
    )
  }

  private func loadServiceMetadata() async throws -> BrokerServiceMetadata? {
    guard let service = try decodeIfPresent(BrokerServiceMetadata.self, from: paths.serviceMetadataURL) else {
      return nil
    }

    guard normalizedPath(service.stateRoot) == normalizedPath(paths.stateRoot.path),
          normalizedPath(service.hostConfigPath) == normalizedPath(paths.hostConfigURL.path) else {
      return nil
    }

    guard let liveService = await liveServiceMetadata(for: service) else {
      return nil
    }

    return liveService
  }

  private func liveServiceMetadata(for service: BrokerServiceMetadata) async -> BrokerServiceMetadata? {
    guard service.pid > 1,
          processIdentifierExists(service.pid),
          FileManager.default.fileExists(atPath: service.socketPath),
          let liveService = await serviceStatusProbe(service) else {
      return nil
    }

    guard normalizedPath(liveService.stateRoot) == normalizedPath(paths.stateRoot.path),
          normalizedPath(liveService.hostConfigPath) == normalizedPath(paths.hostConfigURL.path),
          normalizedPath(liveService.socketPath) == normalizedPath(service.socketPath) else {
      return nil
    }

    return liveService
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
    let fileManager = FileManager.default
    let candidates = [
      paths.configuredCLIURL,
      installMetadata?.cliPath.flatMap { cliPath in
        cliPath.isEmpty ? nil : URL(fileURLWithPath: (cliPath as NSString).expandingTildeInPath)
      },
      BrokerRuntimePaths.defaultCLIURL(),
    ]

    for candidate in candidates {
      guard let candidate else {
        continue
      }
      if fileManager.isExecutableFile(atPath: candidate.path) {
        return candidate
      }
    }

    return nil
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

  private static func defaultServiceStatusProbe(_ service: BrokerServiceMetadata) async -> BrokerServiceMetadata? {
    do {
      let response = try await CurlBrokerServiceTransport(transferTimeoutSeconds: 2).perform(
        socketPath: service.socketPath,
        requestPath: "/v1/service/status",
        method: "GET",
        bodyData: nil,
        transferTimeoutSeconds: 2
      )
      guard (200 ... 299).contains(response.statusCode),
            let envelope = try? JSONDecoder().decode(BrokerSnapshotServiceStatusEnvelope.self, from: response.bodyData) else {
        return nil
      }
      return envelope.service
    } catch {
      return nil
    }
  }
}
