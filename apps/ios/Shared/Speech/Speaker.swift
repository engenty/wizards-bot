import AVFoundation
import NaturalLanguage
import Observation

/// Somewhere else to play the voice: the microphone's own audio engine, whose echo cancellation
/// then knows the voice and takes it out of what the microphone hears.
nonisolated protocol SpeechRoute: AnyObject, Sendable {
    func play(_ buffer: AVAudioPCMBuffer)
    var isPlaying: Bool { get }
    /// Called, on any thread, when the last buffer played.
    var onDrained: @Sendable () -> Void { get set }
    func stop()
}

/// Reads sentences aloud, one after the other, with the best voice installed for their language.
@MainActor @Observable
final class Speaker: NSObject, AVSpeechSynthesizerDelegate {
    private(set) var isSpeaking = false
    /// The sentences of the current reply said or being said, to tell the voice's own echo from the person.
    private(set) var recent: [String] = []
    /// When the voice last went quiet.
    private(set) var quietSince = Date.distantPast

    /// Where the voice plays while the microphone listens. Nil: the synthesizer plays it itself.
    @ObservationIgnored var route: SpeechRoute? {
        didSet {
            stop()
            route?.onDrained = { [weak self] in Task { @MainActor in self?.drained() } }
        }
    }
    @ObservationIgnored private var unwritten: [AVSpeechUtterance] = []
    @ObservationIgnored private var writing = false
    @ObservationIgnored private var generation = 0

    @ObservationIgnored private let synthesizer = AVSpeechSynthesizer()
    @ObservationIgnored private var queued = 0
    @ObservationIgnored private var voices: [String: AVSpeechSynthesisVoice] = [:]
    @ObservationIgnored private var language: String?
    @ObservationIgnored private var waiters: [CheckedContinuation<Void, Never>] = []

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    /// Says a sentence after the ones already waiting.
    func say(_ sentence: String) {
        let text = sentence.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = voice(for: text)
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        utterance.postUtteranceDelay = 0.05
        isSpeaking = true
        recent = Array((recent + [text]).suffix(40))
        if route != nil {
            unwritten.append(utterance)
            writeNext()
        } else {
            queued += 1
            synthesizer.speak(utterance)
        }
    }

    /// Stops at once and drops what was waiting.
    func stop() {
        guard isSpeaking else { return }
        generation += 1
        synthesizer.stopSpeaking(at: .immediate)
        route?.stop()
        unwritten = []
        writing = false
        queued = 0
        settle()
    }

    /// Turns the next sentence into sound and hands it to the route, one sentence at a time.
    private func writeNext() {
        guard !writing, let route else { return }
        guard !unwritten.isEmpty else {
            if !route.isPlaying { drained() }
            return
        }
        writing = true
        let utterance = unwritten.removeFirst()
        let mine = generation
        synthesizer.write(utterance) { [weak self, route] buffer in
            guard let sound = buffer as? AVAudioPCMBuffer else { return }
            if sound.frameLength == 0 {
                Task { @MainActor in
                    guard let self, self.generation == mine else { return }
                    self.writing = false
                    self.writeNext()
                }
            } else {
                route.play(sound)
            }
        }
    }

    /// The route played everything it had: quiet once nothing is left to write.
    private func drained() {
        guard route != nil, isSpeaking, !writing, unwritten.isEmpty, route?.isPlaying == false else { return }
        settle()
    }

    /// Returns once nothing is being said.
    func finished() async {
        guard isSpeaking else { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    /// Forgets the language of the last reply, so the next one is heard afresh.
    func startReply() {
        language = nil
        recent = []
    }

    private func settle() {
        isSpeaking = false
        quietSince = .now
        let waiting = waiters
        waiters = []
        for waiter in waiting { waiter.resume() }
    }

    private func ended() {
        queued = max(0, queued - 1)
        if queued == 0, isSpeaking { settle() }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in self.ended() }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {}

    /// The voice for a text: its language is recognised from the first longer sentence of a reply and kept.
    private func voice(for text: String) -> AVSpeechSynthesisVoice? {
        if language == nil || text.count > 24 {
            let recognizer = NLLanguageRecognizer()
            recognizer.processString(text)
            if let (found, confidence) = recognizer.languageHypotheses(withMaximum: 1).first, confidence > 0.6 || language == nil {
                language = found.rawValue
            }
        }
        let code = language ?? Locale.current.language.languageCode?.identifier ?? "en"
        if let known = voices[code] { return known }
        let best = Self.bestVoice(for: code)
        voices[code] = best
        return best
    }

    /// The best installed voice for a language: premium before enhanced before standard, the device's region first.
    static func bestVoice(for languageCode: String) -> AVSpeechSynthesisVoice? {
        let region = Locale.current.region?.identifier
        let preferred = region.map { "\(languageCode)-\($0)" }
        let candidates = AVSpeechSynthesisVoice.speechVoices().filter {
            $0.language == languageCode || $0.language.hasPrefix(languageCode + "-")
        }
        func rank(_ voice: AVSpeechSynthesisVoice) -> Int {
            let quality = switch voice.quality {
            case .premium: 20
            case .enhanced: 10
            default: 0
            }
            return quality + (voice.language == preferred ? 2 : 0)
        }
        return candidates.max { rank($0) < rank($1) } ?? AVSpeechSynthesisVoice(language: preferred ?? languageCode)
            ?? AVSpeechSynthesisVoice(language: languageCode)
    }
}

/// Speaks one reply while it streams: text goes in as it arrives, sentences come out of the voice.
@MainActor
final class ReplyVoice {
    let messageId: String
    private let speaker: Speaker
    private var splitter = SentenceSplitter()
    private var spokeAnything = false
    private(set) var isSilenced = false

    init(messageId: String, speaker: Speaker) {
        self.messageId = messageId
        self.speaker = speaker
        speaker.startReply()
    }

    /// More text of the reply.
    func add(_ text: String) {
        guard !isSilenced else { return }
        for sentence in splitter.feed(text) {
            spokeAnything = true
            speaker.say(sentence)
        }
    }

    /// The reply is complete. `whole` is its full text, read when no text came in while it was written.
    func finish(whole: String) {
        guard !isSilenced else { return }
        if let rest = splitter.finish() {
            spokeAnything = true
            speaker.say(rest)
        }
        if !spokeAnything {
            for sentence in SentenceSplitter.sentences(in: whole) { speaker.say(sentence) }
        }
        isSilenced = true
    }

    /// The person started talking: stop and say no more of this reply.
    func silence() {
        isSilenced = true
        speaker.stop()
    }
}
