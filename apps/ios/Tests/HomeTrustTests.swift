import Foundation
import Testing

/// The home's https on the person's network: trusted by the print of its key alone.
@Suite struct HomeTrustTests {
    @Test func printOfAKeyIsTheHomesPrint() throws {
        // A P-256 point and its print as the home makes it (Node: SHA-256 of the SPKI, base64url).
        let point = try #require(Data(hex: "041143d274f3fc70cd3e0ab2a8e9dd38c77869a3306eb1b08021873d3f3cd9899dfa707c4a9d3b459d66c953929518d8366f39b9ef0f68f138e426c3b85f1dd600"))
        #expect(HomeTrust.print(ofP256Point: point) == "9BcTf0LIArw7r-zRzJFaj2aAiS1sD30LCGH9-I84O3k")
        #expect(HomeTrust.print(ofP256Point: point.prefix(64)) == nil)
    }

    @Test func pairingLinkCarriesThePrint() throws {
        let link = try #require(PairingLink("wizardsbot://pair?home=https%3A%2F%2F192.168.1.20%3A4747&code=K7QM-2RXD&k=9BcTf0LIArw7r-zRzJFaj2aAiS1sD30LCGH9-I84O3k"))
        #expect(link.home.absoluteString == "https://192.168.1.20:4747")
        #expect(link.print == "9BcTf0LIArw7r-zRzJFaj2aAiS1sD30LCGH9-I84O3k")
        #expect(try #require(PairingLink("wizardsbot://pair?home=http://192.168.1.20:4747&code=K7QM-2RXD")).print == nil)
    }

    @Test func aPrintCountsForItsOwnHostAndPort() throws {
        let trust = HomeTrust()
        trust.trust("abc", at: try #require(URL(string: "https://192.168.1.20:4747")))
        trust.trust("ignored", at: try #require(URL(string: "http://192.168.1.21:4747")))
        #expect(trust.print(host: "192.168.1.20", port: 4747) == "abc")
        #expect(trust.print(host: "192.168.1.20", port: 4748) == nil)
        #expect(trust.print(host: "192.168.1.21", port: 4747) == nil)
    }

    @Test func onlyAnHttpLinkOnThePersonsNetworkMovesToHttps() throws {
        func link(_ address: String) throws -> HomeLink {
            HomeLink(baseURL: try #require(URL(string: address)), token: "t", deviceId: "dev_1", name: "Ada")
        }
        #expect(try link("http://192.168.1.20:4747").secureAddress?.absoluteString == "https://192.168.1.20:4747")
        #expect(try link("http://mac-mini.local:4747").secureAddress?.absoluteString == "https://mac-mini.local:4747")
        #expect(try link("http://192.168.1.20").secureAddress?.absoluteString == "https://192.168.1.20:80")
        #expect(try link("https://192.168.1.20:4747").secureAddress == nil)
        #expect(try link("http://me.example.com").secureAddress == nil)
    }

    @Test func aLinkKeptBeforePrintsStillReads() throws {
        let json = #"{ "baseURL": "http://192.168.1.20:4747", "token": "t", "deviceId": "dev_1", "name": "Ada" }"#
        let link = try JSONDecoder().decode(HomeLink.self, from: Data(json.utf8))
        #expect(link.print == nil)
        #expect(link.secureAddress != nil)
    }
}

private extension Data {
    init?(hex: String) {
        var bytes: [UInt8] = []
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2, limitedBy: hex.endIndex) ?? hex.endIndex
            guard let byte = UInt8(hex[index ..< next], radix: 16) else { return nil }
            bytes.append(byte)
            index = next
        }
        self.init(bytes)
    }
}
