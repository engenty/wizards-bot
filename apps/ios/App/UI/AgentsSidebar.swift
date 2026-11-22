import SwiftUI

/// The list of agents at the left of a wide screen, as a messenger shows its conversations, with
/// the way to the settings at its foot.
struct AgentsSidebar: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        List(selection: Binding(
            get: { model.currentAgent?.id },
            set: { id in
                if let agent = id.flatMap(model.agent), agent.id != model.currentAgent?.id { model.select(agent) }
            }
        )) {
            ForEach(AgentList.ordered(model.agents)) { agent in
                AgentListRow(agent: agent, badge: AgentBadge(for: agent, onScreen: agent.id == model.currentAgent?.id))
                    .tag(agent.id)
            }
        }
        .navigationTitle("Wizards")
        .safeAreaInset(edge: .bottom, spacing: 0) {
            Button {
                model.showsSettings = true
            } label: {
                HStack(spacing: 10) {
                    Text(model.link?.name ?? String(localized: "This device"))
                        .font(.body.weight(.medium))
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    Image(systemName: "gearshape")
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 14)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Settings")
            .accessibilityValue(model.link?.name ?? "")
        }
    }
}

/// One agent in the list: its figure, its name and the time, a line of its newest message, and
/// what waits there. The colours are fixed, so the selected row is marked by the system's
/// highlight alone and its text stays as calm as the others'. The phone's drawer shows the same.
struct AgentListRow: View {
    let agent: Agent
    let badge: AgentBadge

    var body: some View {
        let line = AgentList.line(for: agent)
        let from = agent.origin == .shared ? agent.from : nil
        // The time belongs to the newest message; an agent that has said nothing has none.
        let time = agent.preview.isEmpty ? "" : AgentList.time(agent.updatedAt)
        HStack(spacing: 12) {
            EntryFigure(agent: agent)
                .frame(width: 44, height: 44)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(agent.name)
                        .font(.body.weight(badge == .none || badge == .working ? .medium : .semibold))
                        .foregroundStyle(Color.primary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if !time.isEmpty {
                        Text(time)
                            .font(.footnote.monospacedDigit())
                            .foregroundStyle(Color.secondary)
                            .layoutPriority(1)
                    }
                }
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Group {
                        switch line {
                        case .writing: Text("writing…").foregroundStyle(.green)
                        case .message(let text): Text(text)
                        case .from(let from): Text("from \(from)")
                        case .about(let about): Text(about)
                        }
                    }
                    .font(.subheadline)
                    .foregroundStyle(Color.secondary)
                    .lineLimit(1)
                    Spacer(minLength: 0)
                    waiting
                        .layoutPriority(1)
                }
                // A shared agent says whose it is, also under a message.
                if let from, line != .from(from) {
                    Text("from \(from)")
                        .font(.caption)
                        .foregroundStyle(Color.secondary.opacity(0.7))
                        .lineLimit(1)
                }
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var waiting: some View {
        switch badge {
        case .needsYou(let open):
            HStack(spacing: 6) {
                Text("needs you")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.tint)
                if open > 0 {
                    CountBadge(count: open)
                        .accessibilityHidden(true)
                }
            }
        case .unread(let count):
            CountBadge(count: count)
                .accessibilityLabel("\(count) unread")
        case .working, .none:
            // The line says the agent is writing.
            EmptyView()
        }
    }
}
