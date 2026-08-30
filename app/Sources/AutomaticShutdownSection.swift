import SwiftUI

struct AutomaticShutdownSection: View {
  static let validInputGuidance = "This grace period starts when a lease is released. Eligible automated simulators are shut down when it expires."

  @Bindable var store: BrokerDashboardStore
  let idle: BrokerIdleSummary

  @State private var graceSecondsText = ""

  var body: some View {
    GroupBox("Automatic shutdown") {
      VStack(alignment: .leading, spacing: 16) {
        summaryGrid

        Divider()

        controls

        Text(inputGuidance)
          .font(.caption)
          .foregroundStyle(graceSecondsText.isEmpty || graceSeconds != nil ? Color.secondary : Color.red)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .onAppear(perform: synchronizeInput)
    .onChange(of: idle.graceSeconds) { _, _ in
      synchronizeInput()
    }
    .confirmationDialog(
      Text("Clean idle simulators now?"),
      isPresented: cleanupConfirmationPresented,
      presenting: store.pendingIdleCleanupRequest
    ) { request in
      Button(cleanupButtonTitle(count: request.eligibleCount), role: .destructive) {
        store.confirmIdleCleanup()
      }
    } message: { request in
      Text(cleanupConfirmationMessage(count: request.eligibleCount))
    }
  }

  private var summaryGrid: some View {
    LazyVGrid(
      columns: [
        GridItem(.flexible(minimum: 220), spacing: 18),
        GridItem(.flexible(minimum: 220), spacing: 18),
      ],
      alignment: .leading,
      spacing: 12
    ) {
      LabeledContent("Policy") {
        StatusPill(
          color: idle.configured ? .green : .secondary,
          title: idle.configured ? "Configured" : "Not configured"
        )
      }
      LabeledContent("Grace duration", value: configuredDurationText)
      LabeledContent("Eligible now", value: "\(idle.eligibleCount)")
      LabeledContent("Last result", value: lastResultText)
    }
  }

  private var controls: some View {
    HStack(alignment: .firstTextBaseline, spacing: 12) {
      TextField("60–86400 seconds", text: $graceSecondsText)
        .frame(width: 180)
        .textFieldStyle(.roundedBorder)
        .accessibilityLabel("Automatic shutdown grace duration in seconds")

      Button("Apply", action: applyPolicy)
        .buttonStyle(.borderedProminent)
        .disabled(graceSeconds == nil || store.canSendCommands == false || store.isApplyingAction)

      Button("Disable", action: disablePolicy)
        .disabled(idle.configured == false || store.canSendCommands == false || store.isApplyingAction)

      Spacer()

      Button("Clean idle simulators now", role: .destructive) {
        store.requestIdleCleanup()
      }
      .disabled(store.canSendCommands == false || store.isApplyingAction)
    }
  }

  private var cleanupConfirmationPresented: Binding<Bool> {
    Binding(
      get: { store.pendingIdleCleanupRequest != nil },
      set: { isPresented in
        if isPresented == false {
          store.pendingIdleCleanupRequest = nil
        }
      }
    )
  }

  private var configuredDurationText: String {
    guard let graceSeconds = idle.graceSeconds else {
      return "Not configured"
    }
    return "\(graceSeconds) seconds"
  }

  private var graceSeconds: Int? {
    guard let value = Int(graceSecondsText.trimmingCharacters(in: .whitespacesAndNewlines)),
          (60 ... 86_400).contains(value)
    else {
      return nil
    }
    return value
  }

  private var inputGuidance: String {
    if graceSecondsText.isEmpty {
      return "Enter a whole number of seconds from 60 through 86400."
    }
    if graceSeconds == nil {
      return "The duration must be a whole number from 60 through 86400 seconds."
    }
    return Self.validInputGuidance
  }

  private var lastResultText: String {
    guard let result = idle.lastCleanupResult else {
      return "No cleanup recorded"
    }
    let status = result.status.replacingOccurrences(of: "_", with: " ").capitalized
    return "\(status) · \(result.shutdownCount) shut down · \(result.failureCount) need repair"
  }

  private func cleanupButtonTitle(count: Int) -> String {
    count == 1 ? "Shut down 1 simulator" : "Shut down \(count) simulators"
  }

  private func cleanupConfirmationMessage(count: Int) -> String {
    count == 1
      ? "1 currently idle simulator is eligible for shutdown."
      : "\(count) currently idle simulators are eligible for shutdown."
  }

  private func synchronizeInput() {
    graceSecondsText = idle.graceSeconds.map(String.init) ?? ""
  }

  private func applyPolicy() {
    guard let graceSeconds else { return }
    Task { @MainActor in
      do {
        try await store.applyIdlePolicy(graceSeconds: graceSeconds)
      } catch {
        store.lastErrorMessage = error.localizedDescription
      }
    }
  }

  private func disablePolicy() {
    Task { @MainActor in
      do {
        try await store.disableIdlePolicy()
      } catch {
        store.lastErrorMessage = error.localizedDescription
      }
    }
  }
}
