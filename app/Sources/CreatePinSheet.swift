import SwiftUI

struct CreatePinSheet: View {
  @Environment(\.dismiss) private var dismiss

  let projects: [BrokerProjectSummary]
  let readModel: BrokerDashboardReadModel
  let simulator: BrokerSimulator
  let onConfirm: (BrokerProjectSummary, BrokerProjectPurposeSummary, String) -> Void

  @State private var note = ""
  @State private var selectedProjectId: String
  @State private var selectedPurposeId: String

  init(
    projects: [BrokerProjectSummary],
    readModel: BrokerDashboardReadModel,
    simulator: BrokerSimulator,
    onConfirm: @escaping (BrokerProjectSummary, BrokerProjectPurposeSummary, String) -> Void
  ) {
    self.projects = projects
    self.readModel = readModel
    self.simulator = simulator
    self.onConfirm = onConfirm

    let firstProject = projects.first
    let firstPurpose = firstProject.flatMap { project in
      readModel.eligiblePinPurposes(for: simulator, projectId: project.projectId).first
    }
    _selectedProjectId = State(initialValue: firstProject?.projectId ?? "")
    _selectedPurposeId = State(initialValue: firstPurpose?.purposeId ?? "")
  }

  private var selectedProject: BrokerProjectSummary? {
    projects.first { $0.projectId == selectedProjectId }
  }

  private var eligiblePurposes: [BrokerProjectPurposeSummary] {
    readModel.eligiblePinPurposes(for: simulator, projectId: selectedProjectId)
  }

  private var selectedPurpose: BrokerProjectPurposeSummary? {
    eligiblePurposes.first { $0.purposeId == selectedPurposeId }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      Text("Create durable pin")
        .font(.title2.weight(.semibold))

      if projects.isEmpty {
        Text("No known broker-aware project purpose currently matches \(simulator.alias). Register a repo with broker commands first, then return here.")
          .foregroundStyle(.secondary)
      } else {
        Picker("Project", selection: $selectedProjectId) {
          ForEach(projects) { project in
            Text(project.projectName).tag(project.projectId)
          }
        }
        .onChange(of: selectedProjectId) { _, newValue in
          let firstPurposeId = readModel.eligiblePinPurposes(for: simulator, projectId: newValue).first?.purposeId ?? ""
          selectedPurposeId = firstPurposeId
        }

        Picker("Purpose", selection: $selectedPurposeId) {
          ForEach(eligiblePurposes) { purpose in
            Text(purpose.displayName).tag(purpose.purposeId)
          }
        }

        if let selectedProject {
          VStack(alignment: .leading, spacing: 8) {
            Text(selectedProject.projectFilePath ?? "—")
              .font(.system(.caption, design: .monospaced))
              .textSelection(.enabled)
              .foregroundStyle(.secondary)
            if let selectedPurpose {
              Text("Capability: \(selectedPurpose.capability ?? "—")")
                .font(.subheadline)
                .foregroundStyle(.secondary)
              if let requires = selectedPurpose.requires {
                Text(projectPurposeRequiresText(requires))
                  .font(.subheadline)
                  .foregroundStyle(.secondary)
              }
            }
          }
        }

        TextField("Optional note", text: $note, axis: .vertical)
          .lineLimit(2 ... 4)
          .textFieldStyle(.roundedBorder)
      }

      HStack {
        Spacer()
        Button("Cancel") {
          dismiss()
        }
        if let selectedProject, let selectedPurpose {
          Button("Create pin") {
            onConfirm(selectedProject, selectedPurpose, note)
            dismiss()
          }
          .buttonStyle(.borderedProminent)
        }
      }
    }
    .padding(24)
    .frame(minWidth: 460)
    .groupBoxStyle(DashboardPanelStyle())
  }
}
