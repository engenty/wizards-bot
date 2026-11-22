import Foundation
import Testing

/// Files on their way to the home and in messages, and artifacts.
@Suite struct FilesTests {
    private func decode<Value: Decodable>(_ type: Value.Type, _ json: String) throws -> Value {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    @Test func uploadIsOneFieldCalledFile() throws {
        let form = FileForm(boundary: "b0undary")
        #expect(form.contentType == "multipart/form-data; boundary=b0undary")
        let body = form.body(Data([0xFF, 0xD8, 0x00, 0x01]), name: "Ticket \"Kraków\".jpg", mime: "image/jpeg")
        let expected = Data("""
        --b0undary\r
        Content-Disposition: form-data; name="file"; filename="Ticket %22Kraków%22.jpg"\r
        Content-Type: image/jpeg\r
        \r

        """.utf8) + Data([0xFF, 0xD8, 0x00, 0x01]) + Data("\r\n--b0undary--\r\n".utf8)
        #expect(body == expected)
        // A type the phone does not know goes as bytes.
        let unknown = String(decoding: form.body(Data(), name: "a\r\nb", mime: ""), as: UTF8.self)
        #expect(unknown.contains("filename=\"a%0D%0Ab\"\r\nContent-Type: application/octet-stream\r\n"))
    }

    @Test func aMessageCarriesTenFilesAtMost() {
        #expect(FileLimits.perMessage == 10)
        #expect(FileLimits.maxBytes == 15_728_640)
        #expect(FileLimits.room(counted: 0, picked: 3) == 3)
        #expect(FileLimits.room(counted: 8, picked: 5) == 2)
        #expect(FileLimits.room(counted: 10, picked: 1) == 0)
        #expect(FileLimits.room(counted: 12, picked: 1) == 0)
    }

    @Test func messageWithFilesAndArtifact() throws {
        let message = try decode(Message.self, """
        { "id": "m", "conversationId": "c", "role": "you", "channel": "app", "state": "done", "createdAt": "t",
          "parts": [
            { "type": "file", "file": { "id": "fil_1", "name": "ticket.jpg", "mime": "image/jpeg", "size": 482113 } },
            { "type": "file", "file": { "id": "fil_2" } },
            { "type": "artifact", "artifactId": "art_1", "title": "Spending by month" },
            { "type": "text", "text": "Here." }
          ] }
        """)
        #expect(message.parts == [
            .file(FileRef(id: "fil_1", name: "ticket.jpg", mime: "image/jpeg", size: 482_113)),
            .unknown(type: "file", title: nil),
            .artifact(id: "art_1", title: "Spending by month"),
            .text("Here."),
        ])
        #expect(message.files.map(\.id) == ["fil_1"])
        #expect(message.text == "Here.")
        // What is decoded encodes back the same.
        let again = try JSONDecoder().decode(Message.self, from: JSONEncoder().encode(message))
        #expect(again.parts == message.parts)
    }

    @Test func sendingNamesTheFiles() throws {
        let sent = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(
            SendMessage(text: "", clientId: "x", files: ["fil_1", "fil_2"])
        )) as? [String: Any])
        #expect(sent["files"] as? [String] == ["fil_1", "fil_2"])
        #expect(sent["text"] as? String == "")
        let plain = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(SendMessage(text: "Hi"))) as? [String: Any])
        #expect(plain["files"] == nil)
    }

    @Test func artifactAndItsAddress() throws {
        let artifact = try decode(Artifact.self, """
        { "id": "art_1", "title": "Spending by month", "format": "html", "version": 2, "updatedAt": "t",
          "conversationId": "cnv_1", "content": "<main>…</main>", "page": "/v1/artifacts/art_1/page?until=1795251881&key=k1" }
        """)
        #expect(artifact.version == 2)
        #expect(Artifact.until(artifact.page) == Date(timeIntervalSince1970: 1_795_251_881))
        #expect(Artifact.pageOpens(artifact.page, at: Date(timeIntervalSince1970: 1_795_251_881 - 3600)))
        #expect(!Artifact.pageOpens(artifact.page, at: Date(timeIntervalSince1970: 1_795_251_881 - 30)))
        #expect(!Artifact.pageOpens("/v1/artifacts/art_1/page?key=k1"))
        let client = HomeClient(baseURL: URL(string: "http://localhost:4848/")!, token: "secret")
        #expect(client.pageURL(artifact.page)?.absoluteString == "http://localhost:4848/v1/artifacts/art_1/page?until=1795251881&key=k1")
        #expect(client.pageURL("https://elsewhere.example.com/x") == nil)

        guard case .artifactUpdated(let meta) = try decode(HomeEvent.self, """
        { "type": "artifact.updated", "artifact": { "id": "art_1", "title": "Spending", "format": "html", "version": 3,
          "updatedAt": "t", "conversationId": "cnv_1" } }
        """) else {
            Issue.record("artifact.updated did not decode")
            return
        }
        #expect(meta.version == 3)
    }

    @Test func secondsWhileTheAgentWorks() {
        #expect(Elapsed.label(seconds: 0) == nil)
        #expect(Elapsed.label(seconds: 3) == nil)
        #expect(Elapsed.label(seconds: 4) == "4 s")
        #expect(Elapsed.label(seconds: 59) == "59 s")
        #expect(Elapsed.label(seconds: 60) == "1:00")
        #expect(Elapsed.label(seconds: 65) == "1:05")
        #expect(Elapsed.label(seconds: 3725) == "62:05")
    }
}
