import AppKit
import SwiftUI

/// Petrol, the web app's default branded ground: the colours and parts of the app's own screens
/// (everything before the web view, and the sheets).
enum Petrol {
    static let ground = Color(hex: 0x0B4553)
    static let card = Color(hex: 0x13525F)
    /// A card's row that holds the keyboard focus.
    static let cardFocus = Color(hex: 0x185B69)
    static let divider = Color(hex: 0x1D6170)
    static let ink = Color(hex: 0xEEF4F3)
    static let ink2 = Color(hex: 0xC7D9DA)
    static let ink3 = Color(hex: 0x9FBCBF)
    static let accent = Color(hex: 0xE8704F)
    static let onAccent = Color(hex: 0x10262B)
    static let accentMark = Color(hex: 0xF3A78F)
    static let ok = Color(hex: 0x7FD6A8)
    static let noticeCard = Color(hex: 0x3A3F2A)
    static let noticeInk = Color(hex: 0xF1ECD2)
    static let rose = Color(hex: 0xFF9C8A)

    static let groundColor = NSColor(red: 0x0B / 255, green: 0x45 / 255, blue: 0x53 / 255, alpha: 1)
}

/// The three kinds of button: the one to go on (accent fill), a light one beside it, and plain text.
struct PetrolButton: ButtonStyle {
    enum Kind { case primary, secondary, plain }
    var kind: Kind = .primary

    func makeBody(configuration: Configuration) -> some View {
        Face(kind: kind, configuration: configuration)
    }

    private struct Face: View {
        let kind: Kind
        let configuration: Configuration
        @Environment(\.isEnabled) private var enabled

        var body: some View {
            label
                .opacity(enabled ? (configuration.isPressed ? 0.8 : 1) : 0.45)
                .contentShape(.rect(cornerRadius: 8))
        }

        @ViewBuilder private var label: some View {
            switch kind {
            case .primary:
                configuration.label
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Petrol.onAccent)
                    .padding(.vertical, 8)
                    .padding(.horizontal, 18)
                    .background(Petrol.accent, in: .rect(cornerRadius: 8))
            case .secondary:
                configuration.label
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Petrol.onAccent)
                    .padding(.vertical, 6)
                    .padding(.horizontal, 12)
                    .background(Petrol.ink, in: .rect(cornerRadius: 7))
            case .plain:
                configuration.label
                    .font(.system(size: 13))
                    .foregroundStyle(Petrol.ink2)
                    .padding(.vertical, 8)
                    .padding(.horizontal, 4)
            }
        }
    }
}

extension View {
    /// A button of the app's own screens, without a focus ring.
    func petrolButton(_ kind: PetrolButton.Kind = .primary) -> some View {
        buttonStyle(PetrolButton(kind: kind)).focusEffectDisabled()
    }

    /// The ground of the app's own screens: Petrol, dark.
    func petrolGround() -> some View {
        environment(\.colorScheme, .dark)
            .tint(Petrol.accentMark)
            .background(Petrol.ground.ignoresSafeArea())
    }
}

/// A card: rows on the card colour, rounded 10. Rows put `PetrolDivider` between them.
struct PetrolCard<Content: View>: View {
    var fill = Petrol.card
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content }
            .background(fill)
            .clipShape(.rect(cornerRadius: 10))
    }
}

struct PetrolDivider: View {
    var body: some View {
        Petrol.divider.frame(height: 1)
    }
}

/// A row of a card that is a field: its label at a fixed width, the field borderless beside it.
/// The row holding the focus is a little lighter.
struct PetrolFieldRow<Field: View>: View {
    let label: LocalizedStringKey
    var focused = false
    @ViewBuilder let field: Field

    var body: some View {
        HStack(spacing: 12) {
            Text(label)
                .font(.system(size: 13))
                .foregroundStyle(Petrol.ink3)
                .frame(width: 84, alignment: .leading)
            field
                .textFieldStyle(.plain)
                .font(.system(size: 13))
                .foregroundStyle(Petrol.ink)
                .focusEffectDisabled()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .background(focused ? Petrol.cardFocus : .clear)
    }
}

/// A heading of the app's own screens, once per screen.
struct PetrolHeading: View {
    let text: LocalizedStringKey

    init(_ text: LocalizedStringKey) { self.text = text }

    var body: some View {
        Text(text)
            .font(.system(size: 20, weight: .semibold))
            .foregroundStyle(Petrol.ink)
    }
}

/// The window of the app's own screens: Petrol, dark, behind a title bar without a title; the web
/// app's window as macOS draws it. SwiftUI keeps the colour scheme and the title bar's background,
/// the window keeps its title and colour.
struct WindowLook: ViewModifier {
    let native: Bool

    func body(content: Content) -> some View {
        content
            .preferredColorScheme(native ? .dark : nil)
            .toolbarBackground(native ? .hidden : .automatic, for: .windowToolbar)
            .background(Probe(native: native))
    }

    private struct Probe: NSViewRepresentable {
        let native: Bool

        func makeNSView(context: Context) -> Window { Window() }

        func updateNSView(_ view: Window, context: Context) {
            view.native = native
        }
    }

    /// Sets the title and the colour of the window it is in, also once it reaches one.
    final class Window: NSView {
        var native = true {
            didSet { apply() }
        }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            apply()
        }

        private func apply() {
            guard let window else { return }
            window.titleVisibility = native ? .hidden : .visible
            window.backgroundColor = native ? Petrol.groundColor : .windowBackgroundColor
        }
    }
}
