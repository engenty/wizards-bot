import QuickLook
import SwiftUI
import UniformTypeIdentifiers

/// A connected folder of the Bot Server's computer: what it holds, one place per screen, and what
/// agents and the person did in it, with a way to take a change back. It shows what the agents
/// reach and nothing else. In a folder connected for changes the person adds files, makes
/// folders, renames and moves to the Trash here, without a card.
struct ConnectedFolderView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let folder: Folder

    @State private var stack: [String] = []
    @State private var showing: Tab = .files
    @State private var current: Folder?

    enum Tab: Hashable { case files, activity }

    private var shown: Folder { current ?? folder }

    var body: some View {
        NavigationStack(path: $stack) {
            content(at: "")
                .navigationDestination(for: String.self) { path in
                    FolderPlace(folder: shown, path: path) { stack.append($0) }
                }
        }
        .presentationDetents([.large])
    }

    @ViewBuilder
    private func content(at path: String) -> some View {
        VStack(spacing: 0) {
            Picker("Show", selection: $showing) {
                Text("Files").tag(Tab.files)
                Text("What happened").tag(Tab.activity)
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            if showing == .files {
                FolderPlace(folder: shown, path: path) { stack.append($0) }
            } else {
                FolderActivityList(folder: shown)
            }
            FolderAccessFooter(folder: shown) { current = $0 }
        }
        .navigationTitle(shown.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Done") { dismiss() }
            }
        }
    }
}

/// One place in a connected folder: its folders and files.
private struct FolderPlace: View {
    @Environment(AppModel.self) private var model
    let folder: Folder
    let path: String
    let open: (String) -> Void

    @State private var listing: FolderEntries?
    @State private var problem: String?
    @State private var naming = false
    @State private var newName = ""
    @State private var renaming: FolderEntry?
    @State private var trashing: FolderEntry?
    @State private var importing = false
    @State private var preview: URL?
    @State private var busy: String?

    private var writes: Bool { folder.access == .write }

    var body: some View {
        List {
            if let listing {
                ForEach(listing.entries) { entry in
                    row(entry)
                }
                if listing.entries.isEmpty {
                    Text(writes ? "Nothing in here yet. Add files to put them here." : "No folders in here.")
                        .foregroundStyle(.secondary)
                }
                if listing.more {
                    Text("There is more in here than is listed.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            } else if problem == nil {
                ProgressView().frame(maxWidth: .infinity)
            }
            if let problem {
                Text(problem)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        }
        .navigationTitle(path.isEmpty ? folder.name : FolderField.name(of: path))
        .toolbar {
            if writes {
                ToolbarItemGroup(placement: .bottomBar) {
                    Button("New folder", systemImage: "folder.badge.plus") {
                        newName = ""
                        naming = true
                    }
                    .labelStyle(.titleAndIcon)
                    Spacer()
                    Button("Add files", systemImage: "square.and.arrow.down") { importing = true }
                        .labelStyle(.titleAndIcon)
                }
            }
        }
        .alert("New folder", isPresented: $naming) {
            TextField("Name of the new folder", text: $newName)
                .autocorrectionDisabled()
            Button("Cancel", role: .cancel) {}
            Button("Make") { act { try await $0.editFolder(folder.id, .make(join(newName))) } }
        }
        .alert("Rename", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("New name", text: $newName)
                .autocorrectionDisabled()
            Button("Cancel", role: .cancel) {}
            Button("Rename") {
                if let entry = renaming {
                    act { try await $0.editFolder(folder.id, .move(entry.path, to: join(newName))) }
                }
            }
        }
        .confirmationDialog(
            "Move “\(trashing?.name ?? "")” to the Trash?",
            isPresented: Binding(get: { trashing != nil }, set: { if !$0 { trashing = nil } }),
            titleVisibility: .visible
        ) {
            Button("Move to the Trash", role: .destructive) {
                if let entry = trashing { act { try await $0.editFolder(folder.id, .trash([entry.path])) } }
            }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            act { client in
                for url in urls {
                    let scoped = url.startAccessingSecurityScopedResource()
                    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                    let bytes = try Data(contentsOf: url)
                    try await client.putFolderFile(folder.id, path: join(url.lastPathComponent), bytes: bytes)
                }
            }
        }
        .quickLookPreview($preview)
        .refreshable { await load() }
        .task { await load() }
    }

    @ViewBuilder
    private func row(_ entry: FolderEntry) -> some View {
        Button {
            if entry.isFolder { open(entry.path) } else { show(entry) }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: entry.isFolder ? "folder" : "doc")
                    .foregroundStyle(.secondary)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: entry.name).lineLimit(1)
                    Text(verbatim: line(entry))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                if busy == entry.path { ProgressView() }
                if entry.isFolder {
                    Image(systemName: "chevron.right")
                        .font(.footnote)
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .buttonStyle(.plain)
        .swipeActions {
            if writes {
                Button("Move to the Trash", systemImage: "trash", role: .destructive) { trashing = entry }
                Button("Rename", systemImage: "pencil") {
                    newName = entry.name
                    renaming = entry
                }
            }
        }
    }

    private func line(_ entry: FolderEntry) -> String {
        let date = Timestamp.date(from: entry.changedAt)
            .map { $0.formatted(date: .abbreviated, time: .shortened) } ?? ""
        return entry.isFolder ? date : "\(Int64(entry.size).formatted(.byteCount(style: .file))) · \(date)"
    }

    private func join(_ name: String) -> String {
        let clean = name.trimmingCharacters(in: .whitespaces)
        return path.isEmpty ? clean : "\(path)/\(clean)"
    }

    private func load() async {
        guard let client = model.client else { return }
        do {
            listing = try await client.folderEntries(folder.id, path: path)
            problem = nil
        } catch {
            problem = (error as? HomeError)?.message ?? String(localized: "That didn’t work. Try again.")
        }
    }

    private func act(_ work: @escaping (HomeClient) async throws -> Void) {
        guard let client = model.client else { return }
        Task {
            do {
                try await work(client)
                problem = nil
            } catch {
                problem = (error as? HomeError)?.message ?? String(localized: "That didn’t work. Try again.")
            }
            await load()
        }
    }

    /// Opens a file in Quick Look from a copy in the app's own caches.
    private func show(_ entry: FolderEntry) {
        guard let client = model.client, busy == nil else { return }
        busy = entry.path
        Task {
            defer { busy = nil }
            do {
                let bytes = try await client.folderFile(folder.id, path: entry.path)
                let dir = FileManager.default.temporaryDirectory.appending(path: "folder-\(folder.id)", directoryHint: .isDirectory)
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                let file = dir.appending(path: entry.name)
                try bytes.write(to: file, options: .atomic)
                preview = file
            } catch {
                problem = String(localized: "Your Bot Server could not send this file. Try again later.")
            }
        }
    }
}

/// What agents and the person did in a folder, per turn, with a way to take a change back.
private struct FolderActivityList: View {
    @Environment(AppModel.self) private var model
    let folder: Folder

    @State private var rows: [FolderActivity]?
    @State private var problem: String?

    var body: some View {
        List {
            if let rows {
                if rows.isEmpty {
                    Text("Nothing was read or changed here yet.")
                        .foregroundStyle(.secondary)
                }
                ForEach(rows) { row in
                    Section {
                        ForEach(Array(row.changes.enumerated()), id: \.offset) { index, change in
                            HStack {
                                Text(verbatim: describe(change))
                                    .strikethrough(change.undone == true)
                                    .foregroundStyle(change.undone == true ? .secondary : .primary)
                                    .lineLimit(2)
                                Spacer(minLength: 8)
                                if change.undone != true, folder.access == .write {
                                    Button("Take back") { undo(row, index) }
                                        .font(.subheadline)
                                }
                            }
                        }
                    } header: {
                        Text(verbatim: header(row))
                    }
                }
            } else if problem == nil {
                ProgressView().frame(maxWidth: .infinity)
            }
            if let problem {
                Text(problem)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        }
        .refreshable { await load() }
        .task { await load() }
    }

    private func header(_ row: FolderActivity) -> String {
        let who = row.agentName ?? String(localized: "You")
        let when = Timestamp.date(from: row.at)
            .map { $0.formatted(date: .abbreviated, time: .shortened) } ?? ""
        let read = row.read > 0 ? " · " + String(localized: "read \(row.read) files") : ""
        return "\(who) · \(when)\(read)"
    }

    private func describe(_ change: FolderChange) -> String {
        let what: String = switch change.action {
        case "make": String(localized: "Made")
        case "write": String(localized: "Wrote")
        case "replace": String(localized: "Replaced")
        case "edit": String(localized: "Changed")
        case "copy": String(localized: "Copied")
        case "move": String(localized: "Moved")
        case "delete": String(localized: "Moved to the Trash:")
        default: change.action
        }
        if change.action == "move", let from = change.from { return "\(what) \(from) → \(change.path)" }
        return "\(what) \(change.path)"
    }

    private func load() async {
        guard let client = model.client else { return }
        do {
            rows = try await client.folderActivity(folder.id)
            problem = nil
        } catch {
            problem = (error as? HomeError)?.message ?? String(localized: "That didn’t work. Try again.")
        }
    }

    private func undo(_ row: FolderActivity, _ index: Int) {
        guard let client = model.client else { return }
        Task {
            do {
                try await client.undoFolderChange(folder.id, activityId: row.id, index: index)
                problem = nil
            } catch {
                problem = (error as? HomeError)?.message ?? String(localized: "That didn’t work. Try again.")
            }
            await load()
        }
    }
}

/// What the agents may do in the folder, and the "Always allow" the person gave on a card.
private struct FolderAccessFooter: View {
    @Environment(AppModel.self) private var model
    let folder: Folder
    let changed: (Folder) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Toggle("Your agents may change files here", isOn: Binding(
                get: { folder.access == .write },
                set: { on in update(UpdateFolder(access: on ? .write : .read)) }
            ))
            if folder.access == .write {
                Toggle(isOn: Binding(
                    get: { folder.allow == .always },
                    set: { on in update(UpdateFolder(allow: on ? .always : .ask)) }
                )) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Change without asking")
                        Text("Deleting always asks.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .font(.subheadline)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.bar)
    }

    private func update(_ update: UpdateFolder) {
        guard let client = model.client else { return }
        Task {
            if let folder = try? await client.updateFolder(folder.id, update) { changed(folder) }
        }
    }
}
