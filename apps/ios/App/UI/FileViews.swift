import QuickLook
import SwiftUI

/// The files of a message: pictures as themselves, other files as a row with name and size.
/// Tapping one opens it in Quick Look.
struct MessageFiles: View {
    @Environment(AppModel.self) private var model
    let files: [FileRef]
    /// The person's own message: its files stand at the right edge, as its text does.
    let mine: Bool

    @State private var opening: String?
    @State private var open: URL?
    @State private var problem: String?

    var body: some View {
        VStack(alignment: mine ? .trailing : .leading, spacing: 6) {
            ForEach(files) { file in
                Button {
                    show(file)
                } label: {
                    if Pictures.shows(file.mime) {
                        FilePicture(file: file)
                    } else {
                        FileRow(file: file)
                    }
                }
                .buttonStyle(.plain)
                .overlay {
                    if opening == file.id { ProgressView() }
                }
                .accessibilityLabel(Text(file.name))
                .accessibilityHint(Text("Opens the file"))
            }
            if let problem {
                Text(problem)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .quickLookPreview($open)
    }

    private func show(_ file: FileRef) {
        guard let client = model.client, opening == nil else { return }
        opening = file.id
        problem = nil
        Task {
            defer { opening = nil }
            do {
                open = try await FileCache.shared.openable(file, client: client)
            } catch {
                problem = String(localized: "Your home could not send this file. Try again later.")
            }
        }
    }
}

/// A picture of a message, fetched with the device token and kept.
struct FilePicture: View {
    @Environment(AppModel.self) private var model
    let file: FileRef
    /// Its longest side on screen.
    var side: CGFloat = 240

    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(maxWidth: side, maxHeight: side)
                    .clipShape(.rect(cornerRadius: 16))
            } else if failed {
                FileRow(file: file)
            } else {
                RoundedRectangle(cornerRadius: 16)
                    .fill(.fill.quaternary)
                    .frame(width: side * 0.75, height: side * 0.75)
                    .overlay { ProgressView() }
            }
        }
        .task(id: file.id) {
            guard image == nil, let client = model.client else { return }
            do {
                image = try await FileCache.shared.picture(file, side: side, client: client)
            } catch is CancellationError {
                return
            } catch {
                failed = true
            }
        }
    }
}

/// A file as a row: what it is, its name and its size.
struct FileRow: View {
    let file: FileRef

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: FileSymbol.name(for: file))
                .font(.title3)
                .foregroundStyle(.tint)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(file.name)
                    .font(.callout.weight(.medium))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(Int64(file.size), format: .byteCount(style: .file))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(maxWidth: 300, alignment: .leading)
        .background(.fill.quaternary, in: .rect(cornerRadius: 16))
        .accessibilityElement(children: .combine)
    }
}

/// A file attached to the message being written: its picture or what it is, with × to remove it.
struct AttachmentTile: View {
    let attachment: Attachment
    let onRemove: () -> Void

    var body: some View {
        ZStack {
            if let preview = attachment.preview {
                Image(uiImage: preview)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(width: 64, height: 64)
                    .clipped()
            } else {
                VStack(spacing: 4) {
                    Image(systemName: FileSymbol.name(for: FileRef(id: "", name: attachment.name, mime: attachment.mime, size: attachment.size)))
                        .font(.title3)
                        .foregroundStyle(.secondary)
                    Text(attachment.name)
                        .font(.caption2)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .padding(.horizontal, 4)
                }
                .frame(width: 64, height: 64)
            }
            if attachment.state == .uploading {
                Color.black.opacity(0.25)
                ProgressView()
                    .tint(.white)
            } else if attachment.state == .failed {
                Color.black.opacity(0.35)
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.white)
            }
        }
        .frame(width: 64, height: 64)
        .background(.fill.tertiary)
        .clipShape(.rect(cornerRadius: 12))
        .overlay(alignment: .topTrailing) {
            Button(action: onRemove) {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 20, height: 20)
                    .background(.black.opacity(0.6), in: .circle)
                    .frame(width: 32, height: 32)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .offset(x: 8, y: -8)
            .accessibilityLabel(Text("Remove \(attachment.name)"))
        }
        .padding(.top, 8)
        .padding(.trailing, 8)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(label)
    }

    private var label: Text {
        switch attachment.state {
        case .uploading: Text("\(attachment.name) is being uploaded…")
        case .failed: Text("“\(attachment.name)” was not attached.")
        case .ready: Text(attachment.name)
        }
    }
}
