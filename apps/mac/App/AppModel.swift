import AppKit
import Observation

/// What the window shows and which Bot Server the app speaks to.
@Observable
final class AppModel {
    static let shared = AppModel()

    enum Screen: Equatable {
        /// The app looks for a Bot Server it knows, or one on this Mac.
        case looking
        /// The two ways: start on this Mac, or connect to a Bot Server.
        case first
        case connect
        /// The Bot Server it knows does not answer.
        case away(URL, Health.Problem)
        /// The web app of `home`; `token` is the device token of a pairing that just happened.
        case chat(URL, token: String?)
    }

    var screen: Screen = .looking
    /// The sheet with the QR for a phone.
    var showPhone = false
    /// What the connect form shows from a pairing link, before the person confirms it.
    var linked: (home: URL, code: String)?
    /// The number of what needs you, from the web app.
    var waiting = 0 {
        didSet { NSApp.dockTile.badgeLabel = waiting > 0 ? "\(waiting)" : nil }
    }

    /// The Bot Server this app is paired with, kept between starts.
    private(set) var home: URL? {
        get { access(keyPath: \.home); return UserDefaults.standard.url(forKey: "home") }
        set {
            withMutation(keyPath: \.home) { UserDefaults.standard.set(newValue, forKey: "home") }
        }
    }

    let web = WebHost()
    let local = LocalHome()
    let link = MacLink()

    var menuBarSymbol: String { home == nil ? "sparkle" : "sparkles" }

    /// Where the app starts: the Bot Server it knows, or the first screen.
    func begin() async {
        link.watch()
        await local.look()
        if local.isOurs {
            // After an update the LaunchAgent still runs the old Node and home: start it anew.
            // The person may also have installed claude or codex since: the Bot Server learns where.
            let version = local.bundledVersion
            let updated = version != UserDefaults.standard.string(forKey: "homeVersion")
            UserDefaults.standard.set(version, forKey: "homeVersion")
            if await local.writeShellPath() || updated { local.restart() }
        }
        guard let home else {
            screen = .first
            return
        }
        await reach(home, code: nil)
    }

    /// The address is this Mac's own Bot Server.
    func isLocal(_ home: URL) -> Bool {
        let host = home.host?.lowercased() ?? ""
        return (host == "localhost" || host == "127.0.0.1") && (home.port ?? 80) == Address.port
    }

    /// "Start on this Mac": the app's Bot Server, or the one already here; then its setup, paired.
    func startHere() async {
        guard await local.start() else { return }
        await openHere()
    }

    /// Opens the Bot Server that runs on this Mac, paired without a code typed.
    func openHere() async {
        let address = LocalHome.address
        if let home, isLocal(home), case .home = await Health.check(address, seconds: 2) {
            screen = .chat(address, token: nil)
            return
        }
        guard let code = await local.pairingCode() else {
            linked = (address, "")
            screen = .connect
            return
        }
        if let problem = await reach(address, code: code) {
            local.problem = problem
            screen = .first
        }
    }

    /// "Use it": the Bot Server that was on this Mac before the app.
    func useFound() async {
        if local.found == .installed {
            local.busy = true
            let started = await local.startInstalled()
            local.busy = false
            guard started else {
                local.problem = String(localized: "That Bot Server did not start. wizards bot status in a terminal says why.")
                return
            }
        }
        await openHere()
    }

    /// Asks `home`, pairs with `code` when one is given, and opens its web app. Returns what
    /// went wrong with the code, or nil.
    @discardableResult
    func reach(_ home: URL, code: String?) async -> String? {
        switch await Health.check(home) {
        case .home:
            var token: String?
            if let code {
                switch await Pair.pair(home, code: code, name: Self.deviceName) {
                case let .paired(paired): token = paired
                case .refused: return String(localized: "This code is not valid any more. Ask your Bot Server for a new one.")
                case let .problem(text): return String(localized: "The Bot Server did not pair this Mac: \(text)")
                }
            }
            self.home = home
            linked = nil
            screen = .chat(home, token: token)
        case .notHome:
            screen = .away(home, .other(String(localized: "This address answers, but not as a Bot Server.")))
        case let .unreachable(problem):
            screen = .away(home, problem)
        }
        return nil
    }

    /// The name the Bot Server lists this Mac under.
    static var deviceName: String { Host.current().localizedName ?? "Mac" }

    /// Connects to an address typed in the connect form. Returns what went wrong, or nil.
    func connect(address: String, code: String) async -> String? {
        guard let url = Address.normalize(address) else {
            return String(localized: "That is not an address. It looks like ada.wizards.bot or macmini.local.")
        }
        guard Address.tidy(code).count >= 4 else {
            return String(localized: "The code is missing. Your Bot Server shows it with its QR.")
        }
        switch await Health.check(url) {
        case .home:
            return await reach(url, code: code)
        case .notHome:
            return String(localized: "This address answers, but not as a Bot Server.")
        case let .unreachable(problem):
            return Self.say(problem)
        }
    }

    /// A pairing link from the QR or another app.
    func open(link: URL) {
        guard let (home, code) = Address.pairingLink(link) else { return }
        linked = (home, code)
        screen = .connect
        NSApp.activate()
    }

    /// The app's Bot Server instead of the one of `wizards bot install`, on the same data.
    func takeOver() async {
        guard await local.takeOver() else { return }
        UserDefaults.standard.set(local.bundledVersion, forKey: "homeVersion")
        await openHere()
    }

    /// Removes the app's Bot Server from this Mac, and forgets it when the app was paired with it.
    func removeHere(trashData: Bool) async {
        await local.remove(trashData: trashData)
        if let home, isLocal(home) { forget() }
    }

    /// Forgets the Bot Server and shows the first screen; the Bot Server keeps the device until it
    /// is removed there.
    func forget() {
        home = nil
        web.clear()
        waiting = 0
        screen = .first
    }

    static func say(_ problem: Health.Problem) -> String {
        switch problem {
        case .noSuchAddress: String(localized: "There is no such address. Check how it is written.")
        case .nothingListens: String(localized: "Nothing answers at this address. Is the Bot Server running?")
        case .noAnswer: String(localized: "The Bot Server did not answer within 10 seconds.")
        case .certificate: String(localized: "The address's certificate is not valid, so the app does not trust it.")
        case .offline: String(localized: "This Mac is not connected to the internet.")
        case let .other(text): text
        }
    }
}
