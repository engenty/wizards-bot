import SwiftUI

/// The watch: the main agent, one button to talk, and what needs the person.
struct ContentView: View {
    @Environment(WatchModel.self) private var model

    var body: some View {
        if model.link == nil {
            Unpaired()
        } else {
            NavigationStack {
                ScrollView {
                    VStack(spacing: 10) {
                        EngentyFigure(kind: model.agent?.kind ?? .round, lively: model.isWaiting || model.agent?.state == .working)
                            .frame(height: 72)

                        TextFieldLink(prompt: Text("Say something")) {
                            Label("Talk", systemImage: "mic.fill")
                                .font(.title3.weight(.semibold))
                                .frame(maxWidth: .infinity, minHeight: 44)
                        } onSubmit: { text in
                            Task { await model.send(text) }
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(.accentColor)
                        .foregroundStyle(Color(hex: 0x090D16))
                        .disabled(model.agent == nil)
                        .accessibilityLabel(model.agent.map { Text("Talk to \($0.name)") } ?? Text("Talk"))

                        if let said = model.said {
                            Text(said)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .trailing)
                                .multilineTextAlignment(.trailing)
                        }
                        if let reply = model.reply, !reply.text.isEmpty {
                            MarkdownText(reply.text)
                        } else if model.isWaiting {
                            ProgressView()
                        }
                        if let problem = model.problem {
                            Text(problem)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .multilineTextAlignment(.center)
                        }

                        if !model.items.isEmpty {
                            Text("Needs you")
                                .font(.headline)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.top, 8)
                                .accessibilityAddTraits(.isHeader)
                            ForEach(model.items) { card in
                                WatchCard(card: card)
                            }
                        }
                    }
                    .padding(.horizontal, 4)
                }
                .navigationTitle(model.agent?.name ?? "wizards.bot")
                .navigationBarTitleDisplayMode(.inline)
            }
        }
    }
}

/// A card on the wrist: its actions as buttons. A card with fields is answered on the phone.
private struct WatchCard: View {
    @Environment(WatchModel.self) private var model
    let card: Card
    @State private var working = false
    @State private var problem: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(card.title)
                .font(.headline)
            if let body = card.body, !body.isEmpty, card.kind != .pairing {
                Text(MarkdownText.inline(body))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if needsPhone {
                Label("Answer on your phone", systemImage: "iphone")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(card.actions) { action in
                    button(for: action)
                }
            }
            if let problem {
                Text(problem)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.fill.tertiary, in: .rect(cornerRadius: 14))
    }

    /// Fields, a sign-in and a QR need a larger screen.
    private var needsPhone: Bool {
        !(card.fields ?? []).isEmpty || card.url != nil || card.qr != nil || card.actions.isEmpty
    }

    @ViewBuilder
    private func button(for action: CardAction) -> some View {
        let label = Text(action.label).frame(maxWidth: .infinity)
        if action.style == .primary {
            Button { answer(action) } label: { label }
                .buttonStyle(.borderedProminent)
                .tint(.accentColor)
                .foregroundStyle(Color(hex: 0x090D16))
                .disabled(working)
        } else {
            Button(role: action.style == .danger ? .destructive : nil) { answer(action) } label: { label }
                .buttonStyle(.bordered)
                .disabled(working)
        }
    }

    private func answer(_ action: CardAction) {
        working = true
        problem = nil
        Task {
            problem = await model.answer(card, action: action)
            working = false
        }
    }
}

/// The watch has no home yet: the phone connects it.
private struct Unpaired: View {
    @Environment(WatchModel.self) private var model

    var body: some View {
        ScrollView {
            VStack(spacing: 10) {
                EngentyFigure(kind: .round)
                    .frame(height: 64)
                Text(model.phoneHasNoHome
                    ? "Connect your phone to your Bot Server first. This watch follows."
                    : "Open wizards.bot on your phone. It connects this watch to your Bot Server.")
                    .font(.footnote)
                    .multilineTextAlignment(.center)
                Button("Try again") { model.ask() }
            }
            .padding(.horizontal, 4)
        }
    }
}
