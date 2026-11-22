import Foundation

/// Tells the voice's own words, picked up by the microphone, from the person talking over it.
nonisolated enum Echo {
    /// True when everything heard is something the voice just said.
    static func isEcho(_ heard: String, of spoken: [String]) -> Bool {
        let heardWords = words(heard)
        guard !heardWords.isEmpty else { return true }
        let said = Set(spoken.flatMap(words))
        guard !said.isEmpty else { return false }
        let foreign = heardWords.filter { !said.contains($0) }.count
        // One misheard word in five is still the voice.
        return foreign * 5 <= heardWords.count
    }

    private static func words(_ text: String) -> [String] {
        text.lowercased().split { !$0.isLetter && !$0.isNumber }.map(String.init)
    }
}
