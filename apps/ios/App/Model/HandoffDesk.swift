import Foundation
import Observation

/// One question an agent handed to this phone, as the phone keeps it: what was asked, what went back.
nonisolated struct HandoffEntry: Codable, Hashable, Sendable, Identifiable {
    nonisolated enum State: String, Codable, Sendable {
        /// The phone's agent works on it.
        case working
        /// The answer went to the home.
        case answered
        /// The person did not let the agent ask, or the phone could not work on it; the home was told.
        case declined
        /// The answer did not reach the home; it goes again when the home is back.
        case unsent
    }

    var id: String
    var agentId: String
    var agentName: String
    var text: String
    var answer: String?
    var state: State
    /// What was changed on the phone and which files were sent, one line each.
    var changed: [String] = []
    var at: Date
    /// What goes to the home, kept until it arrived.
    var reply: AnswerHandoff?
}

/// Questions the home's agents hand to this phone. Only an agent the person let ask this phone gets
/// an answer: the first question of an agent asks the person. The phone keeps a list of what was
/// asked and what it sent back; that list never leaves the phone.
@Observable
final class HandoffDesk {
    /// Newest first.
    private(set) var entries: [HandoffEntry] = []
    /// The agents the person let ask this phone, by id.
    private(set) var allowed: Set<String> = []
    /// The agents the person did not let ask this phone, by id. One in neither set asks first.
    private(set) var refused: Set<String> = []
    /// Called after the person changed which agents may ask, so the home learns it.
    @ObservationIgnored var onChange: () -> Void = {}

    /// What the desk needs from the app to work on one question.
    struct Work {
        var client: HomeClient
        var personName: String?
        /// The phone's tools for this question, with sending to the home.
        var tools: (Handoff) -> PhoneTools
        var model: OnDeviceAgent
        var ask: (PhoneQuestion) async -> Bool
        /// Whether the home's model services may read the answer, asking the person when they have not said yet.
        var consent: () async -> Bool = { true }
    }

    @ObservationIgnored private let file: URL
    /// Hand-offs being worked on: one at a time, in the order they came.
    @ObservationIgnored private var taken: Set<String> = []
    @ObservationIgnored private var queue: Task<Void, Never>?

    /// Entries the list keeps.
    static let keep = 100

    nonisolated private struct Saved: Codable {
        var entries: [HandoffEntry]
        var allowed: [String]
        var refused: [String]?
    }

    init(file: URL = URL.applicationSupportDirectory.appending(path: "handoffs.json")) {
        self.file = file
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard let data = try? Data(contentsOf: file), let saved = try? JSONDecoder().decode(Saved.self, from: data) else { return }
        // Work that was cut off when the app closed is done again when the home hands it again.
        entries = saved.entries.filter { $0.state != .working }
        allowed = Set(saved.allowed)
        refused = Set(saved.refused ?? [])
    }

    /// Which agents may ask this phone, as the home learns it.
    var agents: DeviceAgents {
        DeviceAgents(allowed: allowed.sorted(), refused: refused.sorted())
    }

    /// Resolves when the questions taken so far are worked on.
    func idle() async {
        await queue?.value
    }

    func entries(of agentId: String) -> [HandoffEntry] {
        entries.filter { $0.agentId == agentId }
    }

    func isAllowed(_ agentId: String) -> Bool { allowed.contains(agentId) }

    func setAllowed(_ agentId: String, _ allow: Bool) {
        if allow {
            allowed.insert(agentId)
            refused.remove(agentId)
        } else {
            allowed.remove(agentId)
            refused.insert(agentId)
        }
        save()
        onChange()
    }

    /// Forgets the home's agents, keeping nothing of what they asked.
    func forgetHome() {
        queue?.cancel()
        queue = nil
        taken = []
        entries = []
        allowed = []
        refused = []
        save()
    }

    /// Takes a hand-off for this phone. One that is taken already, or was answered, is passed over.
    func take(_ handoff: Handoff, with work: Work) {
        guard handoff.state == .open, !taken.contains(handoff.id) else { return }
        let known = entries.first { $0.id == handoff.id }
        // An answer that did not arrive goes again as it was; the work is not done twice.
        if let known, known.state == .unsent, let reply = known.reply {
            taken.insert(handoff.id)
            Task {
                var entry = known
                entry.state = reply.declined == true ? .declined : .answered
                await finish(handoff, entry: entry, send: reply, client: work.client)
                taken.remove(handoff.id)
            }
            return
        }
        guard known == nil else { return }
        taken.insert(handoff.id)
        let previous = queue
        queue = Task {
            await previous?.value
            await self.handle(handoff, with: work)
            self.taken.remove(handoff.id)
        }
    }

    private func handle(_ handoff: Handoff, with work: Work) async {
        if refused.contains(handoff.agentId) {
            let text = "The person did not let \(handoff.agentName) ask this device."
            await finish(handoff, entry: entry(handoff, answer: text, state: .declined), send: AnswerHandoff(text: text, declined: true), client: work.client)
            return
        }
        if !allowed.contains(handoff.agentId) {
            let question = PhoneQuestion(
                title: String(localized: "Let \(handoff.agentName) ask this phone?"),
                detail: String(localized: "“\(handoff.text)”\n\nThe model on this phone reads your calendar, reminders, contacts and the folders connected here to answer. Only the answer goes to \(handoff.agentName)."),
                yes: String(localized: "Allow"), no: String(localized: "Don't allow")
            )
            guard await work.ask(question) else {
                setAllowed(handoff.agentId, false)
                let text = "The person did not let \(handoff.agentName) ask this device."
                await finish(handoff, entry: entry(handoff, answer: text, state: .declined), send: AnswerHandoff(text: text, declined: true), client: work.client)
                return
            }
            setAllowed(handoff.agentId, true)
        }
        guard await work.consent() else {
            let text = "The person has not allowed the model services of the home to read answers from this device."
            await finish(handoff, entry: entry(handoff, answer: text, state: .declined), send: AnswerHandoff(text: text, declined: true), client: work.client)
            return
        }
        var current = entry(handoff, answer: nil, state: .working)
        record(current)
        let tools = work.tools(handoff)
        do {
            let text = try await work.model.work(on: handoff, personName: work.personName, tools: tools)
            current.answer = text
            current.state = .answered
            current.changed = await tools.changed
            let files = await tools.sent.map(\.id)
            await finish(handoff, entry: current, send: AnswerHandoff(text: text, files: files.isEmpty ? nil : files), client: work.client)
        } catch let problem as OnDeviceAgent.Problem {
            let reason: String = switch problem {
            case .unavailable(let sentence), .failed(let sentence): sentence
            }
            current.answer = reason
            current.state = .declined
            current.changed = await tools.changed
            await finish(handoff, entry: current, send: AnswerHandoff(text: "This device could not work on it: \(reason)", declined: true), client: work.client)
        } catch {
            entries.removeAll { $0.id == handoff.id }
            save()
        }
    }

    private func entry(_ handoff: Handoff, answer: String?, state: HandoffEntry.State) -> HandoffEntry {
        HandoffEntry(id: handoff.id, agentId: handoff.agentId, agentName: handoff.agentName, text: handoff.text, answer: answer, state: state, at: .now)
    }

    /// Sends the answer. When the home is out of reach it stays marked and goes when the home hands the question again.
    private func finish(_ handoff: Handoff, entry: HandoffEntry, send: AnswerHandoff, client: HomeClient) async {
        var entry = entry
        entry.reply = send
        do {
            try await client.answerHandoff(handoff.id, send)
        } catch HomeError.alreadyAnswered, HomeError.notFound {
            // Another copy of this app answered, or the home let go of the question.
        } catch {
            entry.state = .unsent
        }
        record(entry)
    }

    private func record(_ entry: HandoffEntry) {
        entries.removeAll { $0.id == entry.id }
        entries.insert(entry, at: 0)
        if entries.count > Self.keep { entries.removeLast(entries.count - Self.keep) }
        save()
    }

    private func save() {
        let saved = Saved(entries: entries, allowed: Array(allowed).sorted(), refused: Array(refused).sorted())
        guard let data = try? JSONEncoder().encode(saved) else { return }
        try? data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}
