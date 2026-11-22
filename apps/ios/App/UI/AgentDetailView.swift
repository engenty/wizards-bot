import SwiftUI

/// An agent, looked at, beside the chat or over it: who it is, what it works on right now, what it
/// does by itself, what it works with and what it wrote down to remember. Nothing is changed here
/// but the connected folders: the person tells the agent.
struct AgentDetailView: View {
    @Environment(AppModel.self) private var model
    let agent: Agent

    @State private var detail: AgentDetail?
    @State private var files: [FileRef]?
    @State private var problem: String?
    @State private var connecting = false

    var body: some View {
        // Every agent of the home uses the connected folders; one shared with you does not.
        let usesFolders = agent.origin == .own
        let doing = agent.state == .working ? detail?.doing : nil
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                who(doing: doing)
                tasks
                if usesFolders {
                    AgentData(agentId: agent.id, name: agent.name, folders: model.folders, files: files ?? []) {
                        connecting = true
                    }
                }
                if let memory = detail?.memory.trimmingCharacters(in: .whitespacesAndNewlines), !memory.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        SectionHeading("Remembers")
                        MarkdownText(memory)
                            .font(.callout)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 12)
                            .background(.fill.quaternary, in: .rect(cornerRadius: 14))
                    }
                }
            }
            .padding(.horizontal, 24)
            .padding(.top, 12)
            .padding(.bottom, 32)
            // A fixed column, so the pane's width never depends on what it holds.
            .frame(maxWidth: 576)
            .frame(maxWidth: .infinity)
        }
        .navigationTitle(Text("About \(agent.name)"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Close", systemImage: "xmark") { model.closePane() }
            }
        }
        // The home says `agent.updated` when the agent starts or ends work and when a message
        // arrives: the detail and the files sent in this chat are read again then.
        .task(id: "\(agent.id) \(agent.state.rawValue) \(agent.updatedAt) \(agent.open)") {
            await load()
        }
        .task(id: agent.id) {
            if usesFolders { await model.loadFolders() }
        }
        .sheet(isPresented: $connecting) {
            FolderConnectSheet(conversationId: agent.conversationId)
        }
    }

    private func load() async {
        guard let client = model.client else { return }
        do {
            async let loadedDetail = client.agentDetail(agent.id)
            async let loadedFiles = agent.origin == .own ? client.sentFiles(in: agent.conversationId) : []
            let (newDetail, newFiles) = try await (loadedDetail, loadedFiles)
            detail = newDetail
            files = newFiles
            problem = nil
        } catch is CancellationError {
            return
        } catch {
            if detail == nil {
                problem = (error as? HomeError)?.message ?? String(localized: "Your home is out of reach. Try again in a moment.")
            }
        }
    }

    /// The figure, the name, whose it is, what it says about itself and what it works on.
    private func who(doing: AgentDetail.Doing?) -> some View {
        VStack(spacing: 10) {
            EntryFigure(agent: agent)
                .frame(width: 96, height: 96)
                .accessibilityHidden(true)
            VStack(spacing: 2) {
                Text(agent.name)
                    .font(.title3.weight(.semibold))
                if agent.origin == .shared, let from = agent.from {
                    Text("from \(from)")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            if !agent.about.isEmpty {
                Text(agent.about)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            if let doing {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    ProgressView()
                        .controlSize(.small)
                    Text(TaskText.doing(doing))
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                .transition(.opacity)
            }
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: 360)
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder
    private var tasks: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeading("Does by itself")
            if let tasks = detail?.tasks, !tasks.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(tasks.enumerated()), id: \.element.id) { index, task in
                        if index > 0 { Divider() }
                        TaskRow(task: task)
                    }
                }
                Text("Tell \(agent.name) to change or remove a task.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else if detail != nil {
                Text("Nothing yet. Tell \(agent.name) what to do at a set time or when something happens: a new file in a folder, a mail, a change in your calendar.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else if let problem {
                Text(problem)
                    .font(.footnote)
                    .foregroundStyle(.red)
            } else {
                ProgressView()
                    .controlSize(.small)
            }
        }
    }
}

/// The small grey heading of a part of the pane.
private struct SectionHeading: View {
    let text: LocalizedStringKey

    init(_ text: LocalizedStringKey) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .font(.footnote.weight(.medium))
            .foregroundStyle(.secondary)
            .accessibilityAddTraits(.isHeader)
    }
}

/// A task: what it does, what starts it and when, and why it is paused.
private struct TaskRow: View {
    let task: AgentTask

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: symbol)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .frame(width: 20)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(task.title)
                Text(TaskText.line(task))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                if let paused = task.paused {
                    Text("Paused. \(paused)")
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 10)
        .accessibilityElement(children: .combine)
    }

    /// What starts it, as a small picture: a time, a folder, mail, an address, a look.
    private var symbol: String {
        if task.paused != nil { return "pause.circle" }
        return switch task.rule {
        case .folder: "folder"
        case .mail: "envelope"
        case .webhook: "point.3.connected.trianglepath.dotted"
        case .connection: "arrow.triangle.2.circlepath"
        default: "calendar.badge.clock"
        }
    }
}

/// A task and what an agent works on, in words. The same sentences as the web app's `lib/tasks.ts`.
enum TaskText {
    /// What starts a task, as a sentence: "Every day at 08:30", "When mail arrives from …".
    static func rule(_ rule: TaskRule, locale: Locale = .current) -> String {
        switch rule {
        case .folder(let folder, let path):
            let place = path.map { "\(folder)/\($0)" } ?? folder
            return String(localized: "When a file is added or changed in \(place)")
        case .mail(let from?, let subject?):
            return String(localized: "When mail arrives from \(from) with “\(subject)” in the subject")
        case .mail(let from?, nil):
            return String(localized: "When mail arrives from \(from)")
        case .mail(nil, let subject?):
            return String(localized: "When mail arrives with “\(subject)” in the subject")
        case .mail(nil, nil):
            return String(localized: "When mail arrives")
        case .webhook:
            return String(localized: "When another service calls its address")
        case .connection(let connection, _, let minutes):
            return String(localized: "When \(connection) changes, looked at every \(minutes) min")
        case .at:
            return String(localized: "Once")
        case .hourly:
            return String(localized: "Every hour")
        case .daily(let time):
            return String(localized: "Every day at \(time)")
        case .weekdays(let time):
            return String(localized: "Monday to Friday at \(time)")
        case .weekly(let time, let weekday):
            var calendar = Calendar(identifier: .gregorian)
            calendar.locale = locale
            let names = calendar.standaloneWeekdaySymbols
            let name = names.indices.contains(weekday) ? names[weekday] : ""
            return String(localized: "Every \(name) at \(time)")
        case .unknown:
            return ""
        }
    }

    /// A day and a time, as a list wants it: "Mon, 23 Nov, 08:30".
    static func dayAndTime(_ iso: String) -> String {
        guard let date = Timestamp.date(from: iso) else { return "" }
        return date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated).hour().minute())
    }

    /// A task in one line under what it does: what starts it, when it runs next or ran last, and
    /// whether it is quiet. A task that waits for an event has no next time, so its last run
    /// stands there.
    static func line(_ task: AgentTask) -> String {
        var last = ""
        if let lastAt = task.lastAt {
            let when = dayAndTime(lastAt)
            last = String(localized: "last: \(when)")
            if task.last == .failed { last += ", " + String(localized: "failed") }
        }
        let when = task.nextAt.flatMap { task.paused == nil ? dayAndTime($0) : nil }
        return [
            rule(task.rule),
            when.map { String(localized: "next: \($0)") } ?? last,
            task.quiet ? String(localized: "quiet") : "",
        ]
        .filter { !$0.isEmpty }
        .joined(separator: " · ")
    }

    /// What the agent works on, and which turn in a row it is in.
    static func doing(_ doing: AgentDetail.Doing) -> String {
        [
            doing.what.isEmpty ? String(localized: "Working") : String(localized: "Working on: \(doing.what)"),
            doing.turn > 1 ? String(localized: "turn \(doing.turn) of \(doing.turns)") : "",
        ]
        .filter { !$0.isEmpty }
        .joined(separator: " · ")
    }
}
