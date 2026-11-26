import Foundation

/// What the QR of a pairing card holds: `wizardsbot://pair?home=<base url>&code=<code>`, and on
/// the person's network `&k=<print>`: the key the home's https answers with.
nonisolated struct PairingLink: Equatable, Sendable {
    static let scheme = "wizardsbot"

    var home: URL
    var code: String
    var print: String?

    init?(_ url: URL) {
        guard url.scheme?.lowercased() == Self.scheme, url.host()?.lowercased() == "pair",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              let address = items.first(where: { $0.name == "home" })?.value,
              let home = HomeAddress.url(from: address),
              let code = items.first(where: { $0.name == "code" })?.value, !code.isEmpty else { return nil }
        self.home = home
        self.code = PairingCode.tidy(code)
        print = items.first(where: { $0.name == "k" })?.value.flatMap { $0.isEmpty ? nil : $0 }
    }

    init?(_ text: String) {
        guard let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
        self.init(url)
    }
}

/// The address of a home as a person types it.
nonisolated enum HomeAddress {
    /// A base URL from what was typed: "192.168.1.20:4747" gets `http`, "me.example.com" gets `https`.
    static func url(from typed: String) -> URL? {
        var text = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !text.contains(" ") else { return nil }
        if !text.contains("://") {
            let host = text.split(separator: "/").first.map(String.init) ?? text
            text = (isLocal(host) ? "http://" : "https://") + text
        }
        while text.hasSuffix("/") { text.removeLast() }
        guard let url = URL(string: text), let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = url.host(), !host.isEmpty else { return nil }
        return url
    }

    /// True for an address in the person's own network: an IP address, `localhost`, a `.local` name or a bare name.
    static func isLocal(_ hostAndPort: String) -> Bool {
        var host = hostAndPort.lowercased()
        if host.hasPrefix("[") { return true }
        if let colon = host.lastIndex(of: ":") { host = String(host[..<colon]) }
        if host == "localhost" || host.hasSuffix(".local") || host.hasSuffix(".localhost") || !host.contains(".") { return true }
        let numbers = host.split(separator: ".")
        return numbers.count == 4 && numbers.allSatisfy { UInt8($0) != nil }
    }
}

/// The 8 characters of a pairing code, shown as "K7QM-2RXD".
nonisolated enum PairingCode {
    static func tidy(_ typed: String) -> String {
        let characters = typed.uppercased().filter { $0.isLetter || $0.isNumber }
        guard characters.count == 8 else { return typed.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() }
        return "\(characters.prefix(4))-\(characters.suffix(4))"
    }
}
