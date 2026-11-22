import Foundation
import WatchConnectivity

/// Pairs the watch with the home through this phone: the watch asks, the phone adds it as a device
/// (`POST /v1/devices`) and hands the watch its own token.
final class WatchBridge: NSObject, WCSessionDelegate {
    private let session: WCSession? = WCSession.isSupported() ? .default : nil
    private var phoneLink: () -> HomeLink? = { nil }
    private var pending: Task<WatchLink, Never>?

    private static let account = "watch"
    private static let nameKey = "watchName"

    func start(link: @escaping () -> HomeLink?) {
        phoneLink = link
        session?.delegate = self
        session?.activate()
    }

    /// The phone connected to a home or left it: the watch follows.
    func homeChanged() {
        guard let session, session.activationState == .activated, session.isWatchAppInstalled else { return }
        Task {
            guard let message = await answer(watchName: nil).encoded() else { return }
            session.transferUserInfo(message)
        }
    }

    /// What the watch gets. Two questions at once get the same answer: the watch is paired once.
    private func answer(watchName: String?) async -> WatchLink {
        if let watchName { UserDefaults.standard.set(watchName, forKey: Self.nameKey) }
        if let pending { return await pending.value }
        let task = Task { await pair() }
        pending = task
        defer { pending = nil }
        return await task.value
    }

    /// The watch's own link to the phone's home, made once and kept.
    private func pair() async -> WatchLink {
        guard let phone = phoneLink() else {
            Keychain.remove(Self.account)
            return .noHome
        }
        if let known = Keychain.read(HomeLink.self, from: Self.account), known.baseURL == phone.baseURL { return .home(known) }
        let name = UserDefaults.standard.string(forKey: Self.nameKey) ?? "Apple Watch"
        guard let paired = try? await HomeClient(phone).addDevice(name: name, kind: .watch) else { return .noHome }
        let link = HomeLink(baseURL: phone.baseURL, token: paired.token, deviceId: paired.device.id, name: paired.home.name)
        Keychain.save(link, as: Self.account)
        return .home(link)
    }

    nonisolated func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {}
    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}

    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        // Switching to another watch: start over with it.
        session.activate()
    }

    nonisolated func session(
        _ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void
    ) {
        guard case .ask(let watchName) = WatchLink.decode(message) else {
            replyHandler([:])
            return
        }
        nonisolated(unsafe) let reply = replyHandler
        Task { @MainActor in
            let answer = await self.answer(watchName: watchName)
            reply(answer.encoded() ?? [:])
        }
    }
}
