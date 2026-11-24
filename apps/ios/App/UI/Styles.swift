import CoreImage.CIFilterBuiltins
import SwiftUI

extension Color {
    /// Text on the accent colour.
    static let onAccent = Color(hex: 0x090D16)
}

/// Petrol, the ground of the pairing screens: the default colours of the web app's branded theme.
enum Petrol {
    static let ground = Color(hex: 0x0B4553)
    static let card = Color(hex: 0x13525F)
    static let divider = Color(hex: 0x1D6170)
    static let ink = Color(hex: 0xEEF4F3)
    static let ink2 = Color(hex: 0xC7D9DA)
    static let ink3 = Color(hex: 0x9FBCBF)
    /// The fill of the main button.
    static let accent = Color(hex: 0xE8704F)
    /// Text on the accent fill.
    static let onAccent = Color(hex: 0x10262B)
    /// Links and symbols.
    static let accentMark = Color(hex: 0xF3A78F)
    static let ok = Color(hex: 0x7FD6A8)
}

/// The main button on Petrol: the accent fill, full width; `compact` fits it into a row.
struct PetrolButtonStyle: ButtonStyle {
    var compact = false
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(compact ? .callout.weight(.semibold) : .body.weight(.semibold))
            .multilineTextAlignment(.center)
            .foregroundStyle(Petrol.onAccent)
            .padding(.horizontal, compact ? 16 : 20)
            .frame(maxWidth: compact ? nil : .infinity, minHeight: compact ? 34 : 52)
            .background(Petrol.accent, in: .rect(cornerRadius: compact ? 10 : 14))
            .opacity(isEnabled ? (configuration.isPressed ? 0.75 : 1) : 0.4)
            // A compact button keeps a 44-point target.
            .padding(.vertical, compact ? 5 : 0)
            .contentShape(.rect)
            .hoverEffectDisabled()
    }
}

/// A heading on Petrol: 26 points at the standard text size, larger with Dynamic Type.
struct PetrolHeading: ViewModifier {
    @ScaledMetric(relativeTo: .title) private var size: CGFloat = 26

    func body(content: Content) -> some View {
        content
            .font(.system(size: size, weight: .semibold))
            .foregroundStyle(Petrol.ink)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isHeader)
    }
}

extension View {
    func petrolHeading() -> some View { modifier(PetrolHeading()) }
}

/// One level up: a chevron at the top left with a 44-point target.
struct PetrolBackButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "chevron.left")
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(Petrol.accentMark)
                .frame(width: 44, height: 44)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .hoverEffectDisabled()
        .accessibilityLabel("Back")
    }
}

/// A screen of the pairing flow on Petrol: the back button where there is a level to go back to,
/// the content scrolling below it, and what stays at the bottom.
struct PetrolScreen<Content: View, Bottom: View>: View {
    var back: (() -> Void)?
    @ViewBuilder var content: Content
    @ViewBuilder var bottom: Bottom

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                content
            }
            .padding(.horizontal, 24)
            .padding(.top, 8)
            .padding(.bottom, 16)
            .frame(maxWidth: 460, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .top, spacing: 0) {
            HStack {
                if let back { PetrolBackButton(action: back) }
                Spacer()
            }
            .frame(height: 44)
            .padding(.horizontal, 8)
            .background(Petrol.ground)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 4) {
                bottom
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 12)
            .frame(maxWidth: 460)
            .frame(maxWidth: .infinity)
            .background(Petrol.ground)
        }
        .foregroundStyle(Petrol.ink)
        .background(Petrol.ground.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
    }
}

extension PetrolScreen where Bottom == EmptyView {
    init(back: (() -> Void)?, @ViewBuilder content: () -> Content) {
        self.init(back: back, content: content, bottom: { EmptyView() })
    }
}

/// The buttons of a card: one filled for the main action, quiet ones for the rest.
struct ActionButtonStyle: ButtonStyle {
    let style: ActionStyle
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.callout.weight(.semibold))
            .multilineTextAlignment(.center)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .frame(minHeight: 44)
            .foregroundStyle(foreground)
            .background(background, in: .capsule)
            .opacity(isEnabled ? (configuration.isPressed ? 0.7 : 1) : 0.4)
            .contentShape(.capsule)
    }

    private var foreground: Color {
        switch style {
        case .primary: .onAccent
        case .danger: .red
        default: .primary
        }
    }

    private var background: AnyShapeStyle {
        switch style {
        case .primary: AnyShapeStyle(Color.accentColor)
        default: AnyShapeStyle(.fill.tertiary)
        }
    }
}

/// A QR code for a text, sharp at any size.
struct QRCode: View {
    let text: String

    var body: some View {
        if let image = Self.image(for: text) {
            Image(uiImage: image)
                .interpolation(.none)
                .resizable()
                .aspectRatio(1, contentMode: .fit)
                .padding(10)
                .background(.white, in: .rect(cornerRadius: 12))
                .accessibilityLabel("QR code")
        }
    }

    private static func image(for text: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage, let cg = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}

/// One quiet line: a small symbol and a few words.
struct QuietLine: View {
    let symbol: String
    let text: Text

    var body: some View {
        Label { text } icon: { Image(systemName: symbol) }
            .font(.footnote)
            .foregroundStyle(.secondary)
            .labelStyle(.titleAndIcon)
    }
}

/// A small count in the accent colour: cards that wait, or messages not read yet.
struct CountBadge: View {
    let count: Int

    var body: some View {
        Text(count, format: .number)
            .font(.footnote.weight(.semibold).monospacedDigit())
            .foregroundStyle(Color.onAccent)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(.tint, in: .capsule)
    }
}
