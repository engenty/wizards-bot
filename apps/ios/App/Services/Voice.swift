import AVFoundation
import Observation
import Speech

/// Talking to the agent. Hold the microphone to say one message; tap it for talk mode, where the
/// app keeps listening and reads every reply aloud, sentence by sentence, while it is written.
@Observable
final class Voice {
    enum Mode: Equatable { case off, holding, talking }

    private(set) var mode: Mode = .off
    /// The words heard so far.
    private(set) var heard = ""
    /// A sentence when the app cannot listen.
    var problem: String?
    let speaker = Speaker()

    /// Called in talk mode when the person finished a sentence.
    @ObservationIgnored var onUtterance: (String) -> Void = { _ in }

    @ObservationIgnored private let ear = Ear()
    @ObservationIgnored private var reply: ReplyVoice?
    @ObservationIgnored private var finished: Set<String> = []
    @ObservationIgnored private var lastChange = Date.now
    @ObservationIgnored private var watcher: Task<Void, Never>?
    @ObservationIgnored private var wantsHold = false
    @ObservationIgnored private var failures = 0

    init() {
        ear.onPartial = { [weak self] in self?.partial($0) }
    }

    // MARK: Hold to talk

    /// The person pressed the microphone and keeps it pressed.
    func beginHold() async {
        wantsHold = true
        guard mode == .off, await allowed(), wantsHold, mode == .off else { return }
        guard AudioSession.listen(), ear.open(echoCancelled: false), ear.listen() else {
            cannotListen()
            return
        }
        heard = ""
        mode = .holding
    }

    /// The person let go: what was heard, if anything.
    func endHold() -> String? {
        wantsHold = false
        guard mode == .holding else { return nil }
        let text = heard.trimmingCharacters(in: .whitespacesAndNewlines)
        quiet()
        return text.isEmpty ? nil : text
    }

    // MARK: Talk mode

    func startTalk() async {
        guard mode == .off, await allowed(), mode == .off else { return }
        // The voice plays while the microphone is open, so its own sound is taken out of what is heard.
        guard AudioSession.listen(), ear.open(echoCancelled: true), ear.listen() else {
            cannotListen()
            return
        }
        // The voice plays through the microphone's engine, so its echo cancellation knows it.
        speaker.route = ear.playback
        heard = ""
        failures = 0
        lastChange = .now
        mode = .talking
        watcher = Task { [weak self] in
            var wasSpeaking = false
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(200))
                guard let self, self.mode == .talking else { return }
                self.tick(wasSpeaking: wasSpeaking)
                wasSpeaking = self.speaker.isSpeaking
            }
        }
    }

    func stopTalk() {
        guard mode != .off else { return }
        quiet()
    }

    private func tick(wasSpeaking: Bool) {
        let speaking = speaker.isSpeaking
        if !heard.isEmpty, !speaking, Date.now.timeIntervalSince(lastChange) > 1.2 {
            // The person paused: that was a sentence.
            let text = heard.trimmingCharacters(in: .whitespacesAndNewlines)
            heard = ""
            restartWindow()
            if !text.isEmpty { onUtterance(text) }
        } else if wasSpeaking, !speaking, heard.isEmpty || Echo.isEcho(heard, of: speaker.recent) {
            // The voice went quiet: a fresh window, so what it said is not taken for the person.
            heard = ""
            restartWindow()
        } else if !ear.isListening {
            restartWindow()
        }
    }

    private func restartWindow() {
        if ear.listen() {
            failures = 0
        } else {
            failures += 1
            if failures > 8 { cannotListen() }
        }
    }

    private func partial(_ text: String) {
        if mode == .talking, speaker.isSpeaking {
            if Echo.isEcho(text, of: speaker.recent) { return }
            // The person talks over the voice: it stops and listens.
            reply?.silence()
        } else if mode == .talking, Date.now.timeIntervalSince(speaker.quietSince) < 1.5,
                  Echo.isEcho(text, of: speaker.recent) {
            // What the microphone still hands over of the voice once it went quiet.
            return
        }
        heard = text
        lastChange = .now
    }

    // MARK: Replies

    /// A reply started or changed as a whole. In talk mode it is read aloud.
    func reply(_ messageId: String, started text: String, done: Bool) {
        guard mode == .talking, !finished.contains(messageId) else { return }
        if reply?.messageId != messageId {
            reply = ReplyVoice(messageId: messageId, speaker: speaker)
            if !done, !text.isEmpty { reply?.add(text) }
        }
        if done {
            reply?.finish(whole: text)
            finished.insert(messageId)
        }
    }

    /// A reply that is being written grew by `text`.
    func reply(_ messageId: String, grew text: String) {
        guard mode == .talking, reply?.messageId == messageId else { return }
        reply?.add(text)
    }

    // MARK: Permission

    private func allowed() async -> Bool {
        let speech = await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            SFSpeechRecognizer.requestAuthorization { @Sendable status in continuation.resume(returning: status == .authorized) }
        }
        // One question is enough when the first answer was no.
        let microphone = speech ? await AVAudioApplication.requestRecordPermission() : false
        if !(speech && microphone) {
            problem = String(localized: "wizards.bot may not use the microphone or speech recognition. You can allow both in Settings.")
        }
        return speech && microphone
    }

    private func cannotListen() {
        quiet()
        problem = ear.unsupported
            ? String(localized: "This device can’t turn speech into text in your language without sending it away.")
            : String(localized: "This device can’t listen right now. Try again in a moment.")
    }

    private func quiet() {
        watcher?.cancel()
        watcher = nil
        reply?.silence()
        reply = nil
        speaker.stop()
        speaker.route = nil
        ear.close()
        AudioSession.rest()
        mode = .off
        heard = ""
    }
}

/// The microphone and the recogniser. Speech is turned into text on the device only.
private final class Ear {
    var onPartial: (String) -> Void = { _ in }
    private(set) var isListening = false
    /// True when the device has no on-device recognition for the person's language.
    private(set) var unsupported = false

    private let engine = AVAudioEngine()
    private let target = Target()
    /// Plays the voice through this engine while echo cancellation is on.
    private(set) var playback: Playback?
    private var tapped = false
    private var recognizer: SFSpeechRecognizer?
    private var task: SFSpeechRecognitionTask?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var window = 0

    /// Opens the microphone. True when it is open.
    func open(echoCancelled: Bool) -> Bool {
        close()
        guard AVAudioSession.sharedInstance().isInputAvailable else { return false }
        let input = engine.inputNode
        try? input.setVoiceProcessingEnabled(echoCancelled)
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { return false }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { @Sendable [target] buffer, _ in
            target.request?.append(buffer)
        }
        tapped = true
        if echoCancelled { playback = Playback(engine: engine) }
        engine.prepare()
        do {
            try engine.start()
            return true
        } catch {
            close()
            return false
        }
    }

    /// Starts a fresh listening window. True when the recogniser took it.
    func listen() -> Bool {
        endWindow()
        guard let recognizer = recognizer ?? Self.makeRecognizer() else {
            unsupported = true
            return false
        }
        self.recognizer = recognizer
        guard recognizer.supportsOnDeviceRecognition else {
            unsupported = true
            return false
        }
        guard recognizer.isAvailable else { return false }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = true
        request.addsPunctuation = true
        self.request = request
        target.request = request
        window += 1
        let mine = window
        isListening = true
        task = recognizer.recognitionTask(with: request) { @Sendable [weak self] result, error in
            let text = result?.bestTranscription.formattedString
            let over = error != nil || (result?.isFinal ?? false)
            Task { @MainActor in
                guard let self, self.window == mine else { return }
                if let text, !text.isEmpty { self.onPartial(text) }
                if over { self.isListening = false }
            }
        }
        return true
    }

    func close() {
        endWindow()
        playback?.stop()
        if engine.isRunning { engine.stop() }
        if tapped { engine.inputNode.removeTap(onBus: 0) }
        tapped = false
        playback?.detach()
        playback = nil
    }

    private func endWindow() {
        window += 1
        target.request = nil
        request?.endAudio()
        task?.cancel()
        task = nil
        request = nil
        isListening = false
    }

    /// A recogniser for the language the person uses the device in, else for English.
    private static func makeRecognizer() -> SFSpeechRecognizer? {
        SFSpeechRecognizer(locale: Locale(identifier: Locale.preferredLanguages.first ?? "en-US"))
            ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    }

    /// The request the microphone feeds, set on the main thread and read on the audio thread.
    nonisolated private final class Target: @unchecked Sendable {
        private let lock = NSLock()
        private var current: SFSpeechAudioBufferRecognitionRequest?
        var request: SFSpeechAudioBufferRecognitionRequest? {
            get { lock.withLock { current } }
            set { lock.withLock { current = newValue } }
        }
    }
}

/// The voice played through the microphone's engine. Buffers come from the synthesizer on any
/// thread; they are turned into the format the engine plays and played in order.
nonisolated final class Playback: SpeechRoute, @unchecked Sendable {
    private let lock = NSLock()
    private let engine: AVAudioEngine
    private let player = AVAudioPlayerNode()
    private let format: AVAudioFormat
    private var converter: AVAudioConverter?
    private var outstanding = 0
    private var drainedHandler: @Sendable () -> Void = {}

    init(engine: AVAudioEngine) {
        self.engine = engine
        engine.attach(player)
        format = engine.mainMixerNode.outputFormat(forBus: 0)
        engine.connect(player, to: engine.mainMixerNode, format: format)
    }

    var onDrained: @Sendable () -> Void {
        get { lock.withLock { drainedHandler } }
        set { lock.withLock { drainedHandler = newValue } }
    }

    var isPlaying: Bool { lock.withLock { outstanding > 0 } }

    func play(_ buffer: AVAudioPCMBuffer) {
        guard let sound = lock.withLock({ converted(buffer) }) else { return }
        lock.withLock { outstanding += 1 }
        player.scheduleBuffer(sound) { [weak self] in self?.played() }
        if engine.isRunning, !player.isPlaying { player.play() }
    }

    func stop() {
        lock.withLock { outstanding = 0 }
        player.stop()
    }

    func detach() {
        player.stop()
        engine.detach(player)
    }

    private func played() {
        let (drained, handler) = lock.withLock { () -> (Bool, @Sendable () -> Void) in
            outstanding = max(0, outstanding - 1)
            return (outstanding == 0, drainedHandler)
        }
        if drained { handler() }
    }

    /// The buffer in the engine's format. Called with the lock held.
    private func converted(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        if buffer.format == format { return buffer }
        if converter?.inputFormat != buffer.format {
            converter = AVAudioConverter(from: buffer.format, to: format)
        }
        guard let converter else { return nil }
        let ratio = format.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1024
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
        let source = Source(buffer)
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in source.next(status) }
        return error == nil && out.frameLength > 0 ? out : nil
    }

    /// Hands the converter one buffer, then says there is no more for now.
    private final class Source: @unchecked Sendable {
        private let buffer: AVAudioPCMBuffer
        private var given = false
        init(_ buffer: AVAudioPCMBuffer) { self.buffer = buffer }
        func next(_ status: UnsafeMutablePointer<AVAudioConverterInputStatus>) -> AVAudioBuffer? {
            if given {
                status.pointee = .noDataNow
                return nil
            }
            given = true
            status.pointee = .haveData
            return buffer
        }
    }
}
