import AuthenticationServices
import SwiftUI

/// A card of the chat, drawn from its data: title, body, QR, fields, link and actions. A kind this
/// version does not know is drawn the same way, from whatever it carries.
struct CardView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @Environment(\.openURL) private var openURL
    let card: Card

    @State private var texts: [String: String] = [:]
    @State private var choices: [String: Set<String>] = [:]
    @State private var working: String?
    @State private var problem: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(card.title)
                .font(.headline)
                .fixedSize(horizontal: false, vertical: true)

            if card.state == .open {
                open
            } else {
                closed
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.fill.quaternary, in: .rect(cornerRadius: 20))
        .accessibilityElement(children: .contain)
        .onAppear(perform: start)
    }

    /// The fields start with what the card gives them.
    private func start() {
        for field in card.fields ?? [] {
            switch (field.type, field.value) {
            case (.choice, .text(let value)?), (.multi, .text(let value)?):
                if choices[field.id] == nil { choices[field.id] = [value] }
            case (.multi, .many(let values)?):
                if choices[field.id] == nil { choices[field.id] = Set(values) }
            case (_, .text(let value)?):
                if texts[field.id] == nil { texts[field.id] = value }
            default:
                break
            }
        }
    }

    // MARK: Open

    @ViewBuilder
    private var open: some View {
        if let qr = card.qr, !qr.isEmpty {
            QRCode(text: qr)
                .frame(maxWidth: 220)
                .frame(maxWidth: .infinity)
        }
        if let body = card.body, !body.isEmpty {
            if card.kind == .pairing {
                // The code of a pairing card, large enough to read across a table.
                Text(body)
                    .font(.title2.monospaced().weight(.semibold))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity)
            } else {
                MarkdownText(body)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
        ForEach(card.fields ?? []) { field in
            FieldView(field: field, text: text(field.id), chosen: chosen(field.id))
        }
        if let problem {
            Text(problem)
                .font(.footnote)
                .foregroundStyle(.red)
        }
        if card.url == PersonKeyCard.url {
            // The person's key is made, and their record signed, on this phone.
            PersonKeyCard()
        } else if let link = card.url.flatMap(URL.init(string:)) {
            Button {
                openLink(link)
            } label: {
                Label(linkLabel(link), systemImage: PhoneAction(link) == nil ? "arrow.up.forward" : "iphone")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(ActionButtonStyle(style: .primary))
        }
        // A card that only informs has no actions. A `connect` card keeps its own ("Not now") beside the sign-in.
        if card.kind != .info, !card.actions.isEmpty {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { actionButtons }
                VStack(spacing: 8) { actionButtons }
            }
        }
    }

    @ViewBuilder
    private var actionButtons: some View {
        ForEach(card.actions) { action in
            Button {
                answer(action)
            } label: {
                Group {
                    if working == action.id {
                        ProgressView()
                    } else {
                        Text(action.label)
                    }
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(ActionButtonStyle(style: action.style))
            .disabled(working != nil || (action.style == .primary && !isComplete))
        }
    }

    /// True when every required field has a value. Only the main action waits for that.
    private var isComplete: Bool {
        (card.fields ?? []).allSatisfy { field in
            guard field.required == true else { return true }
            return switch field.type {
            case .choice, .multi: !(choices[field.id] ?? []).isEmpty
            default: !(texts[field.id] ?? "").trimmingCharacters(in: .whitespaces).isEmpty
            }
        }
    }

    private func text(_ id: String) -> Binding<String> {
        Binding(get: { texts[id] ?? "" }, set: { texts[id] = $0 })
    }

    private func chosen(_ id: String) -> Binding<Set<String>> {
        Binding(get: { choices[id] ?? [] }, set: { choices[id] = $0 })
    }

    private func answer(_ action: CardAction) {
        var values: [String: FieldValue] = [:]
        for field in card.fields ?? [] {
            switch field.type {
            case .multi:
                // In the order the card lists them.
                let picked = choices[field.id] ?? []
                values[field.id] = .many((field.options ?? []).map(\.id).filter(picked.contains))
            case .choice:
                if let picked = choices[field.id]?.first { values[field.id] = .text(picked) }
            default:
                if let text = texts[field.id], !text.isEmpty { values[field.id] = .text(text) }
            }
        }
        working = action.id
        problem = nil
        Task {
            problem = await model.answer(card, action: action, values: values.isEmpty ? nil : values)
            working = nil
            // What was typed into a secret field is not kept on screen.
            if problem == nil { texts = [:] }
        }
    }

    private func linkLabel(_ link: URL) -> LocalizedStringKey {
        if card.kind == .connect { return "Sign in" }
        return switch PhoneAction(link) {
        case .call?: "Call"
        case .message?: "Open the message"
        case nil: "Open"
        }
    }

    private func openLink(_ link: URL) {
        // A call or a message the phone puts together from its own contacts.
        if let action = PhoneAction(link) {
            model.phoneAction = action
            return
        }
        // Only a sign-in opens in the sign-in browser; any other link opens its app, or the web.
        guard card.kind == .connect, ["http", "https"].contains(link.scheme?.lowercased() ?? "") else {
            openURL(link)
            return
        }
        Task {
            // The system's sign-in browser. It closes by itself when the sign-in ends at wizardsbot://,
            // or the person closes it; the card is answered by the home either way.
            _ = try? await webAuthenticationSession.authenticate(
                using: link, callback: .customScheme(PairingLink.scheme), additionalHeaderFields: [:]
            )
            await model.refresh()
        }
    }

    // MARK: Answered or expired

    /// The name of the admin who answered, when it was not this phone's admin.
    private var otherAdmin: String? {
        guard let admin = card.answer?.admin, admin.id != model.admin?.id else { return nil }
        return admin.name
    }

    @ViewBuilder
    private var closed: some View {
        if card.state == .answered {
            if let chosen = card.chosen {
                // A folder the person picked on the card is named beside the yes.
                let picked = pickedFolder(chosen).map { "\(chosen.label) · \(FolderField.name(of: $0))" } ?? chosen.label
                // In a group home: another admin answered, and the card says who.
                let label = otherAdmin.map { "\(picked) · \($0)" } ?? picked
                QuietLine(symbol: "checkmark", text: Text(verbatim: label))
                    .accessibilityLabel(Text("Answered: \(label)"))
            } else if card.answer?.by == Card.signIn {
                // The home answered it itself when the sign-in was done.
                QuietLine(symbol: "checkmark", text: Text("signed in"))
            } else {
                QuietLine(symbol: "checkmark", text: Text("answered"))
            }
        } else {
            QuietLine(symbol: "clock", text: Text("no longer open"))
        }
    }
}

extension CardView {
    /// The folder picked on an answered card, with its main action.
    fileprivate func pickedFolder(_ chosen: CardAction) -> String? {
        guard chosen.style == .primary,
              let field = card.fields?.first(where: { $0.type == .folder }),
              case .text(let path)? = card.answer?.values?[field.id], !path.isEmpty else { return nil }
        return path
    }
}

/// One field of a card.
private struct FieldView: View {
    let field: CardField
    @Binding var text: String
    @Binding var chosen: Set<String>

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(field.label)
                .font(.footnote.weight(.medium))
                .foregroundStyle(.secondary)
            switch field.type {
            case .secret:
                // Goes to the home and is never shown again.
                SecureField(text: $text, prompt: Text(verbatim: field.placeholder ?? "")) { Text(verbatim: field.label) }
                    .textContentType(.password)
                    .modifier(FieldBox())
            case .choice:
                ForEach(field.options ?? []) { option in
                    optionRow(option, symbol: chosen.contains(option.id) ? "largecircle.fill.circle" : "circle") {
                        chosen = [option.id]
                    }
                }
            case .multi:
                ForEach(field.options ?? []) { option in
                    optionRow(option, symbol: chosen.contains(option.id) ? "checkmark.square.fill" : "square") {
                        chosen.formSymmetricDifference([option.id])
                    }
                }
            case .folder:
                // A folder the card proposes to make: the line that says so, while it is chosen.
                FolderField(path: $text, hint: field.value == .text(text) ? field.placeholder : nil)
            default:
                TextField(text: $text, prompt: Text(verbatim: field.placeholder ?? ""), axis: .vertical) { Text(verbatim: field.label) }
                    .lineLimit(1 ... 5)
                    .modifier(FieldBox())
            }
        }
    }

    private func optionRow(_ option: FieldOption, symbol: String, action: @escaping () -> Void) -> some View {
        let isOn = chosen.contains(option.id)
        return Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: symbol)
                    .foregroundStyle(isOn ? AnyShapeStyle(.tint) : AnyShapeStyle(.tertiary))
                Text(option.label)
                    .foregroundStyle(.primary)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 0)
            }
            .frame(minHeight: 36)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }
}

private struct FieldBox: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(.background, in: .rect(cornerRadius: 12))
    }
}
