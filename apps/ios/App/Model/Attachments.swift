import Foundation
import Observation
import UIKit

/// A file picked for the message being written, before it is uploaded.
nonisolated struct PickedFile: Sendable {
    var name: String
    var mime: String
    /// Nil when the file is too large to be read for sending.
    var data: Data?
    var size: Int

    init(name: String, mime: String? = nil, data: Data?, size: Int? = nil) {
        self.name = name
        self.mime = mime ?? mimeType(forName: name)
        self.data = data
        self.size = size ?? data?.count ?? 0
    }

    /// Reads a file of this phone, or says how large it is when it is too large to send.
    static func read(_ url: URL) -> PickedFile? {
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        let picture = mimeType(forName: url.lastPathComponent).hasPrefix("image/")
        // A picture over the limit is read too: it is made smaller before it is sent.
        let readable = size <= FileLimits.maxBytes || (picture && size <= 4 * FileLimits.maxBytes)
        let data = readable ? try? Data(contentsOf: url) : nil
        if readable, data == nil { return nil }
        return PickedFile(name: url.lastPathComponent, data: data, size: size)
    }
}

/// A file attached to the message being written.
struct Attachment: Identifiable {
    enum State: Equatable { case uploading, ready, failed }

    let id = UUID()
    var name: String
    var mime: String
    var size: Int
    var state: State = .uploading
    /// The file as the home keeps it, once it is there.
    var ref: FileRef?
    /// Why it was not attached.
    var why: String?
    /// A small picture for the tile.
    var preview: UIImage?
    /// The bytes that were sent, kept for the chat so it does not ask the home for them.
    var sent: Data?
}

/// The files of the message being written. Each one is uploaded to the home as soon as it is
/// attached, a large picture made smaller first; the message then names the ids.
@Observable
final class Attachments {
    private(set) var list: [Attachment] = []
    /// A sentence when files were left out because the message is full.
    private(set) var notice: String?

    @ObservationIgnored private var uploads: [UUID: Task<Void, Never>] = [:]

    var isEmpty: Bool { list.isEmpty }
    var isUploading: Bool { list.contains { $0.state == .uploading } }
    /// The files the home has, to name in the message.
    var refs: [FileRef] { list.compactMap(\.ref) }
    /// How many more files the message takes. A file that was not attached does not count.
    var room: Int { FileLimits.room(counted: counted, picked: FileLimits.perMessage) }
    private var counted: Int { list.filter { $0.state != .failed }.count }

    /// Attaches files and starts their uploads. `picked` beyond the room are left out; `total`
    /// counts files that were not even read because they would not fit.
    func add(_ picked: [PickedFile], total: Int? = nil, client: HomeClient) {
        let taken = Array(picked.prefix(FileLimits.room(counted: counted, picked: picked.count)))
        notice = taken.count < (total ?? picked.count) ? Self.limitSentence : nil
        for file in taken {
            var attachment = Attachment(name: file.name, mime: file.mime, size: file.size)
            let id = attachment.id
            guard let data = file.data else {
                attachment.state = .failed
                attachment.why = Self.tooLargeSentence
                list.append(attachment)
                continue
            }
            list.append(attachment)
            uploads[id] = Task { await upload(id, data: data, name: file.name, mime: file.mime, client: client) }
        }
    }

    func remove(_ id: UUID, client: HomeClient?) {
        uploads[id]?.cancel()
        uploads[id] = nil
        if let ref = list.first(where: { $0.id == id })?.ref, let client {
            Task { try? await client.deleteFile(ref.id) }
        }
        list.removeAll { $0.id == id }
        notice = nil
    }

    /// Empties the field for sending and hands over the files the home has. Their bytes stay on
    /// this device, so the chat shows a picture at once.
    func take() -> [FileRef] {
        let refs = refs
        for attachment in list {
            if let ref = attachment.ref, let sent = attachment.sent { FileCache.shared.put(sent, for: ref.id) }
        }
        for task in uploads.values { task.cancel() }
        uploads = [:]
        list = []
        notice = nil
        return refs
    }

    static var limitSentence: String {
        String(localized: "A message carries \(FileLimits.perMessage) files at most. The rest was left out.")
    }

    static var tooLargeSentence: String {
        String(localized: "It is larger than 15 MB. Your Bot Server takes files up to that size.")
    }

    private func upload(_ id: UUID, data: Data, name: String, mime: String, client: HomeClient) async {
        let (sending, sentName, sentMime) = await Task.detached { PictureShrink.forSending(data, name: name, mime: mime) }.value
        let preview = sentMime.hasPrefix("image/")
            ? await Task.detached { PictureShrink.image(sending, longestSide: 192).map { UIImage(cgImage: $0) } }.value
            : nil
        update(id) { $0.preview = preview }
        guard sending.count <= FileLimits.maxBytes else {
            update(id) {
                $0.state = .failed
                $0.why = Self.tooLargeSentence
            }
            return
        }
        do {
            let ref = try await client.upload(sending, name: sentName, mime: sentMime)
            guard !Task.isCancelled else {
                // Removed while it went up: the home lets it go too.
                try? await client.deleteFile(ref.id)
                return
            }
            update(id) {
                $0.state = .ready
                $0.ref = ref
                $0.name = ref.name
                $0.mime = ref.mime
                $0.size = ref.size
                // The home kept another picture (a HEIC as a JPEG): the chat asks it for that one.
                $0.sent = ref.mime == sentMime ? sending : nil
            }
        } catch is CancellationError {
            return
        } catch {
            update(id) {
                $0.state = .failed
                $0.why = Self.sentence(for: error)
            }
        }
        uploads[id] = nil
    }

    private func update(_ id: UUID, _ change: (inout Attachment) -> Void) {
        guard let index = list.firstIndex(where: { $0.id == id }) else { return }
        change(&list[index])
    }

    private static func sentence(for error: Error) -> String {
        switch error as? HomeError {
        case .unreachable: String(localized: "Your Bot Server is out of reach. Try again in a moment.")
        case let error?: error.message ?? String(localized: "That didn’t work. Try again.")
        case nil: String(localized: "That didn’t work. Try again.")
        }
    }
}
