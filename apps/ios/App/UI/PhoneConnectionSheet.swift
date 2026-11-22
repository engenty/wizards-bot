import SwiftUI

/// Signs a service in on this phone: an MCP server the phone reaches, with the token it asks for.
/// The token goes into the phone's Keychain; the phone's own agent uses the service, and the home
/// only learns its name.
struct PhoneConnectionSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var address = ""
    @State private var token = ""
    @State private var busy = false
    @State private var problem: String?

    private var thisDevice: String { UIDevice.current.model }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name)
                        .textInputAutocapitalization(.words)
                    TextField("Address", text: $address, prompt: Text(verbatim: "https://…/mcp"))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    SecureField("Access token, if it needs one", text: $token)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } footer: {
                    Text("The service is used by the model on this \(thisDevice) only. The token stays in this \(thisDevice)’s Keychain; your Bot Server learns only the name. A tool that changes something asks you here first.")
                }
                if let problem {
                    Section {
                        Text(problem)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Sign in a service")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", systemImage: "xmark") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if busy {
                        ProgressView()
                    } else {
                        Button("Connect", action: connect)
                            .disabled(address.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func connect() {
        guard let url = URL(string: address.trimmingCharacters(in: .whitespaces)), url.scheme != nil else {
            problem = String(localized: "This is not an address. It starts with https://.")
            return
        }
        busy = true
        problem = nil
        Task {
            defer { busy = false }
            do {
                try await model.connectPhoneService(name: name, url: url, token: token.isEmpty ? nil : token)
                dismiss()
            } catch let problem as MCPProblem {
                self.problem = problem.sentence
            } catch {
                problem = String(localized: "No service answers at this address.")
            }
        }
    }
}
