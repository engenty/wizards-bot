import SwiftUI
import UIKit

/// On a phone: the list of agents, slid in from the left edge over the chat, the chat dimmed
/// behind it. It follows the finger both ways; with reduced motion it fades instead.
struct AgentsDrawer: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// How far a finger moved the list from where it rests, to the right positive; nil while no
    /// finger moves it. The swipe from the chat's edge sets it too.
    @Binding var drag: CGFloat?
    /// True once a move on the open list turned out to be a scroll, until the finger lets go.
    @State private var scrolls = false

    var body: some View {
        // The width comes from the window and is read here only: nothing laid out depends on
        // the list, so its width can never feed back into itself.
        GeometryReader { window in
            let width = DrawerMotion.width(window: window.size.width)
            let open = model.showsAgents
            let progress = DrawerMotion.progress(open: open, translation: drag, width: width)
            ZStack(alignment: .leading) {
                if open || drag != nil {
                    Color.black
                        .opacity(0.28 * progress)
                        .ignoresSafeArea()
                        .contentShape(.rect)
                        .onTapGesture { close() }
                        .gesture(closing(width: width))
                        .accessibilityHidden(true)
                        .transition(.opacity)
                    DrawerPanel(close: close)
                        .frame(width: width)
                        .frame(maxHeight: .infinity)
                        .background {
                            Color(.systemBackground)
                                .shadow(color: .black.opacity(0.18 * progress), radius: 18)
                                .ignoresSafeArea()
                        }
                        .offset(x: reduceMotion ? 0 : -width * (1 - progress))
                        .opacity(reduceMotion ? progress : 1)
                        .simultaneousGesture(closing(width: width))
                        .transition(reduceMotion ? .opacity : .move(edge: .leading))
                        .accessibilityElement(children: .contain)
                        .accessibilityAddTraits(.isModal)
                        .accessibilityAction(.escape) { close() }
                }
            }
            .animation(Self.motion(reduceMotion), value: open)
        }
        .onChange(of: model.showsAgents) {
            if model.showsAgents { Self.endEditing() }
        }
    }

    /// The spring the list settles with, or a fade.
    static func motion(_ reduceMotion: Bool) -> Animation {
        reduceMotion ? .easeInOut(duration: 0.2) : .spring(duration: 0.35, bounce: 0)
    }

    /// The keyboard goes down when the list comes in.
    static func endEditing() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }

    private func close() {
        withAnimation(Self.motion(reduceMotion)) {
            model.showsAgents = false
            drag = nil
        }
    }

    /// A swipe to the left on the open list or the dimmed chat. A move that starts up or down is
    /// the list scrolling and leaves the list where it is.
    private func closing(width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 12, coordinateSpace: .global)
            .onChanged { move in
                guard model.showsAgents, !scrolls else { return }
                if drag == nil, abs(move.translation.height) > abs(move.translation.width) {
                    scrolls = true
                    return
                }
                drag = min(0, move.translation.width)
            }
            .onEnded { move in
                scrolls = false
                guard drag != nil else { return }
                let stays = DrawerMotion.staysOpen(open: true, predicted: move.predictedEndTranslation.width, width: width)
                withAnimation(Self.motion(reduceMotion)) {
                    model.showsAgents = stays
                    drag = nil
                }
            }
    }
}

/// A swipe to the right from the left edge of the chat. It reports the finger's move, and where
/// the list would come to rest with its speed when the finger lets go.
struct EdgeSwipe: UIGestureRecognizerRepresentable {
    var moved: (CGFloat) -> Void
    var ended: (_ predicted: CGFloat) -> Void

    func makeUIGestureRecognizer(context: Context) -> UIScreenEdgePanGestureRecognizer {
        let recognizer = UIScreenEdgePanGestureRecognizer()
        recognizer.edges = .left
        return recognizer
    }

    func handleUIGestureRecognizerAction(_ recognizer: UIScreenEdgePanGestureRecognizer, context: Context) {
        let moved = recognizer.translation(in: recognizer.view).x
        switch recognizer.state {
        case .began, .changed:
            self.moved(moved)
        case .ended:
            // About where the finger's speed would carry the list in a fifth of a second.
            ended(moved + recognizer.velocity(in: recognizer.view).x * 0.2)
        case .cancelled, .failed:
            ended(0)
        default:
            break
        }
    }
}

/// What the drawer shows: the heading, the agents as a messenger lists its chats, and the
/// person with the way to the settings at the foot.
private struct DrawerPanel: View {
    @Environment(AppModel.self) private var model
    let close: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 4) {
                PersonMenu(close: close)
                Button(action: close) {
                    Image(systemName: "sidebar.left")
                        .font(.body.weight(.medium))
                        .frame(width: 44, height: 44)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .accessibilityLabel("Hide the wizards")
            }
            .padding(.horizontal, 8)
            .padding(.top, 4)
            Text("Wizards")
                .font(.footnote.weight(.medium))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 20)
                .padding(.top, 8)
                .accessibilityAddTraits(.isHeader)
            ScrollView {
                LazyVStack(spacing: 2) {
                    ForEach(AgentList.ordered(model.agents)) { agent in
                        let current = agent.id == model.currentAgent?.id
                        Button {
                            if current { close() } else { model.select(agent) }
                        } label: {
                            AgentListRow(agent: agent, badge: AgentBadge(for: agent, onScreen: current))
                                .padding(.horizontal, 10)
                                .padding(.vertical, 2)
                                .contentShape(.rect)
                        }
                        .buttonStyle(DrawerRowStyle(current: current))
                        .accessibilityAddTraits(current ? .isSelected : [])
                    }
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
            }
            .scrollBounceBehavior(.basedOnSize)
            HStack {
                SettingsButton(before: close)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8)
            .padding(.bottom, 4)
        }
    }
}

/// The row of the agent on screen is filled; a row being pressed is filled lightly.
private struct DrawerRowStyle: ButtonStyle {
    let current: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color(.secondarySystemFill).opacity(current ? 1 : configuration.isPressed ? 0.6 : 0))
            }
    }
}

/// Whose Bot Server this is: the person's head and name, and the Bot Server, opening their own
/// things. It heads the drawer and the sidebar.
struct PersonMenu: View {
    @Environment(AppModel.self) private var model
    var close: () -> Void = {}
    @State private var asksSignOut = false
    @State private var showsAvatar = false

    var body: some View {
        Menu {
            if model.link != nil {
                Button(AvatarPictures.shared.has ? LocalizedStringKey("Your avatar") : "Make your avatar", systemImage: "face.smiling") {
                    showsAvatar = true
                }
                Button("Sign out", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                    asksSignOut = true
                }
            } else {
                Button("Connect to a Bot Server", systemImage: "house") {
                    close()
                    model.showsPairing = true
                }
            }
        } label: {
            HStack(spacing: 12) {
                AvatarPicture(view: .head)
                    .frame(width: 40, height: 40)
                    .frame(width: 44)
                VStack(alignment: .leading, spacing: 1) {
                    Text(model.link?.name ?? String(localized: "This device"))
                        .font(.body.weight(.medium))
                        .foregroundStyle(Color.primary)
                        .lineLimit(1)
                    if let link = model.link {
                        Text(BotServerName.of(link.baseURL))
                            .font(.subheadline)
                            .foregroundStyle(Color.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .confirmationDialog("Sign out of this Bot Server?", isPresented: $asksSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) {
                Task { await model.signOut() }
            }
        } message: {
            Text("This device forgets the Bot Server. Your conversations stay on your Bot Server.")
        }
        .sheet(isPresented: $showsAvatar) {
            AvatarSheet()
        }
    }
}

/// Which Bot Server this is, as the person knows it: its host where it has a name of its own
/// (`ada.wizards.bot`), "Your Bot Server" where it is reached at an address of the network.
enum BotServerName {
    static func of(_ url: URL) -> String {
        let host = url.host() ?? ""
        let numeric = host.isEmpty || host == "localhost" || host.contains(":")
            || host.allSatisfy { $0.isNumber || $0 == "." }
        return numeric ? String(localized: "Your Bot Server") : host
    }
}

/// The gear at the foot of the drawer and the sidebar.
struct SettingsButton: View {
    @Environment(AppModel.self) private var model
    var before: () -> Void = {}

    var body: some View {
        Button {
            before()
            model.showsSettings = true
        } label: {
            Image(systemName: "gearshape")
                .font(.title3)
                .frame(width: 44, height: 44)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .accessibilityLabel("Settings")
    }
}

/// The person's avatar, whole, and where it is made.
private struct AvatarSheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let has = AvatarPictures.shared.has
        NavigationStack {
            VStack(spacing: 20) {
                if has {
                    AvatarPicture(view: .body)
                        .frame(width: 200, height: 200)
                }
                Text(has ? LocalizedStringKey("You change your avatar in the web app.") : "You make your avatar in the web app.")
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .padding(32)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .navigationTitle("Your avatar")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", systemImage: "xmark") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium])
    }
}

/// The person's avatar as the home draws it. Until the home answered, the one it drew last;
/// without an avatar, a plain figure.
struct AvatarPicture: View {
    enum Part: String {
        case head, body
    }

    @Environment(AppModel.self) private var model
    @Environment(\.displayScale) private var scale
    let view: Part

    var body: some View {
        let pictures = AvatarPictures.shared
        Group {
            if let image = pictures.images[view] {
                Image(uiImage: image)
                    .resizable()
                    .interpolation(.none)
                    .scaledToFit()
            } else {
                Image(systemName: "person.crop.circle.fill")
                    .resizable()
                    .scaledToFit()
                    .foregroundStyle(.tertiary)
            }
        }
        .accessibilityHidden(true)
        .task(id: model.link?.baseURL) {
            guard let client = model.client else { return }
            await pictures.load(view, from: client, pixels: view == .head ? Int(40 * scale) : Int(200 * scale))
        }
    }
}

/// The pictures of the person's avatar this app has, kept while it runs.
@Observable final class AvatarPictures {
    static let shared = AvatarPictures()

    private(set) var images: [AvatarPicture.Part: UIImage] = [:]
    /// False once the home said there is no avatar.
    private(set) var has = true
    /// The home the pictures are of.
    private var home: URL?

    func load(_ part: AvatarPicture.Part, from client: HomeClient, pixels: Int) async {
        if client.baseURL != home {
            home = client.baseURL
            images = [:]
            has = true
        }
        var request = client.request("GET", "/v1/avatar.png", query: [
            URLQueryItem(name: "size", value: String(pixels)),
            URLQueryItem(name: "view", value: part.rawValue),
        ])
        request.setValue("image/png", forHTTPHeaderField: "Accept")
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let status = (response as? HTTPURLResponse)?.statusCode else { return }
        if status == 404 {
            has = false
            images = [:]
        } else if (200 ..< 300).contains(status), let image = UIImage(data: data) {
            has = true
            images[part] = image
        }
    }
}
