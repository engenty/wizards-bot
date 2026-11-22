import Foundation

/// A call or a message an agent put on a card for the person to start on this phone. The card
/// names the recipient as the agent knows them ("Anna Berg"); the phone finds the number or the
/// address in its own contacts, so the contact never leaves the phone. Nothing is called or sent
/// until the person taps.
nonisolated enum PhoneAction: Hashable, Sendable, Identifiable {
    enum Via: String, Hashable, Sendable {
        case messages, mail, whatsapp
    }

    case call(to: String)
    case message(to: String, via: Via, text: String, subject: String?)

    var id: String {
        switch self {
        case .call(let to): "call:\(to)"
        case .message(let to, let via, let text, _): "message:\(via.rawValue):\(to):\(text.hashValue)"
        }
    }

    var to: String {
        switch self {
        case .call(let to), .message(let to, _, _, _): to
        }
    }

    /// The action of a card's link: `wizardsbot://call?to=…` or `wizardsbot://message?to=…&via=…&text=…`.
    init?(_ url: URL) {
        guard url.scheme == PairingLink.scheme, let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        // A form-encoded query writes a space as `+`; a `+` of its own comes as `%2B`.
        let plain = { (name: String) in
            parts.percentEncodedQueryItems?.first { $0.name == name }?.value?
                .replacingOccurrences(of: "+", with: " ").removingPercentEncoding
        }
        let value = { (name: String) in plain(name)?.trimmingCharacters(in: .whitespaces) }
        guard let to = value("to"), !to.isEmpty else { return nil }
        switch url.host() {
        case "call":
            self = .call(to: to)
        case "message":
            guard let via = value("via").flatMap(Via.init(rawValue:)), let text = plain("text") else { return nil }
            self = .message(to: to, via: via, text: text, subject: value("subject"))
        default:
            return nil
        }
    }

    /// One way to reach someone: their name as the phone has it, and a number or an address.
    struct Recipient: Hashable, Sendable {
        var name: String
        var address: String
        /// "mobile", "work", or the address itself for a mail.
        var label: String?
    }

    /// Whether the agent gave a number or an address itself, rather than a name.
    static func isAddress(_ text: String) -> Bool {
        if text.contains("@") { return true }
        let digits = text.filter(\.isNumber)
        return digits.count >= 5 && text.allSatisfy { $0.isNumber || " +-()/.".contains($0) }
    }

    /// The numbers or addresses the phone has for the recipient: given ones as they are, a name
    /// from the contacts. A mail needs an address, a call and a message a number.
    func recipients(in data: PhoneData) async -> [Recipient] {
        let wantsMail: Bool = if case .message(_, .mail, _, _) = self { true } else { false }
        if Self.isAddress(to) { return [Recipient(name: to, address: to, label: nil)] }
        if data.access(.contacts) == .notAsked { _ = await data.requestAccess(.contacts) }
        guard data.access(.contacts) == .allowed, let found = try? await data.contacts(matching: to) else { return [] }
        return found.prefix(5).flatMap { contact in
            (wantsMail ? contact.emails : contact.phones).map { Recipient(name: contact.name, address: $0, label: nil) }
        }
    }

    /// The link that opens what the person chose: a call, a WhatsApp chat with the text, or — where
    /// the phone can't show its own form — a message or a mail with the text filled in.
    func link(for recipient: Recipient) -> URL? {
        let digits = recipient.address.filter { $0.isNumber || $0 == "+" }
        switch self {
        case .call:
            return URL(string: "tel:\(digits)")
        case .message(_, .whatsapp, let text, _):
            var parts = URLComponents(string: "https://wa.me/\(digits.filter(\.isNumber))")
            parts?.queryItems = [URLQueryItem(name: "text", value: text)]
            return parts?.url
        case .message(_, .messages, let text, _):
            var parts = URLComponents()
            parts.scheme = "sms"
            parts.path = digits
            parts.queryItems = [URLQueryItem(name: "body", value: text)]
            // iOS reads the text after `&`, as Messages writes such links itself.
            return parts.url.flatMap { URL(string: $0.absoluteString.replacingOccurrences(of: "?body=", with: "&body=")) }
        case .message(_, .mail, let text, let subject):
            var parts = URLComponents()
            parts.scheme = "mailto"
            parts.path = recipient.address
            parts.queryItems = [subject.map { URLQueryItem(name: "subject", value: $0) }, URLQueryItem(name: "body", value: text)].compactMap(\.self)
            return parts.url
        }
    }
}
