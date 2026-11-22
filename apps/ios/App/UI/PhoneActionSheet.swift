import MessageUI
import SwiftUI

/// A call or a message from a card, on this phone: who it goes to (found in the phone's contacts),
/// and the one button that starts it. A message opens the system's own form with the text filled
/// in; the person sends it there. Nothing is called or sent by the app.
struct PhoneActionSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    let action: PhoneAction

    @State private var recipients: [PhoneAction.Recipient]?
    @State private var composing: PhoneAction.Recipient?

    var body: some View {
        NavigationStack {
            List {
                if case .message(_, _, let text, let subject) = action {
                    Section {
                        if let subject { Text(subject).font(.headline) }
                        Text(text)
                    } footer: {
                        Text("You read it and send it. The app sends nothing by itself.")
                    }
                }
                Section {
                    if let recipients {
                        if recipients.isEmpty {
                            Text(empty)
                                .foregroundStyle(.secondary)
                        }
                        ForEach(recipients, id: \.self) { recipient in
                            Button {
                                start(recipient)
                            } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(recipient.name)
                                            .foregroundStyle(Color.primary)
                                        if recipient.address != recipient.name {
                                            Text(recipient.address)
                                                .font(.footnote)
                                                .foregroundStyle(.secondary)
                                        }
                                    }
                                    Spacer()
                                    Label(buttonLabel, systemImage: symbol)
                                        .labelStyle(.titleAndIcon)
                                        .font(.subheadline.weight(.medium))
                                }
                            }
                        }
                    } else {
                        ProgressView()
                    }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", systemImage: "xmark") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .task { recipients = await action.recipients(in: model.phoneData) }
        .sheet(item: $composing) { recipient in
            Compose(action: action, recipient: recipient) { composing = nil; dismiss() }
                .ignoresSafeArea()
        }
    }

    private var title: LocalizedStringKey {
        switch action {
        case .call(let to): "Call \(to)"
        case .message(let to, _, _, _): "Message to \(to)"
        }
    }

    private var buttonLabel: LocalizedStringKey {
        switch action {
        case .call: "Call"
        case .message(_, .whatsapp, _, _): "WhatsApp"
        case .message: "Write"
        }
    }

    private var symbol: String {
        switch action {
        case .call: "phone"
        case .message(_, .mail, _, _): "envelope"
        case .message: "message"
        }
    }

    private var empty: LocalizedStringKey {
        model.phoneData.access(.contacts) == .denied
            ? "This app may not read your contacts. You can allow it in Settings, or ask your agent to give the number."
            : "No contact with a number or an address for this name."
    }

    private func start(_ recipient: PhoneAction.Recipient) {
        switch action {
        case .message(_, .messages, _, _) where MFMessageComposeViewController.canSendText(),
             .message(_, .mail, _, _) where MFMailComposeViewController.canSendMail():
            composing = recipient
        default:
            // A call, WhatsApp, or a phone without the system's form: the link opens it, and the
            // system asks once more before a call.
            if let link = action.link(for: recipient) { openURL(link) }
            dismiss()
        }
    }
}

extension PhoneAction.Recipient: Identifiable {
    var id: String { address }
}

/// The system's form for a message or a mail, filled in. The person sends it there, or not.
private struct Compose: UIViewControllerRepresentable {
    let action: PhoneAction
    let recipient: PhoneAction.Recipient
    let done: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(done: done) }

    func makeUIViewController(context: Context) -> UIViewController {
        switch action {
        case .message(_, .mail, let text, let subject):
            let form = MFMailComposeViewController()
            form.mailComposeDelegate = context.coordinator
            form.setToRecipients([recipient.address])
            if let subject { form.setSubject(subject) }
            form.setMessageBody(text, isHTML: false)
            return form
        case .message(_, _, let text, _):
            let form = MFMessageComposeViewController()
            form.messageComposeDelegate = context.coordinator
            form.recipients = [recipient.address]
            form.body = text
            return form
        case .call:
            return UIViewController()
        }
    }

    func updateUIViewController(_ controller: UIViewController, context: Context) {}

    final class Coordinator: NSObject, MFMessageComposeViewControllerDelegate, MFMailComposeViewControllerDelegate {
        let done: () -> Void
        init(done: @escaping () -> Void) { self.done = done }

        nonisolated func messageComposeViewController(_ controller: MFMessageComposeViewController, didFinishWith result: MessageComposeResult) {
            Task { @MainActor in done() }
        }

        nonisolated func mailComposeController(_ controller: MFMailComposeViewController, didFinishWith result: MFMailComposeResult, error: Error?) {
            Task { @MainActor in done() }
        }
    }
}
