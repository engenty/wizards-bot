import Foundation
import Observation
import ServiceManagement

/// "Die Modelle dieses Macs anbieten": this Mac as a linked computer of a Bot Server elsewhere,
/// such as one at wizards.bot. That Bot Server then uses Claude Code, Codex and Ollama of this
/// Mac while the Mac is on. The link runs as the LaunchAgent `bot.wizards.link`, so it stays when
/// the app quits.
@Observable
final class MacLink {
    private(set) var home: URL?
    private(set) var state: Link.State?
    var busy = false
    var problem: String?
    /// The sheet that asks for the address and the code.
    var asking = false

    private let service = SMAppService.agent(plistName: LocalPaths.linkPlist)
    private var watching: Task<Void, Never>?

    /// The app carries Node and the Bot Server's code, which the link runs.
    var canLink: Bool { LocalPaths.node(in: .main) != nil && LocalPaths.cli(in: .main) != nil }

    var isOn: Bool { home != nil && (service.status == .enabled || service.status == .requiresApproval) }

    private var linkFile: URL { LocalPaths.linkData.appending(path: "link.json") }
    private var stateFile: URL { LocalPaths.linkData.appending(path: "link-state.json") }

    /// Reads where the link goes and how it stands, now and every few seconds while the app runs.
    func watch() {
        read()
        watching?.cancel()
        watching = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3))
                self?.read()
            }
        }
    }

    func read() {
        let linked = service.status == .enabled || service.status == .requiresApproval
        home = linked ? (try? Data(contentsOf: linkFile)).flatMap(Link.home) : nil
        state = linked ? (try? Data(contentsOf: stateFile)).flatMap(Link.state) : nil
    }

    /// Pairs this Mac with the Bot Server at `address` as a computer, keeps what the link needs
    /// in its folder and starts it. Returns what went wrong, or nil.
    func link(address: String, code: String) async -> String? {
        guard canLink else { return String(localized: "This build of the app carries no Bot Server.") }
        guard let url = Address.normalize(address) else {
            return String(localized: "That is not an address. It looks like ada.wizards.bot or macmini.local.")
        }
        guard Address.tidy(code).count >= 4 else {
            return String(localized: "The code is missing. Your Bot Server shows it in the chat under \u{201C}Add a device\u{201D}.")
        }
        busy = true
        defer { busy = false }
        switch await Health.check(url) {
        case .home: break
        case .notHome: return String(localized: "This address answers, but not as a Bot Server.")
        case let .unreachable(problem): return AppModel.say(problem)
        }
        let token: String
        switch await Pair.pair(url, code: code, name: AppModel.deviceName, kind: "computer") {
        case let .paired(paired): token = paired
        case .refused: return String(localized: "This code is not valid any more. Ask your Bot Server for a new one.")
        case let .problem(text): return String(localized: "The Bot Server did not pair this Mac: \(text)")
        }
        do {
            try FileManager.default.createDirectory(
                at: LocalPaths.linkData, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]
            )
            try Link.file(home: url, token: token).write(to: linkFile, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: linkFile.path)
            try? FileManager.default.removeItem(at: stateFile)
        } catch {
            return error.localizedDescription
        }
        await writeShellPath()
        if service.status == .enabled { try? await service.unregister() }
        do {
            try service.register()
        } catch {
            if service.status != .requiresApproval {
                return String(localized: "macOS did not start the link: \(error.localizedDescription)")
            }
        }
        read()
        if service.status == .requiresApproval {
            SMAppService.openSystemSettingsLoginItems()
            return String(localized: "macOS asks you to allow the link: turn on wizards in Login Items.")
        }
        for _ in 0 ..< 30 {
            read()
            if state == .linked || state == .refused { break }
            try? await Task.sleep(for: .milliseconds(500))
        }
        return state == .refused
            ? String(localized: "The Bot Server did not take this Mac. Ask it for a new code.")
            : nil
    }

    /// Ends the link: the Bot Server removes this Mac from its devices, when it can be reached,
    /// macOS forgets the LaunchAgent and the token goes.
    func stop() async {
        busy = true
        defer { busy = false }
        if let data = try? Data(contentsOf: linkFile), let home = Link.home(data), let token = Link.token(data) {
            _ = try? await URLSession.shared.data(for: Link.removal(home: home, token: token))
        }
        try? await service.unregister()
        try? FileManager.default.removeItem(at: linkFile)
        try? FileManager.default.removeItem(at: stateFile)
        read()
    }

    /// The folders of the person's login shell, where the link looks for `claude`, `codex` and
    /// `ollama`, as the Bot Server on this Mac does.
    private func writeShellPath() async {
        let shell = ProcessInfo.processInfo.environment["SHELL"].flatMap { $0.hasPrefix("/") ? $0 : nil } ?? "/bin/zsh"
        let mark = ShellPath.mark
        let output = await LocalHome.run(URL(filePath: shell), ["-l", "-i", "-c", "printf '\(mark)%s\(mark)' \"$PATH\""], timeout: 8)
        guard let path = output.flatMap(ShellPath.read) else { return }
        try? Data("\(path)\n".utf8).write(to: LocalPaths.linkData.appending(path: "path"), options: .atomic)
    }

    /// How the link stands, in one line for the settings and the menu.
    var said: String {
        guard let home else { return String(localized: "This Mac offers its models to no Bot Server.") }
        let name = Address.label(home)
        switch state {
        case .linked: return String(localized: "Offered to \(name).")
        case .away: return String(localized: "Offered to \(name), which is out of reach now. The link tries again.")
        case .refused: return String(localized: "\(name) removed this Mac. Offer the models again with a new code.")
        case .connecting, nil: return String(localized: "Connecting to \(name)…")
        }
    }
}
