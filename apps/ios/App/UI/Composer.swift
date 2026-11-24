import PhotosUI
import SwiftUI

/// Where the person writes or talks, and attaches files. Hold the microphone to say one message;
/// tap it for talk mode. The plus takes a photo, picks photos or files, or connects a folder.
struct Composer: View {
    @Environment(AppModel.self) private var model
    @State private var text = ""
    @State private var pressed = false
    @State private var holdTask: Task<Void, Never>?
    @State private var heldLong = false
    @FocusState private var focused: Bool
    @State private var camera = false
    @State private var photos = false
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var importing = false
    @State private var connecting = false
    @State private var scanning = false

    var body: some View {
        let voice = model.voice
        VStack(spacing: 8) {
            if let problem = voice.problem {
                Text(problem)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 12)
                    .onTapGesture { voice.problem = nil }
            }
            attached
            HStack(alignment: .bottom, spacing: 8) {
                if model.isPaired, voice.mode == .off {
                    plus
                }
                Group {
                    if voice.mode == .off {
                        TextField("Message", text: $text, axis: .vertical)
                            .lineLimit(1 ... 6)
                            .focused($focused)
                    } else {
                        // What is heard appears where the text would be typed.
                        Text(voice.heard.isEmpty ? listeningLabel : voice.heard)
                            .foregroundStyle(voice.heard.isEmpty ? .secondary : .primary)
                            .lineLimit(1 ... 6)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .accessibilityAddTraits(.updatesFrequently)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .frame(minHeight: 46)
                .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 23))

                microphone(voice)

                // While a reply is written an empty field offers Stop; something typed goes into the
                // reply, or, held or with ⌘↩, waits for after it.
                if voice.mode == .off, hasText || !model.attachments.isEmpty {
                    round("arrow.up", label: Text("Send"), prominent: true) { send() }
                        .disabled(!canSend)
                        .opacity(canSend ? 1 : 0.5)
                        .contextMenu {
                            if showsStop {
                                Button("Send now", systemImage: "arrow.up") { send() }
                                Button("Send after the answer", systemImage: "text.append") { send(later: true) }
                            }
                        }
                        .background {
                            Button("Send after the answer") { send(later: true) }
                                .keyboardShortcut(.return, modifiers: .command)
                                .disabled(!canSend || !showsStop)
                                .hidden()
                        }
                } else if showsStop {
                    round("stop.fill", label: Text("Stop the reply"), prominent: false) { model.stopReply() }
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 8)
        .frame(maxWidth: 720)
        .frame(maxWidth: .infinity)
        .animation(.snappy, value: voice.mode)
        .animation(.snappy, value: showsStop)
        .animation(.snappy, value: model.attachments.list.map(\.id))
        .fullScreenCover(isPresented: $camera) {
            CameraPicker { photo in took(photo) }
                .ignoresSafeArea()
        }
        .photosPicker(
            isPresented: $photos, selection: $photoItems, maxSelectionCount: max(1, model.attachments.room),
            selectionBehavior: .ordered, matching: .images
        )
        .onChange(of: photoItems) { chosen(photoItems) }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { picked(urls) }
        }
        .sheet(isPresented: $connecting) {
            if let conversationId = model.conversationId {
                FolderConnectSheet(conversationId: conversationId)
            }
        }
        .sheet(isPresented: $scanning) {
            ScannerSheet(
                hint: "Point the camera at the code of the invite.",
                otherwise: "Give the invite’s link to your agent instead. You can allow the camera in Settings.",
                read: { InviteLink($0) }
            ) { invite in
                scanning = false
                Task { await model.openInvite(invite) }
            }
        }
        .onChange(of: text) {
            if !text.isEmpty { voice.problem = nil }
            // The model on this device loads while the person types, when it is the one to answer.
            if !model.reachable, text.count == 1, let agent = model.currentAgent {
                model.onDevice.prewarm(
                    conversationId: agent.conversationId, agentName: agent.name, personName: model.link?.name,
                    earlier: model.messages(in: agent.conversationId)
                )
            }
        }
    }

    private var listeningLabel: String {
        model.voice.speaker.isSpeaking ? String(localized: "Speaking…") : String(localized: "Listening…")
    }

    private var showsStop: Bool {
        model.conversationId.map(model.isReplying) ?? false
    }

    private var hasText: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Something to send, and no file still on its way to the home.
    private var canSend: Bool {
        (hasText || !model.attachments.refs.isEmpty) && !model.attachments.isUploading
    }

    private func send(later: Bool = false) {
        guard canSend else { return }
        model.send(text, files: model.attachments.take(), later: later && showsStop)
        text = ""
    }

    // MARK: Files

    /// The files of the message above the field, and why one was not attached.
    @ViewBuilder
    private var attached: some View {
        let attachments = model.attachments
        if !attachments.isEmpty {
            // In rows, as many as the width takes. No scroll view of its own: one in the bar
            // under the chat moves the chat's own scrolling.
            TileRows(spacing: 4) {
                ForEach(attachments.list) { attachment in
                    AttachmentTile(attachment: attachment) {
                        attachments.remove(attachment.id, client: model.client)
                    }
                }
            }
            .padding(.horizontal, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        let failed = attachments.list.filter { $0.state == .failed }
        if attachments.notice != nil || !failed.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                if let notice = attachments.notice {
                    Text(notice)
                }
                ForEach(failed) { attachment in
                    Text("“\(attachment.name)” was not attached. \(attachment.why ?? "")")
                }
            }
            .font(.footnote)
            .foregroundStyle(.red)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
        }
    }

    /// The plus and its menu: a photo, photos, files, a folder, an invite.
    private var plus: some View {
        Menu {
            if CameraPicker.isAvailable {
                Button("Take a photo", systemImage: "camera") { camera = true }
            }
            Button("Photos", systemImage: "photo.on.rectangle") { photos = true }
            Button("File", systemImage: "doc") { importing = true }
            // Every agent of the home uses the connected folders; one shared with you does not.
            Divider()
            if model.currentAgent?.origin == .own {
                Button("Connect a folder", systemImage: "folder.badge.plus") { connecting = true }
            }
            // An invite is read by the home, whichever agent is on screen.
            if model.link != nil {
                Button("Scan an invite", systemImage: "qrcode.viewfinder") { scanning = true }
            }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(Color.primary)
                .frame(width: 46, height: 46)
                .glassEffect(.regular.interactive(), in: .circle)
                .contentShape(.circle)
        }
        .menuOrder(.fixed)
        .buttonStyle(.plain)
        .accessibilityLabel(Text("Files, photo, folder"))
    }

    private func took(_ photo: UIImage) {
        guard let client = model.client, let data = PictureShrink.forSending(photo) else { return }
        let format = DateFormatter()
        format.locale = Locale(identifier: "en_US_POSIX")
        format.dateFormat = "yyyy-MM-dd-HH-mm-ss"
        let stamp = format.string(from: .now)
        model.attachments.add([PickedFile(name: "photo-\(stamp).jpg", mime: "image/jpeg", data: data)], client: client)
    }

    private func chosen(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty, let client = model.client else { return }
        photoItems = []
        Task {
            var picked: [PickedFile] = []
            for item in items {
                if let photo = try? await item.loadTransferable(type: PickedPhoto.self) { picked.append(photo.file) }
            }
            model.attachments.add(picked, client: client)
        }
    }

    private func picked(_ urls: [URL]) {
        guard let client = model.client else { return }
        let room = model.attachments.room
        Task {
            let picked = await Task.detached { PickedFile.read(picked: Array(urls.prefix(room))) }.value
            model.attachments.add(picked, total: urls.count, client: client)
        }
    }

    /// The microphone: a short tap switches talk mode, a longer press listens until it ends.
    private func microphone(_ voice: Voice) -> some View {
        let talking = voice.mode == .talking
        return Image(systemName: talking ? "waveform" : "mic.fill")
            .font(.system(size: 18, weight: .semibold))
            .foregroundStyle(voice.mode == .off ? Color.primary : Color.onAccent)
            .symbolEffect(.variableColor.iterative, isActive: talking && !voice.speaker.isSpeaking)
            .frame(width: 46, height: 46)
            .background {
                if voice.mode != .off { Circle().fill(.tint) }
            }
            .glassEffect(.regular.interactive(), in: .circle)
            .scaleEffect(pressed ? 1.12 : 1)
            .animation(.snappy, value: pressed)
            .contentShape(.circle)
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in
                        guard !pressed else { return }
                        pressed = true
                        heldLong = false
                        guard voice.mode == .off else { return }
                        holdTask = Task {
                            try? await Task.sleep(for: .milliseconds(280))
                            guard !Task.isCancelled, pressed else { return }
                            heldLong = true
                            focused = false
                            voice.problem = nil
                            await voice.beginHold()
                        }
                    }
                    .onEnded { _ in
                        pressed = false
                        holdTask?.cancel()
                        holdTask = nil
                        if heldLong {
                            // Let go after holding: what was heard is the message.
                            if let heard = voice.endHold() { model.send(heard, spoken: true) }
                        } else {
                            toggleTalk(voice)
                        }
                    }
            )
            .sensoryFeedback(.impact(weight: .medium), trigger: voice.mode)
            .accessibilityElement()
            .accessibilityLabel(talking ? Text("Stop talking") : Text("Talk"))
            .accessibilityHint(talking ? Text(verbatim: "") : Text("Tap to talk and hear the replies. Hold to say one message."))
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { toggleTalk(voice) }
    }

    private func toggleTalk(_ voice: Voice) {
        if voice.mode == .talking {
            voice.stopTalk()
        } else if voice.mode == .off {
            focused = false
            voice.problem = nil
            Task { await voice.startTalk() }
        }
    }

    private func round(_ symbol: String, label: Text, prominent: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 18, weight: .bold))
                .foregroundStyle(prominent ? Color.onAccent : Color.primary)
                .frame(width: 46, height: 46)
                .background {
                    if prominent { Circle().fill(.tint) }
                }
                .glassEffect(.regular.interactive(), in: .circle)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .transition(.scale.combined(with: .opacity))
    }
}

/// Tiles side by side, on the next row where the width ends.
private struct TileRows: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = rows(for: subviews, width: proposal.width ?? .infinity)
        let width = rows.map { $0.reduce(0) { $0 + $1.width } + spacing * CGFloat(max(0, $0.count - 1)) }.max() ?? 0
        let height = rows.map { $0.map(\.height).max() ?? 0 }.reduce(0, +) + spacing * CGFloat(max(0, rows.count - 1))
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        var index = 0
        for row in rows(for: subviews, width: bounds.width) {
            var x = bounds.minX
            for size in row {
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + spacing
                index += 1
            }
            y += (row.map(\.height).max() ?? 0) + spacing
        }
    }

    private func rows(for subviews: Subviews, width: CGFloat) -> [[CGSize]] {
        var rows: [[CGSize]] = [[]]
        var used: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if !rows[rows.count - 1].isEmpty, used + spacing + size.width > width {
                rows.append([])
                used = 0
            }
            used += (rows[rows.count - 1].isEmpty ? 0 : spacing) + size.width
            rows[rows.count - 1].append(size)
        }
        return rows
    }
}
