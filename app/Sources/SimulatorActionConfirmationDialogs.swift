import SwiftUI

struct SimulatorActionConfirmationDialogs: ViewModifier {
  let store: BrokerDashboardStore

  func body(content: Content) -> some View {
    content
      .confirmationDialog(
        Text("Clear durable pin?"),
        isPresented: clearPinPresented,
        presenting: store.pendingClearPinRequest
      ) { _ in
        Button("Clear pin", role: .destructive) {
          store.confirmClearPin()
        }
      } message: { request in
        Text("This makes \(request.alias) available for other projects unless it is actively leased.")
      }
      .confirmationDialog(
        Text("Release active lease?"),
        isPresented: releaseLeasePresented,
        presenting: store.pendingReleaseLeaseRequest
      ) { _ in
        Button("Release lease", role: .destructive) {
          store.confirmReleaseLease()
        }
      } message: { request in
        Text("This immediately releases \(request.lease.alias) from \(request.lease.projectName) · \(request.lease.purposeId).")
      }
      .confirmationDialog(
        lifecycleConfirmationTitle(for: store.pendingLifecycleRequest?.action),
        isPresented: lifecycleRequestPresented,
        presenting: store.pendingLifecycleRequest
      ) { request in
        Button(request.action.confirmationButtonTitle, role: .destructive) {
          store.confirmPendingLifecycleAction()
        }
      } message: { request in
        Text(lifecycleConfirmationMessage(for: request.action, alias: request.alias))
      }
  }

  private var clearPinPresented: Binding<Bool> {
    Binding(
      get: { store.pendingClearPinRequest != nil },
      set: { isPresented in
        if isPresented == false {
          store.pendingClearPinRequest = nil
        }
      }
    )
  }

  private var releaseLeasePresented: Binding<Bool> {
    Binding(
      get: { store.pendingReleaseLeaseRequest != nil },
      set: { isPresented in
        if isPresented == false {
          store.pendingReleaseLeaseRequest = nil
        }
      }
    )
  }

  private var lifecycleRequestPresented: Binding<Bool> {
    Binding(
      get: { store.pendingLifecycleRequest != nil },
      set: { isPresented in
        if isPresented == false {
          store.pendingLifecycleRequest = nil
        }
      }
    )
  }

  private func lifecycleConfirmationMessage(for action: BrokerLifecycleAction, alias: String) -> String {
    switch action {
    case .erase:
      return "This will erase simulator data for \(alias) and shut it down."
    case .repair:
      return "This will run broker-managed repair for \(alias). If another actor holds the lease, the broker may require an explicit human override."
    case .boot, .shutdown:
      return ""
    }
  }

  private func lifecycleConfirmationTitle(for action: BrokerLifecycleAction?) -> Text {
    switch action {
    case .erase:
      return Text("Erase simulator?")
    case .repair:
      return Text("Repair simulator?")
    default:
      return Text("")
    }
  }
}

extension View {
  func simulatorActionConfirmationDialogs(store: BrokerDashboardStore) -> some View {
    modifier(SimulatorActionConfirmationDialogs(store: store))
  }
}
