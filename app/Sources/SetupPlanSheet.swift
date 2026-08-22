import SwiftUI

struct SetupPlanSheet: View {
  let onCancel: () -> Void
  let onConfirm: () -> Void
  let onStop: () -> Void
  let phase: BrokerSetupPhase
  let plan: BrokerSetupPlan

  var body: some View {
    VStack(spacing: 0) {
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: titleSymbol)
              .font(.title2)
              .bold()
            Text(introduction)
              .foregroundStyle(.secondary)
              .fixedSize(horizontal: false, vertical: true)
          }

          SetupPlanPrerequisitesView(prerequisites: plan.prerequisites)

          if let runtime = plan.runtime {
            GroupBox("Selected runtime") {
              LabeledContent("iOS version", value: runtime.version)
              if let buildVersion = runtime.buildVersion {
                LabeledContent("Build", value: buildVersion)
              }
              LabeledContent(
                "Selection",
                value: runtime.selectionSource == "automatic" ? "Newest compatible installed runtime" : "Explicit version"
              )
            }
          }

          if plan.devices.isEmpty == false {
            SetupPlanDevicesView(devices: plan.devices)
          }

          GroupBox("Finish setup") {
            VStack(alignment: .leading, spacing: 8) {
              Label("Start or validate brokerd", systemImage: "play.circle")
              Label("Refresh the app snapshot", systemImage: "arrow.clockwise.circle")
              Label("Verify service identity and Simulator health", systemImage: "checkmark.shield")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
          }

          if let errorMessage = plan.prerequisites.first(where: { $0.status == "blocked" })?.summary {
            Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
              .foregroundStyle(.red)
          }
        }
        .padding()
      }

      Divider()

      HStack {
        Text(phase == .applying ? "Setup is in progress. You can stop safely." : "Plan ID: \(plan.planId)")
          .font(.footnote)
          .foregroundStyle(.secondary)
          .lineLimit(1)
          .truncationMode(.middle)
        Spacer()
        if phase == .applying {
          ProgressView()
            .controlSize(.small)
          Button("Stop", role: .destructive, action: onStop)
        } else {
          Button("Cancel", action: onCancel)
            .keyboardShortcut(.cancelAction)
          Button(confirmTitle, action: onConfirm)
            .buttonStyle(.borderedProminent)
            .keyboardShortcut(.defaultAction)
            .disabled(plan.status == .blocked || plan.confirmation.required == false)
        }
      }
      .padding()
    }
    .frame(minWidth: 640, idealWidth: 760, minHeight: 520, idealHeight: 700)
    .interactiveDismissDisabled(phase == .applying)
  }

  private var confirmTitle: String {
    if plan.confirmation.reuseCount > 0 {
      return "Create \(plan.confirmation.createCount), Reuse \(plan.confirmation.reuseCount) & Finish Setup"
    }
    return "Create \(plan.confirmation.createCount) Simulators & Finish Setup"
  }

  private var introduction: String {
    if plan.status == .blocked {
      return "Setup cannot continue until the checks below are resolved. No changes have been made."
    }
    return "Review the exact Simulator pool and machine changes below. No changes have been made yet."
  }

  private var title: String {
    plan.status == .blocked ? "Setup needs attention" : "Review first-time setup"
  }

  private var titleSymbol: String {
    plan.status == .blocked ? "exclamationmark.triangle.fill" : "sparkles.rectangle.stack"
  }
}
