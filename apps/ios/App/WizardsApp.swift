import SwiftUI

@main
struct WizardsApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .onAppear {
                    delegate.notifier = model.notifier
                    delegate.onHandoff = { await model.wake(for: $0) }
                    model.start()
                    model.setActive(scenePhase == .active)
                }
                .onChange(of: scenePhase) { _, phase in
                    model.setActive(phase == .active)
                }
                .onOpenURL { url in
                    // wizardsbot://invite?link=<an invite link>
                    if let invite = InviteLink(url) {
                        Task { await model.openInvite(invite) }
                        return
                    }
                    // wizardsbot://pair?home=<url>&code=<code>
                    guard let link = PairingLink(url) else { return }
                    model.pendingLink = link
                    if !model.pairingFills { model.showsPairing = true }
                }
        }
    }
}
