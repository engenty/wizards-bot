import SwiftUI

@main
struct EngentyWatchApp: App {
    @State private var model = WatchModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(model)
                .onAppear { model.start() }
                .onChange(of: scenePhase) { _, phase in
                    model.setActive(phase == .active)
                }
        }
    }
}
