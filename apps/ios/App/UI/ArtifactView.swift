import SwiftUI
import WebKit

/// An artifact beside the chat: a page an agent wrote, shown where a document is shown. It is a
/// stranger's page. It loads from the home's address for it, which the home serves closed off;
/// it gets no bridge to the app, keeps nothing, and leaves for nowhere: a link opens in Safari.
/// A connection's view (`format` `app`) loads the home's host, which frames the view and runs
/// its bridge to the home itself; the app only opens the links it asks for in Safari.
struct ArtifactView: View {
    @Environment(AppModel.self) private var model
    @Bindable var session: ArtifactSession

    var body: some View {
        Group {
            if session.refused {
                ContentUnavailableView {
                    Label("The page isn’t shown", systemImage: "square.on.circle")
                } description: {
                    Text("Your Bot Server sent this page without closing it off, so it is not shown.")
                }
            } else if let shown = session.shown {
                ArtifactPage(shown: shown, refused: $session.refused) {
                    // The address ran out before it loaded.
                    Task { await session.load(reload: true) }
                }
                .ignoresSafeArea(edges: .bottom)
            } else if let problem = session.problem {
                ContentUnavailableView {
                    Label("The page isn’t here", systemImage: "square.on.circle")
                } description: {
                    Text(problem)
                } actions: {
                    Button("Try again") { Task { await session.load() } }
                }
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle(session.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Close", systemImage: "xmark") { model.closePane() }
            }
        }
        // Read anew while it is open: the address of the page works for an hour.
        .task(id: session.id) {
            await session.refreshIfRunOut()
            while !Task.isCancelled {
                try? await Task.sleep(for: ArtifactSession.every)
                guard !Task.isCancelled else { return }
                await session.load()
            }
        }
    }
}

/// The page in a web view of its own: nothing kept, no messages to the app, no way away.
private struct ArtifactPage: UIViewRepresentable {
    let shown: ArtifactSession.Shown
    @Binding var refused: Bool
    let onRunOut: () -> Void

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        // The host of a connection's view asks for links here (apps/web/src/app-host).
        configuration.userContentController.add(HostMessages(coordinator: context.coordinator), name: "app")
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.dataDetectorTypes = []
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.allowsBackForwardNavigationGestures = false
        view.allowsLinkPreview = false
        view.isInspectable = false
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        context.coordinator.parent = self
        guard context.coordinator.loaded != shown.url else { return }
        context.coordinator.loaded = shown.url
        var request = URLRequest(url: shown.url)
        request.setValue(nil, forHTTPHeaderField: "Referer")
        view.load(request)
    }

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.configuration.userContentController.removeScriptMessageHandler(forName: "app")
        view.stopLoading()
        view.navigationDelegate = nil
        view.uiDelegate = nil
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var parent: ArtifactPage
        /// The address the view was asked to load: the only one it may show.
        var loaded: URL?
        /// When an address last ran out, so a home that refuses every key is not asked on and on.
        private var ranOut = Date.distantPast

        init(_ parent: ArtifactPage) { self.parent = parent }

        /// The view a host page frames: its `page` beside its `host`, on the same home.
        var viewOfHost: URL? {
            guard let loaded, loaded.path.hasSuffix("/host") else { return nil }
            var parts = URLComponents(url: loaded, resolvingAgainstBaseURL: false)
            parts?.path = String(loaded.path.dropLast("host".count)) + "page"
            parts?.query = nil
            return parts?.url
        }

        /// What the host of a connection's view asks: a link, opened in Safari. Nothing else.
        func hostSaid(_ body: Any) {
            guard viewOfHost != nil,
                  let message = body as? [String: Any],
                  message["type"] as? String == "open-link",
                  let text = message["url"] as? String,
                  let url = URL(string: text),
                  ["http", "https"].contains(url.scheme ?? "") else { return }
            Task { @MainActor in await UIApplication.shared.open(url) }
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard let url = action.request.url else { return .cancel }
            // Inside the page: frames of its own content only; the page's policy allows no others.
            // The host of a connection's view frames that view, from the same home.
            if action.targetFrame?.isMainFrame == false {
                if let view = viewOfHost, url.host == view.host, url.port == view.port, url.path == view.path {
                    return .allow
                }
                return ["about", "data", "blob"].contains(url.scheme ?? "") ? .allow : .cancel
            }
            if url == loaded { return .allow }
            // Anything else leaves the page: a link the person tapped opens in Safari.
            if action.navigationType == .linkActivated, ["http", "https", "mailto"].contains(url.scheme ?? "") {
                await UIApplication.shared.open(url)
            }
            return .cancel
        }

        /// The home's https on the person's network is trusted by its print, as for every load (`HomeTrust`).
        func webView(
            _ webView: WKWebView, respondTo challenge: URLAuthenticationChallenge
        ) async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
            HomeTrust.shared.answer(challenge)
        }

        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse) async -> WKNavigationResponsePolicy {
            guard response.isForMainFrame else { return .allow }
            guard let http = response.response as? HTTPURLResponse else { return .cancel }
            if http.statusCode == 403 {
                // The key ran out: the artifact is read again for a new address.
                if Date.now.timeIntervalSince(ranOut) > 30 {
                    ranOut = .now
                    parent.onRunOut()
                }
                return .cancel
            }
            // A page that does not come closed off by the home's policy is not shown.
            let policy = (http.value(forHTTPHeaderField: "Content-Security-Policy") ?? "").lowercased()
            guard policy.split(separator: ";").contains(where: { $0.trimmingCharacters(in: .whitespaces).hasPrefix("sandbox") }) else {
                parent.refused = true
                return .cancel
            }
            return .allow
        }

        /// The page opens no windows.
        func webView(
            _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
            for action: WKNavigationAction, windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            nil
        }
    }
}

/// Passes the host's messages on without the web view keeping the coordinator alive.
private final class HostMessages: NSObject, WKScriptMessageHandler {
    weak var coordinator: ArtifactPage.Coordinator?

    init(coordinator: ArtifactPage.Coordinator) { self.coordinator = coordinator }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        coordinator?.hostSaid(message.body)
    }
}
