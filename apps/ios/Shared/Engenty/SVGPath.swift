import SwiftUI

/// Reads the path data of the engenty figures: the absolute commands M, L, H, V, C, Q and Z.
nonisolated enum SVGPath {
    static func path(_ data: String) -> Path {
        var path = Path()
        var numbers: [CGFloat] = []
        var command: Character?
        var current = CGPoint.zero

        func run() {
            guard let command else { return }
            switch command {
            case "M":
                var first = true
                for pair in pairs(numbers) {
                    if first { path.move(to: pair) } else { path.addLine(to: pair) }
                    first = false
                    current = pair
                }
            case "L":
                for pair in pairs(numbers) {
                    path.addLine(to: pair)
                    current = pair
                }
            case "H":
                for x in numbers {
                    current.x = x
                    path.addLine(to: current)
                }
            case "V":
                for y in numbers {
                    current.y = y
                    path.addLine(to: current)
                }
            case "Q":
                let points = pairs(numbers)
                for index in stride(from: 0, to: points.count - 1, by: 2) {
                    path.addQuadCurve(to: points[index + 1], control: points[index])
                    current = points[index + 1]
                }
            case "C":
                let points = pairs(numbers)
                for index in stride(from: 0, to: points.count - 2, by: 3) {
                    path.addCurve(to: points[index + 2], control1: points[index], control2: points[index + 1])
                    current = points[index + 2]
                }
            case "Z":
                path.closeSubpath()
            default:
                break
            }
        }

        var token = ""
        func flush() {
            if let value = Double(token) { numbers.append(CGFloat(value)) }
            token = ""
        }
        for character in data {
            if character.isLetter, character != "e" {
                flush()
                run()
                command = Character(character.uppercased())
                numbers = []
            } else if character == "," || character.isWhitespace {
                flush()
            } else if character == "-", !token.isEmpty, token.last != "e" {
                flush()
                token = "-"
            } else {
                token.append(character)
            }
        }
        flush()
        run()
        return path
    }

    private static func pairs(_ numbers: [CGFloat]) -> [CGPoint] {
        stride(from: 0, to: numbers.count - 1, by: 2).map { CGPoint(x: numbers[$0], y: numbers[$0 + 1]) }
    }
}
