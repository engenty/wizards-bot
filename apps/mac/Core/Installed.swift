import Foundation

/// What `bot.json` of `wizards bot install` says: the version of the Bot Server it runs and its
/// data folder. An earlier Bot Server does not say its version in `/health`; this file does.
nonisolated struct InstalledBot: Equatable, Sendable {
    let version: String?
    let data: String?

    static func read(_ data: Data) -> InstalledBot? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return InstalledBot(version: json["version"] as? String, data: json["data"] as? String)
    }
}

extension Version {
    /// Whether the app offers to update a Bot Server it found on this Mac: one older than the one
    /// it carries. A Bot Server that says no version is from before `/health` said it, so older.
    /// A build that carries no Bot Server offers nothing.
    static func offersUpdate(found: String?, carried: String?) -> Bool {
        guard let carried else { return false }
        guard let found else { return true }
        return older(found, than: carried)
    }
}
