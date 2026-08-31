import SwiftUI

func timestampDisplay(_ isoValue: String?) -> String? {
  guard let isoValue else {
    return nil
  }
  guard let date = parseISO8601Timestamp(isoValue) else {
    return isoValue
  }
  return date.formatted(date: .abbreviated, time: .shortened)
}

private func parseISO8601Timestamp(_ value: String) -> Date? {
  let formats = [
    Date.ISO8601FormatStyle(includingFractionalSeconds: true),
    Date.ISO8601FormatStyle(includingFractionalSeconds: false),
  ]

  for format in formats {
    if let date = try? format.parse(value) {
      return date
    }
  }

  return nil
}

func healthTint(_ health: String) -> Color {
  switch health {
  case "healthy":
    return .green
  case "state-drift":
    return .orange
  case "repair-needed", "repairing":
    return .red
  default:
    return .secondary
  }
}

func powerTint(_ powerState: String) -> Color {
  powerState == "booted" ? .blue : .secondary
}

struct MetricCard: View {
  let accent: Color
  let subtitle: String
  let title: String
  let value: String

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Image(systemName: "circle.fill")
        .font(.system(size: 10))
        .foregroundStyle(accent)
      Text(title)
        .font(.headline)
      Text(value)
        .font(.system(size: 32, weight: .semibold, design: .rounded))
      Text(subtitle)
        .font(.subheadline)
        .foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(18)
    .background(accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 16, style: .continuous)
        .stroke(accent.opacity(0.18), lineWidth: 1)
    )
  }
}

struct DashboardPanelStyle: GroupBoxStyle {
  func makeBody(configuration: Configuration) -> some View {
    VStack(alignment: .leading, spacing: 14) {
      configuration.label
        .font(.headline)
      configuration.content
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(18)
    .background(
      RoundedRectangle(cornerRadius: 18, style: .continuous)
        .fill(.quinary)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 18, style: .continuous)
        .strokeBorder(.quaternary, lineWidth: 1)
    )
  }
}

struct StatusPill: View {
  let color: Color
  let title: String

  var body: some View {
    HStack(spacing: 6) {
      Circle()
        .fill(color)
        .frame(width: 8, height: 8)
      Text(title)
    }
    .font(.caption.weight(.semibold))
    .padding(.horizontal, 10)
    .padding(.vertical, 6)
    .background(color.opacity(0.12), in: Capsule())
    .foregroundStyle(color)
  }
}

struct ToolbarStatusLabel: View {
  let color: Color
  let symbolName: String
  let title: String

  var body: some View {
    HStack(spacing: 6) {
      Image(systemName: symbolName)
      Text(title)
        .lineLimit(1)
        .truncationMode(.tail)
    }
    .font(.subheadline)
    .foregroundStyle(color)
    .fixedSize(horizontal: true, vertical: false)
    .accessibilityElement(children: .combine)
  }
}

struct EmptyBrokerStateView: View {
  let errorMessage: String?
  let onRefresh: () -> Void
  let stateRootPath: String

  var body: some View {
    ContentUnavailableView {
      Label("No broker snapshot available", systemImage: "tray.full")
    } description: {
      VStack(alignment: .leading, spacing: 14) {
        Text("Start `brokerd` or run a broker command that writes the read-only snapshot artifact, then refresh this window.")
        VStack(alignment: .leading, spacing: 8) {
          Text("Expected state root")
            .font(.headline)
          Text(stateRootPath)
            .font(.system(.body, design: .monospaced))
            .textSelection(.enabled)
        }
        if let errorMessage {
          VStack(alignment: .leading, spacing: 8) {
            Text("Last error")
              .font(.headline)
            Text(errorMessage)
              .foregroundStyle(.red)
          }
        }
      }
      .frame(maxWidth: 560, alignment: .leading)
    } actions: {
      Button("Refresh", action: onRefresh)
        .buttonStyle(.borderedProminent)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .padding(32)
  }
}

func connectionTint(_ title: String) -> Color {
  switch title {
  case "Commands enabled", "brokerd running":
    return .green
  case "Read-only snapshot", "snapshot only", "Refreshing state", "brokerd starting":
    return .orange
  default:
    return .red
  }
}

struct StatusMessageCard: View {
  let color: Color
  let message: String
  let actionTitle: String?
  let onAction: (() -> Void)?
  let onDismiss: (() -> Void)?
  let symbolName: String

  init(
    color: Color,
    message: String,
    symbolName: String,
    actionTitle: String? = nil,
    onAction: (() -> Void)? = nil,
    onDismiss: (() -> Void)? = nil
  ) {
    self.color = color
    self.message = message
    self.actionTitle = actionTitle
    self.onAction = onAction
    self.onDismiss = onDismiss
    self.symbolName = symbolName
  }

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: symbolName)
        .font(.headline.weight(.semibold))
        .foregroundStyle(color)
        .frame(width: 18)

      Text(message)
        .foregroundStyle(.primary)
        .fixedSize(horizontal: false, vertical: true)

      Spacer()

      if let actionTitle, let onAction {
        Button(actionTitle, action: onAction)
          .buttonStyle(.borderedProminent)
          .controlSize(.small)
          .tint(color)
      }
      if let onDismiss {
        Button(action: onDismiss) {
          Image(systemName: "xmark")
            .font(.caption.weight(.semibold))
            .frame(width: 16, height: 16)
        }
        .buttonStyle(.borderless)
        .foregroundStyle(.secondary)
        .accessibilityLabel("Dismiss message")
      }
    }
    .font(.subheadline)
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(.quinary, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 16, style: .continuous)
        .strokeBorder(color.opacity(0.18), lineWidth: 1)
    )
  }
}

struct HighlightBanner: View {
  let color: Color
  let symbolName: String
  let title: String
  let message: String

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: symbolName)
        .font(.title3.weight(.semibold))
        .foregroundStyle(color)
      VStack(alignment: .leading, spacing: 4) {
        Text(title)
          .font(.headline)
        Text(message)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(color.opacity(0.1), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 16, style: .continuous)
        .stroke(color.opacity(0.18), lineWidth: 1)
    )
  }
}

struct BrokerCommandSnippetView: View {
  let command: String

  var body: some View {
    Text(command)
      .font(.system(.body, design: .monospaced))
      .textSelection(.enabled)
      .padding(.horizontal, 14)
      .padding(.vertical, 12)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(.background.secondary.opacity(0.6), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
  }
}

struct RepoOnboardingGuideView: View {
  let cliPath: String?
  let envHelperPath: String?

  private var guide: RepoOnboardingCommandGuide {
    RepoOnboardingCommandGuide(cliPath: cliPath, envHelperPath: envHelperPath)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("Every repo still needs its own broker project file and harness wiring.")
        .foregroundStyle(.secondary)
      Text(guide.shellHelpText)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      ForEach(guide.commands, id: \.self) { command in
        BrokerCommandSnippetView(command: command)
      }
      Text("For agent-first repos, use the `broker-harness-adoption` skill or follow this repo’s harness integration guide to add the lease wrapper and cleanup flow.")
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

private struct SetupStatusRow: View {
  let detail: String
  let title: String
  let statusColor: Color
  let statusTitle: String

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      VStack(alignment: .leading, spacing: 4) {
        Text(title)
          .font(.headline)
        Text(detail)
          .font(.system(.body, design: .monospaced))
          .foregroundStyle(.secondary)
          .textSelection(.enabled)
      }
      Spacer()
      StatusPill(color: statusColor, title: statusTitle)
    }
  }
}

struct BrokerSetupView: View {
  @Bindable var store: BrokerDashboardStore

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        VStack(alignment: .leading, spacing: 12) {
          Label(heroTitle, systemImage: heroSymbolName)
            .font(.system(size: 28, weight: .semibold))
          Text(heroMessage)
            .font(.title3)
          Text("All setup actions run the same broker CLI commands that humans, agents, and CI use. The app is only orchestrating those broker-owned flows.")
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }

        HStack(spacing: 12) {
          if let primaryActionTitle = primaryActionTitle {
            Button(primaryActionTitle, action: performPrimaryAction)
            .buttonStyle(.borderedProminent)
            .disabled(store.isApplyingAction || primaryActionEnabled == false)
          }

          Button(BrokerMissingCLISetupCopy.refreshActionTitle) {
            store.refreshNow()
          }
          .buttonStyle(.bordered)
          .disabled(store.isApplyingAction)

          if store.isAutomaticSetupInProgress {
            ProgressView()
              .controlSize(.small)
            if store.setupPhase == .applying {
              Button("Stop", role: .destructive) {
                _ = store.stopGuidedSetup()
              }
            }
          }
        }

        GroupBox("Setup status") {
          VStack(alignment: .leading, spacing: 14) {
            SetupStatusRow(
              detail: store.cliPath ?? store.cliHintPath,
              title: "Broker CLI",
              statusColor: store.canRunLocalBrokerCommands ? .green : .red,
              statusTitle: store.canRunLocalBrokerCommands ? "Ready" : "Missing"
            )
            SetupStatusRow(
              detail: store.hostConfigPath,
              title: "Host config",
              statusColor: store.hostConfigExists ? .green : .orange,
              statusTitle: store.hostConfigExists ? "Ready" : "Missing"
            )
            SetupStatusRow(
              detail: store.stateRootPath,
              title: "Broker service",
              statusColor: store.serviceStatusUnverified ? .red : (store.canSendCommands ? .green : .orange),
              statusTitle: store.serviceStatusUnverified
                ? "Unverified"
                : (store.serviceRequiresRestart ? "Restart required" : (store.canSendCommands ? "Running" : "Stopped"))
            )
            if let installRootPath = store.installRootPath {
              SetupStatusRow(
                detail: installRootPath,
                title: "Install root",
                statusColor: .blue,
                statusTitle: "Detected"
              )
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }

        GroupBox("Manual fallback") {
          VStack(alignment: .leading, spacing: 14) {
            Text(manualFallbackText)
              .foregroundStyle(.secondary)
              .fixedSize(horizontal: false, vertical: true)
            ForEach(manualFallbackCommands, id: \.self) { command in
              BrokerCommandSnippetView(command: command)
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }

        GroupBox("Next repo to onboard") {
          RepoOnboardingGuideView(
            cliPath: store.onboardingCLIPath,
            envHelperPath: store.envHelperPath
          )
        }

        if let errorMessage = store.lastErrorMessage {
          GroupBox("Last error") {
            Text(errorMessage)
              .foregroundStyle(.red)
              .fixedSize(horizontal: false, vertical: true)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
        }
      }
      .padding(32)
      .frame(maxWidth: 980, alignment: .leading)
    }
    .groupBoxStyle(DashboardPanelStyle())
  }

  private var heroMessage: String {
    switch store.startupState {
    case .missingCLI:
      return BrokerMissingCLISetupCopy.heroMessage
    case .needsHostBootstrap:
      return "Preview one guided plan for the starter Simulator pool, host configuration, brokerd startup, snapshot refresh, and health verification."
    case .needsServiceStart:
      if store.serviceRequiresRestart {
        return "brokerd is running, but its runtime requires restart. Finish setup to restart it cooperatively and restore live commands."
      }
      return "The broker host config exists, but brokerd is not running. Start the service to enable live state, pins, lease release, and lifecycle actions."
    case .needsSnapshotRefresh:
      return "brokerd is reachable, but the app snapshot is missing. Refresh the snapshot artifact to populate the dashboard."
    case .readOnlySnapshot:
      return "A snapshot exists, but brokerd is not running. You can inspect state, but commands stay disabled until the service starts."
    case .serviceStatusUnverified:
      return store.serviceAvailabilityMessage
    case .ready:
      return "Simulator Broker is ready on this Mac."
    }
  }

  private var heroSymbolName: String {
    switch store.startupState {
    case .missingCLI:
      return "terminal"
    case .needsHostBootstrap:
      return "sparkles.rectangle.stack"
    case .needsServiceStart:
      return store.serviceRequiresRestart ? "arrow.trianglehead.2.clockwise.rotate.90" : "play.circle.fill"
    case .needsSnapshotRefresh:
      return "arrow.trianglehead.clockwise"
    case .readOnlySnapshot:
      return "tray.full"
    case .serviceStatusUnverified:
      return "arrow.clockwise.circle"
    case .ready:
      return "checkmark.circle.fill"
    }
  }

  private var heroTitle: String {
    switch store.startupState {
    case .missingCLI:
      return "Finish Local Broker Installation"
    case .needsHostBootstrap:
      return "Set Up This Mac"
    case .needsServiceStart:
      return store.serviceRequiresRestart ? "Restart brokerd" : "Start brokerd"
    case .needsSnapshotRefresh:
      return "Refresh Broker State"
    case .readOnlySnapshot:
      return "Read-Only Broker State"
    case .serviceStatusUnverified:
      return "Verify Broker Status"
    case .ready:
      return "Simulator Broker Ready"
    }
  }

  private var manualFallbackCommands: [String] {
    let formatter = BrokerCLIInvocationFormatter(executablePath: store.onboardingCLIPath)

    switch store.startupState {
    case .missingCLI:
      return BrokerMissingCLISetupCopy.manualFallbackCommands
    case .needsHostBootstrap, .needsServiceStart, .readOnlySnapshot, .needsSnapshotRefresh, .ready:
      return [
        formatter.setupCommand(
          hostConfigPath: store.hostConfigPath,
          stateRootPath: store.stateRootPath,
          serviceSocketPath: store.serviceSocketPath
        ),
      ]
    case .serviceStatusUnverified:
      if let command = store.unverifiedServiceStatusFallbackCommand {
        return [command]
      }
      return []
    }
  }

  private var manualFallbackText: String {
    switch store.startupState {
    case .missingCLI:
      return BrokerMissingCLISetupCopy.manualFallbackText
    case .needsHostBootstrap:
      return "CLI fallback for the same guided preview and confirmation flow."
    case .needsServiceStart, .readOnlySnapshot:
      if store.serviceRequiresRestart {
        return "The same setup command cooperatively replaces the incompatible runtime without replacing the host configuration."
      }
      return "The same setup command safely finishes brokerd startup without replacing the host configuration."
    case .needsSnapshotRefresh:
      return "The same setup command safely refreshes and verifies broker state."
    case .serviceStatusUnverified:
      return BrokerUnverifiedStatusCopy.manualFallbackText
    case .ready:
      return "Rerunning setup verifies the existing healthy machine without expanding its pool."
    }
  }

  private var primaryActionEnabled: Bool {
    switch store.startupState {
    case .missingCLI:
      return false
    case .needsHostBootstrap, .needsServiceStart, .readOnlySnapshot, .needsSnapshotRefresh:
      return store.canRunLocalBrokerCommands
    case .serviceStatusUnverified, .ready:
      return false
    }
  }

  private var primaryActionTitle: String? {
    switch store.startupState {
    case .missingCLI, .serviceStatusUnverified, .ready:
      return nil
    case .needsHostBootstrap:
      return "Complete first-time setup"
    case .needsServiceStart, .readOnlySnapshot:
      return "Finish setup"
    case .needsSnapshotRefresh:
      return "Finish setup"
    }
  }

  private func performPrimaryAction() {
    store.requestGuidedSetup()
  }
}

func projectPurposeRequiresText(_ requires: BrokerPurposeRequires) -> String {
  var segments: [String] = []
  if let deviceFamily = requires.deviceFamily {
    segments.append("Device family: \(deviceFamily)")
  }
  if let iosVersion = requires.iosVersion {
    segments.append("iOS: \(iosVersion)")
  }
  return segments.isEmpty ? "No additional requirements" : segments.joined(separator: " · ")
}
