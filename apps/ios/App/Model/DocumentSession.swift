import Foundation
import Observation

/// The document open beside the chat: what the home has, what the person is writing, and what to
/// do when both changed.
@Observable
final class DocumentSession: Identifiable {
    let id: String
    private(set) var title: String
    /// The version this device last loaded or saved.
    private(set) var document: Document?
    /// The text on screen.
    var draft = ""
    var isEditing = false
    private(set) var isSaving = false
    /// A sentence when loading or saving did not work.
    private(set) var problem: String?
    /// The agent's newer version, when the person's edit started from an older one.
    private(set) var newer: Document?
    /// True when the home has a newer version than the one on screen and the person is editing.
    private(set) var homeIsNewer = false

    @ObservationIgnored private let client: HomeClient

    init(id: String, title: String, client: HomeClient) {
        self.id = id
        self.title = title
        self.client = client
        Task { await load() }
    }

    var isLoading: Bool { document == nil && problem == nil }
    var isDirty: Bool { document.map { $0.content != draft } ?? false }

    func load() async {
        do {
            show(try await client.document(id))
        } catch HomeError.notFound {
            problem = String(localized: "This document is no longer in your home.")
        } catch HomeError.unreachable {
            problem = String(localized: "Your home is out of reach. The document opens when it is back.")
        } catch {
            problem = (error as? HomeError)?.message ?? String(localized: "The document didn’t open. Try again.")
        }
    }

    /// Saves the draft. When the agent wrote meanwhile, `newer` holds its version and the person chooses.
    func save() async {
        guard let document, isDirty, !isSaving else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            show(try await client.save(id, SaveDocument(content: draft, baseVersion: document.version)), keepEditing: true)
        } catch HomeError.versionConflict(let theirs) {
            if let theirs {
                newer = theirs
            } else if let theirs = try? await client.document(id) {
                newer = theirs
            }
            problem = nil
        } catch HomeError.unreachable {
            problem = String(localized: "Your home is out of reach. Your text stays here. Save it again in a moment.")
        } catch {
            problem = (error as? HomeError)?.message ?? String(localized: "Saving didn’t work. Try again.")
        }
    }

    /// After a conflict: the person's text replaces the agent's newer version.
    func keepMine() async {
        guard let newer else { return }
        let mine = draft
        document = newer
        self.newer = nil
        draft = mine
        await save()
    }

    /// After a conflict: the agent's newer version replaces the person's text.
    func takeTheirs() {
        guard let newer else { return }
        show(newer)
    }

    /// The home says this document changed.
    func homeChanged(_ meta: DocumentMeta) {
        guard meta.id == id, meta.version > (document?.version ?? -1) else { return }
        title = meta.title
        if isDirty {
            homeIsNewer = true
        } else {
            Task { await load() }
        }
    }

    /// Loads the home's newer version over the person's text.
    func loadNewer() async {
        isEditing = false
        homeIsNewer = false
        document = nil
        await load()
    }

    private func show(_ document: Document, keepEditing: Bool = false) {
        self.document = document
        title = document.title
        draft = document.content
        newer = nil
        homeIsNewer = false
        problem = nil
        if !keepEditing { isEditing = false }
    }
}
