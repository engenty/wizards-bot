import AppKit
import Observation
import ServiceManagement

/// The Bot Server on this Mac: the app's own (the LaunchAgent `bot.wizards.home`) or one that
/// was there before it.
@Observable
final class LocalHome {
    /// What the app found on this Mac that is not its own.
    enum Found: Equatable {
        /// A Bot Server answers on 4747.
        case runs(version: String?, byInstall: Bool)
        /// `wizards bot install` put one here, but it does not answer.
        case installed
        /// Something that is not a Bot Server listens on 4747.
        case portTaken(String)
    }

    /// Where starting the app's Bot Server is, for the starting screen.
    enum Stage: Equatable {
        /// Taking over: the Bot Server of `wizards bot install` stops.
        case stopping
        /// Taking over: a copy of the data is made.
        case copying
        /// The login shell's `PATH` is written for the Bot Server.
        case programs
        /// The LaunchAgent is registered.
        case background
        /// macOS waits for the person to turn the Bot Server on under Login Items.
        case approval
        /// The Bot Server runs; the app waits for `/health`.
        case starting
        /// The Bot Server answers; the app pairs with it.
        case started
    }

    static let address = URL(string: "http://localhost:\(Address.port)")!

    private(set) var found: Found?
    /// Data of an earlier Bot Server is in the data folder: starting here uses it.
    private(set) var hasData = false
    var busy = false
    var problem: String?
    /// Where starting is; nil when the app starts nothing.
    var stage: Stage?
    /// Starting takes over the Bot Server of `wizards bot install`.
    private(set) var takesOver = false
    /// Taking over keeps a copy of the data first.
    private(set) var copiesData = false
    /// The person went back while macOS waited for the approval.
    private var cancelled = false

    private let service = SMAppService.agent(plistName: LocalPaths.plist)

    /// The app carries a Bot Server (a build of `pnpm pack:mac`; a plain Xcode build does not).
    var canStart: Bool { LocalPaths.node(in: .main) != nil && LocalPaths.cli(in: .main) != nil }

    /// The app's own Bot Server is registered with macOS.
    var isOurs: Bool { service.status == .enabled || service.status == .requiresApproval }

    var needsApproval: Bool { service.status == .requiresApproval }

    var bundledVersion: String? { LocalPaths.version(in: .main) }

    /// The Bot Server found on this Mac came with `wizards bot install` and is older than the
    /// app's: the app offers to update it, which is to run its own on the same data.
    var offersUpdate: Bool {
        guard canStart, case let .runs(version, byInstall: true) = found else { return false }
        return Version.offersUpdate(found: version, carried: bundledVersion)
    }

    /// What `wizards bot install` wrote about its Bot Server.
    static var installed: InstalledBot? {
        (try? Data(contentsOf: LocalPaths.installBot)).flatMap(InstalledBot.read)
    }

    /// Where the update keeps a copy of the data as it was: `~/.engenty/wizards-bot-before-0.1.3`,
    /// numbered when that is taken.
    var backup: URL {
        let base = "wizards-bot-before-\(bundledVersion ?? "update")"
        let folder = FileManager.default.homeDirectoryForCurrentUser.appending(path: ".engenty")
        var candidate = folder.appending(path: base)
        var number = 2
        while FileManager.default.fileExists(atPath: candidate.path) {
            candidate = folder.appending(path: "\(base)-\(number)")
            number += 1
        }
        return candidate
    }

    /// Looks at the Mac: the app's own Bot Server, one of `wizards bot install`, one by hand,
    /// another program on 4747, data in the data folder.
    func look() async {
        hasData = FileManager.default.fileExists(atPath: LocalPaths.data.appending(path: "home.db").path)
        let byInstall = FileManager.default.fileExists(atPath: LocalPaths.installPlist.path)
        switch await Health.check(Self.address, seconds: 2) {
        case let .home(version):
            let known = version ?? (byInstall ? Self.installed?.version : nil)
            found = isOurs ? nil : .runs(version: known, byInstall: byInstall)
        case .notHome:
            found = .portTaken(Self.listener() ?? String(localized: "another program"))
        case .unreachable:
            found = byInstall ? .installed : nil
        }
    }

    /// Registers the LaunchAgent and waits until the Bot Server answers.
    func start() async -> Bool {
        problem = nil
        guard canStart else {
            problem = String(localized: "This build of the app carries no Bot Server.")
            finish()
            return false
        }
        await look()
        if case let .portTaken(program) = found {
            problem = String(localized: "Port 4747 is taken by \(program). The app starts no Bot Server beside it.")
            finish()
            return false
        }
        if case .runs = found {
            finish()
            return true
        }
        busy = true
        cancelled = false
        defer { busy = false }
        stage = .programs
        await writeShellPath()
        stage = .background
        do {
            if service.status == .enabled { try? await service.unregister() }
            try service.register()
        } catch {
            if service.status != .requiresApproval {
                problem = String(localized: "macOS did not start the Bot Server: \(error.localizedDescription)")
                finish()
                return false
            }
        }
        if service.status == .requiresApproval {
            stage = .approval
            SMAppService.openSystemSettingsLoginItems()
            while service.status == .requiresApproval, !cancelled {
                try? await Task.sleep(for: .seconds(1))
            }
            guard !cancelled, service.status == .enabled else {
                if !cancelled { problem = String(localized: "macOS did not allow the Bot Server to run.") }
                finish()
                return false
            }
        }
        stage = .starting
        for _ in 0 ..< 60 {
            if case .home = await Health.check(Self.address, seconds: 1) {
                found = nil
                stage = .started
                return true
            }
            try? await Task.sleep(for: .milliseconds(500))
        }
        problem = String(localized: "The Bot Server did not start. What it said is in \(LocalPaths.dataShown)/logs/home.log.")
        finish()
        return false
    }

    /// Goes back from the starting screen while macOS waits for the approval: the app starts
    /// nothing, and the LaunchAgent stays registered for when the person turns it on.
    func cancelApproval() {
        cancelled = true
    }

    /// Ends the starting screen.
    func finish() {
        stage = nil
        takesOver = false
        copiesData = false
    }

    /// Writes the folders of the person's login shell into the data folder's `path`, where the
    /// Bot Server looks for `claude`, `codex` and `ollama`: launchd gives it only the system's.
    /// Returns whether they changed.
    @discardableResult
    func writeShellPath() async -> Bool {
        let shell = ProcessInfo.processInfo.environment["SHELL"].flatMap { $0.hasPrefix("/") ? $0 : nil } ?? "/bin/zsh"
        let mark = ShellPath.mark
        let output = await Self.run(
            URL(filePath: shell),
            ["-l", "-i", "-c", "printf '\(mark)%s\(mark)' \"$PATH\""],
            timeout: 8
        )
        guard let path = output.flatMap(ShellPath.read) else { return false }
        let file = LocalPaths.data.appending(path: "path")
        let before = try? String(contentsOf: file, encoding: .utf8)
        guard before?.trimmingCharacters(in: .whitespacesAndNewlines) != path else { return false }
        try? FileManager.default.createDirectory(at: LocalPaths.data, withIntermediateDirectories: true)
        try? Data("\(path)\n".utf8).write(to: file, options: .atomic)
        return true
    }

    /// Stops the app's Bot Server: macOS forgets the LaunchAgent until it is started again.
    func stop() async {
        busy = true
        defer { busy = false }
        try? await service.unregister()
    }

    /// The app takes over the Bot Server of `wizards bot install`, on the person's word, which
    /// also updates it to the app's version: that LaunchAgent stops and its plist is set aside
    /// (`….plist.off`), a copy of the data is kept (`backup`), and the app's own starts on the same
    /// data. Refused when the app's Bot Server is older than the one that last wrote the data, or
    /// when the two would not use the same data folder.
    func takeOver() async -> Bool {
        problem = nil
        guard canStart else {
            problem = String(localized: "This build of the app carries no Bot Server.")
            return false
        }
        let data = LocalPaths.data
        let last = (try? String(contentsOf: data.appending(path: "version"), encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let last, let mine = bundledVersion, Version.older(mine, than: last) {
            problem = String(localized: "Your data was last used by Bot Server \(last), and the app carries \(mine). Update the app first.")
            return false
        }
        if let theirs = Self.installed?.data,
           URL(filePath: theirs).standardizedFileURL.resolvingSymlinksInPath().path
           != data.standardizedFileURL.resolvingSymlinksInPath().path {
            problem = String(localized: "That Bot Server keeps its data in \(theirs), and the app's would use \(LocalPaths.dataShown). Nothing was changed.")
            return false
        }
        busy = true
        takesOver = true
        copiesData = FileManager.default.fileExists(atPath: data.path)
        stage = .stopping
        Self.launchctl(["bootout", "gui/\(getuid())/\(LocalPaths.installLabel)"])
        let plist = LocalPaths.installPlist
        let aside = plist.appendingPathExtension("off")
        if FileManager.default.fileExists(atPath: plist.path) {
            try? FileManager.default.removeItem(at: aside)
            try? FileManager.default.moveItem(at: plist, to: aside)
        }
        var stopped = false
        for _ in 0 ..< 20 {
            if case .unreachable = await Health.check(Self.address, seconds: 1) {
                stopped = true
                break
            }
            try? await Task.sleep(for: .milliseconds(500))
        }
        guard stopped else {
            restoreInstall(aside)
            busy = false
            finish()
            problem = String(localized: "The Bot Server of wizards bot install did not stop. Nothing was changed.")
            return false
        }
        // The copy is made while no Bot Server writes, so its databases are whole.
        if FileManager.default.fileExists(atPath: data.path) {
            let copy = backup
            stage = .copying
            do {
                try FileManager.default.copyItem(at: data, to: copy)
            } catch {
                try? FileManager.default.removeItem(at: copy)
                restoreInstall(aside)
                busy = false
                finish()
                problem = String(localized: "The copy of your data was not made (\(error.localizedDescription)). The Bot Server of wizards bot install runs again; nothing was changed.")
                return false
            }
        }
        busy = false
        found = nil
        return await start()
    }

    /// Puts the LaunchAgent of `wizards bot install` back and starts it, when taking over stopped
    /// before anything changed.
    private func restoreInstall(_ aside: URL) {
        let plist = LocalPaths.installPlist
        if !FileManager.default.fileExists(atPath: plist.path), FileManager.default.fileExists(atPath: aside.path) {
            try? FileManager.default.moveItem(at: aside, to: plist)
        }
        Self.launchctl(["bootstrap", "gui/\(getuid())", plist.path])
    }

    /// Removes the app's Bot Server from this Mac: macOS forgets the LaunchAgent, and the data
    /// goes to the Trash only when the person chose that.
    func remove(trashData: Bool) async {
        busy = true
        defer { busy = false }
        try? await service.unregister()
        try? FileManager.default.removeItem(at: LocalPaths.data.appending(path: "path"))
        if trashData, FileManager.default.fileExists(atPath: LocalPaths.data.path) {
            _ = try? await NSWorkspace.shared.recycle([LocalPaths.data])
        }
        await look()
    }

    /// Writes an encrypted copy of the Bot Server's data to `file` with `wizards-bot export`, which
    /// works while the Bot Server runs. Returns what went wrong, or nil. The passphrase goes to the
    /// command in its environment, never on its command line.
    func export(to file: URL, passphrase: String) async -> String? {
        guard let node = LocalPaths.node(in: .main), let cli = LocalPaths.cli(in: .main) else {
            return String(localized: "This build of the app carries no Bot Server.")
        }
        var environment = ProcessInfo.processInfo.environment
        environment["WIZARDS_BOT_DATA"] = LocalPaths.data.path
        environment["WIZARDS_BOT_PASSPHRASE"] = passphrase
        let (ok, said) = await Self.runSaying(node, [cli.path, "export", file.path], environment: environment)
        if ok { return nil }
        let line = said.split(whereSeparator: \.isNewline).last.map(String.init) ?? ""
        return String(localized: "The backup was not saved: \(line)")
    }

    /// Runs a program to its end and gives back whether it succeeded and what it printed, errors
    /// included.
    static func runSaying(_ program: URL, _ arguments: [String], environment: [String: String]) async -> (Bool, String) {
        await Task.detached {
            let process = Process()
            let pipe = Pipe()
            process.executableURL = program
            process.arguments = arguments
            process.environment = environment
            process.standardOutput = pipe
            process.standardError = pipe
            process.standardInput = FileHandle.nullDevice
            guard (try? process.run()) != nil else { return (false, "") }
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            return (process.terminationStatus == 0, String(decoding: data, as: UTF8.self))
        }.value
    }

    /// Starts the app's Bot Server anew, after an update of the app.
    func restart() {
        guard service.status == .enabled else { return }
        Self.launchctl(["kickstart", "-k", "gui/\(getuid())/\(LocalPaths.label)"])
    }

    /// A pairing code for this Mac's Bot Server, made by the Bot Server's own command: the
    /// app's, or the one of `wizards bot install`.
    func pairingCode() async -> String? {
        let output: String?
        if found == nil, let node = LocalPaths.node(in: .main), let cli = LocalPaths.cli(in: .main) {
            output = await Self.run(node, [cli.path, "pair", "--json"])
        } else if FileManager.default.isExecutableFile(atPath: LocalPaths.installCommand.path) {
            output = await Self.run(LocalPaths.installCommand, ["pair"])
        } else {
            output = nil
        }
        return output.flatMap(PairOutput.read)?.code
    }

    /// The address for the phone and a pairing code, for the QR.
    func phonePairing() async -> (address: String, code: String)? {
        guard let node = LocalPaths.node(in: .main), let cli = LocalPaths.cli(in: .main),
              let output = await Self.run(node, [cli.path, "pair", "--json"]),
              let read = PairOutput.read(output), let address = read.address
        else { return nil }
        return (address, read.code)
    }

    /// Starts the Bot Server of `wizards bot install` that does not answer.
    func startInstalled() async -> Bool {
        Self.launchctl(["kickstart", "gui/\(getuid())/\(LocalPaths.installLabel)"])
        for _ in 0 ..< 30 {
            if case .home = await Health.check(Self.address, seconds: 1) { return true }
            try? await Task.sleep(for: .milliseconds(500))
        }
        return false
    }

    /// The program that listens on 4747, by name.
    private static func listener() -> String? {
        let pipe = Pipe()
        let lsof = Process()
        lsof.executableURL = URL(filePath: "/usr/sbin/lsof")
        lsof.arguments = ["-nP", "-iTCP:\(Address.port)", "-sTCP:LISTEN", "-Fc"]
        lsof.standardOutput = pipe
        lsof.standardError = FileHandle.nullDevice
        guard (try? lsof.run()) != nil else { return nil }
        lsof.waitUntilExit()
        let text = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        return text.split(separator: "\n").first { $0.hasPrefix("c") }.map { String($0.dropFirst()) }
    }

    @discardableResult
    static func launchctl(_ arguments: [String]) -> Int32 {
        let process = Process()
        process.executableURL = URL(filePath: "/bin/launchctl")
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        guard (try? process.run()) != nil else { return -1 }
        process.waitUntilExit()
        return process.terminationStatus
    }

    /// Runs a program and gives back what it printed, or nil when it failed.
    /// Runs a program and gives back what it printed, or nil when it failed or took longer than
    /// `timeout` seconds. A shell's start files may print or exit as they like; only the output
    /// counts then.
    static func run(_ program: URL, _ arguments: [String], environment: [String: String]? = nil, timeout: TimeInterval = 30) async -> String? {
        await Task.detached {
            let process = Process()
            let pipe = Pipe()
            process.executableURL = program
            process.arguments = arguments
            if let environment { process.environment = environment }
            process.standardOutput = pipe
            process.standardError = FileHandle.nullDevice
            process.standardInput = FileHandle.nullDevice
            guard (try? process.run()) != nil else { return nil }
            let deadline = DispatchTime.now() + timeout
            DispatchQueue.global().asyncAfter(deadline: deadline) {
                if process.isRunning { process.terminate() }
            }
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            let text = String(decoding: data, as: UTF8.self)
            if process.terminationReason == .uncaughtSignal { return text.isEmpty ? nil : text }
            return process.terminationStatus == 0 || arguments.contains("-l") ? text : nil
        }.value
    }
}
