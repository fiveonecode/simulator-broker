import Foundation
import OSLog

enum BrokerLogger {
  private static let fallbackSubsystem = "dev.codex.simulator-broker-app"

  static let subsystem = Bundle.main.bundleIdentifier ?? fallbackSubsystem

  static let appLifecycle = Logger(subsystem: subsystem, category: "AppLifecycle")
  static let refresh = Logger(subsystem: subsystem, category: "Refresh")
  static let setup = Logger(subsystem: subsystem, category: "Setup")
  static let commands = Logger(subsystem: subsystem, category: "Commands")

  static func summary(for error: any Error) -> String {
    summary(error.localizedDescription)
  }

  static func summary(_ message: String) -> String {
    let collapsed = message
      .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
      .trimmingCharacters(in: .whitespacesAndNewlines)

    guard collapsed.isEmpty == false else {
      return "Unknown error."
    }

    let maxLength = 240
    guard collapsed.count > maxLength else {
      return collapsed
    }

    let truncationIndex = collapsed.index(collapsed.startIndex, offsetBy: maxLength)
    return String(collapsed[..<truncationIndex]) + "..."
  }
}
