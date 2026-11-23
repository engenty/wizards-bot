import AppKit
import SwiftUI

/// "Die Modelle dieses Macs anbieten": the address of a Bot Server elsewhere and a code from it.
struct LinkSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var code = ""
    @State private var problem: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Offer this Mac's models").font(.title2.weight(.semibold))
            Text("A Bot Server on another computer or at wizards.bot then uses Claude Code, Codex and Ollama of this Mac while it is on.")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Form {
                TextField("Address", text: $address, prompt: Text(verbatim: "ada.wizards.bot"))
                TextField("Code", text: $code, prompt: Text(verbatim: "K7QM-2RXD"))
            }
            .formStyle(.columns)
            .textFieldStyle(.roundedBorder)
            .onSubmit { Task { await link() } }
            Text("The code comes from that Bot Server: ask it in the chat to add a device (\u{201C}Add a device\u{201D}). It works once, for 10 minutes.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let problem {
                Text(problem).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Button("Cancel") { dismiss() }
                Spacer()
                if model.link.busy { ProgressView().controlSize(.small) }
                Button("Offer") { Task { await link() } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(model.link.busy || address.isEmpty || code.isEmpty)
            }
        }
        .padding(28)
        .frame(width: 460)
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

    static let minimum = 12

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Save a backup").font(.title2.weight(.semibold))
            Text("All of your Bot Server in one file: agents, conversations, files, keys. It is encrypted with a passphrase you choose; keep it apart from the file. Without it nobody can read the file, you neither.")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Form {
                SecureField("Passphrase", text: $passphrase)
                SecureField("Once more", text: $again)
            }
            .formStyle(.columns)
            .textFieldStyle(.roundedBorder)
            Text("At least \(Self.minimum) characters.").font(.footnote).foregroundStyle(.secondary)
            if let problem {
                Text(problem).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Button("Cancel") { dismiss() }
                Spacer()
                if busy { ProgressView().controlSize(.small) }
                Button("Save…") { Task { await save() } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(busy || passphrase.count < Self.minimum || passphrase != again)
            }
        }
        .padding(28)
        .frame(width: 460)
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
