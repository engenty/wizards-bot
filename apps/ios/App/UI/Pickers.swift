import CoreTransferable
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// The phone's camera, for one photo to send.
struct CameraPicker: UIViewControllerRepresentable {
    static var isAvailable: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }

    let onPhoto: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.cameraCaptureMode = .photo
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ picker: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker

        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let photo = info[.originalImage] as? UIImage { parent.onPhoto(photo) }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}

/// A picture from the photo library as a file with its own name, e.g. `IMG_0042.HEIC`.
nonisolated struct PickedPhoto: Transferable {
    let file: PickedFile

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .image) { received in
            let name = received.file.lastPathComponent
            guard let file = PickedFile.read(received.file) else { throw CocoaError(.fileReadUnknown) }
            return PickedPhoto(file: PickedFile(name: name.isEmpty ? "photo" : name, data: file.data, size: file.size))
        }
    }
}

extension PickedFile {
    /// Files of this phone picked in the Files dialog: read while their access lasts.
    nonisolated static func read(picked urls: [URL]) -> [PickedFile] {
        urls.compactMap { url in
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            return read(url)
        }
    }

    /// The files of a folder of this phone, its subfolders included, in the order of their paths.
    /// Hidden files are left out. Only the first `room` are read; `count` says how many there are.
    nonisolated static func read(folder: URL, room: Int) -> (files: [PickedFile], count: Int) {
        let scoped = folder.startAccessingSecurityScopedResource()
        defer { if scoped { folder.stopAccessingSecurityScopedResource() } }
        guard let walk = FileManager.default.enumerator(
            at: folder, includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey],
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else { return ([], 0) }
        var found: [URL] = []
        // Enough to know whether the message is full; a large folder is not walked to its end.
        for case let url as URL in walk {
            if found.count >= 2000 { break }
            if (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true { found.append(url) }
        }
        found.sort { $0.path.localizedStandardCompare($1.path) == .orderedAscending }
        return (found.prefix(max(0, room)).compactMap { read($0) }, found.count)
    }
}
