import SwiftUI

struct OverviewScreen: View {
  @Bindable var store: BrokerDashboardStore

  var body: some View {
    if let snapshot = store.snapshot, let readModel = store.readModel {
      ScrollView {
        VStack(alignment: .leading, spacing: 24) {
          HighlightBanner(
            color: connectionTint(store.commandStatusText),
            symbolName: store.canSendCommands ? "bolt.horizontal.circle.fill" : "tray.full",
            title: store.commandStatusText,
            message: "\(snapshot.hostId) · \(readModel.leaseReadyAliasCount) aliases ready for new work · \(readModel.bootedAliasCount) booted right now"
          )

          LazyVGrid(
            columns: [GridItem(.adaptive(minimum: 220), spacing: 16)],
            spacing: 16
          ) {
            MetricCard(
              accent: .blue,
              subtitle: "Leased aliases across the broker pool",
              title: "Aliases in use",
              value: "\(snapshot.overview.leasedAliases) / \(snapshot.overview.totalAliases)"
            )
            MetricCard(
              accent: .orange,
              subtitle: "Durable operator reservations",
              title: "Pinned aliases",
              value: "\(snapshot.overview.pinnedAliases)"
            )
            MetricCard(
              accent: .red,
              subtitle: "Aliases blocked from new leases",
              title: "Unhealthy aliases",
              value: "\(snapshot.overview.unhealthyAliases)"
            )
            MetricCard(
              accent: .green,
              subtitle: "Current lease saturation",
              title: "Pool saturation",
              value: "\(Int(snapshot.overview.leaseSaturation * 100))%"
            )
          }

          AutomaticShutdownSection(store: store, idle: snapshot.idle)

          GroupBox("Broker source") {
            LazyVGrid(
              columns: [
                GridItem(.flexible(minimum: 260), spacing: 18),
                GridItem(.flexible(minimum: 260), spacing: 18),
              ],
              alignment: .leading,
              spacing: 12
            ) {
              LabeledContent("Host", value: snapshot.hostId)
              LabeledContent("Service", value: store.serviceStatusText)
              LabeledContent("Last snapshot", value: store.generatedAtText)
              LabeledContent("Booted aliases", value: "\(readModel.bootedAliasCount)")
              LabeledContent("Ready aliases", value: "\(readModel.leaseReadyAliasCount)")
              LabeledContent("State root") {
                Text(snapshot.stateRoot)
                  .font(.system(.body, design: .monospaced))
                  .textSelection(.enabled)
              }
            }
          }

          if snapshot.projects.isEmpty {
            GroupBox("Next repo to onboard") {
              RepoOnboardingGuideView(
                cliPath: store.onboardingCLIPath,
                envHelperPath: store.envHelperPath
              )
            }
          }

          GroupBox("Needs attention") {
            if readModel.repairNeededSimulators.isEmpty, readModel.driftedSimulators.isEmpty {
              HighlightBanner(
                color: .green,
                symbolName: "checkmark.circle.fill",
                title: "No blocking issues",
                message: "All aliases are healthy and ready for new broker work."
              )
            } else {
              VStack(alignment: .leading, spacing: 12) {
                ForEach(readModel.repairNeededSimulators.prefix(6)) { simulator in
                  OverviewAttentionRow(
                    simulator: simulator,
                    title: "Repair needed",
                    subtitle: simulator.driftReason ?? "Broker repair is required before this alias can be reused.",
                    onSelect: inspectSimulator
                  )
                }

                ForEach(readModel.driftedSimulators.prefix(6)) { simulator in
                  OverviewAttentionRow(
                    simulator: simulator,
                    title: "State drift detected",
                    subtitle: simulator.driftReason ?? "Observed state differs from the broker record.",
                    onSelect: inspectSimulator
                  )
                }
              }
            }
          }

          GroupBox("Active leases") {
            if snapshot.activeLeases.isEmpty {
              Text("No active leases.")
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
              VStack(alignment: .leading, spacing: 12) {
                ForEach(snapshot.activeLeases.prefix(8)) { lease in
                  OverviewLeaseRow(lease: lease, onSelect: inspectSimulator)
                }
              }
            }
          }
        }
        .padding(24)
        .frame(maxWidth: 1100, alignment: .leading)
      }
      .groupBoxStyle(DashboardPanelStyle())
    }
  }

  private func inspectSimulator(alias: String) {
    store.selectedPane = .simulators
    store.inspectedSimulatorAlias = alias
  }
}

private struct OverviewAttentionRow: View {
  let simulator: BrokerSimulator
  let title: String
  let subtitle: String
  let onSelect: (String) -> Void

  var body: some View {
    Button {
      onSelect(simulator.alias)
    } label: {
      HStack(alignment: .top, spacing: 12) {
        Image(systemName: "wrench.and.screwdriver.fill")
          .foregroundStyle(healthTint(simulator.health))
        VStack(alignment: .leading, spacing: 4) {
          Text("\(simulator.alias) · \(title)")
            .font(.headline)
          Text(subtitle)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        Spacer()
        StatusPill(color: healthTint(simulator.health), title: simulator.health)
      }
      .padding(14)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(.background.secondary.opacity(0.6), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
    .buttonStyle(.plain)
  }
}

private struct OverviewLeaseRow: View {
  let lease: BrokerLease
  let onSelect: (String) -> Void

  var body: some View {
    Button {
      onSelect(lease.alias)
    } label: {
      HStack(alignment: .top, spacing: 12) {
        VStack(alignment: .leading, spacing: 6) {
          Text("\(lease.alias) · \(lease.projectName)")
            .font(.headline)
          Text("\(lease.actorType) · \(lease.actorId) · \(lease.purposeId)")
            .foregroundStyle(.secondary)
          if let sessionDir = lease.sessionDir {
            Text(sessionDir)
              .font(.system(.caption, design: .monospaced))
              .foregroundStyle(.secondary)
              .lineLimit(1)
          }
        }
        Spacer()
        VStack(alignment: .trailing, spacing: 8) {
          StatusPill(color: .blue, title: lease.displayName)
          Text(timestampDisplay(lease.startedAt) ?? lease.startedAt)
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }
      .padding(14)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(.background.secondary.opacity(0.6), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
    .buttonStyle(.plain)
  }
}
