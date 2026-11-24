import Foundation

// What an agent keeps and does, and what it works with: the Swift side of `AgentDetail`, `Task`,
// `FileRef` and the folder shapes in packages/protocol/src/index.ts.

// MARK: - Tasks

/// What starts a task: a time or an event. A rule this app does not know decodes to `.unknown` and
/// never breaks the task it belongs to.
nonisolated enum TaskRule: Codable, Hashable, Sendable {
    /// Once, at that time.
    case at(String)
    case hourly
    /// Every day at `time` in the home's local time, "08:30".
    case daily(time: String)
    /// Monday to Friday at `time`.
    case weekdays(time: String)
    /// Every week; `weekday` 0 is Sunday.
    case weekly(time: String, weekday: Int)
    /// A file is added or changed in a connected folder, or in `path` inside it.
    case folder(folder: String, path: String?)
    /// Mail arrives in the agent's mailbox that is not from the person.
    case mail(from: String?, subject: String?)
    /// Another service posts to the task's own address.
    case webhook
    /// A read-only tool of a connection answers differently than at the last look, every `minutes`.
    case connection(connection: String, tool: String, minutes: Int)
    case unknown

    /// True for a rule that waits for an event rather than a time.
    var isEvent: Bool {
        switch self {
        case .folder, .mail, .webhook, .connection: true
        default: false
        }
    }

    private enum Key: String, CodingKey {
        case at, every, time, weekday, on, folder, path, from, subject, connection, tool, minutes
    }

    init(from decoder: Decoder) throws {
        guard let container = try? decoder.container(keyedBy: Key.self) else {
            self = .unknown
            return
        }
        func text(_ key: Key) -> String? { try? container.decodeIfPresent(String.self, forKey: key) }
        func number(_ key: Key) -> Int? {
            (try? container.decode(Int.self, forKey: key)) ?? (try? container.decode(Double.self, forKey: key)).map { Int($0) }
        }
        if let on = text(.on) {
            switch on {
            case "folder":
                self = text(.folder).map { .folder(folder: $0, path: text(.path)) } ?? .unknown
            case "mail":
                self = .mail(from: text(.from), subject: text(.subject))
            case "webhook":
                self = .webhook
            case "connection":
                if let connection = text(.connection), let minutes = number(.minutes) {
                    self = .connection(connection: connection, tool: text(.tool) ?? "", minutes: minutes)
                } else {
                    self = .unknown
                }
            default:
                self = .unknown
            }
            return
        }
        if let at = text(.at) {
            self = .at(at)
            return
        }
        switch text(.every) {
        case "hour":
            self = .hourly
        case "day":
            self = text(.time).map { .daily(time: $0) } ?? .unknown
        case "weekday":
            self = text(.time).map { .weekdays(time: $0) } ?? .unknown
        case "week":
            if let time = text(.time), let weekday = number(.weekday) {
                self = .weekly(time: time, weekday: weekday)
            } else {
                self = .unknown
            }
        default:
            self = .unknown
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Key.self)
        switch self {
        case .at(let at):
            try container.encode(at, forKey: .at)
        case .hourly:
            try container.encode("hour", forKey: .every)
        case .daily(let time):
            try container.encode("day", forKey: .every)
            try container.encode(time, forKey: .time)
        case .weekdays(let time):
            try container.encode("weekday", forKey: .every)
            try container.encode(time, forKey: .time)
        case .weekly(let time, let weekday):
            try container.encode("week", forKey: .every)
            try container.encode(time, forKey: .time)
            try container.encode(weekday, forKey: .weekday)
        case .folder(let folder, let path):
            try container.encode("folder", forKey: .on)
            try container.encode(folder, forKey: .folder)
            try container.encodeIfPresent(path, forKey: .path)
        case .mail(let from, let subject):
            try container.encode("mail", forKey: .on)
            try container.encodeIfPresent(from, forKey: .from)
            try container.encodeIfPresent(subject, forKey: .subject)
        case .webhook:
            try container.encode("webhook", forKey: .on)
        case .connection(let connection, let tool, let minutes):
            try container.encode("connection", forKey: .on)
            try container.encode(connection, forKey: .connection)
            try container.encode(tool, forKey: .tool)
            try container.encode(minutes, forKey: .minutes)
        case .unknown:
            break
        }
    }
}

/// How a task's last run ended.
nonisolated enum TaskOutcome: OpenEnum {
    case answered
    /// A quiet run with nothing to tell.
    case note
    /// A card waits.
    case asked
    case failed
    case unknown(String)

    static let known: [String: TaskOutcome] = ["answered": .answered, "note": .note, "asked": .asked, "failed": .failed]
    var unknownValue: String? { if case .unknown(let raw) = self { raw } else { nil } }
}

/// Something an agent does by itself: at a time or when an event happens, it gets a turn with
/// `prompt`. Set, changed and removed in the conversation. (`Task` in the protocol.)
nonisolated struct AgentTask: Codable, Hashable, Sendable, Identifiable {
    var id: String
    /// What it does, in a few words for a list: "Morning look".
    var title: String
    /// What the agent is told when the task starts.
    var prompt: String
    var rule: TaskRule
    /// When it runs next, for a scheduled task.
    var nextAt: String?
    /// The agent tells the person only when something needs them, and leaves a note otherwise.
    var quiet: Bool
    /// Why the home paused it, when it did. A paused task does not run.
    var paused: String?
    /// When it last ran.
    var lastAt: String?
    var last: TaskOutcome?
}

/// An agent with what it keeps and does: its memory, its tasks and what it works on right now.
nonisolated struct AgentDetail: Codable, Hashable, Sendable {
    /// While the agent works: what on, in one line ("" when it answers a message), and which turn
    /// in a row of how many the home gives before the person has to say go on.
    nonisolated struct Doing: Codable, Hashable, Sendable {
        var what: String
        var turn: Int
        var turns: Int
    }

    var agent: Agent
    /// What the agent wrote down about the person and their work. "" for a shared agent.
    var memory: String
    /// Scheduled tasks first, the next one first; then the tasks that wait for an event.
    var tasks: [AgentTask]
    var doing: Doing?
}

// MARK: - Files

/// A file the person gave the home: a picture, a photo from the camera, a document.
nonisolated struct FileRef: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var name: String
    /// The type the home found in the bytes, e.g. "image/jpeg".
    var mime: String
    var size: Int
}

// MARK: - Plugins

nonisolated enum PluginState: OpenEnum {
    case off, starting, ready, failed
    case unknown(String)

    static let known: [String: PluginState] = [
        "off": .off, "starting": .starting, "ready": .ready, "failed": .failed,
    ]
    var unknownValue: String? { if case .unknown(let raw) = self { raw } else { nil } }
}

/// A plugin in the home's plugins folder: skills and tools the person's own agents get while it
/// is on. Its tools run in a process of their own, with fewer rights than the home.
nonisolated struct Plugin: Codable, Hashable, Sendable, Identifiable {
    struct Skill: Codable, Hashable, Sendable {
        var name: String
        var description: String
    }
    struct Tool: Codable, Hashable, Sendable {
        var name: String
        var description: String
        /// False: the person is asked before each use.
        var readOnly: Bool
    }
    var id: String
    var name: String
    var version: String
    var description: String?
    /// Switched on by the person. A plugin found in the folder is off until then.
    var on: Bool
    var state: PluginState
    var problem: String?
    var skills: [Skill]
    var tools: [Tool]
}

/// `GET /v1/plugins`: where the home looks, the plugins, and what looked like one and is none.
nonisolated struct PluginsView: Codable, Hashable, Sendable {
    struct Problem: Codable, Hashable, Sendable {
        var path: String
        var message: String
    }
    var folder: String
    var plugins: [Plugin]
    var problems: [Problem]
}

// MARK: - Folders

nonisolated enum FolderAccess: OpenEnum {
    /// The agents read the files and change nothing.
    case read
    /// The agents may also change files, and ask before each change.
    case write
    case unknown(String)

    static let known: [String: FolderAccess] = ["read": .read, "write": .write]
    var unknownValue: String? { if case .unknown(let raw) = self { raw } else { nil } }
}

/// A folder of the home's computer the agents may use. The files stay where they are.
nonisolated struct Folder: Codable, Hashable, Sendable, Identifiable {
    var id: String
    /// How the agents and the person name it: the folder's own name, made unique.
    var name: String
    var path: String
    var access: FolderAccess
    var createdAt: String
}

/// What a device sends to connect a folder.
nonisolated struct ConnectFolder: Codable, Hashable, Sendable {
    var path: String
    var access: FolderAccess
    /// The chat it was connected from: its agent is told and answers there.
    var conversationId: String?
}

/// What a folder holds, shown before it is connected. Counting stops at a limit; `more` says the
/// folder holds more than was counted.
nonisolated struct FolderPreview: Codable, Hashable, Sendable {
    var path: String
    var name: String
    var files: Int
    var folders: Int
    var bytes: Int
    var more: Bool
}

/// The folders inside a folder of the person's home folder on the home's computer, for the
/// folder picker. Only folders, nothing hidden, nothing outside the home folder.
nonisolated struct FolderListing: Codable, Hashable, Sendable {
    nonisolated struct Entry: Codable, Hashable, Sendable, Identifiable {
        var name: String
        var path: String
        var id: String { path }
    }

    var path: String
    /// The folder one up; nil at the person's home folder, where the picker starts.
    var parent: String?
    /// The person's home folder: where the picker starts and what `~` stands for.
    var home: String
    var folders: [Entry]
}

/// A new folder `name` inside `parent`.
nonisolated struct MakeFolder: Codable, Hashable, Sendable {
    var parent: String
    var name: String
}

/// A key, token or password the person gave the home: what uses it and when it was set, never its value.
nonisolated struct SecretEntry: Codable, Hashable, Sendable, Identifiable {
    enum Kind: String, Codable, Sendable { case gateway, account, connection, channel, outside }
    var name: String
    var kind: Kind
    var label: String
    var setAt: String
    var id: String { name }
}

nonisolated struct SecretsEnvelope: Codable, Sendable { var secrets: [SecretEntry] }
nonisolated struct FoldersEnvelope: Codable, Sendable { var folders: [Folder] }
nonisolated struct FilesEnvelope: Codable, Sendable { var files: [FileRef] }
nonisolated struct FolderPathBody: Codable, Sendable { var path: String }
