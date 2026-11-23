import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            switch model.screen {
            case .looking:
                ProgressView().controlSize(.small)
            case .first:
                FirstView()
            case .connect:
                ConnectView()
            case let .away(home, problem):
                AwayView(home: home, problem: problem)
            case let .chat(home, token):
                WebView(host: model.web)
                    .onAppear { model.web.show(home, token: token, local: model.isLocal(home)) }
                    .onChange(of: model.screen) { model.web.show(home, token: token, local: model.isLocal(home)) }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .sheet(isPresented: Bindable(model).showPhone) { PhoneSheet() }
        .sheet(isPresented: Bindable(model.link).asking) { LinkSheet() }
    }
}

/// The first screen: start a Bot Server on this Mac, or connect to one.
struct FirstView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 28) {
            VStack(spacing: 8) {
                Image(nsImage: NSApp.applicationIconImage)
                    .resizable()
                    .frame(width: 72, height: 72)
                Text("wizards.bot")
                    .font(.largeTitle.weight(.semibold))
                Text("Your own agents, on your own Bot Server.")
                    .foregroundStyle(.secondary)
            }
            if let found = model.local.found {
                FoundView(found: found)
            }
            HStack(alignment: .top, spacing: 16) {
                if model.local.canStart, model.local.found == nil {
                    Way(
                        symbol: "laptopcomputer",
                        title: "Start on this Mac",
                        text: "The app runs your Bot Server on this Mac and keeps it running. You need no terminal."
                    ) { Task { await model.startHere() } }
                }
                Way(
                    symbol: "network",
                    title: "Connect to a Bot Server",
                    text: "One that runs on another computer, or yours at wizards.bot."
                ) { model.screen = .connect }
            }
            .frame(maxWidth: 620)
            if let problem = model.local.problem {
                Text(problem)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 520)
                    .textSelection(.enabled)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(40)
        .disabled(model.local.busy)
        .overlay(alignment: .bottom) {
            if model.local.busy {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(model.local.step)
                }
                .padding(.bottom, 24)
                .foregroundStyle(.secondary)
            }
        }
    }
}

/// One of the two ways on the first screen.
private struct Way: View {
    let symbol: String
    let title: LocalizedStringKey
    let text: LocalizedStringKey
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 10) {
                Image(systemName: symbol)
                    .font(.title2)
                    .foregroundStyle(.tint)
                Text(title).font(.headline)
                Text(text)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(18)
            .frame(maxWidth: .infinity, minHeight: 150, alignment: .topLeading)
            .background(.quaternary.opacity(0.5), in: .rect(cornerRadius: 12))
            .contentShape(.rect(cornerRadius: 12))
        }
        .buttonStyle(.plain)
    }
}

/// "Connect to a Bot Server": its address and the code it shows.
struct ConnectView: View {
    @Environment(AppModel.self) private var model
    @State private var address = ""
    @State private var code = ""
    @State private var problem: String?
    @State private var busy = false
    @FocusState private var focus: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Connect to a Bot Server")
                .font(.title2.weight(.semibold))
            Text("Your Bot Server shows its address and a code with its QR: in its setup, or with wizards-bot pair in a terminal.")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Form {
                TextField("Address", text: $address, prompt: Text(verbatim: "ada.wizards.bot"))
                    .focused($focus)
                TextField("Code", text: $code, prompt: Text(verbatim: "K7QM-2RXD"))
            }
            .formStyle(.columns)
            .textFieldStyle(.roundedBorder)
            .onSubmit { Task { await connect() } }
            if let problem {
                Text(problem).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Button("Back") {
                    model.linked = nil
                    model.screen = .first
                }
                Spacer()
                if busy { ProgressView().controlSize(.small) }
                Button("Connect") { Task { await connect() } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(busy || address.isEmpty || code.isEmpty)
            }
        }
        .padding(40)
        .frame(maxWidth: 520)
        .onAppear {
            if let linked = model.linked {
                address = Address.label(linked.home)
                if linked.home.scheme == "http", !Address.isLocal(linked.home.host ?? "") {
                    address = linked.home.absoluteString
                }
                code = linked.code
            }
            focus = address.isEmpty
        }
    }

    private func connect() async {
        busy = true
        problem = await model.connect(address: address, code: code)
        busy = false
    }
}

/// The Bot Server the app knows does not answer.
struct AwayView: View {
    @Environment(AppModel.self) private var model
    let home: URL
    let problem: Health.Problem
    @State private var busy = false

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "bolt.horizontal.circle")
                .font(.system(size: 40))
                .foregroundStyle(.secondary)
            Text("Your Bot Server at \(Address.label(home)) does not answer.")
                .font(.title3.weight(.semibold))
                .multilineTextAlignment(.center)
            Text(AppModel.say(problem))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            HStack {
                if model.isLocal(home), model.local.canStart {
                    Button("Start it") { Task { await model.startHere() } }
                }
                Button("Try again") {
                    busy = true
                    Task {
                        await model.reach(home, code: nil)
                        busy = false
                    }
                }
                .keyboardShortcut(.defaultAction)
                Button("Connect to another Bot Server") { model.forget() }
            }
            .disabled(busy || model.local.busy)
        }
        .padding(40)
        .frame(maxWidth: 560)
    }
}
