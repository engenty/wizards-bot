import SwiftUI

/// Connects a folder from a chat. First where it is. A folder on this phone (iCloud Drive, On My
/// iPhone or any other place in Files) is connected on the phone: its files stay here, the phone's
/// own agent reads them when the home's agents ask, and the home only learns that it is there. A
/// folder of the home's computer is picked as on an agent's folder card, in the folder browser of
/// that computer, with whether the agents only read it or also change it; the chat's agent is
/// told and answers there.
struct FolderConnectSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    /// The chat it is opened from.
    let conversationId: String

    /// Where the folder is: on this phone or on the home's computer.
    private enum Place { case phone, home }

    /// A folder picked on this phone, counted before it is connected.
    private struct Picked {
        var url: URL
        var count: PhoneFolderCount
    }

    @State private var place: Place?
    @State private var path = ""
    @State private var access: FolderAccess = .read
    @State private var busy = false
    @State private var problem: String?
    /// The Files dialog of this phone is open, for a folder.
    @State private var importing = false
    @State private var picked: Picked?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if let picked {
                        onPhone(picked)
                    } else if place == .home {
                        onHome
                    } else {
                        places
                    }
                    if let problem {
                        Text(problem)
                            .font(.subheadline)
                            .foregroundStyle(.red)
                    }
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationTitle("Connect a folder")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", systemImage: "xmark") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .fileImporter(isPresented: $importing, allowedContentTypes: [.folder]) { result in
            if case .success(let url) = result { fromPhone(url) }
        }
    }

    // MARK: Steps

    /// The word for this device in "On this iPhone".
    private var thisDevice: String { UIDevice.current.model }

    private var places: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Where is the folder?")
                .foregroundStyle(.secondary)
            placeChoice(
                title: "On this \(thisDevice)",
                note: "iCloud Drive, On My \(thisDevice) or another place in Files. The files stay here: your agents ask this \(thisDevice), and only the answer goes to your Bot Server.",
                symbol: "iphone"
            ) {
                problem = nil
                importing = true
            }
            placeChoice(
                title: "On your Bot Server’s computer",
                note: "Your Bot Server reads the files on its computer, in place.",
                symbol: "desktopcomputer"
            ) {
                problem = nil
                place = .home
            }
        }
    }

    private func placeChoice(title: LocalizedStringKey, note: LocalizedStringKey, symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Image(systemName: symbol)
                    .foregroundStyle(.tint)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Color.primary)
                    Text(note)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(.fill.quaternary, in: .rect(cornerRadius: 14))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(busy)
    }

    /// A folder picked on this phone, before it is connected here.
    private func onPhone(_ folder: Picked) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 4) {
                Text(folder.url.lastPathComponent)
                    .foregroundStyle(.tertiary)
                    .lineLimit(2)
                    .truncationMode(.middle)
                Text(FolderField.holds(files: folder.count.files, folders: folder.count.folders, bytes: folder.count.bytes, more: folder.count.more))
                Text("The files stay on this \(thisDevice). When your agents need something in them, they ask this \(thisDevice): its own model reads the files here and sends back only the answer. A file goes to your Bot Server only after you said yes here.")
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
            buttons {
                Button("Back") {
                    problem = nil
                    picked = nil
                }
                .buttonStyle(ActionButtonStyle(style: .plain))
                Button("Connect") { connectHere(folder.url) }
                    .buttonStyle(ActionButtonStyle(style: .primary))
                    .disabled(busy)
            }
        }
    }

    /// A folder of the Bot Server's computer: picked in its folder browser, and what the agents may do there.
    private var onHome: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Choose a folder on your Bot Server’s computer. Once it is connected, your agents read its files.")
                .foregroundStyle(.secondary)
            FolderField(path: $path)
            VStack(alignment: .leading, spacing: 8) {
                Text("What may your agents do in this folder?")
                    .font(.subheadline.weight(.medium))
                choice(.read, title: "Read only", note: "Your agents read the files and change nothing.")
                choice(.write, title: "Read and change", note: "Your agents ask you before each change.")
            }
            buttons {
                Button("Back") {
                    problem = nil
                    place = nil
                }
                .buttonStyle(ActionButtonStyle(style: .plain))
                Button("Connect") { connect(path) }
                    .buttonStyle(ActionButtonStyle(style: .primary))
                    .disabled(busy || path.isEmpty)
            }
        }
    }

    private func choice(_ option: FolderAccess, title: LocalizedStringKey, note: LocalizedStringKey) -> some View {
        let chosen = access == option
        return Button {
            access = option
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Image(systemName: chosen ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(chosen ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Color.primary)
                    Text(note)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(.fill.quaternary, in: .rect(cornerRadius: 14))
            .overlay {
                RoundedRectangle(cornerRadius: 14)
                    .strokeBorder(chosen ? AnyShapeStyle(.tint) : AnyShapeStyle(.clear), lineWidth: 1.5)
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }

    /// The buttons of a step, at its right.
    private func buttons(@ViewBuilder _ content: () -> some View) -> some View {
        HStack(spacing: 8) {
            Spacer(minLength: 0)
            content()
        }
    }

    // MARK: What the steps do

    /// A folder picked in the Files dialog of this phone: counted here, before it is connected here.
    private func fromPhone(_ url: URL) {
        problem = nil
        busy = true
        Task {
            defer { busy = false }
            let count = await Task.detached {
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                return PhoneFolderReader.count(url)
            }.value
            picked = Picked(url: url, count: count)
        }
    }

    /// Connects the picked folder on this phone. The chat's agent learns it from what the phone offers.
    private func connectHere(_ url: URL) {
        do {
            _ = try model.connectPhoneFolder(url)
            dismiss()
        } catch {
            problem = String(localized: "This phone can’t keep a way back to this folder. Choose another one.")
        }
    }

    private func connect(_ chosen: String) {
        guard let client = model.client else { return }
        busy = true
        problem = nil
        Task {
            defer { busy = false }
            do {
                let folder = try await client.connectFolder(ConnectFolder(path: chosen, access: access, conversationId: conversationId))
                model.connected(folder)
                dismiss()
            } catch {
                problem = sentence(for: error)
            }
        }
    }

    private func sentence(for error: Error) -> String {
        switch error as? HomeError {
        case .unreachable: String(localized: "Your Bot Server is out of reach. Try again in a moment.")
        case .notFound: String(localized: "There is no folder at this path.")
        case let error?: error.message ?? String(localized: "That didn’t work. Try again.")
        case nil: String(localized: "That didn’t work. Try again.")
        }
    }
}
