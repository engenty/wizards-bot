import Foundation

/// An invite of another person's home, as its link and its QR code name it:
/// `https://<home>/i/<code>#k=<print of the home's key>`. The page behind such a link hands it
/// to the app as `wizardsbot://invite?link=<the link>`.
nonisolated struct InviteLink: Equatable, Sendable {
    /// The link as the person's home reads it: the other home's address, the code and the
    /// print. Nothing else of what was scanned or opened goes on.
    var text: String

    init?(_ url: URL) {
        guard let text = Self.text(of: url) else { return nil }
        self.text = text
    }

    private static func text(of url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased() else { return nil }
        if scheme == PairingLink.scheme {
            guard url.host()?.lowercased() == "invite",
                  let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
                  let carried = items.first(where: { $0.name == "link" })?.value,
                  let inner = URL(string: carried), inner.scheme?.lowercased() != PairingLink.scheme else { return nil }
            return text(of: inner)
        }
        guard ["https", "http"].contains(scheme), let host = url.host(), !host.isEmpty,
              url.user() == nil, url.query() == nil else { return nil }
        let path = url.path()
        guard path.hasPrefix("/i/") else { return nil }
        let code = path.dropFirst(3)
        guard (8...80).contains(code.count), code.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) else { return nil }
        var link = URLComponents()
        link.scheme = scheme
        link.host = host
        link.port = url.port
        link.path = "/i/\(code)"
        link.fragment = print(in: url.fragment()).map { "k=\($0)" }
        return link.string
    }

    init?(_ text: String) {
        guard let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
        self.init(url)
    }

    /// The print of the inviting home's key, when the link names one: 16 characters, 0–9 and a–f.
    private static func print(in fragment: String?) -> String? {
        for part in (fragment ?? "").split(separator: "&") where part.hasPrefix("k=") {
            let print = part.dropFirst(2).lowercased()
            if print.count == 16, print.allSatisfy({ $0.isHexDigit }) { return print }
        }
        return nil
    }
}
