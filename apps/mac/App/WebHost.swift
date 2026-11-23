import AppKit
import SwiftUI
import UniformTypeIdentifiers
import WebKit

/// The one web view of the app: the Bot Server's web app. It outlives the window, so closing and
/// opening the window keeps the chat where it was.
final class WebHost: NSObject {
    let view: WKWebView
    private(set) var home: URL?
    private let bridge = Bridge()

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.preferences.isElementFullscreenEnabled = true
        configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "wizardsMac")
        view = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        view.navigationDelegate = self
        view.uiDelegate = self
        view.allowsBackForwardNavigationGestures = false
        view.setValue(false, forKey: "drawsBackground")
        #if DEBUG
            view.isInspectable = true
        #endif
    }

    /// The token handed to the web app last, so the same pairing is not loaded twice.
    private var handed: String?

    /// Shows `home`'s web app; `token` is the device token of a pairing the app just made, which
    /// the web app finds where it keeps its own.
    func show(_ home: URL, token: String?, local: Bool) {
        if self.home == home, view.url != nil, token == nil || token == handed { return }
        let user = view.configuration.userContentController
        user.removeAllUserScripts()
        user.addUserScript(WKUserScript(source: Bridge.script(local: local), injectionTime: .atDocumentStart, forMainFrameOnly: true))
        if let token {
            user.addUserScript(WKUserScript(source: Pair.tokenScript(token), injectionTime: .atDocumentStart, forMainFrameOnly: true))
            handed = token
        }
        bridge.local = local
        self.home = home
        view.load(URLRequest(url: home))
    }

    /// Forgets the page and what the web app kept for its address (the device token with it).
    func clear() {
        if let home {
            let store = view.configuration.websiteDataStore
            store.fetchDataRecords(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes()) { records in
                let host = home.host ?? ""
                store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), for: records.filter { $0.displayName.contains(host) || host.contains($0.displayName) }) {}
            }
        }
        home = nil
        view.load(URLRequest(url: URL(string: "about:blank")!))
    }

    /// Tells the web app that the person clicked one of its notifications.
    func opened(tag: String) {
        let quoted = (try? String(data: JSONEncoder().encode(tag), encoding: .utf8)) ?? "\"\""
        view.evaluateJavaScript("window.dispatchEvent(new CustomEvent('wizards-mac:open', { detail: \(quoted) }))")
    }

    private func isHome(_ url: URL?) -> Bool {
        guard let url, let home else { return false }
        if url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" { return true }
        return url.host == home.host && url.port == home.port && url.scheme == home.scheme
    }
}

extension WebHost: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        if action.shouldPerformDownload { return .download }
        guard let url = action.request.url else { return .cancel }
        if url.scheme == "wizardsbot" {
            AppModel.shared.open(link: url)
            return .cancel
        }
        // The web app stays on its own address; every other link opens in the person's browser.
        if action.targetFrame?.isMainFrame != false, !isHome(url) {
            if url.scheme == "http" || url.scheme == "https" || url.scheme == "mailto" || url.scheme == "tel" {
                NSWorkspace.shared.open(url)
            }
            return .cancel
        }
        return .allow
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse) async -> WKNavigationResponsePolicy {
        let attachment = (response.response as? HTTPURLResponse)?
            .value(forHTTPHeaderField: "Content-Disposition")?.lowercased().hasPrefix("attachment") ?? false
        return attachment || !response.canShowMIMEType ? .download : .allow
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }
}

extension WebHost: WKDownloadDelegate {
    /// A file the person saves goes to Downloads, under a name not taken yet.
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String) async -> URL? {
        let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        let name = suggestedFilename.isEmpty ? "file" : suggestedFilename
        var target = folder.appending(path: name)
        let stem = target.deletingPathExtension().lastPathComponent
        let ext = target.pathExtension
        var number = 2
        while FileManager.default.fileExists(atPath: target.path) {
            target = folder.appending(path: ext.isEmpty ? "\(stem) \(number)" : "\(stem) \(number).\(ext)")
            number += 1
        }
        return target
    }

    func downloadDidFinish(_ download: WKDownload) {
        NSSound(named: "Glass")?.play()
    }
}

extension WebHost: WKUIDelegate {
    /// `target="_blank"` and `window.open`: the browser for other addresses, this view for the home.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            if isHome(url) { webView.load(action.request) } else { NSWorkspace.shared.open(url) }
        }
        return nil
    }

    /// `<input type="file">` of the composer.
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo) async -> [URL]? {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        guard let window = webView.window else { return panel.runModal() == .OK ? panel.urls : nil }
        return await panel.beginSheetModal(for: window) == .OK ? panel.urls : nil
    }

    /// The camera and the microphone, for the home's own page only. macOS asks the person too.
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType) async -> WKPermissionDecision {
        origin.host == home?.host ? .prompt : .deny
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async {
        let alert = NSAlert()
        alert.messageText = message
        alert.runModal()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async -> Bool {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: String(localized: "OK"))
        alert.addButton(withTitle: String(localized: "Cancel"))
        return alert.runModal() == .alertFirstButtonReturn
    }
}

/// What the web app asks of the Mac (`window.webkit.messageHandlers.wizardsMac`).
final class Bridge: NSObject, WKScriptMessageHandlerWithReply {
    /// The Bot Server runs on this Mac: the folder dialog is this Mac's.
    var local = false

    /// What the web app learns before it starts: that it runs in the Mac app, the Mac's name for
    /// pairing, and whether its Bot Server is on this Mac.
    static func script(local: Bool) -> String {
        let name = Host.current().localizedName ?? "Mac"
        let quoted = (try? String(data: JSONEncoder().encode(name), encoding: .utf8)) ?? "\"Mac\""
        return "window.wizardsMac = { local: \(local), name: \(quoted) };"
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) async -> (Any?, String?) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else {
            return (nil, "unknown message")
        }
        switch type {
        case "notify":
            Notifier.shared.post(
                title: body["title"] as? String ?? "",
                body: body["body"] as? String ?? "",
                tag: body["tag"] as? String ?? UUID().uuidString
            )
            return (true, nil)
        case "waiting":
            AppModel.shared.waiting = body["count"] as? Int ?? 0
            return (true, nil)
        case "pickFolder":
            guard local else { return (nil, nil) }
            return (await pickFolder(window: message.webView?.window), nil)
        default:
            return (nil, "unknown message")
        }
    }

    /// The Mac's folder dialog, in the app's window.
    private func pickFolder(window: NSWindow?) async -> String? {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.message = String(localized: "Which folder should your agents use?")
        panel.prompt = String(localized: "Choose")
        let answer = if let window { await panel.beginSheetModal(for: window) } else { panel.runModal() }
        return answer == .OK ? panel.url?.path : nil
    }
}

/// The web view in the window.
struct WebView: NSViewRepresentable {
    let host: WebHost

    func makeNSView(context: Context) -> NSView {
        let container = NSView()
        attach(to: container)
        return container
    }

    func updateNSView(_ container: NSView, context: Context) {
        if host.view.superview !== container { attach(to: container) }
    }

    private func attach(to container: NSView) {
        host.view.removeFromSuperview()
        host.view.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: container.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
    }
}
