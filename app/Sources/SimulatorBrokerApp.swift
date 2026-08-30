import SwiftUI

@main
struct SimulatorBrokerApp: App {
  private let launchContext: BrokerLaunchContext

  init() {
    let launchContext = BrokerLaunchContext.fromLaunchContext()
    self.launchContext = launchContext
    BrokerLogger.appLifecycle.info(
      "App launch prepared stateRoot=\(launchContext.runtimePaths.stateRoot.path, privacy: .public)"
    )
  }

  var body: some Scene {
    WindowGroup {
      BrokerDashboardWindowRoot(launchContext: launchContext)
    }
    .defaultSize(width: 1200, height: 760)
    .commands {
      BrokerDashboardCommands()
    }
  }
}

private struct BrokerDashboardWindowRoot: View {
  @State private var hasBootstrappedSceneRestoration = false
  @State private var store: BrokerDashboardStore
  @SceneStorage(BrokerSceneStorageKey.selectedPane) private var storedSelectedPane = BrokerNavigationPane.overview.rawValue
  @SceneStorage(BrokerSceneStorageKey.inspectedSimulatorAlias) private var storedInspectedSimulatorAlias: String?
  @SceneStorage(BrokerSceneStorageKey.inspectedProjectId) private var storedInspectedProjectId: String?
  @SceneStorage(BrokerSceneStorageKey.inspectedEventId) private var storedInspectedEventId: String?
  @SceneStorage(BrokerSceneStorageKey.simulatorSearchText) private var storedSimulatorSearchText = ""
  @SceneStorage(BrokerSceneStorageKey.simulatorActorFilter) private var storedSimulatorActorFilter = BrokerDashboardReadModel.allSelection
  @SceneStorage(BrokerSceneStorageKey.simulatorHealthFilter) private var storedSimulatorHealthFilter = BrokerHealthFilter.all.rawValue
  @SceneStorage(BrokerSceneStorageKey.simulatorProjectFilter) private var storedSimulatorProjectFilter = BrokerDashboardReadModel.allSelection
  @SceneStorage(BrokerSceneStorageKey.simulatorPurposeFilter) private var storedSimulatorPurposeFilter = BrokerDashboardReadModel.allSelection

  init(launchContext: BrokerLaunchContext) {
    _store = State(initialValue: BrokerDashboardStore(launchContext: launchContext))
  }

  var body: some View {
    GeometryReader { proxy in
      RootView(store: store, viewportHeight: proxy.size.height)
    }
      .frame(minWidth: 1200, minHeight: 760)
      .task {
        bootstrapSceneRestorationIfNeeded()
        store.start()
      }
      .onChange(of: store.sceneRestorationState) { _, newValue in
        guard hasBootstrappedSceneRestoration else {
          return
        }
        persistSceneRestorationState(newValue)
      }
      .onDisappear {
        store.stop()
      }
  }

  private func bootstrapSceneRestorationIfNeeded() {
    guard hasBootstrappedSceneRestoration == false else {
      return
    }

    store.applySceneRestorationState(
      BrokerSceneRestorationState(
        selectedPaneRawValue: storedSelectedPane,
        inspectedSimulatorAlias: storedInspectedSimulatorAlias,
        inspectedProjectId: storedInspectedProjectId,
        inspectedEventId: storedInspectedEventId,
        simulatorSearchText: storedSimulatorSearchText,
        simulatorActorFilter: storedSimulatorActorFilter,
        simulatorHealthFilterRawValue: storedSimulatorHealthFilter,
        simulatorProjectFilter: storedSimulatorProjectFilter,
        simulatorPurposeFilter: storedSimulatorPurposeFilter
      )
    )
    persistSceneRestorationState(store.sceneRestorationState)
    hasBootstrappedSceneRestoration = true
  }

  private func persistSceneRestorationState(_ state: BrokerSceneRestorationState) {
    storedSelectedPane = state.selectedPane.rawValue
    storedInspectedSimulatorAlias = state.inspectedSimulatorAlias
    storedInspectedProjectId = state.inspectedProjectId
    storedInspectedEventId = state.inspectedEventId
    storedSimulatorSearchText = state.simulatorSearchText
    storedSimulatorActorFilter = state.simulatorActorFilter
    storedSimulatorHealthFilter = state.simulatorHealthFilter.rawValue
    storedSimulatorProjectFilter = state.simulatorProjectFilter
    storedSimulatorPurposeFilter = state.simulatorPurposeFilter
  }
}
