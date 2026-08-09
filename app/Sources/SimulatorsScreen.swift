import SwiftUI

struct SimulatorsScreen: View {
  @Bindable var store: BrokerDashboardStore

  var body: some View {
    if let readModel = store.readModel {
      let simulators = readModel.filteredSimulators(using: store.simulatorFilters)
      HSplitView {
        VStack(alignment: .leading, spacing: 16) {
          filterBar(readModel: readModel)

          HStack(alignment: .center) {
            Text("\(simulators.count) of \(readModel.snapshot.simulators.count) simulators")
              .font(.headline)
            if store.hasActiveSimulatorFilters {
              Label("Filters active", systemImage: "line.3.horizontal.decrease.circle.fill")
                .font(.subheadline)
                .foregroundStyle(.secondary)
              Button("Clear filters") {
                store.clearSimulatorFilters()
              }
              .buttonStyle(.link)
            }
            Spacer()
            Text("Search matches alias, project, purpose, actor, power, and drift")
              .font(.subheadline)
              .foregroundStyle(.secondary)
          }

          if simulators.isEmpty {
            ContentUnavailableView.search(text: store.simulatorSearchText)
              .frame(maxWidth: .infinity, maxHeight: .infinity)
          } else {
            Table(simulators, selection: $store.inspectedSimulatorAlias) {
              TableColumn("Simulator") { simulator in
                VStack(alignment: .leading, spacing: 2) {
                  Text(simulator.displayName)
                    .font(.headline)
                  Text(simulator.alias)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
              }
              TableColumn("Runtime") { simulator in
                Text("\(simulator.deviceFamily) · iOS \(simulator.iosVersion)")
              }
              TableColumn("Status") { simulator in
                HStack(spacing: 8) {
                  StatusPill(color: healthTint(simulator.health), title: simulator.health)
                  StatusPill(color: powerTint(simulator.powerState), title: simulator.powerState)
                }
              }
              TableColumn("Assignment") { simulator in
                VStack(alignment: .leading, spacing: 2) {
                  Text(simulator.activeLeaseSummary?.projectId ?? simulator.pin?.projectId ?? "Available")
                  Text(simulator.activeLeaseSummary?.purposeId ?? simulator.pin?.purposeId ?? "—")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
              }
              TableColumn("Holder") { simulator in
                if let leaseSummary = simulator.activeLeaseSummary {
                  Text("\(leaseSummary.actorType) · \(leaseSummary.actorId)")
                } else if readModel.pin(for: simulator.alias) != nil {
                  Text("Pinned")
                    .foregroundStyle(.secondary)
                } else {
                  Text("—")
                }
              }
            }
          }
        }
        .frame(minWidth: 700)
        .padding(24)

        SimulatorDetailView(
          readModel: readModel,
          store: store,
          selectedAlias: store.inspectedSimulatorAlias
        )
        .frame(minWidth: 320)
      }
      .searchable(
        text: $store.simulatorSearchText,
        placement: .toolbar,
        prompt: "Search alias, project, purpose, actor, or drift"
      )
    }
  }

  @ViewBuilder
  private func filterBar(readModel: BrokerDashboardReadModel) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 12) {
        Picker("Health", selection: $store.simulatorHealthFilter) {
          ForEach(BrokerHealthFilter.allCases) { filter in
            Text(filter.title).tag(filter)
          }
        }
        Picker("Project", selection: $store.simulatorProjectFilter) {
          Text("All projects").tag(BrokerDashboardReadModel.allSelection)
          ForEach(readModel.snapshot.projects) { project in
            Text(project.projectName).tag(project.projectId)
          }
        }
        Picker("Purpose", selection: $store.simulatorPurposeFilter) {
          Text("All purposes").tag(BrokerDashboardReadModel.allSelection)
          ForEach(readModel.purposeIds, id: \.self) { purposeId in
            Text(purposeId).tag(purposeId)
          }
        }
        Picker("Actor", selection: $store.simulatorActorFilter) {
          Text("All actors").tag(BrokerDashboardReadModel.allSelection)
          ForEach(readModel.actorTypes, id: \.self) { actorType in
            Text(actorType).tag(actorType)
          }
        }
      }
      .pickerStyle(.menu)
      .controlSize(.large)
    }
  }
}
