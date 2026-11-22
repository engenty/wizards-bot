import Foundation
import Observation

/// The artifact open beside the chat: the page an agent wrote, and the address it is shown from.
@Observable
final class ArtifactSession: Identifiable {
    /// What the web view shows. It changes with the version, or when the address it holds ran
    /// out and the page has to load again; a fresh address alone does not reload the page, or
    /// what the person turned or picked in it would be lost.
    struct Shown: Equatable {
        var version: Int
        var url: URL
        var page: String
    }

    let id: String
    private(set) var title: String
    private(set) var artifact: Artifact?
    private(set) var shown: Shown?
    /// A sentence when the artifact did not load.
    private(set) var problem: String?
    /// The home sent the page without closing it off, so it is not shown.
    var refused = false

    /// How often the artifact is read again for an address that still works.
    static let every: Duration = .seconds(45 * 60)

    @ObservationIgnored private let client: HomeClient

    init(id: String, title: String, client: HomeClient) {
        self.id = id
        self.title = title
        self.client = client
    }

    var isLoading: Bool { shown == nil && problem == nil && !refused }

    /// Reads the artifact. The page loads anew for a new version, or when `reload` asks for it
    /// because the address on screen no longer opens.
    func load(reload: Bool = false) async {
        do {
            let artifact = try await client.artifact(id)
            self.artifact = artifact
            title = artifact.title
            problem = nil
            guard let url = client.pageURL(artifact.page) else {
                problem = String(localized: "The page didn’t open. Try again.")
                return
            }
            if reload || shown?.version != artifact.version {
                shown = Shown(version: artifact.version, url: url, page: artifact.page)
            }
        } catch is CancellationError {
            return
        } catch HomeError.notFound {
            problem = String(localized: "This page is no longer on your Bot Server.")
        } catch HomeError.unreachable {
            problem = String(localized: "Your Bot Server is out of reach. The page opens when it is back.")
        } catch {
            problem = (error as? HomeError)?.message ?? String(localized: "The page didn’t open. Try again.")
        }
    }

    /// The address on screen ran out, e.g. a view made anew after an hour: a fresh one loads.
    func refreshIfRunOut() async {
        if let shown, Artifact.pageOpens(shown.page) { return }
        await load(reload: true)
    }

    /// The agent wrote the artifact anew.
    func homeChanged(_ meta: ArtifactMeta) {
        guard meta.id == id, meta.version != shown?.version else { return }
        Task { await load() }
    }
}
