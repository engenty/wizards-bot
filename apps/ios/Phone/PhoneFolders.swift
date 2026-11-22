import Foundation
import Observation
import PDFKit

/// A folder connected on this phone: picked in the Files dialog (iCloud Drive, On My iPhone or any
/// other provider) and kept as a bookmark. Its files stay where they are; the phone's own agent
/// reads them when a task needs them, and a file leaves the phone only after the person said yes.
nonisolated struct PhoneFolder: Codable, Hashable, Sendable, Identifiable {
    var id: String
    /// How the agents and the person name it: the folder's own name, made unique.
    var name: String
    var bookmark: Data
    var createdAt: Date
}

/// One file or folder inside a connected folder, by its path from the folder.
nonisolated struct PhoneFolderEntry: Hashable, Sendable {
    var path: String
    var isFolder: Bool
    var size: Int
}

/// What a connected folder holds, counted before it is connected.
nonisolated struct PhoneFolderCount: Hashable, Sendable {
    var files: Int
    var folders: Int
    var bytes: Int
    /// The counting stopped before the end.
    var more: Bool
}

/// The folders connected on this phone, kept on this phone only.
@Observable
final class PhoneFolders {
    private(set) var folders: [PhoneFolder] = []

    @ObservationIgnored private let file: URL

    init(file: URL = URL.applicationSupportDirectory.appending(path: "phone-folders.json")) {
        self.file = file
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let data = try? Data(contentsOf: file), let saved = try? JSONDecoder().decode([PhoneFolder].self, from: data) {
            folders = saved
        }
    }

    /// Connects a folder the person picked. Throws when the phone can't keep a way back to it.
    @discardableResult
    func connect(_ url: URL) throws -> PhoneFolder {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let bookmark = try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
        let name = Self.unique(url.lastPathComponent, among: folders.map(\.name))
        let folder = PhoneFolder(id: "pf_\(UUID().uuidString.prefix(8).lowercased())", name: name, bookmark: bookmark, createdAt: .now)
        folders.append(folder)
        save()
        return folder
    }

    func disconnect(_ id: String) {
        folders.removeAll { $0.id == id }
        save()
    }

    private func save() {
        guard let data = try? JSONEncoder().encode(folders) else { return }
        try? data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    /// "Trips", or "Trips 2" when a folder of that name is connected already.
    nonisolated static func unique(_ name: String, among taken: [String]) -> String {
        let base = name.isEmpty ? "Folder" : name
        guard taken.contains(base) else { return base }
        var number = 2
        while taken.contains("\(base) \(number)") { number += 1 }
        return "\(base) \(number)"
    }
}

/// Reads connected folders. Every path stays inside its folder: nothing hidden, no link out of it.
nonisolated enum PhoneFolderReader {
    /// Files one walk looks at, at most.
    static let walkLimit = 4000

    /// Opens a connected folder for the time of `work`.
    static func within<T>(_ folder: PhoneFolder, _ work: (URL) throws -> T) throws -> T {
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: folder.bookmark, options: [], relativeTo: nil, bookmarkDataIsStale: &stale) else {
            throw PhoneDataProblem(sentence: "The folder \(folder.name) is not there any more. The person can connect it again.")
        }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        return try work(url)
    }

    /// Everything in a folder, its subfolders included, in the order of the paths.
    static func entries(of root: URL, limit: Int = walkLimit) -> (entries: [PhoneFolderEntry], more: Bool) {
        guard let walk = FileManager.default.enumerator(
            at: root, includingPropertiesForKeys: [.isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey, .fileSizeKey],
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else { return ([], false) }
        let base = root.standardizedFileURL.path(percentEncoded: false)
        var found: [PhoneFolderEntry] = []
        for case let url as URL in walk {
            if found.count >= limit { return (found.sorted { $0.path.localizedStandardCompare($1.path) == .orderedAscending }, true) }
            let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey, .fileSizeKey])
            if values?.isSymbolicLink == true {
                walk.skipDescendants()
                continue
            }
            let path = String(url.standardizedFileURL.path(percentEncoded: false).dropFirst(base.count)).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            guard !path.isEmpty else { continue }
            found.append(PhoneFolderEntry(path: path, isFolder: values?.isDirectory == true, size: values?.fileSize ?? 0))
        }
        return (found.sorted { $0.path.localizedStandardCompare($1.path) == .orderedAscending }, false)
    }

    static func count(_ root: URL) -> PhoneFolderCount {
        let (entries, more) = entries(of: root)
        let files = entries.filter { !$0.isFolder }
        return PhoneFolderCount(files: files.count, folders: entries.count - files.count, bytes: files.reduce(0) { $0 + $1.size }, more: more)
    }

    /// The file at `path` inside `root`, or nil when the path leads out of it, to something hidden or nowhere.
    static func locate(_ path: String, in root: URL) -> URL? {
        let parts = path.split(separator: "/").map(String.init)
        guard !parts.isEmpty, !parts.contains(where: { $0 == ".." || $0 == "." || $0.hasPrefix(".") }) else { return nil }
        let url = parts.reduce(root) { $0.appending(path: $1) }
        let base = root.standardizedFileURL.resolvingSymlinksInPath().path(percentEncoded: false)
        let resolved = url.standardizedFileURL.resolvingSymlinksInPath().path(percentEncoded: false)
        guard resolved.hasPrefix(base.hasSuffix("/") ? base : base + "/") else { return nil }
        guard (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { return nil }
        return url
    }

    /// The text of a file: a text file as it is, a PDF as the text in it. Nil for any other file.
    static func text(of url: URL) -> String? {
        if url.pathExtension.lowercased() == "pdf" {
            return PDFDocument(url: url)?.string
        }
        guard let data = try? Data(contentsOf: url, options: .mappedIfSafe), data.count <= 4 * 1024 * 1024,
              !data.prefix(4096).contains(0) else { return nil }
        return String(data: data, encoding: .utf8) ?? String(data: data, encoding: .isoLatin1)
    }
}
