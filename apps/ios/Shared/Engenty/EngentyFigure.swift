import SwiftUI

/// One of the ten engenty figures, drawn from the brand's SVG shapes (120 × 120).
struct EngentyFigure: View {
    let kind: EngentyKind
    /// Bobs gently, for an agent that is working. Still when the person asked for less motion.
    var lively = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let shape = EngentyShape.of(kind)
        Group {
            if lively, !reduceMotion {
                TimelineView(.animation(minimumInterval: 1 / 30)) { timeline in
                    let phase = timeline.date.timeIntervalSinceReferenceDate
                    canvas(shape)
                        .offset(y: sin(phase * 2 * .pi / 1.8) * 1.6)
                }
            } else {
                canvas(shape)
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .accessibilityHidden(true)
    }

    private func canvas(_ shape: EngentyShape) -> some View {
        Canvas { context, size in
            let scale = min(size.width, size.height) / 120
            context.translateBy(x: (size.width - 120 * scale) / 2, y: (size.height - 120 * scale) / 2)
            context.scaleBy(x: scale, y: scale)
            for mark in shape.marks {
                context.opacity = mark.opacity
                switch mark.form {
                case .fill(let path):
                    context.fill(path, with: .color(mark.color))
                case .stroke(let path, let width):
                    context.stroke(path, with: .color(mark.color), style: StrokeStyle(lineWidth: width, lineCap: .round))
                }
            }
        }
    }
}

/// The marks of one figure, back to front.
nonisolated struct EngentyShape: Sendable {
    nonisolated struct Mark: Sendable {
        nonisolated enum Form: Sendable {
            case fill(Path)
            case stroke(Path, width: CGFloat)
        }

        var form: Form
        var color: Color
        var opacity: Double = 1
    }

    /// The figure's own colour.
    let fill: Color
    let marks: [Mark]

    static func of(_ kind: EngentyKind) -> EngentyShape {
        shapes[kind] ?? shapes[.round]!
    }

    /// The colour of a kind, for a tint or a dot.
    static func color(of kind: EngentyKind) -> Color { of(kind).fill }

    private static let shapes: [EngentyKind: EngentyShape] = [
        .round: make(0x2873FF, pupil: 0x000E34, eye: (68, 58, 8), [
            .body("M60 22 C65.2 22 71.2 24 75.8 26 C80.2 28 84 30.7 87 34 C90 37.3 92.2 41.3 93.8 46 C95.2 50.7 96 56.8 96 62 C96 67.2 95.2 72.7 93.8 77.1 C92.2 81.5 90 85.3 87 88.5 C84 91.7 80.2 94.2 75.8 96.1 C71.2 98 65.2 100 60 100 C54.8 100 48.8 98 44.2 96.1 C39.8 94.2 36 91.7 33 88.5 C30 85.3 27.8 81.5 26.2 77.1 C24.8 72.7 24 67.2 24 62 C24 56.8 24.8 50.7 26.2 46 C27.8 41.3 30 37.3 33 34 C36 30.7 39.8 28 44.2 26 C48.8 24 54.8 22 60 22 Z"),
            .dot(97, 34, 6, nil, 0.5), .dot(106, 24, 3.5, nil, 0.35),
        ]),
        .drop: make(0xFFB407, pupil: 0x501C00, eye: (60, 56, 8), [
            .body("M60 16 Q90 34 90 66 Q90 96 60 98 Q30 96 30 66 Q30 34 60 16 Z"),
        ], after: [
            .line("M49 75 C54 78 64 78.5 71 71.4", 0x511A00, 2.6, 1),
        ]),
        .dome: make(0x19C63C, pupil: 0x001602, eye: (60, 54, 8.5), [
            .body("M60 20 Q92 30 92 70 Q92 96 60 96 Q28 96 28 70 Q28 30 60 20 Z"),
            .line("M46 90 L46 80 M60 92 L60 82 M74 90 L74 80", 0x003610, 2.4, 0.5),
            .dot(60, 6, 3, nil, 1),
        ]),
        .flame: make(0xFF154F, pupil: 0x3D0007, eye: (60, 62, 8), [
            .body("M60 14 Q84 44 80 76 Q78 98 60 98 Q42 98 40 76 Q36 44 60 14 Z"),
            .line("M40 20 Q60 6 80 20", nil, 3, 0.55),
        ], after: [
            .dot(60, 82, 2.6, 0x3D0007, 1),
        ]),
        .oval: make(0xFF6404, pupil: 0x430000, eye: (66, 58, 8), [
            .body("M60 34 Q100 38 100 64 Q100 92 60 94 Q20 92 20 64 Q20 38 60 34 Z"),
            .line("M28 54 Q60 48 92 54", 0x8A0700, 2.2, 0.45),
            .line("M26 70 Q60 64 94 70", 0x8A0700, 2.2, 0.45),
        ]),
        .bean: make(0x00C9C5, pupil: 0x001A1F, eye: (70, 58, 8), [
            .body("M48 96 Q24 92 26 68 Q28 44 52 38 Q78 32 88 50 Q98 66 84 84 Q70 100 48 96 Z"),
            .dot(32, 94, 4, nil, 0.4),
        ]),
        .pebble: make(0x259ED6, pupil: 0x00182F, eye: (68, 72, 7.5), [
            .body("M60 96 Q20 96 18 78 Q16 60 46 56 Q78 52 98 62 Q110 72 104 86 Q98 96 60 96 Z"),
            .dot(42, 76, 3, 0x163045, 0.32), .dot(56, 86, 2.2, 0x163045, 0.32), .dot(86, 80, 2.6, 0x163045, 0.32),
        ]),
        .sprout: make(0xD0EB24, pupil: 0x242100, eye: (60, 68, 8.5), [
            .oval(48, 34, 6, 10), .oval(72, 32, 5.5, 9),
            .body("M60 100 Q28 98 28 72 Q28 46 60 44 Q92 46 92 72 Q92 98 60 100 Z"),
        ]),
        .tower: make(0x9B48FB, pupil: 0x210434, eye: (60, 52, 8), [
            .body("M60 102 Q36 100 38 78 Q40 58 42 44 Q44 26 60 24 Q76 26 78 44 Q80 58 82 78 Q84 100 60 102 Z"),
            .line("M42 74 Q60 70 78 74", 0x37164E, 2.2, 0.4),
            .line("M40 88 Q60 84 80 88", 0x37164E, 2.2, 0.4),
        ]),
        .wedge: make(0xF800B5, pupil: 0x370025, eye: (60, 70, 8), [
            .body("M60 30 Q74 40 86 70 Q96 92 78 98 Q60 102 42 98 Q24 92 34 70 Q46 40 60 30 Z"),
            .line("M52 22 Q60 14 68 22", nil, 3, 0.5),
        ]),
    ]

    /// A piece of a figure as the SVG writes it. A nil colour is the figure's own.
    nonisolated private enum Piece {
        case body(String)
        case dot(CGFloat, CGFloat, CGFloat, UInt32?, Double)
        case oval(CGFloat, CGFloat, CGFloat, CGFloat)
        case line(String, UInt32?, CGFloat, Double)
    }

    private static func make(
        _ fill: UInt32, pupil: UInt32, eye: (x: CGFloat, y: CGFloat, r: CGFloat), _ pieces: [Piece], after: [Piece] = []
    ) -> EngentyShape {
        let own = Color(hex: fill)
        func marks(_ pieces: [Piece]) -> [Mark] {
            pieces.map { piece in
                switch piece {
                case .body(let data):
                    Mark(form: .fill(SVGPath.path(data)), color: own)
                case .dot(let x, let y, let r, let color, let opacity):
                    Mark(form: .fill(Path(ellipseIn: CGRect(x: x - r, y: y - r, width: r * 2, height: r * 2))),
                         color: color.map(Color.init(hex:)) ?? own, opacity: opacity)
                case .oval(let x, let y, let rx, let ry):
                    Mark(form: .fill(Path(ellipseIn: CGRect(x: x - rx, y: y - ry, width: rx * 2, height: ry * 2))), color: own)
                case .line(let data, let color, let width, let opacity):
                    Mark(form: .stroke(SVGPath.path(data), width: width), color: color.map(Color.init(hex:)) ?? own, opacity: opacity)
                }
            }
        }
        // The eye: a white oval a little taller than wide, the pupil just below its middle, a glint up left.
        let r = eye.r
        let eyeMarks = [
            Mark(form: .fill(Path(ellipseIn: CGRect(x: eye.x - r, y: eye.y - r * 1.15, width: r * 2, height: r * 2.3))), color: .white),
            Mark(form: .fill(Path(ellipseIn: CGRect(x: eye.x - r * 0.48, y: eye.y + 1 - r * 0.48, width: r * 0.96, height: r * 0.96))),
                 color: Color(hex: pupil)),
            Mark(form: .fill(Path(ellipseIn: CGRect(x: eye.x - r * 0.25 - r * 0.18, y: eye.y - r * 0.3 - r * 0.18,
                                                    width: r * 0.36, height: r * 0.36))), color: .white),
        ]
        return EngentyShape(fill: own, marks: marks(pieces) + eyeMarks + marks(after))
    }
}

extension Color {
    nonisolated init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255
        )
    }
}

#Preview {
    LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 5)) {
        ForEach(Array(EngentyKind.known.values), id: \.self) { kind in
            EngentyFigure(kind: kind)
        }
    }
    .padding()
}
