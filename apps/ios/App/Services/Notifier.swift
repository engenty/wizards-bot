import Foundation
import UIKit
import UserNotifications

/// Notifications as docs/protocol.md describes them: pushes from the home when it has a key, and
/// local ones from the event stream while the app runs.
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    /// True when the conversation is in front of the person right now.
    var isOnScreen: (String) -> Bool = { _ in false }
    /// The person tapped a notification: open this conversation.
    var onOpen: (_ conversationId: String?, _ agentId: String?) -> Void = { _, _ in }
    /// The device has a push token, or a new one.
    var onPush: (Push) -> Void = { _ in }

    /// The push token of this device, once the person allowed notifications.
    private(set) var push: Push?
    private var allowed = false
    private var wantsToAsk = false
    private var center: UNUserNotificationCenter { .current() }

    func start() {
        center.delegate = self
        Task {
            center.setNotificationCategories(await center.notificationCategories().union(CardNotifications.plain))
            let status = await center.notificationSettings().authorizationStatus
            allowed = status == .authorized || status == .provisional
            if allowed { UIApplication.shared.registerForRemoteNotifications() }
        }
    }

    // MARK: Permission

    /// Asks for permission the first time it matters. Away from the screen, the question waits
    /// until the app is in front again.
    func ask() {
        guard !allowed else { return }
        wantsToAsk = true
        if UIApplication.shared.applicationState == .active { becameActive() }
    }

    func becameActive() {
        guard wantsToAsk else { return }
        wantsToAsk = false
        Task {
            guard await center.notificationSettings().authorizationStatus == .notDetermined else { return }
            allowed = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
            if allowed { UIApplication.shared.registerForRemoteNotifications() }
        }
    }

    /// The system gave this device a push token.
    func registered(token: Data) {
        let hex = token.map { String(format: "%02x", $0) }.joined()
        #if DEBUG
        let environment = PushEnvironment.development
        #else
        let environment = PushEnvironment.production
        #endif
        let push = Push(token: hex, environment: environment, topic: Bundle.main.bundleIdentifier ?? "bot.wizards")
        guard push != self.push else { return }
        self.push = push
        onPush(push)
    }

    // MARK: Local notifications

    /// A card waits for the person in a conversation that is not on screen.
    func post(_ card: Card, from agentName: String) {
        guard allowed else { return }
        let content = UNMutableNotificationContent()
        content.title = agentName
        content.body = card.title
        content.sound = .default
        content.threadIdentifier = card.agentId
        content.interruptionLevel = card.level == .needsYou ? .timeSensitive : .active
        content.userInfo = [
            CardNotifications.Key.cardId: card.id,
            CardNotifications.Key.conversationId: card.conversationId,
            CardNotifications.Key.agentId: card.agentId,
        ]
        let base = CardNotifications.category(kind: card.kind.rawValue)
        Task {
            // The home's push for the same card may be here already.
            guard await !delivered(cardId: card.id) else { return }
            if card.answersFromNotification {
                let category = CardNotifications.category(
                    base: base, actions: card.actions.map { CardNotifications.Action(id: $0.id, label: $0.label) }
                )
                await CardNotifications.register([category], in: center)
                content.categoryIdentifier = category.identifier
            } else {
                content.categoryIdentifier = base
            }
            try? await center.add(UNNotificationRequest(identifier: Self.identifier(cardId: card.id), content: content, trigger: nil))
        }
    }

    /// The phone's agent waits for the person's yes while the app is not in front: the question
    /// shows when they open it.
    func post(question: PhoneQuestion) {
        guard allowed else { return }
        let content = UNMutableNotificationContent()
        content.title = question.title
        content.body = question.detail
        content.sound = .default
        content.interruptionLevel = .timeSensitive
        Task {
            try? await center.add(UNNotificationRequest(identifier: "question.\(question.id.uuidString)", content: content, trigger: nil))
        }
    }

    /// A reply arrived in a conversation that is not on screen.
    func post(reply message: Message, text: String, from agentName: String) {
        guard allowed else { return }
        let content = UNMutableNotificationContent()
        content.title = agentName
        content.body = String(SpokenText.plain(text).prefix(240))
        content.sound = .default
        content.threadIdentifier = message.agentId ?? message.conversationId
        content.categoryIdentifier = CardNotifications.message
        content.interruptionLevel = .active
        var userInfo = [CardNotifications.Key.conversationId: message.conversationId]
        if let agentId = message.agentId { userInfo[CardNotifications.Key.agentId] = agentId }
        content.userInfo = userInfo
        let conversationId = message.conversationId
        Task {
            // A push for this reply shows as a notification of the same conversation in the last moments.
            let recent = await center.deliveredNotifications().contains {
                $0.request.trigger is UNPushNotificationTrigger
                    && $0.request.content.categoryIdentifier == CardNotifications.message
                    && $0.request.content.userInfo[CardNotifications.Key.conversationId] as? String == conversationId
                    && $0.date.timeIntervalSinceNow > -20
            }
            guard !recent else { return }
            try? await center.add(UNNotificationRequest(identifier: "message.\(message.id)", content: content, trigger: nil))
        }
    }

    /// These cards were answered somewhere: their notifications go.
    func resolve(_ cardIds: [String]) {
        guard !cardIds.isEmpty else { return }
        let ids = Set(cardIds)
        Task {
            let stale = await center.deliveredNotifications()
                .filter { ($0.request.content.userInfo[CardNotifications.Key.cardId] as? String).map(ids.contains) ?? false }
                .map(\.request.identifier)
            center.removeDeliveredNotifications(withIdentifiers: stale + cardIds.map(Self.identifier(cardId:)))
            center.removePendingNotificationRequests(withIdentifiers: cardIds.map(Self.identifier(cardId:)))
        }
    }

    /// The badge is the number of open items.
    func setBadge(_ count: Int) {
        guard allowed else { return }
        center.setBadgeCount(count)
    }

    private func delivered(cardId: String) async -> Bool {
        await center.deliveredNotifications().contains {
            $0.request.content.userInfo[CardNotifications.Key.cardId] as? String == cardId
        }
    }

    nonisolated private static func identifier(cardId: String) -> String { "card.\(cardId)" }

    // MARK: Delegate

    // The system wants its completion handlers called on the main thread, so both answers are given there.

    /// A notification arrives while the app is in front: shown, unless its conversation is on screen.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let userInfo = notification.request.content.userInfo
        let conversationId = userInfo[CardNotifications.Key.conversationId] as? String
        let cardId = userInfo[CardNotifications.Key.cardId] as? String
        if notification.request.trigger is UNPushNotificationTrigger, let cardId {
            // The push stands for the card; the local notification for the same card goes.
            center.removeDeliveredNotifications(withIdentifiers: [Self.identifier(cardId: cardId)])
        }
        nonisolated(unsafe) let done = completionHandler
        Task { @MainActor in
            let onScreen = conversationId.map(self.isOnScreen) ?? false
            done(onScreen ? [] : [.banner, .list, .sound])
        }
    }

    /// The person pressed a button of a notification, or the notification itself.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        let cardId = userInfo[CardNotifications.Key.cardId] as? String
        let conversationId = userInfo[CardNotifications.Key.conversationId] as? String
        let agentId = userInfo[CardNotifications.Key.agentId] as? String
        let action = CardNotifications.answer(from: response.actionIdentifier)
        let opened = response.actionIdentifier == UNNotificationDefaultActionIdentifier
        nonisolated(unsafe) let done = completionHandler
        Task { @MainActor in
            if let action, let cardId {
                // The first answer wins; when someone else was first, there is nothing left to do.
                if let link = HomeLink.stored {
                    _ = try? await HomeClient(link).answer(cardId, action: action)
                }
            } else if opened {
                self.onOpen(conversationId, agentId)
            }
            done()
        }
    }
}

/// Receives what the system hands to the app itself: the push token and silent pushes.
final class AppDelegate: NSObject, UIApplicationDelegate {
    var notifier: Notifier?
    /// A silent push woke the app for a question an agent handed to this phone.
    var onHandoff: ((String) async -> Void)?

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        notifier?.registered(token: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {}

    /// A silent push names the cards that were answered somewhere else, or a question for this phone.
    func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any]) async -> UIBackgroundFetchResult {
        if let handoff = userInfo[CardNotifications.Key.handoff] as? String {
            await onHandoff?(handoff)
            return .newData
        }
        guard let resolved = userInfo[CardNotifications.Key.resolved] as? [String], !resolved.isEmpty else { return .noData }
        let center = UNUserNotificationCenter.current()
        let ids = Set(resolved)
        let stale = await center.deliveredNotifications()
            .filter { ($0.request.content.userInfo[CardNotifications.Key.cardId] as? String).map(ids.contains) ?? false }
            .map(\.request.identifier)
        center.removeDeliveredNotifications(withIdentifiers: stale)
        if let badge = (userInfo["aps"] as? [String: Any])?["badge"] as? Int {
            try? await center.setBadgeCount(badge)
        }
        return .newData
    }
}
