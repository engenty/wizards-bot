import Foundation
import Observation

/// A service reached over MCP and signed in on this phone. Its address and its tools are kept on
/// the phone, its token in the phone's Keychain; the home learns only its name. Only the phone's
/// own agent uses it.
nonisolated struct PhoneConnection: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var name: String
    var url: URL
    var tools: [PhoneConnectionTool]
    var createdAt: Date

    /// True when one of its tools may change something: those ask the person on the phone first.
    var changes: Bool { tools.contains { !$0.readOnly } }
}

/// The connections signed in on this phone.
@Observable
final class PhoneConnections {
    private(set) var connections: [PhoneConnection] = []

    @ObservationIgnored private let file: URL
    @ObservationIgnored private let keychain: Bool

    /// `keychain: false` keeps tokens in memory only, for tests.
    init(file: URL = URL.applicationSupportDirectory.appending(path: "phone-connections.json"), keychain: Bool = true) {
        self.file = file
        self.keychain = keychain
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let data = try? Data(contentsOf: file), let saved = try? JSONDecoder().decode([PhoneConnection].self, from: data) {
            connections = saved
        }
    }

    @ObservationIgnored private var tokens: [String: String] = [:]

    /// The client for one connection, with its token.
    nonisolated static func client(_ connection: PhoneConnection, token: String?, transport: MCPClient.Transport? = nil) -> MCPClient {
        MCPClient(url: connection.url, token: token, transport: transport)
    }

    func token(of id: String) -> String? {
        keychain ? Keychain.read(String.self, from: "connection.\(id)") : tokens[id]
    }

    /// Reaches the service, reads its tools and keeps it. Throws a sentence when that did not work.
    @discardableResult
    func connect(name: String, url: URL, token: String?, transport: MCPClient.Transport? = nil) async throws -> PhoneConnection {
        guard url.scheme == "https" || url.host() == "localhost" || url.host() == "127.0.0.1" else {
            throw MCPProblem(sentence: "The address must start with https://.")
        }
        let tools = try await MCPClient(url: url, token: token, transport: transport).tools()
        let id = "pc_\(UUID().uuidString.prefix(8).lowercased())"
        let unique = PhoneFolders.unique(name.trimmingCharacters(in: .whitespaces).isEmpty ? (url.host() ?? "Service") : name, among: connections.map(\.name))
        let connection = PhoneConnection(id: id, name: unique, url: url, tools: tools, createdAt: .now)
        if let token, !token.isEmpty {
            if keychain { Keychain.save(token, as: "connection.\(id)") } else { tokens[id] = token }
        }
        connections.append(connection)
        save()
        return connection
    }

    func disconnect(_ id: String) {
        connections.removeAll { $0.id == id }
        if keychain { Keychain.remove("connection.\(id)") } else { tokens[id] = nil }
        save()
    }

    private func save() {
        guard let data = try? JSONEncoder().encode(connections) else { return }
        try? data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}
