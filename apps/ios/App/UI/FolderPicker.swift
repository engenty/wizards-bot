import SwiftUI

/// Picks a folder of the Bot Server's computer; the person never types a path. Shows the chosen
/// folder as a chip with its name, its path from `~` and what it holds, or why the Bot Server
/// would not connect it. "Choose folder…" opens the folder browser.
struct FolderField: View {
    @Environment(AppModel.self) private var model
    /// The chosen folder's path; empty while none is chosen.
    @Binding var path: String
    /// A line instead of what the folder holds, e.g. that the Bot Server makes it.
    var hint: String? = nil

    @State private var browsing = false
    @State private var found: FolderPreview?
    @State private var refused: String?
    @State private var home: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if path.isEmpty {
                Button {
                    browsing = true
                } label: {
                    Label("Choose folder…", systemImage: "folder")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(ActionButtonStyle(style: .plain))
            } else {
                chip
                if let hint {
                    Text(verbatim: hint)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else if let refused {
                    Text(refused)
                        .font(.footnote)
                        .foregroundStyle(.red)
                } else if let found {
                    Text(FolderField.holds(found))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .sheet(isPresented: $browsing) {
            FolderBrowser(start: path.isEmpty ? nil : path) { chosen in
                path = chosen
            }
        }
        .task(id: path) { await look() }
    }

    private var chip: some View {
        HStack(spacing: 12) {
            Image(systemName: "folder.fill")
                .foregroundStyle(.tint)
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: FolderField.name(of: path))
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                Text(verbatim: FolderField.tilde(path, home: home))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 0)
            Button("Change") { browsing = true }
                .font(.subheadline)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.background, in: .rect(cornerRadius: 14))
        .overlay {
            RoundedRectangle(cornerRadius: 14)
                .strokeBorder(refused == nil ? AnyShapeStyle(.tint) : AnyShapeStyle(.red), lineWidth: 1.5)
        }
    }

    /// What the chosen folder holds, or why it cannot be connected.
    private func look() async {
        found = nil
        refused = nil
        guard !path.isEmpty, hint == nil, let client = model.client else { return }
        if home == nil { home = try? await client.browseFolders().home }
        do {
            found = try await client.previewFolder(path)
        } catch is CancellationError {
            return
        } catch let error as HomeError {
            refused = error.message ?? String(localized: "That didn’t work. Try again.")
        } catch {
            refused = String(localized: "That didn’t work. Try again.")
        }
    }

    /// "120 files in 8 folders · 4.2 MB", and when the counting stopped before the end.
    static func holds(_ found: FolderPreview) -> String {
        holds(files: found.files, folders: found.folders, bytes: found.bytes, more: found.more)
    }

    static func holds(files: Int, folders: Int, bytes: Int, more: Bool) -> String {
        var line = String(localized: "\(files) files")
        if folders > 0 { line += " " + String(localized: "in \(folders) folders") }
        line += " · " + Int64(bytes).formatted(.byteCount(style: .file))
        if more { line += " " + String(localized: "The folder holds more than that.") }
        return line
    }

    /// The separator of a path of the home's computer: a backslash on Windows.
    static func separator(of path: String) -> String {
        path.contains("\\") && !path.contains("/") ? "\\" : "/"
    }

    /// The folder's own name: the last part of its path.
    static func name(of path: String) -> String {
        path.split(separator: Character(separator(of: path))).last.map(String.init) ?? path
    }

    /// A path with the person's home folder as `~`.
    static func tilde(_ path: String, home: String?) -> String {
        guard let home else { return path }
        if path == home { return "~" }
        let separator = separator(of: home)
        return path.hasPrefix(home + separator) ? "~" + path.dropFirst(home.count) : path
    }
}

/// The folders of the Bot Server's computer, one level per screen: the person's home folder
/// first, a folder opened with a tap, back with the back button. The folder on screen is chosen
/// with "Choose"; "New folder" makes one where it is missing.
struct FolderBrowser: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    /// A folder chosen before: the browser opens at the folder it is in.
    let start: String?
    let onChoose: (String) -> Void

    @State private var stack: [String] = []

    var body: some View {
        NavigationStack(path: $stack) {
            FolderLevel(path: nil, choose: choose, close: { dismiss() }) { opened in
                stack.append(opened)
            }
            .navigationDestination(for: String.self) { path in
                FolderLevel(path: path, choose: choose, close: { dismiss() }) { opened in
                    stack.append(opened)
                }
            }
        }
        .presentationDetents([.large])
        .task { await openAtStart() }
    }

    private func choose(_ path: String) {
        onChoose(path)
        dismiss()
    }

    /// Opens the steps from the home folder down to the folder the chosen one is in.
    private func openAtStart() async {
        guard let start, let client = model.client, let listing = try? await client.browseFolders() else { return }
        let separator = FolderField.separator(of: listing.home)
        guard start.hasPrefix(listing.home + separator) else { return }
        let parts = start.dropFirst(listing.home.count + 1).split(separator: Character(separator)).dropLast()
        var at = listing.home
        stack = parts.map { part in
            at += separator + part
            return at
        }
    }
}

/// One folder of the folder browser: its folders, and the way to choose it.
private struct FolderLevel: View {
    @Environment(AppModel.self) private var model
    /// Nil: the person's home folder.
    let path: String?
    let choose: (String) -> Void
    let close: () -> Void
    let open: (String) -> Void

    @State private var listing: FolderListing?
    @State private var problem: String?
    @State private var naming = false
    @State private var newName = ""

    var body: some View {
        List {
            if let listing {
                if listing.folders.isEmpty {
                    Text("No folders in here.")
                        .foregroundStyle(.secondary)
                }
                ForEach(listing.folders) { folder in
                    NavigationLink(value: folder.path) {
                        Label(folder.name, systemImage: "folder")
                    }
                }
                // Where the picker starts, the person's other disks are a tap away.
                if listing.parent == nil, let disks = listing.disks, !disks.isEmpty, path == nil {
                    Section("Disks") {
                        ForEach(disks) { disk in
                            NavigationLink(value: disk.path) {
                                Label(disk.name, systemImage: "externaldrive")
                            }
                        }
                    }
                }
            } else if problem == nil {
                ProgressView()
                    .frame(maxWidth: .infinity)
            }
            if let problem {
                Text(problem)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        }
        .navigationTitle(listing.map { FolderField.name(of: $0.path) } ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel", action: close)
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Choose") { if let listing { choose(listing.path) } }
                    .disabled(listing == nil || listing?.path == listing?.home)
            }
            ToolbarItem(placement: .bottomBar) {
                Button("New folder", systemImage: "folder.badge.plus") {
                    newName = ""
                    naming = true
                }
                .labelStyle(.titleAndIcon)
                .disabled(listing == nil)
            }
        }
        .safeAreaInset(edge: .top) {
            if let listing, listing.path == listing.home {
                Text("Not your whole home folder: open a folder in it.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 6)
            }
        }
        .alert("New folder", isPresented: $naming) {
            TextField("Name of the new folder", text: $newName)
                .textInputAutocapitalization(.words)
                .autocorrectionDisabled()
            Button("Cancel", role: .cancel) {}
            Button("Make") { make() }
        }
        .task { await load() }
    }

    private func load() async {
        guard let client = model.client else { return }
        do {
            listing = try await client.browseFolders(path)
            problem = nil
        } catch {
            problem = (error as? HomeError)?.message ?? String(localized: "That didn’t work. Try again.")
        }
    }

    private func make() {
        let name = newName.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty, let listing, let client = model.client else { return }
        Task {
            do {
                let made = try await client.makeFolder(in: listing.path, named: name)
                await load()
                open(made.path)
            } catch {
                problem = (error as? HomeError)?.message ?? String(localized: "That didn’t work. Try again.")
            }
        }
    }
}
