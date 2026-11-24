import ServiceManagement
import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            switch model.screen {
            case .looking:
                ProgressView().controlSize(.small).petrolGround()
            case .first:
                if model.local.stage != nil { StartingView() } else { FirstView() }
            case .connect:
                ConnectView()
            case let .away(home, problem):
                if model.local.stage != nil { StartingView() } else { AwayView(home: home, problem: problem) }
            case let .chat(home, token):
                WebView(host: model.web)
                    .onAppear { model.web.show(home, token: token, local: model.isLocal(home)) }
                    .onChange(of: model.screen) { model.web.show(home, token: token, local: model.isLocal(home)) }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .modifier(WindowLook(native: !isChat))
        .sheet(isPresented: Bindable(model).showPhone) { PhoneSheet() }
        .sheet(isPresented: Bindable(model.link).asking) { LinkSheet() }
    }

    private var isChat: Bool {
        if case .chat = model.screen { return true }
        return false
    }
}

/// The first screen: start a Bot Server on this Mac, or connect to one.
struct FirstView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 24)
            VStack(spacing: 22) {
                VStack(spacing: 10) {
                    EngentyFigure(kind: .round, lively: true)
                        .frame(width: 72, height: 72)
                        .padding(.bottom, 4)
                    Text(verbatim: "wizards.bot")
                        .font(.system(size: 24, weight: .semibold))
                        .foregroundStyle(Petrol.ink)
                    Text("Your own agents. They work on this Mac, or on a Bot Server you already have.")
                        .font(.system(size: 13))
                        .foregroundStyle(Petrol.ink2)
                        .multilineTextAlignment(.center)
                }
                if let found = model.local.found {
                    FoundView(found: found)
                }
                PetrolCard {
                    if model.local.canStart, model.local.found == nil {
                        Way(
                            symbol: "laptopcomputer",
                            title: "Start on this Mac",
                            text: "Keeps working when the window is closed."
                        ) { Task { await model.startHere() } }
                        PetrolDivider()
                    }
                    Way(
                        symbol: "link",
                        title: "Connect to a Bot Server",
                        text: "At wizards.bot, on another computer, or your own."
                    ) { model.screen = .connect }
                }
                .frame(width: 440)
                if model.local.busy {
                    ProgressView().controlSize(.small)
                }
                if let problem = model.local.problem {
                    Text(problem)
                        .font(.system(size: 12))
                        .foregroundStyle(Petrol.rose)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 440)
                        .textSelection(.enabled)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            .disabled(model.local.busy)
            Spacer(minLength: 24)
            (Text("Prefer the terminal? ") + Text(verbatim: "npx wizards bot install").monospaced())
                .font(.system(size: 11))
                .foregroundStyle(Petrol.ink3)
                .textSelection(.enabled)
                .padding(.bottom, 20)
        }
        .padding(.horizontal, 40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .petrolGround()
    }
}

/// One of the two ways on the first screen: a row of its card.
private struct Way: View {
    let symbol: String
    let title: LocalizedStringKey
    let text: LocalizedStringKey
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 14) {
                Image(systemName: symbol)
                    .font(.system(size: 17))
                    .foregroundStyle(Petrol.accentMark)
                    .frame(width: 24)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(Petrol.ink)
                    Text(text)
                        .font(.system(size: 12))
                        .foregroundStyle(Petrol.ink3)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Petrol.ink3)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 13)
            .contentShape(.rect)
        }
        .buttonStyle(RowPress())
        .focusEffectDisabled()
    }
}

/// A card's row that is a button: a little lighter while pressed, no outline.
private struct RowPress: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Petrol.cardFocus : .clear)
    }
}

/// While the app starts its Bot Server: what it did and what it does now.
struct StartingView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let local = model.local
        VStack(spacing: 0) {
            Spacer(minLength: 24)
            VStack(alignment: .leading, spacing: 14) {
                PetrolHeading("Starting your Bot Server")
                PetrolCard {
                    let steps = rows(local)
                    ForEach(Array(steps.enumerated()), id: \.offset) { index, row in
                        if index > 0 { PetrolDivider() }
                        StepRow(row: row)
                    }
                }
                if local.stage == .approval {
                    HStack(spacing: 12) {
                        Text("Only if macOS asks: turn on wizards under Login Items.")
                            .font(.system(size: 12))
                            .foregroundStyle(Petrol.noticeInk)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 8)
                        Button("Open Login Items") { SMAppService.openSystemSettingsLoginItems() }
                            .petrolButton(.secondary)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 11)
                    .background(Petrol.noticeCard, in: .rect(cornerRadius: 10))
                }
            }
            .frame(width: 400)
            Spacer(minLength: 24)
            HStack {
                if local.stage == .approval {
                    Button("Back") { local.cancelApproval() }.petrolButton(.plain)
                }
                Spacer()
            }
            .frame(height: 34)
            .padding(.horizontal, 24)
            .padding(.bottom, 16)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .petrolGround()
    }

    /// The rows follow what `LocalHome.start` and `takeOver` do, in their order.
    private func rows(_ local: LocalHome) -> [StepRow.Row] {
        let order: [LocalHome.Stage] = [.stopping, .copying, .programs, .background, .approval, .starting, .started]
        let now = order.firstIndex(of: local.stage ?? .programs) ?? 0
        func state(_ stage: LocalHome.Stage, through last: LocalHome.Stage? = nil) -> StepRow.State {
            let first = order.firstIndex(of: stage) ?? 0
            let end = order.firstIndex(of: last ?? stage) ?? first
            if now > end { return .done }
            if now >= first { return .now }
            return .next
        }
        var rows: [StepRow.Row] = []
        if local.takesOver {
            rows.append(.init(
                doing: "Stopping the Bot Server of wizards bot install",
                done: "Stopped the Bot Server of wizards bot install",
                state: state(.stopping)
            ))
            if local.copiesData {
                rows.append(.init(doing: "Keeping a copy of your data", done: "Kept a copy of your data", state: state(.copying)))
            }
        }
        rows.append(.init(doing: "Finding your programs", done: "Found your programs", state: state(.programs)))
        rows.append(.init(
            doing: "Allowing it to run in the background",
            done: "Allowed to run in the background",
            state: state(.background, through: .approval)
        ))
        rows.append(.init(doing: "Starting", done: "Started", state: state(.starting), trailing: true))
        return rows
    }
}

/// One row of the starting screen: a check when done, a spinner while it runs.
private struct StepRow: View {
    enum State { case done, now, next }

    struct Row {
        let doing: LocalizedStringKey
        let done: LocalizedStringKey
        let state: State
        /// The row names where the Bot Server runs.
        var trailing = false
    }

    let row: Row

    var body: some View {
        HStack(spacing: 12) {
            Group {
                switch row.state {
                case .done:
                    Image(systemName: "checkmark")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(Petrol.ok)
                case .now:
                    ProgressView().controlSize(.mini)
                case .next:
                    Circle().stroke(Petrol.ink3.opacity(0.5), lineWidth: 1).frame(width: 7, height: 7)
                }
            }
            .frame(width: 16)
            Text(row.state == .done ? row.done : row.doing)
                .font(.system(size: 13))
                .foregroundStyle(row.state == .next ? Petrol.ink3 : Petrol.ink)
            Spacer(minLength: 8)
            if row.trailing {
                Text("this Mac · \(String(Address.port))")
                    .font(.system(size: 12).monospaced())
                    .foregroundStyle(Petrol.ink3)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
    }
}

/// "Connect to a Bot Server": its address and the code it shows.
struct ConnectView: View {
    @Environment(AppModel.self) private var model
    @State private var address = ""
    @State private var code = ""
    @State private var problem: String?
    @State private var busy = false
    @FocusState private var focus: Field?

    private enum Field { case address, code }

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 24)
            VStack(alignment: .leading, spacing: 14) {
                PetrolHeading("Connect to a Bot Server")
                PetrolCard {
                    PetrolFieldRow(label: "Address", focused: focus == .address) {
                        TextField("Address", text: $address, prompt: Text(verbatim: "ada.wizards.bot").foregroundStyle(Petrol.ink3))
                            .labelsHidden()
                            .focused($focus, equals: .address)
                    }
                    PetrolDivider()
                    PetrolFieldRow(label: "Code", focused: focus == .code) {
                        TextField("Code", text: $code, prompt: Text(verbatim: "K7QM-2RXD").foregroundStyle(Petrol.ink3))
                            .labelsHidden()
                            .monospaced()
                            .focused($focus, equals: .code)
                    }
                }
                .onSubmit { Task { await connect() } }
                Text("The code is on the Bot Server's pairing card, under Add a device. A wizardsbot:// link fills in both.")
                    .font(.system(size: 12))
                    .foregroundStyle(Petrol.ink3)
                    .fixedSize(horizontal: false, vertical: true)
                if let problem {
                    Text(problem)
                        .font(.system(size: 12))
                        .foregroundStyle(Petrol.rose)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
            }
            .frame(width: 400)
            Spacer(minLength: 24)
            HStack {
                Button("Back") {
                    model.linked = nil
                    model.screen = .first
                }
                .petrolButton(.plain)
                Spacer()
                if busy { ProgressView().controlSize(.small) }
                Button("Connect") { Task { await connect() } }
                    .petrolButton()
                    .keyboardShortcut(.defaultAction)
                    .disabled(busy || address.isEmpty || code.isEmpty)
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 16)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .petrolGround()
        .onAppear {
            if let linked = model.linked {
                address = Address.label(linked.home)
                if linked.home.scheme == "http", !Address.isLocal(linked.home.host ?? "") {
                    address = linked.home.absoluteString
                }
                code = linked.code
            }
            focus = address.isEmpty ? .address : nil
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
        VStack(spacing: 16) {
            Image(systemName: "bolt.horizontal.circle")
                .font(.system(size: 30))
                .foregroundStyle(Petrol.accentMark)
            VStack(spacing: 8) {
                Text("Your Bot Server at \(Address.label(home)) does not answer.")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(Petrol.ink)
                Text(AppModel.say(problem))
                    .font(.system(size: 13))
                    .foregroundStyle(Petrol.ink2)
            }
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 10) {
                if model.isLocal(home), model.local.canStart {
                    Button("Start it") { Task { await model.startHere() } }
                        .petrolButton(.secondary)
                }
                Button("Try again") {
                    busy = true
                    Task {
                        await model.reach(home, code: nil)
                        busy = false
                    }
                }
                .petrolButton()
                .keyboardShortcut(.defaultAction)
            }
            .padding(.top, 4)
            Button("Connect to another Bot Server") { model.forget() }
                .petrolButton(.plain)
        }
        .disabled(busy || model.local.busy)
        .padding(40)
        .frame(maxWidth: 560)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .petrolGround()
    }
}
