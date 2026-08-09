import SwiftUI

struct EventsScreen: View {
  @Bindable var store: BrokerDashboardStore

  var body: some View {
    if let readModel = store.readModel {
      HSplitView {
        List(readModel.snapshot.recentEvents, selection: $store.inspectedEventId) { event in
          VStack(alignment: .leading, spacing: 4) {
            Text(event.type)
              .font(.headline)
            Text([event.alias, event.projectId, event.purposeId].compactMap { $0 }.joined(separator: " · "))
              .foregroundStyle(.secondary)
            Text(timestampDisplay(event.timestamp) ?? event.timestamp)
              .font(.caption)
              .foregroundStyle(.secondary)
          }
          .tag(event.eventId)
        }
        .listStyle(.sidebar)
        .frame(minWidth: 360)

        if let event = readModel.event(eventId: store.inspectedEventId) {
          ScrollView {
            VStack(alignment: .leading, spacing: 18) {
              Text(event.type)
                .font(.title2.weight(.semibold))

              GroupBox("Event detail") {
                VStack(alignment: .leading, spacing: 10) {
                  LabeledContent("Timestamp") { Text(timestampDisplay(event.timestamp) ?? event.timestamp) }
                  LabeledContent("Alias") { Text(event.alias ?? "—") }
                  LabeledContent("Project") { Text(event.projectId ?? "—") }
                  LabeledContent("Purpose") { Text(event.purposeId ?? "—") }
                  LabeledContent("Actor type") { Text(event.actorType ?? "—") }
                  LabeledContent("Actor ID") { Text(event.actorId ?? "—") }
                  LabeledContent("Lease ID") {
                    Text(event.leaseId ?? "—")
                      .font(.system(.body, design: .monospaced))
                      .textSelection(.enabled)
                  }
                  LabeledContent("Event ID") {
                    Text(event.eventId)
                      .font(.system(.body, design: .monospaced))
                      .textSelection(.enabled)
                  }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
              }
            }
            .padding(24)
          }
          .groupBoxStyle(DashboardPanelStyle())
        } else {
          ContentUnavailableView("Select an event", systemImage: "clock.arrow.trianglehead.counterclockwise.rotate.90")
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
      }
    }
  }
}
