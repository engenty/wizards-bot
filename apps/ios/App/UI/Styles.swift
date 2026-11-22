import CoreImage.CIFilterBuiltins
import SwiftUI

extension Color {
    /// Text on the accent colour.
    static let onAccent = Color(hex: 0x090D16)
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
