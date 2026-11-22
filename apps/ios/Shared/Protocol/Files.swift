import Foundation

/// The numbers of packages/protocol/src/limits.ts that files need.
nonisolated enum FileLimits {
    /// Most files one message carries.
    static let perMessage = 10
    /// Largest file the home takes, in bytes: 15 MB as computers count them.
    static let maxBytes = 15 * 1024 * 1024

    /// How many of `picked` files still fit into a message that already carries `counted`.
    static func room(counted: Int, picked: Int) -> Int {
        max(0, min(picked, perMessage - counted))
    }
}

/// The body of `POST /v1/files`: `multipart/form-data` with the one field `file`.
nonisolated struct FileForm: Sendable {
    let boundary: String

    init(boundary: String = "wizards-\(UUID().uuidString)") {
        self.boundary = boundary
    }

    var contentType: String { "multipart/form-data; boundary=\(boundary)" }

    func body(_ data: Data, name: String, mime: String) -> Data {
        var body = Data()
        body.append(Data("--\(boundary)\r\n".utf8))
        body.append(Data("Content-Disposition: form-data; name=\"file\"; filename=\"\(Self.quoted(name))\"\r\n".utf8))
        body.append(Data("Content-Type: \(mime.isEmpty ? "application/octet-stream" : mime)\r\n\r\n".utf8))
        body.append(data)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        return body
    }

    /// A file name inside the quotes of the header, the way browsers write it.
    static func quoted(_ name: String) -> String {
        name.replacingOccurrences(of: "\"", with: "%22")
            .replacingOccurrences(of: "\r", with: "%0D")
            .replacingOccurrences(of: "\n", with: "%0A")
    }
}

/// The pictures a message shows as the picture itself; every other file is a row with its name.
nonisolated enum Pictures {
    static func shows(_ mime: String) -> Bool {
        ["image/png", "image/jpeg", "image/webp", "image/gif"].contains(mime)
    }
}

/// The seconds an agent has been at an answer, as the line under it says them.
nonisolated enum Elapsed {
    /// Below this the line stays away: most answers start sooner.
    static let shownFrom = 4

    /// "12 s" below a minute, "1:05" from one on; nil for the first seconds.
    static func label(seconds: Int) -> String? {
        guard seconds >= shownFrom else { return nil }
        if seconds < 60 { return "\(seconds) s" }
        let rest = seconds % 60
        return "\(seconds / 60):\(rest < 10 ? "0" : "")\(rest)"
    }
}
