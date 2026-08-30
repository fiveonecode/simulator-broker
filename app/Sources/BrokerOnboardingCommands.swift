import Foundation

struct BrokerCLIInvocationFormatter {
  private let executablePath: String?

  init(executablePath: String?) {
    if let executablePath, executablePath.isEmpty == false {
      self.executablePath = (executablePath as NSString).expandingTildeInPath
    } else {
      self.executablePath = nil
    }
  }

  var usesAbsoluteExecutable: Bool {
    executablePath != nil
  }

  func command(_ subcommand: String) -> String {
    "\(invocationPrefix) \(subcommand)"
  }

  func setupCommand(
    hostConfigPath: String,
    stateRootPath: String,
    serviceSocketPath: String?
  ) -> String {
    command(Self.pathSelectedArguments(
      subcommand: "setup",
      hostConfigPath: hostConfigPath,
      stateRootPath: stateRootPath,
      serviceSocketPath: serviceSocketPath
    ).joined(separator: " "))
  }

  func serviceStatusCommand(
    hostConfigPath: String,
    stateRootPath: String,
    serviceSocketPath: String?
  ) -> String {
    command(Self.pathSelectedArguments(
      subcommand: "service status --json",
      hostConfigPath: hostConfigPath,
      stateRootPath: stateRootPath,
      serviceSocketPath: serviceSocketPath
    ).joined(separator: " "))
  }

  private var invocationPrefix: String {
    if let executablePath {
      return Self.shellQuote(executablePath)
    }
    return "simbroker"
  }

  private static func pathSelectedArguments(
    subcommand: String,
    hostConfigPath: String,
    stateRootPath: String,
    serviceSocketPath: String?
  ) -> [String] {
    var arguments = [
      subcommand,
      "--host-config", shellQuote(hostConfigPath),
      "--state-root", shellQuote(stateRootPath),
    ]
    if let serviceSocketPath {
      arguments += ["--service-socket", shellQuote(serviceSocketPath)]
    }
    return arguments
  }

  private static func shellQuote(_ rawValue: String) -> String {
    "'\(rawValue.replacingOccurrences(of: "'", with: "'\\''"))'"
  }
}

enum BrokerUnverifiedStatusCopy {
  static let manualFallbackText =
    "Check exact service status without mutating it, then refresh the dashboard."
}

enum BrokerMissingCLISetupCopy {
  static let brewInstallCommand = "brew install fiveonecode/simulator-broker/simbroker"
  static let refreshActionTitle = "Refresh"
  static let heroMessage =
    "Install the Homebrew CLI with `brew install fiveonecode/simulator-broker/simbroker`, then click Refresh. The app cannot finish first-run setup until that CLI is on this Mac."
  static let manualFallbackText =
    "The public path is the Homebrew formula, then Refresh. Development builds may still set SIMBROKER_CLI_PATH."
  static let manualFallbackCommands = [brewInstallCommand]
}

struct RepoOnboardingCommandGuide {
  let commands: [String]
  let shellHelpText: String

  init(cliPath: String?, envHelperPath: String?) {
    let formatter = BrokerCLIInvocationFormatter(executablePath: cliPath)
    commands = [
      formatter.command("project init --repo-root /path/to/repo"),
      formatter.command("project validate --repo-root /path/to/repo"),
      formatter.command("lease explain --repo-root /path/to/repo --purpose agent-ui-session"),
    ]

    if let envHelperPath, formatter.usesAbsoluteExecutable {
      shellHelpText = "If your shell does not resolve simbroker, run source \"\(envHelperPath)\" first or use the absolute executable path shown below."
    } else if let envHelperPath {
      shellHelpText = "If your shell does not resolve simbroker, run source \"\(envHelperPath)\" first."
    } else if formatter.usesAbsoluteExecutable {
      shellHelpText = "If your shell does not resolve simbroker, use the absolute executable path shown below."
    } else {
      shellHelpText = "If your shell does not resolve simbroker, install Simulator Broker locally first."
    }
  }
}
