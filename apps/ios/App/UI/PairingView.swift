import SwiftUI
import VisionKit

/// Connects this device to a home: scan the pairing card's code or type what it shows, then the
/// Bot Server it is connected to. One level per screen, each with a back button.
struct PairingView: View {
    @Environment(AppModel.self) private var model
    var isSheet = false

    @State private var path: [Step] = []
    @State private var address = ""
    /// The link last scanned or handed over: its print counts for its own address.
    @State private var scanned: PairingLink?
    @State private var code = ""
    @State private var isConnecting = false
    @State private var problem: String?
    /// Goes up after a scanned code did not connect, so the camera reads again.
    @State private var scanRound = 0

    enum Step: Hashable { case typed, connected }

    /// The scan screen leads back to the chat when there is one behind it.
    private var leave: (() -> Void)? {
        isSheet || !model.needsPairing ? { model.closePairing() } : nil
    }

    var body: some View {
        NavigationStack(path: $path) {
            ScanScreen(
                back: leave,
                problem: problem,
                isConnecting: isConnecting,
                isCameraOn: path.isEmpty,
                scanRound: scanRound,
                onFound: take,
                typeInstead: {
                    problem = nil
                    path.append(.typed)
                }
            )
            .navigationDestination(for: Step.self) { step in
                switch step {
                case .typed:
                    TypedCodeScreen(
                        address: $address,
                        code: $code,
                        problem: problem,
                        isConnecting: isConnecting,
                        back: {
                            problem = nil
                            path.removeLast()
                        },
                        connect: connect
                    )
                case .connected:
                    ConnectedView(back: { path.removeAll() })
                }
            }
        }
        .tint(Petrol.accentMark)
        .focusEffectDisabled()
        .preferredColorScheme(.dark)
        .onAppear { takePending() }
        .onChange(of: model.pendingLink) { takePending() }
    }

    private func takePending() {
        guard let link = model.pendingLink else { return }
        model.pendingLink = nil
        take(link)
    }

    private func take(_ link: PairingLink) {
        address = link.home.absoluteString
        code = link.code
        scanned = link
        connect()
    }

    private func connect() {
        guard !isConnecting, let home = HomeAddress.url(from: address) else { return }
        isConnecting = true
        problem = nil
        Task {
            do {
                // The print counts for the address it came with, not for one typed over it.
                try await model.pair(home: home, code: code, print: scanned?.home == home ? scanned?.print : nil)
                // Back from the connected screen leads to the camera, not to a used code.
                path = [.connected]
            } catch {
                problem = (error as? PairingProblem)?.message
                scanRound += 1
            }
            isConnecting = false
        }
    }
}

/// The first level: the camera reads the pairing card's code.
private struct ScanScreen: View {
    @Environment(AppModel.self) private var model
    let back: (() -> Void)?
    let problem: String?
    let isConnecting: Bool
    /// False while another level is on top: the camera is off then.
    let isCameraOn: Bool
    let scanRound: Int
    let onFound: (PairingLink) -> Void
    let typeInstead: () -> Void

    private var hasCamera: Bool { DataScannerViewController.isSupported && DataScannerViewController.isAvailable }

    var body: some View {
        PetrolScreen(back: back) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Connect to your Bot Server")
                    .petrolHeading()
                Text("Point the camera at the code on the pairing card.")
                    .foregroundStyle(Petrol.ink2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let note = model.pairingNote {
                Text(verbatim: note)
                    .font(.callout)
                    .foregroundStyle(Petrol.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }
            camera
            if let problem {
                ProblemLine(text: problem)
            }
        } bottom: {
            Button("Or type what the pairing card shows", action: typeInstead)
                .buttonStyle(PetrolLinkStyle())
            if model.needsPairing {
                Button("Use this device only") { model.useDeviceOnly() }
                    .buttonStyle(PetrolLinkStyle(quiet: true))
                Text("Without a Bot Server, the model on this device answers. It can’t reach your mail, calendar or files.")
                    .font(.footnote)
                    .foregroundStyle(Petrol.ink3)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var camera: some View {
        ZStack {
            if hasCamera {
                Color.black
                if isCameraOn {
                    CodeScanner(read: { PairingLink($0) }, onFound: onFound)
                        .id(scanRound)
                }
                ViewfinderCorners()
                    .stroke(Petrol.accent, style: StrokeStyle(lineWidth: 4, lineCap: .round))
                    .padding(28)
                    .accessibilityHidden(true)
            } else {
                Petrol.card
                VStack(spacing: 10) {
                    Image(systemName: "camera")
                        .font(.title2)
                        .foregroundStyle(Petrol.accentMark)
                    Text("The camera isn’t available")
                        .font(.headline)
                        .foregroundStyle(Petrol.ink)
                    Text("Type the address and the code instead. You can allow the camera in Settings.")
                        .font(.footnote)
                        .foregroundStyle(Petrol.ink3)
                }
                .multilineTextAlignment(.center)
                .padding(24)
            }
            if isConnecting {
                Color.black.opacity(0.45)
                ProgressView()
                    .controlSize(.large)
                    .tint(Petrol.ink)
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .frame(maxWidth: .infinity)
        .clipShape(.rect(cornerRadius: 20))
    }
}

/// The second level: the address and the code as the pairing card shows them.
private struct TypedCodeScreen: View {
    @Binding var address: String
    @Binding var code: String
    let problem: String?
    let isConnecting: Bool
    let back: () -> Void
    let connect: () -> Void
    @FocusState private var focus: Field?

    private enum Field { case address, code }

    private var canConnect: Bool {
        !isConnecting && HomeAddress.url(from: address) != nil && !code.trimmingCharacters(in: .whitespaces).isEmpty
    }

    var body: some View {
        PetrolScreen(back: back) {
            Text("Type what the pairing card shows")
                .petrolHeading()
            VStack(alignment: .leading, spacing: 0) {
                field("Address of your Bot Server") {
                    TextField("Address of your Bot Server", text: $address, prompt: prompt("e.g. 192.168.1.20:4747"))
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focus, equals: .address)
                        .submitLabel(.next)
                        .onSubmit { focus = .code }
                }
                Petrol.divider
                    .frame(height: 1)
                    .padding(.leading, 16)
                field("Code") {
                    TextField("Code", text: $code, prompt: prompt("e.g. K7QM-2RXD"))
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .font(code.isEmpty ? .body : .body.monospaced())
                        .focused($focus, equals: .code)
                        .submitLabel(.go)
                        .onSubmit(submit)
                }
            }
            .background(Petrol.card, in: .rect(cornerRadius: 14))
            if let problem {
                ProblemLine(text: problem)
            }
        } bottom: {
            Button(action: submit) {
                Group {
                    if isConnecting {
                        ProgressView().tint(Petrol.onAccent)
                    } else {
                        Text("Connect")
                    }
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(PetrolButtonStyle())
            .disabled(!canConnect)
        }
        .onAppear {
            if address.isEmpty { focus = .address }
        }
    }

    private func field(_ label: LocalizedStringKey, @ViewBuilder input: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.footnote)
                .foregroundStyle(Petrol.ink3)
                .accessibilityHidden(true)
            input()
                .foregroundStyle(Petrol.ink)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private func prompt(_ text: LocalizedStringKey) -> Text {
        Text(text).foregroundStyle(Petrol.ink3)
    }

    private func submit() {
        guard canConnect else { return }
        focus = nil
        connect()
    }
}

/// Why a code did not connect, in the Bot Server's or the app's own words.
private struct ProblemLine: View {
    let text: String

    var body: some View {
        Label {
            Text(verbatim: text)
                .foregroundStyle(Petrol.ink)
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: "exclamationmark.circle")
                .foregroundStyle(Petrol.accentMark)
        }
        .font(.footnote)
    }
}

/// A link on Petrol: words in the accent mark colour with a 44-point target; `quiet` in ink.
struct PetrolLinkStyle: ButtonStyle {
    var quiet = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.callout.weight(.medium))
            .multilineTextAlignment(.center)
            .foregroundStyle(quiet ? Petrol.ink2 : Petrol.accentMark)
            .frame(maxWidth: .infinity, minHeight: 44)
            .contentShape(.rect)
            .opacity(configuration.isPressed ? 0.6 : 1)
            .hoverEffectDisabled()
    }
}

/// The four corners of a viewfinder, where the camera looks for the code.
private nonisolated struct ViewfinderCorners: Shape {
    var length: CGFloat = 32
    var radius: CGFloat = 12

    func path(in rect: CGRect) -> Path {
        var path = Path()
        let (l, r) = (length, radius)
        path.move(to: CGPoint(x: rect.minX, y: rect.minY + l))
        path.addArc(tangent1End: CGPoint(x: rect.minX, y: rect.minY), tangent2End: CGPoint(x: rect.minX + l, y: rect.minY), radius: r)
        path.addLine(to: CGPoint(x: rect.minX + l, y: rect.minY))
        path.move(to: CGPoint(x: rect.maxX - l, y: rect.minY))
        path.addArc(tangent1End: CGPoint(x: rect.maxX, y: rect.minY), tangent2End: CGPoint(x: rect.maxX, y: rect.minY + l), radius: r)
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY + l))
        path.move(to: CGPoint(x: rect.maxX, y: rect.maxY - l))
        path.addArc(tangent1End: CGPoint(x: rect.maxX, y: rect.maxY), tangent2End: CGPoint(x: rect.maxX - l, y: rect.maxY), radius: r)
        path.addLine(to: CGPoint(x: rect.maxX - l, y: rect.maxY))
        path.move(to: CGPoint(x: rect.minX + l, y: rect.maxY))
        path.addArc(tangent1End: CGPoint(x: rect.minX, y: rect.maxY), tangent2End: CGPoint(x: rect.minX, y: rect.maxY - l), radius: r)
        path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY - l))
        return path
    }
}
