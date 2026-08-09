import SwiftUI

struct SimulatorDetailView: View {
  let readModel: BrokerDashboardReadModel
  @Bindable var store: BrokerDashboardStore
  let selectedAlias: String?

  private var simulator: BrokerSimulator? {
    readModel.simulator(alias: selectedAlias)
  }

  private var lease: BrokerLease? {
    readModel.lease(for: selectedAlias)
  }

  private var pin: BrokerPin? {
    readModel.pin(for: selectedAlias)
  }

  private var allowsLifecycleMutation: Bool {
    guard let simulator else {
      return false
    }
    return simulator.health == "healthy" || simulator.health == "state-drift"
  }

  var body: some View {
    if let simulator {
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          headerSection(simulator)
          simulatorStatusBanner(simulator)
          identitySection(simulator)
          lifecycleSection(simulator)
          brokerActionsSection(simulator)
          activeLeaseSection
          pinSection
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .groupBoxStyle(DashboardPanelStyle())
      .simulatorActionConfirmationDialogs(store: store)
      .sheet(item: $store.pendingCreatePinRequest, content: createPinSheet)
      .sheet(item: $store.pendingOverrideRequest, content: overrideSheet)
    } else {
      ContentUnavailableView("Select a simulator", systemImage: "rectangle.on.rectangle.angled")
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
  }

  private func headerSection(_ simulator: BrokerSimulator) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(simulator.displayName)
        .font(.title2.weight(.semibold))
      Text("\(simulator.alias) · \(simulator.deviceFamily) · iOS \(simulator.iosVersion)")
        .font(.subheadline)
        .foregroundStyle(.secondary)
      HStack {
        StatusPill(color: healthTint(simulator.health), title: simulator.health)
        StatusPill(color: powerTint(simulator.powerState), title: simulator.powerState)
        if lease != nil {
          StatusPill(color: .blue, title: "Leased")
        } else if pin != nil {
          StatusPill(color: .orange, title: "Pinned")
        } else {
          StatusPill(color: .green, title: "Available")
        }
      }
    }
  }

  private func identitySection(_ simulator: BrokerSimulator) -> some View {
    GroupBox("Identity") {
      VStack(alignment: .leading, spacing: 10) {
        LabeledContent("Alias") { Text(simulator.alias) }
        LabeledContent("Device family") { Text(simulator.deviceFamily) }
        LabeledContent("Runtime") { Text("iOS \(simulator.iosVersion)") }
        LabeledContent("Simulator ID") {
          Text(simulator.simulatorId)
            .font(.system(.body, design: .monospaced))
            .textSelection(.enabled)
        }
        if let driftReason = simulator.driftReason {
          LabeledContent("Drift reason") { Text(driftReason) }
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private func lifecycleSection(_ simulator: BrokerSimulator) -> some View {
    GroupBox("Lifecycle") {
      VStack(alignment: .leading, spacing: 10) {
        LabeledContent("Booted") { Text(timestampDisplay(simulator.lastBootedAt) ?? "—") }
        LabeledContent("Shutdown") { Text(timestampDisplay(simulator.lastShutdownAt) ?? "—") }
        LabeledContent("Erased") { Text(timestampDisplay(simulator.lastErasedAt) ?? "—") }
        LabeledContent("Repaired") { Text(timestampDisplay(simulator.lastRepairedAt) ?? "—") }
        LabeledContent("Reset policy") { Text(simulator.resetPolicy ?? "none") }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private func brokerActionsSection(_ simulator: BrokerSimulator) -> some View {
    GroupBox("Broker actions") {
      VStack(alignment: .leading, spacing: 14) {
        if store.canSendCommands {
          let primaryLifecycleAction: BrokerLifecycleAction = simulator.powerState == "booted" ? .shutdown : .boot
          let primaryLifecycleLabel = simulator.powerState == "booted" ? "Shutdown" : "Boot"

          HStack(spacing: 10) {
            Button(primaryLifecycleLabel) {
              store.requestLifecycleAction(primaryLifecycleAction)
            }
            .buttonStyle(.borderedProminent)
            .disabled(
              primaryLifecycleAction == .shutdown
                ? store.commandAvailability.canShutdownSimulator == false
                : store.commandAvailability.canBootSimulator == false
            )

            Button("Repair") {
              store.requestLifecycleAction(.repair)
            }
            .buttonStyle(.bordered)
            .disabled(store.commandAvailability.canRepairSimulator == false)

            Button("Erase") {
              store.requestLifecycleAction(.erase)
            }
            .buttonStyle(.bordered)
            .tint(.red)
            .disabled(store.commandAvailability.canEraseSimulator == false)
          }

          HStack(spacing: 10) {
            if lease != nil {
              Button("Release lease", role: .destructive) {
                store.requestReleaseLease()
              }
              .buttonStyle(.bordered)
              .disabled(store.commandAvailability.canReleaseLease == false)
            }

            if pin != nil {
              Button("Clear pin", role: .destructive) {
                store.requestClearPin()
              }
              .buttonStyle(.bordered)
              .disabled(store.commandAvailability.canClearPin == false)
            } else {
              Button("Create pin") {
                store.requestCreatePin()
              }
              .buttonStyle(.bordered)
              .disabled(store.commandAvailability.canCreatePin == false)
            }
          }

          Text(
            allowsLifecycleMutation
              ? "Actions go through brokerd, are audited, and refresh this view automatically."
              : "Repair is required before boot, shutdown, or erase will succeed for this alias."
          )
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .lineLimit(nil)
          .fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: .infinity, alignment: .leading)
        } else {
          Text("Start brokerd to enable lifecycle, release, and pin actions from this app.")
            .foregroundStyle(.secondary)
            .lineLimit(nil)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private var activeLeaseSection: some View {
    GroupBox("Active lease") {
      if let lease {
        VStack(alignment: .leading, spacing: 10) {
          LabeledContent("Project") { Text(lease.projectName) }
          LabeledContent("Purpose") { Text(lease.purposeId) }
          LabeledContent("Actor") { Text("\(lease.actorType) · \(lease.actorId)") }
          LabeledContent("Job") { Text(lease.jobId ?? "—") }
          LabeledContent("Session dir") {
            Text(lease.sessionDir ?? "—")
              .font(.system(.body, design: .monospaced))
              .textSelection(.enabled)
          }
          LabeledContent("Artifact") {
            Text(lease.artifactPath ?? "—")
              .font(.system(.body, design: .monospaced))
              .textSelection(.enabled)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      } else {
        Text("This alias is currently available.")
          .foregroundStyle(.secondary)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
  }

  private var pinSection: some View {
    GroupBox("Pin") {
      if let pin {
        VStack(alignment: .leading, spacing: 10) {
          LabeledContent("Project") { Text(pin.projectName) }
          LabeledContent("Purpose") { Text(pin.purposeId ?? "—") }
          LabeledContent("Pinned by") { Text("\(pin.actorType) · \(pin.actorId)") }
          LabeledContent("Created") { Text(timestampDisplay(pin.createdAt) ?? pin.createdAt) }
          if let note = pin.note, note.isEmpty == false {
            LabeledContent("Note") { Text(note) }
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      } else {
        Text("No durable pin on this alias.")
          .foregroundStyle(.secondary)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
  }

  @ViewBuilder
  private func createPinSheet(for request: BrokerPendingCreatePinRequest) -> some View {
    if let requestSimulator = readModel.simulator(alias: request.alias) {
      CreatePinSheet(
        projects: readModel.eligiblePinProjects(for: requestSimulator),
        readModel: readModel,
        simulator: requestSimulator
      ) { project, purpose, note in
        submitCreatePin(request: request, project: project, purpose: purpose, note: note)
      }
    } else {
      ContentUnavailableView(
        "Simulator unavailable",
        systemImage: "rectangle.on.rectangle.angled",
        description: Text("Refresh the broker snapshot and select a simulator again before creating a pin.")
      )
      .padding(24)
    }
  }

  private func overrideSheet(for overrideRequest: BrokerLifecycleOverrideRequest) -> some View {
    OverrideConfirmationSheet(overrideRequest: overrideRequest) { reason in
      store.confirmOverrideRequest(reason: reason)
    }
  }

  private func submitCreatePin(
    request: BrokerPendingCreatePinRequest,
    project: BrokerProjectSummary,
    purpose: BrokerProjectPurposeSummary,
    note: String
  ) {
    store.pendingCreatePinRequest = nil

    Task { @MainActor in
      do {
        try await store.createPin(alias: request.alias, project: project, purpose: purpose, note: note)
      } catch {
        store.lastErrorMessage = error.localizedDescription
      }
    }
  }

  @ViewBuilder
  private func simulatorStatusBanner(_ simulator: BrokerSimulator) -> some View {
    if simulator.health == "repair-needed" || simulator.health == "repairing" {
      HighlightBanner(
        color: .red,
        symbolName: "wrench.and.screwdriver.fill",
        title: "Repair required",
        message: simulator.driftReason ?? "Broker repair must complete before this alias can safely take new work."
      )
    } else if simulator.health == "state-drift" {
      HighlightBanner(
        color: .orange,
        symbolName: "exclamationmark.triangle.fill",
        title: "Observed state drift",
        message: simulator.driftReason ?? "The simulator still works, but broker and device state have diverged."
      )
    } else if let lease {
      HighlightBanner(
        color: .blue,
        symbolName: "person.crop.rectangle.stack.fill",
        title: "Currently leased",
        message: "\(lease.actorType) \(lease.actorId) is using this alias for \(lease.projectName) · \(lease.purposeId)."
      )
    } else if let pin {
      HighlightBanner(
        color: .orange,
        symbolName: "pin.fill",
        title: "Durably reserved",
        message: "\(pin.projectName) keeps this alias pinned for \(pin.purposeId ?? "general use")."
      )
    }
  }
}
