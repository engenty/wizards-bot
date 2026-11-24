import Foundation

/// Which app this build is on the Mac: the wizards.bot app people install, or the dev app that runs
/// beside it from a checkout of this repository, with a bundle id, LaunchAgents, a port and data
/// folders of its own, so it never reaches the installed app's Bot Server.
///
/// The build configuration decides it: a Debug build is the dev app. This file is where the code
/// learns it; the Debug configuration of the project gives the bundle its id and name, and the
/// build phase "Dev app" (`Config/dev-app.sh`) its LaunchAgents and the checkout it runs from.
nonisolated struct Identity: Equatable, Sendable {
    /// The bundle id of the build. A bundle with another id starts no Bot Server and no link.
    let bundleID: String
    /// The name the window and the first screen show.
    let name: String
    /// The LaunchAgent of the app's Bot Server, `<label>.plist` in `Contents/Library/LaunchAgents`.
    let homeLabel: String
    /// The LaunchAgent of this Mac's link to a Bot Server elsewhere.
    let linkLabel: String
    /// The port the app's Bot Server listens on.
    let port: Int
    /// The Bot Server's data folder below the home folder; nil when the app takes the one the home
    /// finds itself (`LocalPaths.data`).
    let data: String?
    /// The link's folder below the home folder.
    let linkData: String
    /// Sparkle looks for updates.
    let checksUpdates: Bool
    /// The app also uses a Bot Server it did not start: the one of `wizards bot install`, or any
    /// that answers on its port.
    let usesOthers: Bool
    /// The Bot Server runs from the checkout the app was built from, with the Node the build found,
    /// instead of from the bundle.
    let runsFromCheckout: Bool

    var homePlist: String { "\(homeLabel).plist" }
    var linkPlist: String { "\(linkLabel).plist" }

    /// The app people install, as `pnpm pack:mac` and the release build it.
    static let release = Identity(
        bundleID: "bot.wizards.mac",
        name: "wizards.bot",
        homeLabel: "bot.wizards.home",
        linkLabel: "bot.wizards.link",
        port: 4747,
        data: nil,
        linkData: ".engenty/wizards-bot-link",
        checksUpdates: true,
        usesOthers: true,
        runsFromCheckout: false
    )

    /// The Debug build, `pnpm dev:mac`.
    static let dev = Identity(
        bundleID: "bot.wizards.mac.dev",
        name: "wizards.bot dev",
        homeLabel: "bot.wizards.home.dev",
        linkLabel: "bot.wizards.link.dev",
        port: 4790,
        data: ".engenty/wizards-bot-dev",
        linkData: ".engenty/wizards-bot-dev-link",
        checksUpdates: false,
        usesOthers: false,
        runsFromCheckout: true
    )

    #if DEBUG
    static let current = dev
    #else
    static let current = release
    #endif

    /// What the app puts into its own environment as it starts, so that its Bot Server, the
    /// commands it runs and its link take this port and data folder. Nothing for the release app,
    /// whose Bot Server finds both itself.
    func environment(home: URL) -> [String: String] {
        var values: [String: String] = [:]
        if let data { values["WIZARDS_BOT_DATA"] = home.appending(path: data).path }
        if port != Address.port { values["WIZARDS_BOT_PORT"] = String(port) }
        return values
    }

    /// Sets `environment` in this process, before anything else reads it.
    func apply() {
        for (key, value) in environment(home: FileManager.default.homeDirectoryForCurrentUser) {
            setenv(key, value, 1)
        }
    }
}
