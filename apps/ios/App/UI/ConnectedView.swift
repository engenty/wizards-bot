import SwiftUI
import UserNotifications

/// After a pairing, before the chat: the Bot Server this device is connected to, and the place
/// where the app asks for notifications.
struct ConnectedView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL
    let back: () -> Void

    /// What the person allowed for notifications; nil until read.
    @State private var permission: UNAuthorizationStatus?

    private var link: HomeLink? { model.justPaired ?? model.link }

    var body: some View {
        PetrolScreen(back: back) {
            Text("Connected")
                .petrolHeading()
            VStack(alignment: .leading, spacing: 0) {
                if let link {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(verbatim: link.name)
                            .font(.headline)
                            .foregroundStyle(Petrol.ink)
                        Text(verbatim: Self.address(of: link.baseURL))
                            .font(.subheadline.monospaced())
                            .foregroundStyle(Petrol.ink3)
                            .textSelection(.enabled)
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    Petrol.divider
                        .frame(height: 1)
                }
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Notifications")
                            .font(.body.weight(.medium))
                            .foregroundStyle(Petrol.ink)
                        Text("When your agents finish or need you")
                            .font(.footnote)
                            .foregroundStyle(Petrol.ink2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 8)
                    notifications
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .frame(minHeight: 64)
            }
            .background(Petrol.card, in: .rect(cornerRadius: 14))
        } bottom: {
            Button("Open the chat") { model.closePairing() }
                .buttonStyle(PetrolButtonStyle())
        }
        .task { permission = await model.notifier.permission() }
        // The person may have allowed them in Settings.
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task { permission = await model.notifier.permission() }
        }
    }

    @ViewBuilder private var notifications: some View {
        switch permission {
        case .none:
            EmptyView()
        case .authorized, .provisional, .ephemeral:
            Image(systemName: "checkmark.circle.fill")
                .font(.title2)
                .foregroundStyle(Petrol.ok)
                .frame(minWidth: 44, minHeight: 44)
                .accessibilityLabel("Allowed")
        default:
            Button("Allow", action: allow)
                .buttonStyle(PetrolButtonStyle(compact: true))
        }
    }

    private func allow() {
        // Once the person said no, only Settings can change it.
        if permission == .denied, let settings = URL(string: UIApplication.openNotificationSettingsURLString) {
            openURL(settings)
            return
        }
        Task { permission = await model.notifier.allow() }
    }

    /// The address as the person typed it or the card showed it: host and port, no scheme.
    private static func address(of url: URL) -> String {
        guard let host = url.host(percentEncoded: false) else { return url.absoluteString }
        let shown = host.contains(":") ? "[\(host)]" : host
        return url.port.map { "\(shown):\($0)" } ?? shown
    }
}
