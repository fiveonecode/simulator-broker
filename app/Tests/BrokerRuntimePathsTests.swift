import XCTest
@testable import SimulatorBrokerApp

final class BrokerRuntimePathsTests: XCTestCase {
  func testLaunchContextPrefersExplicitArgumentOverEnvironmentAndDefaults() throws {
    let paths = BrokerRuntimePaths.fromLaunchContext(
      arguments: [
        "SimulatorBrokerApp",
        "--state-root",
        "/tmp/from-args",
        "--host-config",
        "/tmp/host-from-args.json",
        "--cli-path",
        "/tmp/cli-from-args",
      ],
      environment: [
        BrokerRuntimePaths.stateRootEnvironmentKey: "/tmp/from-env",
        BrokerRuntimePaths.hostConfigEnvironmentKey: "/tmp/host-from-env.json",
        BrokerRuntimePaths.cliPathEnvironmentKey: "/tmp/cli-from-env",
      ]
    )

    XCTAssertEqual(paths.stateRoot.path, "/tmp/from-args")
    XCTAssertEqual(paths.hostConfigURL.path, "/tmp/host-from-args.json")
    XCTAssertEqual(paths.configuredCLIURL?.path, "/tmp/cli-from-args")
  }

  func testLaunchContextFallsBackFromEnvironmentToBuiltInDefaults() {
    let environmentPaths = BrokerRuntimePaths.fromLaunchContext(
      arguments: ["SimulatorBrokerApp"],
      environment: [
        BrokerRuntimePaths.stateRootEnvironmentKey: "/tmp/from-env",
        BrokerRuntimePaths.hostConfigEnvironmentKey: "/tmp/host-from-env.json",
        BrokerRuntimePaths.cliPathEnvironmentKey: "/tmp/cli-from-env",
      ]
    )
    XCTAssertEqual(environmentPaths.stateRoot.path, "/tmp/from-env")
    XCTAssertEqual(environmentPaths.hostConfigURL.path, "/tmp/host-from-env.json")
    XCTAssertEqual(environmentPaths.configuredCLIURL?.path, "/tmp/cli-from-env")

    let defaultsPaths = BrokerRuntimePaths.fromLaunchContext(
      arguments: ["SimulatorBrokerApp"],
      environment: [:]
    )
    XCTAssertEqual(defaultsPaths.stateRoot.path, BrokerRuntimePaths.defaultStateRoot().path)
    XCTAssertEqual(defaultsPaths.hostConfigURL.path, BrokerRuntimePaths.defaultHostConfig().path)
    XCTAssertNil(defaultsPaths.configuredCLIURL)
  }

  func testLaunchContextInfersSimulatorPaneFromAliasArgument() {
    let launchContext = BrokerLaunchContext.fromLaunchContext(
      arguments: ["SimulatorBrokerApp", "--simulator-alias", "ui-2"],
      environment: [:]
    )

    XCTAssertEqual(launchContext.initialSelection.pane, .simulators)
    XCTAssertEqual(launchContext.initialSelection.simulatorAlias, "ui-2")
    XCTAssertNil(launchContext.initialSelection.projectId)
    XCTAssertNil(launchContext.initialSelection.eventId)
  }

  func testLaunchContextHonorsExplicitPaneAndSelectionArguments() {
    let launchContext = BrokerLaunchContext.fromLaunchContext(
      arguments: [
        "SimulatorBrokerApp",
        "--pane=projects",
        "--project-id=sample-project",
      ],
      environment: [:]
    )

    XCTAssertEqual(launchContext.initialSelection.pane, .projects)
    XCTAssertNil(launchContext.initialSelection.simulatorAlias)
    XCTAssertEqual(launchContext.initialSelection.projectId, "sample-project")
    XCTAssertNil(launchContext.initialSelection.eventId)
  }
}
