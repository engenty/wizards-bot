import CoreImage.CIFilterBuiltins
import ServiceManagement
import SwiftUI

/// The Bot Server found on this Mac before the app, on the first screen.
struct FoundView: View {
    @Environment(AppModel.self) private var model
    let found: LocalHome.Found

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: model.local.offersUpdate ? "arrow.up.circle" : "checkmark.circle")
                .font(.title2)
                .foregroundStyle(model.local.offersUpdate ? Color.accentColor : .green)
            VStack(alignment: .leading, spacing: 6) {
                switch found {
                case let .runs(version, _) where model.local.offersUpdate:
                    let mine = model.local.bundledVersion ?? ""
                    Text("An older Bot Server runs on this Mac.").font(.headline)
                    if let version {
                        Text("It is version \(version), the app carries \(mine).")
                    } else {
                        Text("It is older than the app's, which is version \(mine).")
                    }
                    Text("Updating stops it, keeps a copy of its data in \(LocalPaths.shown(model.local.backup)) and starts the app's Bot Server on the same data. Your agents, conversations and paired devices stay.")
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack {
                        Button("Update it") { Task { await model.takeOver() } }
                        Button("Use it as it is") { Task { await model.useFound() } }
                    }
                case .runs:
                    Text("A Bot Server already runs on this Mac.").font(.headline)
                    Text("The app uses it as it is and starts no second one.")
                        .foregroundStyle(.secondary)
                    Button("Use it") { Task { await model.useFound() } }
                case .installed:
                    Text("A Bot Server is installed on this Mac, but it does not run.").font(.headline)
                    Text("It came with wizards bot install. The app starts it and uses it.")
                        .foregroundStyle(.secondary)
                    Button("Start it") { Task { await model.useFound() } }
                case let .portTaken(program):
                    Text("Port 4747 is taken by \(program).").font(.headline)
                    Text("A Bot Server listens on 4747. Quit that program to start one here, or connect to a Bot Server elsewhere.")
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .frame(maxWidth: 620)
        .background(.quaternary.opacity(0.5), in: .rect(cornerRadius: 12))
    }
}

/// The menu of the menu bar item.
struct MenuBarMenu: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Text(status)
        Divider()
        Button("Open wizards.bot") { show() }
        if model.local.isOurs {
            Button("Connect a phone…") {
                show()
                model.showPhone = true
            }
            Divider()
            Button("Stop Bot Server") { Task { await model.local.stop() } }
        } else if model.local.canStart, model.local.found == nil {
            Divider()
            Button("Start Bot Server") { Task { await model.startHere() } }
        }
        if model.link.isOn {
            Divider()
            Text(model.link.said)
            Button("Stop offering this Mac's models") { Task { await model.link.stop() } }
        } else if model.link.canLink {
            Divider()
            Button("Offer this Mac's models…") {
                show()
                model.link.asking = true
            }
        }
        Divider()
        Button("Quit wizards.bot") { NSApp.terminate(nil) }
            .keyboardShortcut("q")
    }

    private var status: String {
        if model.local.isOurs {
            return model.local.needsApproval
                ? String(localized: "Bot Server waits for your approval")
                : String(localized: "Bot Server runs on this Mac")
        }
        if let home = model.home { return String(localized: "Connected to \(Address.label(home))") }
        return String(localized: "Not connected")
    }

    private func show() {
        openWindow(id: "main")
        NSApp.activate()
    }
}

/// Entries of the app's menu.
struct MenuCommands: View {
    var body: some View {
        if Updates.shared.available {
            Button("Check for Updates…") { Updates.shared.check() }
        }
        Button("Connect to Another Bot Server…") { AppModel.shared.forget() }
    }
}

/// The app's settings: its Bot Server on this Mac. Everything else is set up in the conversation.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var removing = false
    @State private var takingOver = false
    @State private var exporting = false
    @State private var linking = false
    /// The removal waits for the backup the person chose to save first.
    @State private var removeAfterExport = false

    var body: some View {
        Form {
            Section("Bot Server on this Mac") {
                if model.local.isOurs {
                    LabeledContent("Version", value: model.local.bundledVersion ?? "–")
                    LabeledContent("Data", value: LocalPaths.dataShown)
                    HStack {
                        Button("Show the log") {
                            NSWorkspace.shared.open(LocalPaths.data.appending(path: "logs/home.log"))
                        }
                        Button("Save a backup…") {
                            removeAfterExport = false
                            exporting = true
                        }
                        Spacer()
                        Button("Remove from this Mac…", role: .destructive) { removing = true }
                    }
                } else if model.local.found == .installed || model.local.found.isInstall {
                    Text("Your Bot Server came with wizards bot install, and wizards bot update updates it. The app can run it instead, on the same data, and update it with itself.")
                        .foregroundStyle(.secondary)
                    if model.local.canStart {
                        Button("Update the Bot Server with the app…") { takingOver = true }
                    }
                } else {
                    Text("The app runs no Bot Server on this Mac.")
                        .foregroundStyle(.secondary)
                }
                if let problem = model.local.problem {
                    Text(problem).foregroundStyle(.red)
                }
            }
            Section("This Mac's models") {
                Text(model.link.said).foregroundStyle(.secondary)
                if model.link.isOn {
                    Button("Stop offering") { Task { await model.link.stop() } }
                } else if model.link.canLink {
                    Button("Offer to a Bot Server…") { linking = true }
                }
            }
            if Updates.shared.available {
                Section("Updates") {
                    Button("Check for Updates…") { Updates.shared.check() }
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 480)
        .disabled(model.local.busy)
        .task { await model.local.look() }
        .sheet(isPresented: $exporting) {
            ExportSheet(then: removeAfterExport ? { removing = true } : nil)
        }
        .sheet(isPresented: $linking) { LinkSheet() }
        .confirmationDialog("Remove the Bot Server from this Mac?", isPresented: $removing) {
            Button("Save a backup first…") {
                removeAfterExport = true
                exporting = true
            }
            Button("Remove, keep the data") { Task { await model.removeHere(trashData: false) } }
            Button("Remove, move the data to the Trash", role: .destructive) {
                Task { await model.removeHere(trashData: true) }
            }
        } message: {
            Text("It stops and no longer starts with your Mac. Your agents, conversations and paired phones are in \(LocalPaths.dataShown); kept there, a Bot Server started later finds them again.")
        }
        .confirmationDialog("Let the app run your Bot Server?", isPresented: $takingOver) {
            Button("Let the app run it") { Task { await model.takeOver() } }
        } message: {
            Text("The Bot Server of wizards bot install stops, a copy of its data is kept in \(LocalPaths.shown(model.local.backup)), and the app's starts on the same data. Its LaunchAgent is set aside, not deleted.")
        }
    }
}

private extension LocalHome.Found? {
    /// A Bot Server of `wizards bot install` that runs.
    var isInstall: Bool {
        if case let .runs(_, byInstall) = self { return byInstall }
        return false
    }
}

/// A QR for the phone, with the address and the code beside it.
struct PhoneSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var pairing: (address: String, code: String)?
    @State private var failed = false

    var body: some View {
        VStack(spacing: 16) {
            Text("Connect a phone").font(.title2.weight(.semibold))
            if let pairing {
                if let image = Self.qr("wizardsbot://pair?home=\(pairing.address.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")&code=\(pairing.code)") {
                    Image(nsImage: image)
                        .interpolation(.none)
                        .resizable()
                        .frame(width: 220, height: 220)
                }
                Text("Scan it with the camera of your iPhone, or type the address and the code into the app.")
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                LabeledContent("Address", value: pairing.address).textSelection(.enabled)
                LabeledContent("Code", value: pairing.code).textSelection(.enabled)
                Text("The code works once, for 10 minutes.").font(.footnote).foregroundStyle(.secondary)
            } else if failed {
                Text("The Bot Server made no code. Is it running?").foregroundStyle(.red)
            } else {
                ProgressView()
            }
            Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
        }
        .padding(28)
        .frame(width: 380)
        .task {
            if let made = await model.local.phonePairing() { pairing = made } else { failed = true }
        }
    }

    static func qr(_ text: String) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: .init(scaleX: 8, y: 8)) else { return nil }
        let rep = NSCIImageRep(ciImage: output)
        let image = NSImage(size: rep.size)
        image.addRepresentation(rep)
        return image
    }
}
