import SwiftUI

/// The pairing screens until the device has a home or the person chose to go without, and after a
/// pairing until the person opens the chat; then the chat.
/// Over both, a question of the phone's agent while it waits for the person.
struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        Group {
            if model.pairingFills {
                PairingView()
            } else {
                ChatScreen()
            }
        }
        .animation(.default, value: model.pairingFills)
        // The phone's agent wants to change something or send a file: nothing happens without a yes.
        .alert(
            Text(verbatim: model.question?.title ?? ""),
            isPresented: Binding(
                get: { model.question != nil },
                set: { shown in if !shown, model.question != nil { model.answerQuestion(false) } }
            ),
            presenting: model.question
        ) { question in
            Button(question.yes) { model.answerQuestion(true) }
            Button(question.no, role: .cancel) { model.answerQuestion(false) }
        } message: { question in
            Text(verbatim: question.detail)
        }
        // An invite link that did not open: the home's own words about it.
        .alert(
            "The invite did not open",
            isPresented: Binding(get: { model.inviteProblem != nil }, set: { shown in if !shown { model.inviteProblem = nil } }),
            presenting: model.inviteProblem
        ) { _ in
            Button("OK", role: .cancel) {}
        } message: { problem in
            Text(verbatim: problem)
        }
        // Where what the person writes goes: asked before the first message reaches a model service.
        .sheet(item: Binding(
            get: { model.consent },
            set: { ask in if ask == nil, model.consent != nil { Task { _ = await model.answerConsent(false) } } }
        )) { ask in
            ConsentSheet(ask: ask)
        }
        .sheet(item: $model.phoneAction) { action in
            PhoneActionSheet(action: action)
        }
        .sheet(isPresented: Binding(
            get: { model.showsPairing },
            set: { shown in if !shown { model.closePairing() } }
        )) {
            PairingView(isSheet: true)
        }
    }
}
