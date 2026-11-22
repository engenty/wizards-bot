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

    static let address = URL(string: "http://localhost:\(Address.port)")!

    private(set) var found: Found?
    /// Data of an earlier Bot Server is in `~/.wizards-bot`: starting here uses it.
    private(set) var hasData = false
    var busy = false
    var step = ""
    var problem: String?

    private let service = SMAppService.agent(plistName: LocalPaths.plist)

    /// The app carries a Bot Server (a build of `pnpm pack:mac`; a plain Xcode build does not).
    var canStart: Bool { LocalPaths.node(in: .main) != nil && LocalPaths.cli(in: .main) != nil }

    /// The app's own Bot Server is registered with macOS.
    var isOurs: Bool { service.status == .enabled || service.status == .requiresApproval }

    var needsApproval: Bool { service.status == .requiresApproval }

    var bundledVersion: String? { LocalPaths.version(in: .main) }

    /// Looks at the Mac: the app's own Bot Server, one of `wizards bot install`, one by hand,
    /// another program on 4747, data in `~/.wizards-bot`.
    func look() async {
        hasData = FileManager.default.fileExists(atPath: LocalPaths.data.appending(path: "home.db").path)
        let byInstall = FileManager.default.fileExists(atPath: LocalPaths.installPlist.path)
        switch await Health.check(Self.address, seconds: 2) {
        case let .home(version):
            found = isOurs ? nil : .runs(version: version, byInstall: byInstall)
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
            return false
        }
        await look()
        if case let .portTaken(program) = found {
            problem = String(localized: "Port 4747 is taken by \(program). The app starts no Bot Server beside it.")
            return false
        }
        if case .runs = found { return true }
        busy = true
        defer { busy = false }
        step = String(localized: "Looking where your programs are…")
        await writeShellPath()
        step = String(localized: "Starting your Bot Server…")
        do {
            if service.status == .enabled { try? await service.unregister() }
            try service.register()
        } catch {
            if service.status != .requiresApproval {
                problem = String(localized: "macOS did not start the Bot Server: \(error.localizedDescription)")
                return false
            }
        }
        if service.status == .requiresApproval {
            problem = String(localized: "macOS asks you to allow the Bot Server: turn on wizards in Login Items, then start it again.")
            SMAppService.openSystemSettingsLoginItems()
            return false
        }
        for _ in 0 ..< 60 {
            if case .home = await Health.check(Self.address, seconds: 1) {
                found = nil
                return true
            }
            try? await Task.sleep(for: .milliseconds(500))
        }
        problem = String(localized: "The Bot Server did not start. What it said is in ~/.wizards-bot/logs/home.log.")
        return false
    }

    /// Writes the folders of the person's login shell into `~/.wizards-bot/path`, where the
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
