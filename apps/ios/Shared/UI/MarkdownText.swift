import SwiftUI

/// The blocks of a Markdown text, enough for what an agent writes in a chat or a document.
nonisolated enum MarkdownBlock: Equatable, Sendable {
    case heading(level: Int, text: String)
    case paragraph(String)
    /// One list item: its mark ("•", "1.", "☐", "☑") and how deep it is nested.
    case item(mark: String, depth: Int, text: String)
    case code(String)
    case quote(String)
    case rule

    static func parse(_ markdown: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        var code: [String]?
        var quote: [String] = []

        func flush() {
            if !paragraph.isEmpty {
                blocks.append(.paragraph(paragraph.joined(separator: "\n")))
                paragraph = []
            }
            if !quote.isEmpty {
                blocks.append(.quote(quote.joined(separator: "\n")))
                quote = []
            }
        }

        for line in markdown.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline).map(String.init) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if code != nil {
                if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                    blocks.append(.code(code!.joined(separator: "\n")))
                    code = nil
                } else {
                    code!.append(line)
                }
                continue
            }
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                flush()
                code = []
            } else if trimmed.isEmpty {
                flush()
            } else if let heading = heading(trimmed) {
                flush()
                blocks.append(heading)
            } else if trimmed.count >= 3, Set(trimmed.filter { !$0.isWhitespace }).isSubset(of: ["-"]) || Set(trimmed).isSubset(of: ["*"])
                        || Set(trimmed).isSubset(of: ["_"]) {
                flush()
                blocks.append(.rule)
            } else if trimmed.hasPrefix(">") {
                if !paragraph.isEmpty { flush() }
                quote.append(String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces))
            } else if let item = item(line) {
                flush()
                blocks.append(item)
            } else if trimmed.hasPrefix("|"), trimmed.hasSuffix("|") {
                // A table row reads as a line of its cells; the row of dashes under the header is left out.
                let cells = trimmed.dropFirst().dropLast().split(separator: "|", omittingEmptySubsequences: false)
                    .map { $0.trimmingCharacters(in: .whitespaces) }
                if !cells.allSatisfy({ !$0.isEmpty && $0.allSatisfy { "-: ".contains($0) } }) {
                    if !quote.isEmpty { flush() }
                    paragraph.append(cells.joined(separator: " · "))
                }
            } else {
                if !quote.isEmpty { flush() }
                paragraph.append(trimmed)
            }
        }
        // A reply that is still being written may end inside a code block.
        if let code { blocks.append(.code(code.joined(separator: "\n"))) }
        flush()
        return blocks
    }

    private static func heading(_ line: String) -> MarkdownBlock? {
        let marks = line.prefix { $0 == "#" }
        guard (1 ... 6).contains(marks.count), line.dropFirst(marks.count).first == " " else { return nil }
        var text = line.dropFirst(marks.count).trimmingCharacters(in: .whitespaces)
        while text.hasSuffix("#") { text.removeLast() }
        return .heading(level: marks.count, text: text.trimmingCharacters(in: .whitespaces))
    }

    private static func item(_ line: String) -> MarkdownBlock? {
        let indent = line.prefix { $0 == " " || $0 == "\t" }.reduce(0) { $0 + ($1 == "\t" ? 4 : 1) }
        let rest = line.drop { $0 == " " || $0 == "\t" }
        let depth = min(4, indent / 2)
        if let first = rest.first, "-*+".contains(first), rest.dropFirst().first == " " {
            let text = rest.dropFirst(2).trimmingCharacters(in: .whitespaces)
            if text.hasPrefix("[ ] ") { return .item(mark: "☐", depth: depth, text: String(text.dropFirst(4))) }
            if text.lowercased().hasPrefix("[x] ") { return .item(mark: "☑", depth: depth, text: String(text.dropFirst(4))) }
            return .item(mark: "•", depth: depth, text: text)
        }
        let digits = rest.prefix { $0.isNumber }
        let after = rest.dropFirst(digits.count)
        if (1 ... 3).contains(digits.count), let stop = after.first, ".)".contains(stop), after.dropFirst().first == " " {
            return .item(mark: "\(digits).", depth: depth, text: after.dropFirst(2).trimmingCharacters(in: .whitespaces))
        }
        return nil
    }
}

/// Markdown as text: headings, paragraphs, lists, quotes and code, in the type sizes of the system.
struct MarkdownText: View {
    let blocks: [MarkdownBlock]

    init(_ markdown: String) {
        blocks = MarkdownBlock.parse(markdown)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                view(for: block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func view(for block: MarkdownBlock) -> some View {
        switch block {
        case .heading(let level, let text):
            Text(Self.inline(text))
                .font(level == 1 ? .title2.weight(.semibold) : level == 2 ? .title3.weight(.semibold) : .headline)
                .padding(.top, 4)
                .accessibilityAddTraits(.isHeader)
        case .paragraph(let text):
            Text(Self.inline(text))
        case .item(let mark, let depth, let text):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(mark)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                Text(Self.inline(text))
            }
            .padding(.leading, CGFloat(depth) * 16)
            .padding(.vertical, -3)
        case .code(let text):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text)
                    .font(.callout.monospaced())
                    .padding(12)
            }
            .background(.quaternary.opacity(0.5), in: .rect(cornerRadius: 10))
        case .quote(let text):
            Text(Self.inline(text))
                .foregroundStyle(.secondary)
                .padding(.leading, 12)
                .overlay(alignment: .leading) {
                    Capsule().fill(.tertiary).frame(width: 3)
                }
        case .rule:
            Divider()
        }
    }

    /// Bold, italic, code and links inside a block.
    static func inline(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible
        )
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }
}
