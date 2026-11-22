import Foundation

/// What the phone and the watch tell each other over WatchConnectivity. The watch asks for a home;
/// the phone pairs it there (`POST /v1/devices`) and hands over the answer.
nonisolated enum WatchLink: Codable, Equatable, Sendable {
    /// Watch → phone: "which home?", with the watch's name for the home's device list.
    case ask(watchName: String)
    /// Phone → watch: the home and the watch's own token.
    case home(HomeLink)
    /// Phone → watch: the phone has no home, or signed out of it.
    case noHome

    static let key = "link"

    func encoded() -> [String: Any]? {
        (try? JSONEncoder().encode(self)).map { [Self.key: $0] }
    }

    static func decode(_ message: [String: Any]) -> WatchLink? {
        (message[key] as? Data).flatMap { try? JSONDecoder().decode(WatchLink.self, from: $0) }
    }
}
