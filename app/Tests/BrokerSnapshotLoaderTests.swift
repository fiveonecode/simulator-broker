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

  func testLoaderCarriesConfirmedServiceAbsenceThroughUnreadableSnapshot() async throws {
    let tempRoot = try makeTempRoot()
    let paths = BrokerRuntimePaths(
      stateRoot: tempRoot.appending(path: "state"),
      hostConfigURL: tempRoot.appending(path: "host-config.json")
    )
    try Data("{}".utf8).write(to: paths.hostConfigURL)
    try FileManager.default.createDirectory(at: paths.stateRoot, withIntermediateDirectories: true)
    try Data("not-json".utf8).write(to: paths.snapshotURL)

    do {
      _ = try await FileBrokerSnapshotLoader(
        paths: paths,
        expectedRuntimeVersion: runtimeVersion
      ).load()
      XCTFail("Expected unreadable snapshot failure")
    } catch let error as BrokerSnapshotPartialLoadError {
      XCTAssertNil(error.recoveredState.service)
      XCTAssertNil(error.recoveredState.snapshot)
      XCTAssertTrue(error.recoveredState.tooling.hostConfigExists)
      XCTAssertTrue(error.localizedDescription.contains("app-snapshot.json"))
    }
  }

  func testLoaderCarriesValidatedLiveServiceThroughUnreadableSnapshot() async throws {
    let paths = try makeLiveServicePaths()
    try Data("not-json".utf8).write(to: paths.snapshotURL)

    do {
      _ = try await FileBrokerSnapshotLoader(
        paths: paths,
        processIdentifierExists: { pid in pid == 12345 },
        serviceStatusProbe: { service in service },
        expectedRuntimeVersion: runtimeVersion
      ).load()
      XCTFail("Expected unreadable snapshot failure")
    } catch let error as BrokerSnapshotPartialLoadError {
      XCTAssertEqual(error.recoveredState.service?.pid, 12345)
      XCTAssertNil(error.recoveredState.snapshot)
      XCTAssertTrue(error.localizedDescription.contains("app-snapshot.json"))
    }
  }

  func testLoaderFailsClosedWhenServiceStatusProbeTimesOut() async throws {
    let paths = try makeLiveServicePaths()

    do {
      _ = try await FileBrokerSnapshotLoader(
        paths: paths,
        processIdentifierExists: { pid in pid == 12345 },
        serviceStatusProbe: { _ in throw ServiceStatusProbeTestError.timedOut },
        expectedRuntimeVersion: runtimeVersion
      ).load()
      XCTFail("Expected service status timeout")
    } catch {
      XCTAssertEqual(error.localizedDescription, "Broker service status probe timed out.")
    }
  }

  func testLoaderFailsClosedWhenServiceStatusProbeReturnsNonSuccess() async throws {
    let paths = try makeLiveServicePaths()

    do {
      _ = try await FileBrokerSnapshotLoader(
        paths: paths,
        processIdentifierExists: { pid in pid == 12345 },
        serviceStatusProbe: { _ in
          try FileBrokerSnapshotLoader.decodeServiceStatusResponse(
            BrokerHTTPResponse(bodyData: Data(), statusCode: 503)
          )
        },
        expectedRuntimeVersion: runtimeVersion
      ).load()
      XCTFail("Expected non-success service status failure")
    } catch {
      XCTAssertEqual(error.localizedDescription, "Failed to verify brokerd status: brokerd returned HTTP status 503.")
    }
  }

  func testLoaderClassifiesExactRuntimeIncompatibleConflictAsRestartRequired() async throws {
    let staleRuntimeVersion = "older-runtime-version"
    let paths = try makeLiveServicePaths(runtimeVersion: staleRuntimeVersion)
    let response = try restartRequiredResponse(
      paths: paths,
      runtimeVersion: staleRuntimeVersion
    )

    let loadedState = try await FileBrokerSnapshotLoader(
      paths: paths,
      processIdentifierExists: { pid in pid == 12345 },
      serviceStatusProbe: { _ in
        try FileBrokerSnapshotLoader.decodeServiceStatusResponse(response)
      },
      expectedRuntimeVersion: runtimeVersion
    ).load()

    XCTAssertTrue(loadedState.serviceRequiresRestart)
    XCTAssertEqual(loadedState.service?.hostConfigPath, paths.hostConfigURL.path)
    XCTAssertEqual(loadedState.service?.pid, 12345)
    XCTAssertEqual(loadedState.service?.runtimeVersion, staleRuntimeVersion)
    XCTAssertEqual(loadedState.service?.socketPath, paths.stateRoot.appending(path: "broker.sock").path)
    XCTAssertEqual(loadedState.service?.startedAt, "2026-04-10T00:00:00Z")
    XCTAssertEqual(loadedState.service?.stateRoot, paths.stateRoot.path)
    XCTAssertEqual(loadedState.service?.transport, "unix-http")
  }

  func testRuntimeIncompatibleConflictRejectsWrongReasonCode() throws {
    let paths = BrokerRuntimePaths(stateRoot: URL(fileURLWithPath: "/tmp/selected-state"))
    let response = try restartRequiredResponse(
      paths: paths,
      runtimeVersion: "older-runtime-version",
      reasonCode: "service-unavailable"
    )

    assertServiceStatusResponseFails(
      response,
      expectedDescription: "Failed to verify brokerd status: brokerd returned HTTP status 409."
    )
  }

  func testRuntimeIncompatibleConflictRequiresRunningTrue() throws {
    let paths = BrokerRuntimePaths(stateRoot: URL(fileURLWithPath: "/tmp/selected-state"))
    let runningFalse = try restartRequiredResponse(
      paths: paths,
      runtimeVersion: "older-runtime-version",
      running: false
    )
    var missingRunningPayload = serviceStatusPayload(
      paths: paths,
      runtimeVersion: "older-runtime-version"
    )
    missingRunningPayload.removeValue(forKey: "running")
    let missingRunning = try serviceStatusResponse(
      statusCode: 409,
      payload: missingRunningPayload
    )

    for (name, response) in [
      ("running false", runningFalse),
      ("running missing", missingRunning),
    ] {
      assertServiceStatusResponseFails(
        response,
        expectedDescription: "Failed to verify brokerd status: brokerd returned HTTP status 409.",
        context: name
      )
    }
  }

  func testRuntimeIncompatibleConflictRejectsMissingServiceMetadata() throws {
    let paths = BrokerRuntimePaths(stateRoot: URL(fileURLWithPath: "/tmp/selected-state"))
    var payload = serviceStatusPayload(
      paths: paths,
      runtimeVersion: "older-runtime-version"
    )
    payload["service"] = NSNull()
    let response = try serviceStatusResponse(statusCode: 409, payload: payload)

    assertServiceStatusResponseFails(
      response,
      expectedDescription: "Failed to verify brokerd status: brokerd status omitted service metadata."
    )
  }

  func testRuntimeIncompatibleConflictRejectsMalformedServiceMetadata() throws {
    let paths = BrokerRuntimePaths(stateRoot: URL(fileURLWithPath: "/tmp/selected-state"))
    var payload = serviceStatusPayload(
      paths: paths,
      runtimeVersion: "older-runtime-version"
    )
    payload["service"] = ["pid": "not-an-integer"]
    let response = try serviceStatusResponse(statusCode: 409, payload: payload)

    assertServiceStatusResponseFails(
      response,
      expectedDescription: "Failed to verify brokerd status: brokerd returned malformed status JSON."
    )
  }

  func testUnrelatedNonSuccessResponseRemainsUnverified() throws {
    let paths = BrokerRuntimePaths(stateRoot: URL(fileURLWithPath: "/tmp/selected-state"))
    let response = try serviceStatusResponse(
      statusCode: 503,
      payload: serviceStatusPayload(
        paths: paths,
        runtimeVersion: runtimeVersion
      )
    )

    assertServiceStatusResponseFails(
      response,
      expectedDescription: "Failed to verify brokerd status: brokerd returned HTTP status 503."
    )
  }

  func testHealthyStatusAcceptsExactHTTP200WithRunningTrue() throws {
    let paths = BrokerRuntimePaths(stateRoot: URL(fileURLWithPath: "/tmp/selected-state"))
    let response = try serviceStatusResponse(
      statusCode: 200,
      payload: serviceStatusPayload(
        paths: paths,
        runtimeVersion: runtimeVersion
      )
    )

    let service = try FileBrokerSnapshotLoader.decodeServiceStatusResponse(response)

    XCTAssertEqual(service.pid, 12345)
    XCTAssertEqual(service.runtimeVersion, runtimeVersion)
    XCTAssertEqual(service.stateRoot, paths.stateRoot.path)
  }

  func testHealthyStatusRejectsOtherwiseValidHTTP201Response() throws {
    let paths = BrokerRuntimePaths(stateRoot: URL(fileURLWithPath: "/tmp/selected-state"))
    let response = try serviceStatusResponse(
      statusCode: 201,
      payload: serviceStatusPayload(
        paths: paths,
        runtimeVersion: runtimeVersion
      )
    )

    assertServiceStatusResponseFails(
      response,
      expectedDescription: "Failed to verify brokerd status: brokerd returned HTTP status 201."
    )
  }

  func testHealthyStatusRequiresRunningTrue() throws {
    let paths = BrokerRuntimePaths(stateRoot: URL(fileURLWithPath: "/tmp/selected-state"))
    var runningFalsePayload = serviceStatusPayload(
      paths: paths,
      runtimeVersion: runtimeVersion
    )
    runningFalsePayload["running"] = false
    let runningFalse = try serviceStatusResponse(
      statusCode: 200,
      payload: runningFalsePayload
    )
    var missingRunningPayload = serviceStatusPayload(
      paths: paths,
      runtimeVersion: runtimeVersion
    )
    missingRunningPayload.removeValue(forKey: "running")
    let missingRunning = try serviceStatusResponse(
      statusCode: 200,
      payload: missingRunningPayload
    )

    for (name, response) in [
      ("running false", runningFalse),
      ("running missing", missingRunning),
    ] {
      assertServiceStatusResponseFails(
        response,
        expectedDescription: "Failed to verify brokerd status: brokerd status did not confirm a running service.",
        context: name
      )
    }
  }

  func testRuntimeIncompatibleConflictRejectsMismatchedServiceIdentity() async throws {
    let staleRuntimeVersion = "older-runtime-version"
    let paths = try makeLiveServicePaths(runtimeVersion: staleRuntimeVersion)
    var payload = serviceStatusPayload(
      paths: paths,
      runtimeVersion: staleRuntimeVersion
    )
    var service = try XCTUnwrap(payload["service"] as? [String: Any])
    service["stateRoot"] = "/tmp/other-simbroker-state"
    payload["service"] = service
    let response = try serviceStatusResponse(statusCode: 409, payload: payload)

    do {
      _ = try await FileBrokerSnapshotLoader(
        paths: paths,
        processIdentifierExists: { pid in pid == 12345 },
        serviceStatusProbe: { _ in
          try FileBrokerSnapshotLoader.decodeServiceStatusResponse(response)
        },
        expectedRuntimeVersion: runtimeVersion
      ).load()
      XCTFail("Expected mismatched restart-required service identity to remain unverified")
    } catch let error as BrokerSnapshotLoaderError {
      XCTAssertEqual(
        error.localizedDescription,
        "Failed to verify brokerd status: brokerd restart status did not match the selected runtime identity."
      )
    } catch {
      XCTFail("Expected BrokerSnapshotLoaderError, got \(error)")
    }
  }

  func testUnreadableSnapshotPartialStateCarriesRestartRequiredService() async throws {
    let staleRuntimeVersion = "older-runtime-version"
    let paths = try makeLiveServicePaths(runtimeVersion: staleRuntimeVersion)
    try Data("not-json".utf8).write(to: paths.snapshotURL)
    let response = try restartRequiredResponse(
      paths: paths,
      runtimeVersion: staleRuntimeVersion
    )

    do {
      _ = try await FileBrokerSnapshotLoader(
        paths: paths,
        processIdentifierExists: { pid in pid == 12345 },
        serviceStatusProbe: { _ in
          try FileBrokerSnapshotLoader.decodeServiceStatusResponse(response)
        },
        expectedRuntimeVersion: runtimeVersion
      ).load()
      XCTFail("Expected unreadable snapshot failure")
    } catch let error as BrokerSnapshotPartialLoadError {
      XCTAssertTrue(error.recoveredState.serviceRequiresRestart)
      XCTAssertEqual(error.recoveredState.service?.pid, 12345)
      XCTAssertEqual(error.recoveredState.service?.runtimeVersion, staleRuntimeVersion)
      XCTAssertNil(error.recoveredState.snapshot)
      XCTAssertTrue(error.localizedDescription.contains("app-snapshot.json"))
    } catch {
      XCTFail("Expected BrokerSnapshotPartialLoadError, got \(error)")
    }
  }

  func testLoaderFailsClosedWhenServiceStatusProbeReturnsMalformedBody() async throws {
    let paths = try makeLiveServicePaths()

    do {
      _ = try await FileBrokerSnapshotLoader(
        paths: paths,
        processIdentifierExists: { pid in pid == 12345 },
        serviceStatusProbe: { _ in
          try FileBrokerSnapshotLoader.decodeServiceStatusResponse(
            BrokerHTTPResponse(bodyData: Data(#"{"service":"invalid"}"#.utf8), statusCode: 200)
          )
        },
        expectedRuntimeVersion: runtimeVersion
      ).load()
      XCTFail("Expected malformed service status failure")
    } catch {
      XCTAssertEqual(error.localizedDescription, "Failed to verify brokerd status: brokerd returned malformed status JSON.")
    }
  }

  func testLoaderFailsClosedWhenServiceStatusResponseOmitsServiceMetadata() async throws {
    let paths = try makeLiveServicePaths()

    do {
      _ = try await FileBrokerSnapshotLoader(
        paths: paths,
        processIdentifierExists: { pid in pid == 12345 },
        serviceStatusProbe: { _ in
          try FileBrokerSnapshotLoader.decodeServiceStatusResponse(
            BrokerHTTPResponse(bodyData: Data(#"{"service":null}"#.utf8), statusCode: 200)
          )
        },
        expectedRuntimeVersion: runtimeVersion
      ).load()
      XCTFail("Expected missing service metadata failure")
    } catch {
      XCTAssertEqual(error.localizedDescription, "Failed to verify brokerd status: brokerd status omitted service metadata.")
    }
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
    XCTAssertFalse(loadedState.serviceRequiresRestart)
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

  private func makeLiveServicePaths(runtimeVersion serviceRuntimeVersion: String? = nil) throws -> BrokerRuntimePaths {
    let tempRoot = try makeTempRoot()
    let paths = BrokerRuntimePaths(
      stateRoot: tempRoot.appending(path: "state"),
      hostConfigURL: tempRoot.appending(path: "host-config.json")
    )
    try Data("{}".utf8).write(to: paths.hostConfigURL)
    let socketURL = paths.stateRoot.appending(path: "broker.sock")
    try FileManager.default.createDirectory(
      at: socketURL.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    try Data().write(to: socketURL)
    try writeJson(
      [
        "hostConfigPath": paths.hostConfigURL.path,
        "pid": 12345,
        "runtimeVersion": serviceRuntimeVersion ?? runtimeVersion,
        "socketPath": socketURL.path,
        "startedAt": "2026-04-10T00:00:00Z",
        "stateRoot": paths.stateRoot.path,
        "transport": "unix-http",
      ],
      to: paths.serviceMetadataURL
    )
    return paths
  }

  private func restartRequiredResponse(
    paths: BrokerRuntimePaths,
    runtimeVersion serviceRuntimeVersion: String,
    reasonCode: String = "service-runtime-incompatible",
    running: Bool = true
  ) throws -> BrokerHTTPResponse {
    var payload = serviceStatusPayload(
      paths: paths,
      runtimeVersion: serviceRuntimeVersion
    )
    payload["reasonCode"] = reasonCode
    payload["running"] = running
    return try serviceStatusResponse(statusCode: 409, payload: payload)
  }

  private func serviceStatusPayload(
    paths: BrokerRuntimePaths,
    runtimeVersion serviceRuntimeVersion: String
  ) -> [String: Any] {
    [
      "reasonCode": "service-runtime-incompatible",
      "running": true,
      "service": [
        "hostConfigPath": paths.hostConfigURL.path,
        "pid": 12345,
        "runtimeVersion": serviceRuntimeVersion,
        "socketPath": paths.stateRoot.appending(path: "broker.sock").path,
        "startedAt": "2026-04-10T00:00:00Z",
        "stateRoot": paths.stateRoot.path,
        "transport": "unix-http",
      ],
    ]
  }

  private func serviceStatusResponse(
    statusCode: Int,
    payload: [String: Any]
  ) throws -> BrokerHTTPResponse {
    BrokerHTTPResponse(
      bodyData: try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
      statusCode: statusCode
    )
  }

  private func assertServiceStatusResponseFails(
    _ response: BrokerHTTPResponse,
    expectedDescription: String,
    context: String = "response",
    file: StaticString = #filePath,
    line: UInt = #line
  ) {
    do {
      _ = try FileBrokerSnapshotLoader.decodeServiceStatusResponse(response)
      XCTFail("Expected \(context) to remain unverified", file: file, line: line)
    } catch let error as BrokerSnapshotLoaderError {
      XCTAssertEqual(error.localizedDescription, expectedDescription, file: file, line: line)
    } catch {
      XCTFail("Expected BrokerSnapshotLoaderError for \(context), got \(error)", file: file, line: line)
    }
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

private enum ServiceStatusProbeTestError: LocalizedError {
  case timedOut

  var errorDescription: String? {
    "Broker service status probe timed out."
  }
}
