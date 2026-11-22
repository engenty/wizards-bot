import SwiftUI

/// The first screen: connect this device to a home, or go on without one.
struct PairingView: View {
    @Environment(AppModel.self) private var model
    var isSheet = false

    @State private var address = ""
    @State private var code = ""
    @State private var isConnecting = false
    @State private var problem: String?
    @State private var showsScanner = false
    @FocusState private var focus: Field?

    private enum Field { case address, code }

    var body: some View {
        GeometryReader { proxy in
            ScrollView {
                form
                    // In the middle of a tall screen; a small one scrolls.
                    .frame(maxWidth: .infinity, minHeight: proxy.size.height)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .sheet(isPresented: $showsScanner) {
            ScannerSheet(
                hint: "Point the camera at the code on the pairing card.",
                otherwise: "Type the address and the code instead. You can allow the camera in Settings.",
                read: { PairingLink($0) }
            ) { link in
                showsScanner = false
                take(link)
            }
        }
        .onAppear { takePending() }
        .onChange(of: model.pendingLink) { takePending() }
    }

    private var form: some View {
        VStack(spacing: 28) {
            VStack(spacing: 14) {
                EngentyFigure(kind: .round)
                    .frame(width: 112, height: 112)
                Text("Connect to your home")
                    .font(.title.weight(.semibold))
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                Text("Your agent runs in your home, on your computer or a server. This device talks to it.")
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let note = model.pairingNote {
                Text(note)
                    .font(.callout)
                    .multilineTextAlignment(.center)
            }

            Button {
                showsScanner = true
            } label: {
                Label("Scan the code", systemImage: "qrcode.viewfinder")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(ActionButtonStyle(style: .primary))

            VStack(alignment: .leading, spacing: 12) {
                Text("Or type what the pairing card shows")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                VStack(spacing: 0) {
                    TextField("Address of your home", text: $address, prompt: Text("e.g. 192.168.1.20:4747"))
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focus, equals: .address)
                        .submitLabel(.next)
                        .onSubmit { focus = .code }
                        .padding(14)
                        .accessibilityLabel("Address of your home")
                    Divider().padding(.leading, 14)
                    TextField("Code", text: $code, prompt: Text("e.g. K7QM-2RXD"))
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .font(code.isEmpty ? .body : .body.monospaced())
                        .focused($focus, equals: .code)
                        .submitLabel(.go)
                        .onSubmit { connect() }
                        .padding(14)
                        .accessibilityLabel("Code")
                }
                .background(.fill.quaternary, in: .rect(cornerRadius: 14))

                if let problem {
                    Text(problem)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }

                Button {
                    connect()
                } label: {
                    Group {
                        if isConnecting {
                            ProgressView()
                        } else {
                            Text("Connect")
                        }
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(ActionButtonStyle(style: .plain))
                .disabled(isConnecting || HomeAddress.url(from: address) == nil || code.trimmingCharacters(in: .whitespaces).isEmpty)
            }

            if !isSheet {
                VStack(spacing: 8) {
                    Button("Use this device only") { model.useDeviceOnly() }
                        .font(.callout.weight(.medium))
                    Text("Without a home, the model on this device answers. It can’t reach your mail, calendar or files.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.top, 4)
            }
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 24)
        .frame(maxWidth: 460)
    }

    private func takePending() {
        guard let link = model.pendingLink else { return }
        model.pendingLink = nil
        take(link)
    }

    private func take(_ link: PairingLink) {
        address = link.home.absoluteString
        code = link.code
        connect()
    }

    private func connect() {
        guard !isConnecting, let home = HomeAddress.url(from: address) else { return }
        focus = nil
        isConnecting = true
        problem = nil
        Task {
            do {
                try await model.pair(home: home, code: code)
            } catch {
                problem = (error as? PairingProblem)?.message
            }
            isConnecting = false
        }
    }
}
