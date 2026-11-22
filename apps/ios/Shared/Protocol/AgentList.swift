import Foundation

/// What a row of the list of agents shows at its right, below the time.
nonisolated enum AgentBadge: Equatable, Sendable {
    /// Cards of the agent wait for the person; `open` is how many.
    case needsYou(open: Int)
    /// Messages of the agent the person has not read.
    case unread(Int)
    /// The agent is working.
    case working
    case none

    /// What needs the person comes before what is unread. The conversation on screen is read as
    /// it is shown, so it has no unread count.
    init(for agent: Agent, onScreen: Bool) {
        if agent.state == .needsYou || agent.open > 0 {
            self = .needsYou(open: agent.open)
        } else if agent.unread > 0, !onScreen {
            self = .unread(agent.unread)
        } else if agent.state == .working {
            self = .working
        } else {
            self = .none
        }
    }
}

nonisolated enum AgentList {
    /// The agents as the list shows them: the main agent first, the others in the home's order.
    static func ordered(_ agents: [Agent]) -> [Agent] {
        agents.filter(\.main) + agents.filter { !$0.main }
    }

    /// When a conversation last changed, as a messenger writes it: the time for today, the date for
    /// an older day, with the year when it is not this one. Empty when the home does not say.
    static func time(
        _ updatedAt: String, now: Date = .now, calendar: Calendar = .current, locale: Locale = .current
    ) -> String {
        guard let date = Timestamp.date(from: updatedAt) else { return "" }
        var style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
        if calendar.isDate(date, inSameDayAs: now) {
            style = style.hour().minute()
        } else if calendar.isDate(date, equalTo: now, toGranularity: .year) {
            style = style.day().month(.abbreviated)
        } else {
            style = style.day().month(.twoDigits).year(.twoDigits)
        }
        return date.formatted(style)
    }
}

/// What a row of the list of agents says below the name.
nonisolated enum AgentLine: Equatable, Sendable {
    /// The agent is writing its answer.
    case writing
    /// The newest message, as plain text.
    case message(String)
    /// A shared agent with no message yet: whose it is.
    case from(String)
    /// No message yet: what the agent says about itself.
    case about(String)
}

extension AgentList {
    /// The line below an agent's name, as the web app writes it: what the agent does right now,
    /// else what was said last, else whose it is or what it does.
    static func line(for agent: Agent) -> AgentLine {
        if agent.state == .working { return .writing }
        let preview = SpokenText.plain(agent.preview)
        if !preview.isEmpty { return .message(preview) }
        if agent.origin == .shared, let from = agent.from, !from.isEmpty { return .from(from) }
        return .about(agent.about)
    }
}

/// How the list of agents slides over the chat on a phone: how wide it is, how far it is open
/// while a finger moves it, and where it settles when the finger lets go.
nonisolated enum DrawerMotion {
    /// The share of the window the open list covers, and its widest.
    static let share: CGFloat = 0.85
    static let widest: CGFloat = 340

    static func width(window: CGFloat) -> CGFloat {
        max(0, min(widest, (window * share).rounded()))
    }

    /// From 0, closed, to 1, open. `translation` is how far the finger moved it from where it
    /// rests, to the right positive; nil while no finger moves it.
    static func progress(open: Bool, translation: CGFloat?, width: CGFloat) -> CGFloat {
        guard width > 0 else { return open ? 1 : 0 }
        let rest: CGFloat = open ? width : 0
        return min(1, max(0, (rest + (translation ?? 0)) / width))
    }

    /// True when the list stays open after the finger lets go: where it would come to rest with
    /// the finger's speed is more than half open. A quick flick decides against where it is.
    static func staysOpen(open: Bool, predicted: CGFloat, width: CGFloat) -> Bool {
        progress(open: open, translation: predicted, width: width) > 0.5
    }
}

/// How the chat and a document share the width beside each other. The web app uses the same numbers.
nonisolated enum PaneLayout {
    /// The chat's width with a document beside it: a wide phone.
    static let chatDefault: CGFloat = 432
    static let chatMin: CGFloat = 352
    static let documentMin: CGFloat = 400
    /// The document grows to an iPad in portrait before the chat gets more.
    static let documentFull: CGFloat = 768
    /// With the list of agents open, a document needs at least this much, or the list makes room.
    static let documentBesideList: CGFloat = 480
    /// The list of agents stands beside the chat in a window at least this wide: an iPad in
    /// landscape. In a narrower one it closes by itself and opens over the chat when asked for.
    static let listBeside: CGFloat = 1040
    /// One step of the divider for someone who moves it without dragging.
    static let step: CGFloat = 40

    nonisolated enum Split: Equatable, Sendable {
        case sideBySide(chat: CGFloat, document: CGFloat)
        /// Too narrow for both: the document goes over the chat.
        case over
    }

    /// - `available`: the width the chat and the document have together.
    /// - `chosenChat`: the chat width the person dragged the divider to; nil for the automatic split.
    static func split(available: CGFloat, chosenChat: CGFloat? = nil) -> Split {
        guard available >= chatMin + documentMin else { return .over }
        let widest = available - documentMin
        let chat: CGFloat
        if let chosenChat {
            chat = min(max(chosenChat, chatMin), widest)
        } else {
            // A wide-phone chat; what is left beyond a full document goes to the chat.
            chat = min(max(chatDefault, available - documentFull), widest)
        }
        return .sideBySide(chat: chat, document: available - chat)
    }

    /// True when the window is wide enough for the list of agents beside the chat.
    static func listStandsBeside(window: CGFloat) -> Bool {
        window >= listBeside
    }

    /// True when the list of agents should close for a document: it takes room beside the chat, the
    /// rest is too narrow for chat and document, and without the list they fit.
    static func listMakesRoom(window: CGFloat, detail: CGFloat) -> Bool {
        window - detail > 1 && detail < chatDefault + documentBesideList && split(available: window) != .over
    }
}
