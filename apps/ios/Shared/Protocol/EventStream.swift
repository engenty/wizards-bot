import Foundation

/// What the stream tells its reader.
nonisolated enum StreamSignal: Sendable {
    /// The stream is open. `resumed` is true when it continues after an event the device had seen.
    case open(resumed: Bool)
    /// An event, with the id to continue after; `message.delta` events have none.
    case event(HomeEvent, id: String?)
    /// The stream ended or could not open; the next try follows by itself.
    case closed
    /// 401: this device has to pair again. The stream ends.
    case unauthorized
}

/// The home's one event stream: `GET /v1/events`, reconnecting with `Last-Event-ID` and a growing pause.
nonisolated struct EventStream: Sendable {
    let client: HomeClient

    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        // The home sends a comment every 20 seconds; a longer silence means the stream is dead.
        configuration.timeoutIntervalForRequest = 50
        configuration.timeoutIntervalForResource = 60 * 60 * 24
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration, delegate: HomeTrust.shared, delegateQueue: nil)
    }()

    /// Runs until the reader stops listening.
    func signals(after lastEventId: String? = nil) -> AsyncStream<StreamSignal> {
        AsyncStream { continuation in
            let task = Task { @concurrent in
                await run(after: lastEventId, continuation)
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    @concurrent
    private func run(after start: String?, _ continuation: AsyncStream<StreamSignal>.Continuation) async {
        var lastEventId = start
        var attempt = 0
        var floor: TimeInterval = 0
        while !Task.isCancelled {
            do {
                var request = client.request("GET", "/v1/events")
                request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
                if let lastEventId { request.setValue(lastEventId, forHTTPHeaderField: "Last-Event-ID") }
                let (bytes, response) = try await Self.session.bytes(for: request, delegate: HomeTrust.shared)
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                if status == 401 {
                    continuation.yield(.unauthorized)
                    return
                }
                guard status == 200 else { throw HomeError.unreachable }
                continuation.yield(.open(resumed: lastEventId != nil))
                attempt = 0
                var parser = SSEParser()
                for try await byte in bytes {
                    guard let message = parser.feed(byte) else { continue }
                    if let id = message.id { lastEventId = id }
                    guard let event = try? JSONDecoder().decode(HomeEvent.self, from: Data(message.data.utf8)) else { continue }
                    continuation.yield(.event(event, id: message.id))
                }
                if let retry = parser.retry { floor = Double(retry) / 1000 }
            } catch {
                if Task.isCancelled { return }
            }
            continuation.yield(.closed)
            attempt += 1
            try? await Task.sleep(for: .seconds(Backoff.delay(attempt: attempt, floor: floor)))
        }
    }
}
