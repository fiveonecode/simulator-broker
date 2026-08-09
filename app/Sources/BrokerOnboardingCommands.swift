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

  private var invocationPrefix: String {
    if let executablePath {
      return Self.shellQuote(executablePath)
    }
    return "simbroker"
  }

  private static func shellQuote(_ rawValue: String) -> String {
    "'\(rawValue.replacingOccurrences(of: "'", with: "'\\''"))'"
  }
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
