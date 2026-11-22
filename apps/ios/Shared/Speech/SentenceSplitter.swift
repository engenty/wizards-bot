import Foundation

/// Cuts a reply into sentences while it is still being written, so a voice can start with the first
/// one. Feed it the text as it grows; it gives back each sentence once it is certainly complete.
nonisolated struct SentenceSplitter: Sendable {
    private var pending = ""

    /// Adds text and returns the sentences it completed.
    mutating func feed(_ text: String) -> [String] {
        pending += text
        var sentences: [String] = []
        while let end = Self.firstBoundary(in: pending) {
            let sentence = String(pending[..<end])
            pending = String(pending[end...])
            if let clean = Self.clean(sentence) { sentences.append(clean) }
        }
        return sentences
    }

    /// The rest, when the reply is complete.
    mutating func finish() -> String? {
        defer { pending = "" }
        return Self.clean(pending)
    }

    /// All sentences of a complete text.
    static func sentences(in text: String) -> [String] {
        var splitter = SentenceSplitter()
        var sentences = splitter.feed(text)
        if let rest = splitter.finish() { sentences.append(rest) }
        return sentences
    }

    /// The index after the first sentence that is certainly over, with the space that follows it.
    private static func firstBoundary(in text: String) -> String.Index? {
        var index = text.startIndex
        while index < text.endIndex {
            let character = text[index]
            let next = text.index(after: index)
            if character.isNewline {
                // A line ends a sentence: a list item or a heading has no full stop.
                if !text[..<index].allSatisfy(\.isWhitespace) { return next }
            } else if ".!?…".contains(character) {
                // Closing quotes and brackets belong to the sentence.
                var end = next
                while end < text.endIndex, "\"'”“’»«)]*_".contains(text[end]) || ".!?…".contains(text[end]) {
                    end = text.index(after: end)
                }
                // The text may go on with "5" after "3." or "com" after "example.": wait for what follows.
                guard end < text.endIndex else { return nil }
                if text[end].isWhitespace, character != "." || endsSentence(text, stop: index, after: end) {
                    return text.index(after: end)
                }
                index = end
                continue
            }
            index = next
        }
        return nil
    }

    /// True when the full stop at `stop` ends a sentence rather than an abbreviation, an initial or an ordinal.
    private static func endsSentence(_ text: String, stop: String.Index, after: String.Index) -> Bool {
        let before = text[..<stop]
        let word = String(before.reversed().prefix { !$0.isWhitespace }.reversed()).lowercased()
        let bare = word.trimmingCharacters(in: CharacterSet(charactersIn: "(\"'„“*_"))
        if abbreviations.contains(bare) { return false }
        // An initial: "J. S. Bach".
        if bare.count == 1, bare.first?.isLetter == true { return false }
        // "e.g.", "z.B.", "u.a.": letters with stops between them.
        if bare.contains("."), bare.split(separator: ".").allSatisfy({ $0.count == 1 }) { return false }

        // What follows decides, so wait for it: the same text cuts the same way however it arrives.
        guard let following = text[after...].first(where: { !$0.isWhitespace }) else { return false }
        if !bare.isEmpty, bare.allSatisfy(\.isNumber) {
            // "am 3. Mai", "1. Buy milk" go on; "in 1989. Then" ends: a year is no ordinal.
            if bare.count <= 2 { return false }
            return following.isUppercase || !following.isLetter
        }
        // A sentence goes on in lower case after an abbreviation this list does not know.
        return !following.isLowercase
    }

    private static let abbreviations: Set<String> = [
        "mr", "mrs", "ms", "dr", "prof", "st", "vs", "etc", "no", "nr", "ca", "approx", "inc", "ltd", "jr", "sr",
        "bzw", "usw", "ggf", "evtl", "inkl", "exkl", "zzgl", "vgl", "bspw", "sog", "tel", "str", "mio", "mrd", "min",
        "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "okt", "nov", "dec", "dez",
    ]

    private static func clean(_ sentence: String) -> String? {
        let plain = SpokenText.plain(sentence)
        return plain.contains { $0.isLetter || $0.isNumber } ? plain : nil
    }
}

/// What a voice reads instead of what the screen shows: Markdown without its marks.
nonisolated enum SpokenText {
    static func plain(_ markdown: String) -> String {
        var text = markdown
        // [label](address) → label
        text = text.replacing(/!?\[([^\]]*)\]\([^)]*\)/) { String($0.output.1) }
        // Headings, quotes and list marks at the start of a line.
        text = text.replacing(/(?m)^\s{0,3}(#{1,6}|>|[-*+]|\d{1,2}[.)])\s+(\[[ xX]\]\s+)?/) { match in
            let mark = match.output.1
            // A numbered step keeps its number: "1. Buy milk" reads "1: Buy milk".
            return mark.first?.isNumber == true ? "\(mark.dropLast()): " : ""
        }
        for mark in ["**", "__", "~~", "`", "*"] { text = text.replacingOccurrences(of: mark, with: "") }
        // Underscores that wrap a word; "snake_case" keeps its own.
        text = text.replacing(/(^|\s)_([^_]+)_(?=\s|[.,!?]|$)/) { "\($0.output.1)\($0.output.2)" }
        return text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }
}
