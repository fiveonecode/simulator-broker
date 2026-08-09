import SwiftUI

struct ProjectsScreen: View {
  @Bindable var store: BrokerDashboardStore

  var body: some View {
    if let readModel = store.readModel {
      if readModel.snapshot.projects.isEmpty {
        ScrollView {
          VStack(alignment: .leading, spacing: 18) {
            Text("No broker-aware repos yet")
              .font(.title2.weight(.semibold))
            Text("This Mac is ready, but no repo has registered a broker project file yet. Onboard a repo with the commands below, then refresh this view.")
              .foregroundStyle(.secondary)
              .fixedSize(horizontal: false, vertical: true)
            GroupBox("Next repo to onboard") {
              RepoOnboardingGuideView(
                cliPath: store.onboardingCLIPath,
                envHelperPath: store.envHelperPath
              )
            }
          }
          .padding(24)
        }
        .groupBoxStyle(DashboardPanelStyle())
      } else {
        HSplitView {
          List(readModel.snapshot.projects, selection: $store.inspectedProjectId) { project in
            VStack(alignment: .leading, spacing: 4) {
              Text(project.projectName)
                .font(.headline)
              Text("\(project.activeLeaseCount) active leases · \(project.pinnedAliasCount) pins")
                .foregroundStyle(.secondary)
            }
            .tag(project.projectId)
          }
          .listStyle(.sidebar)
          .frame(minWidth: 280)

          if let project = readModel.project(projectId: store.inspectedProjectId) {
            ScrollView {
              VStack(alignment: .leading, spacing: 18) {
                Text(project.projectName)
                  .font(.title2.weight(.semibold))

                GroupBox("Project activity") {
                  VStack(alignment: .leading, spacing: 10) {
                    LabeledContent("Project ID") { Text(project.projectId) }
                    LabeledContent("Project file") {
                      Text(project.projectFilePath ?? "—")
                        .font(.system(.body, design: .monospaced))
                        .textSelection(.enabled)
                    }
                    LabeledContent("Repo root") {
                      Text(project.repoRoot ?? "—")
                        .font(.system(.body, design: .monospaced))
                        .textSelection(.enabled)
                    }
                    LabeledContent("Active leases") { Text("\(project.activeLeaseCount)") }
                    LabeledContent("Pinned aliases") { Text("\(project.pinnedAliasCount)") }
                    LabeledContent("Last event") { Text(timestampDisplay(project.lastEventAt) ?? "—") }
                    LabeledContent("Aliases") { Text(project.activeAliases.joined(separator: ", ")) }
                  }
                  .frame(maxWidth: .infinity, alignment: .leading)
                }

                GroupBox("Purposes") {
                  VStack(alignment: .leading, spacing: 12) {
                    ForEach(project.purposes) { purpose in
                      VStack(alignment: .leading, spacing: 6) {
                        HStack(alignment: .top) {
                          VStack(alignment: .leading, spacing: 2) {
                            Text(purpose.displayName)
                              .font(.headline)
                            Text(purpose.purposeId)
                              .font(.caption)
                              .foregroundStyle(.secondary)
                          }
                          Spacer()
                          Text("\(purpose.activeLeaseCount) leases · \(purpose.pinnedAliasCount) pins")
                            .foregroundStyle(.secondary)
                        }
                        if let capability = purpose.capability {
                          Text("Capability: \(capability)")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        }
                        if let requires = purpose.requires {
                          Text(projectPurposeRequiresText(requires))
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        }
                      }
                    }
                  }
                  .frame(maxWidth: .infinity, alignment: .leading)
                }
              }
              .padding(24)
            }
            .groupBoxStyle(DashboardPanelStyle())
          } else {
            ContentUnavailableView("Select a project", systemImage: "shippingbox")
              .frame(maxWidth: .infinity, maxHeight: .infinity)
          }
        }
      }
    }
  }
}
