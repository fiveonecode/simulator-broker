import XCTest
@testable import SimulatorBrokerApp

final class BrokerOnboardingCommandsTests: XCTestCase {
  func testMissingCLICopyLeadsWithHomebrewFormulaAndRefresh() {
    XCTAssertEqual(
      BrokerMissingCLISetupCopy.brewInstallCommand,
      "brew install fiveonecode/simulator-broker/simbroker"
    )
    XCTAssertEqual(BrokerMissingCLISetupCopy.refreshActionTitle, "Refresh")
    XCTAssertTrue(
      BrokerMissingCLISetupCopy.heroMessage.contains(BrokerMissingCLISetupCopy.brewInstallCommand)
    )
    XCTAssertTrue(
      BrokerMissingCLISetupCopy.heroMessage.contains(BrokerMissingCLISetupCopy.refreshActionTitle)
    )
    XCTAssertEqual(
      BrokerMissingCLISetupCopy.manualFallbackCommands,
      [BrokerMissingCLISetupCopy.brewInstallCommand]
    )
    XCTAssertTrue(
      BrokerMissingCLISetupCopy.manualFallbackText.hasPrefix("The public path is the Homebrew formula, then Refresh.")
    )
    XCTAssertFalse(
      BrokerMissingCLISetupCopy.heroMessage.contains("SIMBROKER_CLI_PATH"),
      "missing-CLI hero must not lead with SIMBROKER_CLI_PATH"
    )
    let fallback = BrokerMissingCLISetupCopy.manualFallbackText
    let brewIndex = fallback.range(of: "Homebrew formula")?.lowerBound
    let envIndex = fallback.range(of: "SIMBROKER_CLI_PATH")?.lowerBound
    XCTAssertNotNil(brewIndex)
    if let brewIndex, let envIndex {
      XCTAssertLessThan(brewIndex, envIndex)
    }
  }

  func testRepoGuideUsesQuotedAbsoluteCLIPathWhenAvailable() {
    let guide = RepoOnboardingCommandGuide(
      cliPath: "/tmp/custom broker/simbroker",
      envHelperPath: "/tmp/install/env.sh"
    )

    XCTAssertEqual(
      guide.commands,
      [
        "'/tmp/custom broker/simbroker' project init --repo-root /path/to/repo",
        "'/tmp/custom broker/simbroker' project validate --repo-root /path/to/repo",
        "'/tmp/custom broker/simbroker' lease explain --repo-root /path/to/repo --purpose agent-ui-session",
      ]
    )
    XCTAssertEqual(
      guide.shellHelpText,
      "If your shell does not resolve simbroker, run source \"/tmp/install/env.sh\" first or use the absolute executable path shown below."
    )
  }

  func testRepoGuideFallsBackToBareSimbrokerWhenNoCLIPathIsAvailable() {
    let guide = RepoOnboardingCommandGuide(
      cliPath: nil,
      envHelperPath: "/tmp/install/env.sh"
    )

    XCTAssertEqual(
      guide.commands,
      [
        "simbroker project init --repo-root /path/to/repo",
        "simbroker project validate --repo-root /path/to/repo",
        "simbroker lease explain --repo-root /path/to/repo --purpose agent-ui-session",
      ]
    )
    XCTAssertEqual(
      guide.shellHelpText,
      "If your shell does not resolve simbroker, run source \"/tmp/install/env.sh\" first."
    )
  }

  func testRepoGuideUsesAbsoluteCLIPathWhenEnvHelperIsUnknown() {
    let guide = RepoOnboardingCommandGuide(
      cliPath: "/tmp/custom broker/simbroker",
      envHelperPath: nil
    )

    XCTAssertEqual(
      guide.shellHelpText,
      "If your shell does not resolve simbroker, use the absolute executable path shown below."
    )
  }

  func testRepoGuideRequestsInstallWhenCLIAndEnvHelperAreUnknown() {
    let guide = RepoOnboardingCommandGuide(
      cliPath: nil,
      envHelperPath: nil
    )

    XCTAssertEqual(
      guide.shellHelpText,
      "If your shell does not resolve simbroker, install Simulator Broker locally first."
    )
  }
}
