import Foundation

enum BrokerSceneStorageKey {
  static let inspectedEventId = "broker.inspected-event-id"
  static let inspectedProjectId = "broker.inspected-project-id"
  static let inspectedSimulatorAlias = "broker.inspected-simulator-alias"
  static let selectedPane = "broker.selected-pane"
  static let simulatorActorFilter = "broker.simulator-actor-filter"
  static let simulatorHealthFilter = "broker.simulator-health-filter"
  static let simulatorProjectFilter = "broker.simulator-project-filter"
  static let simulatorPurposeFilter = "broker.simulator-purpose-filter"
  static let simulatorSearchText = "broker.simulator-search-text"
}

struct BrokerSceneRestorationState: Equatable {
  var selectedPane: BrokerNavigationPane = .overview
  var inspectedSimulatorAlias: String?
  var inspectedProjectId: String?
  var inspectedEventId: String?
  var simulatorSearchText = ""
  var simulatorActorFilter = BrokerDashboardReadModel.allSelection
  var simulatorHealthFilter: BrokerHealthFilter = .all
  var simulatorProjectFilter = BrokerDashboardReadModel.allSelection
  var simulatorPurposeFilter = BrokerDashboardReadModel.allSelection

  init(
    selectedPane: BrokerNavigationPane = .overview,
    inspectedSimulatorAlias: String? = nil,
    inspectedProjectId: String? = nil,
    inspectedEventId: String? = nil,
    simulatorSearchText: String = "",
    simulatorActorFilter: String = BrokerDashboardReadModel.allSelection,
    simulatorHealthFilter: BrokerHealthFilter = .all,
    simulatorProjectFilter: String = BrokerDashboardReadModel.allSelection,
    simulatorPurposeFilter: String = BrokerDashboardReadModel.allSelection
  ) {
    self.selectedPane = selectedPane
    self.inspectedSimulatorAlias = inspectedSimulatorAlias
    self.inspectedProjectId = inspectedProjectId
    self.inspectedEventId = inspectedEventId
    self.simulatorSearchText = simulatorSearchText
    self.simulatorActorFilter = simulatorActorFilter
    self.simulatorHealthFilter = simulatorHealthFilter
    self.simulatorProjectFilter = simulatorProjectFilter
    self.simulatorPurposeFilter = simulatorPurposeFilter
  }

  init(
    selectedPaneRawValue: String?,
    inspectedSimulatorAlias: String?,
    inspectedProjectId: String?,
    inspectedEventId: String?,
    simulatorSearchText: String?,
    simulatorActorFilter: String?,
    simulatorHealthFilterRawValue: String?,
    simulatorProjectFilter: String?,
    simulatorPurposeFilter: String?
  ) {
    self.init(
      selectedPane: BrokerNavigationPane(rawValue: selectedPaneRawValue ?? "") ?? .overview,
      inspectedSimulatorAlias: Self.normalizedOptionalString(inspectedSimulatorAlias),
      inspectedProjectId: Self.normalizedOptionalString(inspectedProjectId),
      inspectedEventId: Self.normalizedOptionalString(inspectedEventId),
      simulatorSearchText: simulatorSearchText ?? "",
      simulatorActorFilter: Self.normalizedFilterSelection(simulatorActorFilter),
      simulatorHealthFilter: BrokerHealthFilter(rawValue: simulatorHealthFilterRawValue ?? "") ?? .all,
      simulatorProjectFilter: Self.normalizedFilterSelection(simulatorProjectFilter),
      simulatorPurposeFilter: Self.normalizedFilterSelection(simulatorPurposeFilter)
    )
  }

  func applying(initialSelection: BrokerInitialSelection) -> BrokerSceneRestorationState {
    var resolved = self

    if initialSelection.hasExplicitDeepLink {
      resolved.selectedPane = initialSelection.pane
    }

    if initialSelection.hasExplicitSimulatorAlias {
      resolved.inspectedSimulatorAlias = initialSelection.simulatorAlias
      resolved.simulatorSearchText = ""
      resolved.simulatorActorFilter = BrokerDashboardReadModel.allSelection
      resolved.simulatorHealthFilter = .all
      resolved.simulatorProjectFilter = BrokerDashboardReadModel.allSelection
      resolved.simulatorPurposeFilter = BrokerDashboardReadModel.allSelection
    }

    if initialSelection.hasExplicitProjectId {
      resolved.inspectedProjectId = initialSelection.projectId
    }

    if initialSelection.hasExplicitEventId {
      resolved.inspectedEventId = initialSelection.eventId
    }

    return resolved
  }

  private static func normalizedFilterSelection(_ value: String?) -> String {
    guard let value, value.isEmpty == false else {
      return BrokerDashboardReadModel.allSelection
    }
    return value
  }

  private static func normalizedOptionalString(_ value: String?) -> String? {
    guard let value, value.isEmpty == false else {
      return nil
    }
    return value
  }
}
