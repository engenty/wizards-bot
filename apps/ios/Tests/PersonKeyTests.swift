import CryptoKit
import Foundation
import Testing

/// The person's key on the phone is the same key as in the web app: one recovery code for both.
@Suite struct PersonKeyTests {
    /// The key the web app's own test uses, with what the web app makes of it.
    private let seed = Data((0..<32).map { UInt8(($0 * 37 + 11) % 256) })
    private let webCode = "1CR5-AYMZ-RKMG-WCTR-FPHC-FV0H-6SDR-19EA-XWA3-JQM3-N36Z-45SW-C63D-0"
    private let webPublicKey = "JMOklPoimWJmRLllqRMtp5z-ZxUf3ELeYAzwkJfbgkc"

    @Test func theCodeIsTheOneTheWebAppShows() {
        #expect(PersonKey.code(for: seed) == webCode)
        #expect(PersonKey.seed(from: webCode) == seed)
        #expect(PersonKey.publicKey(of: seed) == webPublicKey)
    }

    @Test func theCodeIsReadHoweverItWasTyped() {
        let typed = webCode.lowercased()
            .replacingOccurrences(of: "-", with: " ")
            .replacingOccurrences(of: "0", with: "o")
            .replacingOccurrences(of: "1", with: "l")
        #expect(PersonKey.seed(from: typed) == seed)
        #expect(PersonKey.seed(from: "  \(webCode)\n") == seed)
    }

    @Test func aWrongCodeIsRefused() {
        let other = webCode.hasPrefix("7") ? "8" : "7"
        #expect(PersonKey.seed(from: other + webCode.dropFirst()) == nil)
        let swapped = String(webCode.dropFirst(2).prefix(0)) + String(Array(webCode)[1]) + String(Array(webCode)[0]) + webCode.dropFirst(2)
        #expect(PersonKey.seed(from: swapped) == nil)
        #expect(PersonKey.seed(from: String(webCode.dropLast(3))) == nil)
        #expect(PersonKey.seed(from: webCode + "-7K2M") == nil)
        #expect(PersonKey.seed(from: "") == nil)
        #expect(PersonKey.seed(from: "not a code") == nil)
    }

    @Test func whatItSignsAHomeCanCheck() throws {
        let payload = #"{"v":1,"name":"Ada"}"#
        let sig = try #require(PersonKey.sign(payload, with: seed))
        let padded = sig.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
            + String(repeating: "=", count: (4 - sig.count % 4) % 4)
        let signature = try #require(Data(base64Encoded: padded))
        let publicKey = try Curve25519.Signing.PrivateKey(rawRepresentation: seed).publicKey
        #expect(publicKey.isValidSignature(signature, for: Data(payload.utf8)))
        #expect(!publicKey.isValidSignature(signature, for: Data("other".utf8)))
    }

    @Test func theHomesAnswerAboutTheRecordDecodes() throws {
        let state = try JSONDecoder().decode(PersonState.self, from: Data("""
        { "record": { "v": 1, "id": "753e", "seq": 1795347770000, "name": "Ada", "handle": "ada@me.example.com",
            "key": "JMOk", "homes": [ { "url": "https://me.example.com", "key": "abc", "receives": true } ], "at": "…" },
          "proposed": { "payload": "{}", "why": "Your name changed." } }
        """.utf8))
        #expect(state.record?.key == "JMOk")
        #expect(state.proposed?.why == "Your name changed.")
        #expect(try JSONDecoder().decode(PersonState.self, from: Data("{}".utf8)).record == nil)
    }
}
