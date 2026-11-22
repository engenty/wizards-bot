import Foundation
import Testing

@Suite struct SSETests {
    /// The stream of docs/protocol.md.
    static let example = """
    id: 412
    data: {"type":"message.created","message":{"id":"m","conversationId":"c","role":"agent","channel":"app","state":"streaming","createdAt":"t","parts":[{"type":"text","text":"You are"}]}}

    data: {"type":"message.delta","conversationId":"c","messageId":"m","part":0,"text":" free"}

    id: 413
    data: {"type":"message.updated","message":{"id":"m","conversationId":"c","role":"agent","channel":"app","state":"done","createdAt":"t","parts":[{"type":"text","text":"You are free"}]}}


    """

    @Test func theExampleOfTheProtocol() throws {
        var parser = SSEParser()
        let messages = parser.feed(Self.example)
        #expect(messages.map(\.id) == ["412", nil, "413"])
        let events = try messages.map { try JSONDecoder().decode(HomeEvent.self, from: Data($0.data.utf8)) }
        guard case .messageCreated(let created) = events[0], case .messageUpdated(let updated) = events[2] else {
            Issue.record("The first and the last event carry the message")
            return
        }
        #expect(created.state == .streaming)
        #expect(events[1] == .messageDelta(conversationId: "c", messageId: "m", part: 0, text: " free"))
        #expect(updated.text == "You are free")
    }

    @Test func aDeltaHasNoIdAndDoesNotKeepTheLastOne() {
        var parser = SSEParser()
        let messages = parser.feed("id: 1\ndata: a\n\ndata: b\n\n")
        #expect(messages == [SSEMessage(id: "1", event: nil, data: "a"), SSEMessage(id: nil, event: nil, data: "b")])
    }

    @Test func commentsKeepTheStreamOpenAndDispatchNothing() {
        var parser = SSEParser()
        #expect(parser.feed(": ping\n\n: ping\n\n").isEmpty)
        #expect(parser.feed(":\n\ndata: x\n\n") == [SSEMessage(id: nil, event: nil, data: "x")])
    }

    @Test func anyLineEnding() {
        for ending in ["\n", "\r\n", "\r"] {
            var parser = SSEParser()
            let text = ["id: 7", "event: note", "data: one", "data: two", "", "data: three", "", ""].joined(separator: ending)
            #expect(parser.feed(text) == [
                SSEMessage(id: "7", event: "note", data: "one\ntwo"),
                SSEMessage(id: nil, event: nil, data: "three"),
            ], "line ending \(ending.debugDescription)")
        }
    }

    @Test func bytesMayArriveInAnyPieces() {
        let text = "id: 9\r\ndata: {\"type\":\"reset\"}\r\n\r\ndata: grüß dich … 👋\n\n"
        let whole = { var parser = SSEParser(); return parser.feed(text) }()
        #expect(whole.count == 2)
        #expect(whole[1].data == "grüß dich … 👋")
        // One byte at a time: a line ending and a character may be cut anywhere.
        var parser = SSEParser()
        var pieces: [SSEMessage] = []
        for byte in text.utf8 {
            if let message = parser.feed(byte) { pieces.append(message) }
        }
        #expect(pieces == whole)
    }

    @Test func theSpaceAfterTheColonIsOptionalAndOnlyOneIsDropped() {
        var parser = SSEParser()
        #expect(parser.feed("data:tight\n\ndata:  two spaces\n\ndata\n\n").map(\.data) == ["tight", " two spaces", ""])
    }

    @Test func aLeadingByteOrderMarkAndUnknownFieldsAreIgnored() {
        var parser = SSEParser()
        let bytes: [UInt8] = [0xEF, 0xBB, 0xBF] + Array("data: x\nfoo: bar\n\n".utf8)
        #expect(parser.feed(bytes) == [SSEMessage(id: nil, event: nil, data: "x")])
    }

    @Test func nothingIsDispatchedWithoutData() {
        var parser = SSEParser()
        #expect(parser.feed("id: 5\n\nevent: note\n\n").isEmpty)
        // An event that never ended is not dispatched.
        #expect(parser.feed("data: half").isEmpty)
    }

    @Test func retryIsKept() {
        var parser = SSEParser()
        _ = parser.feed("retry: 5000\n\nretry: soon\n\n")
        #expect(parser.retry == 5000)
    }

    @Test func backoffGrowsAndStops() {
        #expect(Backoff.delay(attempt: 1, jitter: 0.5) == 1)
        #expect(Backoff.delay(attempt: 2, jitter: 0.5) == 2)
        #expect(Backoff.delay(attempt: 3, jitter: 0.5) == 4)
        #expect(Backoff.delay(attempt: 6, jitter: 0.5) == 30)
        #expect(Backoff.delay(attempt: 50, jitter: 0.5) == 30)
        #expect(abs(Backoff.delay(attempt: 1, jitter: 0) - 0.8) < 0.001)
        #expect(abs(Backoff.delay(attempt: 1, jitter: 1) - 1.2) < 0.001)
        #expect(Backoff.delay(attempt: 1, jitter: 0.5, floor: 5) == 5)
        for attempt in 1 ... 12 {
            let delay = Backoff.delay(attempt: attempt)
            #expect(delay >= 0.79 && delay <= Backoff.longest * 1.21)
        }
    }
}
