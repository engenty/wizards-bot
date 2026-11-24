import Foundation

/// The ten engenty figures. Shared with the Mac app, which draws the figure on its first screen.
nonisolated enum EngentyKind: OpenEnum {
    case round, drop, dome, flame, oval, bean, pebble, sprout, tower, wedge
    case unknown(String)

    static let known: [String: EngentyKind] = [
        "round": .round, "drop": .drop, "dome": .dome, "flame": .flame, "oval": .oval,
        "bean": .bean, "pebble": .pebble, "sprout": .sprout, "tower": .tower, "wedge": .wedge,
    ]
    var unknownValue: String? { if case .unknown(let raw) = self { raw } else { nil } }
}
