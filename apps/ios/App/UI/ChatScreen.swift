import SwiftUI

/// The one screen: the chat with an agent, and beside it a document or the agent, looked at, when
/// one is open. On a wide screen the list of agents stands at the left.
struct ChatScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.horizontalSizeClass) private var sizeClass

    /// Whether the list of agents shows right now.
    @State private var listShown = false
    /// What the person chose for a window wide enough for it: the list open, until they close it.
    @State private var listWanted = true
    /// True while the list is closed to make room for a document.
    @State private var madeRoom = false
    /// When the list last closed by itself. For a moment after, the split view may still report
    /// the state it is leaving; that is not the person opening the list again.
    @State private var closedItself = Date.distantPast
    @State private var windowWidth: CGFloat = 0
    /// Where the open list of agents ends, from the left edge of the window.
    @State private var listEdge: CGFloat = 0
    /// The chat width the person dragged the divider to; nil for the automatic split.
    @State private var chosenChat: CGFloat?
    /// On a phone: how far a finger moved the list of agents; nil while none moves it.
    @State private var drawerDrag: CGFloat?
    /// The phone's window width, for where a swipe from the edge lets the list rest.
    @State private var phoneWidth: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        @Bindable var model = model
        let wide = sizeClass == .regular
        let narrow = wide && windowWidth > 0 && !PaneLayout.listStandsBeside(window: windowWidth)
        // The room the list takes from the chat. In a narrow window it lies over the chat and takes none.
        let listRoom: CGFloat = wide && listShown && !narrow ? listEdge : 0
        // What the chat and a document share.
        let available = windowWidth - listRoom
        let split: PaneLayout.Split = wide && windowWidth > 0
            ? PaneLayout.split(available: available, chosenChat: chosenChat)
            : .over
        // A document, an artifact or the agent stands beside the chat, in the same place.
        let paneOpen = model.paneOpen
        // The width the pane takes from the chat, when it stands beside it.
        let documentWidth: CGFloat? = if paneOpen, case .sideBySide(_, let width) = split { width } else { nil }
        // The width the chat has on screen: beside a pane its share, otherwise all of it.
        let chatRoom: CGFloat? = if !wide || windowWidth == 0 { nil } else if paneOpen, case .sideBySide(let chat, _) = split { chat } else { available }
        Group {
            if wide {
                // The split view keeps the whole window. The document lies over its right side and
                // the chat leaves that room free, so each of the three keeps its own bar and the
                // split view never changes its size for a document.
                NavigationSplitView(columnVisibility: columns) {
                    AgentsSidebar()
                        .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).maxX } action: { edge in
                            // The list moves in and out; where it rests when open is its edge.
                            if edge > listEdge { listEdge = edge }
                        }
                } detail: {
                    NavigationStack {
                        ChatView(room: chatRoom, trailingInset: documentWidth ?? 0)
                    }
                }
                .overlay(alignment: .trailing) {
                    if paneOpen, let documentWidth, case .sideBySide(let chat, _) = split {
                        NavigationStack {
                            pane
                        }
                        .id(paneId)
                        .frame(width: documentWidth)
                        .background(Color(.systemBackground).ignoresSafeArea())
                        .overlay(alignment: .leading) {
                            PaneDivider(chat: chat, available: available, chosenChat: $chosenChat)
                        }
                        .transition(.move(edge: .trailing))
                    }
                }
                .animation(.snappy, value: paneId)
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in
                    // The first time, the list is simply there or not; later it moves in and out.
                    if windowWidth == 0 { listShown = listWanted && PaneLayout.listStandsBeside(window: width) }
                    windowWidth = width
                }
            } else {
                // On a phone the list of agents slides in over the chat from the left edge.
                NavigationStack {
                    ChatView()
                }
                .gesture(EdgeSwipe(
                    moved: { moved in
                        guard !model.showsAgents else { return }
                        if drawerDrag == nil { AgentsDrawer.endEditing() }
                        drawerDrag = max(0, moved)
                    },
                    ended: { predicted in
                        guard !model.showsAgents, drawerDrag != nil else { return }
                        let opens = DrawerMotion.staysOpen(open: false, predicted: predicted, width: DrawerMotion.width(window: phoneWidth))
                        withAnimation(AgentsDrawer.motion(reduceMotion)) {
                            model.showsAgents = opens
                            drawerDrag = nil
                        }
                    }
                ))
                .accessibilityHidden(model.showsAgents)
                .overlay {
                    AgentsDrawer(drag: $drawerDrag)
                }
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in
                    phoneWidth = width
                }
            }
        }
        .onChange(of: narrow) {
            // Portrait or a small window: the list closes by itself. Wide again: it is as the
            // person left it.
            if narrow { closedItself = .now }
            withAnimation(.snappy) { listShown = !narrow && !madeRoom && listWanted }
        }
        .onChange(of: paneOpen) {
            if paneOpen {
                // A document or the agent opens. The list closes for it when the three would not fit.
                guard wide, listShown, PaneLayout.listMakesRoom(window: windowWidth, detail: available) else { return }
                madeRoom = true
                closedItself = .now
                withAnimation(.snappy) { listShown = false }
            } else if madeRoom {
                // The pane closed: the list comes back if the person had it open.
                madeRoom = false
                withAnimation(.snappy) { listShown = !narrow && listWanted }
            }
        }
        // Where the window is too narrow for both, also without the list, the pane is a sheet
        // over the chat.
        .sheet(isPresented: Binding(
            get: { paneOpen && (!wide || windowWidth == 0 || PaneLayout.split(available: windowWidth) == .over) },
            set: { if !$0 { model.closePane() } }
        )) {
            NavigationStack {
                pane
            }
        }
        .sheet(isPresented: $model.showsItems) {
            ItemsSheet()
        }
        .sheet(isPresented: $model.showsSettings) {
            SettingsSheet()
        }
    }

    /// What stands beside the chat: a document, an artifact, or the agent on screen.
    @ViewBuilder
    private var pane: some View {
        if let document = model.document {
            DocumentView(session: document)
        } else if let artifact = model.artifact {
            ArtifactView(session: artifact)
        } else if model.showsAbout, let agent = model.currentAgent {
            AgentDetailView(agent: agent)
        }
    }

    /// Which pane is open, so it moves in and out as a whole when it changes.
    private var paneId: String? {
        if let document = model.document {
            "document \(document.id)"
        } else if let artifact = model.artifact {
            "artifact \(artifact.id)"
        } else if model.showsAbout { "agent \(model.currentAgent?.id ?? "")" } else { nil }
    }

    /// What the split view shows and what its sidebar button changes. Opening or closing the list
    /// in a window wide enough for it, with no document in the way, is the person's choice for later.
    private var columns: Binding<NavigationSplitViewVisibility> {
        Binding(
            get: { listShown ? .all : .detailOnly },
            set: { visibility in
                let shown = visibility != .detailOnly
                guard shown != listShown else { return }
                if shown, Date.now.timeIntervalSince(closedItself) < 0.8 { return }
                let beside = PaneLayout.listStandsBeside(window: windowWidth)
                // The person asks for the list where it, the chat and the open document do not
                // fit side by side: the document closes for it.
                if shown, beside, model.paneOpen, PaneLayout.split(available: windowWidth - listEdge) == .over {
                    madeRoom = false
                    model.closePane()
                }
                listShown = shown
                if beside, !madeRoom { listWanted = shown }
            }
        )
    }
}

/// The line between the chat and the document. Dragging it changes how they share the width,
/// within the limits of `PaneLayout`; a double tap goes back to the automatic split.
private struct PaneDivider: View {
    let chat: CGFloat
    let available: CGFloat
    @Binding var chosenChat: CGFloat?
    @State private var dragStart: CGFloat?

    var body: some View {
        Color(.separator)
            .frame(width: 1)
            .frame(maxHeight: .infinity)
            .ignoresSafeArea()
            .overlay {
                // A handle wide enough for a finger, with a small grip to show it moves.
                Color.clear
                    .frame(width: 24)
                    .contentShape(.rect)
                    .overlay {
                        Capsule()
                            .fill(.tertiary)
                            .frame(width: 5, height: 40)
                    }
                    .gesture(
                        DragGesture(minimumDistance: 2, coordinateSpace: .global)
                            .onChanged { drag in
                                let start = dragStart ?? chat
                                dragStart = start
                                move(to: start + drag.translation.width)
                            }
                            .onEnded { _ in dragStart = nil }
                    )
                    .onTapGesture(count: 2) {
                        withAnimation(.snappy) { chosenChat = nil }
                    }
                    .accessibilityElement()
                    .accessibilityLabel("Divider between the chat and the document")
                    .accessibilityValue("The chat is \(Int(chat)) points wide")
                    .accessibilityAdjustableAction { direction in
                        switch direction {
                        case .increment: move(to: chat + PaneLayout.step)
                        case .decrement: move(to: chat - PaneLayout.step)
                        @unknown default: break
                        }
                    }
                    .accessibilityAction(named: "Automatic width") { chosenChat = nil }
            }
            .zIndex(1)
    }

    /// Keeps the wish inside the limits, so the stored width is one the layout can give.
    private func move(to width: CGFloat) {
        if case .sideBySide(let chat, _) = PaneLayout.split(available: available, chosenChat: width) {
            chosenChat = chat
        }
    }
}

/// The conversation with the agent on screen.
struct ChatView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.horizontalSizeClass) private var sizeClass
    /// The width the chat has on screen, where the screen is wide: the column of messages and the
    /// bars keep inside it. It comes from the screen's own rule, not from measuring the chat, so
    /// the chat's width never depends on how the chat was laid out before.
    var room: CGFloat?
    /// The room at the right that a document beside the chat takes.
    var trailingInset: CGFloat = 0
    @State private var position = ScrollPosition(idType: String.self, edge: .bottom)
    @State private var width: CGFloat = 0
    /// True while the newest message is in view.
    @State private var atEnd = true
    /// Whether the chat was at its end when its width began to change; nil while the width rests.
    @State private var wasAtEnd: Bool?

    var body: some View {
        let agent = model.currentAgent
        let messages = agent.map { model.messages(in: $0.conversationId) } ?? []
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                if let agent, model.threads[agent.conversationId]?.more == true, model.threads[agent.conversationId]?.loaded == true {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .task { await model.loadOlder() }
                }
                ForEach(messages) { message in
                    MessageView(message: message)
                        .id(message.id)
                }
            }
            // Each message is a place the chat can be at, so it knows where the person is reading.
            .scrollTargetLayout()
            .padding(.horizontal, 18)
            .padding(.vertical, 12)
            // A column in the middle of the chat, no wider than what shows of the chat.
            .frame(maxWidth: min(720, room ?? .infinity))
            .frame(maxWidth: .infinity)
        }
        .defaultScrollAnchor(.bottom)
        .scrollPosition($position)
        .scrollDismissesKeyboard(.interactively)
        // The newest message stays in view: when one arrives, while one is written, and when the agent changes.
        // Older messages loading above do not move the chat.
        .onChange(of: messages.last?.id) {
            withAnimation(.snappy) { position.scrollTo(edge: .bottom) }
        }
        .onChange(of: messages.last?.parts) {
            position.scrollTo(edge: .bottom)
        }
        .onChange(of: agent?.id) {
            position.scrollTo(edge: .bottom)
        }
        // Files above the field make the bar under the chat taller or lower: the person writes at
        // the end, so the end stays in view.
        .onChange(of: model.attachments.list.count) {
            withAnimation(.snappy) { position.scrollTo(edge: .bottom) }
        }
        // What was remembered is replaced by what the home has: once it is laid out, the end is in view again.
        .task(id: agent.map { "\($0.conversationId) \(model.threads[$0.conversationId]?.loaded == true)" }) {
            try? await Task.sleep(for: .milliseconds(350))
            position.scrollTo(edge: .bottom)
        }
        .onScrollGeometryChange(for: Bool.self) { geometry in
            geometry.contentOffset.y + geometry.containerSize.height
                >= geometry.contentSize.height + geometry.contentInsets.bottom - 60
        } action: { _, nowAtEnd in
            atEnd = nowAtEnd
        }
        // The chat moves up and down only. A message that grows in place can make the chat line up
        // with that message's leading edge, a margin to the side; then it is put back.
        .onScrollGeometryChange(for: CGFloat.self) { geometry in
            geometry.contentOffset.x + geometry.contentInsets.leading
        } action: { _, sideways in
            if abs(sideways) > 0.5 { position.scrollTo(x: 0) }
        }
        // The chat got wider or narrower: the device turned, the list of agents or a document opened
        // or closed, the divider moved. Once the width rests, the chat is put back where the person
        // was: at its end, or at the message they were reading further up. Without this the chat
        // can keep the layout of the old width.
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { newWidth in
            if wasAtEnd == nil { wasAtEnd = atEnd }
            width = newWidth
        }
        .task(id: width) {
            try? await Task.sleep(for: .milliseconds(150))
            guard !Task.isCancelled else { return }
            let toEnd = wasAtEnd ?? true
            wasAtEnd = nil
            if !toEnd, let reading = position.viewID(type: String.self) {
                // At the top, in the middle: a leading anchor would move the chat sideways by
                // the column's margin.
                position.scrollTo(id: reading, anchor: .top)
            } else {
                position.scrollTo(edge: .bottom)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidShowNotification)) { _ in
            withAnimation(.snappy) { position.scrollTo(edge: .bottom) }
        }
        .overlay {
            if messages.isEmpty, let agent {
                EmptyChat(agent: agent, isLoading: model.isPaired && model.threads[agent.conversationId]?.loaded != true && model.reachable)
            } else if agent == nil {
                Waiting()
            }
        }
        // Bars of the system kind: the chat fades out under them.
        .safeAreaBar(edge: .top, spacing: 0) {
            StatusBar()
        }
        .safeAreaBar(edge: .bottom, spacing: 0) {
            if agent != nil { Composer() }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // On a wide screen the header stands at the left, over the chat also when a document
            // lies over the right side of the bar.
            if sizeClass == .regular {
                ToolbarItem(placement: .topBarLeading) {
                    if let agent {
                        AgentButton(agent: agent)
                            .fixedSize()
                    }
                }
                // The header is a name, not a button: no glass around it.
                .sharedBackgroundVisibility(.hidden)
            } else {
                // On a phone the bar is balanced: the way back and the name at the left, each
                // on glass of its own, and what the agent is about at the right.
                ToolbarItem(placement: .topBarLeading) {
                    WizardsButton()
                }
                ToolbarSpacer(.fixed, placement: .topBarLeading)
                ToolbarItem(placement: .topBarLeading) {
                    if let agent {
                        AgentButton(agent: agent)
                            .frame(maxWidth: 220)
                            .fixedSize(horizontal: true, vertical: false)
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if let agent {
                        AboutButton(agent: agent)
                    }
                }
            }
        }
        .frame(maxWidth: room)
        .padding(.trailing, trailingInset)
        // The chat takes a new width at once. Moved with an animation, the words of the line
        // under the bar can stay behind their glass.
        .animation(nil, value: room)
        .animation(nil, value: trailingInset)
    }
}

/// The header: the agent's figure and name. It opens what the agent does by itself, works with and
/// remembers: beside the chat where there is room, over it on a phone.
private struct AgentButton: View {
    @Environment(AppModel.self) private var model
    let agent: Agent

    var body: some View {
        Button {
            withAnimation(.snappy) { model.toggleAbout() }
        } label: {
            HStack(spacing: 8) {
                EntryFigure(agent: agent)
                    .frame(width: 30, height: 30)
                Text(agent.name)
                    .font(.headline)
                    .foregroundStyle(Color.primary)
                    .lineLimit(1)
            }
            .padding(.horizontal, 6)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(agent.name)
        .accessibilityAddTraits(.isHeader)
        .accessibilityHint("Shows what this agent does and works with")
    }
}

/// On a phone, at the right of the bar: what the agent does by itself, works with and remembers.
private struct AboutButton: View {
    @Environment(AppModel.self) private var model
    let agent: Agent

    var body: some View {
        Button {
            withAnimation(.snappy) { model.toggleAbout() }
        } label: {
            Image(systemName: "ellipsis")
        }
        .accessibilityLabel("About \(agent.name)")
    }
}

/// On a phone: the way to the list of agents and this device, with a dot when another agent has
/// something new or waits for the person.
private struct WizardsButton: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let news = model.agents.contains { $0.id != model.currentAgent?.id && ($0.unread > 0 || $0.open > 0) }
        Button {
            model.showsAgents = true
        } label: {
            Image(systemName: "chevron.left")
                .overlay(alignment: .topTrailing) {
                    if news {
                        Circle()
                            .fill(.tint)
                            .frame(width: 8, height: 8)
                            .offset(x: 3, y: -2)
                    }
                }
        }
        .accessibilityLabel("Show the wizards")
        .accessibilityHint("Shows your agents and this device")
        .accessibilityValue(news ? Text("New messages") : Text(""))
    }
}

/// Above the chat: what needs the person, and a line when the home is out of reach.
private struct StatusBar: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 8) {
            if !model.items.isEmpty {
                Button {
                    model.showsItems = true
                } label: {
                    HStack(spacing: 8) {
                        Circle()
                            .fill(.tint)
                            .frame(width: 8, height: 8)
                        Text("\(model.items.count) need you")
                            .font(.subheadline.weight(.semibold))
                    }
                    .padding(.horizontal, 6)
                }
                .buttonStyle(.glass)
                .accessibilityHint("Shows what waits for your answer")
            }
            if model.isPaired, !model.reachable {
                // In a narrow chat the words take a second line beside the symbol.
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "house")
                        .accessibilityHidden(true)
                    (model.onDevice.isAvailable
                        ? Text("Your Bot Server is out of reach. This device answers for now.")
                        : Text("Your Bot Server is out of reach. Your messages wait until it is back."))
                        .fixedSize(horizontal: false, vertical: true)
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .glassEffect(.regular, in: .rect(cornerRadius: 18))
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, model.items.isEmpty && (model.reachable || !model.isPaired) ? 0 : 8)
        .frame(maxWidth: .infinity)
        .animation(.snappy, value: model.items.count)
        .animation(.snappy, value: model.reachable)
    }
}

/// An empty conversation: the agent, and what it says about itself.
private struct EmptyChat: View {
    @Environment(AppModel.self) private var model
    let agent: Agent
    let isLoading: Bool

    var body: some View {
        VStack(spacing: 14) {
            EngentyFigure(kind: agent.kind)
                .frame(width: 128, height: 128)
            if isLoading {
                ProgressView()
            } else if !agent.about.isEmpty {
                Text(agent.about)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            } else if !model.isPaired {
                Text("This device answers on its own. It can’t reach your mail, calendar or files.")
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                if let reason = model.onDevice.unavailable {
                    Text(reason)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
            }
        }
        .padding(40)
        .frame(maxWidth: 420)
        .allowsHitTesting(false)
    }
}

/// Paired, but the home has not answered yet and nothing is remembered.
private struct Waiting: View {
    @Environment(AppModel.self) private var model
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        VStack(spacing: 14) {
            EngentyFigure(kind: .round)
                .frame(width: 128, height: 128)
            if model.reachable {
                ProgressView()
            } else {
                Text("Your Bot Server is out of reach. The chat opens when it is back.")
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Button("Show this device") {
                    if sizeClass == .regular { model.showsSettings = true } else { model.showsAgents = true }
                }
                .font(.callout.weight(.medium))
            }
        }
        .padding(40)
        .frame(maxWidth: 420)
    }
}
