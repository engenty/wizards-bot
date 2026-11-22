import Foundation
import Observation

/// A message this device wrote while its home was out of reach.
nonisolated struct LocalEntry: Codable, Hashable, Sendable {
    nonisolated enum Kind: String, Codable, Sendable {
        /// Part of an exchange with the model on this device; goes to the home with `import`.
        case onDevice
        /// No model could answer; the home gets it as a new message once it is back.
        case waiting
        /// A line by the app itself; stays on this device.
        case note
    }

    var message: Message
    var clientId: String
    var kind: Kind
}

/// What this device keeps on disk: the messages its home has not seen yet, and the last state of
/// the home, so the chat is there before the home answers.
@Observable
final class LocalStore {
    private(set) var entries: [String: [LocalEntry]] = [:]
    @ObservationIgnored private(set) var agents: [Agent] = []
    @ObservationIgnored private(set) var messages: [String: [Message]] = [:]

    nonisolated private struct Saved: Codable {
        var entries: [String: [LocalEntry]]
        var agents: [Agent]
        var messages: [String: [Message]]
    }

    @ObservationIgnored private let file: URL = {
        let folder = URL.applicationSupportDirectory
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder.appending(path: "state.json")
    }()

    init() {
        guard let data = try? Data(contentsOf: file), let saved = try? JSONDecoder().decode(Saved.self, from: data) else { return }
        // A reply that was being written when the app closed is over.
        entries = saved.entries.mapValues { list in
            list.map { entry in
                var entry = entry
                if entry.message.state == .streaming { entry.message.state = .failed }
                return entry
            }
        }
        agents = saved.agents
        messages = saved.messages
    }

    func save() {
        let saved = Saved(entries: entries, agents: agents, messages: messages)
        guard let data = try? JSONEncoder().encode(saved) else { return }
        try? data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    func add(_ entry: LocalEntry) {
        entries[entry.message.conversationId, default: []].append(entry)
    }

    func update(_ messageId: String, in conversationId: String, _ change: (inout LocalEntry) -> Void) {
        guard let index = entries[conversationId]?.firstIndex(where: { $0.message.id == messageId }) else { return }
        change(&entries[conversationId]![index])
    }

    func remove(_ messageIds: Set<String>, from conversationId: String) {
        entries[conversationId]?.removeAll { messageIds.contains($0.message.id) }
        if entries[conversationId]?.isEmpty == true { entries[conversationId] = nil }
    }

    /// Remembers the home's last state; a conversation keeps its newest 50 messages.
    func remember(agents: [Agent], messages: [String: [Message]]) {
        self.agents = agents
        self.messages = messages.mapValues { Array($0.suffix(50)) }
    }

    /// Forgets the home, keeping what this device wrote on its own.
    func forgetHome() {
        agents = []
        messages = [:]
        save()
    }
}
