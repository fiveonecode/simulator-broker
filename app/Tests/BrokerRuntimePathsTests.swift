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
        "--service-socket",
        "/tmp/socket-from-args.sock",
      ],
      environment: [
        BrokerRuntimePaths.stateRootEnvironmentKey: "/tmp/from-env",
        BrokerRuntimePaths.hostConfigEnvironmentKey: "/tmp/host-from-env.json",
        BrokerRuntimePaths.cliPathEnvironmentKey: "/tmp/cli-from-env",
        BrokerRuntimePaths.serviceSocketEnvironmentKey: "/tmp/socket-from-env.sock",
      ]
    )

    XCTAssertEqual(paths.stateRoot.path, "/tmp/from-args")
    XCTAssertEqual(paths.hostConfigURL.path, "/tmp/host-from-args.json")
    XCTAssertEqual(paths.configuredCLIURL?.path, "/tmp/cli-from-args")
    XCTAssertEqual(paths.serviceSocketURL?.path, "/tmp/socket-from-args.sock")
  }

  func testLaunchContextFallsBackFromEnvironmentToBuiltInDefaults() {
    let environmentPaths = BrokerRuntimePaths.fromLaunchContext(
      arguments: ["SimulatorBrokerApp"],
      environment: [
        BrokerRuntimePaths.stateRootEnvironmentKey: "/tmp/from-env",
        BrokerRuntimePaths.hostConfigEnvironmentKey: "/tmp/host-from-env.json",
        BrokerRuntimePaths.cliPathEnvironmentKey: "/tmp/cli-from-env",
        BrokerRuntimePaths.serviceSocketEnvironmentKey: "/tmp/socket-from-env.sock",
      ]
    )
    XCTAssertEqual(environmentPaths.stateRoot.path, "/tmp/from-env")
    XCTAssertEqual(environmentPaths.hostConfigURL.path, "/tmp/host-from-env.json")
    XCTAssertEqual(environmentPaths.configuredCLIURL?.path, "/tmp/cli-from-env")
    XCTAssertEqual(environmentPaths.serviceSocketURL?.path, "/tmp/socket-from-env.sock")

    let defaultsPaths = BrokerRuntimePaths.fromLaunchContext(
      arguments: ["SimulatorBrokerApp"],
      environment: [:]
    )
    XCTAssertEqual(defaultsPaths.stateRoot.path, BrokerRuntimePaths.defaultStateRoot().path)
    XCTAssertEqual(defaultsPaths.hostConfigURL.path, BrokerRuntimePaths.defaultHostConfig().path)
    XCTAssertNil(defaultsPaths.configuredCLIURL)
    XCTAssertNil(defaultsPaths.serviceSocketURL)
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

  func testCLICandidatesPreferConfiguredThenInstallThenHomebrewThenLocalDefault() {
    let configured = URL(fileURLWithPath: "/tmp/configured-simbroker")
    let installPath = "/tmp/installed-simbroker"
    let candidates = BrokerRuntimePaths.cliCandidateURLs(
      configuredCLIURL: configured,
      installMetadataCLIPath: installPath,
      homebrewPrefixRoots: [
        URL(fileURLWithPath: "/opt/homebrew"),
        URL(fileURLWithPath: "/usr/local"),
      ],
      defaultCLIURL: URL(fileURLWithPath: "/tmp/home/.local/bin/simbroker")
    )

    XCTAssertEqual(
      candidates.map(\.path),
      [
        "/tmp/configured-simbroker",
        "/tmp/installed-simbroker",
        "/opt/homebrew/bin/simbroker",
        "/usr/local/bin/simbroker",
        "/tmp/home/.local/bin/simbroker",
      ]
    )
  }

  func testFirstExecutableCLIPrefersHomebrewOverLocalDefault() {
    let homebrew = URL(fileURLWithPath: "/opt/homebrew/bin/simbroker")
    let localDefault = URL(fileURLWithPath: "/tmp/home/.local/bin/simbroker")
    let candidates = BrokerRuntimePaths.cliCandidateURLs(
      configuredCLIURL: nil,
      installMetadataCLIPath: nil,
      homebrewPrefixRoots: [URL(fileURLWithPath: "/opt/homebrew")],
      defaultCLIURL: localDefault
    )
    let resolved = BrokerRuntimePaths.firstExecutableCLIURL(among: candidates) { path in
      path == homebrew.path || path == localDefault.path
    }

    XCTAssertEqual(resolved, homebrew)
  }

  func testFirstExecutableCLIFallsBackToLocalDefaultWhenHomebrewIsMissing() {
    let localDefault = URL(fileURLWithPath: "/tmp/home/.local/bin/simbroker")
    let candidates = BrokerRuntimePaths.cliCandidateURLs(
      configuredCLIURL: nil,
      installMetadataCLIPath: nil,
      homebrewPrefixRoots: [URL(fileURLWithPath: "/opt/homebrew")],
      defaultCLIURL: localDefault
    )
    let resolved = BrokerRuntimePaths.firstExecutableCLIURL(among: candidates) { path in
      path == localDefault.path
    }

    XCTAssertEqual(resolved, localDefault)
  }

  func testDefaultHomebrewPrefixesIncludeStandardRootsAndOptionalHOMEBREW_PREFIX() {
    let prefixes = BrokerRuntimePaths.defaultHomebrewPrefixRoots(
      environment: ["HOMEBREW_PREFIX": "/opt/homebrew"]
    )
    XCTAssertEqual(
      prefixes.map(\.path),
      ["/opt/homebrew", "/usr/local"]
    )
  }
}
