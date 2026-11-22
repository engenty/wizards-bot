import SwiftUI

/// What the app knows about this device and its home, and the way out of the home.
struct DeviceSection: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var asksSignOut = false

    var body: some View {
        Section("This device") {
            if let link = model.link {
                LabeledContent("Bot Server") {
                    Text(link.baseURL.host() ?? link.baseURL.absoluteString)
                        .textSelection(.enabled)
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text("When your Bot Server is out of reach")
                    Text(model.onDevice.unavailable ?? String(localized: "The model on this device answers, with Apple Intelligence."))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Button("Sign out", role: .destructive) { asksSignOut = true }
                    .confirmationDialog("Sign out of this Bot Server?", isPresented: $asksSignOut, titleVisibility: .visible) {
                        Button("Sign out", role: .destructive) {
                            Task { await model.signOut() }
                        }
                    } message: {
                        Text("This device forgets the Bot Server. Your conversations stay on your Bot Server.")
                    }
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    Text("This device works on its own")
                    Text(model.onDevice.unavailable ?? String(localized: "The model on this device answers, with Apple Intelligence."))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Button("Connect to a Bot Server") {
                    dismiss()
                    model.showsPairing = true
                }
            }
        }
    }
}

/// What the row at the bottom of the list of agents opens: the person's name as the home knows it,
/// and this device.
struct SettingsSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if let link = model.link {
                    Section {
                        LabeledContent("Name", value: link.name)
                    }
                }
                if model.link != nil {
                    ServicesSection()
                }
                DeviceSection()
                Section {
                    NavigationLink("Privacy") { PrivacyView() }
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", systemImage: "xmark") { dismiss() }
                }
            }
        }
    }
}

/// What needs the person: every open card, answerable in place.
struct ItemsSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 20) {
                    ForEach(model.items) { card in
                        VStack(alignment: .leading, spacing: 8) {
                            if let agent = model.agent(card.agentId) {
                                HStack(spacing: 6) {
                                    EngentyFigure(kind: agent.kind)
                                        .frame(width: 22, height: 22)
                                    Text(agent.name)
                                        .font(.footnote.weight(.medium))
                                        .foregroundStyle(.secondary)
                                }
                            }
                            CardView(card: card)
                        }
                    }
                }
                .padding(18)
            }
            .overlay {
                if model.items.isEmpty {
                    ContentUnavailableView("Nothing needs you right now", systemImage: "checkmark")
                }
            }
            .navigationTitle("What needs you")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", systemImage: "xmark") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        // Over a busy chat, a half-high sheet of clear glass is hard to read.
        .presentationBackground(.thickMaterial)
    }
}
