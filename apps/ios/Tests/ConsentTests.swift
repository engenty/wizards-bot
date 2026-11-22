import Foundation
import Testing

/// Where what the person writes goes: the services the home names, the yes it waits for, and the
/// privacy policy the app carries.
struct ConsentTests {
    private func models(_ json: String) throws -> Models {
        try JSONDecoder().decode(Models.self, from: Data(json.utf8))
    }

    @Test func theServicesTheHomeUses() throws {
        let view = try models("""
        {
          "sources": [
            { "id": "claude", "kind": "subscription", "label": "Claude", "where": "Mac", "online": true,
              "models": [{ "id": "sonnet", "label": "Sonnet" }], "service": "anthropic" },
            { "id": "ollama", "kind": "ollama", "label": "Ollama", "where": "Mac", "online": true, "models": [] }
          ],
          "order": [],
          "current": "claude:sonnet",
          "services": [
            { "id": "anthropic", "label": "Anthropic", "sources": ["Claude"], "inUse": true },
            { "id": "openrouter", "label": "OpenRouter", "sources": [], "inUse": false,
              "agreed": { "at": "2026-11-22T10:00:00.000Z", "by": "Ada's iPhone" } }
          ]
        }
        """)
        #expect(view.sources.map(\.service) == ["anthropic", nil])
        #expect(view.waitingForYes.map(\.id) == ["anthropic"])
        #expect(view.services[0].line == "Anthropic – Claude")
        #expect(view.services[1].line == "OpenRouter")
        #expect(view.services[1].agreed?.by == "Ada's iPhone")
    }

    @Test func aServiceWithTheYesWaitsNoLonger() throws {
        let view = try models("""
        { "sources": [], "order": [], "services": [
          { "id": "anthropic", "label": "Anthropic", "sources": ["Claude"], "inUse": true,
            "agreed": { "at": "2026-11-22T10:00:00.000Z", "by": "Phone" } } ] }
        """)
        #expect(view.waitingForYes.isEmpty)
    }

    @Test func anOlderHomeNamesNoServicesAndAsksNothing() throws {
        let view = try models(#"{ "sources": [], "order": [] }"#)
        #expect(view.services.isEmpty)
        #expect(view.waitingForYes.isEmpty)
    }

    @Test func theHomeRefusesWhatWaitsForTheYes() {
        let body = #"{ "error": "needs_consent", "message": "Your home uses OpenRouter.", "services": [{ "id": "openrouter", "label": "OpenRouter", "sources": ["OpenRouter"], "inUse": true }] }"#
        guard case .needsConsent(let services) = HomeClient.error(status: 409, body: Data(body.utf8)) else {
            Issue.record("needs_consent is not read as such")
            return
        }
        #expect(services.map(\.id) == ["openrouter"])
        // The selfie's question has a list of names under `models`; it stays an error of its own.
        let selfie = #"{ "error": "leaves_home", "message": "…", "models": ["Claude"] }"#
        #expect(HomeClient.error(status: 409, body: Data(selfie.utf8)) == .home(code: "leaves_home", message: "…"))
    }

    @Test func theYesTheAppSends() throws {
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(AgreeToServices(services: ["anthropic"]))) as? [String: Any]
        #expect(json?["services"] as? [String] == ["anthropic"])
        let client = HomeClient(baseURL: URL(string: "http://127.0.0.1:4747")!, token: "t")
        #expect(client.request("DELETE", "/v1/consent/anthropic").url?.absoluteString == "http://127.0.0.1:4747/v1/consent/anthropic")
    }

    /// The app shows its own copy of docs/privacy.md: the two say the same.
    @Test func thePrivacyPolicyIsTheOneInDocs() throws {
        let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        guard let docs = try? String(contentsOf: here.appending(path: "../../../docs/privacy.md").standardizedFileURL, encoding: .utf8) else { return }
        let copy = try String(contentsOf: here.appending(path: "../App/privacy.md").standardizedFileURL, encoding: .utf8)
        #expect(copy == docs, "Copy docs/privacy.md to apps/ios/App/privacy.md.")
    }
}
