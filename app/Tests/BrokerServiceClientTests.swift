import XCTest
@testable import SimulatorBrokerApp

final class BrokerServiceClientTests: XCTestCase {
  func testCurlProcessBoxDeclinesLaunchWhenCancelledBeforeRegistration() throws {
    let box = CurlProcessBox()
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/sleep")
    process.arguments = ["1"]

    box.cancelAndTerminate()

    let launched = try box.launch(process)
    XCTAssertFalse(launched)
    XCTAssertFalse(process.isRunning)
  }

  func testCurlArgumentsIncludeBoundedTransferTimeout() {
    let transport = CurlBrokerServiceTransport(transferTimeoutSeconds: 12)

    let arguments = transport.curlArguments(
      socketPath: "/tmp/broker.sock",
      requestPath: "/v1/command",
      method: "POST",
      hasBody: true
    )

    XCTAssertEqual(arguments.value(after: "--max-time"), "12")
    XCTAssertEqual(arguments.value(after: "--unix-socket"), "/tmp/broker.sock")
    XCTAssertTrue(arguments.contains("--data-binary"))
  }

  func testCurlArgumentsUseRequestedTimeoutWhenLargerThanDefault() {
    let transport = CurlBrokerServiceTransport(transferTimeoutSeconds: 12)

    let arguments = transport.curlArguments(
      socketPath: "/tmp/broker.sock",
      requestPath: "/v1/command",
      method: "POST",
      hasBody: true,
      transferTimeoutSeconds: 90
    )

    XCTAssertEqual(arguments.value(after: "--max-time"), "90")
  }

  func testCurlTransportDrainsLargePipesWhileProcessRuns() async throws {
    let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    let scriptURL = root.appending(path: "fake-curl.sh")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer {
      try? FileManager.default.removeItem(at: root)
    }
    let script = """
    #!/usr/bin/env bash
    set -euo pipefail
    body=$(printf '%100000s' '' | tr ' ' x)
    diagnostic=$(printf '%100000s' '' | tr ' ' e)
    printf '%s\\n200' "$body"
    printf '%s' "$diagnostic" >&2
    """
    try Data(script.utf8).write(to: scriptURL)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: scriptURL.path)

    let transport = CurlBrokerServiceTransport(executableURL: scriptURL, transferTimeoutSeconds: 5)
    let response = try await transport.perform(
      socketPath: "/tmp/broker.sock",
      requestPath: "/v1/test",
      method: "GET",
      bodyData: nil,
      transferTimeoutSeconds: 5
    )

    XCTAssertEqual(response.statusCode, 200)
    XCTAssertEqual(response.bodyData.count, 100_000)
  }

  func testCommandTransferTimeoutsCoverBrokerLockBudgets() {
    XCTAssertEqual(BrokerCommandRequest(command: "init", group: "host", options: [:]).executionTimeoutSeconds, 890)
    XCTAssertEqual(
      BrokerCommandRequest(
        command: "init",
        group: "host",
        options: [
          "bootstrapConfig": .bool(true),
          "hostBootstrapRetirementCount": .int(0),
        ]
      ).executionTimeoutSeconds,
      5290
    )
    XCTAssertEqual(
      BrokerCommandRequest(
        command: "init",
        group: "host",
        options: [
          "bootstrapConfig": .bool(true),
          "hostBootstrapRetirementCount": .int(6),
        ]
      ).executionTimeoutSeconds,
      7100
    )
    XCTAssertEqual(BrokerCommandRequest(command: "acquire", group: "lease", options: [:]).executionTimeoutSeconds, 1431)
    XCTAssertEqual(BrokerCommandRequest(command: "release", group: "lease", options: [:]).executionTimeoutSeconds, 890)
    XCTAssertEqual(BrokerCommandRequest(command: "release", group: "lease", options: [:]).transferTimeoutSeconds, 950)
    XCTAssertEqual(BrokerCommandRequest(command: "create", group: "pin", options: [:]).executionTimeoutSeconds, 890)
    XCTAssertEqual(BrokerCommandRequest(command: "create", group: "pin", options: [:]).transferTimeoutSeconds, 950)
    XCTAssertEqual(BrokerCommandRequest(command: "status", group: "host", options: [:]).executionTimeoutSeconds, 890)
    XCTAssertEqual(BrokerCommandRequest(command: "status", group: "doctor", options: [:]).executionTimeoutSeconds, 890)
    XCTAssertEqual(BrokerCommandRequest(command: "explain", group: "lease", options: [:]).executionTimeoutSeconds, 890)
    XCTAssertEqual(BrokerCommandRequest(command: "status", group: "idle", options: [:]).executionTimeoutSeconds, 890)
    XCTAssertEqual(
      BrokerCommandRequest(command: "cleanup", group: "idle", options: ["apply": .bool(true)]).executionTimeoutSeconds,
      1610
    )
    XCTAssertEqual(BrokerCommandRequest(command: "boot", group: "simulators", options: [:]).executionTimeoutSeconds, 1130)
    XCTAssertEqual(BrokerCommandRequest(command: "boot", group: "simulators", options: [:]).transferTimeoutSeconds, 1190)
    XCTAssertEqual(BrokerCommandRequest(command: "shutdown", group: "simulators", options: [:]).executionTimeoutSeconds, 1010)
    XCTAssertEqual(BrokerCommandRequest(command: "shutdown", group: "simulators", options: [:]).transferTimeoutSeconds, 1070)
    XCTAssertEqual(BrokerCommandRequest(command: "erase", group: "simulators", options: [:]).executionTimeoutSeconds, 1130)
    XCTAssertEqual(BrokerCommandRequest(command: "erase", group: "simulators", options: [:]).transferTimeoutSeconds, 1190)
    XCTAssertEqual(BrokerCommandRequest(command: "repair", group: "simulators", options: [:]).executionTimeoutSeconds, 2150)
    XCTAssertEqual(BrokerCommandRequest(command: "repair", group: "simulators", options: [:]).transferTimeoutSeconds, 2210)
    XCTAssertEqual(
      BrokerCommandRequest(
        command: "repair",
        group: "simulators",
        options: [
          "capacityLockTimeoutMilliseconds": .int(120_000),
          "leaseLockTimeoutMilliseconds": .int(90_000),
        ]
      ).executionTimeoutSeconds,
      2270
    )
    XCTAssertEqual(
      BrokerCommandRequest(
        command: "check",
        group: "capacity",
        options: [:]
      ).executionTimeoutSeconds,
      400
    )
    XCTAssertEqual(
      BrokerCommandRequest(
        command: "reconcile",
        group: "capacity",
        options: [
          "apply": .bool(true),
        ]
      ).executionTimeoutSeconds,
      3010
    )
    XCTAssertEqual(
      BrokerCommandRequest(
        command: "reconcile",
        group: "capacity",
        options: [
          "apply": .bool(true),
          "capacityLockTimeoutMilliseconds": .int(240_000),
          "leaseLockTimeoutMilliseconds": .int(120_000),
        ]
      ).executionTimeoutSeconds,
      3310
    )
    XCTAssertEqual(
      BrokerCommandRequest(
        command: "reconcile",
        group: "capacity",
        options: [
          "apply": .bool(true),
          "capacityActionCount": .int(3),
        ]
      ).executionTimeoutSeconds,
      4930
    )
  }

  func testIdleCleanupEnvelopeDecodesCountOnlyPlanFields() throws {
    let envelope = try JSONDecoder().decode(BrokerCommandEnvelope.self, from: Data("""
    {
      "eligibleCount": 2,
      "ok": true,
      "planId": "cleanup-plan",
      "schemaVersion": 1,
      "status": "changes_required"
    }
    """.utf8))

    XCTAssertEqual(envelope.eligibleCount, 2)
    XCTAssertEqual(envelope.planId, "cleanup-plan")
    XCTAssertEqual(envelope.status, "changes_required")
    XCTAssertTrue(envelope.ok == true)
  }

  func testCommandTransferTimeoutsCoverStaleContainmentBudget() throws {
    let fixture = try makeServiceFixture()
    let leasesURL = fixture.paths.stateRoot.appending(path: "leases")
    try FileManager.default.createDirectory(at: leasesURL, withIntermediateDirectories: true)
    try writeJSONObject([
      "leaseId": "stale-containment-1",
      "runtime": [
        "commandPid": 4242,
      ],
    ], to: leasesURL.appending(path: "stale-containment-1.json"))

    let budget = BrokerCommandRequest(command: "release", group: "lease", options: [:])
      .timeoutBudget(paths: fixture.paths)

    XCTAssertEqual(budget.executionTimeoutSeconds, 1051)
    XCTAssertEqual(budget.transferTimeoutSeconds, 1111)
  }

  func testRepairTimeoutBudgetScalesWithPendingRetirements() throws {
    let fixture = try makeServiceFixture()
    try writeJSONObject([
      "pendingRetirements": ["SIM-OLD-1", "SIM-OLD-2"],
      "version": 1,
    ], to: fixture.paths.hostConfigURL)

    let budget = BrokerCommandRequest(command: "repair", group: "simulators", options: [:])
      .timeoutBudget(paths: fixture.paths)

    XCTAssertEqual(budget.executionTimeoutSeconds, 2630)
    XCTAssertEqual(budget.transferTimeoutSeconds, 2690)
  }

  func testHostBootstrapTimeoutBudgetUsesCurrentHostConfig() throws {
    let fixture = try makeServiceFixture()
    try writeJSONObject([
      "aliases": [
        [
          "alias": "ui-1",
          "simulatorId": "SIM-OLD-1",
        ],
        [
          "alias": "ipad-1",
          "simulatorId": "SIM-OLD-2",
        ],
      ],
      "version": 1,
    ], to: fixture.paths.hostConfigURL)

    let unchangedBudget = BrokerCommandRequest(
      command: "init",
      group: "host",
      options: [
        "bootstrapConfig": .bool(true),
      ]
    ).timeoutBudget(paths: fixture.paths)
    let forcedBudget = BrokerCommandRequest(
      command: "init",
      group: "host",
      options: [
        "bootstrapConfig": .bool(true),
        "force": .bool(true),
      ]
    ).timeoutBudget(paths: fixture.paths)

    XCTAssertEqual(unchangedBudget.executionTimeoutSeconds, 890)
    XCTAssertEqual(forcedBudget.executionTimeoutSeconds, 6140)
  }

  func testIdleCleanupTimeoutBudgetFallsBackWhenHostAliasesAreAbsent() throws {
    let fixture = try makeServiceFixture()
    try writeJSONObject([
      "hostId": "missing-aliases-host",
      "version": 1,
    ], to: fixture.paths.hostConfigURL)

    let budget = BrokerCommandRequest(
      command: "cleanup",
      group: "idle",
      options: ["apply": .bool(true)]
    ).timeoutBudget(paths: fixture.paths)

    XCTAssertEqual(budget.executionTimeoutSeconds, 1610)
    XCTAssertEqual(budget.transferTimeoutSeconds, 1670)
  }

  func testCommandClientRejectsLiveServiceIdentityMismatchBeforeMutation() async throws {
    let fixture = try makeServiceFixture()
    try writeServiceMetadata(paths: fixture.paths, socketPath: fixture.socketPath)
    let statusBody = try makeServiceStatusBody(
      hostConfigPath: fixture.paths.hostConfigURL.path,
      socketPath: fixture.socketPath,
      stateRoot: fixture.root.appending(path: "other-state").path
    )
    let transport = StubBrokerServiceTransport(responses: [
      BrokerHTTPResponse(bodyData: statusBody, statusCode: 200),
      BrokerHTTPResponse(bodyData: Data(#"{"ok":true}"#.utf8), statusCode: 200),
    ])
    let client = BrokerServiceCommandClient(paths: fixture.paths, transport: transport)

    do {
      _ = try await client.send(BrokerCommandRequest(command: "release", group: "lease", options: ["leaseId": .string("lease-1")]))
      XCTFail("Expected service identity mismatch")
    } catch let error as BrokerServiceCommandClientError {
      guard case let .serviceIdentityMismatch(_, _, mismatchedFields) = error else {
        XCTFail("Unexpected error \(error)")
        return
      }
      XCTAssertEqual(mismatchedFields, ["stateRoot"])
    }

    let requests = await transport.requests()
    XCTAssertEqual(requests.map(\.requestPath), ["/v1/service/status"])
  }

  func testCommandClientRejectsMetadataThatDoesNotMatchConfiguredSocketBeforeProbe() async throws {
    let fixture = try makeServiceFixture()
    let configuredSocketPath = fixture.root.appending(path: "configured.sock").path
    try writeServiceMetadata(paths: fixture.paths, socketPath: fixture.socketPath)
    let transport = StubBrokerServiceTransport(responses: [])
    let client = BrokerServiceCommandClient(
      paths: BrokerRuntimePaths(
        stateRoot: fixture.paths.stateRoot,
        hostConfigURL: fixture.paths.hostConfigURL,
        serviceSocketURL: URL(fileURLWithPath: configuredSocketPath)
      ),
      transport: transport
    )

    do {
      _ = try await client.send(BrokerCommandRequest(command: "release", group: "lease", options: [:]))
      XCTFail("Expected service identity mismatch")
    } catch let error as BrokerServiceCommandClientError {
      guard case let .serviceIdentityMismatch(_, _, mismatchedFields) = error else {
        XCTFail("Unexpected error \(error)")
        return
      }
      XCTAssertEqual(mismatchedFields, ["socketPath"])
    }

    let requests = await transport.requests()
    XCTAssertTrue(requests.isEmpty)
  }

  func testCommandClientProbesIdentityAndUsesMutationTimeout() async throws {
    let fixture = try makeServiceFixture()
    try writeServiceMetadata(paths: fixture.paths, socketPath: fixture.socketPath)
    let transport = StubBrokerServiceTransport(responses: [
      BrokerHTTPResponse(
        bodyData: try makeServiceStatusBody(
          hostConfigPath: fixture.paths.hostConfigURL.path,
          socketPath: fixture.socketPath,
          stateRoot: fixture.paths.stateRoot.path
        ),
        statusCode: 200
      ),
      BrokerHTTPResponse(bodyData: Data(#"{"ok":true}"#.utf8), statusCode: 200),
    ])
    let client = BrokerServiceCommandClient(paths: fixture.paths, transport: transport)

    _ = try await client.send(BrokerCommandRequest(command: "repair", group: "simulators", options: ["alias": .string("ui-1")]))

    let requests = await transport.requests()
    XCTAssertEqual(requests.map(\.requestPath), ["/v1/service/status", "/v1/command"])
    XCTAssertEqual(requests.map(\.transferTimeoutSeconds), [10, 2210])
    let commandBodyData = try XCTUnwrap(requests[1].bodyData)
    let commandBody = try XCTUnwrap(JSONSerialization.jsonObject(with: commandBodyData) as? [String: Any])
    XCTAssertEqual(commandBody["clientCommandExecutionTimeoutMilliseconds"] as? Int, 2_150_000)
    XCTAssertEqual(commandBody["clientCommandQueueTimeoutMilliseconds"] as? Int, 60_000)
    XCTAssertNotNil(commandBody["clientRequestStartedAtMilliseconds"] as? Int)
    let expectedIdentity = try XCTUnwrap(commandBody["expectedServiceIdentity"] as? [String: String])
    XCTAssertEqual(expectedIdentity, [
      "hostConfigPath": fixture.paths.hostConfigURL.path,
      "socketPath": fixture.socketPath,
      "stateRoot": fixture.paths.stateRoot.path,
    ])
  }
}

private extension Array where Element == String {
  func value(after flag: String) -> String? {
    guard let index = firstIndex(of: flag) else {
      return nil
    }
    let valueIndex = self.index(after: index)
    guard valueIndex < endIndex else {
      return nil
    }
    return self[valueIndex]
  }
}

private struct ServiceFixture {
  let paths: BrokerRuntimePaths
  let root: URL
  let socketPath: String
}

private struct RecordedTransportRequest: Sendable {
  let bodyData: Data?
  let requestPath: String
  let transferTimeoutSeconds: Int?
}

private actor StubBrokerServiceTransport: BrokerServiceTransporting {
  private var recordedRequests: [RecordedTransportRequest] = []
  private var responses: [BrokerHTTPResponse]

  init(responses: [BrokerHTTPResponse]) {
    self.responses = responses
  }

  func perform(
    socketPath: String,
    requestPath: String,
    method: String,
    bodyData: Data?,
    transferTimeoutSeconds: Int?
  ) async throws -> BrokerHTTPResponse {
    recordedRequests.append(RecordedTransportRequest(
      bodyData: bodyData,
      requestPath: requestPath,
      transferTimeoutSeconds: transferTimeoutSeconds
    ))
    guard responses.isEmpty == false else {
      throw BrokerServiceCommandClientError.transportFailure("Unexpected brokerd request.")
    }
    return responses.removeFirst()
  }

  func requests() -> [RecordedTransportRequest] {
    recordedRequests
  }
}

private func makeServiceFixture() throws -> ServiceFixture {
  let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
  let stateRoot = root.appending(path: "state")
  let hostConfigURL = root.appending(path: "host-config.json")
  try FileManager.default.createDirectory(at: stateRoot, withIntermediateDirectories: true)
  return ServiceFixture(
    paths: BrokerRuntimePaths(stateRoot: stateRoot, hostConfigURL: hostConfigURL),
    root: root,
    socketPath: root.appending(path: "broker.sock").path
  )
}

private func writeServiceMetadata(paths: BrokerRuntimePaths, socketPath: String) throws {
  try writeJSONObject([
    "hostConfigPath": paths.hostConfigURL.path,
    "pid": 123,
    "socketPath": socketPath,
    "startedAt": "2026-06-18T00:00:00.000Z",
    "stateRoot": paths.stateRoot.path,
    "transport": "unix-http",
  ], to: paths.serviceMetadataURL)
}

private func makeServiceStatusBody(hostConfigPath: String, socketPath: String, stateRoot: String) throws -> Data {
  try JSONSerialization.data(withJSONObject: [
    "ok": true,
    "service": [
      "hostConfigPath": hostConfigPath,
      "pid": 123,
      "socketPath": socketPath,
      "startedAt": "2026-06-18T00:00:00.000Z",
      "stateRoot": stateRoot,
      "transport": "unix-http",
    ],
  ], options: [.sortedKeys])
}

private func writeJSONObject(_ object: [String: Any], to url: URL) throws {
  try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
  let data = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
  try data.write(to: url)
}
