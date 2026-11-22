import Testing

@Suite struct SentenceSplitterTests {
    @Test func cutsAtTheEndOfASentence() {
        #expect(SentenceSplitter.sentences(in: "You are free after 14:00. Shall I book it? Yes! Done…")
            == ["You are free after 14:00.", "Shall I book it?", "Yes!", "Done…"])
    }

    @Test func waitsUntilASentenceIsCertainlyOver() {
        var splitter = SentenceSplitter()
        #expect(splitter.feed("You are fr").isEmpty)
        #expect(splitter.feed("ee after 14:00.").isEmpty)
        // The stop alone is not enough: "14:00.5" or "example.com" could follow.
        #expect(splitter.feed(" ").isEmpty)
        #expect(splitter.feed("Shall I") == ["You are free after 14:00."])
        #expect(splitter.feed(" book it?").isEmpty)
        #expect(splitter.finish() == "Shall I book it?")
        #expect(splitter.finish() == nil)
    }

    @Test func theSameTextCutsTheSameWayHoweverItArrives() {
        let text = "Dr. Meier kommt am 3. Mai um ca. 15.30 Uhr, z. B. mit J. S. Bach im Ohr. Das war 1989. Dann kam Version 2.5 von example.com heraus! Gut?\n\n- Erstens\n- Zweitens"
        let whole = SentenceSplitter.sentences(in: text)
        #expect(whole == [
            "Dr. Meier kommt am 3. Mai um ca. 15.30 Uhr, z. B. mit J. S. Bach im Ohr.",
            "Das war 1989.",
            "Dann kam Version 2.5 von example.com heraus!",
            "Gut?",
            "Erstens",
            "Zweitens",
        ])
        for size in [1, 2, 3, 7, 16] {
            var splitter = SentenceSplitter()
            var pieces: [String] = []
            var rest = Substring(text)
            while !rest.isEmpty {
                pieces += splitter.feed(String(rest.prefix(size)))
                rest = rest.dropFirst(size)
            }
            if let last = splitter.finish() { pieces.append(last) }
            #expect(pieces == whole, "in pieces of \(size)")
        }
    }

    @Test func abbreviationsInitialsAndNumbersDoNotEndASentence() {
        #expect(SentenceSplitter.sentences(in: "It costs approx. 3.50 euros, e.g. at Mr. Smith's shop. Fine.")
            == ["It costs approx. 3.50 euros, e.g. at Mr. Smith's shop.", "Fine."])
        #expect(SentenceSplitter.sentences(in: "Am 21. November ist es so weit. Bis dann.")
            == ["Am 21. November ist es so weit.", "Bis dann."])
        #expect(SentenceSplitter.sentences(in: "The meeting is at St. Mary's vs. the usual place.") == ["The meeting is at St. Mary's vs. the usual place."])
    }

    @Test func aLineIsASentence() {
        #expect(SentenceSplitter.sentences(in: "## Today\nTwo things\n\n1. Buy milk\n2. Call Anna")
            == ["Today", "Two things", "1: Buy milk", "2: Call Anna"])
    }

    @Test func quotesAndBracketsStayWithTheirSentence() {
        #expect(SentenceSplitter.sentences(in: "She said “Come at five.” Then she left (really!). OK.")
            == ["She said “Come at five.”", "Then she left (really!).", "OK."])
    }

    @Test func aVoiceGetsNoMarkdown() {
        #expect(SentenceSplitter.sentences(in: "**Done.** See [the plan](https://example.com/plan) and `notes.md`.")
            == ["Done.", "See the plan and notes.md."])
        #expect(SpokenText.plain("> *Quiet* and _calm_, with snake_case kept") == "Quiet and calm, with snake_case kept")
        #expect(SpokenText.plain("- [x] Milk") == "Milk")
        // Marks alone say nothing.
        #expect(SentenceSplitter.sentences(in: "---\n\n***\n").isEmpty)
        #expect(SentenceSplitter.sentences(in: "   \n").isEmpty)
    }

    @Test func theVoiceIsNotThePerson() {
        let said = ["You are free after 14:00.", "Shall I book it?"]
        #expect(Echo.isEcho("you are free after", of: said))
        #expect(Echo.isEcho("Shall I book it", of: said))
        #expect(Echo.isEcho("", of: said))
        #expect(!Echo.isEcho("no wait", of: said))
        #expect(!Echo.isEcho("book it for Thursday instead", of: said))
        #expect(!Echo.isEcho("hello", of: []))
    }
}

@Suite struct MarkdownTests {
    @Test func blocks() {
        let blocks = MarkdownBlock.parse("""
        # Week plan
        Two things
        today.

        - Buy milk
          - Oat
        1. Call Anna
        - [x] Done
        > Quoted
        ---
        ```swift
        let a = 1
        ```
        | Day | Time |
        |-----|------|
        | Thu | 15:00 |
        """)
        #expect(blocks == [
            .heading(level: 1, text: "Week plan"),
            .paragraph("Two things\ntoday."),
            .item(mark: "•", depth: 0, text: "Buy milk"),
            .item(mark: "•", depth: 1, text: "Oat"),
            .item(mark: "1.", depth: 0, text: "Call Anna"),
            .item(mark: "☑", depth: 0, text: "Done"),
            .quote("Quoted"),
            .rule,
            .code("let a = 1"),
            .paragraph("Day · Time\nThu · 15:00"),
        ])
    }

    @Test func aReplyThatIsStillBeingWritten() {
        #expect(MarkdownBlock.parse("Here:\n```\nlet a") == [.paragraph("Here:"), .code("let a")])
        #expect(MarkdownBlock.parse("").isEmpty)
        #expect(MarkdownBlock.parse("#hashtag") == [.paragraph("#hashtag")])
    }
}
