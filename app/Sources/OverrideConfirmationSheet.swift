import SwiftUI

struct OverrideConfirmationSheet: View {
  @Environment(\.dismiss) private var dismiss

  let overrideRequest: BrokerLifecycleOverrideRequest
  let onConfirm: (String) -> Void

  @State private var overrideReason = ""

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      Text("Human override required")
        .font(.title2.weight(.semibold))
      Text("The broker reports that \(overrideRequest.alias) is currently leased by another actor. Provide a reason to continue with \(overrideRequest.action.rawValue).")
        .foregroundStyle(.secondary)

      GroupBox("Current holder") {
        VStack(alignment: .leading, spacing: 10) {
          LabeledContent("Actor") { Text("\(overrideRequest.currentHolder.actorType) · \(overrideRequest.currentHolder.actorId)") }
          LabeledContent("Project") { Text(overrideRequest.currentHolder.projectId) }
          LabeledContent("Purpose") { Text(overrideRequest.currentHolder.purposeId) }
          LabeledContent("Lease ID") {
            Text(overrideRequest.currentHolder.leaseId)
              .font(.system(.body, design: .monospaced))
              .textSelection(.enabled)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }

      TextField("Override reason", text: $overrideReason, axis: .vertical)
        .lineLimit(3 ... 5)
        .textFieldStyle(.roundedBorder)

      HStack {
        Spacer()
        Button("Cancel") {
          dismiss()
        }
        Button(overrideRequest.action.confirmationButtonTitle, role: .destructive) {
          onConfirm(overrideReason.trimmingCharacters(in: .whitespacesAndNewlines))
          dismiss()
        }
        .disabled(overrideReason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }
    .padding(24)
    .frame(minWidth: 440)
    .groupBoxStyle(DashboardPanelStyle())
  }
}
