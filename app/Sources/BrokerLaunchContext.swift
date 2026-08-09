import Foundation

struct BrokerInitialSelection: Sendable, Equatable {
  static let defaultPane: BrokerNavigationPane = .overview
  static let defaultSelection = BrokerInitialSelection(
    pane: defaultPane,
    simulatorAlias: nil,
    projectId: nil,
    eventId: nil
  )

  let pane: BrokerNavigationPane
  let simulatorAlias: String?
  let projectId: String?
  let eventId: String?
  let hasExplicitPane: Bool
  let hasExplicitSimulatorAlias: Bool
  let hasExplicitProjectId: Bool
  let hasExplicitEventId: Bool

  var hasExplicitDeepLink: Bool {
    hasExplicitPane || hasExplicitSimulatorAlias || hasExplicitProjectId || hasExplicitEventId
  }

  init(
    pane: BrokerNavigationPane,
    simulatorAlias: String?,
    projectId: String?,
    eventId: String?,
    hasExplicitPane: Bool = false,
    hasExplicitSimulatorAlias: Bool = false,
    hasExplicitProjectId: Bool = false,
    hasExplicitEventId: Bool = false
  ) {
    self.pane = pane
    self.simulatorAlias = simulatorAlias
    self.projectId = projectId
    self.eventId = eventId
    self.hasExplicitPane = hasExplicitPane
    self.hasExplicitSimulatorAlias = hasExplicitSimulatorAlias
    self.hasExplicitProjectId = hasExplicitProjectId
    self.hasExplicitEventId = hasExplicitEventId
  }

  static func from(arguments: [String]) -> BrokerInitialSelection {
    let simulatorAlias = argumentValue(named: "--simulator-alias", from: arguments)
    let projectId = argumentValue(named: "--project-id", from: arguments)
    let eventId = argumentValue(named: "--event-id", from: arguments)
    let explicitPane = argumentValue(named: "--pane", from: arguments).flatMap(BrokerNavigationPane.init(rawValue:))

    let pane: BrokerNavigationPane
    if let explicitPane {
      pane = explicitPane
    } else if simulatorAlias != nil {
      pane = .simulators
    } else if projectId != nil {
      pane = .projects
    } else if eventId != nil {
      pane = .events
    } else {
      pane = defaultPane
    }

    return BrokerInitialSelection(
      pane: pane,
      simulatorAlias: simulatorAlias,
      projectId: projectId,
      eventId: eventId,
      hasExplicitPane: explicitPane != nil,
      hasExplicitSimulatorAlias: simulatorAlias != nil,
      hasExplicitProjectId: projectId != nil,
      hasExplicitEventId: eventId != nil
    )
  }

  private static func argumentValue(named name: String, from arguments: [String]) -> String? {
    var index = 0
    while index < arguments.count {
      let argument = arguments[index]
      if argument == name {
        let nextIndex = index + 1
        guard nextIndex < arguments.count else {
          return nil
        }
        return arguments[nextIndex]
      }

      if argument.hasPrefix("\(name)=") {
        return String(argument.dropFirst(name.count + 1))
      }

      index += 1
    }

    return nil
  }
}

struct BrokerLaunchContext: Sendable {
  let runtimePaths: BrokerRuntimePaths
  let initialSelection: BrokerInitialSelection

  static func fromLaunchContext(
    arguments: [String] = CommandLine.arguments,
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) -> BrokerLaunchContext {
    BrokerLaunchContext(
      runtimePaths: BrokerRuntimePaths.fromLaunchContext(
        arguments: arguments,
        environment: environment
      ),
      initialSelection: BrokerInitialSelection.from(arguments: arguments)
    )
  }
}
