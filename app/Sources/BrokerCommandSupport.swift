import SwiftUI

struct BrokerDashboardCommandAvailability: Equatable {
  let canRefreshSnapshot: Bool
  let canBootSimulator: Bool
  let canShutdownSimulator: Bool
  let canEraseSimulator: Bool
  let canRepairSimulator: Bool
  let canReleaseLease: Bool
  let canCreatePin: Bool
  let canClearPin: Bool

  static let unavailable = Self(
    canRefreshSnapshot: false,
    canBootSimulator: false,
    canShutdownSimulator: false,
    canEraseSimulator: false,
    canRepairSimulator: false,
    canReleaseLease: false,
    canCreatePin: false,
    canClearPin: false
  )
}

struct BrokerPendingClearPinRequest: Identifiable {
  let alias: String

  var id: String { alias }
}

struct BrokerPendingCreatePinRequest: Identifiable {
  let alias: String

  var id: String { alias }
}

struct BrokerPendingLifecycleRequest: Identifiable {
  let action: BrokerLifecycleAction
  let alias: String

  var id: String { "\(action.rawValue):\(alias)" }
}

struct BrokerPendingLeaseReleaseRequest: Identifiable {
  let lease: BrokerLease

  var id: String { lease.leaseId }
}

struct BrokerPendingIdleCleanupRequest: Identifiable {
  let eligibleCount: Int
  let planId: String

  var id: String { planId }
}

private struct BrokerDashboardStoreFocusedKey: FocusedValueKey {
  typealias Value = BrokerDashboardStore
}

private struct BrokerSelectedPaneFocusedKey: FocusedValueKey {
  typealias Value = Binding<BrokerNavigationPane>
}

private struct BrokerSelectedSimulatorAliasFocusedKey: FocusedValueKey {
  typealias Value = Binding<String?>
}

private struct BrokerCommandAvailabilityFocusedKey: FocusedValueKey {
  typealias Value = BrokerDashboardCommandAvailability
}

extension FocusedValues {
  var brokerCommandAvailability: BrokerDashboardCommandAvailability? {
    get { self[BrokerCommandAvailabilityFocusedKey.self] }
    set { self[BrokerCommandAvailabilityFocusedKey.self] = newValue }
  }

  var brokerDashboardStore: BrokerDashboardStore? {
    get { self[BrokerDashboardStoreFocusedKey.self] }
    set { self[BrokerDashboardStoreFocusedKey.self] = newValue }
  }

  var brokerSelectedPane: Binding<BrokerNavigationPane>? {
    get { self[BrokerSelectedPaneFocusedKey.self] }
    set { self[BrokerSelectedPaneFocusedKey.self] = newValue }
  }

  var brokerSelectedSimulatorAlias: Binding<String?>? {
    get { self[BrokerSelectedSimulatorAliasFocusedKey.self] }
    set { self[BrokerSelectedSimulatorAliasFocusedKey.self] = newValue }
  }
}

func brokerAllowsSimulatorScopedCommands(
  selectedPane: BrokerNavigationPane?,
  selectedSimulatorAlias: String?
) -> Bool {
  guard selectedPane == .simulators, let selectedSimulatorAlias else {
    return false
  }

  return selectedSimulatorAlias.isEmpty == false
}
