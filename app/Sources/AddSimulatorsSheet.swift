import SwiftUI

struct AddSimulatorsSheet: View {
  @Bindable var store: BrokerDashboardStore

  var body: some View {
    NavigationStack {
      Form {
        projectSection
        purposeSection
        resultSection
      }
      .formStyle(.grouped)
      .navigationTitle("Add simulators")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel", action: store.cancelAddSimulators)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button(createTitle, action: store.confirmAddSimulators)
            .disabled(canCreate == false)
        }
      }
    }
    .frame(minWidth: 560, minHeight: 420)
  }

  private var session: BrokerCapacitySheetSession? {
    store.capacitySheet
  }

  private var selectedProject: BrokerProjectSummary? {
    guard let projectId = session?.projectId else {
      return nil
    }
    return store.capacityProjects.first { $0.projectId == projectId }
  }

  private var projectSelection: Binding<String> {
    Binding(
      get: { session?.projectId ?? "" },
      set: { projectId in
        store.updateCapacitySelection(projectId: projectId, purposeId: nil)
      }
    )
  }

  private var purposeSelection: Binding<String?> {
    Binding(
      get: { session?.purposeId },
      set: { purposeId in
        guard let projectId = session?.projectId else {
          return
        }
        store.updateCapacitySelection(projectId: projectId, purposeId: purposeId)
      }
    )
  }

  private var canCreate: Bool {
    guard store.isApplyingAction == false,
          session?.isLoading == false,
          session?.previewError == nil,
          let preview = session?.preview,
          preview.status == "changes_required",
          preview.actions.isEmpty == false
    else {
      return false
    }
    return true
  }

  private var createTitle: String {
    let count = session?.preview?.actions.count ?? 0
    if count == 1 {
      return "Create 1 simulator"
    }
    return "Create \(count) simulators"
  }

  @ViewBuilder
  private var projectSection: some View {
    Picker("Project", selection: projectSelection) {
      ForEach(store.capacityProjects) { project in
        Text(project.projectName).tag(project.projectId)
      }
    }
  }

  @ViewBuilder
  private var purposeSection: some View {
    Picker("Purpose", selection: purposeSelection) {
      Text("All purposes").tag(String?.none)
      ForEach(selectedProject?.purposes ?? []) { purpose in
        Text(purpose.displayName).tag(Optional(purpose.purposeId))
      }
    }
  }

  @ViewBuilder
  private var resultSection: some View {
    if session?.isLoading == true {
      ProgressView("Checking which simulators are missing")
        .frame(maxWidth: .infinity, alignment: .leading)
    } else if let previewError = session?.previewError {
      Text(previewError)
        .foregroundStyle(.red)
    } else if let preview = session?.preview {
      switch preview.status {
      case "changes_required":
        Text(createSummary(count: preview.actions.count))
        ForEach(preview.actions) { action in
          VStack(alignment: .leading, spacing: 4) {
            Text(actionTitle(action))
              .font(.headline)
            Text("Capability \(action.requirement.capability) · \(action.requirement.resetPolicy)")
              .font(.subheadline)
              .foregroundStyle(.secondary)
            Text("Purposes \(action.purposeIds.joined(separator: ", "))")
              .font(.subheadline)
              .foregroundStyle(.secondary)
          }
          .accessibilityElement(children: .combine)
        }
      case "blocked":
        Text("This plan cannot create simulators.")
        ForEach(preview.blockedReasons) { blocked in
          VStack(alignment: .leading, spacing: 4) {
            Text(blocked.purposeId ?? "Project")
              .font(.headline)
            Text(blocked.blockingReasons.map(\.code).joined(separator: ", "))
            Text(blocked.recommendedAction)
              .font(.subheadline)
              .foregroundStyle(.secondary)
          }
          .accessibilityElement(children: .combine)
        }
      case "no_changes":
        Text("This project already has the simulators it declares.")
      default:
        Text("Capacity preview returned \(preview.status).")
      }
    }
  }

  private func createSummary(count: Int) -> String {
    if count == 1 {
      return "1 simulator will be created."
    }
    return "\(count) simulators will be created."
  }

  private func actionTitle(_ action: BrokerCapacityAction) -> String {
    let version = action.requirement.iosVersion ?? "newest compatible"
    return "\(action.requirement.deviceFamily) · iOS \(version)"
  }
}
