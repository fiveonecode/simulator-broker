import SwiftUI

struct RootView: View {
  @Bindable var store: BrokerDashboardStore

  var body: some View {
    NavigationSplitView {
      navigationList
    } detail: {
      detailContent
    }
    .toolbar {
      toolbarContent
    }
    .focusedSceneValue(\.brokerDashboardStore, store)
    .focusedSceneValue(\.brokerSelectedPane, $store.selectedPane)
    .focusedSceneValue(\.brokerSelectedSimulatorAlias, $store.inspectedSimulatorAlias)
    .focusedSceneValue(\.brokerCommandAvailability, store.commandAvailability)
    .sheet(item: $store.setupPlan, onDismiss: store.cancelGuidedSetup) { plan in
      SetupPlanSheet(
        errorMessage: store.lastErrorMessage,
        onCancel: store.cancelGuidedSetup,
        onConfirm: store.confirmGuidedSetup,
        onStop: store.stopGuidedSetup,
        phase: store.setupPhase,
        plan: plan
      )
    }
  }

  private var navigationList: some View {
    List(BrokerNavigationPane.allCases, selection: $store.selectedPane) { pane in
      Label(pane.title, systemImage: pane.symbolName)
        .tag(pane)
    }
    .navigationSplitViewColumnWidth(min: 180, ideal: 220)
  }

  private var detailContent: some View {
    VStack(spacing: 0) {
      if hasStatusMessages {
        VStack(alignment: .leading, spacing: 12) {
          statusMessages
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 20)
        .padding(.top, 16)
        .padding(.bottom, 12)
      }

      dashboardContent
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .navigationTitle(store.selectedPane.title)
  }

  private var hasStatusMessages: Bool {
    store.lastActionMessage != nil
      || (store.lastErrorMessage != nil && store.snapshot != nil)
      || store.startupState == .readOnlySnapshot
      || store.isAutomaticSetupInProgress
  }

  @ViewBuilder
  private var dashboardContent: some View {
    Group {
      if store.snapshot == nil {
        BrokerSetupView(store: store)
      } else {
        selectedScreen
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  @ViewBuilder
  private var selectedScreen: some View {
    switch store.selectedPane {
    case .overview:
      OverviewScreen(store: store)
    case .simulators:
      SimulatorsScreen(store: store)
    case .projects:
      ProjectsScreen(store: store)
    case .events:
      EventsScreen(store: store)
    }
  }

  @ToolbarContentBuilder
  private var toolbarContent: some ToolbarContent {
    ToolbarItem(placement: .status) {
      HStack(spacing: 16) {
        ToolbarStatusLabel(
          color: connectionTint(store.commandStatusText),
          symbolName: commandStatusSymbolName,
          title: store.commandStatusText
        )
        ToolbarStatusLabel(
          color: .secondary,
          symbolName: "clock",
          title: store.generatedAtText
        )
      }
    }

    ToolbarItem(placement: .primaryAction) {
      Button {
        store.refreshNow()
      } label: {
        if store.isRefreshing {
          HStack(spacing: 6) {
            ProgressView()
              .controlSize(.small)
            Text("Refreshing")
          }
        } else {
          Label("Refresh", systemImage: "arrow.clockwise")
        }
      }
      .disabled(store.isApplyingAction || store.isRefreshing)
    }
  }

  private var commandStatusSymbolName: String {
    switch store.startupState {
    case .ready:
      return "bolt.horizontal.circle.fill"
    case .readOnlySnapshot:
      return "tray.full"
    case .needsSnapshotRefresh:
      return "arrow.clockwise.circle"
    case .needsServiceStart:
      return "bolt.slash.fill"
    case .missingCLI, .needsHostBootstrap:
      return "wrench.and.screwdriver.fill"
    }
  }

  private func resumeGuidedSetup() {
    store.requestGuidedSetup()
  }

  @ViewBuilder
  private var statusMessages: some View {
    automaticSetupProgressCard
    actionMessageCard
    errorMessageCard
    readOnlySnapshotMessageCard
  }

  @ViewBuilder
  private var automaticSetupProgressCard: some View {
    if store.isAutomaticSetupInProgress {
      StatusMessageCard(
        color: .blue,
        message: "Finishing setup: starting brokerd, refreshing the snapshot, and verifying Simulator health.",
        symbolName: "gearshape.2",
        actionTitle: store.setupPhase == .applying ? "Stop" : nil,
        onAction: store.setupPhase == .applying ? { store.stopGuidedSetup() } : nil
      )
    }
  }

  @ViewBuilder
  private var actionMessageCard: some View {
    if let message = store.lastActionMessage {
      StatusMessageCard(
        color: .green,
        message: message,
        symbolName: "checkmark.circle.fill",
        onDismiss: store.clearFeedback
      )
    }
  }

  @ViewBuilder
  private var errorMessageCard: some View {
    if let errorMessage = store.lastErrorMessage, store.snapshot != nil {
      StatusMessageCard(
        color: .red,
        message: errorMessage,
        symbolName: "exclamationmark.triangle.fill",
        onDismiss: store.clearFeedback
      )
    }
  }

  @ViewBuilder
  private var readOnlySnapshotMessageCard: some View {
    if store.startupState == .readOnlySnapshot {
      if store.canOfferReadOnlyFinishSetup {
        StatusMessageCard(
          color: .orange,
          message: "Broker commands are disabled because brokerd is not running. Start the service to enable pinning, release, and lifecycle actions.",
          symbolName: "bolt.slash.fill",
          actionTitle: "Finish setup",
          onAction: resumeGuidedSetup,
          onDismiss: nil
        )
      } else {
        StatusMessageCard(
          color: .orange,
          message: "Broker commands are disabled because brokerd is not running. Start the service to enable pinning, release, and lifecycle actions.",
          symbolName: "bolt.slash.fill",
          onDismiss: nil
        )
      }
    }
  }
}
