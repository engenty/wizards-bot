import UserNotifications

/// Gives a pushed card its buttons. The push names the card's actions; this registers a category
/// with exactly these and points the notification at it. The push needs `"mutable-content": 1`.
nonisolated final class NotificationService: UNNotificationServiceExtension, @unchecked Sendable {
    private var deliver: ((UNNotificationContent) -> Void)?
    private var content: UNMutableNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        deliver = contentHandler
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            return
        }
        self.content = content
        let base = content.categoryIdentifier
        guard base.hasPrefix("card."), let actions = CardNotifications.actions(in: content.userInfo) else {
            contentHandler(content)
            return
        }
        content.categoryIdentifier = CardNotifications.categoryId(base: base, actions: actions)
        nonisolated(unsafe) let done = contentHandler
        nonisolated(unsafe) let ready = content
        Task {
            await CardNotifications.register([CardNotifications.category(base: base, actions: actions)], in: .current())
            done(ready)
        }
    }

    override func serviceExtensionTimeWillExpire() {
        if let content { deliver?(content) }
    }
}
