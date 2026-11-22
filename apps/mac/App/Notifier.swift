import AppKit
import UserNotifications

/// The Mac's notifications for what the web app finds worth telling: a card that waits for the
/// person, a finished answer. `WKWebView` shows no web notifications of its own.
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Notifier()
    private var asked = false

    func attach() {
        UNUserNotificationCenter.current().delegate = self
    }

    func post(title: String, body: String, tag: String) {
        // The window in front shows it already.
        if NSApp.isActive, NSApp.keyWindow?.isVisible == true { return }
        Task {
            let center = UNUserNotificationCenter.current()
            if !asked {
                asked = true
                _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
            }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.sound = .default
            content.userInfo = ["tag": tag]
            try? await center.add(UNNotificationRequest(identifier: tag, content: content, trigger: nil))
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let tag = response.notification.request.content.userInfo["tag"] as? String
        await MainActor.run {
            NSApp.activate()
            for window in NSApp.windows where window.identifier?.rawValue == "main" {
                window.makeKeyAndOrderFront(nil)
            }
            if let tag { AppModel.shared.web.opened(tag: tag) }
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}
