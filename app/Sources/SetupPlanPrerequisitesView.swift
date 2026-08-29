import SwiftUI

struct SetupPlanPrerequisitesView: View {
  let prerequisites: [BrokerSetupPrerequisite]

  var body: some View {
    GroupBox("Readiness checks") {
      VStack(alignment: .leading, spacing: 12) {
        ForEach(prerequisites) { prerequisite in
          VStack(alignment: .leading, spacing: 6) {
            Label(prerequisite.summary, systemImage: symbolName(for: prerequisite.status))
              .foregroundStyle(style(for: prerequisite.status))
              .accessibilityLabel("\(statusLabel(for: prerequisite.status)): \(prerequisite.summary)")
            ForEach(prerequisite.remediationCommands, id: \.self) { command in
              BrokerCommandSnippetView(command: command)
            }
          }
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private func statusLabel(for status: String) -> String {
    switch status {
    case "ready": "Ready"
    case "blocked": "Blocked"
    default: "Information"
    }
  }

  private func style(for status: String) -> HierarchicalShapeStyle {
    status == "info" ? .secondary : .primary
  }

  private func symbolName(for status: String) -> String {
    switch status {
    case "ready": "checkmark.circle.fill"
    case "blocked": "xmark.octagon.fill"
    default: "info.circle.fill"
    }
  }
}
