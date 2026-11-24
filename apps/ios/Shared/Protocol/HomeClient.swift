import Foundation

/// A paired home: where it is and the token this device got from it.
nonisolated struct HomeLink: Codable, Hashable, Sendable {
    var baseURL: URL
    var token: String
    var deviceId: String
    /// The person's name as the home knows it.
    var name: String
}

/// What can go wrong when talking to the home, in the terms a device handles.
nonisolated enum HomeError: Error, Equatable, Sendable {
    /// The home did not answer: no network, switched off, or too slow.
    case unreachable
    /// 401: this device has to pair again.
    case unauthorized
    /// 409: someone answered the card first. Carries the card as the home has it.
    case alreadyAnswered(Card?)
    /// 409: the agent wrote a newer version meanwhile. Carries that version.
    case versionConflict(Document?)
    /// 409: the home uses model services the person has not said yes to. Carries them; nothing was kept.
    case needsConsent([ModelService])
    /// 404, with the home's sentence when it sent one.
    case notFound(String?)
    /// Any other error of the home, with its sentence for the person.
    case home(code: String, message: String)
    /// The home answered with something this app cannot read.
    case unreadable

    /// The home's own sentence, when it sent one.
    var message: String? {
        switch self {
        case .home(_, let message) where !message.isEmpty: message
        case .notFound(let message?) where !message.isEmpty: message
        default: nil
        }
    }
}

/// The routes of docs/protocol.md.
nonisolated struct HomeClient: Sendable {
    let baseURL: URL
    let token: String?

    init(baseURL: URL, token: String? = nil) {
        self.baseURL = baseURL
        self.token = token
    }

    init(_ link: HomeLink) {
        self.init(baseURL: link.baseURL, token: link.token)
    }

    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 20
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration)
    }()

    /// For an answer that waits for the person at the home's computer.
    private static let patientSession: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 900
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration)
    }()

    // MARK: Home and pairing

    func home(timeout: TimeInterval = 8) async throws -> HomeInfo {
        try await send("GET", "/v1/home", timeout: timeout)
    }

    func pair(_ request: PairRequest) async throws -> PairResponse {
        try await send("POST", "/v1/pair", body: request)
    }

    @discardableResult
    func updateDevice(_ update: UpdateDevice) async throws -> Device {
        try await send("PATCH", "/v1/device", body: update)
    }

    func signOut() async throws {
        try await run("DELETE", "/v1/device")
    }

    /// Pairs a watch through this phone.
    func addDevice(name: String, kind: DeviceKind) async throws -> PairResponse {
        try await send("POST", "/v1/devices", body: AddDevice(name: name, kind: kind))
    }

    // MARK: Agents and conversations

    func agents() async throws -> [Agent] {
        let envelope: AgentsEnvelope = try await send("GET", "/v1/agents")
        return envelope.agents
    }

    /// A page of messages, oldest first, ending before `before`.
    func messages(in conversationId: String, before: String? = nil, limit: Int = 50) async throws -> (messages: [Message], more: Bool) {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let before { query.append(URLQueryItem(name: "before", value: before)) }
        let envelope: MessagesEnvelope = try await send("GET", "/v1/conversations/\(conversationId)/messages", query: query)
        return (envelope.messages, envelope.more ?? false)
    }

    /// Stores the person's message. The agent's reply arrives on the event stream.
    func post(_ message: SendMessage, to conversationId: String, timeout: TimeInterval? = nil) async throws -> Message {
        let envelope: MessageEnvelope = try await send("POST", "/v1/conversations/\(conversationId)/messages", body: message, timeout: timeout)
        return envelope.message
    }

    func markRead(_ conversationId: String) async throws {
        try await run("POST", "/v1/conversations/\(conversationId)/read")
    }

    /// Stops the reply that is being written.
    func stop(_ conversationId: String) async throws {
        try await run("POST", "/v1/conversations/\(conversationId)/stop")
    }

    func importMessages(_ entries: [ImportMessages.Entry], into conversationId: String) async throws -> [Message] {
        let envelope: MessagesEnvelope = try await send(
            "POST", "/v1/conversations/\(conversationId)/import", body: ImportMessages(messages: entries)
        )
        return envelope.messages
    }

    /// The agent with its memory, its tasks and what it works on right now.
    func agentDetail(_ agentId: String) async throws -> AgentDetail {
        try await send("GET", "/v1/agents/\(agentId)")
    }

    /// The files the person sent in a conversation, newest first.
    func sentFiles(in conversationId: String) async throws -> [FileRef] {
        let envelope: FilesEnvelope = try await send("GET", "/v1/conversations/\(conversationId)/files")
        return envelope.files
    }

    // MARK: Files

    /// Uploads one file for the message being written. The home checks the bytes and may keep
    /// another picture (a phone's HEIC as a JPEG): the answer names what it kept.
    func upload(_ file: Data, name: String, mime: String) async throws -> FileRef {
        let form = FileForm()
        var request = request("POST", "/v1/files")
        request.timeoutInterval = 300
        request.setValue(form.contentType, forHTTPHeaderField: "Content-Type")
        request.httpBody = form.body(file, name: name, mime: mime)
        return try Self.decode(try await data(for: request, in: Self.patientSession))
    }

    /// Removes a file that was uploaded and not sent.
    func deleteFile(_ fileId: String) async throws {
        try await run("DELETE", "/v1/files/\(fileId)")
    }

    /// The bytes of a file.
    func file(_ fileId: String) async throws -> Data {
        var request = request("GET", "/v1/files/\(fileId)")
        request.setValue("*/*", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 120
        return try await data(for: request, in: Self.patientSession)
    }

    // MARK: Artifacts

    func artifact(_ id: String) async throws -> Artifact {
        try await send("GET", "/v1/artifacts/\(id)")
    }

    /// The address of an artifact's page: its `page` path on this home. It carries its own key and
    /// never the device token.
    func pageURL(_ page: String) -> URL? {
        guard page.hasPrefix("/") else { return nil }
        var base = baseURL.absoluteString
        while base.hasSuffix("/") { base.removeLast() }
        return URL(string: base + page)
    }

    // MARK: Folders

    func folders() async throws -> [Folder] {
        let envelope: FoldersEnvelope = try await send("GET", "/v1/folders")
        return envelope.folders
    }

    /// The folders inside `path`; without one, the person's home folder on that computer.
    func browseFolders(_ path: String? = nil) async throws -> FolderListing {
        try await send("GET", "/v1/folders/browse", query: path.map { [URLQueryItem(name: "path", value: $0)] } ?? [])
    }

    /// Makes a new folder `name` inside `parent` and lists it.
    func makeFolder(in parent: String, named name: String) async throws -> FolderListing {
        try await send("POST", "/v1/folders/new", body: MakeFolder(parent: parent, name: name))
    }

    func previewFolder(_ path: String) async throws -> FolderPreview {
        try await send("POST", "/v1/folders/preview", body: FolderPathBody(path: path))
    }

    func connectFolder(_ connect: ConnectFolder) async throws -> Folder {
        try await send("POST", "/v1/folders", body: connect)
    }

    /// Disconnects a folder; nothing on the disk changes.
    func disconnectFolder(_ folderId: String) async throws {
        try await run("DELETE", "/v1/folders/\(folderId)")
    }

    /// What the agents may do in a folder, and whether changes ask.
    func updateFolder(_ folderId: String, _ update: UpdateFolder) async throws -> Folder {
        try await send("PATCH", "/v1/folders/\(folderId)", body: update)
    }

    /// What a place in a connected folder holds, for the file browser.
    func folderEntries(_ folderId: String, path: String) async throws -> FolderEntries {
        try await send("GET", "/v1/folders/\(folderId)/entries", query: [URLQueryItem(name: "path", value: path)])
    }

    /// The bytes of a file in a connected folder.
    func folderFile(_ folderId: String, path: String) async throws -> Data {
        var request = request("GET", "/v1/folders/\(folderId)/file", query: [URLQueryItem(name: "path", value: path)])
        request.setValue("*/*", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 120
        return try await data(for: request, in: Self.patientSession)
    }

    /// Puts a file into a folder connected for changes; one there already goes to the Trash.
    func putFolderFile(_ folderId: String, path: String, bytes: Data) async throws {
        var request = request("PUT", "/v1/folders/\(folderId)/file", query: [URLQueryItem(name: "path", value: path)])
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 300
        request.httpBody = bytes
        _ = try await data(for: request, in: Self.patientSession)
    }

    /// A new folder, a new name or place, or to the Trash, in a folder connected for changes.
    func editFolder(_ folderId: String, _ edit: FolderEdit) async throws {
        var request = request("POST", "/v1/folders/\(folderId)/edit")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(edit)
        _ = try await data(for: request)
    }

    /// What agents and the person did in a connected folder, newest first.
    func folderActivity(_ folderId: String) async throws -> [FolderActivity] {
        let envelope: FolderActivityEnvelope = try await send("GET", "/v1/folders/\(folderId)/activity")
        return envelope.activity
    }

    /// Takes one change back.
    func undoFolderChange(_ folderId: String, activityId: String, index: Int) async throws {
        struct Undo: Encodable, Sendable { var activityId: String; var index: Int }
        let _: FolderActivityEnvelope = try await send(
            "POST", "/v1/folders/\(folderId)/undo", body: Undo(activityId: activityId, index: index)
        )
    }

    // MARK: What this device keeps

    /// Says what this device offers its agents, after each change on it.
    @discardableResult
    func offer(_ resources: [DeviceResource], agents: DeviceAgents? = nil) async throws -> Device {
        try await send("PUT", "/v1/device/resources", body: DeviceResources(resources: resources, agents: agents))
    }

    /// The person's devices, each with what it offers once it said so.
    func devices() async throws -> [Device] {
        let envelope: DevicesEnvelope = try await send("GET", "/v1/devices")
        return envelope.devices
    }

    /// The hand-offs that wait for this device, oldest first.
    func handoffs() async throws -> [Handoff] {
        let envelope: HandoffsEnvelope = try await send("GET", "/v1/handoffs")
        return envelope.handoffs
    }

    @discardableResult
    func answerHandoff(_ id: String, _ answer: AnswerHandoff) async throws -> Handoff {
        try await send("POST", "/v1/handoffs/\(id)/answer", body: answer)
    }

    // MARK: Cards

    /// The first answer wins; a later one throws `alreadyAnswered` with the card as it is.
    func answer(_ cardId: String, action: String, values: [String: FieldValue]? = nil) async throws -> Card {
        let envelope: CardEnvelope = try await send("POST", "/v1/cards/\(cardId)/answer", body: AnswerCard(action: action, values: values))
        return envelope.card
    }

    /// Every open card that waits for the person, oldest first.
    func items() async throws -> [Card] {
        let envelope: ItemsEnvelope = try await send("GET", "/v1/items")
        return envelope.items
    }

    // MARK: Documents

    func document(_ id: String) async throws -> Document {
        try await send("GET", "/v1/documents/\(id)")
    }

    /// Throws `versionConflict` with the newer version when the agent wrote meanwhile.
    func save(_ id: String, _ save: SaveDocument) async throws -> Document {
        try await send("PUT", "/v1/documents/\(id)", body: save)
    }

    func documents(in conversationId: String) async throws -> [DocumentMeta] {
        let envelope: DocumentsEnvelope = try await send("GET", "/v1/conversations/\(conversationId)/documents")
        return envelope.documents
    }

    // MARK: Models

    func models() async throws -> Models {
        try await send("GET", "/v1/models")
    }

    /// The person said yes on this device to these services. Answers the models as they are now.
    func agree(to services: [String]) async throws -> Models {
        try await send("POST", "/v1/consent", body: AgreeToServices(services: services))
    }

    /// Takes a yes back: the next message asks again.
    func takeBack(_ service: String) async throws -> Models {
        try await send("DELETE", "/v1/consent/\(service)")
    }

    // MARK: The person's record

    /// The person's record as the home has it, and what waits to be signed.
    func person() async throws -> PersonState {
        try await send("GET", "/v1/person")
    }

    /// The text the home asks this device to sign, for the key it holds.
    func personStart(key: String) async throws -> String {
        struct Start: Encodable, Sendable { var key: String }
        struct ToSign: Decodable, Sendable { var payload: String }
        let asked: ToSign = try await send("POST", "/v1/person/start", body: Start(key: key))
        return asked.payload
    }

    /// Hands a signed version in.
    func personSign(_ signed: SignedRecord) async throws -> PersonState {
        try await send("POST", "/v1/person/records", body: signed)
    }

    /// Has the home read an invite link. When it opens, the card that asks the person stands
    /// in the main agent's conversation; when not, the home says why.
    func openInvite(_ link: InviteLink) async throws -> InviteOpened {
        struct Open: Encodable, Sendable { var link: String }
        return try await send("POST", "/v1/invites/open", body: Open(link: link.text), timeout: 30)
    }

    // MARK: Requests

    /// A request for a route, with the device token.
    func request(_ method: String, _ path: String, query: [URLQueryItem] = []) -> URLRequest {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) ?? URLComponents()
        let base = components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path
        components.path = base + path
        components.queryItems = query.isEmpty ? nil : query
        var request = URLRequest(url: components.url ?? baseURL.appending(path: path))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return request
    }

    private func run(_ method: String, _ path: String) async throws {
        _ = try await data(for: request(method, path))
    }

    private func send<Response: Decodable & Sendable>(
        _ method: String, _ path: String, query: [URLQueryItem] = [], timeout: TimeInterval? = nil
    ) async throws -> Response {
        var request = request(method, path, query: query)
        if let timeout { request.timeoutInterval = timeout }
        return try Self.decode(try await data(for: request))
    }

    private func send<Body: Encodable & Sendable, Response: Decodable & Sendable>(
        _ method: String, _ path: String, body: Body, timeout: TimeInterval? = nil
    ) async throws -> Response {
        var request = request(method, path)
        if let timeout { request.timeoutInterval = timeout }
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        return try Self.decode(try await data(for: request))
    }

    @concurrent
    private func data(for request: URLRequest, in session: URLSession = Self.session) async throws -> Data {
        let data: Data, response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch {
            throw HomeError.unreachable
        }
        guard let http = response as? HTTPURLResponse else { throw HomeError.unreadable }
        guard (200 ..< 300).contains(http.statusCode) else { throw Self.error(status: http.statusCode, body: data) }
        return data
    }

    private static func decode<Response: Decodable>(_ data: Data) throws -> Response {
        do {
            return try JSONDecoder().decode(Response.self, from: data)
        } catch {
            throw HomeError.unreadable
        }
    }

    /// The error a status and its body stand for.
    static func error(status: Int, body: Data) -> HomeError {
        let parsed = try? JSONDecoder().decode(ErrorBody.self, from: body)
        switch (status, parsed?.error) {
        case (401, _), (_, "unauthorized"): return .unauthorized
        case (_, "already_answered"): return .alreadyAnswered(parsed?.card)
        case (_, "version_conflict"): return .versionConflict(parsed?.document)
        case (_, "needs_consent"): return .needsConsent(parsed?.services ?? [])
        case (404, _), (_, "not_found"): return .notFound(parsed?.message)
        // A gateway in front of the home answers for it while it is down.
        case (502 ... 504, nil): return .unreachable
        default: return .home(code: parsed?.error ?? "http_\(status)", message: parsed?.message ?? "")
        }
    }
}
