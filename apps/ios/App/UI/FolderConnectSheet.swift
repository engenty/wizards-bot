import SwiftUI

/// Connects a folder from a chat. First where it is. A folder on this phone (iCloud Drive, On My
/// iPhone or any other place in Files) is connected on the phone: its files stay here, the phone's
/// own agent reads them when the home's agents ask, and the home only learns that it is there. A
/// folder of the home's computer is connected in three steps: which folder (the folder dialog of
/// that computer or its path), what it holds, and whether the agents only read it or also change
/// it; the chat's agent is told and answers there.
struct FolderConnectSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    /// The chat it is opened from.
    let conversationId: String

    /// Why the path field shows: the person asked for it, or no folder dialog opens.
    private enum Typing { case asked, noDialog }

    /// Where the folder is: on this phone or on the home's computer.
    private enum Place { case phone, home }

    /// A folder picked on this phone, counted before it is connected.
    private struct Picked {
        var url: URL
        var count: PhoneFolderCount
    }

    @State private var place: Place?
    @State private var typing: Typing?
    @State private var path = ""
    @State private var found: FolderPreview?
    @State private var access: FolderAccess = .read
    @State private var busy = false
    /// The wait for the folder dialog of the home's computer.
    @State private var picking: Task<Void, Never>?
    @State private var problem: String?
    @FocusState private var fieldFocused: Bool
    /// The Files dialog of this phone is open, for a folder.
    @State private var importing = false
    @State private var picked: Picked?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if let found {
                        review(found)
                    } else if let picked {
                        onPhone(picked)
                    } else if let typing {
                        pathField(typing)
                    } else if place == .home {
                        start
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
        .onDisappear { picking?.cancel() }
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
                note: "iCloud Drive, On My \(thisDevice) or another place in Files. The files stay here: your agents ask this \(thisDevice), and only the answer goes to your home.",
                symbol: "iphone"
            ) {
                problem = nil
                importing = true
            }
            placeChoice(
                title: "On your home’s computer",
                note: "Your home reads the files on its computer, in place.",
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

    private var start: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Choose a folder on your home’s computer. Once it is connected, your agents read its files.")
                .foregroundStyle(.secondary)
            if picking != nil {
                HStack(spacing: 10) {
                    ProgressView()
                        .controlSize(.small)
                    Text("The folder dialog is open on your home’s computer.")
                }
                .font(.subheadline)
                .foregroundStyle(.secondary)
            }
            // Side by side where the words fit, else one under the other.
            ViewThatFits(in: .horizontal) {
                buttons { startButtons }
                VStack(alignment: .trailing, spacing: 8) { startButtons }
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
    }

    @ViewBuilder
    private var startButtons: some View {
        Button("Back") {
            picking?.cancel()
            problem = nil
            place = nil
        }
        .buttonStyle(ActionButtonStyle(style: .plain))
        Button("Type the path") { type(.asked) }
            .buttonStyle(ActionButtonStyle(style: .plain))
        Button("Choose folder…") { choose() }
            .buttonStyle(ActionButtonStyle(style: .primary))
            .disabled(picking != nil)
    }

    /// A folder picked on this phone, before it is connected here.
    private func onPhone(_ folder: Picked) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 4) {
                Text(folder.url.lastPathComponent)
                    .foregroundStyle(.tertiary)
                    .lineLimit(2)
                    .truncationMode(.middle)
                Text(holds(files: folder.count.files, folders: folder.count.folders, bytes: folder.count.bytes, more: folder.count.more))
                Text("The files stay on this \(thisDevice). When your agents need something in them, they ask this \(thisDevice): its own model reads the files here and sends back only the answer. A file goes to your home only after you said yes here.")
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

    private func pathField(_ typing: Typing) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            if typing == .noDialog {
                Text("No folder dialog opens on your home’s computer. Type the path.")
                    .foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("The folder’s path")
                    .font(.subheadline.weight(.medium))
                TextField("The folder’s path", text: $path)
                    .textFieldStyle(.roundedBorder)
                    .font(.body.monospaced())
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .submitLabel(.next)
                    .focused($fieldFocused)
                    .onSubmit(next)
            }
            buttons {
                Button("Back") {
                    problem = nil
                    self.typing = nil
                    if typing == .noDialog { place = nil }
                }
                .buttonStyle(ActionButtonStyle(style: .plain))
                Button("Next", action: next)
                    .buttonStyle(ActionButtonStyle(style: .primary))
                    .disabled(busy || path.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .onAppear { fieldFocused = true }
    }

    private func review(_ found: FolderPreview) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 4) {
                Text(found.path)
                    .foregroundStyle(.tertiary)
                    .lineLimit(2)
                    .truncationMode(.middle)
                Text(holds(files: found.files, folders: found.folders, bytes: found.bytes, more: found.more))
                Text("The files stay where they are. Your home reads them in place and copies nothing.")
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 8) {
                Text("What may your agents do in this folder?")
                    .font(.subheadline.weight(.medium))
                choice(.read, title: "Read only", note: "Your agents read the files and change nothing.")
                choice(.write, title: "Read and change", note: "Your agents ask you before each change.")
            }
            buttons {
                Button("Back") {
                    problem = nil
                    self.found = nil
                }
                .buttonStyle(ActionButtonStyle(style: .plain))
                Button("Connect") { connect(found.path) }
                    .buttonStyle(ActionButtonStyle(style: .primary))
                    .disabled(busy)
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

    /// "120 files in 8 folders · 4.2 MB", and when the counting stopped before the end.
    private func holds(files: Int, folders: Int, bytes: Int, more: Bool) -> String {
        var line = String(localized: "\(files) files")
        if folders > 0 { line += " " + String(localized: "in \(folders) folders") }
        line += " · " + Int64(bytes).formatted(.byteCount(style: .file))
        if more { line += " " + String(localized: "The folder holds more than that.") }
        return line
    }

    // MARK: What the steps do

    /// Opens the folder dialog of the home's computer and waits for it.
    private func choose() {
        guard let client = model.client else { return }
        problem = nil
        picking = Task {
            defer { picking = nil }
            do {
                let picked = try await client.pickFolder()
                guard !Task.isCancelled else { return }
                if !picked.dialog {
                    type(.noDialog)
                } else if let chosen = picked.path {
                    path = chosen
                    await review(path: chosen)
                }
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                problem = sentence(for: error)
            }
        }
    }

    /// Shows the path field, starting at the person's home folder on that computer. Asked for while
    /// the folder dialog is awaited (the person is not at that computer), it ends the wait.
    private func type(_ why: Typing) {
        picking?.cancel()
        picking = nil
        problem = nil
        typing = why
        guard path.isEmpty, let client = model.client else { return }
        Task {
            guard let start = try? await client.browseFolders(), path.isEmpty else { return }
            path = start.path.hasSuffix(Self.separator(of: start.path)) ? start.path : start.path + Self.separator(of: start.path)
        }
    }

    private func next() {
        let chosen = Self.trimmed(path)
        guard !chosen.isEmpty, !busy else { return }
        Task { await review(path: chosen) }
    }

    private func review(path chosen: String) async {
        guard let client = model.client else { return }
        busy = true
        problem = nil
        defer { busy = false }
        do {
            found = try await client.previewFolder(chosen)
        } catch {
            problem = sentence(for: error)
        }
    }

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
        case .unreachable: String(localized: "Your home is out of reach. Try again in a moment.")
        case .notFound: String(localized: "There is no folder at this path.")
        case let error?: error.message ?? String(localized: "That didn’t work. Try again.")
        case nil: String(localized: "That didn’t work. Try again.")
        }
    }

    // MARK: Paths

    /// The separator of a path of the home's computer: a backslash on Windows.
    static func separator(of path: String) -> String {
        path.contains("\\") && !path.contains("/") ? "\\" : "/"
    }

    /// A typed path as the home takes it: without the separator it may end in.
    static func trimmed(_ typed: String) -> String {
        let path = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        let separator = separator(of: path)
        return path.count > 1 && path.hasSuffix(separator) ? String(path.dropLast()) : path
    }
}
