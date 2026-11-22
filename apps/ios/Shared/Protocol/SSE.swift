import Foundation

/// One dispatched event of a server-sent event stream.
nonisolated struct SSEMessage: Equatable, Sendable {
    /// The `id:` of this event; nil when it had none (a `message.delta`).
    var id: String?
    var event: String?
    var data: String
}

/// Reads a server-sent event stream byte by byte, as the HTML standard describes it: lines end with
/// LF, CR or CRLF, a line starting with a colon is a comment, an empty line dispatches the event.
nonisolated struct SSEParser: Sendable {
    /// Milliseconds the server asked to wait before reconnecting, from a `retry:` line.
    private(set) var retry: Int?

    private var line: [UInt8] = []
    private var afterCR = false
    private var atStart = true
    private var id: String?
    private var event: String?
    private var data: [String] = []

    /// Feeds one byte; returns an event when this byte completed one.
    mutating func feed(_ byte: UInt8) -> SSEMessage? {
        switch byte {
        case 0x0A where afterCR:
            // The LF of a CRLF: the line ended with the CR.
            afterCR = false
            return nil
        case 0x0A, 0x0D:
            afterCR = byte == 0x0D
            defer { line.removeAll(keepingCapacity: true) }
            return finish(line)
        default:
            afterCR = false
            line.append(byte)
            return nil
        }
    }

    mutating func feed(_ bytes: some Sequence<UInt8>) -> [SSEMessage] {
        var messages: [SSEMessage] = []
        for byte in bytes {
            if let message = feed(byte) { messages.append(message) }
        }
        return messages
    }

    mutating func feed(_ text: String) -> [SSEMessage] {
        feed(text.utf8)
    }

    private mutating func finish(_ bytes: [UInt8]) -> SSEMessage? {
        var bytes = bytes[...]
        if atStart {
            atStart = false
            if bytes.starts(with: [0xEF, 0xBB, 0xBF]) { bytes = bytes.dropFirst(3) }
        }
        guard !bytes.isEmpty else { return dispatch() }
        // A comment: the home sends one every 20 seconds to keep the stream open.
        guard bytes.first != 0x3A else { return nil }

        let name: String, value: String
        if let colon = bytes.firstIndex(of: 0x3A) {
            name = String(decoding: bytes[..<colon], as: UTF8.self)
            var rest = bytes[bytes.index(after: colon)...]
            if rest.first == 0x20 { rest = rest.dropFirst() }
            value = String(decoding: rest, as: UTF8.self)
        } else {
            name = String(decoding: bytes, as: UTF8.self)
            value = ""
        }
        switch name {
        case "data": data.append(value)
        case "event": event = value
        case "id" where !value.contains("\0"): id = value
        case "retry": if let milliseconds = Int(value), milliseconds >= 0 { retry = milliseconds }
        default: break
        }
        return nil
    }

    private mutating func dispatch() -> SSEMessage? {
        defer {
            id = nil
            event = nil
            data.removeAll()
        }
        guard !data.isEmpty else { return nil }
        return SSEMessage(id: id, event: event, data: data.joined(separator: "\n"))
    }
}

/// How long to wait before the next try to reach the home: 1, 2, 4 … 30 seconds, a little uneven so
/// that several devices do not all come back in the same moment.
nonisolated enum Backoff {
    static let longest: TimeInterval = 30

    /// - `attempt`: 1 for the first try after a failure.
    /// - `jitter`: 0 … 1, how much of the possible spread to take.
    static func delay(attempt: Int, jitter: Double = .random(in: 0 ... 1), floor: TimeInterval = 0) -> TimeInterval {
        let base = min(longest, pow(2, Double(max(1, min(attempt, 10)) - 1)))
        return max(floor, base * (0.8 + 0.4 * min(1, max(0, jitter))))
    }
}
