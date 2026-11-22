import SwiftUI

/// A document beside the chat: Markdown to read, and to edit.
struct DocumentView: View {
    @Environment(AppModel.self) private var model
    @Bindable var session: DocumentSession
    @FocusState private var editing: Bool

    var body: some View {
        Group {
            if session.isLoading {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if session.document == nil, let problem = session.problem {
                ContentUnavailableView {
                    Label("The document isn’t here", systemImage: "doc.text")
                } description: {
                    Text(problem)
                } actions: {
                    Button("Try again") { Task { await session.load() } }
                }
            } else if session.isEditing {
                TextEditor(text: $session.draft)
                    .focused($editing)
                    .scrollContentBackground(.hidden)
                    .padding(.horizontal, 14)
                    .onAppear { editing = true }
            } else {
                ScrollView {
                    MarkdownText(session.draft)
                        .textSelection(.enabled)
                        .padding(.horizontal, 20)
                        .padding(.vertical, 16)
                        .frame(maxWidth: 720)
                        .frame(maxWidth: .infinity)
                }
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            notices
        }
        .navigationTitle(session.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Close", systemImage: "xmark") { model.closeDocument() }
            }
            if session.document != nil {
                ToolbarItemGroup(placement: .primaryAction) {
                    if session.isDirty {
                        Button {
                            Task { await session.save() }
                        } label: {
                            if session.isSaving { ProgressView() } else { Text("Save") }
                        }
                        .disabled(session.isSaving)
                    }
                    Button(session.isEditing ? "Read" : "Edit", systemImage: session.isEditing ? "eye" : "pencil") {
                        session.isEditing.toggle()
                    }
                }
            }
        }
        .interactiveDismissDisabled(session.isDirty)
    }

    /// What the person has to know or decide about this document.
    @ViewBuilder
    private var notices: some View {
        if session.newer != nil {
            notice("The agent wrote a newer version while you were editing.") {
                Button("Keep my text") { Task { await session.keepMine() } }
                    .buttonStyle(ActionButtonStyle(style: .primary))
                Button("Take the agent’s version") { session.takeTheirs() }
                    .buttonStyle(ActionButtonStyle(style: .plain))
            }
        } else if session.homeIsNewer {
            notice("Your Bot Server has a newer version of this document.") {
                Button("Load it and drop my changes") { Task { await session.loadNewer() } }
                    .buttonStyle(ActionButtonStyle(style: .plain))
            }
        } else if session.document != nil, let problem = session.problem {
            Text(problem)
                .font(.callout)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
                .background(.bar)
        }
    }

    private func notice(_ text: LocalizedStringKey, @ViewBuilder buttons: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(text)
                .font(.callout)
            // Side by side where the words fit, else one under the other.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { buttons() }
                VStack(alignment: .leading, spacing: 8) { buttons() }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(.bar)
    }
}
