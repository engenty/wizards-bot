import SwiftUI

/// What the card for the person's key does on this phone: make the key and show its recovery
/// code once, bring a key back from its code, or sign the version of the record the home asks
/// for. The key stays in the Keychain; the home gets the signature.
struct PersonKeyCard: View {
    /// The address of the card the home shows for it.
    static let url = "wizardsbot://person"

    @Environment(AppModel.self) private var model
    @State private var person: PersonState?
    @State private var held: String?
    /// The recovery code, while it is on the screen: it is shown once, right after the key is made.
    @State private var code: String?
    @State private var entering = false
    @State private var typed = ""
    @State private var busy = false
    @State private var problem: LocalizedStringKey?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let person {
                content(person)
            } else if problem == nil {
                ProgressView()
            }
            if let problem {
                Text(problem)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task { await load() }
    }

    @ViewBuilder
    private func content(_ person: PersonState) -> some View {
        let recordKey = person.record?.key
        let holdsIt = held != nil && (recordKey == nil || recordKey == held)
        if let code, let held {
            Text("Your recovery code")
                .font(.callout.weight(.medium))
            Text(verbatim: Self.rows(of: code))
                .font(.callout.monospaced())
                .textSelection(.enabled)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.background, in: .rect(cornerRadius: 12))
            Text("Write it down and keep it where only you find it. It is shown this once, and it brings your key back when this iPhone is lost.")
                .font(.footnote)
                .foregroundStyle(.secondary)
            button("I wrote it down", style: .primary) {
                await sign(with: held)
                if problem == nil { self.code = nil }
            }
        } else if holdsIt, let held {
            button("Sign with my key", style: .primary) { await sign(with: held) }
        } else if entering || person.record != nil {
            if person.record != nil {
                Text("Your key is on another device. Open this card there, or bring the key to this iPhone with your recovery code.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            TextField(text: $typed, prompt: Text("Recovery code"), axis: .vertical) { Text("Recovery code") }
                .lineLimit(1 ... 3)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .font(.callout.monospaced())
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(.background, in: .rect(cornerRadius: 12))
            button("Bring my key back", style: .primary) { await bringBack(recordKey: recordKey) }
                .disabled(typed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } else {
            button("Make my key on this iPhone", style: .primary) {
                guard let made = PersonKey.make() else { return fail() }
                held = made.publicKey
                code = made.code
            }
            button("I have a recovery code", style: .plain) { entering = true }
        }
    }

    /// The code in rows of four groups, as it is copied down by hand.
    private static func rows(of code: String) -> String {
        let groups = code.split(separator: "-")
        return stride(from: 0, to: groups.count, by: 4)
            .map { groups[$0 ..< min($0 + 4, groups.count)].joined(separator: "-") }
            .joined(separator: "\n")
    }

    private func button(_ title: LocalizedStringKey, style: ActionStyle, action: @escaping () async -> Void) -> some View {
        Button {
            Task {
                busy = true
                problem = nil
                await action()
                busy = false
            }
        } label: {
            Text(title)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(ActionButtonStyle(style: style))
        .disabled(busy)
    }

    private func fail() {
        problem = "That did not work. Try again."
    }

    private func load() async {
        held = PersonKey.held
        guard let client = model.client else { return }
        do {
            person = try await client.person()
        } catch {
            fail()
        }
    }

    /// Has the home name what is to be signed, signs it here and hands the signature in.
    private func sign(with key: String) async {
        guard let client = model.client else { return fail() }
        do {
            let payload = try await client.personStart(key: key)
            guard let sig = PersonKey.signWithHeld(payload) else { return fail() }
            person = try await client.personSign(SignedRecord(payload: payload, sig: sig))
            await model.refresh()
        } catch {
            fail()
        }
    }

    private func bringBack(recordKey: String?) async {
        guard let seed = PersonKey.seed(from: typed), let key = PersonKey.publicKey(of: seed) else {
            problem = "That is not a recovery code. Check it against what you wrote down."
            return
        }
        if let recordKey, recordKey != key {
            problem = "That code belongs to another key than the one in your record."
            return
        }
        guard PersonKey.bringBack(typed) != nil else { return fail() }
        held = key
        entering = false
        typed = ""
        // With no record in the home, or one that waits for a signature, the key signs at once.
        if person?.record == nil || person?.proposed != nil { await sign(with: key) }
    }
}
