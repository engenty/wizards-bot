import Foundation
import Testing

/// Every JSON example of docs/protocol.md decodes, and what a newer home may add never breaks a message.
@Suite struct ProtocolTests {
    private func decode<Value: Decodable>(_ type: Value.Type, _ json: String) throws -> Value {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    // MARK: The examples of protocol.md

    static let homeInfo = """
    { "protocol": 1, "version": "0.1.0", "name": "Matthias", "handle": "matthias@me.example.com", "publicKey": "…" }
    """

    static let pairRequest = """
    { "code": "K7QM-2RXD", "name": "Matthias's iPhone", "kind": "phone",
      "push": { "token": "<apns hex>", "environment": "development", "topic": "bot.wizards" } }
    """

    static let pairResponse = """
    { "token": "<bearer token>", "device": { "id": "dev_…", "name": "…", "kind": "phone", "createdAt": "…", "seenAt": "…" },
      "home": { "protocol": 1, "version": "0.1.0", "name": "Matthias", "publicKey": "…" } }
    """

    static let message = """
    { "id": "msg_…", "conversationId": "cnv_…", "role": "agent", "agentId": "agt_…", "channel": "app",
      "state": "done", "model": "ollama:qwen3.8:27b-mlx", "createdAt": "2026-11-21T09:12:00.000Z",
      "parts": [
        { "type": "activity", "label": "Reading your calendar", "state": "done" },
        { "type": "text", "text": "You are free after 14:00." },
        { "type": "document", "documentId": "doc_…", "title": "Week plan" },
        { "type": "card", "card": { "id": "crd_…", "kind": "approval", "level": "needs_you", "state": "open",
            "title": "Send the invitation to Anna?", "body": "Thursday 15:00, 30 minutes.",
            "actions": [ { "id": "yes", "label": "Send", "style": "primary" }, { "id": "no", "label": "Don't send", "style": "plain" } ],
            "agentId": "agt_…", "conversationId": "cnv_…", "messageId": "msg_…", "createdAt": "…" } }
      ] }
    """

    static let push = """
    { "aps": { "alert": { "title": "Goose", "body": "Send the invitation to Anna?" },
               "category": "card.approval", "thread-id": "agt_…", "interruption-level": "time-sensitive",
               "sound": "default", "badge": 2 },
      "cardId": "crd_…", "conversationId": "cnv_…", "agentId": "agt_…",
      "actions": [ { "id": "yes", "label": "Send" }, { "id": "no", "label": "Don't send" } ] }
    """

    @Test func homeInfoExample() throws {
        let home = try decode(HomeInfo.self, Self.homeInfo)
        #expect(home.protocol == protocolVersion)
        #expect(home.version == "0.1.0")
        #expect(home.name == "Matthias")
        #expect(home.handle == "matthias@me.example.com")
    }

    @Test func pairRequestExample() throws {
        let request = try decode(PairRequest.self, Self.pairRequest)
        #expect(request.code == "K7QM-2RXD")
        #expect(request.kind == .phone)
        #expect(request.push == Push(token: "<apns hex>", environment: .development, topic: "bot.wizards"))
        // What the app sends reads the same when it comes back.
        let again = try decode(PairRequest.self, String(decoding: try JSONEncoder().encode(request), as: UTF8.self))
        #expect(again == request)
    }

    @Test func pairResponseExample() throws {
        let response = try decode(PairResponse.self, Self.pairResponse)
        #expect(response.token == "<bearer token>")
        #expect(response.device.kind == .phone)
        #expect(response.home.handle == nil)
    }

    @Test func messageExample() throws {
        let message = try decode(Message.self, Self.message)
        #expect(message.role == .agent)
        #expect(message.channel == .app)
        #expect(message.state == .done)
        #expect(message.model == "ollama:qwen3.8:27b-mlx")
        #expect(Timestamp.date(from: message.createdAt) != nil)
        #expect(message.parts.count == 4)
        #expect(message.parts[0] == .activity(label: "Reading your calendar", state: .done))
        #expect(message.parts[1] == .text("You are free after 14:00."))
        #expect(message.parts[2] == .document(id: "doc_…", title: "Week plan"))
        guard case .card(let card) = message.parts[3] else {
            Issue.record("The fourth part is a card")
            return
        }
        #expect(card.kind == .approval)
        #expect(card.level == .needsYou)
        #expect(card.state == .open)
        #expect(card.needsYou)
        #expect(card.actions.map(\.id) == ["yes", "no"])
        #expect(card.actions.map(\.style) == [.primary, .plain])
        #expect(card.answersFromNotification)
        #expect(message.text == "You are free after 14:00.")
        // A message survives being kept on the device.
        let again = try decode(Message.self, String(decoding: try JSONEncoder().encode(message), as: UTF8.self))
        #expect(again == message)
    }

    @Test func viewCardExample() throws {
        let card = try decode(Card.self, """
        {"id":"c1","kind":"question","level":"needs_you","state":"answered","title":"When suits you?",
         "view":{"program":"root = Column([f])\\nf = Form([d], \\"Send\\")","library":"engenty:core/1"},
         "actions":[],"agentId":"a","conversationId":"v","messageId":"m","createdAt":"2026-11-24T10:00:00.000Z",
         "answer":{"action":"view","message":"Send","state":{"when":"Mon","people":3,"ok":true},"by":"iPhone","at":"2026-11-24T10:01:00.000Z"}}
        """)
        #expect(card.view?.library == "engenty:core/1")
        #expect(card.view?.program.hasPrefix("root = Column") == true)
        #expect(card.answer?.state?["when"] == .string("Mon"))
        #expect(card.answer?.state?["people"] == .number(3))
        #expect(card.answer?.state?["ok"] == .bool(true))
    }

    @Test func pushExample() throws {
        let payload = try #require(try JSONSerialization.jsonObject(with: Data(Self.push.utf8)) as? [String: Any])
        let actions = try #require(CardNotifications.actions(in: payload))
        #expect(actions == [.init(id: "yes", label: "Send"), .init(id: "no", label: "Don't send")])
        #expect(payload[CardNotifications.Key.cardId] as? String == "crd_…")
        let category = (payload["aps"] as? [String: Any])?["category"] as? String
        #expect(category == CardNotifications.category(kind: "approval"))
        #expect(CardNotifications.categoryId(base: category ?? "", actions: actions) == "card.approval|yes=Send|no=Don't send")
        #expect(CardNotifications.answer(from: CardNotifications.category(base: "card.approval", actions: actions).actions[0].identifier) == "yes")
    }

    /// The file itself, when the tests run next to the repository: each `json` block decodes as what it shows.
    @Test func examplesInTheDocument() throws {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appending(path: "../../../docs/protocol.md").standardizedFileURL
        guard let text = try? String(contentsOf: file, encoding: .utf8) else { return }
        let blocks = text.components(separatedBy: "```json\n").dropFirst().compactMap { $0.components(separatedBy: "```").first }
        #expect(blocks.count >= 5)
        for block in blocks {
            let data = Data(block.utf8)
            let keys = Set(((try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]).keys)
            #expect(!keys.isEmpty, "An example is not JSON: \(block.prefix(60))")
            if Self.notInTheAppYet.contains(where: { $0.isSubset(of: keys) }) {
                // The home has these; the app has no shape for them and draws none of them.
                continue
            } else if keys.contains("aps") {
                #expect(CardNotifications.actions(in: try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])) != nil)
            } else if keys.contains("parts") {
                #expect(throws: Never.self) { try JSONDecoder().decode(Message.self, from: data) }
            } else if keys.contains("token") {
                #expect(throws: Never.self) { try JSONDecoder().decode(PairResponse.self, from: data) }
            } else if keys.contains("code") {
                #expect(throws: Never.self) { try JSONDecoder().decode(PairRequest.self, from: data) }
            } else if keys.contains("publicKey") {
                #expect(throws: Never.self) { try JSONDecoder().decode(HomeInfo.self, from: data) }
            } else if keys == ["resources"] {
                #expect(throws: Never.self) { try JSONDecoder().decode(DeviceResources.self, from: data) }
            } else if keys.isSuperset(of: ["deviceId", "agentName"]) {
                #expect(throws: Never.self) { try JSONDecoder().decode(Handoff.self, from: data) }
            } else if keys.isSuperset(of: ["folderId", "changes"]) {
                #expect(throws: Never.self) { try JSONDecoder().decode(FolderActivity.self, from: data) }
            } else if keys.isSuperset(of: ["home", "folders"]) {
                #expect(throws: Never.self) { try JSONDecoder().decode(FolderListing.self, from: data) }
            } else if keys.isSuperset(of: ["fields", "actions"]) {
                // The part of a card an example shows: its fields and its actions.
                let card = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
                let fields = try JSONSerialization.data(withJSONObject: card["fields"] ?? [])
                let actions = try JSONSerialization.data(withJSONObject: card["actions"] ?? [])
                #expect(throws: Never.self) { try JSONDecoder().decode([CardField].self, from: fields) }
                #expect(throws: Never.self) { try JSONDecoder().decode([CardAction].self, from: actions) }
            } else if keys.isSuperset(of: ["access", "path"]) {
                #expect(throws: Never.self) { try JSONDecoder().decode(Folder.self, from: data) }
            } else if keys.isSuperset(of: ["mime", "size"]), !keys.contains("type") {
                #expect(throws: Never.self) { try JSONDecoder().decode(FileRef.self, from: data) }
            } else if keys.isSuperset(of: ["kind", "setAt"]) {
                #expect(throws: Never.self) { try JSONDecoder().decode(SecretEntry.self, from: data) }
            } else if keys.isSuperset(of: ["sources", "order"]) {
                let models = try JSONDecoder().decode(Models.self, from: data)
                #expect(!models.services.isEmpty, "The example of the models shows where what the person writes goes.")
            } else if keys.isSuperset(of: ["page", "content"]) {
                #expect(throws: Never.self) { try JSONDecoder().decode(Artifact.self, from: data) }
            } else if keys.isSuperset(of: ["file", "type"]) {
                guard case .file = try JSONDecoder().decode(Part.self, from: data) else {
                    Issue.record("A `file` part does not decode as a file: \(block.prefix(60))")
                    continue
                }
            } else {
                Issue.record("An example this test does not know: \(block.prefix(60))")
            }
        }
    }

    /// Examples of protocol.md the app does not mirror yet, by the keys that tell them apart.
    static let notInTheAppYet: [Set<String>] = [
        ["documentId", "quote"],  // a mark in a document
        ["kind", "lasts"],  // publishing a document or an artifact
        ["sourceId", "url"],  // a published link
        ["kind", "handle"],  // sending a copy to a contact
        ["jsonrpc"],  // what an outside agent sends
        ["supportedInterfaces"],  // how an agent shows itself to outside agents
        ["kind", "said", "state"],  // a check of the home's setup
        ["homes", "seq"],  // a version of the person's record: the app makes and signs none yet
        ["skills", "tools", "state"],  // a plugin of the home: the app lists none yet
    ]

    // MARK: The file browser

    @Test func whatAFolderHoldsAndWhatHappenedInIt() throws {
        let place = try decode(FolderEntries.self, """
        { "folder": { "id": "fld_1", "name": "Büro", "path": "/Users/ada/Büro", "access": "write", "allow": "always",
            "createdAt": "2026-11-24T10:00:00.000Z" },
          "path": "Briefe", "parent": "",
          "entries": [ { "name": "kraus.md", "path": "Briefe/kraus.md", "kind": "file", "size": 32,
            "changedAt": "2026-11-24T10:22:00.000Z" } ],
          "more": false }
        """)
        #expect(place.folder.allow == .always)
        #expect(place.entries.first?.isFolder == false)
        let activity = try decode(FolderActivityEnvelope.self, """
        { "activity": [ { "id": "fac_1", "folderId": "fld_1", "read": 0,
          "changes": [ { "action": "make", "path": "Briefe/Archiv", "undone": true, "at": "t" } ], "at": "t" } ] }
        """).activity
        #expect(activity.first?.agentName == nil)
        #expect(activity.first?.changes.first?.undone == true)
        let edit = try JSONSerialization.jsonObject(with: JSONEncoder().encode(FolderEdit.trash(["a.txt"]))) as? [String: Any]
        #expect(edit?.keys.sorted() == ["action", "paths"])
    }

    // MARK: Rooms

    @Test func roomAndWhoWroteInIt() throws {
        let room = try decode(Agent.self, """
        { "id": "agt_9", "name": "Lisbon trip", "kind": "pebble", "about": "Ada, Ben · Travel", "origin": "room",
          "from": "ada@me.example.com", "state": "idle", "open": 0, "conversationId": "cnv_9", "main": false }
        """)
        #expect(room.origin == .room)

        let said = try decode(Message.self, """
        { "id": "msg_1", "conversationId": "cnv_9", "role": "agent", "channel": "home",
          "parts": [ { "type": "text", "text": "A tasca on the hill." } ], "state": "done",
          "from": { "name": "Recipes", "kind": "flame", "of": "Ben" }, "createdAt": "2026-11-22T12:00:00.000Z" }
        """)
        #expect(said.from == Writer(name: "Recipes", kind: .flame, of: "Ben"))
        let person = try decode(Message.self, """
        { "id": "msg_2", "conversationId": "cnv_9", "role": "agent", "channel": "home",
          "parts": [ { "type": "text", "text": "Flights are booked." } ], "state": "done",
          "from": { "name": "Ben" }, "createdAt": "2026-11-22T12:00:00.000Z" }
        """)
        #expect(person.from?.kind == nil)
        // A message of the person's own agent names no writer.
        #expect(try decode(Message.self, Self.message).from == nil)
    }

    // MARK: Envelopes and errors

    @Test func envelopes() throws {
        let agents = try decode(AgentsEnvelope.self, """
        { "agents": [ { "id": "agt_1", "name": "Goose", "kind": "round", "about": "Your agent.", "origin": "own",
            "state": "needs_you", "open": 2, "conversationId": "cnv_1", "main": true },
          { "id": "agt_2", "name": "Anna's planner", "kind": "sprout", "about": "", "origin": "shared",
            "from": "anna@anna.example", "state": "working", "open": 0, "conversationId": "cnv_2", "main": false } ] }
        """).agents
        #expect(agents.map(\.kind) == [.round, .sprout])
        #expect(agents.map(\.state) == [.needsYou, .working])
        #expect(agents[1].origin == .shared)
        #expect(agents[1].from == "anna@anna.example")

        let page = try decode(MessagesEnvelope.self, #"{ "messages": [\#(Self.message)], "more": true }"#)
        #expect(page.messages.count == 1)
        #expect(page.more == true)
        #expect(try decode(MessageEnvelope.self, #"{ "message": \#(Self.message) }"#).message.id == "msg_…")
        #expect(try decode(ItemsEnvelope.self, #"{ "items": [] }"#).items.isEmpty)

        let document = try decode(Document.self, """
        { "id": "doc_1", "title": "Week plan", "format": "markdown", "version": 3, "updatedAt": "2026-11-21T09:12:00.000Z",
          "updatedBy": "agent", "conversationId": "cnv_1", "content": "# Week plan" }
        """)
        #expect(document.format == .markdown)
        #expect(document.updatedBy == .agent)
        #expect(document.version == 3)

        let models = try decode(Models.self, """
        { "sources": [ { "id": "ollama", "kind": "ollama", "label": "Ollama", "where": "Mac mini", "online": true,
            "models": [ { "id": "qwen3.8:27b-mlx", "label": "Qwen 3.8" } ] } ],
          "order": ["ollama:qwen3.8:27b-mlx"], "current": "ollama:qwen3.8:27b-mlx" }
        """)
        #expect(models.sources.first?.kind == .ollama)
        #expect(models.sources.first?.where == "Mac mini")
    }

    @Test func answeredCard() throws {
        let card = try decode(CardEnvelope.self, """
        { "card": { "id": "crd_1", "kind": "question", "level": "needs_you", "state": "answered", "title": "Which days?",
            "fields": [ { "id": "days", "label": "Days", "type": "multi", "options": [ { "id": "mo", "label": "Monday" } ] },
                        { "id": "note", "label": "Note", "type": "text", "placeholder": "e.g. mornings", "required": true },
                        { "id": "key", "label": "Key", "type": "secret" } ],
            "actions": [ { "id": "ok", "label": "Send", "style": "primary" } ],
            "answer": { "action": "ok", "values": { "days": ["mo"], "note": "mornings", "key": "•••" }, "by": "Matthias's iPhone",
                        "at": "2026-11-21T09:13:00.000Z" },
            "agentId": "agt_1", "conversationId": "cnv_1", "messageId": "msg_1", "createdAt": "2026-11-21T09:12:00.000Z" } }
        """).card
        #expect(card.state == .answered)
        #expect(!card.needsYou)
        #expect(card.chosen?.label == "Send")
        #expect(card.answer?.values?["days"] == .many(["mo"]))
        #expect(card.answer?.values?["note"] == .text("mornings"))
        #expect(card.fields?.map(\.type) == [.multi, .text, .secret])
        #expect(!card.answersFromNotification)
    }

    @Test func aGroupHomeNamesItsAdmins() throws {
        let home = try decode(HomeInfo.self, """
        { "protocol": 1, "version": "0.1.5", "name": "Club", "publicKey": "k", "hosted": true, "group": { "name": "Club" } }
        """)
        #expect(home.group?.name == "Club")
        let paired = try decode(PairResponse.self, """
        { "token": "t", "device": { "id": "dev_1", "name": "Ada's iPhone", "kind": "phone", "createdAt": "2026-11-24T10:00:00.000Z",
            "seenAt": "2026-11-24T10:00:00.000Z", "admin": { "id": "usr_ada", "name": "Ada" } },
          "home": { "protocol": 1, "version": "0.1.5", "name": "Club", "publicKey": "k", "group": { "name": "Club" } } }
        """)
        #expect(paired.device.admin == Admin(id: "usr_ada", name: "Ada"))
        let card = try decode(CardEnvelope.self, """
        { "card": { "id": "crd_2", "kind": "approval", "level": "needs_you", "state": "answered", "title": "Book the hall?",
            "actions": [ { "id": "yes", "label": "Book", "style": "primary" } ],
            "answer": { "action": "yes", "by": "Ben's iPhone", "admin": { "id": "usr_ben", "name": "Ben" }, "at": "2026-11-24T10:01:00.000Z" },
            "agentId": "agt_1", "conversationId": "cnv_1", "messageId": "msg_1", "createdAt": "2026-11-24T10:00:00.000Z" } }
        """).card
        #expect(card.answer?.admin?.name == "Ben")
        let message = try decode(Message.self, """
        { "id": "msg_2", "conversationId": "cnv_1", "role": "you", "channel": "app",
          "from": { "name": "Ben", "admin": "usr_ben" }, "parts": [ { "type": "text", "text": "Book it" } ],
          "state": "done", "createdAt": "2026-11-24T10:02:00.000Z" }
        """)
        #expect(message.from?.admin == "usr_ben")
    }

    @Test func aConnectCardTheHomeAnsweredItself() throws {
        let card = try decode(Card.self, """
        { "id": "crd_2", "kind": "connect", "level": "needs_you", "state": "answered", "title": "Sign in to your calendar",
          "url": "https://accounts.example.com/authorize", "actions": [ { "id": "later", "label": "Not now", "style": "plain" } ],
          "answer": { "action": "done", "by": "sign-in", "at": "2026-11-21T09:13:00.000Z" },
          "agentId": "agt_1", "conversationId": "cnv_1", "messageId": "msg_1", "createdAt": "2026-11-21T09:12:00.000Z" }
        """)
        #expect(card.kind == .connect)
        #expect(card.answer?.by == Card.signIn)
        // The action the home names is none of the card's own.
        #expect(card.chosen == nil)
    }

    @Test func whatTheAppSends() throws {
        func json(_ value: some Encodable) throws -> [String: Any] {
            try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any])
        }
        let send = try json(SendMessage(text: "Hello", spoken: true, clientId: "c1"))
        #expect(send["text"] as? String == "Hello")
        #expect(send["spoken"] as? Bool == true)
        #expect(try json(SendMessage(text: "Hello"))["spoken"] == nil)
        #expect(try json(SendMessage(text: "Hello", later: true))["later"] as? Bool == true)
        #expect(try json(SendMessage(text: "Hello"))["later"] == nil)

        let answer = try json(AnswerCard(action: "ok", values: ["days": .many(["mo"]), "note": .text("mornings")]))
        #expect(answer["action"] as? String == "ok")
        #expect((answer["values"] as? [String: Any])?["days"] as? [String] == ["mo"])
        #expect(try json(AnswerCard(action: "yes"))["values"] == nil)

        let view = try json(AnswerCard(action: "view", message: "Send", state: ["when": .string("Mon"), "people": .number(3)]))
        #expect(view["message"] as? String == "Send")
        #expect((view["state"] as? [String: Any])?["people"] as? Double == 3)
        #expect(try json(AnswerCard(action: "yes"))["state"] == nil)

        let imported = try json(ImportMessages(messages: [
            .init(role: .agent, text: "Hi", createdAt: "2026-11-21T09:12:00.000Z", model: "apple:on-device", clientId: "c2"),
        ]))
        #expect(((imported["messages"] as? [[String: Any]])?.first?["role"]) as? String == "agent")

        #expect(try json(AddDevice(name: "Apple Watch", kind: .watch))["kind"] as? String == "watch")
        #expect(try json(SaveDocument(content: "x", baseVersion: 3))["baseVersion"] as? Int == 3)

        // A field that is left out stays as it is; an explicit null removes the push token.
        #expect(try json(UpdateDevice(name: "Phone")).keys.sorted() == ["name"])
        #expect(try json(UpdateDevice(push: .some(nil)))["push"] is NSNull)
        let push = try json(UpdateDevice(push: .some(Push(token: "ab", environment: .production, topic: "bot.wizards"))))
        #expect((push["push"] as? [String: Any])?["environment"] as? String == "production")
    }

    @Test func aMessageForAfterTheAnswer() throws {
        let waiting = try decode(Message.self, """
        { "id": "msg_…", "conversationId": "cnv_…", "role": "you", "channel": "app", "state": "done",
          "queued": true, "createdAt": "2026-11-24T09:12:00.000Z", "parts": [{ "type": "text", "text": "And a seat." }] }
        """)
        #expect(waiting.queued == true)
        #expect(try decode(Message.self, Self.message).queued == nil)
    }

    @Test func errors() {
        func error(_ status: Int, _ body: String) -> HomeError { HomeClient.error(status: status, body: Data(body.utf8)) }
        #expect(error(401, #"{ "error": "unauthorized", "message": "Pair again." }"#) == .unauthorized)
        #expect(error(404, #"{ "error": "not_found", "message": "Not here." }"#) == .notFound("Not here."))
        #expect(error(404, "") == .notFound(nil))
        #expect(error(409, #"{ "error": "already_answered", "message": "Answered on your watch." }"#) == .alreadyAnswered(nil))
        #expect(error(409, #"{ "error": "version_conflict", "message": "Newer." }"#) == .versionConflict(nil))
        #expect(error(500, #"{ "error": "oops", "message": "Something broke." }"#) == .home(code: "oops", message: "Something broke."))
        #expect(error(500, "not json") == .home(code: "http_500", message: ""))
        #expect(error(502, "<html>") == .unreachable)

        let card = #"{ "id": "crd_1", "kind": "approval", "level": "needs_you", "state": "answered", "title": "Send?", "actions": [], "agentId": "a", "conversationId": "c", "messageId": "m", "createdAt": "t" }"#
        guard case .alreadyAnswered(let current?) = error(409, #"{ "error": "already_answered", "message": "…", "card": \#(card) }"#) else {
            Issue.record("A 409 carries the card as the home has it")
            return
        }
        #expect(current.state == .answered)
    }

    // MARK: What a newer home may send

    @Test func unknownPartNeverBreaksTheMessage() throws {
        let message = try decode(Message.self, """
        { "id": "m", "conversationId": "c", "role": "agent", "channel": "app", "state": "done", "createdAt": "t",
          "parts": [
            { "type": "text", "text": "Before." },
            { "type": "map", "title": "Route to the station", "points": [[1, 2]] },
            { "type": "poll" },
            { "type": "text" },
            { "type": "card", "card": { "id": "x", "title": "A card from the future", "kind": 7 } },
            "just a string",
            { "type": "text", "text": "After." }
          ] }
        """)
        #expect(message.parts == [
            .text("Before."),
            .unknown(type: "map", title: "Route to the station"),
            .unknown(type: "poll", title: nil),
            .unknown(type: "text", title: nil),
            .unknown(type: "card", title: "A card from the future"),
            .unknown(type: "", title: nil),
            .text("After."),
        ])
        #expect(message.text == "Before.\n\nAfter.")
    }

    @Test func unknownCardKindKeepsItsData() throws {
        let message = try decode(Message.self, """
        { "id": "m", "conversationId": "c", "role": "agent", "channel": "telegram", "state": "done", "createdAt": "t",
          "parts": [ { "type": "card", "card": { "id": "crd_9", "kind": "poll", "level": "fyi", "state": "open",
            "title": "Lunch on Friday?", "body": "Vote by noon.",
            "fields": [ { "id": "f", "label": "Where", "type": "slider" } ],
            "actions": [ { "id": "a", "label": "Vote", "style": "glowing" } ],
            "agentId": "a", "conversationId": "c", "messageId": "m", "createdAt": "t", "somethingNew": true } } ] }
        """)
        #expect(message.channel == .unknown("telegram"))
        let card = try #require(message.cards.first)
        #expect(card.kind == .unknown("poll"))
        #expect(!card.kind.isKnown)
        #expect(card.kind.rawValue == "poll")
        #expect(card.level == .unknown("fyi"))
        #expect(!card.needsYou)
        #expect(card.title == "Lunch on Friday?")
        #expect(card.fields?.first?.type == .unknown("slider"))
        #expect(card.actions.first?.style == .unknown("glowing"))
        // Written back as it came.
        let again = try decode(Card.self, String(decoding: try JSONEncoder().encode(card), as: UTF8.self))
        #expect(again == card)
    }

    @Test func everyKnownKindOfCard() throws {
        for kind in CardNotifications.kinds {
            let card = try decode(Card.self, """
            { "id": "c", "kind": "\(kind)", "level": "update", "state": "expired", "title": "t", "actions": [],
              "url": "https://example.com", "qr": "wizardsbot://pair?home=http://192.168.1.20:4747&code=K7QM-2RXD",
              "agentId": "a", "conversationId": "c", "messageId": "m", "createdAt": "t" }
            """)
            #expect(card.kind.isKnown, "\(kind)")
            #expect(card.kind.rawValue == kind)
        }
        #expect(CardKind.known.count == CardNotifications.kinds.count)
    }

    @Test func events() throws {
        func event(_ json: String) throws -> HomeEvent { try decode(HomeEvent.self, json) }
        #expect(try event(#"{"type":"message.created","message":\#(Self.message)}"#) == .messageCreated(try decode(Message.self, Self.message)))
        #expect(try event(#"{"type":"message.updated","message":\#(Self.message)}"#) == .messageUpdated(try decode(Message.self, Self.message)))
        #expect(try event(#"{"type":"message.delta","conversationId":"cnv_…","messageId":"msg_…","part":1,"text":" free"}"#)
            == .messageDelta(conversationId: "cnv_…", messageId: "msg_…", part: 1, text: " free"))
        #expect(try event(#"{"type":"agent.removed","agentId":"agt_1"}"#) == .agentRemoved(agentId: "agt_1"))
        #expect(try event(#"{"type":"reset"}"#) == .reset)
        guard case .documentUpdated(let meta) = try event("""
        {"type":"document.updated","document":{"id":"doc_1","title":"Week plan","format":"markdown","version":4,
         "updatedAt":"t","updatedBy":"you","conversationId":"cnv_1"}}
        """) else {
            Issue.record("document.updated carries the document's meta")
            return
        }
        #expect(meta.version == 4)
        #expect(meta.updatedBy == .you)
        guard case .cardUpdated = try event(#"{"type":"card.updated","card":{"id":"c","kind":"info","level":"update","state":"open","title":"t","actions":[],"agentId":"a","conversationId":"c","messageId":"m","createdAt":"t"}}"#),
              case .agentUpdated = try event(#"{"type":"agent.updated","agent":{"id":"a","name":"Goose","kind":"round","about":"","origin":"own","state":"idle","open":0,"conversationId":"c","main":true}}"#),
              case .modelsUpdated = try event(#"{"type":"models.updated","models":{"sources":[],"order":[]}}"#) else {
            Issue.record("card.updated, agent.updated and models.updated decode")
            return
        }
    }

    @Test func foldersUpdated() throws {
        let event = try decode(HomeEvent.self, """
        {"type":"folders.updated","folders":[{"id":"fld_1","name":"Trips","path":"/Users/ada/Trips","access":"write","createdAt":"t"}]}
        """)
        guard case .foldersUpdated(let folders) = event else {
            Issue.record("folders.updated carries the list")
            return
        }
        #expect(folders.map(\.name) == ["Trips"])
        #expect(folders.first?.access == .write)
    }

    @Test func whatDevicesOfferAndWhatTheyAreAsked() throws {
        guard case .devicesUpdated(let devices) = try decode(HomeEvent.self, """
        {"type":"devices.updated","devices":[
          {"id":"dev_1","name":"Ada's iPhone","kind":"phone","createdAt":"t","seenAt":"t",
           "resources":[{"id":"calendar","kind":"calendar","name":"Calendar","can":["read","change"]},
                        {"id":"pf_1","kind":"folder","name":"Receipts","can":["read"]},
                        {"id":"x","kind":"mail","name":"Mail","can":["read","forward"]}]},
          {"id":"dev_2","name":"Web","kind":"browser","createdAt":"t","seenAt":"t"}]}
        """) else {
            Issue.record("devices.updated carries the devices")
            return
        }
        #expect(devices.first?.resources?.map(\.kind) == [.calendar, .folder, .unknown("mail")])
        #expect(devices.first?.resources?.first?.can == [.read, .change])
        #expect(devices.first?.resources?.last?.can == [.read, .unknown("forward")])
        // A device that said nothing offers nothing.
        #expect(devices.last?.resources == nil)

        guard case .handoffUpdated(let handoff) = try decode(HomeEvent.self, """
        {"type":"handoff.updated","handoff":{"id":"hnd_1","deviceId":"dev_1","agentId":"agt_1","agentName":"Goose",
         "conversationId":"cnv_1","text":"What is tomorrow?","state":"answered","answer":"Dentist at 10.",
         "files":[{"id":"fil_1","name":"receipt.pdf","mime":"application/pdf","size":12}],"createdAt":"t","answeredAt":"t"}}
        """) else {
            Issue.record("handoff.updated carries the hand-off")
            return
        }
        #expect(handoff.state == .answered)
        #expect(handoff.answer == "Dentist at 10.")
        #expect(handoff.files?.first?.name == "receipt.pdf")
        // What the phone sends reads as the home takes it.
        let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(AnswerHandoff(text: "No.", declined: true))) as? [String: Any]
        #expect(body?["text"] as? String == "No.")
        #expect(body?["declined"] as? Bool == true)
        #expect(body?["files"] == nil)
        let offer = try JSONSerialization.jsonObject(with: JSONEncoder().encode(DeviceResources(resources: [
            DeviceResource(id: "contacts", kind: .contacts, name: "Contacts", can: [.read]),
        ]))) as? [String: Any]
        let first = (offer?["resources"] as? [[String: Any]])?.first
        #expect(first?["kind"] as? String == "contacts")
        #expect(first?["can"] as? [String] == ["read"])
        // Who may ask goes with what the phone offers, and comes back with the device.
        let told = try JSONSerialization.jsonObject(with: JSONEncoder().encode(DeviceResources(
            resources: [], agents: DeviceAgents(allowed: ["agt_1"], refused: ["agt_2"])
        ))) as? [String: Any]
        #expect((told?["agents"] as? [String: Any])?["refused"] as? [String] == ["agt_2"])
        let device = try decode(Device.self, #"{"id":"d","name":"P","kind":"phone","createdAt":"t","seenAt":"t","resources":[],"agents":{"allowed":["a"],"refused":[]}}"#)
        #expect(device.agents?.allowed == ["a"])
        #expect(device.resources?.isEmpty == true)
        let service = try decode(DeviceResource.self, #"{"id":"pc_1","kind":"connection","name":"Linear","can":["read","change"]}"#)
        #expect(service.kind == .connection)
    }

    @Test func unknownEventsAreSkippedNotFatal() throws {
        #expect(try decode(HomeEvent.self, #"{"type":"presence.changed","who":"anna"}"#) == .unknown(type: "presence.changed"))
        // A known type this version cannot read is unknown too.
        #expect(try decode(HomeEvent.self, #"{"type":"message.created","message":{"id":7}}"#) == .unknown(type: "message.created"))
        #expect(try decode(HomeEvent.self, #"{"type":"message.delta","messageId":"m"}"#) == .unknown(type: "message.delta"))
        #expect(try decode(HomeEvent.self, "{}") == .unknown(type: ""))
        #expect(try decode(HomeEvent.self, "[]") == .unknown(type: ""))
    }

    @Test func unknownNamesElsewhere() throws {
        let agent = try decode(Agent.self, """
        { "id": "a", "name": "Goose", "kind": "comet", "about": "", "origin": "borrowed", "state": "sleeping", "open": 0,
          "conversationId": "c", "main": false }
        """)
        #expect(agent.kind == .unknown("comet"))
        #expect(agent.origin == .unknown("borrowed"))
        #expect(agent.state == .unknown("sleeping"))
        #expect(try decode(Device.self, #"{ "id": "d", "name": "Glasses", "kind": "glasses", "createdAt": "t", "seenAt": "t" }"#).kind == .unknown("glasses"))
        #expect(try decode(Message.self, #"{ "id": "m", "conversationId": "c", "role": "system", "channel": "app", "state": "queued", "createdAt": "t", "parts": [] }"#).role == .unknown("system"))
    }

    // MARK: Pairing links and addresses

    @Test func pairingLink() throws {
        let link = try #require(PairingLink("wizardsbot://pair?home=http://192.168.1.20:4747&code=K7QM-2RXD"))
        #expect(link.home.absoluteString == "http://192.168.1.20:4747")
        #expect(link.code == "K7QM-2RXD")
        let encoded = try #require(PairingLink("wizardsbot://pair?home=https%3A%2F%2Fme.example.com%2F&code=k7qm2rxd"))
        #expect(encoded.home.absoluteString == "https://me.example.com")
        #expect(encoded.code == "K7QM-2RXD")
        #expect(PairingLink("wizardsbot://pair?home=http://192.168.1.20:4747") == nil)
        #expect(PairingLink("wizardsbot://open?home=http://192.168.1.20:4747&code=K7QM-2RXD") == nil)
        #expect(PairingLink("https://example.com/pair?home=x&code=y") == nil)
    }

    @Test func inviteLink() throws {
        let code = "k3v9x2m7q1p8z4w6t0r5y8u2a7s3d9f1"
        let print = "7f3a91c204bed5e8"
        let link = try #require(InviteLink("  https://ada.example.com/i/\(code)#k=\(print)\n"))
        #expect(link.text == "https://ada.example.com/i/\(code)#k=\(print)")
        // The page of an invite hands its link to the app.
        let handed = try #require(InviteLink(
            "wizardsbot://invite?link=https%3A%2F%2Fada.example.com%2Fi%2F\(code)%23k%3D\(print)"
        ))
        #expect(handed == link)
        // A home in the person's own network, and a link that names no key.
        #expect(InviteLink("http://192.168.1.20:4747/i/\(code)")?.text == "http://192.168.1.20:4747/i/\(code)")
        // Only the address, the code and the print go on to the home.
        #expect(InviteLink("https://ada.example.com/i/\(code)#k=\(print.uppercased())&x=1")?.text == link.text)
        #expect(InviteLink("https://ada.example.com/i/\(code)#k=short")?.text == "https://ada.example.com/i/\(code)")
        #expect(InviteLink("https://ada.example.com/i/\(code)?next=1") == nil)
        #expect(InviteLink("https://ada.example.com/s/\(code)") == nil)
        #expect(InviteLink("https://ada.example.com/i/\(code)/more") == nil)
        #expect(InviteLink("https://ada.example.com/i/short") == nil)
        #expect(InviteLink("ftp://ada.example.com/i/\(code)") == nil)
        #expect(InviteLink("wizardsbot://pair?home=http://192.168.1.20:4747&code=K7QM-2RXD") == nil)
        #expect(InviteLink("wizardsbot://invite?link=wizardsbot%3A%2F%2Finvite%3Flink%3Dx") == nil)
        #expect(PairingLink("wizardsbot://invite?link=https%3A%2F%2Fada.example.com%2Fi%2F\(code)") == nil)
        #expect(try decode(InviteOpened.self, #"{ "opened": true }"#) == InviteOpened(opened: true, message: nil))
        #expect(try decode(InviteOpened.self, #"{ "opened": false, "message": "That is not an invite link." }"#).message == "That is not an invite link.")
    }

    @Test func homeAddress() {
        #expect(HomeAddress.url(from: "192.168.1.20:4747")?.absoluteString == "http://192.168.1.20:4747")
        #expect(HomeAddress.url(from: " localhost:4747/ ")?.absoluteString == "http://localhost:4747")
        #expect(HomeAddress.url(from: "mac-mini.local:4747")?.absoluteString == "http://mac-mini.local:4747")
        #expect(HomeAddress.url(from: "me.example.com")?.absoluteString == "https://me.example.com")
        #expect(HomeAddress.url(from: "https://me.example.com/")?.absoluteString == "https://me.example.com")
        #expect(HomeAddress.url(from: "ftp://me.example.com") == nil)
        #expect(HomeAddress.url(from: "") == nil)
        #expect(HomeAddress.url(from: "my home") == nil)
    }

    @Test func requests() {
        let client = HomeClient(baseURL: URL(string: "https://me.example.com/home/")!, token: "secret")
        let request = client.request("GET", "/v1/conversations/cnv_1/messages", query: [URLQueryItem(name: "limit", value: "50")])
        #expect(request.url?.absoluteString == "https://me.example.com/home/v1/conversations/cnv_1/messages?limit=50")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer secret")
        #expect(HomeClient(baseURL: URL(string: "http://localhost:4747")!).request("GET", "/v1/home").value(forHTTPHeaderField: "Authorization") == nil)
    }

    @Test func timestamps() {
        #expect(Timestamp.date(from: "2026-11-21T09:12:00.000Z") == Timestamp.date(from: "2026-11-21T09:12:00Z"))
        let now = Timestamp.now()
        #expect(now.hasSuffix("Z"))
        #expect(now.count == "2026-11-21T09:12:00.000Z".count)
    }
}

/// The list of agents: what a home says about each conversation, and what a row makes of it.
@Suite struct AgentListTests {
    private func agent(_ more: String = "") throws -> Agent {
        try JSONDecoder().decode(Agent.self, from: Data("""
        { "id": "agt_1", "name": "Goose", "kind": "round", "about": "Your agent.", "origin": "own",
          "state": "idle", "open": 0, "conversationId": "cnv_1", "main": true\(more) }
        """.utf8))
    }

    @Test func whatTheHomeSaysAboutTheConversation() throws {
        let agent = try agent(#", "preview": "You are free after 14:00.", "unread": 3, "updatedAt": "2026-11-21T09:12:00.000Z""#)
        #expect(agent.preview == "You are free after 14:00.")
        #expect(agent.unread == 3)
        #expect(agent.updatedAt == "2026-11-21T09:12:00.000Z")
        // Kept on the device and read again, nothing is lost.
        #expect(try JSONDecoder().decode(Agent.self, from: JSONEncoder().encode(agent)) == agent)
    }

    @Test func anOlderHomeSaysNothingAboutIt() throws {
        let agent = try agent()
        #expect(agent.preview == "")
        #expect(agent.unread == 0)
        #expect(agent.updatedAt == "")
        #expect(AgentList.time(agent.updatedAt) == "")
        // Fields of the wrong kind count as missing and do not lose the agent.
        let odd = try self.agent(#", "preview": 7, "unread": "many", "updatedAt": null"#)
        #expect(odd.preview == "" && odd.unread == 0 && odd.updatedAt == "")
    }

    @Test func theEventCarriesTheNewFields() throws {
        let event = try JSONDecoder().decode(HomeEvent.self, from: Data("""
        {"type":"agent.updated","agent":{"id":"a","name":"Goose","kind":"round","about":"","origin":"own","state":"idle","open":0,
         "conversationId":"c","main":true,"preview":"Done.","unread":1,"updatedAt":"2026-11-21T09:12:00.000Z"}}
        """.utf8))
        guard case .agentUpdated(let agent) = event else {
            Issue.record("agent.updated carries the agent")
            return
        }
        #expect(agent.unread == 1)
        #expect(agent.preview == "Done.")
    }

    @Test func theBadgeOfARow() throws {
        var agent = try agent()
        #expect(AgentBadge(for: agent, onScreen: false) == .none)

        agent.unread = 2
        #expect(AgentBadge(for: agent, onScreen: false) == .unread(2))
        // The conversation on screen is read as it is shown.
        #expect(AgentBadge(for: agent, onScreen: true) == .none)

        agent.state = .working
        #expect(AgentBadge(for: agent, onScreen: false) == .unread(2))
        #expect(AgentBadge(for: agent, onScreen: true) == .working)
        agent.unread = 0
        #expect(AgentBadge(for: agent, onScreen: false) == .working)

        // What needs the person comes first, also on screen and whatever else is true.
        agent.unread = 5
        agent.open = 1
        #expect(AgentBadge(for: agent, onScreen: false) == .needsYou(open: 1))
        #expect(AgentBadge(for: agent, onScreen: true) == .needsYou(open: 1))
        agent.open = 0
        agent.state = .needsYou
        #expect(AgentBadge(for: agent, onScreen: false) == .needsYou(open: 0))
    }

    @Test func theMainAgentComesFirst() throws {
        var first = try agent(), second = try agent(), third = try agent()
        first.id = "a"; first.main = false
        second.id = "b"; second.main = true
        third.id = "c"; third.main = false
        #expect(AgentList.ordered([first, second, third]).map(\.id) == ["b", "a", "c"])
        #expect(AgentList.ordered([]).isEmpty)
    }

    @Test func theTimeOfARow() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: "Europe/Vienna"))
        let now = try #require(Timestamp.date(from: "2026-11-21T15:00:00.000Z"))
        func time(_ updatedAt: String, _ locale: String) -> String {
            AgentList.time(updatedAt, now: now, calendar: calendar, locale: Locale(identifier: locale))
        }
        // Today: the time, in the device's own way of writing it.
        #expect(time("2026-11-21T09:12:00.000Z", "de_AT") == "10:12")
        #expect(time("2026-11-21T09:12:00Z", "en_GB") == "10:12")
        #expect(time("2026-11-21T13:05:00.000Z", "en_US").hasPrefix("2:05"))
        // Yesterday evening in Vienna is another day, though the same day in UTC would not be.
        #expect(time("2026-11-20T22:30:00.000Z", "de_AT") == "20. Nov.")
        #expect(time("2026-11-20T23:30:00.000Z", "de_AT") == "00:30")
        #expect(time("2026-03-02T08:00:00.000Z", "en_GB") == "2 Mar")
        // Another year: the date with its year.
        #expect(time("2025-12-31T08:00:00.000Z", "de_AT") == "31.12.25")
        #expect(time("2025-12-31T08:00:00.000Z", "en_GB") == "31/12/25")
        #expect(time("", "en_GB") == "")
        #expect(time("soon", "en_GB") == "")
    }
}

/// How the chat and a document share the width.
@Suite struct PaneLayoutTests {
    @Test func tooNarrowForBoth() {
        #expect(PaneLayout.split(available: 0) == .over)
        #expect(PaneLayout.split(available: 744) == .over)
        #expect(PaneLayout.split(available: 751.5, chosenChat: 352) == .over)
        #expect(PaneLayout.split(available: 752) == .sideBySide(chat: 352, document: 400))
    }

    @Test func theAutomaticSplit() {
        // Just enough: the document keeps its least width, the chat gives.
        #expect(PaneLayout.split(available: 800) == .sideBySide(chat: 400, document: 400))
        // A wide-phone chat; the document takes the rest.
        #expect(PaneLayout.split(available: 832) == .sideBySide(chat: 432, document: 400))
        #expect(PaneLayout.split(available: 1056) == .sideBySide(chat: 432, document: 624))
        #expect(PaneLayout.split(available: 1200) == .sideBySide(chat: 432, document: 768))
        // Beyond a full document the chat grows.
        #expect(PaneLayout.split(available: 1376) == .sideBySide(chat: 608, document: 768))
    }

    @Test func thePersonsChoiceWithinLimits() {
        #expect(PaneLayout.split(available: 1056, chosenChat: 500) == .sideBySide(chat: 500, document: 556))
        // The chat no narrower than a phone, the document no narrower than its least width.
        #expect(PaneLayout.split(available: 1056, chosenChat: 100) == .sideBySide(chat: 352, document: 704))
        #expect(PaneLayout.split(available: 1056, chosenChat: 5000) == .sideBySide(chat: 656, document: 400))
        // A choice made in a wide window still fits a narrower one.
        #expect(PaneLayout.split(available: 800, chosenChat: 600) == .sideBySide(chat: 400, document: 400))
        for available in stride(from: CGFloat(752), through: 1600, by: 53) {
            for chosen in [nil, 0, 352, 432, 700, 2000] as [CGFloat?] {
                guard case .sideBySide(let chat, let document) = PaneLayout.split(available: available, chosenChat: chosen) else {
                    Issue.record("\(available) is wide enough for both")
                    continue
                }
                #expect(chat + document == available)
                #expect(chat >= PaneLayout.chatMin && document >= PaneLayout.documentMin)
            }
        }
    }

    @Test func theListStandsBesideTheChatInAWideWindow() {
        // Landscape: iPad mini, 11-inch, 13-inch.
        for width: CGFloat in [1133, 1210, 1376] { #expect(PaneLayout.listStandsBeside(window: width)) }
        // Portrait, and half of a wide screen.
        for width: CGFloat in [744, 834, 1032, 688] { #expect(!PaneLayout.listStandsBeside(window: width)) }
    }

    @Test func theListMakesRoomForADocument() {
        // iPad 11-inch in landscape: beside the list the chat and a document would be cramped.
        #expect(PaneLayout.listMakesRoom(window: 1210, detail: 890))
        // iPad 13-inch in landscape: all three fit.
        #expect(!PaneLayout.listMakesRoom(window: 1376, detail: 1056))
        // The list is closed or lies over the chat: it takes no room.
        #expect(!PaneLayout.listMakesRoom(window: 1210, detail: 1210))
        #expect(!PaneLayout.listMakesRoom(window: 834, detail: 834))
        // Too narrow even without the list: the document goes over the chat, the list may stay.
        #expect(!PaneLayout.listMakesRoom(window: 740, detail: 420))
    }
}

/// An agent looked at: its tasks with every kind of rule, its memory, and what it works with.
@Suite struct AgentDetailTests {
    private func decode<Value: Decodable>(_ type: Value.Type, _ json: String) throws -> Value {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    static let detail = """
    { "agent": { "id": "agt_1", "name": "Frida", "kind": "sprout", "about": "Helps with homework.", "origin": "own",
        "state": "working", "open": 0, "conversationId": "cnv_1", "main": false },
      "memory": "- Frida is in year 5.",
      "doing": { "what": "Reading the worksheets", "turn": 2, "turns": 8 },
      "tasks": [
        { "id": "t1", "title": "Reminder", "prompt": "Remind me.", "rule": { "at": "2026-11-22T08:00:00.000Z" },
          "nextAt": "2026-11-22T08:00:00.000Z", "quiet": false },
        { "id": "t2", "title": "Hourly look", "prompt": "Look.", "rule": { "every": "hour" }, "quiet": true },
        { "id": "t3", "title": "Morning look", "prompt": "Look.", "rule": { "every": "day", "time": "08:30" }, "quiet": false,
          "lastAt": "2026-11-21T08:30:00.000Z", "last": "answered" },
        { "id": "t4", "title": "Work days", "prompt": "Look.", "rule": { "every": "weekday", "time": "07:00" }, "quiet": false },
        { "id": "t5", "title": "Weekly plan", "prompt": "Plan.", "rule": { "every": "week", "time": "18:00", "weekday": 0 },
          "quiet": false, "paused": "It failed three times in a row.", "last": "failed" },
        { "id": "t6", "title": "New worksheets", "prompt": "Read them.", "rule": { "on": "folder", "folder": "frida", "path": "Mathe" },
          "quiet": false },
        { "id": "t7", "title": "School mail", "prompt": "Sort it.", "rule": { "on": "mail", "from": "school@example.org", "subject": "Homework" },
          "quiet": true },
        { "id": "t8", "title": "Any mail", "prompt": "Sort it.", "rule": { "on": "mail" }, "quiet": false },
        { "id": "t9", "title": "Form posted", "prompt": "Read it.", "rule": { "on": "webhook" }, "quiet": false },
        { "id": "t10", "title": "Calendar", "prompt": "Look.", "rule": { "on": "connection", "connection": "Calendar",
          "tool": "list_events", "minutes": 15 }, "quiet": false, "last": "note" },
        { "id": "t11", "title": "Later", "prompt": "Who knows.", "rule": { "on": "moon", "phase": "full" }, "quiet": false,
          "last": "skipped" }
      ] }
    """

    @Test func everyKindOfRule() throws {
        let detail = try decode(AgentDetail.self, Self.detail)
        #expect(detail.agent.name == "Frida")
        #expect(detail.memory == "- Frida is in year 5.")
        #expect(detail.doing == AgentDetail.Doing(what: "Reading the worksheets", turn: 2, turns: 8))
        #expect(detail.tasks.map(\.rule) == [
            .at("2026-11-22T08:00:00.000Z"),
            .hourly,
            .daily(time: "08:30"),
            .weekdays(time: "07:00"),
            .weekly(time: "18:00", weekday: 0),
            .folder(folder: "frida", path: "Mathe"),
            .mail(from: "school@example.org", subject: "Homework"),
            .mail(from: nil, subject: nil),
            .webhook,
            .connection(connection: "Calendar", tool: "list_events", minutes: 15),
            .unknown,
        ])
        #expect(detail.tasks.filter(\.rule.isEvent).count == 5)
        #expect(detail.tasks[1].quiet)
        #expect(detail.tasks[2].last == .answered)
        #expect(detail.tasks[4].paused == "It failed three times in a row.")
        #expect(detail.tasks[4].last == .failed)
        #expect(detail.tasks[9].last == .note)
        // A newer home's rule and outcome never break the task they belong to.
        #expect(detail.tasks[10].last == .unknown("skipped"))
    }

    @Test func aRuleGoesBackAsItCame() throws {
        let rules: [TaskRule] = [
            .at("t"), .hourly, .daily(time: "08:30"), .weekdays(time: "07:00"), .weekly(time: "18:00", weekday: 3),
            .folder(folder: "Trips", path: nil), .mail(from: nil, subject: "Invoice"), .webhook,
            .connection(connection: "GitHub", tool: "list_issues", minutes: 30),
        ]
        for rule in rules {
            #expect(try JSONDecoder().decode(TaskRule.self, from: JSONEncoder().encode(rule)) == rule)
        }
    }

    @Test func aSharedAgentWithoutWork() throws {
        let detail = try decode(AgentDetail.self, """
        { "agent": { "id": "agt_2", "name": "Anna's planner", "kind": "round", "about": "", "origin": "shared",
            "from": "anna@anna.example", "state": "idle", "open": 0, "conversationId": "cnv_2", "main": false },
          "memory": "", "tasks": [] }
        """)
        #expect(detail.doing == nil)
        #expect(detail.tasks.isEmpty)
        #expect(detail.agent.origin == .shared)
    }

    @Test func folders() throws {
        let folders = try decode(FoldersEnvelope.self, """
        { "folders": [
          { "id": "fld_1", "name": "ausgaben", "path": "/Users/ada/ausgaben", "access": "read", "createdAt": "2026-11-20T10:00:00.000Z" },
          { "id": "fld_2", "name": "frida", "path": "/Users/ada/frida", "access": "write", "createdAt": "2026-11-21T10:00:00.000Z" },
          { "id": "fld_3", "name": "later", "path": "/Users/ada/later", "access": "append", "createdAt": "t" }
        ] }
        """).folders
        #expect(folders.map(\.name) == ["ausgaben", "frida", "later"])
        #expect(folders.map(\.access) == [.read, .write, .unknown("append")])
        let preview = try decode(FolderPreview.self, #"{ "path": "/Users/ada/Trips", "name": "Trips", "files": 120, "folders": 8, "bytes": 4200000, "more": false }"#)
        #expect(preview.files == 120)
        #expect(preview.folders == 8)
        let listing = try decode(FolderListing.self, #"{ "path": "/Users/ada", "parent": null, "home": "/Users/ada", "folders": [ { "name": "Trips", "path": "/Users/ada/Trips" } ] }"#)
        #expect(listing.folders.first?.path == "/Users/ada/Trips")
        #expect(listing.home == "/Users/ada")
        let made = try JSONSerialization.jsonObject(with: JSONEncoder().encode(
            MakeFolder(parent: "/Users/ada", name: "Gesetze")
        )) as? [String: String]
        #expect(made == ["parent": "/Users/ada", "name": "Gesetze"])
        let field = try decode(CardField.self, #"{ "id": "folder", "label": "Ordner", "type": "folder", "required": true, "value": "/Users/ada/Trips" }"#)
        #expect(field.type == .folder)
        #expect(field.value == .text("/Users/ada/Trips"))
        let sent = try JSONSerialization.jsonObject(with: JSONEncoder().encode(
            ConnectFolder(path: "/Users/ada/Trips", access: .write, conversationId: "cnv_1")
        )) as? [String: String]
        #expect(sent == ["path": "/Users/ada/Trips", "access": "write", "conversationId": "cnv_1"])
    }

    @Test func filesSentInAChat() throws {
        let files = try decode(FilesEnvelope.self, """
        { "files": [
          { "id": "fil_1", "name": "IMG_0042.HEIC", "mime": "image/heic", "size": 2480000 },
          { "id": "fil_2", "name": "Noten.xlsx", "mime": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "size": 18000 },
          { "id": "fil_3", "name": "Arbeitsblatt.pdf", "mime": "application/pdf", "size": 320000 },
          { "id": "fil_4", "name": "Referat.docx", "mime": "application/zip", "size": 52000 },
          { "id": "fil_5", "name": "Clip.mov", "mime": "video/quicktime", "size": 9000000 },
          { "id": "fil_6", "name": "Vokabeln.m4a", "mime": "audio/mp4", "size": 800000 },
          { "id": "fil_7", "name": "archive.bin", "mime": "application/octet-stream", "size": 10 }
        ] }
        """).files
        #expect(files.count == 7)
        #expect(files.first?.size == 2_480_000)
        #expect(files.map(FileSymbol.name(for:)) == ["photo", "tablecells", "doc.text", "doc.text", "film", "music.note", "doc"])
    }
}
