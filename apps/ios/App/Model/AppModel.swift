import Foundation
import Observation
import UIKit

/// One conversation as the home has it.
nonisolated struct ChatThread: Sendable {
    var messages: [Message] = []
    /// True when the home has older messages than these.
    var more = false
    var loaded = false
    var loadingOlder = false
}

/// What can go wrong when connecting to a home, as a sentence for the person.
nonisolated struct PairingProblem: Error, Equatable {
    var message: String
}

/// Model services of the home that wait for the person's yes, while the person is asked.
nonisolated struct ConsentAsk: Identifiable, Equatable, Sendable {
    var id = UUID()
    var services: [ModelService]
}

/// The app's state: the home it is paired with, the agents, the conversations and what needs the person.
@Observable
final class AppModel {
    /// The agent of a device without a home.
    static let localAgent = Agent(
        id: "local", name: "wizards.bot", kind: .round, about: "", origin: .own, from: nil, state: .idle, open: 0,
        conversationId: "local", main: true
    )

    private(set) var link: HomeLink?
    /// The person chose to use this device without a home.
    private(set) var deviceOnly: Bool
    private(set) var agents: [Agent] = []
    /// Every open card that waits for the person, oldest first.
    private(set) var items: [Card] = []
    private(set) var models: Models?
    /// True while the event stream is open.
    private(set) var reachable = false
    private(set) var threads: [String: ChatThread] = [:]
    /// Messages on their way to the home, by conversation.
    private(set) var sending: [String: [Message]] = [:]
    private(set) var currentAgentId: String?
    private(set) var document: DocumentSession?
    /// The artifact open beside the chat, in the place of a document.
    private(set) var artifact: ArtifactSession?
    /// True while the agent on screen is shown beside the chat, where a document would be.
    private(set) var showsAbout = false
    /// The connected folders of the home's computer; nil until loaded.
    private(set) var folders: [Folder]?
    /// Said on the pairing screen, e.g. after the home signed this device out.
    private(set) var pairingNote: String?
    /// The person's devices with what each offers its agents; nil until loaded.
    private(set) var devices: [Device]?
    /// A group home's team, when the home belongs to one; nil for a person's own home.
    private(set) var group: HomeGroup?
    /// In a group home: the admin this phone belongs to, as the home lists its devices.
    var admin: Admin? {
        devices?.first { $0.id == link?.deviceId }?.admin
    }
    /// A change the phone's agent wants to make, or a file it wants to send, while the person is asked.
    private(set) var question: PhoneQuestion?
    /// A call or a message from a card, while the person looks at it.
    var phoneAction: PhoneAction?
    /// Where what the person writes would go, while the person is asked for a yes.
    private(set) var consent: ConsentAsk?

    var showsItems = false
    /// Per conversation, the question the person picked for their next message.
    private var picked: [String: Questions.Picked] = [:]
    /// The forms that are being filled in, by their question's card.
    @ObservationIgnored private var formDrafts: [String: FormDraft] = [:]
    /// Counts up when the input should take the focus: a question was picked.
    private(set) var focusComposer = 0
    var showsAgents = false
    var showsSettings = false
    var showsPairing = false
    /// The home this device just paired with, while the pairing screens show that it is connected.
    private(set) var justPaired: HomeLink?
    /// The pairing link the app was opened with, until the pairing screen took it.
    var pendingLink: PairingLink?
    /// Why an invite link the person scanned or opened did not open, while the app says so.
    var inviteProblem: String?

    let voice = Voice()
    let onDevice = OnDeviceAgent()
    let notifier = Notifier()
    let store = LocalStore()
    /// The files of the message being written.
    let attachments = Attachments()
    /// What this phone keeps: its calendar, reminders and contacts, read on this phone only.
    let phoneData: PhoneData = SystemPhoneData()
    /// The folders connected on this phone.
    let phoneFolders = PhoneFolders()
    /// The services signed in on this phone, their tokens in its Keychain.
    let phoneConnections = PhoneConnections()
    /// The questions the home's agents hand to this phone, and what went back.
    let desk = HandoffDesk()

    @ObservationIgnored private let watch = WatchBridge()
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var lastEventId: String?
    @ObservationIgnored private var syncing = false
    @ObservationIgnored private var active = false
    @ObservationIgnored private var started = false
    @ObservationIgnored private var notified: Set<String> = []
    @ObservationIgnored private var replyTasks: [String: Task<Void, Never>] = [:]
    /// Questions waiting behind the one on screen, with the answer each waits for.
    @ObservationIgnored private var questions: [(PhoneQuestion, CheckedContinuation<Bool, Never>)] = []
    @ObservationIgnored private var answering: CheckedContinuation<Bool, Never>?
    /// What waits for the answer to the consent on screen: a message, a hand-off.
    @ObservationIgnored private var consentWaiting: [CheckedContinuation<Bool, Never>] = []
    /// What this phone last told the home it offers.
    @ObservationIgnored private var offered: DeviceResources?

    private static let deviceOnlyKey = "deviceOnly"

    init() {
        link = HomeLink.stored
        deviceOnly = UserDefaults.standard.bool(forKey: Self.deviceOnlyKey)
    }

    // MARK: - Who the person talks to

    var isPaired: Bool { link != nil }
    var needsPairing: Bool { link == nil && !deviceOnly }
    /// True while the pairing screens fill the window: before the first home, and after a pairing
    /// there until the person opens the chat. Otherwise they open as a sheet.
    var pairingFills: Bool { needsPairing || (justPaired != nil && !showsPairing) }
    var client: HomeClient? { link.map(HomeClient.init) }

    var currentAgent: Agent? {
        agents.first { $0.id == currentAgentId } ?? agents.first
    }

    var conversationId: String? { currentAgent?.conversationId }

    func agent(_ id: String) -> Agent? {
        agents.first { $0.id == id }
    }

    /// The messages of a conversation as the chat shows them: the home's, then what this device
    /// wrote on its own and what is on its way.
    func messages(in conversationId: String) -> [Message] {
        let home = threads[conversationId]?.messages ?? []
        let local = (store.entries[conversationId] ?? []).map(\.message) + (sending[conversationId] ?? [])
        guard !local.isEmpty else { return home }
        return (home + local).sorted { $0.createdAt < $1.createdAt }
    }

    /// True for a message the model on this device wrote.
    func isOnDevice(_ message: Message) -> Bool {
        message.role == .agent && message.model == OnDeviceAgent.modelRef
    }

    /// True for a message of the person that waits for the home.
    func isWaiting(_ message: Message) -> Bool {
        store.entries[message.conversationId]?.contains { $0.message.id == message.id && $0.kind == .waiting } ?? false
    }

    /// True while the agent is writing in this conversation.
    func isReplying(in conversationId: String) -> Bool {
        messages(in: conversationId).last { $0.role == .agent }?.state == .streaming
    }

    // MARK: - Start

    func start() {
        guard !started else { return }
        started = true
        notifier.isOnScreen = { [weak self] in self?.isOnScreen($0) ?? false }
        notifier.onOpen = { [weak self] conversationId, agentId in self?.open(conversationId: conversationId, agentId: agentId) }
        notifier.onPush = { [weak self] in self?.sendPush($0) }
        notifier.start()
        voice.onUtterance = { [weak self] in self?.send($0, spoken: true) }
        desk.onChange = { [weak self] in Task { await self?.offer() } }
        onDevice.makeTools = { [unowned self] in
            PhoneTools(
                data: phoneData, folders: phoneFolders.folders, ask: { await self.ask($0) },
                connections: phoneConnections.connections, callTool: callTool
            )
        }
        watch.start { [weak self] in self?.link }
        if link != nil {
            agents = store.agents
            threads = store.messages.mapValues { ChatThread(messages: $0, more: true, loaded: false) }
            connect()
        } else if deviceOnly {
            agents = [Self.localAgent]
        }
    }

    /// The app came to the front or left it.
    func setActive(_ nowActive: Bool) {
        guard active != nowActive else { return }
        active = nowActive
        if nowActive {
            notifier.becameActive()
            // The stream may have died while the app slept: open it again without waiting.
            if link != nil, !reachable { connect() }
            // The person may have changed in Settings what this app may read.
            if reachable { Task { await offer() } }
            markRead()
        } else {
            if voice.mode != .off { voice.stopTalk() }
            remember()
        }
    }

    // MARK: - Pairing

    /// Connects this device to a home with a pairing code.
    func pair(home: URL, code: String) async throws {
        let client = HomeClient(baseURL: home)
        do {
            let info = try await client.home()
            guard info.protocol <= protocolVersion else {
                throw PairingProblem(message: String(localized: "This Bot Server is newer than the app. Update the app, then connect again."))
            }
            let request = PairRequest(code: PairingCode.tidy(code), name: UIDevice.current.name, kind: .phone, push: notifier.push)
            let response = try await client.pair(request)
            let link = HomeLink(baseURL: home, token: response.token, deviceId: response.device.id, name: response.home.name)
            link.store()
            adopt(link)
            justPaired = link
        } catch let problem as PairingProblem {
            throw problem
        } catch HomeError.unreachable {
            throw PairingProblem(message: String(localized: "No Bot Server answers at this address. Check the address and that this device is in the same network."))
        } catch let error as HomeError {
            throw PairingProblem(message: error.message
                ?? String(localized: "The Bot Server didn’t accept this code. A code is valid for 10 minutes and works once."))
        } catch {
            throw PairingProblem(message: String(localized: "That didn’t work. Try again."))
        }
    }

    private func adopt(_ link: HomeLink) {
        self.link = link
        pairingNote = nil
        agents = []
        currentAgentId = nil
        threads = [:]
        lastEventId = nil
        connect()
        watch.homeChanged()
    }

    /// The person leaves the pairing screens for the chat.
    func closePairing() {
        justPaired = nil
        showsPairing = false
    }

    /// Works without a home: the model on this device answers.
    func useDeviceOnly() {
        deviceOnly = true
        UserDefaults.standard.set(true, forKey: Self.deviceOnlyKey)
        pairingNote = nil
        if link == nil { agents = [Self.localAgent] }
    }

    /// Signs this device out of its home.
    func signOut() async {
        try? await client?.signOut()
        forgetHome(note: nil)
    }

    private func forgetHome(note: String?) {
        streamTask?.cancel()
        streamTask = nil
        HomeLink.forget()
        link = nil
        reachable = false
        agents = deviceOnly ? [Self.localAgent] : []
        items = []
        models = nil
        threads = [:]
        sending = [:]
        currentAgentId = nil
        document = nil
        artifact = nil
        showsAbout = false
        folders = nil
        _ = attachments.take()
        devices = nil
        answerConsentLocally(false)
        offered = nil
        desk.forgetHome()
        lastEventId = nil
        showsAgents = false
        showsItems = false
        showsSettings = false
        justPaired = nil
        pairingNote = note
        store.forgetHome()
        notifier.setBadge(0)
        watch.homeChanged()
    }

    // MARK: - The event stream

    private func connect() {
        streamTask?.cancel()
        guard let client else { return }
        let after = lastEventId
        streamTask = Task { [weak self] in
            for await signal in EventStream(client: client).signals(after: after) {
                guard let self, !Task.isCancelled else { return }
                self.handle(signal)
            }
        }
    }

    private func handle(_ signal: StreamSignal) {
        switch signal {
        case .open:
            reachable = true
            // Deltas are never replayed, so the open conversation is loaded again after every reconnect.
            Task {
                await refresh()
                await syncLocal()
                await offer()
                await loadHandoffs()
            }
        case .event(let event, let id):
            if let id { lastEventId = id }
            apply(event)
        case .closed:
            reachable = false
        case .unauthorized:
            forgetHome(note: String(localized: "Your Bot Server signed this device out. Connect it again."))
        }
    }

    /// Loads agents, what needs the person and the open conversation.
    func refresh() async {
        guard let client else { return }
        do {
            async let agents = client.agents()
            async let items = client.items()
            let (loadedAgents, loadedItems) = try await (agents, items)
            self.agents = loadedAgents
            self.items = loadedItems
            if currentAgent == nil || !loadedAgents.contains(where: { $0.id == currentAgentId }) {
                currentAgentId = loadedAgents.first { $0.main }?.id ?? loadedAgents.first?.id
            }
            notifier.setBadge(loadedItems.count)
            for card in loadedItems { noteCard(card) }
            models = try? await client.models()
            // A group home names its admins: whose another's message and answer are.
            group = (try? await client.home())?.group
            if group != nil { devices = try? await client.devices() }
            if let conversationId { await loadMessages(in: conversationId) }
            remember()
        } catch {
            handle(error)
        }
    }

    private func loadMessages(in conversationId: String) async {
        guard let client else { return }
        do {
            let page = try await client.messages(in: conversationId)
            threads[conversationId] = ChatThread(messages: page.messages, more: page.more, loaded: true)
            markRead()
        } catch {
            handle(error)
        }
    }

    /// Loads the page before the oldest message on screen.
    func loadOlder() async {
        guard let client, let conversationId, let thread = threads[conversationId], thread.loaded, thread.more,
              !thread.loadingOlder, let first = thread.messages.first else { return }
        threads[conversationId]?.loadingOlder = true
        defer { threads[conversationId]?.loadingOlder = false }
        do {
            let page = try await client.messages(in: conversationId, before: first.id)
            let known = Set(threads[conversationId]?.messages.map(\.id) ?? [])
            threads[conversationId]?.messages.insert(contentsOf: page.messages.filter { !known.contains($0.id) }, at: 0)
            threads[conversationId]?.more = page.more
        } catch {
            handle(error)
        }
    }

    private func handle(_ error: Error) {
        switch error as? HomeError {
        case .unauthorized:
            forgetHome(note: String(localized: "Your Bot Server signed this device out. Connect it again."))
        case .unreachable:
            reachable = false
        default:
            break
        }
    }

    private func apply(_ event: HomeEvent) {
        switch event {
        case .messageCreated(let message), .messageUpdated(let message):
            upsert(message)
            for card in message.cards { apply(card) }
            speakIfTalking(message)
            notifyAbout(message)
        case .messageDelta(let conversationId, let messageId, let part, let text):
            guard let index = threads[conversationId]?.messages.firstIndex(where: { $0.id == messageId }) else { return }
            var parts = threads[conversationId]!.messages[index].parts
            // The delta may open the text part it writes to.
            while parts.count <= part { parts.append(.text("")) }
            switch parts[part] {
            case .text(let soFar):
                parts[part] = .text(soFar + text)
                threads[conversationId]!.messages[index].parts = parts
                if isOnScreen(conversationId) { voice.reply(messageId, grew: text) }
            case .reasoning(let soFar):
                // What the model thinks is shown, never spoken.
                parts[part] = .reasoning(soFar + text)
                threads[conversationId]!.messages[index].parts = parts
            default:
                return
            }
        case .cardUpdated(let card):
            apply(card)
        case .agentUpdated(let agent):
            if let index = agents.firstIndex(where: { $0.id == agent.id }) {
                agents[index] = agent
            } else {
                agents.append(agent)
            }
        case .agentRemoved(let agentId):
            agents.removeAll { $0.id == agentId }
            if currentAgentId == agentId { select(agents.first { $0.main } ?? agents.first) }
        case .documentUpdated(let meta):
            document?.homeChanged(meta)
        case .artifactUpdated(let meta):
            artifact?.homeChanged(meta)
        case .modelsUpdated(let models):
            self.models = models
        case .foldersUpdated(let folders):
            self.folders = folders
        case .devicesUpdated(let devices):
            self.devices = devices
        case .handoffUpdated(let handoff):
            take(handoff)
        case .reset:
            Task { await refresh() }
        case .unknown:
            break
        }
    }

    private func upsert(_ message: Message) {
        let conversationId = message.conversationId
        // The person's own message came back from the home: the copy that was on its way goes.
        if message.role == .you, let text = sending[conversationId]?.first(where: {
            $0.text == message.text && $0.files.map(\.id) == message.files.map(\.id) && $0.state != .failed
        }) {
            sending[conversationId]?.removeAll { $0.id == text.id }
        }
        var thread = threads[conversationId] ?? ChatThread()
        if let index = thread.messages.firstIndex(where: { $0.id == message.id }) {
            thread.messages[index] = message
        } else {
            thread.messages.append(message)
        }
        threads[conversationId] = thread
        if isOnScreen(conversationId), message.role != .you, message.state != .streaming { markRead() }
    }

    /// Puts a card where it is shown: in its message and in the list of what needs the person.
    private func apply(_ card: Card) {
        if let index = threads[card.conversationId]?.messages.firstIndex(where: { $0.id == card.messageId }) {
            let parts = threads[card.conversationId]!.messages[index].parts.map { part -> Part in
                if case .card(let old) = part, old.id == card.id { .card(card) } else { part }
            }
            threads[card.conversationId]!.messages[index].parts = parts
        }
        items.removeAll { $0.id == card.id }
        if card.needsYou {
            items.append(card)
            items.sort { $0.createdAt < $1.createdAt }
            noteCard(card)
        } else {
            notifier.resolve([card.id])
            formDrafts[card.id] = nil
        }
        notifier.setBadge(items.count)
        if items.isEmpty { showsItems = false }
    }

    // MARK: - Sending

    /// Sends what the person wrote or said to the agent on screen, with the files uploaded for it.
    /// `later`: while a reply is written, the agent reads it after that reply instead of in it.
    func send(_ text: String, files: [FileRef] = [], spoken: Bool = false, later: Bool = false) {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !files.isEmpty, let agent = currentAgent else { return }
        let conversationId = agent.conversationId
        let clientId = UUID().uuidString
        // The files stand before the text, as the home stores them.
        let mine = Message(
            id: "local_\(clientId)", conversationId: conversationId, role: .you, agentId: nil, channel: .app,
            parts: files.map(Part.file) + (text.isEmpty ? [] : [.text(text)]), state: .done, model: nil, createdAt: Timestamp.now()
        )
        guard let client else {
            answerOnDevice(mine, clientId: clientId, agent: agent, spoken: spoken)
            return
        }
        sending[conversationId, default: []].append(mine)
        let message = SendMessage(
            text: text, spoken: spoken ? true : nil, clientId: clientId, files: files.isEmpty ? nil : files.map(\.id),
            later: later ? true : nil, answers: Questions.answers(waitingQuestions, target: targetQuestion)
        )
        Task {
            do {
                // Nothing goes before the person said where it may go.
                let waiting = models?.waitingForYes ?? []
                if !waiting.isEmpty, await !askConsent(waiting) { throw HomeError.needsConsent(waiting) }
                // With the stream down the home is probably away: do not make the person wait long.
                let stored: Message
                do {
                    stored = try await client.post(message, to: conversationId, timeout: reachable ? nil : 4)
                } catch HomeError.needsConsent(let services) {
                    // The home began to use a service this device had not heard of yet.
                    guard await askConsent(services) else { throw HomeError.needsConsent(services) }
                    stored = try await client.post(message, to: conversationId)
                }
                sending[conversationId]?.removeAll { $0.id == mine.id }
                upsert(stored)
            } catch HomeError.unreachable where !files.isEmpty {
                // The files are on the home: this device can't answer about them. The message
                // stays, marked, and can be sent again.
                reachable = false
                if let index = sending[conversationId]?.firstIndex(where: { $0.id == mine.id }) {
                    sending[conversationId]?[index].state = .failed
                }
            } catch HomeError.unreachable {
                reachable = false
                sending[conversationId]?.removeAll { $0.id == mine.id }
                answerOnDevice(mine, clientId: clientId, agent: agent, spoken: spoken)
            } catch HomeError.unauthorized {
                handle(HomeError.unauthorized)
            } catch {
                // The home refused it: it stays in the chat, marked, and can be sent again.
                if let index = sending[conversationId]?.firstIndex(where: { $0.id == mine.id }) {
                    sending[conversationId]?[index].state = .failed
                }
            }
        }
    }

    // MARK: - Questions

    /// The questions of the agent on screen that wait for the person, oldest first.
    var waitingQuestions: [Card] {
        conversationId.map { Questions.waiting(in: items, conversationId: $0) } ?? []
    }

    /// The question the next message answers.
    var targetQuestion: Card? {
        guard let conversationId else { return nil }
        return Questions.target(
            waitingQuestions, picked: picked[conversationId], working: currentAgent?.state == .working,
            lastMessageId: messages(in: conversationId).last?.id
        )
    }

    /// True when the question has to be named above the input: it is not the last thing in the chat, or not the only one.
    var namesQuestion: Bool {
        guard let targetQuestion, let conversationId else { return false }
        return waitingQuestions.count > 1 || messages(in: conversationId).last?.id != targetQuestion.messageId
    }

    /// The next message answers this question, or none of them.
    func pick(_ card: Card?) {
        guard let conversationId, let newest = waitingQuestions.last else { return }
        picked[conversationId] = Questions.Picked(cardId: card?.id, newest: newest.id)
        focusComposer += 1
    }

    /// What the person filled into a question's form so far.
    func formDraft(of card: Card) -> FormDraft {
        if let draft = formDrafts[card.id] { return draft }
        let draft = FormDraft(fields: card.form ?? [])
        formDrafts[card.id] = draft
        return draft
    }

    /// Answers a question with a message, from outside its chat. Returns a sentence when that did not work.
    func reply(_ card: Card, text: String) async -> String? {
        guard let client else { return String(localized: "This card needs your Bot Server.") }
        let message = SendMessage(text: text, clientId: UUID().uuidString, answers: .card(card.id))
        do {
            let waiting = models?.waitingForYes ?? []
            if !waiting.isEmpty, await !askConsent(waiting) { return nil }
            upsert(try await client.post(message, to: card.conversationId))
            return nil
        } catch HomeError.unreachable {
            reachable = false
            return String(localized: "Your Bot Server is out of reach. Try again in a moment.")
        } catch {
            handle(error)
            return (error as? HomeError)?.message ?? String(localized: "That didn’t work. Try again.")
        }
    }

    /// Sends a message again that the home refused.
    func retry(_ message: Message) {
        sending[message.conversationId]?.removeAll { $0.id == message.id }
        send(message.text, files: message.files)
    }

    /// Stops the reply that is being written.
    func stopReply() {
        guard let conversationId else { return }
        if let task = replyTasks[conversationId] {
            task.cancel()
        } else if let client {
            Task { try? await client.stop(conversationId) }
        }
    }

    private func answerOnDevice(_ mine: Message, clientId: String, agent: Agent, spoken: Bool) {
        let conversationId = mine.conversationId
        let earlier = messages(in: conversationId)
        store.add(LocalEntry(message: mine, clientId: clientId, kind: .onDevice))
        if let reason = onDevice.unavailable {
            if isPaired {
                // The home answers it once it is back.
                store.update(mine.id, in: conversationId) { $0.kind = .waiting }
            } else {
                addNote(reason, to: conversationId)
            }
            store.save()
            return
        }
        let replyId = UUID().uuidString
        var reply = Message(
            id: "local_\(replyId)", conversationId: conversationId, role: .agent, agentId: agent.id, channel: .app,
            parts: [.text("")], state: .streaming, model: OnDeviceAgent.modelRef, createdAt: Timestamp.now()
        )
        store.add(LocalEntry(message: reply, clientId: replyId, kind: .onDevice))
        voice.reply(reply.id, started: "", done: false)
        replyTasks[conversationId] = Task {
            var written = ""
            do {
                try await onDevice.answer(
                    mine.text, in: conversationId, agentName: agent.name, personName: link?.name, spoken: spoken, earlier: earlier
                ) { text in
                    if text.hasPrefix(written) { voice.reply(reply.id, grew: String(text.dropFirst(written.count))) }
                    written = text
                    store.update(reply.id, in: conversationId) { $0.message.parts = [.text(text)] }
                }
                reply.state = .done
            } catch {
                reply.state = written.isEmpty ? .failed : .done
                let reason: String? = switch error {
                case OnDeviceAgent.Problem.unavailable(let sentence), OnDeviceAgent.Problem.failed(let sentence): sentence
                default: nil
                }
                if written.isEmpty {
                    // Nothing was written: the question waits for the home, the reason stays as a note.
                    store.remove([reply.id], from: conversationId)
                    if isPaired { store.update(mine.id, in: conversationId) { $0.kind = .waiting } }
                    if let reason { addNote(reason, to: conversationId) }
                }
            }
            store.update(reply.id, in: conversationId) { $0.message.state = reply.state }
            voice.reply(reply.id, started: written, done: true)
            replyTasks[conversationId] = nil
            store.save()
            if reachable { await syncLocal() }
        }
    }

    private func addNote(_ text: String, to conversationId: String) {
        let id = UUID().uuidString
        let note = Message(
            id: "local_\(id)", conversationId: conversationId, role: .note, agentId: nil, channel: .app,
            parts: [.text(text)], state: .done, model: nil, createdAt: Timestamp.now()
        )
        store.add(LocalEntry(message: note, clientId: id, kind: .note))
    }

    /// Hands the home what this device wrote while it was out of reach.
    private func syncLocal() async {
        guard let client, !syncing else { return }
        syncing = true
        defer { syncing = false }
        for (conversationId, entries) in store.entries {
            // What was written without a home goes to the main agent's conversation.
            let target = conversationId == Self.localAgent.conversationId
                ? agents.first { $0.main }?.conversationId ?? agents.first?.conversationId : conversationId
            guard let target, !entries.contains(where: { $0.message.state == .streaming }) else { continue }
            do {
                let exchange = entries.filter { $0.kind == .onDevice && $0.message.state == .done && !$0.message.text.isEmpty }
                if !exchange.isEmpty {
                    let imported = try await client.importMessages(exchange.map {
                        ImportMessages.Entry(
                            role: $0.message.role, text: $0.message.text, createdAt: $0.message.createdAt,
                            model: $0.message.model, clientId: $0.clientId
                        )
                    }, into: target)
                    store.remove(Set(exchange.map(\.message.id)), from: conversationId)
                    for message in imported { upsert(message) }
                    onDevice.forget(conversationId)
                }
                for entry in entries where entry.kind == .waiting {
                    let stored = try await client.post(SendMessage(text: entry.message.text, clientId: entry.clientId), to: target)
                    store.remove([entry.message.id], from: conversationId)
                    upsert(stored)
                }
                // The notes of this device said why it could not answer; with the home back they are done.
                store.remove(Set(entries.filter { $0.kind == .note || $0.message.state == .failed }.map(\.message.id)),
                             from: conversationId)
            } catch {
                handle(error)
                break
            }
        }
        if let conversationId, threads[conversationId]?.loaded == true {
            threads[conversationId]?.messages.sort { $0.createdAt < $1.createdAt }
        }
        store.save()
    }

    // MARK: - Agents

    /// Switches the conversation on screen.
    func select(_ agent: Agent?) {
        guard let agent else {
            currentAgentId = nil
            return
        }
        if voice.mode != .off { voice.stopTalk() }
        currentAgentId = agent.id
        document = nil
        artifact = nil
        showsAbout = false
        showsAgents = false
        if threads[agent.conversationId]?.loaded != true {
            Task { await loadMessages(in: agent.conversationId) }
        } else {
            markRead()
        }
    }

    /// Hands an invite link to the home. The card that asks the person comes in the main
    /// agent's conversation, so that is the conversation shown.
    func openInvite(_ link: InviteLink) async {
        guard let client else { return }
        do {
            let answer = try await client.openInvite(link)
            if answer.opened {
                select(agents.first { $0.main })
            } else {
                inviteProblem = answer.message ?? String(localized: "That did not work. Try again.")
            }
        } catch {
            inviteProblem = String(localized: "Your Bot Server is out of reach. Try again in a moment.")
        }
    }

    private func open(conversationId: String?, agentId: String?) {
        showsItems = false
        showsAgents = false
        let agent = agents.first { $0.id == agentId } ?? agents.first { $0.conversationId == conversationId }
        if let agent, agent.id != currentAgent?.id { select(agent) }
    }

    private func isOnScreen(_ conversationId: String) -> Bool {
        active && self.conversationId == conversationId && !showsAgents
    }

    private func markRead() {
        guard active, reachable, let client, let conversationId, threads[conversationId]?.loaded == true else { return }
        // The list of agents agrees at once; the home confirms with `agent.updated`.
        if let index = agents.firstIndex(where: { $0.conversationId == conversationId }), agents[index].unread > 0 {
            agents[index].unread = 0
        }
        Task { try? await client.markRead(conversationId) }
    }

    private func remember() {
        guard isPaired else { return }
        store.remember(agents: agents, messages: threads.mapValues(\.messages))
        store.save()
    }

    // MARK: - Cards

    /// Answers a card. Returns a sentence when that did not work; nil when the card is answered.
    func answer(_ card: Card, action: CardAction, values: [String: FieldValue]?) async -> String? {
        guard let client else { return String(localized: "This card needs your Bot Server.") }
        do {
            apply(try await client.answer(card.id, action: action.id, values: values))
            return nil
        } catch HomeError.alreadyAnswered(let current) {
            // Someone was first: show the card as it is now.
            if let current {
                apply(current)
            } else {
                await refresh()
            }
            return nil
        } catch HomeError.unreachable {
            reachable = false
            return String(localized: "Your Bot Server is out of reach. Try again in a moment.")
        } catch {
            handle(error)
            return (error as? HomeError)?.message ?? String(localized: "That didn’t work. Try again.")
        }
    }

    // MARK: - Documents

    func openDocument(id: String, title: String) {
        guard let client else { return }
        if document?.id == id { return }
        showsAbout = false
        artifact = nil
        document = DocumentSession(id: id, title: title, client: client)
    }

    func openArtifact(id: String, title: String) {
        guard let client else { return }
        if artifact?.id == id { return }
        showsAbout = false
        document = nil
        artifact = ArtifactSession(id: id, title: title, client: client)
    }

    /// True while a document, an artifact or the agent stands beside the chat.
    var paneOpen: Bool { document != nil || artifact != nil || showsAbout }

    func closeDocument() {
        document = nil
    }

    // MARK: - The agent on screen, looked at

    /// Opens or closes what the agent on screen does and works with, in the place of a document.
    func toggleAbout() {
        if showsAbout {
            showsAbout = false
        } else {
            document = nil
            artifact = nil
            showsAbout = true
        }
    }

    /// Closes what stands beside the chat: a document, an artifact or the agent.
    func closePane() {
        document = nil
        artifact = nil
        showsAbout = false
    }

    func loadFolders() async {
        guard let client else { return }
        do {
            folders = try await client.folders()
        } catch {
            handle(error)
        }
    }

    /// Disconnects a folder. Returns a sentence when that did not work.
    func disconnect(_ folder: Folder) async -> String? {
        guard let client else { return String(localized: "Your Bot Server is out of reach. Try again in a moment.") }
        do {
            try await client.disconnectFolder(folder.id)
            folders?.removeAll { $0.id == folder.id }
            return nil
        } catch {
            handle(error)
            return (error as? HomeError)?.message ?? String(localized: "That didn’t work. Try again.")
        }
    }

    /// A folder was connected: the list has it at once; the home confirms with `folders.updated`.
    func connected(_ folder: Folder) {
        guard var list = folders else { return }
        list.removeAll { $0.id == folder.id }
        list.append(folder)
        folders = list
    }

    // MARK: - What this phone keeps

    /// The folder was connected on this phone: its agent reads it, and the home learns it is there.
    func connectPhoneFolder(_ url: URL) throws -> PhoneFolder {
        let folder = try phoneFolders.connect(url)
        Task { await offer() }
        return folder
    }

    /// Signs a service in on this phone: the home learns its name, never its address or token.
    func connectPhoneService(name: String, url: URL, token: String?) async throws {
        try await phoneConnections.connect(name: name, url: url, token: token)
        await offer()
    }

    func disconnectPhoneService(_ id: String) {
        phoneConnections.disconnect(id)
        Task { await offer() }
    }

    /// Calls a tool of a service signed in on this phone, with its token from the Keychain.
    private var callTool: @Sendable (PhoneConnection, String, String) async throws -> String {
        let tokens = Dictionary(uniqueKeysWithValues: phoneConnections.connections.map { ($0.id, phoneConnections.token(of: $0.id)) })
        return { connection, tool, arguments in
            let parsed = (try? JSONSerialization.jsonObject(with: Data(arguments.utf8)) as? [String: Any]) ?? [:]
            return try await PhoneConnections.client(connection, token: tokens[connection.id] ?? nil).call(tool, arguments: parsed)
        }
    }

    func disconnectPhoneFolder(_ id: String) {
        phoneFolders.disconnect(id)
        Task { await offer() }
    }

    func loadDevices() async {
        guard let client else { return }
        devices = try? await client.devices()
    }

    /// What this phone offers the home's agents: what the person did not say no to, and the
    /// connected folders. Never what any of it holds.
    var phoneResources: [DeviceResource] {
        var resources: [DeviceResource] = []
        if phoneData.access(.calendar) != .denied {
            resources.append(DeviceResource(id: "calendar", kind: .calendar, name: "Calendar", can: [.read, .change]))
        }
        if phoneData.access(.reminders) != .denied {
            resources.append(DeviceResource(id: "reminders", kind: .reminders, name: "Reminders", can: [.read, .change]))
        }
        if phoneData.access(.contacts) != .denied {
            resources.append(DeviceResource(id: "contacts", kind: .contacts, name: "Contacts", can: [.read]))
        }
        resources += phoneFolders.folders.map { DeviceResource(id: $0.id, kind: .folder, name: $0.name, can: [.read]) }
        resources += phoneConnections.connections.map {
            DeviceResource(id: $0.id, kind: .connection, name: $0.name, can: $0.changes ? [.read, .change] : [.read])
        }
        return resources
    }

    /// Tells the home what this phone offers, when it changed.
    func offer() async {
        // A phone whose model is not ready still offers what it keeps: it says why on each question.
        // A group home takes nothing from a phone: what it keeps would reach the other admins' turns.
        guard let client, group == nil else { return }
        let resources = DeviceResources(resources: phoneResources, agents: desk.agents)
        guard resources != offered else { return }
        do {
            try await client.offer(resources.resources, agents: resources.agents)
            offered = resources
        } catch {
            handle(error)
        }
    }

    private func loadHandoffs() async {
        guard let client else { return }
        do {
            for handoff in try await client.handoffs() { take(handoff) }
        } catch {
            handle(error)
        }
    }

    /// A silent push woke the app for a hand-off: the app answers what it can in the moment it
    /// has. What needs the person waits for them as a notification.
    func wake(for handoffId: String) async {
        guard client != nil else { return }
        await loadHandoffs()
        // The system gives a woken app about 30 seconds.
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await self.desk.idle() }
            group.addTask { try? await Task.sleep(for: .seconds(25)) }
            await group.next()
            group.cancelAll()
        }
    }

    /// A question one of the home's agents handed to this phone.
    private func take(_ handoff: Handoff) {
        guard let client, let link, handoff.deviceId == link.deviceId else { return }
        desk.take(handoff, with: HandoffDesk.Work(
            client: client, personName: link.name,
            tools: { [unowned self] _ in
                PhoneTools(
                    data: phoneData, folders: phoneFolders.folders, ask: { await self.ask($0) },
                    upload: { url in try await Self.upload(url, client: client) },
                    connections: phoneConnections.connections, callTool: callTool
                )
            },
            model: onDevice, ask: { [unowned self] in await ask($0) },
            consent: { [unowned self] in
                // The answer goes to the home's models: they must have the person's yes.
                if let fresh = try? await client.models() { models = fresh }
                return await askConsent(models?.waitingForYes ?? [])
            }
        ))
    }

    /// Sends a file of a folder connected on this phone to the home.
    nonisolated private static func upload(_ url: URL, client: HomeClient) async throws -> FileRef {
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        guard size <= FileLimits.maxBytes else {
            throw PhoneDataProblem(sentence: "The file is larger than the 15 MB the Bot Server takes.")
        }
        let data = try Data(contentsOf: url)
        return try await client.upload(data, name: url.lastPathComponent, mime: mimeType(forName: url.lastPathComponent))
    }

    /// Puts a question to the person on this phone; one at a time, in the order they came.
    func ask(_ question: PhoneQuestion) async -> Bool {
        // Away from the screen the question waits as a notification, and shows when the app opens.
        if UIApplication.shared.applicationState != .active { notifier.post(question: question) }
        return await withCheckedContinuation { continuation in
            if answering == nil {
                self.question = question
                answering = continuation
            } else {
                questions.append((question, continuation))
            }
        }
    }

    /// The person answered the question on screen.
    func answerQuestion(_ yes: Bool) {
        let continuation = answering
        answering = nil
        question = nil
        continuation?.resume(returning: yes)
        if !questions.isEmpty {
            let (next, waiting) = questions.removeFirst()
            answering = waiting
            // The alert of the next question comes after this one has gone.
            Task {
                try? await Task.sleep(for: .milliseconds(400))
                question = next
            }
        }
    }

    // MARK: - Where what the person writes goes

    /// Asks the person whether what they write may go to these services; one sheet for all who wait.
    /// Nothing is sent while it is open. A yes is told to the home, which keeps it for all devices.
    func askConsent(_ services: [ModelService]) async -> Bool {
        guard !services.isEmpty else { return true }
        if UIApplication.shared.applicationState != .active {
            notifier.post(question: PhoneQuestion(
                title: String(localized: "Where what you write goes"),
                detail: String(localized: "Your Bot Server uses \(services.map(\.label).joined(separator: ", ")). Open wizards.bot to allow it or not."),
                yes: "", no: ""
            ))
        }
        if consent == nil { consent = ConsentAsk(services: services) }
        return await withCheckedContinuation { consentWaiting.append($0) }
    }

    /// The person answered the consent sheet.
    func answerConsent(_ yes: Bool) async -> String? {
        guard let ask = consent else { return nil }
        guard yes else {
            answerConsentLocally(false)
            return nil
        }
        guard let client else { return nil }
        do {
            models = try await client.agree(to: ask.services.map(\.id))
        } catch {
            handle(error)
            return (error as? HomeError)?.message ?? String(localized: "Your Bot Server is out of reach. Try again in a moment.")
        }
        answerConsentLocally(true)
        await syncLocal()
        return nil
    }

    private func answerConsentLocally(_ yes: Bool) {
        consent = nil
        let waiting = consentWaiting
        consentWaiting = []
        for continuation in waiting { continuation.resume(returning: yes) }
    }

    /// Takes a yes back at the home: the next message asks again.
    func takeBack(_ service: ModelService) async -> String? {
        guard let client else { return nil }
        do {
            models = try await client.takeBack(service.id)
            return nil
        } catch {
            handle(error)
            return (error as? HomeError)?.message ?? String(localized: "Your Bot Server is out of reach. Try again in a moment.")
        }
    }

    // MARK: - Voice

    private func speakIfTalking(_ message: Message) {
        guard message.role == .agent, isOnScreen(message.conversationId) else { return }
        let done = message.state != .streaming
        // The question the message ends with is no text of it: it is said after the text.
        if done, !message.asked.isEmpty { voice.reply(message.id, grew: "\n\n" + message.asked) }
        voice.reply(message.id, started: done ? message.spoken : message.text, done: done)
    }

    // MARK: - Notifications

    /// A card waits for the person: a notification when its conversation is not on screen. A
    /// device that was never asked (paired before the Connected screen, or past it without
    /// Allow) is asked here once.
    private func noteCard(_ card: Card) {
        guard card.needsYou, !notified.contains(card.id) else { return }
        notified.insert(card.id)
        Task { _ = await notifier.allow() }
        guard !isOnScreen(card.conversationId) else { return }
        notifier.post(card, from: agent(card.agentId)?.name ?? "wizards.bot")
    }

    private func notifyAbout(_ message: Message) {
        guard message.role == .agent, message.state == .done, !notified.contains(message.id),
              !isOnScreen(message.conversationId) else { return }
        let text = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        notified.insert(message.id)
        notifier.post(reply: message, text: text, from: message.agentId.flatMap(agent)?.name ?? "wizards.bot")
    }

    /// The device's push token is there or changed: the home gets it.
    private func sendPush(_ push: Push) {
        guard let client else { return }
        Task { try? await client.updateDevice(UpdateDevice(push: .some(push))) }
    }
}
