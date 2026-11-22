import Foundation

/// What a file is, as a small picture: a picture, a sheet, a text, a film, a sound.
nonisolated enum FileSymbol {
    /// The SF Symbol for a file.
    static func name(for file: FileRef) -> String {
        let name = file.name.lowercased()
        let ext = (name as NSString).pathExtension
        // A phone's HEIC is a picture too.
        if file.mime.hasPrefix("image/") { return "photo" }
        if ["xls", "xlsx", "csv", "tsv", "numbers"].contains(ext) { return "tablecells" }
        if file.mime == "application/pdf" || file.mime.hasPrefix("text/") || file.mime == "application/json"
            || ["pdf", "doc", "docx", "ppt", "pptx", "pages", "key", "txt", "md", "markdown", "rtf"].contains(ext) {
            return "doc.text"
        }
        if file.mime.hasPrefix("video/") { return "film" }
        if file.mime.hasPrefix("audio/") { return "music.note" }
        return "doc"
    }
}
