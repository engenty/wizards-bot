import Foundation

/// A tool of a connection, as the phone keeps it: enough for the phone's model to pick and call it.
nonisolated struct PhoneConnectionTool: Codable, Hashable, Sendable {
    var name: String
    var description: String
    /// The server marks it as one that changes nothing.
    var readOnly: Bool
    /// Its input as JSON schema, compact.
    var input: String
}

/// What went wrong with a connection, as a sentence for the person or the model.
nonisolated struct MCPProblem: Error, Equatable {
    var sentence: String
}

/// Speaks MCP's Streamable HTTP to one server: JSON-RPC by POST, the answer as JSON or as a short
/// event stream, the session in `Mcp-Session-Id`. Only what the phone's agent needs: start,
/// list the tools, call one.
nonisolated final class MCPClient: @unchecked Sendable {
    typealias Transport = @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)

    static let protocolVersion = "2025-06-18"

    private let url: URL
    private let token: String?
    private let transport: Transport
    private let lock = NSLock()
    private var session: String?
    private var counter = 0
    private var started = false

    init(url: URL, token: String?, transport: Transport? = nil) {
        self.url = url
        self.token = token?.isEmpty == false ? token : nil
        self.transport = transport ?? { request in
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw MCPProblem(sentence: "The service did not answer.") }
            return (data, http)
        }
    }

    /// The tools of the server.
    func tools() async throws -> [PhoneConnectionTool] {
        try await start()
        let result = try await request("tools/list", params: [:])
        let tools = result["tools"] as? [[String: Any]] ?? []
        return tools.compactMap { tool in
            guard let name = tool["name"] as? String else { return nil }
            let annotations = tool["annotations"] as? [String: Any]
            let schema = (tool["inputSchema"] as? [String: Any]).flatMap {
                try? JSONSerialization.data(withJSONObject: $0, options: [.sortedKeys, .withoutEscapingSlashes])
            }.map { String(decoding: $0, as: UTF8.self) } ?? "{}"
            return PhoneConnectionTool(
                name: name, description: String((tool["description"] as? String ?? "").prefix(200)),
                readOnly: annotations?["readOnlyHint"] as? Bool == true, input: String(schema.prefix(600))
            )
        }
    }

    /// Calls a tool; returns the text it answered.
    func call(_ name: String, arguments: [String: Any]) async throws -> String {
        try await start()
        let result = try await request("tools/call", params: ["name": name, "arguments": arguments])
        let text = (result["content"] as? [[String: Any]] ?? []).compactMap { part -> String? in
            switch part["type"] as? String {
            case "text": part["text"] as? String
            case "resource": ((part["resource"] as? [String: Any])?["text"] as? String)
            default: nil
            }
        }.joined(separator: "\n")
        if result["isError"] as? Bool == true { throw MCPProblem(sentence: text.isEmpty ? "The tool failed." : text) }
        return text
    }

    private func start() async throws {
        guard !lock.withLock({ started }) else { return }
        _ = try await request("initialize", params: [
            "protocolVersion": Self.protocolVersion,
            "capabilities": [String: Any](),
            "clientInfo": ["name": "wizards.bot", "version": "1"],
        ])
        try await notify("notifications/initialized")
        lock.withLock { started = true }
    }

    private func request(_ method: String, params: [String: Any]) async throws -> [String: Any] {
        let id = lock.withLock { counter += 1; return counter }
        let (data, response) = try await transport(try message(["jsonrpc": "2.0", "id": id, "method": method, "params": params]))
        if let session = response.value(forHTTPHeaderField: "Mcp-Session-Id") { lock.withLock { self.session = session } }
        try Self.check(response)
        return try Self.result(of: data, contentType: response.value(forHTTPHeaderField: "Content-Type") ?? "", id: id)
    }

    private func notify(_ method: String) async throws {
        let (_, response) = try await transport(try message(["jsonrpc": "2.0", "method": method]))
        try Self.check(response)
    }

    private func message(_ body: [String: Any]) throws -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json, text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue(Self.protocolVersion, forHTTPHeaderField: "MCP-Protocol-Version")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let session = lock.withLock({ session }) { request.setValue(session, forHTTPHeaderField: "Mcp-Session-Id") }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return request
    }

    static func check(_ response: HTTPURLResponse) throws {
        switch response.statusCode {
        case 200 ..< 300: return
        case 401, 403: throw MCPProblem(sentence: "The service did not take the token. Check it, or connect it again.")
        case 404: throw MCPProblem(sentence: "Nothing answers MCP at this address.")
        default: throw MCPProblem(sentence: "The service answered with an error (\(response.statusCode)).")
        }
    }

    /// The `result` of the answer with `id`, from a JSON body or from the events of a stream.
    static func result(of data: Data, contentType: String, id: Int) throws -> [String: Any] {
        var messages: [[String: Any]] = []
        if contentType.contains("text/event-stream") {
            let text = String(decoding: data, as: UTF8.self).replacingOccurrences(of: "\r\n", with: "\n")
            for event in text.components(separatedBy: "\n\n") {
                let payload = event.split(separator: "\n").filter { $0.hasPrefix("data:") }
                    .map { $0.dropFirst(5).trimmingCharacters(in: .whitespaces) }.joined(separator: "\n")
                if let object = try? JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any] { messages.append(object) }
            }
        } else if let object = try? JSONSerialization.jsonObject(with: data) {
            messages = (object as? [[String: Any]]) ?? [object as? [String: Any]].compactMap(\.self)
        }
        guard let answer = messages.first(where: { ($0["id"] as? Int) == id }) else {
            throw MCPProblem(sentence: "The service answered with something this phone can't read.")
        }
        if let error = answer["error"] as? [String: Any] {
            throw MCPProblem(sentence: error["message"] as? String ?? "The service refused it.")
        }
        return answer["result"] as? [String: Any] ?? [:]
    }
}
