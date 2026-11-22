import Foundation

/// A set of names the home may extend. A name this app does not know decodes to `.unknown` and is
/// written back as it came, so a newer home never breaks an older app.
nonisolated protocol OpenEnum: Codable, Hashable, Sendable {
    static var known: [String: Self] { get }
    static func unknown(_ raw: String) -> Self
    /// The name as it came, when it is not a known one.
    var unknownValue: String? { get }
}

nonisolated extension OpenEnum {
    init(rawValue: String) {
        self = Self.known[rawValue] ?? .unknown(rawValue)
    }

    var rawValue: String {
        unknownValue ?? Self.known.first { $0.value == self }?.key ?? ""
    }

    var isKnown: Bool { unknownValue == nil }

    init(from decoder: Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}
