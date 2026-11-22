import Foundation
import ImageIO
import UIKit
import UniformTypeIdentifiers

/// Pictures as small as a reader needs them. Phone photos are several megabytes, which is slow
/// to upload and more than a vision model takes.
nonisolated enum PictureShrink {
    /// The longest side a photo is sent with.
    static let longestSide = 2400

    /// The file as it is sent: a large JPEG, PNG or WebP (and any picture over the limit) made
    /// smaller as a JPEG; everything else, a phone's HEIC among it, as it is. The home keeps a
    /// HEIC as a JPEG itself.
    static func forSending(_ data: Data, name: String, mime: String) -> (data: Data, name: String, mime: String) {
        let common = ["image/jpeg", "image/png", "image/webp"].contains(mime)
        guard (common && data.count >= 1_200_000) || (mime.hasPrefix("image/") && data.count > FileLimits.maxBytes),
              let smaller = jpeg(data, longestSide: longestSide), smaller.count < data.count else {
            return (data, name, mime)
        }
        return (smaller, (name as NSString).deletingPathExtension + ".jpg", "image/jpeg")
    }

    /// A photo of the camera, as it is sent.
    static func forSending(_ photo: UIImage) -> Data? {
        let longest = max(photo.size.width, photo.size.height) * photo.scale
        let scale = min(1, CGFloat(longestSide) / max(longest, 1))
        let size = CGSize(width: (photo.size.width * photo.scale * scale).rounded(), height: (photo.size.height * photo.scale * scale).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let drawn = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            photo.draw(in: CGRect(origin: .zero, size: size))
        }
        return drawn.jpegData(compressionQuality: 0.86)
    }

    /// A picture no larger than `longestSide`, turned the way it is looked at.
    static func image(_ data: Data, longestSide: Int) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: longestSide,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }

    private static func jpeg(_ data: Data, longestSide: Int) -> Data? {
        guard let image = image(data, longestSide: longestSide) else { return nil }
        let out = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.86] as CFDictionary)
        return CGImageDestinationFinalize(destination) ? out as Data : nil
    }
}

/// The type of a file by its name, as the home is told it.
nonisolated func mimeType(forName name: String) -> String {
    UTType(filenameExtension: (name as NSString).pathExtension)?.preferredMIMEType ?? "application/octet-stream"
}

/// The files of messages this device has seen. A file never changes under its id, so its bytes
/// are kept on the disk; pictures are also kept small in memory.
@MainActor
final class FileCache {
    static let shared = FileCache()

    private let pictures = NSCache<NSString, UIImage>()
    private var loading: [String: Task<Data, Error>] = [:]
    private let folder = URL.cachesDirectory.appending(path: "files", directoryHint: .isDirectory)

    private init() {
        pictures.countLimit = 120
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    /// Keeps bytes this device just sent, so the chat shows them without asking the home.
    func put(_ data: Data, for fileId: String) {
        try? data.write(to: place(of: fileId), options: .atomic)
    }

    /// The bytes of a file: from the disk, or from the home.
    func data(for fileId: String, client: HomeClient) async throws -> Data {
        let place = place(of: fileId)
        if let task = loading[fileId] { return try await task.value }
        let task = Task.detached {
            if let kept = try? Data(contentsOf: place) { return kept }
            let data = try await client.file(fileId)
            try? data.write(to: place, options: .atomic)
            return data
        }
        loading[fileId] = task
        defer { loading[fileId] = nil }
        return try await task.value
    }

    /// A picture of a file for the chat, no larger than `side` points.
    func picture(_ file: FileRef, side: CGFloat, client: HomeClient) async throws -> UIImage {
        let pixels = Int(side * 3)
        let key = "\(file.id) \(pixels)" as NSString
        if let kept = pictures.object(forKey: key) { return kept }
        let data = try await data(for: file.id, client: client)
        let made = await Task.detached { PictureShrink.image(data, longestSide: pixels).map { UIImage(cgImage: $0) } }.value
        guard let made else { throw HomeError.unreadable }
        pictures.setObject(made, forKey: key)
        return made
    }

    /// The file on the disk under its own name, for Quick Look.
    func openable(_ file: FileRef, client: HomeClient) async throws -> URL {
        let data = try await data(for: file.id, client: client)
        let dir = URL.temporaryDirectory.appending(path: "open/\(file.id)", directoryHint: .isDirectory)
        let name = file.name.replacingOccurrences(of: "/", with: "-")
        let url = dir.appending(path: name.isEmpty ? "file" : name)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: url.path) { try data.write(to: url, options: .atomic) }
        return url
    }

    private func place(of fileId: String) -> URL {
        folder.appending(path: fileId.replacingOccurrences(of: "/", with: "-"))
    }
}
