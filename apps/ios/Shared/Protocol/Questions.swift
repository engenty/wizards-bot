import Foundation

// A question of an agent is its own message: what the person writes in the chat answers it. A
// decision brings its choices as buttons, several things at once a form. The web app's
// `lib/questions.ts` follows the same rules.

nonisolated extension Card {
    /// The fields of a question that is a form.
    var form: [CardField]? { reply == nil ? nil : fields }

    /// A question whose one answer is the next message.
    var isFree: Bool { reply != nil && fields == nil && actions.isEmpty }

    /// The `action` of an answer that is a message of the person.
    static let replyAction = "reply"
}

nonisolated enum Questions {
    /// What the person picked for their next message: a question, or none of them.
    nonisolated struct Picked: Equatable, Sendable {
        var cardId: String?
        /// The newest question when they picked: a newer one counts again by itself.
        var newest: String
    }

    /// The questions that wait in one chat, oldest first.
    static func waiting(in items: [Card], conversationId: String) -> [Card] {
        items.filter { $0.reply != nil && $0.conversationId == conversationId }
    }

    /// The question the next message answers: the one the person picked, else the newest. While
    /// the agent works on something else, its earlier question is answered only when it was picked.
    static func target(_ questions: [Card], picked: Picked?, working: Bool, lastMessageId: String?) -> Card? {
        guard let newest = questions.last else { return nil }
        if let picked, picked.newest == newest.id {
            guard let cardId = picked.cardId else { return nil }
            if let chosen = questions.first(where: { $0.id == cardId }) { return chosen }
        }
        return working && lastMessageId != newest.messageId ? nil : newest
    }

    /// What a message says it answers: nothing to say where no question waits.
    static func answers(_ questions: [Card], target: Card?) -> Answers? {
        if let target { return .card(target.id) }
        return questions.isEmpty ? nil : Answers.none
    }
}

/// What the person filled into a form, and what of it the home gets.
nonisolated struct FormInput: Equatable, Sendable {
    /// A text, a number as it was typed, a date as "2026-12-31", or "unsure".
    var texts: [String: String] = [:]
    var choices: [String: Set<String>] = [:]
    /// The ids of the files the home has for a field.
    var files: [String: [String]] = [:]

    /// The value of a field where the person says they don't know.
    static let unsure = "unsure"

    func values(_ fields: [CardField]) -> [String: FieldValue] {
        var values: [String: FieldValue] = [:]
        for field in fields {
            if let value = value(of: field) { values[field.id] = value }
        }
        return values
    }

    /// The fields that still need an answer. "I don't know" is one.
    func missing(_ fields: [CardField]) -> Set<String> {
        Set(fields.filter { $0.required == true && value(of: $0) == nil }.map(\.id))
    }

    private func value(of field: CardField) -> FieldValue? {
        let typed = (texts[field.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        switch field.type {
        case .multi:
            // In the order the form lists them.
            let picked = (field.options ?? []).map(\.id).filter((choices[field.id] ?? []).contains)
            return picked.isEmpty ? nil : .many(picked)
        case .choice:
            return choices[field.id]?.first.map(FieldValue.text)
        case .file where typed != Self.unsure:
            return (files[field.id] ?? []).isEmpty ? nil : .many(files[field.id] ?? [])
        default:
            return typed.isEmpty ? nil : .text(typed)
        }
    }
}

nonisolated extension CardField {
    /// This field's answer as words, once the form is sent; nil where it stayed empty.
    func answerText(_ value: FieldValue?, locale: Locale = .current) -> String? {
        let list: [String] = switch value {
        case .text(let text)?: text.isEmpty ? [] : [text]
        case .many(let many)?: many
        case nil: []
        }
        guard let first = list.first else { return nil }
        if let options {
            return list.map { id in options.first { $0.id == id }?.label ?? id }.joined(separator: ", ")
        }
        if first == FormInput.unsure, let unsure { return unsure }
        switch type {
        case .file:
            return String(localized: "\(list.count) files")
        case .date:
            guard let date = FormDate.date(from: first) else { return first }
            return date.formatted(Date.FormatStyle(date: .long, time: .omitted, locale: locale, timeZone: .gmt))
        default:
            return unit.map { "\(first) \($0)" } ?? first
        }
    }
}

/// A day of a form, as the home reads it: "2026-12-31".
nonisolated enum FormDate {
    static func date(from text: String) -> Date? {
        try? Date(text, strategy: style)
    }

    static func text(from date: Date) -> String {
        date.formatted(style)
    }

    private static var style: Date.ISO8601FormatStyle {
        Date.ISO8601FormatStyle(timeZone: .gmt).year().month().day()
    }
}
