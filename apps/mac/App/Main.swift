import SwiftUI

/// One program, three jobs: started with `--home` by its LaunchAgent it becomes the Bot Server,
/// with `--link` this Mac's link to a Bot Server elsewhere (`HomeLauncher`), otherwise it is the
/// app with its window. The dev app first takes its own port and data folder (`Identity`).
@main
enum Main {
    static func main() {
        Identity.current.apply()
        let arguments = Array(CommandLine.arguments.dropFirst())
        if arguments.first == "--forget" {
            HomeLauncher.forget()
        }
        if arguments.first == "--home" {
            HomeLauncher.run(Array(arguments.dropFirst()))
        }
        if arguments.first == "--link" {
            HomeLauncher.link()
        }
        WizardsMacApp.main()
    }
}

struct WizardsMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @Environment(\.openWindow) private var openWindow

    var body: some Scene {
        Window(Identity.current.name, id: "main") {
            RootView()
                .environment(AppModel.shared)
                .frame(minWidth: 760, minHeight: 540)
                .onOpenURL { AppModel.shared.open(link: $0) }
        }
        .defaultSize(width: 1240, height: 800)
        .commands {
            CommandGroup(replacing: .newItem) {}
            CommandGroup(after: .appInfo) {
                MenuCommands()
            }
        }
        .handlesExternalEvents(matching: ["pair"])

        MenuBarExtra {
            MenuBarMenu().environment(AppModel.shared)
        } label: {
            Image(systemName: AppModel.shared.menuBarSymbol)
        }

        Settings {
            SettingsView()
                .environment(AppModel.shared)
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        Notifier.shared.attach()
        _ = Updates.shared
        Task { await AppModel.shared.begin() }
    }

    /// The window closes, the app stays in the menu bar; the Bot Server is not the app's child and
    /// runs on either way.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}
