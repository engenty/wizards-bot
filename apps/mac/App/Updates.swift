import Sparkle

/// Sparkle: the app and the Bot Server inside it update together. It runs only in a build that
/// names the public key its updates are signed with (`SPARKLE_PUBLIC_KEY`).
final class Updates {
    static let shared = Updates()
    private let controller: SPUStandardUpdaterController?

    private init() {
        let key = Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") as? String ?? ""
        controller = key.isEmpty || key.hasPrefix("$(")
            ? nil
            : SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
    }

    var available: Bool { controller != nil }

    func check() {
        controller?.checkForUpdates(nil)
    }
}
