import Foundation
import UserNotifications

/// The notification categories of docs/protocol.md: `card.<kind>` for a card, `message` for a reply.
///
/// iOS takes the buttons of a notification from a category the device registered, not from the push.
/// So a card that can be answered from its notification gets a category of its own, named after its
/// kind and its actions. The phone and the watch derive the same name from the same actions.
nonisolated enum CardNotifications {
    nonisolated struct Action: Equatable, Sendable {
        var id: String
        var label: String
    }

    static let message = "message"
    static let kinds = ["approval", "question", "connect", "secret", "pairing", "contact", "info"]
    /// The start of an action identifier; the card's action id follows.
    static let answerPrefix = "answer."

    /// Keys of a push payload and of the local notifications this app posts.
    enum Key {
        static let cardId = "cardId"
        static let conversationId = "conversationId"
        static let agentId = "agentId"
        static let actions = "actions"
        static let resolved = "resolved"
        /// A silent push that wakes the app for a question an agent handed to this phone.
        static let handoff = "handoff"
    }

    static func category(kind: String) -> String { "card.\(kind)" }

    /// The actions a payload carries, when a notification can answer its card: one or two of them.
    static func actions(in userInfo: [AnyHashable: Any]) -> [Action]? {
        guard let list = userInfo[Key.actions] as? [[String: Any]], (1 ... 2).contains(list.count) else { return nil }
        let actions = list.compactMap { entry -> Action? in
            guard let id = entry["id"] as? String, let label = entry["label"] as? String else { return nil }
            return Action(id: id, label: label)
        }
        return actions.count == list.count ? actions : nil
    }

    /// The name of the category with these buttons: "card.approval|yes=Send|no=Don't send".
    static func categoryId(base: String, actions: [Action]) -> String {
        ([base] + actions.map { "\($0.id)=\($0.label)" }).joined(separator: "|")
    }

    static func category(base: String, actions: [Action]) -> UNNotificationCategory {
        UNNotificationCategory(
            identifier: categoryId(base: base, actions: actions),
            actions: actions.map {
                // An answer needs the device unlocked: it may send or delete something.
                UNNotificationAction(identifier: answerPrefix + $0.id, title: $0.label, options: [.authenticationRequired])
            },
            intentIdentifiers: []
        )
    }

    /// The categories every device knows from the start: they have no buttons and open the chat.
    static var plain: Set<UNNotificationCategory> {
        Set(([message] + kinds.map(category(kind:))).map {
            UNNotificationCategory(identifier: $0, actions: [], intentIdentifiers: [])
        })
    }

    /// The action id of a response, when the person pressed one of a card's buttons.
    static func answer(from actionIdentifier: String) -> String? {
        actionIdentifier.hasPrefix(answerPrefix) ? String(actionIdentifier.dropFirst(answerPrefix.count)) : nil
    }

    /// Adds categories to the ones the device has, keeping the plain ones and the newest of the others.
    static func register(_ new: [UNNotificationCategory], in center: UNUserNotificationCenter) async {
        var categories = await center.notificationCategories()
        let fresh = Set(new.map(\.identifier))
        guard !fresh.isSubset(of: Set(categories.map(\.identifier))) else { return }
        // Old button sets go when there are many; the system keeps no order, so any of them.
        let old = categories.filter { $0.identifier.contains("|") }
        if old.count > 48 { categories.subtract(old.prefix(old.count - 48)) }
        categories.formUnion(plain)
        categories.formUnion(new)
        center.setNotificationCategories(categories)
    }
}
