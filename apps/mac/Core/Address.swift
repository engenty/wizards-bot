import Foundation

/// A Bot Server's address as a person types it, made into the URL the app asks.
nonisolated enum Address {
    /// The port a Bot Server listens on when nothing else is said.
    static let port = 4747

    /// `ada.wizards.bot` → `https://ada.wizards.bot`; `macmini.local` → `http://macmini.local:4747`;
    /// a full `http(s)://…` stays as it is, without a path or a trailing slash.
    static func normalize(_ text: String) -> URL? {
        var typed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        while typed.hasSuffix("/") { typed.removeLast() }
        guard !typed.isEmpty, !typed.contains(" ") else { return nil }
        let given = typed.contains("://")
        guard var parts = URLComponents(string: given ? typed : "x://\(typed)"),
              let host = parts.host, !host.isEmpty
        else { return nil }
        if !given {
            parts.scheme = isLocal(host) ? "http" : "https"
            if parts.port == nil, isLocal(host) { parts.port = port }
        }
        guard parts.scheme == "http" || parts.scheme == "https" else { return nil }
        parts.path = ""
        parts.query = nil
        parts.fragment = nil
        parts.user = nil
        parts.password = nil
        return parts.url
    }

    /// A name or a number of this network: the app speaks plain HTTP to it, as the phone does.
    static func isLocal(_ host: String) -> Bool {
        let name = host.lowercased()
        if name == "localhost" || name.hasSuffix(".local") || !name.contains(".") { return true }
        let numbers = name.split(separator: ".").compactMap { Int($0) }
        guard numbers.count == 4, numbers.allSatisfy({ (0 ... 255).contains($0) }) else { return false }
        switch (numbers[0], numbers[1]) {
        case (127, _), (10, _), (192, 168), (169, 254): return true
        case (172, 16 ... 31): return true
        default: return false
        }
    }

    /// The address and the code of a pairing link, `wizardsbot://pair?home=…&code=…`, the link the
    /// Bot Server's QR holds.
    static func pairingLink(_ link: URL) -> (home: URL, code: String)? {
        guard link.scheme == "wizardsbot", link.host == "pair",
              let items = URLComponents(url: link, resolvingAgainstBaseURL: false)?.queryItems,
              let home = items.first(where: { $0.name == "home" })?.value.flatMap(normalize),
              let code = items.first(where: { $0.name == "code" })?.value, !tidy(code).isEmpty
        else { return nil }
        return (home, code)
    }

    /// A pairing code as the Bot Server compares it: letters and digits, in capitals.
    static func tidy(_ code: String) -> String {
        code.uppercased().filter { $0.isASCII && ($0.isLetter || $0.isNumber) }
    }

    /// How an address is shown: its host, and the port when it is not the scheme's own.
    static func label(_ home: URL) -> String {
        guard let host = home.host else { return home.absoluteString }
        if let port = home.port { return "\(host):\(port)" }
        return host
    }
}
