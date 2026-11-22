import SwiftUI

/// One message, its parts in order.
struct MessageView: View {
    @Environment(AppModel.self) private var model
    let message: Message

    var body: some View {
        switch message.role {
        case .you:
            mine
        case .note:
            Text(MarkdownText.inline(message.text))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 24)
        default:
            theirs
        }
    }

    /// What the person said: a quiet bubble on the right, the files above it.
    private var mine: some View {
        VStack(alignment: .trailing, spacing: 4) {
            if !message.files.isEmpty {
                MessageFiles(files: message.files, mine: true)
            }
            if !message.text.isEmpty {
                Text(message.text)
                    .textSelection(.enabled)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(.fill.tertiary, in: .rect(cornerRadius: 20))
            }
            if message.state == .failed {
                Button {
                    model.retry(message)
                } label: {
                    QuietLine(symbol: "arrow.clockwise", text: Text("Not sent. Send again"))
                }
                .buttonStyle(.plain)
            } else if model.isWaiting(message) {
                QuietLine(symbol: "clock", text: Text("waits for your home"))
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 48)
    }

    /// What the agent said: type on the page, no bubble.
    private var theirs: some View {
        let firstFile = message.parts.firstIndex(where: \.isFile)
        return VStack(alignment: .leading, spacing: 12) {
            if let from = message.from {
                WriterLine(from: from)
            }
            ForEach(Array(message.parts.enumerated()), id: \.offset) { index, part in
                // The files of a message stand together, where the first one is.
                if part.isFile {
                    if index == firstFile { MessageFiles(files: message.files, mine: false) }
                } else {
                    PartView(part: part)
                }
            }
            // While the answer is open and no tool line turns, the dots say the agent is still at it.
            if message.state == .streaming, !message.parts.contains(where: \.isRunning) {
                WritingDots()
            }
            if message.state == .streaming, let start = Timestamp.date(from: message.createdAt) {
                ElapsedLine(since: start)
            }
            if message.state == .failed {
                QuietLine(symbol: "exclamationmark.circle", text: Text("This reply stopped."))
            }
            if model.isOnDevice(message), message.state != .streaming {
                QuietLine(symbol: "iphone", text: Text("on this device"))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// In a room: who wrote a message. An agent stands with its figure and whose it is, a person
/// with the first letter of their name.
private struct WriterLine: View {
    let from: Writer

    var body: some View {
        HStack(spacing: 8) {
            if let kind = from.kind {
                EngentyFigure(kind: kind)
                    .frame(width: 24, height: 24)
            } else {
                Text(from.name.prefix(1).uppercased())
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 24, height: 24)
                    .background(.fill.tertiary, in: .circle)
            }
            Text(from.name)
                .font(.footnote.weight(.semibold))
            if let of = from.of {
                Text(verbatim: "· \(of)")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
        .padding(.bottom, -6)
    }
}

/// What stands for an entry of the list: an agent's figure, or the mark of a room.
struct EntryFigure: View {
    let agent: Agent

    var body: some View {
        if agent.origin == .room {
            Image(systemName: "person.2.fill")
                .resizable()
                .scaledToFit()
                .foregroundStyle(.secondary)
                .padding(9)
                .background(.fill.tertiary, in: .circle)
                .accessibilityHidden(true)
        } else {
            EngentyFigure(kind: agent.kind, lively: agent.state == .working)
        }
    }
}

extension Part {
    /// A tool line that is still turning.
    var isRunning: Bool {
        if case .activity(_, .running) = self { true } else { false }
    }

    var isText: Bool {
        if case .text = self { true } else { false }
    }

    var isFile: Bool {
        if case .file = self { true } else { false }
    }
}

private struct PartView: View {
    @Environment(AppModel.self) private var model
    let part: Part

    var body: some View {
        switch part {
        case .text(let text):
            if !text.isEmpty {
                MarkdownText(text)
                    .textSelection(.enabled)
            }
        case .card(let card):
            CardView(card: card)
        case .document(let id, let title):
            Button {
                model.openDocument(id: id, title: title)
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "doc.text")
                        .font(.title3)
                        .foregroundStyle(.tint)
                    Text(title)
                        .font(.callout.weight(.medium))
                        .foregroundStyle(.primary)
                        .multilineTextAlignment(.leading)
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
                .padding(14)
                .background(.fill.quaternary, in: .rect(cornerRadius: 16))
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens the document")
        case .artifact(let id, let title):
            Button {
                model.openArtifact(id: id, title: title)
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "square.on.circle")
                        .font(.title3)
                        .foregroundStyle(.tint)
                    Text(title)
                        .font(.callout.weight(.medium))
                        .foregroundStyle(.primary)
                        .multilineTextAlignment(.leading)
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
                .padding(14)
                .background(.fill.quaternary, in: .rect(cornerRadius: 16))
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens the page")
        case .file(let file):
            MessageFiles(files: [file], mine: false)
        case .activity(let label, let state):
            HStack(spacing: 8) {
                switch state {
                case .running:
                    ProgressView().controlSize(.mini)
                case .failed:
                    Image(systemName: "exclamationmark.circle")
                default:
                    Image(systemName: "checkmark")
                }
                Text(label)
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            .accessibilityElement(children: .combine)
        case .unknown(_, let title):
            // A part this version does not know is drawn as its title, or left out.
            if let title, !title.isEmpty {
                Text(title)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// The seconds since the agent started an answer, once it takes a while: "12 s", "1:05".
/// Only this line redraws each second.
private struct ElapsedLine: View {
    let since: Date

    var body: some View {
        TimelineView(.periodic(from: since, by: 1)) { context in
            if let label = Elapsed.label(seconds: Int(context.date.timeIntervalSince(since))) {
                Text(verbatim: label)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .accessibilityLabel(Text("Working for \(label)"))
            }
        }
    }
}

/// Three dots while the agent has not written a word yet.
private struct WritingDots: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Image(systemName: "ellipsis")
            .font(.title3)
            .foregroundStyle(.secondary)
            .symbolEffect(.variableColor.iterative, isActive: !reduceMotion)
            .accessibilityLabel("Writing")
    }
}
