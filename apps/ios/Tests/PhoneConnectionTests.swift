import Foundation
import Testing

/// An MCP server in memory: answers `initialize`, `tools/list` and `tools/call` the way the
/// Streamable HTTP transport does, as JSON or as an event stream.
nonisolated final class FakeMCPServer: @unchecked Sendable {
    private let lock = NSLock()
    var stream = false
    var token = "secret"
    private(set) var seen: [(method: String, session: String?, auth: String?)] = []
    private(set) var calls: [(String, [String: Any])] = []

    var transport: MCPClient.Transport {
        { [self] request in try handle(request) }
    }

    private func handle(_ request: URLRequest) throws -> (Data, HTTPURLResponse) {
        let body = try JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any] ?? [:]
        let method = body["method"] as? String ?? ""
        let auth = request.value(forHTTPHeaderField: "Authorization")
        lock.withLock { seen.append((method, request.value(forHTTPHeaderField: "Mcp-Session-Id"), auth)) }
        let url = request.url!
        guard auth == "Bearer \(token)" else {
            return (Data(), HTTPURLResponse(url: url, statusCode: 401, httpVersion: nil, headerFields: nil)!)
        }
        guard let id = body["id"] else {
            return (Data(), HTTPURLResponse(url: url, statusCode: 202, httpVersion: nil, headerFields: nil)!)
        }
        var result: [String: Any] = [:]
        switch method {
        case "initialize":
            result = ["protocolVersion": MCPClient.protocolVersion, "capabilities": ["tools": [:]], "serverInfo": ["name": "issues", "version": "1"]]
        case "tools/list":
            result = ["tools": [
                ["name": "search", "description": "Find issues.", "inputSchema": ["type": "object", "properties": ["query": ["type": "string"]]],
                 "annotations": ["readOnlyHint": true]],
                ["name": "create", "description": "Make an issue.", "inputSchema": ["type": "object"]],
            ]]
        case "tools/call":
            let params = body["params"] as? [String: Any] ?? [:]
            lock.withLock { calls.append((params["name"] as? String ?? "", params["arguments"] as? [String: Any] ?? [:])) }
            let text = params["name"] as? String == "search" ? String(repeating: "Issue 12: rent is due. ", count: 200) : "Made issue 13."
            result = ["content": [["type": "text", "text": text]]]
        default:
            let error: [String: Any] = ["jsonrpc": "2.0", "id": id, "error": ["code": -32601, "message": "No such method."]]
            return (try JSONSerialization.data(withJSONObject: error), HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!)
        }
        let answer = try JSONSerialization.data(withJSONObject: ["jsonrpc": "2.0", "id": id, "result": result])
        let headers = ["Content-Type": stream ? "text/event-stream" : "application/json", "Mcp-Session-Id": "s-1"]
        let data = stream ? Data("event: message\ndata: \(String(decoding: answer, as: UTF8.self))\n\n".utf8) : answer
        return (data, HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: headers)!)
    }
}

/// Services signed in on the phone: reached from the phone, their token kept there, and every tool
/// that may change something asks the person first.
@Suite struct PhoneConnectionTests {
    func store() -> PhoneConnections {
        PhoneConnections(file: FileManager.default.temporaryDirectory.appending(path: "pc-\(UUID().uuidString)/c.json"), keychain: false)
    }

    @Test(arguments: [false, true])
    func theToolsAreReadOverJsonOrAStream(stream: Bool) async throws {
        let server = FakeMCPServer()
        server.stream = stream
        let client = MCPClient(url: URL(string: "https://issues.example/mcp")!, token: "secret", transport: server.transport)
        let tools = try await client.tools()
        #expect(tools.map(\.name) == ["search", "create"])
        #expect(tools.map(\.readOnly) == [true, false])
        #expect(tools.first?.input.contains("\"query\"") == true)
        // The session the server named goes with every later message.
        #expect(server.seen.map(\.method) == ["initialize", "notifications/initialized", "tools/list"])
        #expect(server.seen.last?.session == "s-1")
    }

    @Test func aWrongTokenIsSaidPlainly() async {
        let server = FakeMCPServer()
        let client = MCPClient(url: URL(string: "https://issues.example/mcp")!, token: "wrong", transport: server.transport)
        await #expect(throws: MCPProblem(sentence: "The service did not take the token. Check it, or connect it again.")) {
            try await client.tools()
        }
    }

    @Test func anErrorOfTheServerIsItsSentence() throws {
        let body = Data(#"{"jsonrpc":"2.0","id":3,"error":{"code":-1,"message":"Not allowed."}}"#.utf8)
        #expect(throws: MCPProblem(sentence: "Not allowed.")) { try MCPClient.result(of: body, contentType: "application/json", id: 3) }
        // Other messages in a stream before the answer are passed over.
        let events = Data("data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\n\ndata: {\"jsonrpc\":\"2.0\",\"id\":4,\"result\":{\"ok\":true}}\n\n".utf8)
        #expect(try MCPClient.result(of: events, contentType: "text/event-stream", id: 4)["ok"] as? Bool == true)
    }

    @Test func aServiceIsKeptOnlyWithAnHttpsAddress() async throws {
        let server = FakeMCPServer()
        let connections = store()
        await #expect(throws: MCPProblem.self) {
            try await connections.connect(name: "Issues", url: URL(string: "http://issues.example/mcp")!, token: "secret", transport: server.transport)
        }
        let kept = try await connections.connect(name: "Issues", url: URL(string: "https://issues.example/mcp")!, token: "secret", transport: server.transport)
        #expect(kept.changes)
        #expect(connections.token(of: kept.id) == "secret")
        // Nothing of the token is in what the phone writes to its files.
        #expect(!(String(data: try JSONEncoder().encode(connections.connections), encoding: .utf8) ?? "").contains("secret"))
        connections.disconnect(kept.id)
        #expect(connections.token(of: kept.id) == nil)
    }

    @Test func aToolThatReadsRunsAndOneThatChangesAsksFirst() async throws {
        let server = FakeMCPServer()
        let connections = store()
        let kept = try await connections.connect(name: "Issues", url: URL(string: "https://issues.example/mcp")!, token: "secret", transport: server.transport)
        let person = Person()
        person.says = false
        let transport = server.transport
        let phone = PhoneTools(
            data: FakePhoneData(), folders: [], ask: { person.ask($0) }, connections: [kept],
            callTool: { connection, tool, arguments in
                let parsed = (try? JSONSerialization.jsonObject(with: Data(arguments.utf8)) as? [String: Any]) ?? [:]
                return try await PhoneConnections.client(connection, token: "secret", transport: transport).call(tool, arguments: parsed)
            }
        )
        #expect(await phone.connection(name: nil, tool: nil, arguments: nil) == "Services on this phone: Issues.")
        let listed = await phone.connection(name: "issues", tool: nil, arguments: nil)
        #expect(listed.contains("search: Find issues.") && listed.contains("create (changes): Make an issue."))
        let found = await phone.connection(name: "Issues", tool: "search", arguments: #"{"query":"rent"}"#)
        #expect(found.hasSuffix("(cut short)"))
        #expect(found.count <= PhoneTools.readLimit + 13)
        #expect(person.questions.isEmpty)
        #expect(await phone.connection(name: "Issues", tool: "create", arguments: #"{"title":"Pay rent"}"#) == PhoneTools.saidNo)
        #expect(person.questions.first?.detail == #"{"title":"Pay rent"}"#)
        #expect(server.calls.map(\.0) == ["search"])
        person.says = true
        #expect(await phone.connection(name: "Issues", tool: "create", arguments: #"{"title":"Pay rent"}"#) == "Made issue 13.")
        #expect(await phone.changed == ["Issues: create"])
        #expect(await phone.connection(name: "Issues", tool: "create", arguments: "rent").hasPrefix("The arguments must be a JSON object"))
    }
}
