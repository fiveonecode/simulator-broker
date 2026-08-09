import SwiftUI

struct BrokerDashboardCommands: Commands {
  @FocusedValue(\.brokerCommandAvailability) private var availability
  @FocusedValue(\.brokerDashboardStore) private var store
  @FocusedBinding(\.brokerSelectedPane) private var selectedPane
  @FocusedBinding(\.brokerSelectedSimulatorAlias) private var selectedSimulatorAlias

  private var commandAvailability: BrokerDashboardCommandAvailability {
    availability ?? .unavailable
  }

  private var allowsSimulatorScopedCommands: Bool {
    brokerAllowsSimulatorScopedCommands(
      selectedPane: selectedPane,
      selectedSimulatorAlias: selectedSimulatorAlias ?? nil
    )
  }

  var body: some Commands {
    CommandGroup(after: .sidebar) {
      Button("Show Overview") {
        selectedPane = .overview
      }
      .keyboardShortcut("1", modifiers: [.command])
      .disabled(selectedPane == nil)

      Button("Show Simulators") {
        selectedPane = .simulators
      }
      .keyboardShortcut("2", modifiers: [.command])
      .disabled(selectedPane == nil)

      Button("Show Projects") {
        selectedPane = .projects
      }
      .keyboardShortcut("3", modifiers: [.command])
      .disabled(selectedPane == nil)

      Button("Show Events") {
        selectedPane = .events
      }
      .keyboardShortcut("4", modifiers: [.command])
      .disabled(selectedPane == nil)
    }

    CommandMenu("Broker") {
      Button("Refresh Snapshot") {
        store?.refreshNow()
      }
      .keyboardShortcut("r", modifiers: [.command])
      .disabled(commandAvailability.canRefreshSnapshot == false)

      Divider()

      Button("Boot Simulator") {
        store?.requestLifecycleAction(.boot)
      }
      .disabled(allowsSimulatorScopedCommands == false || commandAvailability.canBootSimulator == false)

      Button("Shutdown Simulator") {
        store?.requestLifecycleAction(.shutdown)
      }
      .disabled(allowsSimulatorScopedCommands == false || commandAvailability.canShutdownSimulator == false)

      Button("Erase Simulator") {
        store?.requestLifecycleAction(.erase)
      }
      .disabled(allowsSimulatorScopedCommands == false || commandAvailability.canEraseSimulator == false)

      Button("Repair Simulator") {
        store?.requestLifecycleAction(.repair)
      }
      .disabled(allowsSimulatorScopedCommands == false || commandAvailability.canRepairSimulator == false)

      Divider()

      Button("Release Lease") {
        store?.requestReleaseLease()
      }
      .disabled(allowsSimulatorScopedCommands == false || commandAvailability.canReleaseLease == false)

      Button("Create Pin") {
        store?.requestCreatePin()
      }
      .disabled(allowsSimulatorScopedCommands == false || commandAvailability.canCreatePin == false)

      Button("Clear Pin") {
        store?.requestClearPin()
      }
      .disabled(allowsSimulatorScopedCommands == false || commandAvailability.canClearPin == false)
    }
  }
}
