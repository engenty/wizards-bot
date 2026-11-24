import SwiftUI

/// What the agent works with, one line each: the connected folders of the home's computer, the
/// folders connected on this phone and on the person's other devices, and the files the person sent
/// in this chat. A folder is added from here and taken away again (one of another device there);
/// the files stay with the messages they came in. Below, whether the agent may ask this phone, and
/// what it asked and what went back.
struct AgentData: View {
    @Environment(AppModel.self) private var model
    let agentId: String
    let name: String
    /// nil until the home said which folders are connected.
    let folders: [Folder]?
    /// What the person sent in this chat, newest first.
    let files: [FileRef]
    /// Connects a folder from this chat.
    let onConnect: () -> Void

    @State private var problem: String?
    @State private var addingService = false
    /// The connected folder open in the file browser.
    @State private var browsing: Folder?

    /// Folders connected on the person's other devices, with the device's name.
    private var elsewhere: [(folder: DeviceResource, device: String)] {
        (model.devices ?? []).filter { $0.id != model.link?.deviceId }.flatMap { device in
            (device.resources ?? []).filter { $0.kind == .folder || $0.kind == .connection }.map { (folder: $0, device: device.name) }
        }
    }

    var body: some View {
        let onPhone = model.phoneFolders.folders
        let services = model.phoneConnections.connections
        let elsewhere = elsewhere
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Data")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.secondary)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                Menu {
                    Button("Connect a folder", systemImage: "folder.badge.plus", action: onConnect)
                    Button("Sign in a service on this \(thisDevice)", systemImage: "link.badge.plus") { addingService = true }
                } label: {
                    Label("Add", systemImage: "plus")
                        .labelStyle(.iconOnly)
                        .font(.body.weight(.medium))
                        .frame(minWidth: 44, minHeight: 32)
                        .contentShape(.rect)
                }
            }
            if let folders, !folders.isEmpty || !onPhone.isEmpty || !services.isEmpty || !elsewhere.isEmpty || !files.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(folders.enumerated()), id: \.element.id) { index, folder in
                        if index > 0 { Divider() }
                        FolderLine(folder: folder, onProblem: { problem = $0 }, onOpen: { browsing = folder })
                    }
                    ForEach(Array(onPhone.enumerated()), id: \.element.id) { index, folder in
                        if index > 0 || !folders.isEmpty { Divider() }
                        PhoneFolderLine(folder: folder)
                    }
                    ForEach(Array(services.enumerated()), id: \.element.id) { index, service in
                        if index > 0 || !folders.isEmpty || !onPhone.isEmpty { Divider() }
                        PhoneServiceLine(service: service)
                    }
                    ForEach(Array(elsewhere.enumerated()), id: \.offset) { index, line in
                        if index > 0 || !folders.isEmpty || !onPhone.isEmpty || !services.isEmpty { Divider() }
                        ElsewhereLine(folder: line.folder, device: line.device)
                    }
                    if !files.isEmpty {
                        if !folders.isEmpty || !onPhone.isEmpty || !services.isEmpty || !elsewhere.isEmpty { Divider() }
                        Uploads(files: files)
                    }
                }
            } else if folders != nil {
                Text("Nothing yet. Connect a folder with +, or send files in the chat, and \(name) works with them.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            if let problem {
                Text(problem)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .padding(.top, 4)
            }
            AsksThisPhone(agentId: agentId, name: name)
                .padding(.top, 16)
        }
        .task { await model.loadDevices() }
        .sheet(isPresented: $addingService) { PhoneConnectionSheet() }
        .sheet(item: $browsing) { folder in ConnectedFolderView(folder: folder) }
    }
}

/// A service signed in on this phone. Signing it out asks first and removes its token from the Keychain.
private struct PhoneServiceLine: View {
    @Environment(AppModel.self) private var model
    let service: PhoneConnection
    @State private var asking = false

    var body: some View {
        if asking {
            VStack(alignment: .leading, spacing: 10) {
                Text("Sign “\(service.name)” out of this \(thisDevice)? Its token is removed.")
                    .font(.subheadline)
                HStack(spacing: 8) {
                    Spacer()
                    Button("Cancel") { asking = false }
                        .buttonStyle(ActionButtonStyle(style: .plain))
                    Button("Sign out") {
                        model.disconnectPhoneService(service.id)
                        asking = false
                    }
                    .buttonStyle(ActionButtonStyle(style: .danger))
                }
            }
            .padding(.vertical, 10)
            .transition(.opacity)
        } else {
            HStack(spacing: 12) {
                Image(systemName: "link")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(width: 20)
                    .accessibilityHidden(true)
                Text(service.name)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 8)
                Text("On this \(thisDevice)")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .layoutPriority(1)
                Button {
                    withAnimation(.snappy) { asking = true }
                } label: {
                    Image(systemName: "xmark")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 32, height: 44)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("Sign out \(service.name)"))
            }
            .frame(minHeight: 44)
            .accessibilityElement(children: .contain)
        }
    }
}

/// The word for this device in "On this iPhone".
private var thisDevice: String { UIDevice.current.model }

/// A folder connected on this phone: its files stay here and the phone's own agent reads them.
/// Disconnecting it asks first; nothing in the folder changes.
private struct PhoneFolderLine: View {
    @Environment(AppModel.self) private var model
    let folder: PhoneFolder
    @State private var asking = false

    var body: some View {
        if asking {
            VStack(alignment: .leading, spacing: 10) {
                Text("Disconnect “\(folder.name)” from this \(thisDevice)? The files stay where they are.")
                    .font(.subheadline)
                HStack(spacing: 8) {
                    Spacer()
                    Button("Cancel") { asking = false }
                        .buttonStyle(ActionButtonStyle(style: .plain))
                    Button("Disconnect") {
                        model.disconnectPhoneFolder(folder.id)
                        asking = false
                    }
                    .buttonStyle(ActionButtonStyle(style: .danger))
                }
            }
            .padding(.vertical, 10)
            .transition(.opacity)
        } else {
            HStack(spacing: 12) {
                Image(systemName: "folder")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(width: 20)
                    .accessibilityHidden(true)
                Text(folder.name)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 8)
                Text("On this \(thisDevice)")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .layoutPriority(1)
                Button {
                    withAnimation(.snappy) { asking = true }
                } label: {
                    Image(systemName: "xmark")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 32, height: 44)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("Disconnect \(folder.name)"))
            }
            .frame(minHeight: 44)
            .accessibilityElement(children: .contain)
        }
    }
}

/// A folder connected on another of the person's devices. It is disconnected there.
private struct ElsewhereLine: View {
    let folder: DeviceResource
    let device: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: folder.kind == .connection ? "link" : "folder")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .frame(width: 20)
                .accessibilityHidden(true)
            Text(folder.name)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 8)
            Text("On \(device)")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .frame(minHeight: 44)
        .accessibilityElement(children: .combine)
    }
}

/// Whether the agent may hand questions to this phone, and what it asked and what went back. The
/// list stays on this phone.
private struct AsksThisPhone: View {
    @Environment(AppModel.self) private var model
    let agentId: String
    let name: String
    @State private var open = false

    var body: some View {
        let entries = model.desk.entries(of: agentId)
        VStack(alignment: .leading, spacing: 0) {
            Toggle(isOn: Binding(
                get: { model.desk.isAllowed(agentId) },
                set: { model.desk.setAllowed(agentId, $0) }
            )) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(name) may ask this \(thisDevice)")
                    Text("Its model reads your calendar, reminders, contacts and the folders here, and sends back only the answer.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(minHeight: 44)
            if !entries.isEmpty {
                Divider()
                Button {
                    withAnimation(.snappy) { open.toggle() }
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "iphone")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .frame(width: 20)
                        Text("Asked of this \(thisDevice)")
                            .foregroundStyle(Color.primary)
                        Spacer(minLength: 8)
                        Text(entries.count, format: .number)
                            .font(.footnote.monospacedDigit())
                            .foregroundStyle(.secondary)
                        Image(systemName: "chevron.right")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.tertiary)
                            .rotationEffect(.degrees(open ? 90 : 0))
                    }
                    .frame(minHeight: 44)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(open ? .isSelected : [])
                if open {
                    VStack(alignment: .leading, spacing: 14) {
                        ForEach(entries) { entry in
                            AskedLine(entry: entry)
                        }
                    }
                    .padding(.leading, 12)
                    .padding(.vertical, 4)
                    .overlay(alignment: .leading) {
                        Rectangle()
                            .fill(Color(.separator))
                            .frame(width: 1)
                    }
                    .padding(.leading, 9)
                    .padding(.bottom, 6)
                    .transition(.opacity)
                }
            }
        }
    }
}

/// One question and what went back.
private struct AskedLine: View {
    let entry: HandoffEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(entry.text)
                .font(.subheadline.weight(.medium))
            switch entry.state {
            case .working:
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini)
                    Text("Working on it")
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
            case .answered, .declined, .unsent:
                if let answer = entry.answer {
                    Text(answer)
                        .font(.footnote)
                        .foregroundStyle(entry.state == .declined ? AnyShapeStyle(.secondary) : AnyShapeStyle(Color.primary))
                }
            }
            ForEach(entry.changed, id: \.self) { line in
                Text(line)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Text(footer)
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .accessibilityElement(children: .combine)
    }

    private var footer: String {
        let when = entry.at.formatted(.relative(presentation: .named))
        return switch entry.state {
        case .working: when
        case .answered: String(localized: "Sent back \(when)")
        case .declined: String(localized: "Not answered \(when)")
        case .unsent: String(localized: "Goes back when your Bot Server is in reach")
        }
    }
}

/// A connected folder on one line, with what the agents may do in it and the way out, which asks first.
private struct FolderLine: View {
    @Environment(AppModel.self) private var model
    let folder: Folder
    let onProblem: (String?) -> Void
    /// Opens the folder in the file browser.
    let onOpen: () -> Void
    @State private var asking = false
    @State private var busy = false

    var body: some View {
        if asking {
            VStack(alignment: .leading, spacing: 10) {
                Text("Disconnect “\(folder.name)”? The files stay where they are.")
                    .font(.subheadline)
                HStack(spacing: 8) {
                    Spacer()
                    Button("Cancel") { asking = false }
                        .buttonStyle(ActionButtonStyle(style: .plain))
                    Button("Disconnect") {
                        busy = true
                        Task {
                            let problem = await model.disconnect(folder)
                            busy = false
                            asking = false
                            onProblem(problem)
                        }
                    }
                    .buttonStyle(ActionButtonStyle(style: .danger))
                    .disabled(busy)
                }
            }
            .padding(.vertical, 10)
            .transition(.opacity)
        } else {
            HStack(spacing: 12) {
                Button(action: onOpen) {
                    HStack(spacing: 12) {
                        Image(systemName: "folder")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .frame(width: 20)
                            .accessibilityHidden(true)
                        Text(folder.name)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Spacer(minLength: 8)
                        Text(folder.access == .write ? LocalizedStringKey("Read and change") : LocalizedStringKey("Read only"))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .layoutPriority(1)
                    }
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityHint(Text("Opens the folder"))
                Button {
                    onProblem(nil)
                    withAnimation(.snappy) { asking = true }
                } label: {
                    Image(systemName: "xmark")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 32, height: 44)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("Disconnect \(folder.name)"))
            }
            .frame(minHeight: 44)
            .accessibilityElement(children: .contain)
        }
    }
}

/// What the person sent in this chat, folded into one line until it is opened.
private struct Uploads: View {
    let files: [FileRef]
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.snappy) { open.toggle() }
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "paperclip")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .frame(width: 20)
                    Text("Uploaded")
                        .foregroundStyle(Color.primary)
                    Spacer(minLength: 8)
                    Text(files.count, format: .number)
                        .font(.footnote.monospacedDigit())
                        .foregroundStyle(.secondary)
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(open ? 90 : 0))
                }
                .frame(minHeight: 44)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityValue(Text(files.count, format: .number))
            .accessibilityAddTraits(open ? .isSelected : [])
            if open {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(files) { file in
                        HStack(spacing: 12) {
                            Image(systemName: FileSymbol.name(for: file))
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .frame(width: 18)
                                .accessibilityHidden(true)
                            Text(file.name)
                                .font(.subheadline)
                                .lineLimit(1)
                                .truncationMode(.middle)
                            Spacer(minLength: 8)
                            Text(Int64(file.size), format: .byteCount(style: .file))
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(.secondary)
                                .layoutPriority(1)
                        }
                        .frame(minHeight: 36)
                        .accessibilityElement(children: .combine)
                    }
                }
                .padding(.leading, 12)
                .overlay(alignment: .leading) {
                    Rectangle()
                        .fill(Color(.separator))
                        .frame(width: 1)
                }
                .padding(.leading, 9)
                .padding(.bottom, 6)
                .transition(.opacity)
            }
        }
    }
}
