import Foundation

/// The Bot Server's start, as the LaunchAgent `bot.wizards.home` runs it: the app's own program
/// with `--home`. It finds the Node and the home inside the bundle it lies in, sends what they
/// print to the data folder, and becomes Node (`execv`), so launchd keeps the Bot Server itself.
nonisolated enum HomeLauncher {
    static func run(_ arguments: [String]) -> Never {
        let bundle = Bundle.main
        guard let node = LocalPaths.node(in: bundle), let cli = LocalPaths.cli(in: bundle) else {
            FileHandle.standardError.write(Data("This app carries no Bot Server.\n".utf8))
            exit(78) // EX_CONFIG: launchd does not try again at once.
        }
        let data = LocalPaths.data
        try? FileManager.default.createDirectory(at: data.appending(path: "logs"), withIntermediateDirectories: true)
        log(to: data.appending(path: "logs/home.log"))

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
    static let label = "bot.wizards.home"
    static let plist = "bot.wizards.home.plist"
    /// The Bot Server of `wizards bot install`.
    static let installLabel = "com.engenty.wizards.bot"

    static var data: URL {
        if let dir = ProcessInfo.processInfo.environment["WIZARDS_BOT_DATA"] { return URL(filePath: dir) }
        return FileManager.default.homeDirectoryForCurrentUser.appending(path: ".wizards-bot")
    }

    static var installPlist: URL {
        FileManager.default.homeDirectoryForCurrentUser.appending(path: "Library/LaunchAgents/\(installLabel).plist")
    }

    /// `~/.engenty/wizards/bin/wizards-bot`, the command `wizards bot install` makes.
    static var installCommand: URL {
        FileManager.default.homeDirectoryForCurrentUser.appending(path: ".engenty/wizards/bin/wizards-bot")
    }

    static func node(in bundle: Bundle) -> URL? {
        existing(bundle.resourceURL?.appending(path: "node/bin/node"))
    }

    static func cli(in bundle: Bundle) -> URL? {
        existing(bundle.resourceURL?.appending(path: "bot/apps/home/src/cli.ts"))
    }

    /// The version of the home in the bundle, from its `package.json`.
    static func version(in bundle: Bundle) -> String? {
        guard let file = bundle.resourceURL?.appending(path: "bot/package.json"),
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
