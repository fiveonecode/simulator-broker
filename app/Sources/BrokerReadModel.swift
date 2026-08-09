import Foundation

enum BrokerHealthFilter: String, CaseIterable, Identifiable {
  case all
  case healthy
  case drift
  case unhealthy

  var id: String { rawValue }

  var title: String {
    switch self {
    case .all:
      return "All health"
    case .healthy:
      return "Healthy"
    case .drift:
      return "State drift"
    case .unhealthy:
      return "Repair needed"
    }
  }
}

struct BrokerSimulatorFilters: Equatable {
  var actorType: String = BrokerDashboardReadModel.allSelection
  var health: BrokerHealthFilter = .all
  var projectId: String = BrokerDashboardReadModel.allSelection
  var purposeId: String = BrokerDashboardReadModel.allSelection
  var searchText: String = ""
}

struct BrokerDashboardReadModel {
  static let allSelection = "__all__"

  let snapshot: BrokerAppSnapshot

  var leaseReadyAliasCount: Int {
    snapshot.simulators.filter { simulator in
      simulator.activeLeaseSummary == nil
        && simulator.pin == nil
        && simulator.health != "repair-needed"
        && simulator.health != "repairing"
    }.count
  }

  var actorTypes: [String] {
    Array(Set(snapshot.activeLeases.map(\.actorType) + snapshot.pins.map(\.actorType))).sorted()
  }

  var bootedAliasCount: Int {
    snapshot.simulators.filter { $0.powerState == "booted" }.count
  }

  var driftedSimulators: [BrokerSimulator] {
    snapshot.simulators.filter { $0.health == "state-drift" }
  }

  var purposeIds: [String] {
    Array(
      Set(
        snapshot.projects.flatMap(\.purposes).map(\.purposeId)
        + snapshot.activeLeases.map(\.purposeId)
        + snapshot.pins.compactMap(\.purposeId)
      )
    ).sorted()
  }

  var repairNeededSimulators: [BrokerSimulator] {
    snapshot.simulators.filter { simulator in
      simulator.health == "repair-needed" || simulator.health == "repairing"
    }
  }

  var pinnableProjects: [BrokerProjectSummary] {
    snapshot.projects.filter { project in
      project.projectFilePath != nil && project.repoRoot != nil
    }
  }

  func simulator(alias: String?) -> BrokerSimulator? {
    guard let alias else {
      return nil
    }
    return snapshot.simulators.first { $0.alias == alias }
  }

  func lease(for alias: String?) -> BrokerLease? {
    guard let alias else {
      return nil
    }
    return snapshot.activeLeases.first { $0.alias == alias }
  }

  func project(projectId: String?) -> BrokerProjectSummary? {
    guard let projectId else {
      return nil
    }
    return snapshot.projects.first { $0.projectId == projectId }
  }

  func event(eventId: String?) -> BrokerEvent? {
    guard let eventId else {
      return nil
    }
    return snapshot.recentEvents.first { $0.eventId == eventId }
  }

  func pin(for alias: String?) -> BrokerPin? {
    guard let alias else {
      return nil
    }
    return snapshot.pins.first { $0.alias == alias }
  }

  func eligiblePinProjects(for simulator: BrokerSimulator) -> [BrokerProjectSummary] {
    pinnableProjects.filter { project in
      eligiblePinPurposes(for: simulator, projectId: project.projectId).isEmpty == false
    }
  }

  func eligiblePinPurposes(for simulator: BrokerSimulator, projectId: String?) -> [BrokerProjectPurposeSummary] {
    guard let project = project(projectId: projectId) else {
      return []
    }

    return project.purposes.filter { purpose in
      purposeMatches(simulator: simulator, purpose: purpose)
    }
  }

  func filteredSimulators(using filters: BrokerSimulatorFilters) -> [BrokerSimulator] {
    let normalizedQuery = filters.searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let pinByAlias = Dictionary(uniqueKeysWithValues: snapshot.pins.map { ($0.alias, $0) })
    let projectNameById = Dictionary(uniqueKeysWithValues: snapshot.projects.map { ($0.projectId, $0.projectName) })

    return snapshot.simulators
      .filter { simulator in
      if filters.health != .all {
        switch filters.health {
        case .all:
          break
        case .healthy:
          guard simulator.health == "healthy" else { return false }
        case .drift:
          guard simulator.health == "state-drift" else { return false }
        case .unhealthy:
          guard simulator.health == "repair-needed" || simulator.health == "repairing" else { return false }
        }
      }

      if filters.actorType != Self.allSelection {
        let matchedActorType = simulator.activeLeaseSummary?.actorType ?? pinByAlias[simulator.alias]?.actorType
        guard matchedActorType == filters.actorType else { return false }
      }

      if filters.projectId != Self.allSelection {
        let matchedProjectId = simulator.activeLeaseSummary?.projectId ?? simulator.pin?.projectId
        guard matchedProjectId == filters.projectId else { return false }
      }

      if filters.purposeId != Self.allSelection {
        let matchedPurposeId = simulator.activeLeaseSummary?.purposeId ?? simulator.pin?.purposeId
        guard matchedPurposeId == filters.purposeId else { return false }
      }

      if normalizedQuery.isEmpty {
        return true
      }

      let searchableParts = [
        simulator.alias,
        simulator.displayName,
        simulator.deviceFamily,
        simulator.iosVersion,
        simulator.health,
        simulator.powerState,
        simulator.driftReason ?? "",
        simulator.activeLeaseSummary?.actorId ?? "",
        simulator.activeLeaseSummary?.actorType ?? "",
        pinByAlias[simulator.alias]?.actorId ?? "",
        pinByAlias[simulator.alias]?.actorType ?? "",
        simulator.activeLeaseSummary?.projectId ?? "",
        projectNameById[simulator.activeLeaseSummary?.projectId ?? ""] ?? "",
        simulator.activeLeaseSummary?.purposeId ?? "",
        simulator.pin?.projectId ?? "",
        projectNameById[simulator.pin?.projectId ?? ""] ?? "",
        simulator.pin?.purposeId ?? "",
      ].map { $0.lowercased() }

      return searchableParts.contains { $0.contains(normalizedQuery) }
      }
      .sorted(by: simulatorSortOrder)
  }

  private func purposeMatches(simulator: BrokerSimulator, purpose: BrokerProjectPurposeSummary) -> Bool {
    guard let capability = purpose.capability else {
      return false
    }
    guard simulator.capabilities.contains(capability) else {
      return false
    }
    if let requiredFamily = purpose.requires?.deviceFamily, simulator.deviceFamily != requiredFamily {
      return false
    }
    if let requiredVersion = purpose.requires?.iosVersion, iosVersionSatisfies(aliasVersion: simulator.iosVersion, requiredVersion: requiredVersion) == false {
      return false
    }
    return true
  }

  private func iosVersionSatisfies(aliasVersion: String, requiredVersion: String) -> Bool {
    let aliasParts = aliasVersion.split(separator: ".")
    let requiredParts = requiredVersion.split(separator: ".")
    guard aliasParts.count >= requiredParts.count else {
      return false
    }
    for (index, part) in requiredParts.enumerated() where aliasParts[index] != part {
      return false
    }
    return true
  }

  private func simulatorSortOrder(_ lhs: BrokerSimulator, _ rhs: BrokerSimulator) -> Bool {
    let leftOrder = (
      healthPriority(for: lhs.health),
      occupancyPriority(for: lhs),
      lhs.alias
    )
    let rightOrder = (
      healthPriority(for: rhs.health),
      occupancyPriority(for: rhs),
      rhs.alias
    )
    return leftOrder < rightOrder
  }

  private func healthPriority(for health: String) -> Int {
    switch health {
    case "repair-needed", "repairing":
      return 0
    case "state-drift":
      return 1
    case "healthy":
      return 2
    default:
      return 3
    }
  }

  private func occupancyPriority(for simulator: BrokerSimulator) -> Int {
    if simulator.activeLeaseSummary != nil {
      return 0
    }
    if simulator.pin != nil {
      return 1
    }
    return 2
  }
}
