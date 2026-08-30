import Foundation
import Observation

enum BrokerNavigationPane: String, CaseIterable, Identifiable {
  case overview
  case simulators
  case projects
  case events

  var id: String { rawValue }

  var symbolName: String {
    switch self {
    case .overview:
      return "gauge.open.with.lines.needle.33percent"
    case .simulators:
      return "rectangle.3.group"
    case .projects:
      return "shippingbox"
    case .events:
      return "clock.arrow.trianglehead.counterclockwise.rotate.90"
    }
  }

  var title: String {
    rawValue.capitalized
  }
}

enum BrokerStartupState: Equatable {
  case missingCLI
  case needsHostBootstrap
  case needsServiceStart
  case needsSnapshotRefresh
  case readOnlySnapshot
  case serviceStatusUnverified
  case ready
}

private enum BrokerRefreshOutcome {
  case discarded
  case failed(any Error)
  case succeeded
  case superseded(by: Int)
}

private struct BrokerRefreshSupersededError: LocalizedError {
  let message: String

  var errorDescription: String? {
    message
  }
}

private struct BrokerSetupServiceMissingAfterRefreshError: LocalizedError {
  var errorDescription: String? {
    "Setup did not restore broker command authority. Refresh the dashboard or rerun setup."
  }
}

private struct BrokerCommandAuthorityRevokedError: LocalizedError {
  var errorDescription: String? {
    "Broker commands are disabled until a successful refresh validates brokerd."
  }
}

@MainActor
@Observable
final class BrokerDashboardStore {
  private static let appHumanActorId = "simulator-broker-app"

  private let commandClient: any BrokerCommandSending
  private var feedbackClearTask: Task<Void, Never>?
  private let initialSelection: BrokerInitialSelection
  private let localCommandRunner: any BrokerLocalCommandRunning
  private let loader: any BrokerSnapshotLoading
  private var completedRefreshOutcomes: [Int: BrokerRefreshOutcome] = [:]
  private var idleCleanupPreviewGeneration = 0
  private var refreshGeneration = 0
  private var refreshOutcomeWaiters: [Int: [UUID: CheckedContinuation<BrokerRefreshOutcome, Never>]] = [:]
  private let refreshInterval: Duration
  private var refreshTask: Task<Void, Never>?
  private let runtimePaths: BrokerRuntimePaths
  private var serviceAuthorityEpoch = 0
  @ObservationIgnored private var setupTask: Task<Void, Never>?
  private var setupGeneration = 0
  private var storeStopGeneration = 0
  private var visibleRefreshCount = 0

  var inspectedEventId: String?
  var inspectedProjectId: String?
  var inspectedSimulatorAlias: String?
  var isApplyingAction = false
  var isRefreshing = false
  var lastActionMessage: String?
  var lastErrorMessage: String?
  var loadedState: BrokerLoadedState?
  var pendingClearPinRequest: BrokerPendingClearPinRequest?
  var pendingCreatePinRequest: BrokerPendingCreatePinRequest?
  var pendingIdleCleanupRequest: BrokerPendingIdleCleanupRequest?
  var pendingLifecycleRequest: BrokerPendingLifecycleRequest?
  var pendingOverrideRequest: BrokerLifecycleOverrideRequest?
  var pendingReleaseLeaseRequest: BrokerPendingLeaseReleaseRequest?
  var pendingSetupConfirmation: String?
  private(set) var serviceStatusUnverified = false
  var setupPhase: BrokerSetupPhase = .idle
  var setupPlan: BrokerSetupPlan?

  var isAutomaticSetupInProgress: Bool {
    isApplyingAction && setupPlan == nil && setupPhase != .idle && setupPhase != .awaitingConfirmation
  }

  var selectedPane: BrokerNavigationPane = .overview {
    didSet {
      if selectedPane != .overview {
        idleCleanupPreviewGeneration += 1
        pendingIdleCleanupRequest = nil
      }
      guard selectedPane != .simulators else {
        return
      }

      clearPendingSimulatorPrompts()
    }
  }
  var simulatorActorFilter = BrokerDashboardReadModel.allSelection
  var simulatorHealthFilter: BrokerHealthFilter = .all
  var simulatorProjectFilter = BrokerDashboardReadModel.allSelection
  var simulatorPurposeFilter = BrokerDashboardReadModel.allSelection
  var simulatorSearchText = ""

  init(
    loader: any BrokerSnapshotLoading,
    commandClient: any BrokerCommandSending,
    localCommandRunner: any BrokerLocalCommandRunning = ProcessBrokerLocalCommandRunner(),
    runtimePaths: BrokerRuntimePaths,
    initialSelection: BrokerInitialSelection = .defaultSelection,
    refreshInterval: Duration = .seconds(2)
  ) {
    self.commandClient = commandClient
    self.initialSelection = initialSelection
    self.loader = loader
    self.localCommandRunner = localCommandRunner
    self.refreshInterval = refreshInterval
    self.runtimePaths = runtimePaths
    applyInitialSelection(initialSelection)
  }

  convenience init(
    launchContext: BrokerLaunchContext,
    localCommandRunner: any BrokerLocalCommandRunning = ProcessBrokerLocalCommandRunner(),
    refreshInterval: Duration = .seconds(2)
  ) {
    let runtimePaths = launchContext.runtimePaths
    self.init(
      loader: FileBrokerSnapshotLoader(paths: runtimePaths),
      commandClient: BrokerServiceCommandClient(paths: runtimePaths),
      localCommandRunner: localCommandRunner,
      runtimePaths: runtimePaths,
      initialSelection: launchContext.initialSelection,
      refreshInterval: refreshInterval
    )
  }

  var generatedAtText: String {
    timestampDisplay(snapshot?.generatedAt) ?? "No snapshot loaded"
  }

  var commandAvailability: BrokerDashboardCommandAvailability {
    let canMutate = canSendCommands && isApplyingAction == false
    let canRefreshSnapshot = isApplyingAction == false

    guard let selectedSimulator else {
      return BrokerDashboardCommandAvailability(
        canRefreshSnapshot: canRefreshSnapshot,
        canBootSimulator: false,
        canShutdownSimulator: false,
        canEraseSimulator: false,
        canRepairSimulator: false,
        canReleaseLease: false,
        canCreatePin: false,
        canClearPin: false
      )
    }

    let hasEligiblePinProjects = readModel?.eligiblePinProjects(for: selectedSimulator).isEmpty == false

    return BrokerDashboardCommandAvailability(
      canRefreshSnapshot: canRefreshSnapshot,
      canBootSimulator: canMutate && selectedSimulatorAllowsLifecycleMutation && selectedSimulator.powerState != "booted",
      canShutdownSimulator: canMutate && selectedSimulatorAllowsLifecycleMutation && selectedSimulator.powerState == "booted",
      canEraseSimulator: canMutate && selectedSimulatorAllowsLifecycleMutation,
      canRepairSimulator: canMutate,
      canReleaseLease: canMutate && selectedLease != nil,
      canCreatePin: canMutate && selectedPin == nil && hasEligiblePinProjects,
      canClearPin: canMutate && selectedPin != nil
    )
  }

  var hasActiveSimulatorFilters: Bool {
    simulatorHealthFilter != .all
      || simulatorProjectFilter != BrokerDashboardReadModel.allSelection
      || simulatorPurposeFilter != BrokerDashboardReadModel.allSelection
      || simulatorActorFilter != BrokerDashboardReadModel.allSelection
      || simulatorSearchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
  }

  var readModel: BrokerDashboardReadModel? {
    snapshot.map(BrokerDashboardReadModel.init(snapshot:))
  }

  var commandStatusText: String {
    switch startupState {
    case .ready:
      return "Commands enabled"
    case .readOnlySnapshot:
      return "Read-only snapshot"
    case .serviceStatusUnverified:
      return "Status unverified"
    case .needsSnapshotRefresh:
      return "Refreshing state"
    case .needsServiceStart:
      return serviceRequiresRestart ? "Restart required" : "Broker stopped"
    case .missingCLI, .needsHostBootstrap:
      return "Setup required"
    }
  }

  var serviceStatusText: String {
    switch startupState {
    case .ready:
      return "brokerd running"
    case .readOnlySnapshot:
      return "snapshot only"
    case .serviceStatusUnverified:
      return "status unverified"
    case .needsSnapshotRefresh:
      return "brokerd starting"
    case .needsServiceStart:
      return serviceRequiresRestart ? "brokerd restart required" : "brokerd stopped"
    case .missingCLI, .needsHostBootstrap:
      return "setup required"
    }
  }

  var simulatorFilters: BrokerSimulatorFilters {
    BrokerSimulatorFilters(
      actorType: simulatorActorFilter,
      health: simulatorHealthFilter,
      projectId: simulatorProjectFilter,
      purposeId: simulatorPurposeFilter,
      searchText: simulatorSearchText
    )
  }

  var snapshot: BrokerAppSnapshot? {
    loadedState?.snapshot
  }

  var sceneRestorationState: BrokerSceneRestorationState {
    BrokerSceneRestorationState(
      selectedPane: selectedPane,
      inspectedSimulatorAlias: inspectedSimulatorAlias,
      inspectedProjectId: inspectedProjectId,
      inspectedEventId: inspectedEventId,
      simulatorSearchText: simulatorSearchText,
      simulatorActorFilter: simulatorActorFilter,
      simulatorHealthFilter: simulatorHealthFilter,
      simulatorProjectFilter: simulatorProjectFilter,
      simulatorPurposeFilter: simulatorPurposeFilter
    )
  }

  var selectedLease: BrokerLease? {
    readModel?.lease(for: inspectedSimulatorAlias)
  }

  var selectedPin: BrokerPin? {
    readModel?.pin(for: inspectedSimulatorAlias)
  }

  var selectedSimulator: BrokerSimulator? {
    readModel?.simulator(alias: inspectedSimulatorAlias)
  }

  var selectedSimulatorAllowsLifecycleMutation: Bool {
    guard let selectedSimulator else {
      return false
    }
    return selectedSimulator.health == "healthy" || selectedSimulator.health == "state-drift"
  }

  var canSendCommands: Bool {
    loadedState?.service != nil
      && serviceRequiresRestart == false
      && serviceStatusUnverified == false
  }

  var serviceRequiresRestart: Bool {
    loadedState?.serviceRequiresRestart == true && serviceStatusUnverified == false
  }

  var canRunLocalBrokerCommands: Bool {
    resolvedCLIURL != nil
  }

  var canStartBrokerService: Bool {
    canRunLocalBrokerCommands
      && hostConfigExists
      && (loadedState?.service == nil || serviceRequiresRestart)
      && serviceStatusUnverified == false
  }

  var canOfferReadOnlyFinishSetup: Bool {
    (startupState == .readOnlySnapshot || serviceRequiresRestart)
      && canStartBrokerService
      && isApplyingAction == false
      && serviceStatusUnverified == false
  }

  var serviceAvailabilityMessage: String {
    if serviceStatusUnverified {
      if snapshot != nil {
        return "Broker commands are disabled because current brokerd status could not be verified. The last readable snapshot remains available; refresh before sending commands."
      }
      return "Broker commands are disabled because current brokerd status could not be verified. Refresh before starting setup or sending commands."
    }
    if serviceRequiresRestart {
      return "Broker commands are disabled because brokerd is running with a runtime that requires restart. Finish setup to restart it cooperatively and restore command authority."
    }
    return "Broker commands are disabled because brokerd is not running. Start the service to enable pinning, release, and lifecycle actions."
  }

  var unverifiedServiceStatusFallbackCommand: String? {
    guard serviceStatusUnverified else {
      return nil
    }
    return BrokerCLIInvocationFormatter(executablePath: onboardingCLIPath).serviceStatusCommand(
      hostConfigPath: hostConfigPath,
      stateRootPath: stateRootPath,
      serviceSocketPath: serviceSocketPath
    )
  }

  var canRefreshSnapshotArtifact: Bool {
    canRunLocalBrokerCommands && hostConfigExists
  }

  var cliHintPath: String {
    if let cliPath = loadedState?.tooling.installMetadata?.cliPath, cliPath.isEmpty == false {
      return cliPath
    }
    if let configuredCLIURL = runtimePaths.configuredCLIURL {
      return configuredCLIURL.path
    }
    return BrokerRuntimePaths.defaultCLIURL().path
  }

  var cliPath: String? {
    resolvedCLIURL?.path
  }

  var onboardingCLIPath: String? {
    resolvedCLIURL?.path
  }

  var hostConfigExists: Bool {
    loadedState?.tooling.hostConfigExists ?? FileManager.default.fileExists(atPath: runtimePaths.hostConfigURL.path)
  }

  var hostConfigPath: String {
    loadedState?.paths.hostConfigURL.path ?? runtimePaths.hostConfigURL.path
  }

  var installRootPath: String? {
    loadedState?.tooling.installMetadata?.prefix
  }

  var envHelperPath: String? {
    guard
      let installMetadata = loadedState?.tooling.installMetadata,
      let installRootPath = installMetadata.prefix,
      installRootPath.isEmpty == false,
      let installCLIPath = installMetadata.cliPath,
      installCLIPath.isEmpty == false
    else {
      return nil
    }

    let expandedCLIPath = (installCLIPath as NSString).expandingTildeInPath
    guard expandedCLIPath == onboardingCLIPath else {
      return nil
    }

    let envHelperPath = URL(fileURLWithPath: (installRootPath as NSString).expandingTildeInPath)
      .appending(path: "env.sh")
      .path

    guard FileManager.default.fileExists(atPath: envHelperPath) else {
      return nil
    }

    return envHelperPath
  }

  var startupState: BrokerStartupState {
    if serviceStatusUnverified {
      return .serviceStatusUnverified
    }
    if hostConfigExists == false {
      return canRunLocalBrokerCommands ? .needsHostBootstrap : .missingCLI
    }
    if serviceRequiresRestart {
      return .needsServiceStart
    }
    if loadedState?.service != nil {
      return snapshot == nil ? .needsSnapshotRefresh : .ready
    }
    if snapshot != nil {
      return .readOnlySnapshot
    }
    if canRunLocalBrokerCommands == false {
      return .missingCLI
    }
    return .needsServiceStart
  }

  var stateRootPath: String {
    loadedState?.paths.stateRoot.path ?? runtimePaths.stateRoot.path
  }

  var serviceSocketPath: String? {
    runtimePaths.serviceSocketURL?.path
  }

  func start() {
    guard refreshTask == nil else {
      return
    }

    BrokerLogger.appLifecycle.info(
      "Dashboard store starting stateRoot=\(self.stateRootPath, privacy: .public) refreshIntervalSeconds=\(self.refreshInterval.components.seconds, privacy: .public)"
    )
    BrokerLogger.appLifecycle.info("Refresh loop started")

    refreshTask = Task {
      await refresh()
      while Task.isCancelled == false {
        do {
          try await Task.sleep(for: refreshInterval)
        } catch {
          break
        }
        guard Task.isCancelled == false else {
          break
        }
        if isApplyingAction {
          continue
        }
        await refresh(silent: true)
      }
    }
  }

  @discardableResult
  func stop() -> Task<Void, Never>? {
    if refreshTask != nil {
      BrokerLogger.appLifecycle.info("Refresh loop stopping")
    }
    let stoppedRefreshTask = refreshTask
    storeStopGeneration += 1
    feedbackClearTask?.cancel()
    refreshTask?.cancel()
    setupTask?.cancel()
    feedbackClearTask = nil
    isRefreshing = false
    visibleRefreshCount = 0
    refreshTask = nil
    setupTask = nil
    return stoppedRefreshTask
  }

  func clearFeedback() {
    feedbackClearTask?.cancel()
    feedbackClearTask = nil
    lastActionMessage = nil
    lastErrorMessage = nil
  }

  func clearSimulatorFilters() {
    simulatorActorFilter = BrokerDashboardReadModel.allSelection
    simulatorHealthFilter = .all
    simulatorProjectFilter = BrokerDashboardReadModel.allSelection
    simulatorPurposeFilter = BrokerDashboardReadModel.allSelection
    simulatorSearchText = ""
    synchronizeSelections()
  }

  func applySceneRestorationState(_ restorationState: BrokerSceneRestorationState) {
    let resolvedState = restorationState.applying(initialSelection: initialSelection)
    selectedPane = resolvedState.selectedPane
    inspectedSimulatorAlias = resolvedState.inspectedSimulatorAlias
    inspectedProjectId = resolvedState.inspectedProjectId
    inspectedEventId = resolvedState.inspectedEventId
    simulatorSearchText = resolvedState.simulatorSearchText
    simulatorActorFilter = resolvedState.simulatorActorFilter
    simulatorHealthFilter = resolvedState.simulatorHealthFilter
    simulatorProjectFilter = resolvedState.simulatorProjectFilter
    simulatorPurposeFilter = resolvedState.simulatorPurposeFilter

    if loadedState != nil {
      synchronizeSelections()
    }
  }

  func refreshNow() {
    Task {
      await refresh()
    }
  }

  func requestClearPin() {
    guard commandAvailability.canClearPin, let alias = inspectedSimulatorAlias else {
      return
    }
    pendingClearPinRequest = BrokerPendingClearPinRequest(alias: alias)
  }

  func requestCreatePin() {
    guard commandAvailability.canCreatePin, let alias = inspectedSimulatorAlias else {
      return
    }
    pendingCreatePinRequest = BrokerPendingCreatePinRequest(alias: alias)
  }

  func requestLifecycleAction(_ action: BrokerLifecycleAction) {
    guard lifecycleActionIsEnabled(action), let alias = inspectedSimulatorAlias else {
      return
    }

    let request = BrokerPendingLifecycleRequest(action: action, alias: alias)
    if action.requiresDestructiveConfirmation {
      pendingLifecycleRequest = request
      return
    }

    runLifecycleAction(request)
  }

  func requestReleaseLease() {
    guard commandAvailability.canReleaseLease, let selectedLease else {
      return
    }
    pendingReleaseLeaseRequest = BrokerPendingLeaseReleaseRequest(lease: selectedLease)
  }

  func confirmClearPin() {
    guard canSendCommands, let request = pendingClearPinRequest else {
      pendingClearPinRequest = nil
      return
    }
    pendingClearPinRequest = nil
    Task {
      do {
        try await clearPin(alias: request.alias)
      } catch {
        lastErrorMessage = error.localizedDescription
      }
    }
  }

  func confirmOverrideRequest(reason: String) {
    let trimmedReason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
    guard canSendCommands else {
      pendingOverrideRequest = nil
      return
    }
    guard let pendingOverrideRequest, trimmedReason.isEmpty == false else {
      return
    }

    self.pendingOverrideRequest = nil
    runLifecycleAction(
      BrokerPendingLifecycleRequest(action: pendingOverrideRequest.action, alias: pendingOverrideRequest.alias),
      overrideReason: trimmedReason,
      expectedLeaseId: pendingOverrideRequest.currentHolder.leaseId
    )
  }

  func confirmPendingLifecycleAction() {
    guard canSendCommands, let pendingLifecycleRequest else {
      self.pendingLifecycleRequest = nil
      return
    }
    self.pendingLifecycleRequest = nil
    runLifecycleAction(pendingLifecycleRequest)
  }

  func confirmReleaseLease() {
    guard canSendCommands, let pendingReleaseLeaseRequest else {
      self.pendingReleaseLeaseRequest = nil
      return
    }
    self.pendingReleaseLeaseRequest = nil
    Task {
      do {
        try await releaseLease(pendingReleaseLeaseRequest.lease)
      } catch {
        lastErrorMessage = error.localizedDescription
      }
    }
  }

  func requestGuidedSetup() {
    guard serviceStatusUnverified == false else {
      return
    }
    setupTask?.cancel()
    setupGeneration += 1
    let generation = setupGeneration
    let stopGeneration = storeStopGeneration
    setupPhase = .previewing
    isApplyingAction = true
    lastErrorMessage = nil
    setupTask = Task { [weak self] in
      guard let self else { return }
      defer {
        if generation == setupGeneration {
          isApplyingAction = false
          setupTask = nil
        }
      }
      do {
        let plan = try await loadGuidedSetupPlan()
        try Task.checkCancellation()
        guard generation == setupGeneration, serviceStatusUnverified == false else {
          return
        }
        if plan.status == .blocked {
          setupPlan = plan
          pendingSetupConfirmation = nil
          setupPhase = .awaitingConfirmation
          return
        }
        if plan.confirmation.required {
          setupPlan = plan
          pendingSetupConfirmation = plan.planId
          setupPhase = .awaitingConfirmation
          return
        }
        setupPlan = nil
        pendingSetupConfirmation = nil
        if plan.status == .ready {
          try await requireRefreshAfterMutation(
            preservingGuidedSetup: true,
            expectedSetupGeneration: generation
          )
          try Task.checkCancellation()
          try requireLiveServiceAfterSetupRefresh()
          setupPhase = .idle
          lastErrorMessage = nil
          setActionMessage("Setup complete — brokerd is running and all managed simulators are healthy.")
          return
        }
        try await applyGuidedSetup(plan, expectedSetupGeneration: generation)
      } catch is CancellationError {
        await refreshAfterSetupCancellation(
          expectedSetupGeneration: generation,
          expectedStopGeneration: stopGeneration
        )
        if generation == setupGeneration {
          pendingSetupConfirmation = nil
          setupPlan = nil
          setupPhase = .idle
        }
      } catch {
        _ = await refresh(silent: true, expectedSetupGeneration: generation)
        if generation == setupGeneration {
          setupPhase = setupPlan == nil ? .idle : .awaitingConfirmation
          lastActionMessage = nil
          lastErrorMessage = error.localizedDescription
        }
      }
    }
  }

  func confirmGuidedSetup() {
    guard serviceStatusUnverified == false else {
      if setupPhase == .awaitingConfirmation {
        cancelGuidedSetup()
      }
      return
    }
    guard setupPhase == .awaitingConfirmation,
          let setupPlan,
          pendingSetupConfirmation == setupPlan.planId,
          setupPlan.status != .blocked
    else {
      return
    }
    setupTask?.cancel()
    setupGeneration += 1
    let generation = setupGeneration
    let stopGeneration = storeStopGeneration
    setupPhase = .applying
    isApplyingAction = true
    setupTask = Task { [weak self] in
      guard let self else { return }
      defer {
        if generation == setupGeneration {
          isApplyingAction = false
          setupTask = nil
        }
      }
      do {
        try await applyGuidedSetup(setupPlan, expectedSetupGeneration: generation)
      } catch is CancellationError {
        await refreshAfterSetupCancellation(
          expectedSetupGeneration: generation,
          expectedStopGeneration: stopGeneration
        )
        if generation == setupGeneration {
          pendingSetupConfirmation = nil
          self.setupPlan = nil
          setupPhase = .idle
        }
      } catch {
        _ = await refresh(silent: true, expectedSetupGeneration: generation)
        if generation == setupGeneration {
          setupPhase = .awaitingConfirmation
          lastActionMessage = nil
          lastErrorMessage = error.localizedDescription
        }
      }
    }
  }

  func cancelGuidedSetup() {
    guard setupPhase != .applying else { return }
    setupTask?.cancel()
    setupTask = nil
    pendingSetupConfirmation = nil
    setupPlan = nil
    setupPhase = .idle
    isApplyingAction = false
  }

  @discardableResult
  func stopGuidedSetup() -> Task<Void, Never>? {
    guard setupPhase == .applying else { return nil }
    let task = setupTask
    task?.cancel()
    return task
  }

  func applyIdlePolicy(graceSeconds: Int) async throws {
    guard (60 ... 86_400).contains(graceSeconds) else {
      throw BrokerServiceCommandClientError.transportFailure("Enter a whole number of seconds from 60 through 86400.")
    }
    let request = BrokerCommandRequest(
      command: "enable",
      group: "idle",
      options: [
        "actorId": .string(Self.appHumanActorId),
        "actorType": .string("human"),
        "graceSeconds": .int(graceSeconds),
      ]
    )
    try await executeMutation(
      actionName: "idle-enable",
      successMessage: "Automatic shutdown updated."
    ) { [self, request] in
      _ = try await self.commandClient.send(request)
    }
  }

  func disableIdlePolicy() async throws {
    let request = BrokerCommandRequest(
      command: "disable",
      group: "idle",
      options: [
        "actorId": .string(Self.appHumanActorId),
        "actorType": .string("human"),
      ]
    )
    try await executeMutation(
      actionName: "idle-disable",
      successMessage: "Automatic shutdown disabled."
    ) { [self, request] in
      _ = try await self.commandClient.send(request)
    }
  }

  func requestIdleCleanup() {
    guard canSendCommands, isApplyingAction == false else {
      return
    }
    idleCleanupPreviewGeneration += 1
    let previewGeneration = idleCleanupPreviewGeneration
    isApplyingAction = true
    Task {
      defer { isApplyingAction = false }
      do {
        let response = try await commandClient.send(
          BrokerCommandRequest(command: "cleanup", group: "idle", options: [:])
        )
        guard let eligibleCount = response.eligibleCount,
              let planId = response.planId,
              planId.isEmpty == false
        else {
          throw BrokerServiceCommandClientError.invalidJSONResponse
        }
        guard selectedPane == .overview && previewGeneration == idleCleanupPreviewGeneration else {
          return
        }
        if eligibleCount == 0 {
          pendingIdleCleanupRequest = nil
          lastErrorMessage = nil
          setActionMessage("No idle simulators are eligible right now.")
          return
        }
        pendingIdleCleanupRequest = BrokerPendingIdleCleanupRequest(
          eligibleCount: eligibleCount,
          planId: planId
        )
        lastErrorMessage = nil
      } catch {
        guard selectedPane == .overview && previewGeneration == idleCleanupPreviewGeneration else {
          return
        }
        lastErrorMessage = error.localizedDescription
      }
    }
  }

  func confirmIdleCleanup() {
    guard canSendCommands, let pendingIdleCleanupRequest else {
      self.pendingIdleCleanupRequest = nil
      return
    }
    self.pendingIdleCleanupRequest = nil
    Task {
      do {
        try await applyConfirmedIdleCleanup(pendingIdleCleanupRequest)
      } catch {
        lastErrorMessage = error.localizedDescription
      }
    }
  }

  private func applyConfirmedIdleCleanup(_ cleanup: BrokerPendingIdleCleanupRequest) async throws {
    let request = BrokerCommandRequest(
      command: "cleanup",
      group: "idle",
      options: [
        "actorId": .string(Self.appHumanActorId),
        "actorType": .string("human"),
        "apply": .bool(true),
        "confirmPlanId": .string(cleanup.planId),
      ]
    )
    try await executeMutation(
      actionName: "idle-cleanup",
      successMessage: "Idle cleanup completed. Review the last result below.",
      acceptSuccessfulRefreshRetry: true
    ) { [self, request] in
      _ = try await self.commandClient.send(request)
    }
  }

  func releaseLease(_ lease: BrokerLease) async throws {
    let request = BrokerCommandRequest(
      command: "release",
      group: "lease",
      options: [
        "actorId": .string(Self.appHumanActorId),
        "actorType": .string("human"),
        "leaseId": .string(lease.leaseId),
      ]
    )
    try await executeMutation(
      actionName: "release-lease",
      alias: lease.alias,
      successMessage: "Released lease for \(lease.alias)."
    ) { [self, request] in
      _ = try await self.commandClient.send(request)
    }
  }

  func clearPin(alias: String) async throws {
    let request = BrokerCommandRequest(
      command: "clear",
      group: "pin",
      options: [
        "actorId": .string(Self.appHumanActorId),
        "actorType": .string("human"),
        "alias": .string(alias),
      ]
    )
    try await executeMutation(
      actionName: "clear-pin",
      alias: alias,
      successMessage: "Cleared pin for \(alias)."
    ) { [self, request] in
      _ = try await self.commandClient.send(request)
    }
  }

  func createPin(alias: String, project: BrokerProjectSummary, purpose: BrokerProjectPurposeSummary, note: String) async throws {
    guard let projectFilePath = project.projectFilePath else {
      throw BrokerServiceCommandClientError.transportFailure("The selected project is missing a project file path.")
    }

    var requestOptions: [String: BrokerJSONValue] = [
      "actorId": .string(Self.appHumanActorId),
      "actorType": .string("human"),
      "alias": .string(alias),
      "projectFilePath": .string(projectFilePath),
      "purposeId": .string(purpose.purposeId),
    ]
    let trimmedNote = note.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmedNote.isEmpty == false {
      requestOptions["note"] = .string(trimmedNote)
    }

    let request = BrokerCommandRequest(
      command: "create",
      group: "pin",
      options: requestOptions
    )
    try await executeMutation(
      actionName: "create-pin",
      alias: alias,
      successMessage: "Pinned \(alias) to \(project.projectName) · \(purpose.displayName)."
    ) { [self, request] in
      _ = try await self.commandClient.send(request)
    }
  }

  func performLifecycleAction(
    _ action: BrokerLifecycleAction,
    simulator: BrokerSimulator,
    overrideReason: String? = nil,
    expectedLeaseId: String? = nil
  ) async throws {
    try await performLifecycleAction(
      action,
      alias: simulator.alias,
      overrideReason: overrideReason,
      expectedLeaseId: expectedLeaseId
    )
  }

  func performLifecycleAction(
    _ action: BrokerLifecycleAction,
    alias: String,
    overrideReason: String? = nil,
    expectedLeaseId: String? = nil
  ) async throws {
    var requestOptions: [String: BrokerJSONValue] = [
      "actorId": .string(Self.appHumanActorId),
      "actorType": .string("human"),
      "alias": .string(alias),
    ]

    if let overrideReason {
      requestOptions["expectedAlias"] = .string(alias)
      requestOptions["expectedLeaseId"] = expectedLeaseId.map(BrokerJSONValue.string) ?? .null
      requestOptions["forceOverride"] = .bool(true)
      requestOptions["overrideReason"] = .string(overrideReason)
    }

    let request = BrokerCommandRequest(
      command: action.commandName,
      group: "simulators",
      options: requestOptions
    )
    try await executeMutation(
      actionName: action.commandName,
      alias: alias,
      successMessage: action.successMessage
    ) { [self, request] in
      _ = try await self.commandClient.send(request)
    }
  }

  private func executeMutation(
    actionName: String,
    alias: String? = nil,
    successMessage: String,
    acceptSuccessfulRefreshRetry: Bool = false,
    operation: @escaping @Sendable () async throws -> Void
  ) async throws {
    guard canSendCommands else {
      throw BrokerCommandAuthorityRevokedError()
    }

    logCommandStart(actionName: actionName, alias: alias)
    isApplyingAction = true
    defer {
      isApplyingAction = false
    }

    do {
      try await operation()
    } catch is CancellationError {
      throw CancellationError()
    } catch let error as BrokerServiceCommandError where error.needsOverrideConfirmation {
      logCommandOverrideRequired(actionName: actionName, alias: alias, error: error)
      throw error
    } catch {
      logCommandFailure(actionName: actionName, alias: alias, error: error)
      lastActionMessage = nil
      lastErrorMessage = error.localizedDescription
      throw error
    }

    do {
      try await requireRefreshAfterMutation()
    } catch is CancellationError {
      throw CancellationError()
    } catch {
      if acceptSuccessfulRefreshRetry {
        do {
          try await requireRefreshAfterMutation(silent: true)
          logCommandSuccess(actionName: actionName, alias: alias)
          setActionMessage(successMessage)
          lastErrorMessage = nil
          return
        } catch is CancellationError {
          throw CancellationError()
        } catch {
          // Preserve the first post-commit refresh failure for diagnostics.
        }
      }
      logCommandFailure(actionName: actionName, alias: alias, error: error)
      lastActionMessage = nil
      lastErrorMessage = error.localizedDescription
      throw error
    }

    logCommandSuccess(actionName: actionName, alias: alias)
    setActionMessage(successMessage)
    lastErrorMessage = nil
  }

  @discardableResult
  private func refresh(
    silent: Bool = false,
    preservingGuidedSetup: Bool = false,
    expectedSetupGeneration: Int? = nil,
    expectedStopGeneration: Int? = nil
  ) async -> BrokerRefreshOutcome {
    let lifecycleGeneration = expectedStopGeneration ?? storeStopGeneration
    guard lifecycleGeneration == storeStopGeneration else {
      return .discarded
    }
    if let expectedSetupGeneration, expectedSetupGeneration != setupGeneration {
      return .discarded
    }
    let refreshMode = silent ? "silent" : "manual"
    refreshGeneration += 1
    let generation = refreshGeneration
    if silent == false {
      visibleRefreshCount += 1
      isRefreshing = true
    }
    defer {
      if silent == false, lifecycleGeneration == storeStopGeneration {
        visibleRefreshCount = max(0, visibleRefreshCount - 1)
        isRefreshing = visibleRefreshCount > 0
      }
    }

    logRefreshStart(mode: refreshMode)
    do {
      let refreshedState = try await loader.load()
      guard lifecycleGeneration == storeStopGeneration else {
        completeRefresh(generation: generation, with: .discarded)
        return .discarded
      }
      try Task.checkCancellation()
      if let expectedSetupGeneration, expectedSetupGeneration != setupGeneration {
        completeRefresh(generation: generation, with: .discarded)
        return .discarded
      }
      guard generation == refreshGeneration else {
        let outcome = BrokerRefreshOutcome.superseded(by: refreshGeneration)
        completeRefresh(generation: generation, with: outcome)
        return outcome
      }
      if sameServiceAuthority(loadedState?.service, refreshedState.service) == false
        || loadedState?.serviceRequiresRestart != refreshedState.serviceRequiresRestart
      {
        advanceServiceAuthorityEpoch(preservingGuidedSetup: preservingGuidedSetup)
      }
      loadedState = refreshedState
      serviceStatusUnverified = false
      lastErrorMessage = nil
      synchronizeSelections()
      logRefreshSuccess(mode: refreshMode, snapshot: loadedState?.snapshot)
      completeRefresh(generation: generation, with: .succeeded)
      return .succeeded
    } catch is CancellationError {
      guard lifecycleGeneration == storeStopGeneration else {
        completeRefresh(generation: generation, with: .discarded)
        return .discarded
      }
      if let expectedSetupGeneration, expectedSetupGeneration != setupGeneration {
        completeRefresh(generation: generation, with: .discarded)
        return .discarded
      }
      guard generation == refreshGeneration else {
        let outcome = BrokerRefreshOutcome.superseded(by: refreshGeneration)
        completeRefresh(generation: generation, with: outcome)
        return outcome
      }
      completeRefresh(generation: generation, with: .discarded)
      return .discarded
    } catch {
      guard lifecycleGeneration == storeStopGeneration else {
        completeRefresh(generation: generation, with: .discarded)
        return .discarded
      }
      if let expectedSetupGeneration, expectedSetupGeneration != setupGeneration {
        completeRefresh(generation: generation, with: .discarded)
        return .discarded
      }
      guard generation == refreshGeneration else {
        let outcome = BrokerRefreshOutcome.superseded(by: refreshGeneration)
        completeRefresh(generation: generation, with: outcome)
        return outcome
      }
      if let partialFailure = error as? BrokerSnapshotPartialLoadError,
        partialFailure.recoveredState.service == nil
          || partialFailure.recoveredState.serviceRequiresRestart
      {
        acceptRecoverablePartialState(
          partialFailure.recoveredState,
          preservingGuidedSetup: preservingGuidedSetup
        )
      } else {
        let hostConfigurationCouldAuthorizeService = loadedState?.tooling.hostConfigExists == true
          || FileManager.default.fileExists(atPath: runtimePaths.hostConfigURL.path)
        if let loadedState, hostConfigurationCouldAuthorizeService {
          revokeCachedServiceAuthority(preserving: loadedState)
        } else if loadedState == nil, hostConfigurationCouldAuthorizeService {
          markServiceStatusUnverified()
        }
      }
      logRefreshFailure(mode: refreshMode, error: error)
      lastErrorMessage = error.localizedDescription
      completeRefresh(generation: generation, with: .failed(error))
      return .failed(error)
    }
  }

  private func requireLiveServiceAfterSetupRefresh() throws {
    guard canSendCommands else {
      throw BrokerSetupServiceMissingAfterRefreshError()
    }
  }

  private func requireRefreshAfterMutation(
    silent: Bool = false,
    preservingGuidedSetup: Bool = false,
    expectedSetupGeneration: Int? = nil
  ) async throws {
    try Task.checkCancellation()
    var outcome = await refresh(
      silent: silent,
      preservingGuidedSetup: preservingGuidedSetup,
      expectedSetupGeneration: expectedSetupGeneration
    )
    var followedGenerations: Set<Int> = []

    while true {
      try Task.checkCancellation()
      switch outcome {
      case .discarded:
        throw CancellationError()
      case .succeeded:
        return
      case .superseded(by: let generation):
        guard followedGenerations.insert(generation).inserted else {
          throw BrokerRefreshSupersededError(message: "Snapshot refresh was superseded repeatedly.")
        }
        outcome = await refreshOutcome(for: generation)
      case .failed(let error):
        throw error
      }
    }
  }

  private func completeRefresh(generation: Int, with outcome: BrokerRefreshOutcome) {
    completedRefreshOutcomes[generation] = outcome
    let waiters = refreshOutcomeWaiters.removeValue(forKey: generation) ?? [:]
    for waiter in waiters.values {
      waiter.resume(returning: outcome)
    }
    let retainedGenerations = completedRefreshOutcomes.keys.filter { $0 >= refreshGeneration - 20 }
    completedRefreshOutcomes = Dictionary(uniqueKeysWithValues: retainedGenerations.compactMap { generation in
      guard let outcome = completedRefreshOutcomes[generation] else {
        return nil
      }
      return (generation, outcome)
    })
  }

  private func refreshOutcome(for generation: Int) async -> BrokerRefreshOutcome {
    if let outcome = completedRefreshOutcomes[generation] {
      return outcome
    }

    let waiterId = UUID()
    return await withTaskCancellationHandler {
      await withCheckedContinuation { continuation in
        if Task.isCancelled {
          continuation.resume(returning: .discarded)
        } else if let outcome = completedRefreshOutcomes[generation] {
          continuation.resume(returning: outcome)
        } else {
          refreshOutcomeWaiters[generation, default: [:]][waiterId] = continuation
        }
      }
    } onCancel: {
      Task { @MainActor [weak self] in
        self?.cancelRefreshOutcomeWaiter(generation: generation, waiterId: waiterId)
      }
    }
  }

  private func cancelRefreshOutcomeWaiter(generation: Int, waiterId: UUID) {
    guard let waiter = refreshOutcomeWaiters[generation]?.removeValue(forKey: waiterId) else {
      return
    }
    if refreshOutcomeWaiters[generation]?.isEmpty == true {
      refreshOutcomeWaiters.removeValue(forKey: generation)
    }
    waiter.resume(returning: .discarded)
  }

  private func synchronizeSelections() {
    guard let readModel else {
      // Preserve restored inspection identifiers until a snapshot is available so a
      // later refresh can validate and reselect them instead of discarding scene context.
      return
    }

    normalizeSimulatorFilters(using: readModel)

    let filteredSimulators = readModel.filteredSimulators(using: simulatorFilters)
    if filteredSimulators.isEmpty {
      inspectedSimulatorAlias = nil
    } else if filteredSimulators.contains(where: { $0.alias == inspectedSimulatorAlias }) == false {
      inspectedSimulatorAlias = filteredSimulators.first?.alias
    }

    if readModel.snapshot.projects.isEmpty {
      inspectedProjectId = nil
    } else if readModel.project(projectId: inspectedProjectId) == nil {
      inspectedProjectId = readModel.snapshot.projects.first?.projectId
    }

    if readModel.snapshot.recentEvents.isEmpty {
      inspectedEventId = nil
    } else if readModel.event(eventId: inspectedEventId) == nil {
      inspectedEventId = readModel.snapshot.recentEvents.first?.eventId
    }
  }

  private func normalizeSimulatorFilters(using readModel: BrokerDashboardReadModel) {
    if simulatorActorFilter != BrokerDashboardReadModel.allSelection,
      readModel.actorTypes.contains(simulatorActorFilter) == false
    {
      simulatorActorFilter = BrokerDashboardReadModel.allSelection
    }

    if simulatorProjectFilter != BrokerDashboardReadModel.allSelection,
      readModel.snapshot.projects.contains(where: { $0.projectId == simulatorProjectFilter }) == false
    {
      simulatorProjectFilter = BrokerDashboardReadModel.allSelection
    }

    if simulatorPurposeFilter != BrokerDashboardReadModel.allSelection,
      readModel.purposeIds.contains(simulatorPurposeFilter) == false
    {
      simulatorPurposeFilter = BrokerDashboardReadModel.allSelection
    }
  }

  private var resolvedCLIURL: URL? {
    loadedState?.tooling.cliPath ?? runtimePaths.configuredCLIURL
  }

  private func requireCLIURL() throws -> URL {
    guard let resolvedCLIURL else {
      throw BrokerCLICommandError.missingCLI(URL(fileURLWithPath: cliHintPath))
    }
    return resolvedCLIURL
  }

  private func setActionMessage(_ message: String) {
    feedbackClearTask?.cancel()
    lastActionMessage = message
    feedbackClearTask = Task {
      try? await Task.sleep(for: .seconds(4))
      guard Task.isCancelled == false else {
        return
      }
      lastActionMessage = nil
    }
  }

  private func revokeCachedServiceAuthority(preserving loadedState: BrokerLoadedState) {
    self.loadedState = BrokerLoadedState(
      paths: loadedState.paths,
      tooling: loadedState.tooling,
      service: nil,
      snapshot: loadedState.snapshot,
      serviceRequiresRestart: false
    )
    markServiceStatusUnverified()
  }

  private func markServiceStatusUnverified() {
    advanceServiceAuthorityEpoch()
    serviceStatusUnverified = true
  }

  private func acceptRecoverablePartialState(
    _ recoveredState: BrokerLoadedState,
    preservingGuidedSetup: Bool
  ) {
    if sameServiceAuthority(loadedState?.service, recoveredState.service) == false
      || loadedState?.serviceRequiresRestart != recoveredState.serviceRequiresRestart
    {
      advanceServiceAuthorityEpoch(preservingGuidedSetup: preservingGuidedSetup)
    }
    self.loadedState = BrokerLoadedState(
      paths: recoveredState.paths,
      tooling: recoveredState.tooling,
      service: recoveredState.service,
      snapshot: loadedState?.snapshot,
      serviceRequiresRestart: recoveredState.serviceRequiresRestart
    )
    serviceStatusUnverified = false
    synchronizeSelections()
  }

  private func advanceServiceAuthorityEpoch(preservingGuidedSetup: Bool = false) {
    serviceAuthorityEpoch += 1
    clearPendingMutationAffordances(preservingGuidedSetup: preservingGuidedSetup)
  }

  private func refreshAfterSetupCancellation(
    expectedSetupGeneration: Int,
    expectedStopGeneration: Int
  ) async {
    guard storeStopGeneration == expectedStopGeneration else {
      return
    }

    let recoveryRefreshTask = Task { @MainActor [weak self] in
      guard let self, self.storeStopGeneration == expectedStopGeneration else {
        return
      }
      _ = await self.refresh(
        silent: true,
        preservingGuidedSetup: true,
        expectedSetupGeneration: expectedSetupGeneration,
        expectedStopGeneration: expectedStopGeneration
      )
    }
    await recoveryRefreshTask.value
  }

  private func sameServiceAuthority(
    _ current: BrokerServiceMetadata?,
    _ refreshed: BrokerServiceMetadata?
  ) -> Bool {
    switch (current, refreshed) {
    case (nil, nil):
      return true
    case let (.some(current), .some(refreshed)):
      return current.hostConfigPath == refreshed.hostConfigPath
        && current.pid == refreshed.pid
        && current.runtimeVersion == refreshed.runtimeVersion
        && current.socketPath == refreshed.socketPath
        && current.startedAt == refreshed.startedAt
        && current.stateRoot == refreshed.stateRoot
        && current.transport == refreshed.transport
    default:
      return false
    }
  }

  private func clearPendingMutationAffordances(preservingGuidedSetup: Bool = false) {
    idleCleanupPreviewGeneration += 1
    pendingIdleCleanupRequest = nil
    clearPendingSimulatorPrompts()
    if preservingGuidedSetup == false,
      setupPhase == .previewing || setupPhase == .awaitingConfirmation
    {
      cancelGuidedSetup()
    }
  }

  private func clearPendingSimulatorPrompts() {
    pendingClearPinRequest = nil
    pendingCreatePinRequest = nil
    pendingLifecycleRequest = nil
    pendingOverrideRequest = nil
    pendingReleaseLeaseRequest = nil
  }

  private func canPresentSimulatorPrompt(for alias: String) -> Bool {
    selectedPane == .simulators && inspectedSimulatorAlias == alias
  }

  private func applyInitialSelection(_ initialSelection: BrokerInitialSelection) {
    selectedPane = initialSelection.pane
    inspectedSimulatorAlias = initialSelection.simulatorAlias
    inspectedProjectId = initialSelection.projectId
    inspectedEventId = initialSelection.eventId
  }

  private func lifecycleActionIsEnabled(_ action: BrokerLifecycleAction) -> Bool {
    switch action {
    case .boot:
      return commandAvailability.canBootSimulator
    case .shutdown:
      return commandAvailability.canShutdownSimulator
    case .erase:
      return commandAvailability.canEraseSimulator
    case .repair:
      return commandAvailability.canRepairSimulator
    }
  }

  private func runLifecycleAction(
    _ request: BrokerPendingLifecycleRequest,
    overrideReason: String? = nil,
    expectedLeaseId: String? = nil
  ) {
    let authorityEpoch = serviceAuthorityEpoch
    Task {
      do {
        try await performLifecycleAction(
          request.action,
          alias: request.alias,
          overrideReason: overrideReason,
          expectedLeaseId: expectedLeaseId
        )
      } catch let error as BrokerServiceCommandError {
        if let overrideRequest = error.overrideRequest(for: request.action, alias: request.alias),
          authorityEpoch == serviceAuthorityEpoch,
          canSendCommands,
          canPresentSimulatorPrompt(for: request.alias)
        {
          pendingOverrideRequest = overrideRequest
        } else {
          lastErrorMessage = error.localizedDescription
        }
      } catch {
        lastErrorMessage = error.localizedDescription
      }
    }
  }

  private func runSetupStep<Result>(
    name: String,
    successDetail: (Result) -> String = { _ in "ok" },
    operation: @escaping @Sendable () async throws -> Result
  ) async throws -> Result {
    BrokerLogger.setup.info("Setup step started name=\(name, privacy: .public)")
    do {
      let result = try await operation()
      let detail = successDetail(result)
      BrokerLogger.setup.info(
        "Setup step succeeded name=\(name, privacy: .public) result=\(detail, privacy: .public)"
      )
      return result
    } catch {
      let summary = BrokerLogger.summary(for: error)
      BrokerLogger.setup.error(
        "Setup step failed name=\(name, privacy: .public) summary=\(summary, privacy: .public)"
      )
      throw error
    }
  }

  private func guidedSetupPathArguments() -> [String] {
    var arguments = [
      "--host-config",
      hostConfigPath,
      "--state-root",
      stateRootPath,
    ]
    if let serviceSocketURL = runtimePaths.serviceSocketURL {
      arguments += ["--service-socket", serviceSocketURL.path]
    }
    return arguments
  }

  private func loadGuidedSetupPlan() async throws -> BrokerSetupPlan {
    let cliURL = try requireCLIURL()
    let response = try await runSetupStep(name: "guided-setup-preview") {
      try await self.localCommandRunner.run(
        cliPath: cliURL,
        arguments: ["setup", "--json"] + self.guidedSetupPathArguments()
      )
    }
    guard let plan = response.setupPlan else {
      throw BrokerCLICommandError.invalidJSONResponse(cliURL)
    }
    guard plan.schemaVersion == BrokerSetupPlan.supportedSchemaVersion else {
      throw BrokerCLICommandError.invalidJSONResponse(cliURL)
    }
    return plan
  }

  private func applyGuidedSetup(
    _ plan: BrokerSetupPlan,
    expectedSetupGeneration: Int
  ) async throws {
    let cliURL = try requireCLIURL()
    setupPhase = .applying
    var arguments = [
      "setup",
      "--apply",
      "--confirm",
      plan.planId,
    ]
    if plan.host.configured == false, let hostId = plan.host.hostId {
      arguments += ["--host-id", hostId]
    }
    if let runtime = plan.runtime {
      arguments += ["--ios-version", runtime.version]
    }
    arguments += ["--json"] + guidedSetupPathArguments()
    let commandArguments = arguments

    let response = try await runSetupStep(name: "guided-setup-apply") {
      try await self.localCommandRunner.run(cliPath: cliURL, arguments: commandArguments)
    }
    try Task.checkCancellation()
    guard response.status == "ready" else {
      throw BrokerCLICommandError.invalidJSONResponse(cliURL)
    }
    try await requireRefreshAfterMutation(
      preservingGuidedSetup: true,
      expectedSetupGeneration: expectedSetupGeneration
    )
    try requireLiveServiceAfterSetupRefresh()
    setupPlan = nil
    pendingSetupConfirmation = nil
    setupPhase = .idle
    lastErrorMessage = nil
    setActionMessage("Setup complete — brokerd is running and all managed simulators are healthy.")
  }

  private func logCommandStart(actionName: String, alias: String?) {
    if let alias {
      BrokerLogger.commands.info(
        "Command started action=\(actionName, privacy: .public) alias=\(alias, privacy: .public)"
      )
      return
    }

    BrokerLogger.commands.info("Command started action=\(actionName, privacy: .public)")
  }

  private func logCommandSuccess(actionName: String, alias: String?) {
    if let alias {
      BrokerLogger.commands.info(
        "Command succeeded action=\(actionName, privacy: .public) alias=\(alias, privacy: .public)"
      )
      return
    }

    BrokerLogger.commands.info("Command succeeded action=\(actionName, privacy: .public)")
  }

  private func logCommandFailure(actionName: String, alias: String?, error: any Error) {
    let summary = BrokerLogger.summary(for: error)
    if let alias {
      BrokerLogger.commands.error(
        "Command failed action=\(actionName, privacy: .public) alias=\(alias, privacy: .public) summary=\(summary, privacy: .public)"
      )
      return
    }

    BrokerLogger.commands.error(
      "Command failed action=\(actionName, privacy: .public) summary=\(summary, privacy: .public)"
    )
  }

  private func logCommandOverrideRequired(actionName: String, alias: String?, error: BrokerServiceCommandError) {
    let reasonCode = error.reasonCode ?? "override-required"
    if let alias {
      BrokerLogger.commands.warning(
        "Command override required action=\(actionName, privacy: .public) alias=\(alias, privacy: .public) reasonCode=\(reasonCode, privacy: .public)"
      )
      return
    }

    BrokerLogger.commands.warning(
      "Command override required action=\(actionName, privacy: .public) reasonCode=\(reasonCode, privacy: .public)"
    )
  }

  private func logRefreshStart(mode: String) {
    let logger = mode == "silent" ? BrokerLogger.refresh : BrokerLogger.refresh
    if mode == "silent" {
      logger.debug("Refresh started mode=\(mode, privacy: .public)")
    } else {
      logger.info("Refresh started mode=\(mode, privacy: .public)")
    }
  }

  private func logRefreshSuccess(mode: String, snapshot: BrokerAppSnapshot?) {
    let generatedAt = snapshot?.generatedAt ?? "none"
    if mode == "silent" {
      BrokerLogger.refresh.debug(
        "Refresh succeeded mode=\(mode, privacy: .public) snapshotGeneratedAt=\(generatedAt, privacy: .public)"
      )
    } else {
      BrokerLogger.refresh.info(
        "Refresh succeeded mode=\(mode, privacy: .public) snapshotGeneratedAt=\(generatedAt, privacy: .public)"
      )
    }
  }

  private func logRefreshFailure(mode: String, error: any Error) {
    let summary = BrokerLogger.summary(for: error)
    BrokerLogger.refresh.error(
      "Refresh failed mode=\(mode, privacy: .public) summary=\(summary, privacy: .public)"
    )
  }
}
