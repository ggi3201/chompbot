import AVFoundation
import SwiftUI
import VoiceGlowKit

/// Hands-free voice for a chat, like the web composer's: each pause sends what was said,
/// talking on while the agent works adds to the running task, and with "Speak replies when
/// I talk" on the reply is read aloud, then it listens again. Half duplex: while it speaks
/// it does not record, so it never hears itself.
/// 0 while talking, 1 when it sends.
@MainActor
final class VoicePause: ObservableObject {
    @Published private(set) var progress: Double = 0

    func set(_ next: Double) {
        if next != progress { progress = next }
    }
}

@MainActor
final class VoiceChat: ObservableObject {
    enum Phase { case off, listening, transcribing, speaking }

    @Published private(set) var phase: Phase = .off
    /// How far through the closing pause you are. Its own object: it changes 20 times a second,
    /// and everything observing VoiceChat (the whole thread) would redraw with it.
    let pause = VoicePause()
    @Published var problem: String?
    /// "Speak replies when I talk", from Settings or a long press on the mic.
    @Published private(set) var speakReplies = false
    /// The microphone, also what the glow follows while listening.
    let meter = VoiceMeter()
    /// Told to the agent with a spoken message, as web chat's SPOKEN_CONTEXT.
    static let spokenContext = "The user said this aloud in voice mode and may hear your reply read out: answer in one to three short spoken sentences, no lists, tables or markdown, and offer more only if they ask."
    /// What was heard. draft is true for words caught when you tapped voice off, to edit rather than send.
    var onUtterance: (String, Bool) -> Void = { _, _ in }

    // Same pause detection as the web (packages/web/src/hooks/useVoiceMode.ts).
    private static let speechRMS = 0.022
    private static let speechOverRoom = 3.0
    private static let roomLevelDrift = 1.002
    private static let speechStartMs = 160.0
    // 2 s, as the web chat: at 1.3 s it sent while people were still finding the end of a sentence.
    private static let speechEndMs = 2000.0
    private static let restartMs = 30_000.0
    private static let maxUtteranceMs = 90_000.0
    private static let sampleMs = 50.0

    private var api: ChompAPI { ChompAPI(config: AppConfig.shared) }
    private var on = false
    private var voiceName: String?

    private var recording: Recording?
    private var handler: UUID?
    private var timer: Timer?
    private var heard = false
    private var spokenMs = 0.0
    private var silentMs = 0.0
    private var elapsedMs = 0.0
    private var roomLevel = Double.infinity

    private var player: AVAudioPlayer?
    private let playbackEnd = PlaybackEnd()
    private var speaking: Task<Void, Never>?

    /// Call from the mic tap.
    func start() async {
        guard !on else { return }
        problem = nil
        do {
            try await meter.start()
        } catch {
            problem = "Microphone access is off. Turn it on in the Settings app."
            return
        }
        on = true
        Task { await loadSettings() }
        listen()
    }

    func loadSettings() async {
        guard let settings = try? await api.settings() else { return }
        speakReplies = settings["voice_auto_speak"] == "true"
        voiceName = settings["voice_tts_voice"]
    }

    /// The long press on the mic. Saved on the server, so web chat follows.
    func toggleSpokenReplies() {
        speakReplies.toggle()
        let value = speakReplies ? "true" : "false"
        Task { try? await api.setSetting("voice_auto_speak", to: value) }
    }

    /// Voice off. Words it was still hearing come back as a draft.
    func stop() {
        guard on else { return }
        on = false
        cutSpeech()
        finishUtterance(save: heard, draft: true)
        meter.stop()
        phase = .off
    }

    /// The mic button: off starts, speaking cuts in, otherwise stops.
    func tap() {
        switch phase {
        case .off: Task { await start() }
        case .speaking:
            cutSpeech()
            listen()
        default: stop()
        }
    }

    /// Reads a reply aloud if the setting is on. Words being said right now are sent first.
    func speak(_ reply: String) {
        guard on, speakReplies else { return }
        let pieces = Self.pieces(of: Self.spoken(reply))
        guard !pieces.isEmpty else { return }
        finishUtterance(save: heard, draft: false, thenListen: false)
        phase = .speaking
        let voice = voiceName
        speaking = Task { [weak self] in
            guard let self else { return }
            // The next piece is fetched while this one plays.
            var next: Task<Data?, Never>? = fetchSpeech(pieces[0], voice: voice)
            for index in pieces.indices {
                guard let data = await next?.value, !Task.isCancelled else { break }
                next = index + 1 < pieces.count ? fetchSpeech(pieces[index + 1], voice: voice) : nil
                await play(data)
            }
            guard !Task.isCancelled else { return }
            speaking = nil
            listen()
        }
    }

    /// The reply's loudness 0–1, for the glow while it speaks.
    nonisolated func playbackLevel() -> Double {
        MainActor.assumeIsolated {
            guard let player, player.isPlaying else { return 0 }
            player.updateMeters()
            return min(1, 2 * pow(10, Double(player.averagePower(forChannel: 0)) / 20))
        }
    }

    // MARK: - Listening

    private func listen() {
        guard on, speaking == nil, recording == nil else { return }
        let recording = Recording(url: FileManager.default.temporaryDirectory.appendingPathComponent("chomp-voice-\(UUID().uuidString).m4a"))
        self.recording = recording
        handler = meter.addBufferHandler { buffer in recording.write(buffer) }
        heard = false
        spokenMs = 0
        silentMs = 0
        elapsedMs = 0
        roomLevel = .infinity
        pause.set(0)
        phase = .listening
        timer = Timer.scheduledTimer(withTimeInterval: Self.sampleMs / 1000, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.sample() }
        }
    }

    private func sample() {
        let rms = meter.currentRMS()
        // A noisy room must not read as someone who never stops talking.
        roomLevel = min(rms, roomLevel * Self.roomLevelDrift)
        elapsedMs += Self.sampleMs
        if rms > max(Self.speechRMS, roomLevel * Self.speechOverRoom) {
            spokenMs += Self.sampleMs
            silentMs = 0
            if spokenMs >= Self.speechStartMs { heard = true }
        } else {
            silentMs += Self.sampleMs
            if !heard { spokenMs = 0 }
        }
        if heard { pause.set(min(1, silentMs / Self.speechEndMs)) }
        if heard && (silentMs >= Self.speechEndMs || elapsedMs >= Self.maxUtteranceMs) {
            finishUtterance(save: true, draft: false)
        } else if !heard && elapsedMs >= Self.restartMs {
            // Keep listening, but not to a long recording of silence.
            finishUtterance(save: false, draft: false)
        }
    }

    /// Ends the current recording. Saved words are transcribed and handed on; then it listens again if still on.
    private func finishUtterance(save: Bool, draft: Bool, thenListen: Bool = true) {
        timer?.invalidate()
        timer = nil
        if let handler { meter.removeBufferHandler(handler) }
        handler = nil
        pause.set(0)
        guard let recording else { return }
        self.recording = nil
        recording.close()
        guard save else {
            try? FileManager.default.removeItem(at: recording.url)
            if thenListen { listen() }
            return
        }
        if on, thenListen { phase = .transcribing }
        Task {
            defer { try? FileManager.default.removeItem(at: recording.url) }
            do {
                let audio = try Data(contentsOf: recording.url)
                let text = try await api.transcribe(audio, mimeType: "audio/mp4").trimmingCharacters(in: .whitespacesAndNewlines)
                if !text.isEmpty { onUtterance(text, draft) }
            } catch {
                problem = "Could not understand that. Try again, or type it."
            }
            if on, thenListen, phase == .transcribing { listen() }
        }
    }

    // MARK: - Speaking

    private nonisolated func fetchSpeech(_ text: String, voice: String?) -> Task<Data?, Never> {
        Task { try? await ChompAPI(config: AppConfig.shared).speech(text, voice: voice) }
    }

    private func play(_ data: Data) async {
        guard let player = try? AVAudioPlayer(data: data) else { return }
        player.isMeteringEnabled = true
        // A touch faster than the voice's own pace, as web chat; the pitch stays.
        player.enableRate = true
        player.rate = 1.15
        player.delegate = playbackEnd
        self.player = player
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            playbackEnd.done = { done.resume() }
            if !player.play() { playbackEnd.finish() }
        }
        self.player = nil
    }

    private func cutSpeech() {
        speaking?.cancel()
        speaking = nil
        player?.stop()
        playbackEnd.finish()
    }

    /// Reply text as it should sound: no code, links, tables or markdown marks.
    nonisolated static func spoken(_ text: String) -> String {
        var s = text
        let rules: [(String, String)] = [
            (":::canvas\\n[\\s\\S]*?\\n:::", ""),
            ("```[\\s\\S]*?```", " code block "),
            ("`([^`]+)`", "$1"),
            ("!\\[[^\\]]*\\]\\([^)]+\\)", ""),
            ("\\[([^\\]]+)\\]\\([^)]+\\)", "$1"),
            ("<?https?://[^\\s>]+>?", ""),
            ("(?m)^\\|.*\\|$", ""),
            ("(?m)^#{1,6}\\s+|^>\\s?|^\\s*[-*+]\\s+|^\\s*\\d+\\.\\s+", ""),
            ("[*_~]{1,3}([^*_~\\n]+)[*_~]{1,3}", "$1"),
        ]
        for (pattern, template) in rules {
            s = s.replacingOccurrences(of: pattern, with: template, options: .regularExpression)
        }
        return s
    }

    /// Sentences, joined until each is long enough to be worth a request.
    nonisolated static func pieces(of text: String, minLength: Int = 28) -> [String] {
        var sentences: [String] = []
        var sentence = ""
        func endSentence() {
            let trimmed = sentence.trimmingCharacters(in: .whitespaces)
            if !trimmed.isEmpty { sentences.append(trimmed) }
            sentence = ""
        }
        for character in text {
            if character.isNewline {
                endSentence()
            } else {
                sentence.append(character)
                if ".!?…".contains(character) { endSentence() }
            }
        }
        endSentence()
        var pieces: [String] = []
        var piece = ""
        for sentence in sentences {
            piece += piece.isEmpty ? sentence : " \(sentence)"
            if piece.count >= minLength {
                pieces.append(piece)
                piece = ""
            }
        }
        if !piece.isEmpty { pieces.append(piece) }
        return pieces
    }
}

/// One utterance written to an AAC file from the meter's buffers, which arrive off the main thread.
private final class Recording: @unchecked Sendable {
    let url: URL
    private let lock = NSLock()
    private var file: AVAudioFile?
    private var closed = false

    init(url: URL) {
        self.url = url
    }

    func write(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        defer { lock.unlock() }
        guard !closed else { return }
        if file == nil {
            let settings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: buffer.format.sampleRate,
                AVNumberOfChannelsKey: buffer.format.channelCount,
            ]
            file = try? AVAudioFile(forWriting: url, settings: settings, commonFormat: buffer.format.commonFormat, interleaved: buffer.format.isInterleaved)
        }
        try? file?.write(from: buffer)
    }

    /// Dropping the file finishes it, so it can be read.
    func close() {
        lock.lock()
        closed = true
        file = nil
        lock.unlock()
    }
}

/// Resumes the speaking loop when a piece ends, fails, or is cut off. Resumes at most once per piece.
private final class PlaybackEnd: NSObject, AVAudioPlayerDelegate {
    var done: (() -> Void)?

    func finish() {
        let done = self.done
        self.done = nil
        done?()
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        finish()
    }

    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        finish()
    }
}
