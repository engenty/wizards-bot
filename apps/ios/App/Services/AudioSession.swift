import AVFoundation

/// The app's audio session: it plays, and it records only while it listens.
enum AudioSession {
    /// For listening, and for talking with the voice while still listening.
    @discardableResult
    static func listen() -> Bool {
        activate(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothA2DP, .bluetoothHighQualityRecording])
    }

    /// For the voice alone.
    @discardableResult
    static func play() -> Bool {
        activate(.playback, mode: .spokenAudio, options: [.duckOthers])
    }

    /// Gives the audio back to whatever played before.
    static func rest() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private static func activate(
        _ category: AVAudioSession.Category, mode: AVAudioSession.Mode, options: AVAudioSession.CategoryOptions
    ) -> Bool {
        let session = AVAudioSession.sharedInstance()
        do {
            if session.category != category || session.categoryOptions != options || session.mode != mode {
                try session.setCategory(category, mode: mode, options: options)
            }
            try session.setActive(true)
            return true
        } catch {
            return false
        }
    }
}
