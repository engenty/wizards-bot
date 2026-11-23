import Foundation
import Testing

@Suite struct AddressTests {
    @Test func namesGetHTTPS() {
        #expect(Address.normalize("ada.wizards.bot")?.absoluteString == "https://ada.wizards.bot")
        #expect(Address.normalize("  ada.wizards.bot/ ")?.absoluteString == "https://ada.wizards.bot")
    }

    @Test func thisNetworkGetsHTTPAndThePort() {
        #expect(Address.normalize("macmini.local")?.absoluteString == "http://macmini.local:4747")
        #expect(Address.normalize("192.168.1.20")?.absoluteString == "http://192.168.1.20:4747")
        #expect(Address.normalize("localhost:5000")?.absoluteString == "http://localhost:5000")
        #expect(Address.normalize("macmini")?.absoluteString == "http://macmini:4747")
    }

    @Test func aFullAddressStaysWithoutItsPath() {
        #expect(Address.normalize("http://example.com:4747/setup#x")?.absoluteString == "http://example.com:4747")
        #expect(Address.normalize("https://ada.wizards.bot")?.absoluteString == "https://ada.wizards.bot")
    }

    @Test func notAnAddress() {
        #expect(Address.normalize("") == nil)
        #expect(Address.normalize("two words") == nil)
        #expect(Address.normalize("ftp://example.com") == nil)
    }

    @Test func localHosts() {
        #expect(Address.isLocal("10.0.0.2"))
        #expect(Address.isLocal("172.20.1.1"))
        #expect(!Address.isLocal("172.32.1.1"))
        #expect(!Address.isLocal("8.8.8.8"))
        #expect(!Address.isLocal("ada.wizards.bot"))
    }

    @Test func pairingLink() throws {
        let link = try #require(URL(string: "wizardsbot://pair?home=http%3A%2F%2Fmacmini.local%3A4747&code=K7QM-2RXD"))
        let read = try #require(Address.pairingLink(link))
        #expect(read.home.absoluteString == "http://macmini.local:4747")
        #expect(read.code == "K7QM-2RXD")
        #expect(Address.pairingLink(URL(string: "wizardsbot://pair?home=x.local")!) == nil)
        #expect(Address.pairingLink(URL(string: "https://pair?home=x&code=y")!) == nil)
    }

    @Test func label() {
        #expect(Address.label(URL(string: "http://macmini.local:4747")!) == "macmini.local:4747")
        #expect(Address.label(URL(string: "https://ada.wizards.bot")!) == "ada.wizards.bot")
    }
}

@Suite struct HealthTests {
    @Test func aBotServer() {
        #expect(Health.read(status: 200, body: Data(#"{"ok":true}"#.utf8)) == .home(version: nil))
        #expect(Health.read(status: 200, body: Data(#"{"ok":true,"home":true,"version":"0.2.0"}"#.utf8)) == .home(version: "0.2.0"))
    }

    @Test func somethingElse() {
        #expect(Health.read(status: 200, body: Data("<html>".utf8)) == .notHome)
        #expect(Health.read(status: 404, body: Data(#"{"ok":true}"#.utf8)) == .notHome)
        #expect(Health.read(status: 200, body: Data(#"{"ok":true,"home":false}"#.utf8)) == .notHome)
    }

    @Test func problems() {
        #expect(Health.problem(URLError(.cannotFindHost)) == .noSuchAddress)
        #expect(Health.problem(URLError(.timedOut)) == .noAnswer)
        #expect(Health.problem(URLError(.serverCertificateUntrusted)) == .certificate)
        #expect(Health.problem(URLError(.cannotConnectToHost)) == .nothingListens)
    }

    @Test func versions() {
        #expect(Version.older("0.1.1", than: "0.2.0"))
        #expect(!Version.older("0.2.0", than: "0.2.0"))
        #expect(!Version.older("0.10.0", than: "0.9.9"))
        #expect(Version.older("0.2", than: "0.2.1"))
        #expect(!Version.older("1.0.0-beta.1", than: "1.0.0"))
    }
}

@Suite struct OutputTests {
    @Test func pairJSON() throws {
        let read = try #require(PairOutput.read(#"{"address":"http://macmini.local:4747","code":"K7QM-2RXD"}"#))
        #expect(read.address == "http://macmini.local:4747")
        #expect(read.code == "K7QM-2RXD")
    }

    @Test func pairText() throws {
        let text = "▄▄▄ qr ▄▄▄\nAddress: http://macmini.local:4747\nCode:    K7QM-2RXD\nBrowser: http://…/#code=K7QM-2RXD\n"
        let read = try #require(PairOutput.read(text))
        #expect(read.address == "http://macmini.local:4747")
        #expect(read.code == "K7QM-2RXD")
        #expect(PairOutput.read("nothing") == nil)
    }

    @Test func shellPath() {
        let output = "Welcome!\n__WIZARDS_PATH__/opt/homebrew/bin:/usr/bin:relative:/usr/bin:/Users/a/.local/bin__WIZARDS_PATH__\n"
        #expect(ShellPath.read(output) == "/opt/homebrew/bin:/usr/bin:/Users/a/.local/bin")
        #expect(ShellPath.read("no marks") == nil)
    }
}

@Suite struct PairTests {
    @Test func aToken() {
        #expect(Pair.read(status: 200, body: Data(#"{"token":"abc","device":{}}"#.utf8)) == .paired(token: "abc"))
    }

    @Test func aCodeThatIsNotValid() {
        #expect(Pair.read(status: 401, body: Data(#"{"error":"unauthorized"}"#.utf8)) == .refused)
        #expect(Pair.read(status: 500, body: Data(#"{"message":"The Bot Server could not do this."}"#.utf8)) == .problem("The Bot Server could not do this."))
    }

    @Test func theRequest() throws {
        let request = Pair.request(URL(string: "http://localhost:4747")!, code: "K7QM-2RXD", name: "Ada's Mac")
        #expect(request.url?.absoluteString == "http://localhost:4747/v1/pair")
        let body = try #require(request.httpBody.flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: String] })
        #expect(body == ["code": "K7QM-2RXD", "name": "Ada's Mac", "kind": "browser"])
    }

    @Test func theTokenOnce() {
        let script = Pair.tokenScript("abc\"def")
        #expect(script.contains(#"localStorage.setItem("wizards.token", "abc\"def")"#))
        #expect(script.contains("sessionStorage"))
    }
}

@Suite struct LinkTests {
    @Test func theFileTheLinkReads() throws {
        let data = Link.file(home: URL(string: "https://ada.wizards.bot")!, token: "tok")
        let json = try #require(try JSONSerialization.jsonObject(with: data) as? [String: String])
        #expect(json == ["home": "https://ada.wizards.bot", "token": "tok"])
        #expect(Link.home(data)?.absoluteString == "https://ada.wizards.bot")
    }

    @Test func itsState() {
        #expect(Link.state(Data(#"{"state":"linked","home":"https://ada.wizards.bot"}"#.utf8)) == .linked)
        #expect(Link.state(Data(#"{"state":"refused"}"#.utf8)) == .refused)
        #expect(Link.state(Data(#"{"state":"something"}"#.utf8)) == nil)
    }

    @Test func theLinkLeaves() {
        let data = Link.file(home: URL(string: "https://ada.wizards.bot")!, token: "tok")
        #expect(Link.token(data) == "tok")
        let request = Link.removal(home: URL(string: "https://ada.wizards.bot")!, token: "tok")
        #expect(request.httpMethod == "DELETE")
        #expect(request.url?.absoluteString == "https://ada.wizards.bot/v1/device")
        #expect(request.value(forHTTPHeaderField: "authorization") == "Bearer tok")
    }

    @Test func aComputerPairs() throws {
        let request = Pair.request(URL(string: "https://ada.wizards.bot")!, code: "K7QM", name: "Ada's Mac", kind: "computer")
        let body = try #require(request.httpBody.flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: String] })
        #expect(body["kind"] == "computer")
    }
}
