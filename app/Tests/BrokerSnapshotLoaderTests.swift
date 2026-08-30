import XCTest
@testable import SimulatorBrokerApp

final class BrokerSnapshotLoaderTests: XCTestCase {
  private let runtimeVersion = "test-runtime-version"

  // Ignore snapshots that point at a different broker root than the configured runtime.
  func testLoaderIgnoresSnapshotWhenEmbeddedStateRootDoesNotMatchConfiguredPath() async throws {
    let tempRoot = try makeTempRoot()
    let paths = BrokerRuntimePaths(
      stateRoot: tempRoot.appending(path: "state"),
      hostConfigURL: tempRoot.appending(path: "host-config.json")
    )
    try Data("{}".utf8).write(to: paths.hostConfigURL)
    try writeFixtureSnapshot(
      named: "busy-snapshot",
      overrides: [
        "hostConfigPath": paths.hostConfigURL.path,
        "stateRoot": "/tmp/simbroker-fixture/state",
      ],
      to: paths.snapshotURL
    )

    let loadedState = try await FileBrokerSnapshotLoader(paths: paths).load()

    XCTAssertTrue(loadedState.tooling.hostConfigExists)
    XCTAssertNil(loadedState.snapshot)
  }

  func testLoaderIgnoresSnapshotWhenHostConfigIsMissing() async throws {
    let tempRoot = try makeTempRoot()
    let paths = BrokerRuntimePaths(
      stateRoot: tempRoot.appending(path: "state"),
      hostConfigURL: tempRoot.appending(path: "host-config.json")
    )
    try writeFixtureSnapshot(
      named: "busy-snapshot",
      overrides: [
        "hostConfigPath": paths.hostConfigURL.path,
        "stateRoot": paths.stateRoot.path,
      ],
      to: paths.snapshotURL
    )

    let loadedState = try await FileBrokerSnapshotLoader(paths: paths).load()

    XCTAssertFalse(loadedState.tooling.hostConfigExists)
    XCTAssertNil(loadedState.snapshot)
  }

  func testLoaderIgnoresSnapshotWhenEmbeddedHostConfigPathDoesNotMatchConfiguredPath() async throws {
    let tempRoot = try makeTempRoot()
    let paths = BrokerRuntimePaths(
      stateRoot: tempRoot.appending(path: "state"),
      hostConfigURL: tempRoot.appending(path: "host-config.json")
    )
    try Data("{}".utf8).write(to: paths.hostConfigURL)
    try writeFixtureSnapshot(
      named: "busy-snapshot",
      overrides: [
        "hostConfigPath": tempRoot.appending(path: "other-host-config.json").path,
        "stateRoot": paths.stateRoot.path,
      ],
      to: paths.snapshotURL
    )

    let loadedState = try await FileBrokerSnapshotLoader(paths: paths).load()

    XCTAssertNil(loadedState.snapshot)
  }

  func testLoaderAcceptsSnapshotWhenEmbeddedPathsMatchConfiguredRuntime() async throws {
    let tempRoot = try makeTempRoot()
    let paths = BrokerRuntimePaths(
      stateRoot: tempRoot.appending(path: "state"),
      hostConfigURL: tempRoot.appending(path: "host-config.json")
    )
    try Data("{}".utf8).write(to: paths.hostConfigURL)
    try writeFixtureSnapshot(
      named: "busy-snapshot",
      overrides: [
        "hostConfigPath": paths.hostConfigURL.path,
        "stateRoot": paths.stateRoot.path,
      ],
      to: paths.snapshotURL
    )

    let loadedState = try await FileBrokerSnapshotLoader(paths: paths).load()

    XCTAssertEqual(loadedState.snapshot?.hostConfigPath, paths.hostConfigURL.path)
  }

  func testLoaderIgnoresServiceMetadataWhenPathsDoNotMatchConfiguredRuntime() async throws {
    let tempRoot = try makeTempRoot()
    let paths = BrokerRuntimePaths(
      stateRoot: tempRoot.appending(path: "state"),
      hostConfigURL: tempRoot.appending(path: "host-config.json")
    )
    try Data("{}".utf8).write(to: paths.hostConfigURL)
    try writeJson(
      [
        "hostConfigPath": "/tmp/fixture-host.json",
        "pid": 123,
        "runtimeVersion": runtimeVersion,
        "socketPath": "/tmp/simbroker.sock",
        "startedAt": "2026-04-10T00:00:00Z",
        "stateRoot": "/tmp/simbroker-fixture/state",
        "transport": "unix-http",
      ],
      to: paths.serviceMetadataURL
    )

    let loadedState = try await FileBrokerSnapshotLoader(
      paths: paths,
      expectedRuntimeVersion: runtimeVersion
    ).load()

    XCTAssertNil(loadedState.service)
  }

  func testLoaderIgnoresServiceMetadataWhenRecordedProcessIsNotAlive() async throws {
    let tempRoot = try makeTempRoot()
    let paths = BrokerRuntimePaths(
      stateRoot: tempRoot.appending(path: "state"),
      hostConfigURL: tempRoot.appending(path: "host-config.json")
    )
    try Data("{}".utf8).write(to: paths.hostConfigURL)
    let socketURL = paths.stateRoot.appending(path: "broker.sock")
    try FileManager.default.createDirectory(at: socketURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data().write(to: socketURL)
    try writeJson(
      [
        "hostConfigPath": paths.hostConfigURL.path,
        "pid": 424242,
        "runtimeVersion": runtimeVersion,
        "socketPath": socketURL.path,
        "startedAt": "2026-04-10T00:00:00Z",
        "stateRoot": paths.stateRoot.path,
        "transport": "unix-http",
      ],
      to: paths.serviceMetadataURL
    )

    let loadedState = try await FileBrokerSnapshotLoader(
      paths: paths,
      processIdentifierExists: { _ in false },
      expectedRuntimeVersion: runtimeVersion
    ).load()

    XCTAssertNil(loadedState.service)
  }

  func testLoaderIgnoresServiceMetadataWhenStatusProbeDoesNotConfirmLiveDaemon() async throws {
    let tempRoot = try makeTempRoot()
    let paths = BrokerRuntimePaths(
      stateRoot: tempRoot.appending(path: "state"),
      hostConfigURL: tempRoot.appending(path: "host-config.json")
    )
    try Data("{}".utf8).write(to: paths.hostConfigURL)
    let socketURL = paths.stateRoot.appending(path: "broker.sock")
    try FileManager.default.createDirectory(at: socketURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data().write(to: socketURL)
    try writeJson(
      [
        "hostConfigPath": paths.hostConfigURL.path,
        "pid": 12345,
        "runtimeVersion": runtimeVersion,
        "socketPath": socketURL.path,
        "startedAt": "2026-04-10T00:00:00Z",
        "stateRoot": paths.stateRoot.path,
        "transport": "unix-http",
      ],
      to: paths.serviceMetadataURL
    )

    let loadedState = try await FileBrokerSnapshotLoader(
      paths: paths,
      processIdentifierExists: { pid in pid == 12345 },
      serviceStatusProbe: { _ in nil },
      expectedRuntimeVersion: runtimeVersion
    ).load()

    XCTAssertNil(loadedState.service)
  }

  func testLoaderIgnoresServiceMetadataWhenLiveStatusReportsDifferentIdentity() async throws {
    let tempRoot = try makeTempRoot()
    let paths = BrokerRuntimePaths(
      stateRoot: tempRoot.appending(path: "state"),
      hostConfigURL: tempRoot.appending(path: "host-config.json")
    )
    try Data("{}".utf8).write(to: paths.hostConfigURL)
    let socketURL = paths.stateRoot.appending(path: "broker.sock")
    try FileManager.default.createDirectory(at: socketURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data().write(to: socketURL)
    try writeJson(
      [
        "hostConfigPath": paths.hostConfigURL.path,
        "pid": 12345,
        "runtimeVersion": runtimeVersion,
        "socketPath": socketURL.path,
        "startedAt": "2026-04-10T00:00:00Z",
        "stateRoot": paths.stateRoot.path,
        "transport": "unix-http",
      ],
      to: paths.serviceMetadataURL
    )

    let loadedState = try await FileBrokerSnapshotLoader(
      paths: paths,
      processIdentifierExists: { pid in pid == 12345 },
      serviceStatusProbe: { service in
        BrokerServiceMetadata(
          hostConfigPath: service.hostConfigPath,
          pid: service.pid,
          socketPath: service.socketPath,
          startedAt: service.startedAt,
          stateRoot: "/tmp/other-simbroker-state",
          transport: service.transport,
          runtimeVersion: service.runtimeVersion
        )
      },
      expectedRuntimeVersion: runtimeVersion
    ).load()

    XCTAssertNil(loadedState.service)
  }

  func testLoaderAcceptsServiceMetadataWhenLiveStatusMatchesRuntime() async throws {
    let tempRoot = try makeTempRoot()
    let paths = BrokerRuntimePaths(
      stateRoot: tempRoot.appending(path: "state"),
      hostConfigURL: tempRoot.appending(path: "host-config.json")
    )
    try Data("{}".utf8).write(to: paths.hostConfigURL)
    let socketURL = paths.stateRoot.appending(path: "broker.sock")
    try FileManager.default.createDirectory(at: socketURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data().write(to: socketURL)
    try writeJson(
      [
        "hostConfigPath": paths.hostConfigURL.path,
        "pid": 12345,
        "runtimeVersion": runtimeVersion,
        "socketPath": socketURL.path,
        "startedAt": "2026-04-10T00:00:00Z",
        "stateRoot": paths.stateRoot.path,
        "transport": "unix-http",
      ],
      to: paths.serviceMetadataURL
    )

    let loadedState = try await FileBrokerSnapshotLoader(
      paths: paths,
      processIdentifierExists: { pid in pid == 12345 },
      serviceStatusProbe: { service in service },
      expectedRuntimeVersion: runtimeVersion
    ).load()

    XCTAssertEqual(loadedState.service?.pid, 12345)
    XCTAssertEqual(loadedState.service?.runtimeVersion, runtimeVersion)
  }

  func testLoaderIgnoresLegacyServiceMetadataWithoutRuntimeVersion() async throws {
    let tempRoot = try makeTempRoot()
    let paths = BrokerRuntimePaths(
      stateRoot: tempRoot.appending(path: "state"),
      hostConfigURL: tempRoot.appending(path: "host-config.json")
    )
    let socketURL = paths.stateRoot.appending(path: "broker.sock")
    try FileManager.default.createDirectory(at: socketURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data().write(to: socketURL)
    try writeJson(
      [
        "hostConfigPath": paths.hostConfigURL.path,
        "pid": 12345,
        "socketPath": socketURL.path,
        "startedAt": "2026-04-10T00:00:00Z",
        "stateRoot": paths.stateRoot.path,
        "transport": "unix-http",
      ],
      to: paths.serviceMetadataURL
    )

    let loadedState = try await FileBrokerSnapshotLoader(
      paths: paths,
      processIdentifierExists: { _ in true },
      serviceStatusProbe: { service in service },
      expectedRuntimeVersion: runtimeVersion
    ).load()

    XCTAssertNil(loadedState.service)
  }

  func testLoaderIgnoresServiceMetadataFromDifferentRuntimeVersion() async throws {
    let tempRoot = try makeTempRoot()
    let paths = BrokerRuntimePaths(
      stateRoot: tempRoot.appending(path: "state"),
      hostConfigURL: tempRoot.appending(path: "host-config.json")
    )
    let socketURL = paths.stateRoot.appending(path: "broker.sock")
    try FileManager.default.createDirectory(at: socketURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data().write(to: socketURL)
    try writeJson(
      [
        "hostConfigPath": paths.hostConfigURL.path,
        "pid": 12345,
        "runtimeVersion": "older-runtime-version",
        "socketPath": socketURL.path,
        "startedAt": "2026-04-10T00:00:00Z",
        "stateRoot": paths.stateRoot.path,
        "transport": "unix-http",
      ],
      to: paths.serviceMetadataURL
    )

    let loadedState = try await FileBrokerSnapshotLoader(
      paths: paths,
      processIdentifierExists: { _ in true },
      serviceStatusProbe: { service in service },
      expectedRuntimeVersion: runtimeVersion
    ).load()

    XCTAssertNil(loadedState.service)
  }

  func testLoaderIgnoresServiceMetadataThatDoesNotMatchConfiguredSocket() async throws {
    let tempRoot = try makeTempRoot()
    let configuredSocketURL = tempRoot.appending(path: "configured.sock")
    let metadataSocketURL = tempRoot.appending(path: "metadata.sock")
    let paths = BrokerRuntimePaths(
      stateRoot: tempRoot.appending(path: "state"),
      hostConfigURL: tempRoot.appending(path: "host-config.json"),
      serviceSocketURL: configuredSocketURL
    )
    try FileManager.default.createDirectory(at: paths.stateRoot, withIntermediateDirectories: true)
    try Data().write(to: metadataSocketURL)
    try writeJson(
      [
        "hostConfigPath": paths.hostConfigURL.path,
        "pid": 12345,
        "runtimeVersion": runtimeVersion,
        "socketPath": metadataSocketURL.path,
        "startedAt": "2026-04-10T00:00:00Z",
        "stateRoot": paths.stateRoot.path,
        "transport": "unix-http",
      ],
      to: paths.serviceMetadataURL
    )

    let loadedState = try await FileBrokerSnapshotLoader(
      paths: paths,
      processIdentifierExists: { _ in true },
      serviceStatusProbe: { service in service },
      expectedRuntimeVersion: runtimeVersion
    ).load()

    XCTAssertNil(loadedState.service)
  }

  private func makeTempRoot() throws -> URL {
    let url = URL(fileURLWithPath: NSTemporaryDirectory())
      .appending(path: "simbroker-app-tests-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    addTeardownBlock {
      try? FileManager.default.removeItem(at: url)
    }
    return url
  }

  private func writeFixtureSnapshot(named name: String, overrides: [String: Any], to url: URL) throws {
    let fixtureURL = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .appending(path: "Fixtures")
      .appending(path: "\(name).json")
    let data = try Data(contentsOf: fixtureURL)
    var payload = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    overrides.forEach { key, value in
      payload[key] = value
    }
    try writeJson(payload, to: url)
  }

  private func writeJson(_ payload: [String: Any], to url: URL) throws {
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
    try data.write(to: url)
  }
}
