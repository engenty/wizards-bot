import Foundation
import ServiceManagement

/// The Bot Server's start, as the LaunchAgent `bot.wizards.home` runs it: the app's own program
/// with `--home`. It finds the Node and the home inside the bundle it lies in (in the dev app, in
/// the checkout it was built from), sends what they print to the data folder, and becomes Node
/// (`execv`), so launchd keeps the Bot Server itself.
nonisolated enum HomeLauncher {
    /// This Mac's link to a Bot Server elsewhere, as the LaunchAgent `bot.wizards.link` runs it:
    /// `wizards-bot link` with a data folder of its own (`LocalPaths.linkData`), where the app
    /// wrote `link.json` when it paired.
    static func link() -> Never {
        setenv("WIZARDS_BOT_DATA", LocalPaths.linkData.path, 1)
        run(["link"], log: "link.log")
    }

    static func run(_ arguments: [String], log name: String = "home.log") -> Never {
        let bundle = Bundle.main
        guard let node = LocalPaths.node(in: bundle), let cli = LocalPaths.cli(in: bundle) else {
            FileHandle.standardError.write(Data("This app carries no Bot Server it may start.\n".utf8))
            exit(78) // EX_CONFIG: launchd does not try again at once.
        }
        let data = LocalPaths.data
        try? FileManager.default.createDirectory(at: data.appending(path: "logs"), withIntermediateDirectories: true)
        log(to: data.appending(path: "logs/\(name)"))

        // The home writes only into its data folder, never next to its code in the bundle.
        FileManager.default.changeCurrentDirectoryPath(data.path)
        unsetenv("NODE_OPTIONS")
        unsetenv("NODE_COMPILE_CACHE")
        let path = ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        setenv("PATH", "/opt/homebrew/bin:/usr/local/bin:\(path)", 1)
        setenv("WIZARDS_BOT_BY", "mac-app", 1)

        let command = arguments.isEmpty ? ["start"] : arguments
        let argv = [node.path, cli.path] + command
        var cArguments = argv.map { strdup($0) } + [nil]
        execv(node.path, &cArguments)
        FileHandle.standardError.write(Data("Node did not start: \(String(cString: strerror(errno)))\n".utf8))
        exit(1)
    }

    /// The dev app's `--forget`, for `pnpm dev:mac --fresh`: macOS forgets its two LaunchAgents,
    /// which stops them, as removing the Bot Server in the app does.
    static func forget() -> Never {
        let identity = Identity.current
        guard identity.runsFromCheckout, Bundle.main.bundleIdentifier == identity.bundleID else {
            FileHandle.standardError.write(Data("Only the dev app forgets its LaunchAgents this way.\n".utf8))
            exit(64) // EX_USAGE
        }
        for plist in [identity.homePlist, identity.linkPlist] {
            try? SMAppService.agent(plistName: plist).unregister()
        }
        exit(0)
    }

    /// Sends standard output and errors to the log, and starts it afresh when it grew past 10 MB.
    private static func log(to file: URL) {
        let size = (try? FileManager.default.attributesOfItem(atPath: file.path)[.size] as? Int) ?? 0
        if size > 10_000_000 { try? FileManager.default.removeItem(at: file) }
        let fd = open(file.path, O_WRONLY | O_CREAT | O_APPEND, 0o600)
        guard fd >= 0 else { return }
        dup2(fd, STDOUT_FILENO)
        dup2(fd, STDERR_FILENO)
        close(fd)
    }
}

/// Where the parts of a Bot Server on this Mac are.
nonisolated enum LocalPaths {
    static let label = Identity.current.homeLabel
    static let plist = Identity.current.homePlist
    /// The Bot Server of `wizards bot install`.
    static let installLabel = "com.engenty.wizards.bot"

    /// The Bot Server's data folder, as the home finds it (`config.ts`, `defaultDataDir`):
    /// `WIZARDS_BOT_DATA`, else `~/.engenty/wizards-bot`, or the `~/.wizards-bot` of an earlier
    /// Bot Server until the home moves it on its next start. The dev app sets `WIZARDS_BOT_DATA`
    /// to its own as it starts (`Identity.apply`).
    static var data: URL {
        if let dir = ProcessInfo.processInfo.environment["WIZARDS_BOT_DATA"] { return URL(filePath: dir) }
        let user = FileManager.default.homeDirectoryForCurrentUser
        let now = user.appending(path: ".engenty/wizards-bot")
        let before = user.appending(path: ".wizards-bot")
        let exists = { (url: URL) in FileManager.default.fileExists(atPath: url.path) }
        return !exists(now) && exists(before) ? before : now
    }

    /// The data folder as a person reads it: `~/.engenty/wizards-bot`.
    static var dataShown: String { shown(data) }

    /// A folder as a person reads it, with `~` for the home folder.
    static func shown(_ url: URL) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return url.path.hasPrefix(home + "/") ? "~" + url.path.dropFirst(home.count) : url.path
    }

    static let linkLabel = Identity.current.linkLabel
    static let linkPlist = Identity.current.linkPlist

    /// The link's own folder: `link.json` (where to and its token), `link-state.json` (how it
    /// stands), `path` and its log. Apart from the Bot Server's data, so removing one leaves the
    /// other.
    static var linkData: URL {
        FileManager.default.homeDirectoryForCurrentUser.appending(path: Identity.current.linkData)
    }

    /// What `wizards bot install` wrote about its Bot Server: its version and its data folder.
    static var installBot: URL {
        FileManager.default.homeDirectoryForCurrentUser.appending(path: ".engenty/wizards/bot/bot.json")
    }

    static var installPlist: URL {
        FileManager.default.homeDirectoryForCurrentUser.appending(path: "Library/LaunchAgents/\(installLabel).plist")
    }

    /// `~/.engenty/wizards/bin/wizards-bot`, the command `wizards bot install` makes.
    static var installCommand: URL {
        FileManager.default.homeDirectoryForCurrentUser.appending(path: ".engenty/wizards/bin/wizards-bot")
    }

    /// The Node that runs the Bot Server: `Contents/Resources/node` of a build of `pnpm pack:mac`,
    /// the one the build found for the dev app. None in a bundle whose id is not the build's own,
    /// such as a copy with another one: it would take the LaunchAgent of the app it was copied from.
    static func node(in bundle: Bundle) -> URL? {
        guard bundle.bundleIdentifier == Identity.current.bundleID else { return nil }
        if Identity.current.runsFromCheckout { return existing(checkout(in: bundle)?.node) }
        return existing(bundle.resourceURL?.appending(path: "node/bin/node"))
    }

    static func cli(in bundle: Bundle) -> URL? {
        existing(root(in: bundle)?.appending(path: "apps/home/src/cli.ts"))
    }

    /// Where the Bot Server's code is: `Contents/Resources/bot`, or for the dev app the checkout it
    /// was built from, so that a change to `apps/home` runs once its Bot Server starts anew.
    private static func root(in bundle: Bundle) -> URL? {
        guard bundle.bundleIdentifier == Identity.current.bundleID else { return nil }
        if Identity.current.runsFromCheckout { return checkout(in: bundle)?.root }
        return bundle.resourceURL?.appending(path: "bot")
    }

    /// What the build phase "Dev app" wrote into the dev app's `checkout.plist`: the checkout's
    /// folder and the Node of the build, a Node 24.11 or newer. Without a Node it wrote no `node`.
    private static func checkout(in bundle: Bundle) -> (root: URL, node: URL?)? {
        guard let file = bundle.url(forResource: "checkout", withExtension: "plist"),
              let data = try? Data(contentsOf: file),
              let values = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: String],
              let root = values["checkout"]
        else { return nil }
        return (URL(filePath: root), values["node"].map { URL(filePath: $0) })
    }

    /// The version of the home in the bundle (or the checkout), from its `package.json`.
    static func version(in bundle: Bundle) -> String? {
        guard let file = root(in: bundle)?.appending(path: "package.json"),
              let data = try? Data(contentsOf: file),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return json["version"] as? String
    }

    private static func existing(_ url: URL?) -> URL? {
        guard let url, FileManager.default.isExecutableFile(atPath: url.path) || FileManager.default.fileExists(atPath: url.path)
        else { return nil }
        return url
    }
}
