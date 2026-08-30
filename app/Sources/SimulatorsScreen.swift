import SwiftUI

struct SimulatorsScreen: View {
  @Bindable var store: BrokerDashboardStore

  var body: some View {
    if let readModel = store.readModel {
      let simulators = readModel.filteredSimulators(using: store.simulatorFilters)
      GeometryReader { screenProxy in
        let masterWidth = min(820, max(560, screenProxy.size.width - 420))
        HStack(spacing: 0) {
          masterPane(readModel: readModel, simulators: simulators)
            .frame(width: masterWidth, height: screenProxy.size.height, alignment: .topLeading)

          Divider()

          SimulatorDetailView(
            readModel: readModel,
            store: store,
            selectedAlias: store.inspectedSimulatorAlias
          )
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .frame(
          width: screenProxy.size.width,
          height: screenProxy.size.height,
          alignment: .topLeading
        )
      }
      .frame(
        minWidth: 920,
        idealWidth: 1020,
        maxWidth: .infinity,
        minHeight: 0,
        idealHeight: 684,
        maxHeight: .infinity
      )
      .searchable(
        text: $store.simulatorSearchText,
        placement: .toolbar,
        prompt: "Search alias, project, purpose, actor, or drift"
      )
    }
  }

  @ViewBuilder
  private func masterPane(
    readModel: BrokerDashboardReadModel,
    simulators: [BrokerSimulator]
  ) -> some View {
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
          .width(min: 85, ideal: 100, max: 115)
          TableColumn("Runtime") { simulator in
            Text("\(simulator.deviceFamily) · iOS \(simulator.iosVersion)")
          }
          .width(min: 75, ideal: 85, max: 100)
          TableColumn("Status") { simulator in
            VStack(alignment: .leading, spacing: 6) {
              StatusPill(color: healthTint(simulator.health), title: simulator.health)
                .fixedSize(horizontal: true, vertical: false)
              StatusPill(color: powerTint(simulator.powerState), title: simulator.powerState)
                .fixedSize(horizontal: true, vertical: false)
            }
          }
          .width(min: 120, ideal: 130, max: 140)
          TableColumn("Assignment") { simulator in
            VStack(alignment: .leading, spacing: 2) {
              Text(simulator.activeLeaseSummary?.projectId ?? simulator.pin?.projectId ?? "Available")
              Text(simulator.activeLeaseSummary?.purposeId ?? simulator.pin?.purposeId ?? "—")
                .font(.caption)
                .foregroundStyle(.secondary)
            }
          }
          .width(min: 80, ideal: 90, max: 105)
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
          .width(min: 60, ideal: 70, max: 85)
        }
      }
    }
    .padding(24)
  }

  @ViewBuilder
  private func filterBar(readModel: BrokerDashboardReadModel) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Grid(alignment: .leading, horizontalSpacing: 20, verticalSpacing: 10) {
        GridRow {
          healthPicker
          projectPicker(readModel: readModel)
        }
        GridRow {
          purposePicker(readModel: readModel)
          actorPicker(readModel: readModel)
        }
      }
      .pickerStyle(.menu)
      .controlSize(.large)
    }
  }

  private var healthPicker: some View {
    Picker("Health", selection: $store.simulatorHealthFilter) {
      ForEach(BrokerHealthFilter.allCases) { filter in
        Text(filter.title).tag(filter)
      }
    }
  }

  private func projectPicker(readModel: BrokerDashboardReadModel) -> some View {
    Picker("Project", selection: $store.simulatorProjectFilter) {
      Text("All projects").tag(BrokerDashboardReadModel.allSelection)
      ForEach(readModel.snapshot.projects) { project in
        Text(project.projectName).tag(project.projectId)
      }
    }
  }

  private func purposePicker(readModel: BrokerDashboardReadModel) -> some View {
    Picker("Purpose", selection: $store.simulatorPurposeFilter) {
      Text("All purposes").tag(BrokerDashboardReadModel.allSelection)
      ForEach(readModel.purposeIds, id: \.self) { purposeId in
        Text(purposeId).tag(purposeId)
      }
    }
  }

  private func actorPicker(readModel: BrokerDashboardReadModel) -> some View {
    Picker("Actor", selection: $store.simulatorActorFilter) {
      Text("All actors").tag(BrokerDashboardReadModel.allSelection)
      ForEach(readModel.actorTypes, id: \.self) { actorType in
        Text(actorType).tag(actorType)
      }
    }
  }
}
