import Foundation

// What a home and its devices say to each other: the Swift side of packages/protocol/src/index.ts.
// Times stay the ISO 8601 strings the home sends; `Timestamp` reads and writes them.

nonisolated let protocolVersion = 1

/// Where a message came in or went out.
nonisolated enum Channel: OpenEnum {
    case app, watch, slack, email, whatsapp, signal, home
    case unknown(String)

    static let known: [String: Channel] = [
        "app": .app, "watch": .watch, "slack": .slack, "email": .email,
        "whatsapp": .whatsapp, "signal": .signal, "home": .home,
    ]
    var unknownValue: String? { if case .unknown(let raw) = self { raw } else { nil } }
}

nonisolated enum DeviceKind: OpenEnum {
    case phone, watch, computer, browser
    case unknown(String)

    static let known: [String: DeviceKind] = ["phone": .phone, "watch": .watch, "computer": .computer, "browser": .browser]
    var unknownValue: String? { if case .unknown(let raw) = self { raw } else { nil } }
}

// MARK: - Cards

nonisolated enum CardKind: OpenEnum {
    /// The agent wants to do something and waits for a yes or no.
    case approval
    /// The agent needs an answer: choices, fields or both.
    case question
    /// Sign in to an account or app; `url` opens the sign-in.
    case connect
    /// Fields the home stores and the model never reads.
    case secret
    /// A code and a QR to add a device.
    case pairing
    /// Someone wants to connect, or shares an agent.
    case contact
    /// A result worth a card; never waits.
    case info
    case unknown(String)

    static let known: [String: CardKind] = [
        "approval": .approval, "question": .question, "connect": .connect, "secret": .secret,
        "pairing": .pairing, "contact": .contact, "info": .info,
    ]
    var unknownValue: String? { if case .unknown(let raw) = self { raw } else { nil } }
}

nonisolated enum CardLevel: OpenEnum {
    /// Waits for the person and is listed under what needs you.
    case needsYou
    case update
    case unknown(String)

    static let known: [String: CardLevel] = ["needs_you": .needsYou, "update": .update]
    var unknownValue: String? { if case .unknown(let raw) = self { raw } else { nil } }
}

nonisolated enum CardState: OpenEnum {
    case open, answered, expired
    case unknown(String)

    static let known: [String: CardState] = ["open": .open, "answered": .answered, "expired": .expired]
    var unknownValue: String? { if case .unknown(let raw) = self { raw } else { nil } }
}

nonisolated enum FieldType: OpenEnum {
    case text, secret, choice, multi
    /// A folder of the home's computer the person picks; its value is the folder's path.
    case folder
    case unknown(String)

    static let known: [String: FieldType] = [
        "text": .text, "secret": .secret, "choice": .choice, "multi": .multi, "folder": .folder,
    ]
    var unknownValue: String? { if case .unknown(let raw) = self { raw } else { nil } }
}

nonisolated enum ActionStyle: OpenEnum {
    case primary, plain, danger
    case unknown(String)

    static let known: [String: ActionStyle] = ["primary": .primary, "plain": .plain, "danger": .danger]
    var unknownValue: String? { if case .unknown(let raw) = self { raw } else { nil } }
}

nonisolated struct FieldOption: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var label: String
}

nonisolated struct CardField: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var label: String
    var type: FieldType
    var options: [FieldOption]?
    var placeholder: String?
    var required: Bool?
    /// What the field starts with. The person may change it; it is sent like a typed value.
    var value: FieldValue?
}

nonisolated struct CardAction: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var label: String
    var style: ActionStyle
}

/// The value of one field: a text, or the chosen options of a `multi` field.
nonisolated enum FieldValue: Codable, Hashable, Sendable {
    case text(String)
    case many([String])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let many = try? container.decode([String].self) {
            self = .many(many)
        } else {
            self = .text(try container.decode(String.self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .text(let text): try container.encode(text)
        case .many(let many): try container.encode(many)
        }
    }
}

nonisolated struct CardAnswer: Codable, Hashable, Sendable {
    var action: String
    /// Field values by field id. A secret field reads "•••" here.
    var values: [String: FieldValue]?
    /// Device name or channel the answer came from.
    var by: String
    /// In a group home: the admin whose device answered.
    var admin: Admin? = nil
    var at: String
}

/// One of the people who run a group home; a device of it belongs to one admin.
nonisolated struct Admin: Codable, Hashable, Sendable {
    var id: String
    var name: String
}

nonisolated struct Card: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var kind: CardKind
    var level: CardLevel
    var state: CardState
    var title: String
    /// Markdown.
    var body: String?
    var fields: [CardField]?
    var actions: [CardAction]
    var url: String?
    /// Text to draw as a QR code.
    var qr: String?
    var answer: CardAnswer?
    var agentId: String
    var conversationId: String
    var messageId: String
    var createdAt: String

    /// What `answer.by` reads when the home answered a `connect` card after the sign-in.
    static let signIn = "sign-in"

    /// True while it waits for the person.
    var needsYou: Bool { state == .open && level == .needsYou }

    /// The action the person chose, once answered.
    var chosen: CardAction? {
        guard let answer else { return nil }
        return actions.first { $0.id == answer.action }
    }

    /// True when a notification can answer it: at most two actions and nothing to fill in.
    var answersFromNotification: Bool {
        state == .open && (1 ... 2).contains(actions.count) && (fields ?? []).isEmpty
    }
}

/// What a device sends to answer a card.
nonisolated struct AnswerCard: Codable, Hashable, Sendable {
    var action: String
    var values: [String: FieldValue]?
}

// MARK: - Messages

nonisolated enum ActivityState: OpenEnum {
    case running, done, failed
    case unknown(String)

    static let known: [String: ActivityState] = ["running": .running, "done": .done, "failed": .failed]
    var unknownValue: String? { if case .unknown(let raw) = self { raw } else { nil } }
}

/// One piece of a message. A type this app does not know, or a known one it cannot read, becomes
/// `.unknown` and never breaks the message.
nonisolated enum Part: Codable, Hashable, Sendable {
    /// Markdown. Grows by `message.delta` while the message is streaming.
    case text(String)
    case card(Card)
    /// A document the chat opens beside itself.
    case document(id: String, title: String)
    /// A file the person attached, or one the agent made.
    case file(FileRef)
    /// An artifact the chat opens beside itself.
    case artifact(id: String, title: String)
    /// One line about what the agent is doing.
    case activity(label: String, state: ActivityState)
    case unknown(type: String, title: String?)

    private enum Key: String, CodingKey { case type, text, card, documentId, title, label, state, file, artifactId }

    init(from decoder: Decoder) throws {
        guard let container = try? decoder.container(keyedBy: Key.self),
              let type = try? container.decode(String.self, forKey: .type) else {
            self = .unknown(type: "", title: nil)
            return
        }
        let title = try? container.decode(String.self, forKey: .title)
        switch type {
        case "text":
            if let text = try? container.decode(String.self, forKey: .text) {
                self = .text(text)
                return
            }
        case "card":
            if let card = try? container.decode(Card.self, forKey: .card) {
                self = .card(card)
                return
            }
            // A card this app cannot read still shows its title.
            if let nested = try? container.nestedContainer(keyedBy: Key.self, forKey: .card),
               let cardTitle = try? nested.decode(String.self, forKey: .title) {
                self = .unknown(type: type, title: cardTitle)
                return
            }
        case "document":
            if let id = try? container.decode(String.self, forKey: .documentId), let title {
                self = .document(id: id, title: title)
                return
            }
        case "file":
            if let file = try? container.decode(FileRef.self, forKey: .file) {
                self = .file(file)
                return
            }
        case "artifact":
            if let id = try? container.decode(String.self, forKey: .artifactId), let title {
                self = .artifact(id: id, title: title)
                return
            }
        case "activity":
            if let label = try? container.decode(String.self, forKey: .label),
               let state = try? container.decode(ActivityState.self, forKey: .state) {
                self = .activity(label: label, state: state)
                return
            }
        default:
            break
        }
        self = .unknown(type: type, title: title)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Key.self)
        switch self {
        case .text(let text):
            try container.encode("text", forKey: .type)
            try container.encode(text, forKey: .text)
        case .card(let card):
            try container.encode("card", forKey: .type)
            try container.encode(card, forKey: .card)
        case .document(let id, let title):
            try container.encode("document", forKey: .type)
            try container.encode(id, forKey: .documentId)
            try container.encode(title, forKey: .title)
        case .file(let file):
            try container.encode("file", forKey: .type)
            try container.encode(file, forKey: .file)
        case .artifact(let id, let title):
            try container.encode("artifact", forKey: .type)
            try container.encode(id, forKey: .artifactId)
            try container.encode(title, forKey: .title)
        case .activity(let label, let state):
            try container.encode("activity", forKey: .type)
            try container.encode(label, forKey: .label)
            try container.encode(state, forKey: .state)
        case .unknown(let type, let title):
            try container.encode(type, forKey: .type)
            try container.encodeIfPresent(title, forKey: .title)
        }
    }
}

nonisolated enum Role: OpenEnum {
    case you, agent
    /// A line by the home itself, e.g. "Answered on your watch".
    case note
    case unknown(String)

    static let known: [String: Role] = ["you": .you, "agent": .agent, "note": .note]
    var unknownValue: String? { if case .unknown(let raw) = self { raw } else { nil } }
}

nonisolated enum MessageState: OpenEnum {
    case streaming, done, failed
    case unknown(String)

    static let known: [String: MessageState] = ["streaming": .streaming, "done": .done, "failed": .failed]
    var unknownValue: String? { if case .unknown(let raw) = self { raw } else { nil } }
}

nonisolated struct Message: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var conversationId: String
    var role: Role
    var agentId: String?
    var channel: Channel
    var parts: [Part]
    var state: MessageState
    /// Which model wrote it, e.g. "ollama:qwen3.8:27b-mlx".
    var model: String?
    /// In a room: who wrote a message that is not the person's own.
    var from: Writer? = nil
    var createdAt: String

    /// All text parts, joined: what a preview or a voice reads.
    var text: String {
        parts.compactMap { if case .text(let text) = $0 { text } else { nil } }.joined(separator: "\n\n")
    }

    var cards: [Card] {
        parts.compactMap { if case .card(let card) = $0 { card } else { nil } }
    }

    var files: [FileRef] {
        parts.compactMap { if case .file(let file) = $0 { file } else { nil } }
    }
}

/// The person's record as the home has it, and the version the home asks a device to sign.
nonisolated struct PersonState: Codable, Hashable, Sendable {
    /// What this device needs of the record that counts: whose it is and which key signs.
    nonisolated struct Record: Codable, Hashable, Sendable {
        var id: String
        var name: String
        var handle: String?
        /// The person's public key (Ed25519, base64url).
        var key: String
    }

    nonisolated struct Proposed: Codable, Hashable, Sendable {
        /// The text to sign, exactly as it is.
        var payload: String
        var why: String
    }

    var record: Record?
    var proposed: Proposed?
}

/// What the home answers about an invite link: the card that asks is in the chat, or why not.
nonisolated struct InviteOpened: Codable, Equatable, Sendable {
    var opened: Bool
    var message: String?
}

/// One version of the person's record as it is handed in: the text, and the signature over it.
nonisolated struct SignedRecord: Codable, Hashable, Sendable {
    var payload: String
    var sig: String
}

/// Who wrote a message in a room. `kind` is set when it is an agent; `of` then names whose.
nonisolated struct Writer: Codable, Hashable, Sendable {
    var name: String
    var kind: EngentyKind?
    var of: String?
    /// In a group home: the admin who wrote a message of the people's side.
    var admin: String? = nil
}

nonisolated struct SendMessage: Codable, Hashable, Sendable {
    var text: String
    /// The person spoke and listens: the agent answers short, in plain sentences.
    var spoken: Bool?
    /// Made by the device; the same id is stored once.
    var clientId: String?
    /// The ids of the files uploaded for it, at most `FileLimits.perMessage`. `text` may then be empty.
    var files: [String]?
}

/// An exchange a phone had with its own model while the home was out of reach.
nonisolated struct ImportMessages: Codable, Hashable, Sendable {
    nonisolated struct Entry: Codable, Hashable, Sendable {
        var role: Role
        var text: String
        var createdAt: String
        var model: String?
        var clientId: String
    }

    var messages: [Entry]
}

// MARK: - Agents and conversations

nonisolated enum AgentOrigin: OpenEnum {
    case own
    /// Lives in someone else's home.
    case shared
    /// No agent: a conversation of several people and agents, listed among the agents.
    case room
    case unknown(String)

    static let known: [String: AgentOrigin] = ["own": .own, "shared": .shared, "room": .room]
    var unknownValue: String? { if case .unknown(let raw) = self { raw } else { nil } }
}

nonisolated enum AgentState: OpenEnum {
    case idle, working, needsYou
    case unknown(String)

    static let known: [String: AgentState] = ["idle": .idle, "working": .working, "needs_you": .needsYou]
    var unknownValue: String? { if case .unknown(let raw) = self { raw } else { nil } }
}

nonisolated struct Agent: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var name: String
    var kind: EngentyKind
    var about: String
    var origin: AgentOrigin
    /// Handle of the person who shares it, e.g. "anna@anna.example".
    var from: String?
    var state: AgentState
    /// Open cards that wait for the person.
    var open: Int
    /// The agent's one conversation with the person.
    var conversationId: String
    /// The first agent of a home. It cannot be removed.
    var main: Bool
    /// One line of the newest message in the conversation, "" when there is none.
    var preview: String = ""
    /// Messages of the agent the person has not read.
    var unread: Int = 0
    /// When the conversation last changed, "" when the home does not say.
    var updatedAt: String = ""
}

nonisolated extension Agent {
    /// An older home sends no `preview`, `unread` or `updatedAt`: they read as empty, zero and unknown.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        kind = try container.decode(EngentyKind.self, forKey: .kind)
        about = try container.decode(String.self, forKey: .about)
        origin = try container.decode(AgentOrigin.self, forKey: .origin)
        from = try container.decodeIfPresent(String.self, forKey: .from)
        state = try container.decode(AgentState.self, forKey: .state)
        open = try container.decode(Int.self, forKey: .open)
        conversationId = try container.decode(String.self, forKey: .conversationId)
        main = try container.decode(Bool.self, forKey: .main)
        preview = (try? container.decodeIfPresent(String.self, forKey: .preview)) ?? ""
        unread = (try? container.decodeIfPresent(Int.self, forKey: .unread)) ?? 0
        updatedAt = (try? container.decodeIfPresent(String.self, forKey: .updatedAt)) ?? ""
    }
}

nonisolated struct Conversation: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var agentId: String
    var updatedAt: String
    var preview: String
    var unread: Int
}

// MARK: - Documents

nonisolated enum DocumentFormat: OpenEnum {
    case markdown
    case unknown(String)

    static let known: [String: DocumentFormat] = ["markdown": .markdown]
    var unknownValue: String? { if case .unknown(let raw) = self { raw } else { nil } }
}

nonisolated enum Author: OpenEnum {
    case you, agent
    case unknown(String)

    static let known: [String: Author] = ["you": .you, "agent": .agent]
    var unknownValue: String? { if case .unknown(let raw) = self { raw } else { nil } }
}

nonisolated struct DocumentMeta: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var title: String
    var format: DocumentFormat
    var version: Int
    var updatedAt: String
    var updatedBy: Author
    var conversationId: String
}

nonisolated struct Document: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var title: String
    var format: DocumentFormat
    var version: Int
    var updatedAt: String
    var updatedBy: Author
    var conversationId: String
    var content: String
}

nonisolated struct SaveDocument: Codable, Hashable, Sendable {
    var content: String
    var title: String?
    /// The version the edit started from. A newer one on the home answers 409.
    var baseVersion: Int
}

// MARK: - Home, devices, models

nonisolated struct HomeInfo: Codable, Hashable, Sendable {
    var `protocol`: Int
    var version: String
    /// The person's name as the agent uses it.
    var name: String
    /// `name@host` once the home has a public address.
    var handle: String?
    /// Ed25519 public key, base64url.
    var publicKey: String
    /// A hosted Bot Server at `<name>.wizards.bot`, run by engenty.
    var hosted: Bool?
    /// A group home: it belongs to a team, and `name` is the team's.
    var group: HomeGroup? = nil
}

nonisolated struct HomeGroup: Codable, Hashable, Sendable {
    var name: String
}

nonisolated enum PushEnvironment: OpenEnum {
    case development, production
    case unknown(String)

    static let known: [String: PushEnvironment] = ["development": .development, "production": .production]
    var unknownValue: String? { if case .unknown(let raw) = self { raw } else { nil } }
}

nonisolated struct Push: Codable, Hashable, Sendable {
    var token: String
    var environment: PushEnvironment
    /// Bundle id the token belongs to.
    var topic: String
}

nonisolated struct PairRequest: Codable, Hashable, Sendable {
    var code: String
    var name: String
    var kind: DeviceKind
    var push: Push?
}

/// What a phone sends to pair its watch.
nonisolated struct AddDevice: Codable, Hashable, Sendable {
    var name: String
    var kind: DeviceKind
}

nonisolated struct Device: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var name: String
    var kind: DeviceKind
    var createdAt: String
    var seenAt: String
    /// What the device offers its agents, once it said so.
    var resources: [DeviceResource]? = nil
    /// Which agents may ask it, as the person said on it.
    var agents: DeviceAgents? = nil
    /// In a group home: whose device it is.
    var admin: Admin? = nil
}

nonisolated struct PairResponse: Codable, Hashable, Sendable {
    var token: String
    var device: Device
    var home: HomeInfo
}

nonisolated struct QuietHours: Codable, Hashable, Sendable {
    var from: Int
    var to: Int
    var timezone: String
}

/// Changes to this device. A field that is left out stays as it is; `push: .some(nil)` removes the token.
nonisolated struct UpdateDevice: Encodable, Hashable, Sendable {
    var name: String?
    var push: Push??
    var quiet: QuietHours??

    private enum Key: String, CodingKey { case name, push, quiet }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Key.self)
        try container.encodeIfPresent(name, forKey: .name)
        if let push { try container.encode(push, forKey: .push) }
        if let quiet { try container.encode(quiet, forKey: .quiet) }
    }
}

nonisolated enum ModelSourceKind: OpenEnum {
    case ollama
    /// A signed-in app on a computer.
    case subscription
    case gateway
    case unknown(String)

    static let known: [String: ModelSourceKind] = ["ollama": .ollama, "subscription": .subscription, "gateway": .gateway]
    var unknownValue: String? { if case .unknown(let raw) = self { raw } else { nil } }
}

nonisolated struct ModelSource: Codable, Hashable, Sendable, Identifiable {
    nonisolated struct Model: Codable, Hashable, Sendable, Identifiable {
        var id: String
        var label: String
    }

    var id: String
    var kind: ModelSourceKind
    var label: String
    /// Device name of the computer it runs on, or "the cloud" for a gateway.
    var `where`: String
    var online: Bool
    var models: [Model]
    /// The service outside the person's own computers that reads what this source is given; nil
    /// for a model on the person's own computers, such as Ollama.
    var service: String? = nil
}

/// A company whose models read what the person writes when the home uses them: Anthropic for
/// Claude, OpenAI for Codex, a gateway such as OpenRouter.
nonisolated struct ModelService: Codable, Hashable, Sendable, Identifiable {
    nonisolated struct Agreed: Codable, Hashable, Sendable {
        var at: String
        /// The device the person said yes on.
        var by: String
    }

    var id: String
    /// The company, e.g. "Anthropic".
    var label: String
    /// The sources that send to it, e.g. ["Claude"].
    var sources: [String]
    /// Whether the home would use one of its models now.
    var inUse: Bool
    /// When and where the person said yes; nil while there is none.
    var agreed: Agreed?

    /// "Anthropic – Claude".
    var line: String {
        sources.isEmpty ? label : "\(label) – \(sources.joined(separator: ", "))"
    }
}

nonisolated struct Models: Codable, Hashable, Sendable {
    var sources: [ModelSource]
    /// Model refs `source:model` in the order the home tries them. Empty: the home picks.
    var order: [String]
    /// The model the next message would use.
    var current: String?
    /// The services in use and those the person said yes to. An older home sends none.
    var services: [ModelService] = []

    /// The services in use that wait for the person's yes before anything written here goes.
    var waitingForYes: [ModelService] {
        services.filter { $0.inUse && $0.agreed == nil }
    }
}

nonisolated extension Models {
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sources = try container.decode([ModelSource].self, forKey: .sources)
        order = try container.decode([String].self, forKey: .order)
        current = try container.decodeIfPresent(String.self, forKey: .current)
        services = (try? container.decodeIfPresent([ModelService].self, forKey: .services)) ?? []
    }
}

/// What a device sends when the person said yes to services: their ids.
nonisolated struct AgreeToServices: Codable, Hashable, Sendable {
    var services: [String]
}

// MARK: - Events

/// One event of the home's stream. A type this app does not know, or a known one it cannot read,
/// becomes `.unknown` and is skipped.
nonisolated enum HomeEvent: Decodable, Hashable, Sendable {
    case messageCreated(Message)
    /// Appends `text` to the text part at `part`. Not replayed after a reconnect.
    case messageDelta(conversationId: String, messageId: String, part: Int, text: String)
    case messageUpdated(Message)
    case cardUpdated(Card)
    case agentUpdated(Agent)
    case agentRemoved(agentId: String)
    case documentUpdated(DocumentMeta)
    /// An artifact was written anew; a device that shows it reads it again.
    case artifactUpdated(ArtifactMeta)
    case modelsUpdated(Models)
    /// The whole list of connected folders, after each change.
    case foldersUpdated([Folder])
    /// The person's devices with what each offers, after a device said what it offers.
    case devicesUpdated([Device])
    /// A hand-off for this device, made or answered.
    case handoffUpdated(Handoff)
    /// The device missed events: load agents, items and open conversations again.
    case reset
    case unknown(type: String)

    private enum Key: String, CodingKey {
        case type, message, conversationId, messageId, part, text, card, agent, agentId, document, artifact, models, folders
        case devices, handoff
    }

    init(from decoder: Decoder) throws {
        guard let container = try? decoder.container(keyedBy: Key.self),
              let type = try? container.decode(String.self, forKey: .type) else {
            self = .unknown(type: "")
            return
        }
        let read: HomeEvent? = switch type {
        case "message.created":
            (try? container.decode(Message.self, forKey: .message)).map(HomeEvent.messageCreated)
        case "message.updated":
            (try? container.decode(Message.self, forKey: .message)).map(HomeEvent.messageUpdated)
        case "message.delta":
            Self.delta(container)
        case "card.updated":
            (try? container.decode(Card.self, forKey: .card)).map(HomeEvent.cardUpdated)
        case "agent.updated":
            (try? container.decode(Agent.self, forKey: .agent)).map(HomeEvent.agentUpdated)
        case "agent.removed":
            (try? container.decode(String.self, forKey: .agentId)).map { .agentRemoved(agentId: $0) }
        case "document.updated":
            (try? container.decode(DocumentMeta.self, forKey: .document)).map(HomeEvent.documentUpdated)
        case "artifact.updated":
            (try? container.decode(ArtifactMeta.self, forKey: .artifact)).map(HomeEvent.artifactUpdated)
        case "models.updated":
            (try? container.decode(Models.self, forKey: .models)).map(HomeEvent.modelsUpdated)
        case "folders.updated":
            (try? container.decode([Folder].self, forKey: .folders)).map(HomeEvent.foldersUpdated)
        case "devices.updated":
            (try? container.decode([Device].self, forKey: .devices)).map(HomeEvent.devicesUpdated)
        case "handoff.updated":
            (try? container.decode(Handoff.self, forKey: .handoff)).map(HomeEvent.handoffUpdated)
        case "reset":
            .reset
        default:
            nil
        }
        self = read ?? .unknown(type: type)
    }

    private static func delta(_ container: KeyedDecodingContainer<Key>) -> HomeEvent? {
        guard let conversationId = try? container.decode(String.self, forKey: .conversationId),
              let messageId = try? container.decode(String.self, forKey: .messageId),
              let part = try? container.decode(Int.self, forKey: .part),
              let text = try? container.decode(String.self, forKey: .text) else { return nil }
        return .messageDelta(conversationId: conversationId, messageId: messageId, part: part, text: text)
    }
}

// MARK: - Errors and envelopes

/// The body of a 4xx or 5xx answer. A 409 also carries the card or document as the home has it.
nonisolated struct ErrorBody: Codable, Hashable, Sendable {
    var error: String
    var message: String
    var card: Card?
    var document: Document?
    /// With `needs_consent`: the services in use that wait for the person's yes.
    var services: [ModelService]?
}

nonisolated struct AgentsEnvelope: Codable, Sendable { var agents: [Agent] }
nonisolated struct MessagesEnvelope: Codable, Sendable {
    var messages: [Message]
    var more: Bool?
}
nonisolated struct MessageEnvelope: Codable, Sendable { var message: Message }
nonisolated struct CardEnvelope: Codable, Sendable { var card: Card }
nonisolated struct ItemsEnvelope: Codable, Sendable { var items: [Card] }
nonisolated struct DocumentsEnvelope: Codable, Sendable { var documents: [DocumentMeta] }

// MARK: - Times

/// ISO 8601 in UTC, as the home writes it: "2026-11-21T09:12:00.000Z".
nonisolated enum Timestamp {
    static func now() -> String { string(from: .now) }

    static func string(from date: Date) -> String {
        date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
    }

    static func date(from string: String) -> Date? {
        (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(string))
            ?? (try? Date.ISO8601FormatStyle().parse(string))
    }
}
