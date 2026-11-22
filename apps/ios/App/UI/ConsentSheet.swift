import SwiftUI

/// Before what the person writes reaches a model service outside their own computers: where it
/// goes, and a clear yes or no. Nothing is sent before the answer.
struct ConsentSheet: View {
    @Environment(AppModel.self) private var model
    let ask: ConsentAsk
    @State private var busy = false
    @State private var problem: String?

    private var host: String { model.link.map { $0.baseURL.host() ?? $0.baseURL.absoluteString } ?? "" }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("What you write here goes to your Bot Server at \(host). Your Bot Server answers with models of these companies, which then read what you write and what your agents send them:")
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(ask.services) { service in
                            Text(verbatim: service.line)
                                .fontWeight(.semibold)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(14)
                    .background(.fill.tertiary, in: .rect(cornerRadius: 14))
                    Text("That can be your messages, the files and photos you add, the answers this phone sends back for your agents, and what your agents found. Each company handles it under its own terms.")
                        .foregroundStyle(.secondary)
                    Text("A model on your own computer, such as Ollama, and the model on this phone read it where they are and need no yes. You can take your yes back in Settings.")
                        .foregroundStyle(.secondary)
                    NavigationLink("Read the privacy policy") { PrivacyView() }
                    if let problem {
                        Text(verbatim: problem)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
                .padding(20)
            }
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 10) {
                    Button {
                        busy = true
                        Task {
                            problem = await model.answerConsent(true)
                            busy = false
                        }
                    } label: {
                        Text("Allow").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(busy)
                    Button {
                        Task { _ = await model.answerConsent(false) }
                    } label: {
                        Text("Not now").frame(maxWidth: .infinity)
                    }
                    .controlSize(.large)
                    .disabled(busy)
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
                .background(.bar)
            }
            .navigationTitle("Where what you write goes")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}

/// The privacy policy of wizards.bot, as `docs/privacy.md` has it; the app carries a copy.
struct PrivacyView: View {
    private static let text: String = Bundle.main.url(forResource: "privacy", withExtension: "md")
        .flatMap { try? String(contentsOf: $0, encoding: .utf8) }
        .map { $0.replacing(/^# .*\n/, with: "") } ?? ""

    var body: some View {
        ScrollView {
            MarkdownText(Self.text)
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle("Privacy")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// The model services the home uses or the person said yes to, and the way to take a yes back.
struct ServicesSection: View {
    @Environment(AppModel.self) private var model
    @State private var problem: String?

    var body: some View {
        Section {
            if let services = model.models?.services, !services.isEmpty {
                ForEach(services) { service in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: service.line)
                            if let agreed = service.agreed {
                                Text("Allowed on \(agreed.by), \(Timestamp.date(from: agreed.at)?.formatted(date: .abbreviated, time: .omitted) ?? "")")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            } else {
                                Text("Waits for your yes")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                        if service.agreed != nil {
                            Button("Take back") {
                                Task { problem = await model.takeBack(service) }
                            }
                            .buttonStyle(.borderless)
                        }
                    }
                }
            } else {
                Text("Your Bot Server uses only models on your own computers. Nothing goes to another company.")
                    .foregroundStyle(.secondary)
            }
            if let problem {
                Text(verbatim: problem)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        } header: {
            Text("Where what you write goes")
        }
    }
}
