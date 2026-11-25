import Foundation
import Testing

struct QuestionsTests {
    private func card(_ id: String, reply: Bool = true, extra: String = "", conversation: String = "c1") throws -> Card {
        let json = """
        { "id": "\(id)", "kind": "question", "level": "needs_you", "state": "open", "title": "Wie hoch?",
          \(reply ? #""reply": { "placeholder": "Höhe" },"# : "") "actions": [] \(extra),
          "agentId": "a", "conversationId": "\(conversation)", "messageId": "m_\(id)", "createdAt": "t" }
        """
        return try JSONDecoder().decode(Card.self, from: Data(json.utf8))
    }

    private let form = #"""
    , "fields": [
      { "id": "p1", "label": "Höhe", "type": "number", "unit": "m", "required": true },
      { "id": "p2", "label": "Abstand", "type": "number", "unit": "m", "unsure": "Weiß ich nicht", "required": true },
      { "id": "p3", "label": "Material", "type": "multi", "required": false,
        "options": [{ "id": "o1", "label": "Holz" }, { "id": "o2", "label": "Stein" }] },
      { "id": "p4", "label": "Beginn", "type": "date" },
      { "id": "p5", "label": "Plan", "type": "file" },
      { "id": "p6", "label": "Mehr", "type": "long_text" }
    ]
    """#

    @Test func aQuestionIsFreeOrAForm() throws {
        let free = try card("a")
        #expect(free.isFree)
        #expect(free.reply?.placeholder == "Höhe")
        #expect(free.form == nil)
        let form = try card("f", extra: form)
        #expect(!form.isFree)
        #expect(form.form?.map(\.type) == [.number, .number, .multi, .date, .file, .longText])
        // An approval is no question, whatever fields it has.
        #expect(try card("y", reply: false, extra: self.form).form == nil)
    }

    @Test func theNextMessageAnswersTheNewestOrThePickedQuestion() throws {
        let a = try card("a"), b = try card("b")
        func target(_ questions: [Card], _ picked: Questions.Picked? = nil, working: Bool = false, last: String? = nil) -> String? {
            Questions.target(questions, picked: picked, working: working, lastMessageId: last)?.id
        }
        #expect(target([a, b]) == "b")
        #expect(target([a, b], .init(cardId: "a", newest: "b")) == "a")
        #expect(target([]) == nil)
        // Something else, until a newer question comes.
        #expect(target([a], .init(cardId: nil, newest: "a")) == nil)
        #expect(target([a, b], .init(cardId: nil, newest: "a")) == "b")
        // The picked one was answered meanwhile.
        #expect(target([b], .init(cardId: "a", newest: "b")) == "b")
        // While the agent works on something else, only a picked one.
        #expect(target([a], working: true, last: "m_x") == nil)
        #expect(target([a], .init(cardId: "a", newest: "a"), working: true, last: "m_x") == "a")
        #expect(target([a], working: true, last: "m_a") == "a")
    }

    @Test func onlyQuestionsOfTheChatCount() throws {
        let items = [try card("a"), try card("o", conversation: "c2"), try card("y", reply: false)]
        #expect(Questions.waiting(in: items, conversationId: "c1").map(\.id) == ["a"])
    }

    @Test func aMessageNamesItsQuestionOrNone() throws {
        func sent(_ answers: Answers?) throws -> String {
            let encoder = JSONEncoder()
            encoder.outputFormatting = .sortedKeys
            return String(decoding: try encoder.encode(SendMessage(text: "2,4 m", answers: answers)), as: UTF8.self)
        }
        let a = try card("a")
        #expect(try sent(Questions.answers([a], target: a)) == #"{"answers":"a","text":"2,4 m"}"#)
        #expect(try sent(Questions.answers([a], target: nil)) == #"{"answers":null,"text":"2,4 m"}"#)
        #expect(try sent(Questions.answers([], target: nil)) == #"{"text":"2,4 m"}"#)
    }

    @Test func aFormMissesWhatIsRequiredAndSendsWhatIsThere() throws {
        let fields = try #require(try card("f", extra: form).form)
        var input = FormInput()
        #expect(input.missing(fields) == ["p1", "p2"])
        input.texts = ["p1": " 2,4 ", "p2": FormInput.unsure, "p4": "2026-12-31", "p6": " "]
        input.choices = ["p3": ["o2", "o1"]]
        input.files = ["p5": ["fil_1"]]
        #expect(input.missing(fields).isEmpty)
        #expect(input.values(fields) == [
            "p1": .text("2,4"), "p2": .text("unsure"), "p3": .many(["o1", "o2"]),
            "p4": .text("2026-12-31"), "p5": .many(["fil_1"]),
        ])
    }

    @Test func aSentFormShowsItsAnswersAsWords() throws {
        let fields = try #require(try card("f", extra: form).form)
        let german = Locale(identifier: "de_AT")
        #expect(fields[0].answerText(.text("2,4")) == "2,4 m")
        #expect(fields[1].answerText(.text("unsure")) == "Weiß ich nicht")
        #expect(fields[2].answerText(.many(["o1", "o2"])) == "Holz, Stein")
        #expect(fields[3].answerText(.text("2026-12-31"), locale: german) == "31. Dezember 2026")
        #expect(fields[0].answerText(nil) == nil)
    }

    @Test func aDayIsTheSameInEveryTimeZone() throws {
        let day = try #require(FormDate.date(from: "2026-12-31"))
        #expect(FormDate.text(from: day) == "2026-12-31")
        #expect(FormDate.date(from: "morgen") == nil)
    }

    @Test func aVoiceReadsTheQuestionAfterTheText() throws {
        let question = try card("a", extra: #", "body": "In Metern.""#)
        let message = Message(
            id: "m", conversationId: "c1", role: .agent, agentId: "a", channel: .app,
            parts: [.text("Ich sehe mir das an."), .card(question)], state: .done, model: nil, createdAt: "t"
        )
        #expect(message.asked == "Wie hoch?\n\nIn Metern.")
        #expect(message.spoken == "Ich sehe mir das an.\n\nWie hoch?\n\nIn Metern.")
    }
}
