import XCTest
@testable import SimulatorBrokerApp

@MainActor
final class BrokerDashboardStoreTests: XCTestCase {
  func testSnapshotDecodesMissingIdleAsUnconfiguredDefault() throws {
    let fixturesRoot = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .appending(path: "Fixtures")
    let data = try Data(contentsOf: fixturesRoot.appending(path: "busy-snapshot.json"))
    var jsonObject = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    jsonObject.removeValue(forKey: "idle")
    let snapshotData = try JSONSerialization.data(withJSONObject: jsonObject)

    let snapshot = try JSONDecoder().decode(BrokerAppSnapshot.self, from: snapshotData)

    XCTAssertFalse(snapshot.idle.configured)
    XCTAssertEqual(snapshot.idle.eligibleCount, 0)
    XCTAssertNil(snapshot.idle.graceSeconds)
    XCTAssertNil(snapshot.idle.lastCleanupResult)
    XCTAssertNil(snapshot.idle.nextScheduledCleanupAt)
  }

  func testIdlePolicyCommandsUseHumanActorAndRefreshSnapshot() async throws {
    let snapshot = try loadFixture(named: "busy-snapshot")
    let loadedState = makeLoadedState(snapshot: snapshot)
    let commandClient = RecordingCommandClient()
    let store = BrokerDashboardStore(
      loader: StubSnapshotLoader(state: loadedState),
      commandClient: commandClient,
      runtimePaths: loadedState.paths
    )
    store.loadedState = loadedState

    try await store.applyIdlePolicy(graceSeconds: 120)
    try await store.disableIdlePolicy()

    let requests = await commandClient.requests()
    XCTAssertEqual(requests.count, 2)
    XCTAssertEqual(requests[0].group, "idle")
    XCTAssertEqual(requests[0].command, "enable")
    XCTAssertEqual(requests[0].options["graceSeconds"]?.intValue, 120)
    XCTAssertEqual(requests[0].options["actorType"]?.stringValue, "human")
    XCTAssertEqual(requests[0].options["actorId"]?.stringValue, "simulator-broker-app")
    XCTAssertEqual(requests[1].group, "idle")
    XCTAssertEqual(requests[1].command, "disable")
    XCTAssertEqual(requests[1].options["actorType"]?.stringValue, "human")
    XCTAssertEqual(requests[1].options["actorId"]?.stringValue, "simulator-broker-app")
  }

  func testIdlePolicyRejectsInvalidDurationBeforeSending() async throws {
    let snapshot = try loadFixture(named: "busy-snapshot")
    let loadedState = makeLoadedState(snapshot: snapshot)
    let commandClient = RecordingCommandClient()
    let store = BrokerDashboardStore(
      loader: StubSnapshotLoader(state: loadedState),
      commandClient: commandClient,
      runtimePaths: loadedState.paths
    )
    store.loadedState = loadedState

    do {
      try await store.applyIdlePolicy(graceSeconds: 59)
      XCTFail("Expected invalid duration")
    } catch {
      XCTAssertEqual(error.localizedDescription, "Enter a whole number of seconds from 60 through 86400.")
    }
    let requests = await commandClient.requests()
    XCTAssertTrue(requests.isEmpty)
  }

  func testIdleCleanupStagesCountOnlyPreviewThenSendsConfirmedPlan() async throws {
    let snapshot = try loadFixture(named: "busy-snapshot")
    let loadedState = makeLoadedState(snapshot: snapshot)
    let commandClient = RecordingCommandClient()
    await commandClient.enqueueResponse(
      BrokerCommandEnvelope(
        currentHolder: nil,
        eligibleCount: 2,
        error: nil,
        exitCode: nil,
        ok: true,
        planId: "cleanup-plan",
        reasonCode: nil,
        requiredConfirmationFields: nil,
        status: "changes_required",
        unchanged: nil
      )
    )
    let store = BrokerDashboardStore(
      loader: StubSnapshotLoader(state: loadedState),
      commandClient: commandClient,
      runtimePaths: loadedState.paths
    )
    store.loadedState = loadedState

    store.requestIdleCleanup()
    try await waitUntil { store.pendingIdleCleanupRequest != nil }
    XCTAssertEqual(store.pendingIdleCleanupRequest?.eligibleCount, 2)
    XCTAssertEqual(store.pendingIdleCleanupRequest?.planId, "cleanup-plan")

    store.confirmIdleCleanup()
    try await waitUntil { await commandClient.requests().count == 2 }
    let requests = await commandClient.requests()
    XCTAssertEqual(requests[0].group, "idle")
    XCTAssertEqual(requests[0].command, "cleanup")
    XCTAssertTrue(requests[0].options.isEmpty)
    XCTAssertEqual(requests[1].group, "idle")
    XCTAssertEqual(requests[1].command, "cleanup")
    XCTAssertEqual(requests[1].options["apply"]?.boolValue, true)
    XCTAssertEqual(requests[1].options["confirmPlanId"]?.stringValue, "cleanup-plan")
    XCTAssertEqual(requests[1].options["actorType"]?.stringValue, "human")
    XCTAssertEqual(requests[1].options["actorId"]?.stringValue, "simulator-broker-app")
    XCTAssertNil(store.pendingIdleCleanupRequest)
  }

  func testIdleCleanupPreviewMarksBusyBeforeTaskStarts() async throws {
    let snapshot = try loadFixture(named: "busy-snapshot")
    let loadedState = makeLoadedState(snapshot: snapshot)
    let commandClient = DeferredCommandClient(
      response: BrokerCommandEnvelope(
        currentHolder: nil,
        eligibleCount: 2,
        error: nil,
        exitCode: nil,
        ok: true,
        planId: "cleanup-plan",
        reasonCode: nil,
        requiredConfirmationFields: nil,
        status: "changes_required",
        unchanged: nil
      )
    )
    let store = BrokerDashboardStore(
      loader: StubSnapshotLoader(state: loadedState),
      commandClient: commandClient,
      runtimePaths: loadedState.paths
    )
    store.loadedState = loadedState

    store.requestIdleCleanup()
    XCTAssertTrue(store.isApplyingAction)
    store.requestIdleCleanup()

    try await waitUntil { await commandClient.hasPendingSend() }
    let requestCount = await commandClient.requests().count
    XCTAssertEqual(requestCount, 1)

    await commandClient.release()
    try await waitUntil { store.isApplyingAction == false }
  }

  func testIdleCleanupPreviewResultIsDiscardedAfterLeavingOverview() async throws {
    let snapshot = try loadFixture(named: "busy-snapshot")
    let loadedState = makeLoadedState(snapshot: snapshot)
    let commandClient = DeferredCommandClient(
      response: BrokerCommandEnvelope(
        currentHolder: nil,
        eligibleCount: 2,
        error: nil,
        exitCode: nil,
        ok: true,
        planId: "cleanup-plan",
        reasonCode: nil,
        requiredConfirmationFields: nil,
        status: "changes_required",
        unchanged: nil
      )
    )
    let store = BrokerDashboardStore(
      loader: StubSnapshotLoader(state: loadedState),
      commandClient: commandClient,
      runtimePaths: loadedState.paths
    )
    store.loadedState = loadedState
    store.selectedPane = .overview

    store.requestIdleCleanup()
    try await waitUntil { await commandClient.hasPendingSend() }

    store.selectedPane = .events
    await commandClient.release()
    try await waitUntil {
      await commandClient.hasPendingSend() == false && store.isApplyingAction == false
    }

    XCTAssertNil(store.pendingIdleCleanupRequest)
  }

  func testIdleCleanupPreviewWithZeroEligibleDoesNotStageConfirmation() async throws {
    let snapshot = try loadFixture(named: "busy-snapshot")
    let loadedState = makeLoadedState(snapshot: snapshot)
    let commandClient = RecordingCommandClient()
    await commandClient.enqueueResponse(
      BrokerCommandEnvelope(
        currentHolder: nil,
        eligibleCount: 0,
        error: nil,
        exitCode: nil,
        ok: true,
        planId: "cleanup-plan-empty",
        reasonCode: nil,
        requiredConfirmationFields: nil,
        status: "no_changes",
        unchanged: nil
      )
    )
    let store = BrokerDashboardStore(
      loader: StubSnapshotLoader(state: loadedState),
      commandClient: commandClient,
      runtimePaths: loadedState.paths
    )
    store.loadedState = loadedState

    store.requestIdleCleanup()
    try await waitUntil { store.isApplyingAction == false }

    XCTAssertNil(store.pendingIdleCleanupRequest)
    XCTAssertEqual(store.lastActionMessage, "No idle simulators are eligible right now.")
    XCTAssertNil(store.lastErrorMessage)
    let requests = await commandClient.requests()
    XCTAssertEqual(requests.count, 1)
    XCTAssertEqual(requests[0].group, "idle")
    XCTAssertEqual(requests[0].command, "cleanup")
    XCTAssertTrue(requests[0].options.isEmpty)
  }

  func testIdleCleanupPreviewErrorIsDiscardedAfterLeavingOverview() async throws {
    let snapshot = try loadFixture(named: "busy-snapshot")
    let loadedState = makeLoadedState(snapshot: snapshot)
    let commandClient = BlockingCommandClient(
      error: BrokerServiceCommandClientError.transportFailure("preview failed")
    )
    let store = BrokerDashboardStore(
      loader: StubSnapshotLoader(state: loadedState),
      commandClient: commandClient,
      runtimePaths: loadedState.paths
    )
    store.loadedState = loadedState
    store.selectedPane = .overview

    store.requestIdleCleanup()
    try await waitUntil { await commandClient.hasPendingSend() }

    store.selectedPane = .events
    await commandClient.release()
    try await waitUntil {
      await commandClient.hasPendingSend() == false && store.isApplyingAction == false
    }

    XCTAssertNil(store.pendingIdleCleanupRequest)
    XCTAssertNil(store.lastErrorMessage)
  }

  func testCreatePinSendsProjectFilePathPurposeAndNote() async throws {
    let snapshot = try loadFixture(named: "busy-snapshot")
    let loadedState = makeLoadedState(snapshot: snapshot)
    let loader = StubSnapshotLoader(state: loadedState)
    let commandClient = RecordingCommandClient()
    let store = BrokerDashboardStore(
      loader: loader,
      commandClient: commandClient,
      runtimePaths: loadedState.paths
    )
    store.loadedState = loadedState

    let project = try XCTUnwrap(store.readModel?.project(projectId: "sample-project"))
    let purpose = try XCTUnwrap(project.purposes.first(where: { $0.purposeId == "manual-testing" }))

    try await store.createPin(alias: "manual-1", project: project, purpose: purpose, note: "Reserved for walkthroughs")

    let requests = await commandClient.requests()
    XCTAssertEqual(requests.count, 1)
    XCTAssertEqual(requests[0].group, "pin")
    XCTAssertEqual(requests[0].command, "create")
    XCTAssertEqual(requests[0].options["alias"]?.stringValue, "manual-1")
    XCTAssertEqual(requests[0].options["projectFilePath"]?.stringValue, "/tmp/sample-project/.simulator-broker/project.json")
    XCTAssertEqual(requests[0].options["purposeId"]?.stringValue, "manual-testing")
    XCTAssertEqual(requests[0].options["note"]?.stringValue, "Reserved for walkthroughs")
    XCTAssertEqual(requests[0].options["actorId"]?.stringValue, "simulator-broker-app")
    XCTAssertEqual(requests[0].options["actorType"]?.stringValue, "human")
    XCTAssertEqual(store.lastActionMessage, "Pinned manual-1 to Sample Project · Manual Testing.")
  }

  func testSuccessfulMutationPreservesRefreshFailure() async throws {
    let snapshot = try loadFixture(named: "busy-snapshot")
    let loadedState = makeLoadedState(snapshot: snapshot)
    let refreshError = SnapshotRefreshTestError(message: "Snapshot refresh failed")
    let commandClient = RecordingCommandClient()
    let store = BrokerDashboardStore(
      loader: FailingSnapshotLoader(error: refreshError),
      commandClient: commandClient,
      runtimePaths: loadedState.paths
    )
    store.loadedState = loadedState

    do {
      try await store.performLifecycleAction(.shutdown, alias: "ui-1")
      XCTFail("Expected refresh failure")
    } catch {
      XCTAssertEqual(error.localizedDescription, "Snapshot refresh failed")
    }

    let requests = await commandClient.requests()
    XCTAssertEqual(requests.count, 1)
    XCTAssertNil(store.lastActionMessage)
    XCTAssertEqual(store.lastErrorMessage, "Snapshot refresh failed")
    XCTAssertEqual(store.loadedState?.snapshot?.generatedAt, loadedState.snapshot?.generatedAt)
  }

  func testIdleCleanupAcceptsSuccessfulFallbackRefreshAfterCommittedCommand() async throws {
    let snapshot = try loadFixture(named: "busy-snapshot")
    let loadedState = makeLoadedState(snapshot: snapshot)
    let refreshError = SnapshotRefreshTestError(message: "Snapshot refresh failed once")
    let loader = FailingOnceSnapshotLoader(error: refreshError, recoveredState: loadedState)
    let commandClient = RecordingCommandClient()
    await commandClient.enqueueResponse(
      BrokerCommandEnvelope(
        currentHolder: nil,
        eligibleCount: 2,
        error: nil,
        exitCode: nil,
        ok: true,
        planId: "cleanup-plan",
        reasonCode: nil,
        requiredConfirmationFields: nil,
        status: "changes_required",
        unchanged: nil
      )
    )
    let store = BrokerDashboardStore(
      loader: loader,
      commandClient: commandClient,
      runtimePaths: loadedState.paths
    )
    store.loadedState = loadedState

    store.requestIdleCleanup()
    try await waitUntil { store.pendingIdleCleanupRequest != nil }
    store.confirmIdleCleanup()

    try await waitUntil {
      store.lastActionMessage == "Idle cleanup completed. Review the last result below."
    }

    let requests = await commandClient.requests()
    XCTAssertEqual(requests.count, 2)
    XCTAssertEqual(requests[1].group, "idle")
    XCTAssertEqual(requests[1].command, "cleanup")
    XCTAssertNil(store.lastErrorMessage)
    let loadCount = await loader.loadCount()
    XCTAssertEqual(loadCount, 2)
  }

  func testOverrideErrorsPassThroughWithoutSettingLastErrorMessage() async throws {
    let snapshot = try loadFixture(named: "busy-snapshot")
    let loadedState = makeLoadedState(snapshot: snapshot)
    let loader = StubSnapshotLoader(state: loadedState)
    let commandClient = RecordingCommandClient()
    await commandClient.setError(
      BrokerServiceCommandError(
        currentHolder: BrokerLeaseSummary(
          actorId: "agent-review",
          actorType: "agent",
          jobId: "job-101",
          leaseId: "lease-ui-2",
          projectId: "sample-project",
          purposeId: "agent-ui-session"
        ),
        message: "Alias ui-2 requires an explicit human override before repair.",
        reasonCode: "override-required",
        requiredConfirmationFields: ["forceOverride", "overrideReason", "expectedAlias", "expectedLeaseId"],
        statusCode: 400
      )
    )
    let store = BrokerDashboardStore(
      loader: loader,
      commandClient: commandClient,
      runtimePaths: loadedState.paths
    )
    store.loadedState = loadedState
    let simulator = try XCTUnwrap(store.readModel?.simulator(alias: "ui-2"))

    do {
      try await store.performLifecycleAction(.repair, simulator: simulator)
      XCTFail("Expected override-required error")
    } catch let error as BrokerServiceCommandError {
      XCTAssertTrue(error.needsOverrideConfirmation)
      XCTAssertNil(store.lastErrorMessage)
    }
  }

  func testStateRootPathUsesConfiguredRuntimePathsBeforeFirstRefresh() {
    let runtimePaths = BrokerRuntimePaths(stateRoot: URL(fileURLWithPath: "/tmp/custom-state-root"))
    let store = BrokerDashboardStore(
      loader: StubSnapshotLoader(
        state: BrokerLoadedState(
          paths: runtimePaths,
          tooling: BrokerToolingState(
            cliPath: nil,
            hostConfigExists: false,
            installMetadata: nil
          ),
          service: nil,
          snapshot: nil
        )
      ),
      commandClient: RecordingCommandClient(),
      runtimePaths: runtimePaths
    )

    XCTAssertEqual(store.stateRootPath, "/tmp/custom-state-root")
  }

  func testOnboardingCLIPathUsesResolvedExecutablePathInsteadOfStaleMetadata() {
    let runtimePaths = BrokerRuntimePaths(
      stateRoot: URL(fileURLWithPath: "/tmp/custom-state-root"),
      hostConfigURL: URL(fileURLWithPath: "/tmp/custom-host.json"),
      configuredCLIURL: URL(fileURLWithPath: "/tmp/stale-override-simbroker")
    )
    let loadedState = BrokerLoadedState(
      paths: runtimePaths,
      tooling: BrokerToolingState(
        cliPath: URL(fileURLWithPath: "/tmp/resolved-simbroker"),
        hostConfigExists: true,
        installMetadata: BrokerInstallMetadata(
          appPath: nil,
          cliPath: "/tmp/stale-installed-simbroker",
          installSource: "repo-worktree",
          installedAt: nil,
          nodePath: nil,
          prefix: "/tmp/stale-install-root"
        )
      ),
      service: nil,
      snapshot: nil
    )
    let store = BrokerDashboardStore(
      loader: StubSnapshotLoader(state: loadedState),
      commandClient: RecordingCommandClient(),
      runtimePaths: runtimePaths
    )
    store.loadedState = loadedState

    XCTAssertEqual(store.onboardingCLIPath, "/tmp/resolved-simbroker")
    XCTAssertNil(store.envHelperPath)
  }

  func testEnvHelperPathUsesInstallMetadataWhenItMatchesResolvedCLIPath() throws {
    let installRoot = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: installRoot, withIntermediateDirectories: true)
    defer {
      try? FileManager.default.removeItem(at: installRoot)
    }
    let envHelperURL = installRoot.appending(path: "env.sh")
    try Data("export PATH=/tmp/bin:$PATH\n".utf8).write(to: envHelperURL)

    let runtimePaths = BrokerRuntimePaths(
      stateRoot: URL(fileURLWithPath: "/tmp/custom-state-root"),
      hostConfigURL: URL(fileURLWithPath: "/tmp/custom-host.json")
    )
    let loadedState = BrokerLoadedState(
      paths: runtimePaths,
      tooling: BrokerToolingState(
        cliPath: URL(fileURLWithPath: "/tmp/resolved-simbroker"),
        hostConfigExists: true,
        installMetadata: BrokerInstallMetadata(
          appPath: nil,
          cliPath: "/tmp/resolved-simbroker",
          installSource: "repo-worktree",
          installedAt: nil,
          nodePath: nil,
          prefix: installRoot.path
        )
      ),
      service: nil,
      snapshot: nil
    )
    let store = BrokerDashboardStore(
      loader: StubSnapshotLoader(state: loadedState),
      commandClient: RecordingCommandClient(),
      runtimePaths: runtimePaths
    )
    store.loadedState = loadedState

    XCTAssertEqual(store.envHelperPath, envHelperURL.path)
  }

  func testStartupStateTracksReadOnlySnapshotWhenBrokerdIsStopped() throws {
    let snapshot = try loadFixture(named: "busy-snapshot")
    let loadedState = makeLoadedState(
      snapshot: snapshot,
      service: nil
    )
    let store = BrokerDashboardStore(
      loader: StubSnapshotLoader(state: loadedState),
      commandClient: RecordingCommandClient(),
      runtimePaths: loadedState.paths
    )
    store.loadedState = loadedState

    XCTAssertEqual(store.startupState, .readOnlySnapshot)
    XCTAssertEqual(store.commandStatusText, "Read-only snapshot")
    XCTAssertTrue(store.canStartBrokerService)
  }

  func testStartupStatePrioritizesMissingHostBootstrapWhenServiceExists() {
    let runtimePaths = BrokerRuntimePaths(
      stateRoot: URL(fileURLWithPath: "/tmp/simbroker-store-test"),
      hostConfigURL: URL(fileURLWithPath: "/tmp/host-config.json"),
      configuredCLIURL: URL(fileURLWithPath: "/tmp/fake-simbroker")
    )
    let loadedState = BrokerLoadedState(
      paths: runtimePaths,
      tooling: BrokerToolingState(
        cliPath: URL(fileURLWithPath: "/tmp/fake-simbroker"),
        hostConfigExists: false,
        installMetadata: nil
      ),
      service: BrokerServiceMetadata(
        hostConfigPath: "/tmp/host-config.json",
        pid: 123,
        socketPath: "/tmp/simbroker.sock",
        startedAt: "2026-04-09T10:00:00Z",
        stateRoot: "/tmp/simbroker-store-test",
        transport: "unix-http"
      ),
      snapshot: nil
    )
    let store = BrokerDashboardStore(
      loader: StubSnapshotLoader(state: loadedState),
      commandClient: RecordingCommandClient(),
      runtimePaths: loadedState.paths
    )
    store.loadedState = loadedState

    XCTAssertEqual(store.startupState, .needsHostBootstrap)
  }

  func testCompleteFirstTimeSetupRunsHostBootstrapAndStartsService() async throws {
    let runtimePaths = BrokerRuntimePaths(
      stateRoot: URL(fileURLWithPath: "/tmp/simbroker-setup-state"),
      hostConfigURL: URL(fileURLWithPath: "/tmp/simbroker-setup-host.json"),
      configuredCLIURL: URL(fileURLWithPath: "/tmp/fake-simbroker")
    )
    let loadedState = BrokerLoadedState(
      paths: runtimePaths,
      tooling: BrokerToolingState(
        cliPath: URL(fileURLWithPath: "/tmp/fake-simbroker"),
        hostConfigExists: false,
        installMetadata: nil
      ),
      service: nil,
      snapshot: nil
    )
    let localRunner = RecordingLocalCommandRunner()
    let store = BrokerDashboardStore(
      loader: StubSnapshotLoader(state: loadedState),
      commandClient: RecordingCommandClient(),
      localCommandRunner: localRunner,
      runtimePaths: runtimePaths
    )
    store.loadedState = loadedState

    try await store.completeFirstTimeSetup()

    let invocations = await localRunner.invocations()
    XCTAssertEqual(invocations.count, 2)
    XCTAssertEqual(invocations[0].arguments, [
      "host",
      "init",
      "--bootstrap-config",
      "--host-config",
      "/tmp/simbroker-setup-host.json",
      "--state-root",
      "/tmp/simbroker-setup-state",
    ])
    XCTAssertEqual(invocations[1].arguments, [
      "service",
      "start",
      "--host-config",
      "/tmp/simbroker-setup-host.json",
      "--state-root",
      "/tmp/simbroker-setup-state",
    ])
    XCTAssertEqual(store.lastActionMessage, "Broker setup completed and brokerd started.")
  }

  func testCommandAvailabilityMatchesSelectedSimulatorState() throws {
    let snapshot = try loadFixture(named: "busy-snapshot")
    let loadedState = makeLoadedState(snapshot: snapshot)
    let store = BrokerDashboardStore(
      loader: StubSnapshotLoader(state: loadedState),
      commandClient: RecordingCommandClient(),
      runtimePaths: loadedState.paths
    )
    store.loadedState = loadedState

    store.inspectedSimulatorAlias = "ui-1"
    XCTAssertTrue(store.commandAvailability.canRefreshSnapshot)
    XCTAssertFalse(store.commandAvailability.canBootSimulator)
    XCTAssertTrue(store.commandAvailability.canShutdownSimulator)
    XCTAssertTrue(store.commandAvailability.canEraseSimulator)
    XCTAssertTrue(store.commandAvailability.canRepairSimulator)
    XCTAssertTrue(store.commandAvailability.canReleaseLease)
    XCTAssertTrue(store.commandAvailability.canCreatePin)
    XCTAssertFalse(store.commandAvailability.canClearPin)

    store.inspectedSimulatorAlias = "manual-1"
    XCTAssertTrue(store.commandAvailability.canBootSimulator)
    XCTAssertFalse(store.commandAvailability.canShutdownSimulator)
    XCTAssertTrue(store.commandAvailability.canEraseSimulator)
    XCTAssertTrue(store.commandAvailability.canRepairSimulator)
    XCTAssertFalse(store.commandAvailability.canReleaseLease)
    XCTAssertFalse(store.commandAvailability.canCreatePin)
    XCTAssertTrue(store.commandAvailability.canClearPin)

    store.inspectedSimulatorAlias = "ui-2"
    XCTAssertFalse(store.commandAvailability.canBootSimulator)
    XCTAssertFalse(store.commandAvailability.canShutdownSimulator)
    XCTAssertFalse(store.commandAvailability.canEraseSimulator)
    XCTAssertTrue(store.commandAvailability.canRepairSimulator)
    XCTAssertTrue(store.commandAvailability.canReleaseLease)
    XCTAssertTrue(store.commandAvailability.canCreatePin)
    XCTAssertFalse(store.commandAvailability.canClearPin)
  }

  func testSimulatorScopedCommandsRequireSimulatorsPaneAndSelection() {
    XCTAssertFalse(
      brokerAllowsSimulatorScopedCommands(
        selectedPane: nil,
        selectedSimulatorAlias: "ui-1"
      )
    )
    XCTAssertFalse(
      brokerAllowsSimulatorScopedCommands(
        selectedPane: .overview,
        selectedSimulatorAlias: "ui-1"
      )
    )
    XCTAssertFalse(
      brokerAllowsSimulatorScopedCommands(
        selectedPane: .simulators,
        selectedSimulatorAlias: nil
      )
    )
    XCTAssertFalse(
      brokerAllowsSimulatorScopedCommands(
        selectedPane: .simulators,
        selectedSimulatorAlias: ""
      )
    )
    XCTAssertTrue(
      brokerAllowsSimulatorScopedCommands(
        selectedPane: .simulators,
        selectedSimulatorAlias: "ui-1"
      )
    )
  }

  func testDestructiveLifecycleRequestStagesConfirmationWithoutSendingCommand() async throws {
    let snapshot = try loadFixture(named: "busy-snapshot")
    let loadedState = makeLoadedState(snapshot: snapshot)
    let commandClient = RecordingCommandClient()
    let store = BrokerDashboardStore(
      loader: StubSnapshotLoader(state: loadedState),
      commandClient: commandClient,
      runtimePaths: loadedState.paths
    )
    store.loadedState = loadedState
    store.inspectedSimulatorAlias = "ui-1"

    store.requestLifecycleAction(.erase)

    XCTAssertEqual(store.pendingLifecycleRequest?.action, .erase)
    XCTAssertEqual(store.pendingLifecycleRequest?.alias, "ui-1")
    let requests = await commandClient.requests()
    XCTAssertTrue(requests.isEmpty)
  }

  func testImmediateLifecycleRequestRoutesSelectedAlias() async throws {
    let snapshot = try loadFixture(named: "busy-snapshot")
    let loadedState = makeLoadedState(snapshot: snapshot)
    let commandClient = RecordingCommandClient()
    let store = BrokerDashboardStore(
      loader: StubSnapshotLoader(state: loadedState),
      commandClient: commandClient,
      runtimePaths: loadedState.paths
    )
    store.loadedState = loadedState
    store.inspectedSimulatorAlias = "ui-1"

    store.requestLifecycleAction(.shutdown)

    try await waitUntil {
      let requests = await commandClient.requests()
      return requests.count == 1
    }

    let requests = await commandClient.requests()
    XCTAssertEqual(requests[0].group, "simulators")
    XCTAssertEqual(requests[0].command, "shutdown")
    XCTAssertEqual(requests[0].options["alias"]?.stringValue, "ui-1")
    XCTAssertEqual(requests[0].options["actorId"]?.stringValue, "simulator-broker-app")
    XCTAssertEqual(requests[0].options["actorType"]?.stringValue, "human")
    XCTAssertNil(store.pendingLifecycleRequest)
  }

  func testReleaseLeaseConfirmationUsesCurrentLeaseRequest() async throws {
    let snapshot = try loadFixture(named: "busy-snapshot")
    let loadedState = makeLoadedState(snapshot: snapshot)
    let commandClient = RecordingCommandClient()
    let store = BrokerDashboardStore(
      loader: StubSnapshotLoader(state: loadedState),
      commandClient: commandClient,
      runtimePaths: loadedState.paths
    )
    store.loadedState = loadedState
    store.inspectedSimulatorAlias = "ui-1"

    store.requestReleaseLease()

    XCTAssertEqual(store.pendingReleaseLeaseRequest?.lease.leaseId, "lease-ui-1")

    store.confirmReleaseLease()

    try await waitUntil {
      let requests = await commandClient.requests()
      return requests.count == 1
    }

    let requests = await commandClient.requests()
    XCTAssertEqual(requests[0].group, "lease")
    XCTAssertEqual(requests[0].command, "release")
    XCTAssertEqual(requests[0].options["leaseId"]?.stringValue, "lease-ui-1")
    XCTAssertEqual(requests[0].options["actorId"]?.stringValue, "simulator-broker-app")
    XCTAssertEqual(requests[0].options["actorType"]?.stringValue, "human")
    XCTAssertNil(store.pendingReleaseLeaseRequest)
  }

  func testLeavingSimulatorsClearsPendingSimulatorPrompts() throws {
    let snapshot = try loadFixture(named: "busy-snapshot")
    let loadedState = makeLoadedState(snapshot: snapshot)
    let store = BrokerDashboardStore(
      loader: StubSnapshotLoader(state: loadedState),
      commandClient: RecordingCommandClient(),
      runtimePaths: loadedState.paths
    )
    store.loadedState = loadedState
    let lease = try XCTUnwrap(store.readModel?.lease(for: "ui-1"))
    let currentHolder = BrokerLeaseSummary(
      actorId: lease.actorId,
      actorType: lease.actorType,
      jobId: lease.jobId,
      leaseId: lease.leaseId,
      projectId: lease.projectId,
      purposeId: lease.purposeId
    )

    store.selectedPane = .simulators
    store.pendingClearPinRequest = BrokerPendingClearPinRequest(alias: "manual-1")
    store.pendingCreatePinRequest = BrokerPendingCreatePinRequest(alias: "ui-1")
    store.pendingLifecycleRequest = BrokerPendingLifecycleRequest(action: .erase, alias: "ui-1")
    store.pendingOverrideRequest = BrokerLifecycleOverrideRequest(
      action: .repair,
      alias: "ui-1",
      currentHolder: currentHolder
    )
    store.pendingReleaseLeaseRequest = BrokerPendingLeaseReleaseRequest(lease: lease)

    store.selectedPane = .projects

    XCTAssertNil(store.pendingClearPinRequest)
    XCTAssertNil(store.pendingCreatePinRequest)
    XCTAssertNil(store.pendingLifecycleRequest)
    XCTAssertNil(store.pendingOverrideRequest)
    XCTAssertNil(store.pendingReleaseLeaseRequest)
  }

  func testOverrideRequestIsDroppedAfterLeavingSimulators() async throws {
    let snapshot = try loadFixture(named: "busy-snapshot")
    let loadedState = makeLoadedState(snapshot: snapshot)
    let overrideError = BrokerServiceCommandError(
      currentHolder: BrokerLeaseSummary(
        actorId: "agent-review",
        actorType: "agent",
        jobId: "job-101",
        leaseId: "lease-ui-2",
        projectId: "sample-project",
        purposeId: "agent-ui-session"
      ),
      message: "Alias ui-2 requires an explicit human override before repair.",
      reasonCode: "override-required",
      requiredConfirmationFields: ["forceOverride", "overrideReason", "expectedAlias", "expectedLeaseId"],
      statusCode: 400
    )
    let commandClient = BlockingCommandClient(error: overrideError)
    let store = BrokerDashboardStore(
      loader: StubSnapshotLoader(state: loadedState),
      commandClient: commandClient,
      runtimePaths: loadedState.paths
    )
    store.loadedState = loadedState
    store.selectedPane = .simulators
    store.inspectedSimulatorAlias = "ui-2"

    store.requestLifecycleAction(.repair)
    store.confirmPendingLifecycleAction()

    try await waitUntil {
      await commandClient.hasPendingSend()
    }

    store.selectedPane = .events
    await commandClient.release()

    try await waitUntil {
      store.isApplyingAction == false && store.lastErrorMessage != nil
    }

    XCTAssertNil(store.pendingOverrideRequest)
    XCTAssertEqual(store.lastErrorMessage, overrideError.localizedDescription)
  }

  func testLaunchContextInitializerSeedsIndependentWindowStatePerStore() {
    let launchContext = BrokerLaunchContext.fromLaunchContext(
      arguments: [
        "SimulatorBrokerApp",
        "--pane",
        "simulators",
        "--simulator-alias",
        "ui-2",
        "--state-root",
        "/tmp/window-state-root",
        "--host-config",
        "/tmp/window-host-config.json",
        "--cli-path",
        "/tmp/window-cli",
      ],
      environment: [:]
    )

    let storeA = BrokerDashboardStore(
      launchContext: launchContext,
      localCommandRunner: RecordingLocalCommandRunner()
    )
    let storeB = BrokerDashboardStore(
      launchContext: launchContext,
      localCommandRunner: RecordingLocalCommandRunner()
    )

    XCTAssertNotEqual(ObjectIdentifier(storeA), ObjectIdentifier(storeB))
    XCTAssertEqual(storeA.selectedPane, .simulators)
    XCTAssertEqual(storeA.inspectedSimulatorAlias, "ui-2")
    XCTAssertEqual(storeA.stateRootPath, "/tmp/window-state-root")
    XCTAssertEqual(storeA.hostConfigPath, "/tmp/window-host-config.json")
    XCTAssertEqual(storeA.cliPath, "/tmp/window-cli")

    XCTAssertEqual(storeB.selectedPane, .simulators)
    XCTAssertEqual(storeB.inspectedSimulatorAlias, "ui-2")
    XCTAssertEqual(storeB.stateRootPath, "/tmp/window-state-root")
    XCTAssertEqual(storeB.hostConfigPath, "/tmp/window-host-config.json")
    XCTAssertEqual(storeB.cliPath, "/tmp/window-cli")

    storeA.selectedPane = .events
    storeA.inspectedSimulatorAlias = "manual-1"
    storeA.simulatorSearchText = "manual"
    storeA.lastActionMessage = "Updated only window A"

    XCTAssertEqual(storeB.selectedPane, .simulators)
    XCTAssertEqual(storeB.inspectedSimulatorAlias, "ui-2")
    XCTAssertEqual(storeB.simulatorSearchText, "")
    XCTAssertNil(storeB.lastActionMessage)
  }

  func testSceneRestorationAppliesValidStoredValues() throws {
    let snapshot = try loadFixture(named: "busy-snapshot")
    let loadedState = makeLoadedState(snapshot: snapshot)
    let store = BrokerDashboardStore(
      loader: StubSnapshotLoader(state: loadedState),
      commandClient: RecordingCommandClient(),
      runtimePaths: loadedState.paths
    )
    store.loadedState = loadedState

    store.applySceneRestorationState(
      BrokerSceneRestorationState(
        selectedPaneRawValue: "simulators",
        inspectedSimulatorAlias: "ui-2",
        inspectedProjectId: "sample-project",
        inspectedEventId: "event-1",
        simulatorSearchText: "ui-2",
        simulatorActorFilter: "agent",
        simulatorHealthFilterRawValue: "unhealthy",
        simulatorProjectFilter: "sample-project",
        simulatorPurposeFilter: "agent-ui-session"
      )
    )

    XCTAssertEqual(
      store.sceneRestorationState,
      BrokerSceneRestorationState(
        selectedPane: .simulators,
        inspectedSimulatorAlias: "ui-2",
        inspectedProjectId: "sample-project",
        inspectedEventId: "event-1",
        simulatorSearchText: "ui-2",
        simulatorActorFilter: "agent",
        simulatorHealthFilter: .unhealthy,
        simulatorProjectFilter: "sample-project",
        simulatorPurposeFilter: "agent-ui-session"
      )
    )
  }

  func testSceneRestorationDecodesInvalidStoredValuesSafely() {
    let restorationState = BrokerSceneRestorationState(
      selectedPaneRawValue: "unsupported-pane",
      inspectedSimulatorAlias: "",
      inspectedProjectId: "",
      inspectedEventId: "",
      simulatorSearchText: nil,
      simulatorActorFilter: "",
      simulatorHealthFilterRawValue: "unsupported-health",
      simulatorProjectFilter: "",
      simulatorPurposeFilter: nil
    )

    XCTAssertEqual(restorationState.selectedPane, .overview)
    XCTAssertNil(restorationState.inspectedSimulatorAlias)
    XCTAssertNil(restorationState.inspectedProjectId)
    XCTAssertNil(restorationState.inspectedEventId)
    XCTAssertEqual(restorationState.simulatorSearchText, "")
    XCTAssertEqual(restorationState.simulatorActorFilter, BrokerDashboardReadModel.allSelection)
    XCTAssertEqual(restorationState.simulatorHealthFilter, .all)
    XCTAssertEqual(restorationState.simulatorProjectFilter, BrokerDashboardReadModel.allSelection)
    XCTAssertEqual(restorationState.simulatorPurposeFilter, BrokerDashboardReadModel.allSelection)
  }

  func testSceneRestorationFallsBackWhenStoredSelectionsAreStale() throws {
    let snapshot = try loadFixture(named: "busy-snapshot")
    let loadedState = makeLoadedState(snapshot: snapshot)
    let store = BrokerDashboardStore(
      loader: StubSnapshotLoader(state: loadedState),
      commandClient: RecordingCommandClient(),
      runtimePaths: loadedState.paths
    )
    store.loadedState = loadedState

    store.applySceneRestorationState(
      BrokerSceneRestorationState(
        selectedPaneRawValue: "simulators",
        inspectedSimulatorAlias: "missing-simulator",
        inspectedProjectId: "missing-project",
        inspectedEventId: "missing-event",
        simulatorSearchText: "",
        simulatorActorFilter: BrokerDashboardReadModel.allSelection,
        simulatorHealthFilterRawValue: "all",
        simulatorProjectFilter: BrokerDashboardReadModel.allSelection,
        simulatorPurposeFilter: BrokerDashboardReadModel.allSelection
      )
    )

    let expectedSimulatorAlias = try XCTUnwrap(
      store.readModel?.filteredSimulators(using: store.simulatorFilters).first?.alias
    )

    XCTAssertEqual(store.selectedPane, .simulators)
    XCTAssertEqual(store.inspectedSimulatorAlias, expectedSimulatorAlias)
    XCTAssertEqual(store.inspectedProjectId, "sample-project")
    XCTAssertEqual(store.inspectedEventId, "event-2")
  }

  func testSceneRestorationFallsBackWhenStoredFiltersAreStale() throws {
    let snapshot = try loadFixture(named: "busy-snapshot")
    let loadedState = makeLoadedState(snapshot: snapshot)
    let store = BrokerDashboardStore(
      loader: StubSnapshotLoader(state: loadedState),
      commandClient: RecordingCommandClient(),
      runtimePaths: loadedState.paths
    )
    store.loadedState = loadedState

    store.applySceneRestorationState(
      BrokerSceneRestorationState(
        selectedPaneRawValue: "simulators",
        inspectedSimulatorAlias: "ui-2",
        inspectedProjectId: "sample-project",
        inspectedEventId: "event-1",
        simulatorSearchText: "",
        simulatorActorFilter: "retired-actor",
        simulatorHealthFilterRawValue: "all",
        simulatorProjectFilter: "missing-project",
        simulatorPurposeFilter: "missing-purpose"
      )
    )

    XCTAssertEqual(store.simulatorActorFilter, BrokerDashboardReadModel.allSelection)
    XCTAssertEqual(store.simulatorProjectFilter, BrokerDashboardReadModel.allSelection)
    XCTAssertEqual(store.simulatorPurposeFilter, BrokerDashboardReadModel.allSelection)
    XCTAssertEqual(store.inspectedSimulatorAlias, "ui-2")
  }

  func testSceneRestorationSurvivesStartupBeforeSnapshotLoads() async throws {
    let snapshot = try loadFixture(named: "busy-snapshot")
    let emptyState = makeLoadedState(snapshot: nil)
    let populatedState = makeLoadedState(snapshot: snapshot)
    let loader = SequencedSnapshotLoader(states: [emptyState, populatedState])
    let store = BrokerDashboardStore(
      loader: loader,
      commandClient: RecordingCommandClient(),
      runtimePaths: populatedState.paths,
      refreshInterval: .seconds(60)
    )

    store.applySceneRestorationState(
      BrokerSceneRestorationState(
        selectedPaneRawValue: "simulators",
        inspectedSimulatorAlias: "ui-2",
        inspectedProjectId: "sample-project",
        inspectedEventId: "event-2",
        simulatorSearchText: "",
        simulatorActorFilter: BrokerDashboardReadModel.allSelection,
        simulatorHealthFilterRawValue: "all",
        simulatorProjectFilter: BrokerDashboardReadModel.allSelection,
        simulatorPurposeFilter: BrokerDashboardReadModel.allSelection
      )
    )

    store.start()
    defer {
      store.stop()
    }

    try await waitUntil {
      let count = await loader.loadCount()
      return count >= 1 && store.startupState == .needsSnapshotRefresh
    }

    XCTAssertEqual(store.inspectedSimulatorAlias, "ui-2")
    XCTAssertEqual(store.inspectedProjectId, "sample-project")
    XCTAssertEqual(store.inspectedEventId, "event-2")

    store.refreshNow()

    try await waitUntil {
      let count = await loader.loadCount()
      return count >= 2 && store.snapshot != nil
    }

    XCTAssertEqual(store.selectedPane, .simulators)
    XCTAssertEqual(store.inspectedSimulatorAlias, "ui-2")
    XCTAssertEqual(store.inspectedProjectId, "sample-project")
    XCTAssertEqual(store.inspectedEventId, "event-2")
  }

  func testOverlappingRefreshesIgnoreStaleOlderResult() async throws {
    let olderState = makeLoadedState(
      snapshot: try loadFixture(named: "busy-snapshot", generatedAt: "2026-04-09T10:00:00Z")
    )
    let newerState = makeLoadedState(
      snapshot: try loadFixture(named: "busy-snapshot", generatedAt: "2026-04-09T10:30:00Z")
    )
    let loader = ControlledSnapshotLoader()
    let store = BrokerDashboardStore(
      loader: loader,
      commandClient: RecordingCommandClient(),
      runtimePaths: olderState.paths
    )

    store.refreshNow()
    try await waitUntil {
      await loader.pendingCount() == 1
    }

    store.refreshNow()
    try await waitUntil {
      await loader.pendingCount() == 2
    }

    await loader.resumePending(at: 1, with: newerState)
    try await waitUntil {
      store.loadedState?.snapshot?.generatedAt == "2026-04-09T10:30:00Z"
    }

    await loader.resumePending(at: 0, with: olderState)
    try await waitUntil {
      await loader.pendingCount() == 0 && store.isRefreshing == false
    }

    XCTAssertEqual(store.loadedState?.snapshot?.generatedAt, "2026-04-09T10:30:00Z")
  }

  func testSupersededMutationRefreshWaitsForWinningFailure() async throws {
    let loadedState = makeLoadedState(
      snapshot: try loadFixture(named: "busy-snapshot", generatedAt: "2026-04-09T10:00:00Z")
    )
    let refreshedState = makeLoadedState(
      snapshot: try loadFixture(named: "busy-snapshot", generatedAt: "2026-04-09T10:30:00Z")
    )
    let refreshError = SnapshotRefreshTestError(message: "Winning refresh failed")
    let loader = ControlledSnapshotLoader()
    let commandClient = RecordingCommandClient()
    let store = BrokerDashboardStore(
      loader: loader,
      commandClient: commandClient,
      runtimePaths: loadedState.paths
    )
    store.loadedState = loadedState

    let mutationTask = Task { @MainActor in
      try await store.performLifecycleAction(.shutdown, alias: "ui-1")
    }

    try await waitUntil {
      await loader.pendingCount() == 1
    }

    store.refreshNow()

    try await waitUntil {
      await loader.pendingCount() == 2
    }

    await loader.resumePending(at: 0, with: refreshedState)
    try await waitUntil {
      await loader.pendingCount() == 1
    }

    await loader.failPending(at: 0, with: refreshError)

    do {
      try await mutationTask.value
      XCTFail("Expected winning refresh failure")
    } catch {
      XCTAssertEqual(error.localizedDescription, "Winning refresh failed")
    }

    XCTAssertNil(store.lastActionMessage)
    XCTAssertEqual(store.lastErrorMessage, "Winning refresh failed")
    XCTAssertEqual(store.loadedState?.snapshot?.generatedAt, "2026-04-09T10:00:00Z")
  }

  func testExplicitLaunchArgumentsOverrideRestoredSceneState() {
    let launchContext = BrokerLaunchContext.fromLaunchContext(
      arguments: [
        "SimulatorBrokerApp",
        "--simulator-alias",
        "ui-2",
        "--state-root",
        "/tmp/window-state-root",
        "--host-config",
        "/tmp/window-host-config.json",
        "--cli-path",
        "/tmp/window-cli",
      ],
      environment: [:]
    )
    let store = BrokerDashboardStore(
      launchContext: launchContext,
      localCommandRunner: RecordingLocalCommandRunner()
    )

    store.applySceneRestorationState(
      BrokerSceneRestorationState(
        selectedPaneRawValue: "events",
        inspectedSimulatorAlias: "manual-1",
        inspectedProjectId: "sample-project",
        inspectedEventId: "event-1",
        simulatorSearchText: "manual",
        simulatorActorFilter: "human",
        simulatorHealthFilterRawValue: "healthy",
        simulatorProjectFilter: "sample-project",
        simulatorPurposeFilter: "manual-testing"
      )
    )

    XCTAssertEqual(store.selectedPane, .simulators)
    XCTAssertEqual(store.inspectedSimulatorAlias, "ui-2")
    XCTAssertEqual(store.inspectedProjectId, "sample-project")
    XCTAssertEqual(store.inspectedEventId, "event-1")
    XCTAssertEqual(store.simulatorSearchText, "")
    XCTAssertEqual(store.simulatorActorFilter, BrokerDashboardReadModel.allSelection)
    XCTAssertEqual(store.simulatorHealthFilter, .all)
    XCTAssertEqual(store.simulatorProjectFilter, BrokerDashboardReadModel.allSelection)
    XCTAssertEqual(store.simulatorPurposeFilter, BrokerDashboardReadModel.allSelection)
  }

  func testStoppingOneStoreDoesNotAffectAnotherStoreRefreshLoop() async throws {
    let snapshot = try loadFixture(named: "busy-snapshot")
    let loadedState = makeLoadedState(snapshot: snapshot)
    let loaderA = CountingSnapshotLoader(state: loadedState)
    let loaderB = CountingSnapshotLoader(state: loadedState)
    let storeA = BrokerDashboardStore(
      loader: loaderA,
      commandClient: RecordingCommandClient(),
      runtimePaths: loadedState.paths,
      refreshInterval: .milliseconds(50)
    )
    let storeB = BrokerDashboardStore(
      loader: loaderB,
      commandClient: RecordingCommandClient(),
      runtimePaths: loadedState.paths,
      refreshInterval: .milliseconds(50)
    )

    storeA.start()
    storeB.start()
    defer {
      storeA.stop()
      storeB.stop()
    }

    try await waitUntil {
      let countA = await loaderA.loadCount()
      let countB = await loaderB.loadCount()
      return countA >= 2 && countB >= 2
    }

    let countABeforeStop = await loaderA.loadCount()
    let countBBeforeStop = await loaderB.loadCount()

    storeA.stop()

    try await waitUntil {
      await loaderB.loadCount() > countBBeforeStop
    }

    let countAAfterStop = await loaderA.loadCount()
    let countBAfterStop = await loaderB.loadCount()

    XCTAssertEqual(countAAfterStop, countABeforeStop)
    XCTAssertGreaterThan(countBAfterStop, countBBeforeStop)
  }

  private func loadFixture(named name: String) throws -> BrokerAppSnapshot {
    let fixturesRoot = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .appending(path: "Fixtures")
    let data = try Data(contentsOf: fixturesRoot.appending(path: "\(name).json"))
    return try JSONDecoder().decode(BrokerAppSnapshot.self, from: data)
  }

  private func loadFixture(named name: String, generatedAt: String) throws -> BrokerAppSnapshot {
    let fixturesRoot = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .appending(path: "Fixtures")
    let data = try Data(contentsOf: fixturesRoot.appending(path: "\(name).json"))
    var json = try XCTUnwrap(String(data: data, encoding: .utf8))
    json = json.replacingOccurrences(
      of: "\"generatedAt\": \"2026-04-09T10:15:00Z\"",
      with: "\"generatedAt\": \"\(generatedAt)\""
    )
    return try JSONDecoder().decode(BrokerAppSnapshot.self, from: Data(json.utf8))
  }

  private func makeLoadedState(
    snapshot: BrokerAppSnapshot?,
    service: BrokerServiceMetadata? = BrokerServiceMetadata(
      hostConfigPath: "/tmp/host-config.json",
      pid: 123,
      socketPath: "/tmp/simbroker.sock",
      startedAt: "2026-04-09T10:00:00Z",
      stateRoot: "/tmp/simbroker-store-test",
      transport: "unix-http"
    )
  ) -> BrokerLoadedState {
    let paths = BrokerRuntimePaths(
      stateRoot: URL(fileURLWithPath: "/tmp/simbroker-store-test"),
      hostConfigURL: URL(fileURLWithPath: "/tmp/host-config.json"),
      configuredCLIURL: URL(fileURLWithPath: "/tmp/fake-simbroker")
    )
    return BrokerLoadedState(
      paths: paths,
      tooling: BrokerToolingState(
        cliPath: URL(fileURLWithPath: "/tmp/fake-simbroker"),
        hostConfigExists: true,
        installMetadata: nil
      ),
      service: service,
      snapshot: snapshot
    )
  }

  private func waitUntil(
    timeout: Duration = .seconds(1),
    pollInterval: Duration = .milliseconds(10),
    condition: @escaping () async -> Bool
  ) async throws {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: timeout)

    while await condition() == false {
      if clock.now >= deadline {
        XCTFail("Timed out waiting for condition.")
        return
      }
      try await Task.sleep(for: pollInterval)
    }
  }
}

private actor RecordingCommandClient: BrokerCommandSending {
  private var recordedRequests: [BrokerCommandRequest] = []
  private var stubbedError: Error?
  private var stubbedResponses: [BrokerCommandEnvelope] = []

  func send(_ request: BrokerCommandRequest) async throws -> BrokerCommandEnvelope {
    recordedRequests.append(request)
    if let stubbedError {
      throw stubbedError
    }
    if stubbedResponses.isEmpty == false {
      return stubbedResponses.removeFirst()
    }
    return BrokerCommandEnvelope(
      currentHolder: nil,
      error: nil,
      exitCode: nil,
      ok: true,
      reasonCode: nil,
      requiredConfirmationFields: nil,
      unchanged: false
    )
  }

  func requests() -> [BrokerCommandRequest] {
    recordedRequests
  }

  func setError(_ error: Error?) {
    stubbedError = error
  }

  func enqueueResponse(_ response: BrokerCommandEnvelope) {
    stubbedResponses.append(response)
  }
}

private actor RecordingLocalCommandRunner: BrokerLocalCommandRunning {
  private var recordedInvocations: [(cliPath: URL, arguments: [String])] = []

  func run(cliPath: URL, arguments: [String]) async throws -> BrokerCLICommandEnvelope {
    recordedInvocations.append((cliPath, arguments))
    return BrokerCLICommandEnvelope(
      error: nil,
      exitCode: 0,
      ok: true,
      reasonCode: nil,
      started: true,
      unchanged: false
    )
  }

  func invocations() -> [(cliPath: URL, arguments: [String])] {
    recordedInvocations
  }
}

private actor StubSnapshotLoader: BrokerSnapshotLoading {
  private let state: BrokerLoadedState

  init(state: BrokerLoadedState) {
    self.state = state
  }

  func load() async throws -> BrokerLoadedState {
    state
  }
}

private struct SnapshotRefreshTestError: LocalizedError {
  let message: String

  var errorDescription: String? {
    message
  }
}

private actor FailingSnapshotLoader: BrokerSnapshotLoading {
  private let error: any Error

  init(error: any Error) {
    self.error = error
  }

  func load() async throws -> BrokerLoadedState {
    throw error
  }
}

private actor FailingOnceSnapshotLoader: BrokerSnapshotLoading {
  private var count = 0
  private let error: any Error
  private let recoveredState: BrokerLoadedState

  init(error: any Error, recoveredState: BrokerLoadedState) {
    self.error = error
    self.recoveredState = recoveredState
  }

  func load() async throws -> BrokerLoadedState {
    count += 1
    if count == 1 {
      throw error
    }
    return recoveredState
  }

  func loadCount() -> Int {
    count
  }
}

private actor CountingSnapshotLoader: BrokerSnapshotLoading {
  private var count = 0
  private let state: BrokerLoadedState

  init(state: BrokerLoadedState) {
    self.state = state
  }

  func load() async throws -> BrokerLoadedState {
    count += 1
    return state
  }

  func loadCount() -> Int {
    count
  }
}

private actor SequencedSnapshotLoader: BrokerSnapshotLoading {
  private var count = 0
  private var remainingStates: [BrokerLoadedState]
  private let fallbackState: BrokerLoadedState

  init(states: [BrokerLoadedState]) {
    precondition(states.isEmpty == false, "SequencedSnapshotLoader requires at least one state.")
    remainingStates = states
    fallbackState = states[states.count - 1]
  }

  func load() async throws -> BrokerLoadedState {
    count += 1
    if remainingStates.isEmpty == false {
      return remainingStates.removeFirst()
    }
    return fallbackState
  }

  func loadCount() -> Int {
    count
  }
}

private actor ControlledSnapshotLoader: BrokerSnapshotLoading {
  private var continuations: [CheckedContinuation<BrokerLoadedState, any Error>] = []

  func load() async throws -> BrokerLoadedState {
    try await withCheckedThrowingContinuation { continuation in
      continuations.append(continuation)
    }
  }

  func pendingCount() -> Int {
    continuations.count
  }

  func resumePending(at index: Int, with state: BrokerLoadedState) {
    let continuation = continuations.remove(at: index)
    continuation.resume(returning: state)
  }

  func failPending(at index: Int, with error: any Error) {
    let continuation = continuations.remove(at: index)
    continuation.resume(throwing: error)
  }
}

private actor BlockingCommandClient: BrokerCommandSending {
  private var continuation: CheckedContinuation<Void, Never>?
  private let error: Error

  init(error: Error) {
    self.error = error
  }

  func send(_ request: BrokerCommandRequest) async throws -> BrokerCommandEnvelope {
    await withCheckedContinuation { continuation in
      self.continuation = continuation
    }
    throw error
  }

  func hasPendingSend() -> Bool {
    continuation != nil
  }

  func release() {
    continuation?.resume()
    continuation = nil
  }
}

private actor DeferredCommandClient: BrokerCommandSending {
  private var continuation: CheckedContinuation<Void, Never>?
  private var recordedRequests: [BrokerCommandRequest] = []
  private let response: BrokerCommandEnvelope

  init(response: BrokerCommandEnvelope) {
    self.response = response
  }

  func send(_ request: BrokerCommandRequest) async throws -> BrokerCommandEnvelope {
    recordedRequests.append(request)
    await withCheckedContinuation { continuation in
      self.continuation = continuation
    }
    return response
  }

  func requests() -> [BrokerCommandRequest] {
    recordedRequests
  }

  func hasPendingSend() -> Bool {
    continuation != nil
  }

  func release() {
    continuation?.resume()
    continuation = nil
  }
}
