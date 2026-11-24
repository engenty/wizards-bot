import Foundation

// The artifact shapes of packages/protocol/src/index.ts.

/// A page an agent wrote: a chart, a diagram, a 3D scene, a report on one page. The home serves
/// it closed off, so it reaches neither the home nor the network.
nonisolated struct ArtifactMeta: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var title: String
    /// `html`: a page an agent wrote. `app`: the view a connection's server shows a tool's
    /// result in (MCP Apps); its `page` is the home's host that runs the view.
    var format: String
    var version: Int
    var updatedAt: String
    var conversationId: String
    /// An app's result in a few lines, for where its view is not shown.
    var summary: String?
}

nonisolated struct Artifact: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var title: String
    var format: String
    var version: Int
    var updatedAt: String
    var conversationId: String
    var summary: String?
    /// The page as the agent wrote it. A device never shows it itself: it shows `page`.
    var content: String
    /// Path of the page as the home serves it, with a key that opens this one page for an hour.
    var page: String

    /// The second the key of `page` stops working, from its `until`.
    static func until(_ page: String) -> Date? {
        guard let query = page.split(separator: "?", maxSplits: 1).dropFirst().first,
              let item = URLComponents(string: "?\(query)")?.queryItems?.first(where: { $0.name == "until" }),
              let seconds = item.value.flatMap(Double.init), seconds > 0 else { return nil }
        return Date(timeIntervalSince1970: seconds)
    }

    /// Whether the address of a page still opens it, with a minute to spare.
    static func pageOpens(_ page: String, at now: Date = .now) -> Bool {
        guard let until = until(page) else { return false }
        return until.timeIntervalSince(now) > 60
    }
}
