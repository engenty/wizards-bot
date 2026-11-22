import AVFoundation
import Foundation
import Observation
import OSLog
import UserNotifications
import WatchConnectivity
import WatchKit

/// The watch as a device of the home. It gets the home's address and its own token from the phone,
/// then talks to the home directly.
@Observable
final class WatchModel: NSObject, WCSessionDelegate, UNUserNotificationCenterDelegate {
    private(set) var link: HomeLink?
    /// The phone answered that it has no home.
    private(set) var phoneHasNoHome = false
    /// The main agent.
    private(set) var agent: Agent?
    /// Every open card that waits for the person, oldest first.
    private(set) var items: [Card] = []
    /// What the person last said, and the reply to it.
    private(set) var said: String?
    private(set) var reply: Message?
    private(set) var isWaiting = false
    private(set) var problem: String?
    let speaker = Speaker()

    @ObservationIgnored private let session = WCSession.default
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private var streamOpen = false
    @ObservationIgnored private var lastEventId: String?
    @ObservationIgnored private var voice: ReplyVoice?
    @ObservationIgnored private var saidAt: String?
    @ObservationIgnored private var started = false
    @ObservationIgnored private var isAsking = false
    @ObservationIgnored private let log = Logger(subsystem: "bot.wizards", category: "watch")

    private var client: HomeClient? { link.map(HomeClient.init) }

    // MARK: Start

    func start() {
        guard !started else { return }
        started = true
        link = HomeLink.stored
        session.delegate = self
        session.activate()
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        Task { center.setNotificationCategories(await center.notificationCategories().union(CardNotifications.plain)) }
        if link != nil { connect() }
    }

    func setActive(_ active: Bool) {
        guard started else { return }
        if active {
            if link == nil { ask() } else if !streamOpen { connect() }
        } else {
            speaker.stop()
        }
    }

    /// Asks the phone for the home. The phone pairs this watch there and answers with its token.
    func ask() {
        guard !isAsking, session.activationState == .activated, session.isReachable,
              let message = WatchLink.ask(watchName: WKInterfaceDevice.current().name).encoded() else { return }
        isAsking = true
        // WatchConnectivity calls back on its own queue, so neither closure belongs to the main actor.
        session.sendMessage(message) { @Sendable [weak self] reply in
            let answer = WatchLink.decode(reply)
            Task { @MainActor in
                self?.isAsking = false
                if let answer { self?.take(answer) }
            }
        } errorHandler: { @Sendable [weak self] error in
            let reason = error.localizedDescription
            Task { @MainActor in
                self?.isAsking = false
                self?.log.error("The phone did not answer: \(reason, privacy: .public)")
            }
        }
    }

    private func take(_ answer: WatchLink) {
        switch answer {
        case .home(let link):
            phoneHasNoHome = false
            guard link != self.link else { return }
            link.store()
            self.link = link
            lastEventId = nil
            connect()
        case .noHome:
            phoneHasNoHome = true
            guard let old = link else { return }
            // The phone signed out: this watch leaves the home too.
            Task { try? await HomeClient(old).signOut() }
            forgetHome()
        case .ask:
            break
        }
    }

    private func forgetHome() {
        streamTask?.cancel()
        streamTask = nil
        streamOpen = false
        HomeLink.forget()
        link = nil
        agent = nil
        items = []
        reply = nil
        said = nil
        isWaiting = false
    }

    // MARK: The home

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
            streamOpen = true
            Task { await refresh() }
        case .event(let event, let id):
            if let id { lastEventId = id }
            apply(event)
        case .closed:
            streamOpen = false
        case .unauthorized:
            forgetHome()
            ask()
        }
    }

    func refresh() async {
        guard let client else { return }
        do {
            async let agents = client.agents()
            async let items = client.items()
            let (loadedAgents, loadedItems) = try await (agents, items)
            agent = loadedAgents.first { $0.main } ?? loadedAgents.first
            self.items = loadedItems
            problem = nil
            registerCategories()
        } catch HomeError.unauthorized {
            forgetHome()
            ask()
        } catch {
            if agent == nil { problem = String(localized: "Your Bot Server is out of reach.") }
        }
    }

    private func apply(_ event: HomeEvent) {
        switch event {
        case .messageCreated(let message), .messageUpdated(let message):
            for card in message.cards { apply(card) }
            take(message)
        case .messageDelta(let conversationId, let messageId, let part, let text):
            guard conversationId == agent?.conversationId, var message = reply, message.id == messageId else { return }
            while message.parts.count <= part { message.parts.append(.text("")) }
            guard case .text(let soFar) = message.parts[part] else { return }
            message.parts[part] = .text(soFar + text)
            reply = message
            voice?.add(text)
        case .cardUpdated(let card):
            apply(card)
        case .agentUpdated(let updated):
            if updated.id == agent?.id || (agent == nil && updated.main) { agent = updated }
        case .reset:
            Task { await refresh() }
        default:
            break
        }
    }

    /// A message of the conversation: the reply to what the person said is shown and read aloud.
    private func take(_ message: Message) {
        guard message.conversationId == agent?.conversationId, message.role == .agent,
              let saidAt, message.createdAt >= saidAt else { return }
        let isNew = reply?.id != message.id
        reply = message
        if isNew, isWaiting {
            listenToReply()
            voice = ReplyVoice(messageId: message.id, speaker: speaker)
            if message.state == .streaming, !message.text.isEmpty { voice?.add(message.text) }
        }
        if message.state != .streaming {
            if voice?.messageId == message.id { voice?.finish(whole: message.text) }
            isWaiting = false
            pollTask?.cancel()
        }
    }

    private func apply(_ card: Card) {
        items.removeAll { $0.id == card.id }
        if card.needsYou {
            items.append(card)
            items.sort { $0.createdAt < $1.createdAt }
            registerCategories()
        } else {
            let center = UNUserNotificationCenter.current()
            Task {
                let stale = await center.deliveredNotifications()
                    .filter { $0.request.content.userInfo[CardNotifications.Key.cardId] as? String == card.id }
                    .map(\.request.identifier)
                center.removeDeliveredNotifications(withIdentifiers: stale)
            }
        }
    }

    // MARK: Talking

    /// Sends what the person dictated; the reply shows as text and is read aloud.
    func send(_ text: String) async {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let client, let agent else { return }
        speaker.stop()
        voice = nil
        said = text
        reply = nil
        problem = nil
        isWaiting = true
        do {
            let stored = try await client.post(SendMessage(text: text, spoken: true, clientId: UUID().uuidString), to: agent.conversationId)
            saidAt = stored.createdAt
            watchForReply(in: agent.conversationId)
        } catch HomeError.unauthorized {
            forgetHome()
            ask()
        } catch HomeError.needsConsent {
            // The watch has no room for what the phone shows before the first message.
            isWaiting = false
            problem = String(localized: "Open wizards.bot on your iPhone and allow where your messages go.")
        } catch {
            isWaiting = false
            problem = (error as? HomeError)?.message ?? String(localized: "Your Bot Server is out of reach. Try again in a moment.")
        }
    }

    /// While the stream is not open, the reply is looked up every two seconds.
    private func watchForReply(in conversationId: String) {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            for _ in 0 ..< 60 {
                try? await Task.sleep(for: .seconds(2))
                guard let self, !Task.isCancelled, self.isWaiting, let client = self.client else { return }
                guard !self.streamOpen, let page = try? await client.messages(in: conversationId, limit: 6) else { continue }
                for message in page.messages { self.take(message) }
            }
        }
    }

    private func listenToReply() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .spokenAudio, policy: .default, options: [.duckOthers])
        try? session.setActive(true)
    }

    // MARK: Cards

    /// Answers a card. Returns a sentence when that did not work.
    func answer(_ card: Card, action: CardAction) async -> String? {
        guard let client else { return nil }
        do {
            apply(try await client.answer(card.id, action: action.id))
            WKInterfaceDevice.current().play(.success)
            return nil
        } catch HomeError.alreadyAnswered(let current) {
            // Someone was first: the card is done.
            if let current { apply(current) } else { items.removeAll { $0.id == card.id } }
            return nil
        } catch {
            return (error as? HomeError)?.message ?? String(localized: "Your Bot Server is out of reach. Try again in a moment.")
        }
    }

    /// Notifications for the cards this watch knows get their buttons: the same category names as on the phone.
    private func registerCategories() {
        let categories = items.filter(\.answersFromNotification).map { card in
            CardNotifications.category(
                base: CardNotifications.category(kind: card.kind.rawValue),
                actions: card.actions.map { CardNotifications.Action(id: $0.id, label: $0.label) }
            )
        }
        guard !categories.isEmpty else { return }
        Task { await CardNotifications.register(categories, in: .current()) }
    }

    // MARK: WatchConnectivity

    nonisolated func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {
        Task { @MainActor in
            if self.link == nil { self.ask() }
        }
    }

    nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
        Task { @MainActor in
            if self.link == nil { self.ask() }
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        guard let answer = WatchLink.decode(userInfo) else { return }
        Task { @MainActor in self.take(answer) }
    }

    // MARK: Notifications

    // The system wants its completion handlers called on the main thread, so both answers are given there.

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        nonisolated(unsafe) let done = completionHandler
        Task { @MainActor in done([.banner, .list, .sound]) }
    }

    /// The person pressed a button of a card's notification on the wrist.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let cardId = response.notification.request.content.userInfo[CardNotifications.Key.cardId] as? String
        let action = CardNotifications.answer(from: response.actionIdentifier)
        nonisolated(unsafe) let done = completionHandler
        Task { @MainActor in
            if let action, let cardId, let link = HomeLink.stored {
                _ = try? await HomeClient(link).answer(cardId, action: action)
            }
            done()
        }
    }
}
