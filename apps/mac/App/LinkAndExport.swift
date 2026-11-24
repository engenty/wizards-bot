import AppKit
import SwiftUI

/// "Die Modelle dieses Macs anbieten": the address of a Bot Server elsewhere and a code from it.
struct LinkSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var code = ""
    @State private var problem: String?
    @FocusState private var focus: Field?

    private enum Field { case address, code }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            PetrolHeading("Offer this Mac's models")
            Text("A Bot Server on another computer or at wizards.bot then uses Claude Code, Codex and Ollama of this Mac while it is on.")
                .font(.system(size: 13))
                .foregroundStyle(Petrol.ink2)
                .fixedSize(horizontal: false, vertical: true)
            PetrolCard {
                PetrolFieldRow(label: "Address", focused: focus == .address) {
                    TextField("Address", text: $address, prompt: Text(verbatim: "ada.wizards.bot").foregroundStyle(Petrol.ink3))
                        .labelsHidden()
                        .focused($focus, equals: .address)
                }
                PetrolDivider()
                PetrolFieldRow(label: "Code", focused: focus == .code) {
                    TextField("Code", text: $code, prompt: Text(verbatim: "K7QM-2RXD").foregroundStyle(Petrol.ink3))
                        .labelsHidden()
                        .monospaced()
                        .focused($focus, equals: .code)
                }
            }
            .onSubmit { Task { await link() } }
            Text("The code comes from that Bot Server: ask it in the chat to add a device (\u{201C}Add a device\u{201D}). It works once, for 10 minutes.")
                .font(.system(size: 12))
                .foregroundStyle(Petrol.ink3)
                .fixedSize(horizontal: false, vertical: true)
            if let problem {
                Text(problem)
                    .font(.system(size: 12))
                    .foregroundStyle(Petrol.rose)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            HStack {
                Button("Cancel") { dismiss() }.petrolButton(.plain)
                Spacer()
                if model.link.busy { ProgressView().controlSize(.small) }
                Button("Offer") { Task { await link() } }
                    .petrolButton()
                    .keyboardShortcut(.defaultAction)
                    .disabled(model.link.busy || address.isEmpty || code.isEmpty)
            }
        }
        .padding(28)
        .frame(width: 460)
        .petrolGround()
        .onAppear {
            if let home = model.home, !model.isLocal(home) { address = Address.label(home) }
        }
    }

    private func link() async {
        problem = await model.link.link(address: address, code: code)
        if problem == nil { dismiss() }
    }
}

/// An encrypted copy of the Bot Server's data (`wizards-bot export`), in a file the person picks.
struct ExportSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    /// What happens once the copy is saved: the removal waits for it.
    var then: (() -> Void)?
    @State private var passphrase = ""
    @State private var again = ""
    @State private var problem: String?
    @State private var busy = false

    @FocusState private var focus: Field?

    private enum Field { case passphrase, again }

    static let minimum = 12

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            PetrolHeading("Save a backup")
            Text("All of your Bot Server in one file: agents, conversations, files, keys. It is encrypted with a passphrase you choose; keep it apart from the file. Without it nobody can read the file, you neither.")
                .font(.system(size: 13))
                .foregroundStyle(Petrol.ink2)
                .fixedSize(horizontal: false, vertical: true)
            PetrolCard {
                PetrolFieldRow(label: "Passphrase", focused: focus == .passphrase) {
                    SecureField("Passphrase", text: $passphrase)
                        .labelsHidden()
                        .focused($focus, equals: .passphrase)
                }
                PetrolDivider()
                PetrolFieldRow(label: "Once more", focused: focus == .again) {
                    SecureField("Once more", text: $again)
                        .labelsHidden()
                        .focused($focus, equals: .again)
                }
            }
            Text("At least \(Self.minimum) characters.")
                .font(.system(size: 12))
                .foregroundStyle(Petrol.ink3)
            if let problem {
                Text(problem)
                    .font(.system(size: 12))
                    .foregroundStyle(Petrol.rose)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            HStack {
                Button("Cancel") { dismiss() }.petrolButton(.plain)
                Spacer()
                if busy { ProgressView().controlSize(.small) }
                Button("Save…") { Task { await save() } }
                    .petrolButton()
                    .keyboardShortcut(.defaultAction)
                    .disabled(busy || passphrase.count < Self.minimum || passphrase != again)
            }
        }
        .padding(28)
        .frame(width: 460)
        .petrolGround()
    }

    private func save() async {
        problem = nil
        let panel = NSSavePanel()
        let day = Date.now.formatted(.iso8601.year().month().day())
        panel.nameFieldStringValue = "wizards-bot-\(day).export"
        panel.canCreateDirectories = true
        let answer = if let window = NSApp.keyWindow { await panel.beginSheetModal(for: window) } else { panel.runModal() }
        guard answer == .OK, let file = panel.url else { return }
        busy = true
        problem = await model.local.export(to: file, passphrase: passphrase)
        busy = false
        if problem == nil {
            NSWorkspace.shared.activateFileViewerSelecting([file])
            dismiss()
            then?()
        }
    }
}
