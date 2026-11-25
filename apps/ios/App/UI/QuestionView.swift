import SwiftUI

extension EnvironmentValues {
    /// True in a chat, where the input below answers a question. Elsewhere a question brings a field of its own.
    @Entry var answersInChat = false
}

/// A form that is being filled in, kept while its question waits: closed and opened again, in the
/// chat and in the list of what needs the person, it is the same.
@Observable
final class FormDraft {
    var input = FormInput()
    private(set) var attachments: [String: Attachments] = [:]

    init(fields: [CardField]) {
        for field in fields where field.type == .file { attachments[field.id] = Attachments() }
    }

    var isUploading: Bool { attachments.values.contains(where: \.isUploading) }

    /// What is filled in, with the files the home has by now.
    func filled() -> FormInput {
        var filled = input
        for (id, files) in attachments { filled.files[id] = files.refs.map(\.id) }
        return filled
    }
}

/// A question of an agent, as its own message: what is written in the chat answers it. A decision
/// has its choices as buttons, several things at once are a form. In a chat the form opens over
/// it: the chat keeps to its end, a form is read from its start.
struct QuestionView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.answersInChat) private var inChat
    let card: Card

    @State private var fillsIn = false
    @State private var words = ""
    @State private var working: String?
    @State private var problem: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            MarkdownText(card.title)
                .fontWeight(.medium)
                .textSelection(.enabled)
            if let body = card.body, !body.isEmpty {
                MarkdownText(body)
                    .textSelection(.enabled)
            }
            if card.state == .open { open } else { closed }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .sheet(isPresented: $fillsIn) { QuestionSheet(card: card) }
        // Answered here or on another device: nothing is left to fill in.
        .onChange(of: card.state) { fillsIn = false }
    }

    // MARK: Open

    @ViewBuilder
    private var open: some View {
        if card.form != nil {
            if inChat {
                Button {
                    fillsIn = true
                } label: {
                    Label("Fill in the form", systemImage: "list.bullet.rectangle")
                }
                .buttonStyle(ActionButtonStyle(style: .primary))
            } else {
                QuestionForm(card: card)
            }
        } else {
            if !card.actions.isEmpty {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) { choices(full: false) }
                    VStack(alignment: .leading, spacing: 8) { choices(full: true) }
                }
            }
            if card.isFree, !inChat { ownField }
            if let problem {
                Text(problem)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        }
        if inChat { waits }
    }

    @ViewBuilder
    private func choices(full: Bool) -> some View {
        ForEach(card.actions) { action in
            Button {
                send(action.id) { await model.answer(card, action: action, values: nil) }
            } label: {
                Group {
                    if working == action.id { ProgressView() } else { Text(action.label) }
                }
                .frame(maxWidth: full ? .infinity : nil)
            }
            .buttonStyle(ActionButtonStyle(style: action.style))
            .disabled(working != nil)
        }
    }

    /// In the list of what needs the person there is no chat to write in.
    private var ownField: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField(text: $words, prompt: Text(verbatim: card.reply?.placeholder ?? ""), axis: .vertical) {
                Text(verbatim: card.reply?.placeholder ?? "")
            }
            .lineLimit(2 ... 6)
            .modifier(FieldBox())
            Button {
                let text = words.trimmingCharacters(in: .whitespacesAndNewlines)
                send(Card.replyAction) { await model.reply(card, text: text) }
            } label: {
                Group {
                    if working == Card.replyAction { ProgressView() } else { Text("Send") }
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(ActionButtonStyle(style: .primary))
            .disabled(working != nil || words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    /// That it waits, and a way to answer it when the input answers another one.
    private var waits: some View {
        HStack(spacing: 12) {
            HStack(spacing: 8) {
                Circle()
                    .fill(.tint)
                    .frame(width: 6, height: 6)
                Text("Waiting for your answer")
            }
            .foregroundStyle(.secondary)
            if model.targetQuestion?.id != card.id {
                Button("Answer", systemImage: "arrowshape.turn.up.left") { model.pick(card) }
                    .buttonStyle(.plain)
                    .foregroundStyle(.tint)
            }
        }
        .font(.footnote)
        .frame(minHeight: 32)
    }

    private func send(_ what: String, _ work: @escaping () async -> String?) {
        working = what
        problem = nil
        Task {
            problem = await work()
            working = nil
        }
    }

    // MARK: Answered or expired

    @ViewBuilder
    private var closed: some View {
        if card.state == .expired {
            QuietLine(symbol: "clock", text: Text("no longer open"))
        } else if card.answer?.action == Card.replyAction {
            // The person's own message follows.
            EmptyView()
        } else if let form = card.form {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(form) { field in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: field.label)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        Text(verbatim: field.answerText(card.answer?.values?[field.id]) ?? "–")
                            .font(.callout)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.fill.quaternary, in: .rect(cornerRadius: 20))
        } else {
            let label = card.chosen?.label ?? String(localized: "answered")
            // In a group home: someone else answered, and the question says who.
            let other = card.answer?.person.flatMap { $0.id == model.person?.id ? nil : $0.name }
            QuietLine(symbol: "checkmark", text: Text(verbatim: [label, other].compactMap(\.self).joined(separator: " · ")))
        }
    }
}

/// The form of a question, over the chat.
private struct QuestionSheet: View {
    @Environment(\.dismiss) private var dismiss
    let card: Card

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    MarkdownText(card.title)
                        .fontWeight(.medium)
                    QuestionForm(card: card)
                }
                .padding(18)
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", systemImage: "xmark") { dismiss() }
                }
            }
        }
        .presentationDetents([.large])
    }
}

/// The parts of a form and the button that sends them.
private struct QuestionForm: View {
    @Environment(AppModel.self) private var model
    let card: Card

    @State private var missing: Set<String> = []
    @State private var working = false
    @State private var problem: String?

    var body: some View {
        let draft = model.formDraft(of: card)
        VStack(alignment: .leading, spacing: 18) {
            ForEach(card.form ?? []) { field in
                part(field, draft)
            }
            if let problem {
                Text(problem)
                    .font(.footnote)
                    .foregroundStyle(.red)
            } else if !missing.isDisjoint(with: draft.filled().missing(card.form ?? [])) {
                // The empty part may be out of view.
                Text("Something is still empty.")
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
            ForEach(card.actions) { action in
                Button {
                    answer(action, draft)
                } label: {
                    Group {
                        if working { ProgressView() } else { Text(action.label) }
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(ActionButtonStyle(style: action.style))
                .disabled(working || draft.isUploading)
            }
        }
        .padding(16)
        .background(.fill.quaternary, in: .rect(cornerRadius: 20))
    }

    /// One part of the form, with "I don't know" where the agent allows it.
    private func part(_ field: CardField, _ draft: FormDraft) -> some View {
        let unsure = draft.input.texts[field.id] == FormInput.unsure
        return VStack(alignment: .leading, spacing: 8) {
            if let attachments = draft.attachments[field.id] {
                FileField(label: field.label, attachments: attachments)
            } else {
                FieldView(field: field, text: text(field, draft), chosen: chosen(field.id, draft))
            }
            if let words = field.unsure {
                Button {
                    draft.input.texts[field.id] = unsure ? "" : FormInput.unsure
                } label: {
                    Label {
                        Text(verbatim: words)
                    } icon: {
                        Image(systemName: unsure ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(unsure ? AnyShapeStyle(.tint) : AnyShapeStyle(.tertiary))
                    }
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(minHeight: 36)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(unsure ? .isSelected : [])
            }
            if missing.contains(field.id), !draft.filled().missing([field]).isEmpty {
                Text("This one is still empty.")
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        }
    }

    /// What was typed; "I don't know" leaves the field empty, and typing takes it back.
    private func text(_ field: CardField, _ draft: FormDraft) -> Binding<String> {
        Binding(
            get: { draft.input.texts[field.id].flatMap { $0 == FormInput.unsure ? nil : $0 } ?? "" },
            set: {
                // A field that gives up the focus writes back the empty text it shows.
                if $0.isEmpty, draft.input.texts[field.id] == FormInput.unsure { return }
                draft.input.texts[field.id] = $0
            }
        )
    }

    private func chosen(_ id: String, _ draft: FormDraft) -> Binding<Set<String>> {
        Binding(
            get: { draft.input.choices[id] ?? [] },
            set: { next in
                // "I don't know" stands alone among several choices.
                let before = draft.input.choices[id] ?? []
                if next.contains(FormInput.unsure), next.count > 1 {
                    draft.input.choices[id] = before.contains(FormInput.unsure) ? next.subtracting([FormInput.unsure]) : [FormInput.unsure]
                } else {
                    draft.input.choices[id] = next
                }
            }
        )
    }

    private func answer(_ action: CardAction, _ draft: FormDraft) {
        let fields = card.form ?? []
        let filled = draft.filled()
        missing = filled.missing(fields)
        guard missing.isEmpty else { return }
        working = true
        problem = nil
        Task {
            let values = filled.values(fields)
            problem = await model.answer(card, action: action, values: values.isEmpty ? nil : values)
            working = false
        }
    }
}

/// Files given as an answer: they go to the home as they are picked, the form names them.
private struct FileField: View {
    @Environment(AppModel.self) private var model
    let label: String
    let attachments: Attachments
    @State private var importing = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: label)
                .font(.footnote.weight(.medium))
                .foregroundStyle(.secondary)
            ForEach(attachments.list) { attachment in
                HStack(spacing: 8) {
                    AttachmentTile(attachment: attachment) {
                        attachments.remove(attachment.id, client: model.client)
                    }
                    Text(verbatim: attachment.name)
                        .font(.callout)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                if attachment.state == .failed {
                    Text("“\(attachment.name)” was not attached. \(attachment.why ?? "")")
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }
            if let notice = attachments.notice {
                Text(notice)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
            Button("Add a file", systemImage: "paperclip") { importing = true }
                .buttonStyle(ActionButtonStyle(style: .plain))
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result, let client = model.client else { return }
            let room = attachments.room
            Task {
                let picked = await Task.detached { PickedFile.read(picked: Array(urls.prefix(room))) }.value
                attachments.add(picked, total: urls.count, client: client)
            }
        }
    }
}
