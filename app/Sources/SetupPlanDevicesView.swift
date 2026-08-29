import SwiftUI

struct SetupPlanDevicesView: View {
  let devices: [BrokerSetupDevicePlan]

  var body: some View {
    GroupBox("Managed Simulator pool — \(devices.count) devices") {
      VStack(alignment: .leading, spacing: 12) {
        ForEach(devices) { device in
          HStack(alignment: .top, spacing: 12) {
            Image(systemName: device.deviceFamily == "iPad" ? "ipad" : "iphone")
              .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
              Text(device.alias)
                .font(.headline)
              Text("\(device.deviceTypeName) · iOS \(device.runtimeVersion)")
              Text(resetDescription(for: device))
                .foregroundStyle(.secondary)
            }
            Spacer()
            Label(
              device.action == "reuse" ? "Reuse" : "Create",
              systemImage: device.action == "reuse" ? "arrow.trianglehead.2.clockwise" : "plus.circle.fill"
            )
            .foregroundStyle(device.action == "reuse" ? .secondary : .primary)
          }
          .accessibilityElement(children: .combine)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private func resetDescription(for device: BrokerSetupDevicePlan) -> String {
    device.resetPolicy == "erase-on-acquire"
      ? "Erased before each resettable lease."
      : "Keeps Simulator data between uses."
  }
}
