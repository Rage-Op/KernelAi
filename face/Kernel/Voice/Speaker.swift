import AVFoundation
import os

/// The TTS surface (VOICE-03; RESEARCH Pattern 6; SPIKE-VERDICT.md).
///
/// The `AVSpeechSynthesizer` is held as a RETAINED PROPERTY — a local-var
/// synthesizer is deallocated before it speaks and its delegate never fires
/// (Apple Forums 683471 / RESEARCH Pitfall 1). The spike proved this discipline
/// load-bearing AND working on macOS 26.5 + Samantha.
///
/// Dual-paced wiring (the SPIKE-VERDICT-bound strategy):
///   - PRIMARY: `willSpeakRangeOfSpeechString` → `stage.fireCuesUpTo(charOffset:)`
///     (word-level callback clock — proven PRIMARY-viable).
///   - FALLBACK: `speak(text:cues:)` arms the StageController's sentence-time
///     schedule at speak start (ALWAYS present — VOICE-04). It fires any cue the
///     callbacks miss so choreography degrades gracefully and never stalls.
@MainActor
final class Speaker: NSObject, ObservableObject, AVSpeechSynthesizerDelegate {

    private let log = Logger(subsystem: "com.kernel.face", category: "speaker")

    /// RETAINED for the app's lifetime — never a local var (Pitfall 1).
    private let synth = AVSpeechSynthesizer()

    /// The Stage this speaker drives (the choreography consumer).
    private let stage: StageController

    @Published private(set) var isSpeaking = false

    /// Outstanding queued chunks in the streaming-TTS path (see `enqueueChunk`). While > 0 the
    /// speaker stays "speaking" across per-sentence utterances; the legacy single-utterance `speak`
    /// path leaves this at 0 and uses the original didFinish behavior.
    private var pendingChunks = 0

    init(stage: StageController) {
        self.stage = stage
        super.init()
        synth.delegate = self
    }

    /// Streaming TTS: speak one sentence chunk immediately, queued behind any already speaking. The
    /// synth plays queued utterances back-to-back, so calling this as each sentence completes makes
    /// KERNEL start talking almost as soon as it starts generating (snappy), not after the full reply.
    func enqueueChunk(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        let utterance = AVSpeechUtterance(string: t)
        utterance.voice = AVSpeechSynthesisVoice(language: AVSpeechSynthesisVoice.currentLanguageCode())
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        pendingChunks += 1
        isSpeaking = true
        synth.speak(utterance)
    }

    /// Speak a reply and choreograph its cues. Loads the cues into the Stage,
    /// arms the sentence-time fallback (estimated from the utterance), and speaks.
    func speak(_ text: String, cues: [Cue], onFinish: [FrameOnFinish] = []) {
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: AVSpeechSynthesisVoice.currentLanguageCode())
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate

        // Estimate total speak time for the fallback schedule. The spike showed
        // word-granular callbacks at the default rate; a chars×per-char estimate is
        // the right basis for the fallback (SPIKE-VERDICT.md question (c)).
        let estimatedDuration = Self.estimateDuration(for: text, rate: utterance.rate)
        stage.load(text: text, cues: cues, onFinish: onFinish, estimatedDuration: estimatedDuration)

        isSpeaking = true
        log.info("speak: \(text.count) chars, \(cues.count) cues, est \(estimatedDuration, format: .fixed(precision: 2))s")
        synth.speak(utterance)
    }

    /// Stop any in-flight speech and reset the Stage.
    func stop() {
        synth.stopSpeaking(at: .immediate)
        stage.reset()
        pendingChunks = 0
        isSpeaking = false
    }

    /// Estimate speech duration from char count + the utterance rate. Calibrated
    /// coarsely (the fallback only needs sentence-level resolution). At the default
    /// rate, ~12 chars/sec is a conservative basis.
    static func estimateDuration(for text: String, rate: Float) -> TimeInterval {
        let baseCharsPerSecond: Double = 12.0
        // Scale inversely with rate relative to the default.
        let rateScale = Double(max(rate, 0.01) / AVSpeechUtteranceDefaultSpeechRate)
        let charsPerSecond = baseCharsPerSecond * rateScale
        return max(0.3, Double(text.count) / charsPerSecond)
    }

    // MARK: AVSpeechSynthesizerDelegate

    /// PRIMARY pacing: every boundary crossing fires the cues up to its location.
    func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        willSpeakRangeOfSpeechString characterRange: NSRange,
        utterance: AVSpeechUtterance
    ) {
        // The StageController clamps an out-of-bounds/NSNotFound location and falls
        // through to the time path (T-03-16) — no substring math here, no crash.
        stage.fireCuesUpTo(charOffset: characterRange.location)
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        // Streaming path: stay "speaking" until the last queued chunk finishes (no cue choreography).
        if pendingChunks > 0 {
            pendingChunks -= 1
            if pendingChunks == 0 { isSpeaking = false }
            return
        }
        // Legacy single-utterance path: finish + dissolve the last widget back into the cloud.
        isSpeaking = false
        stage.fireOnFinish()
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        pendingChunks = 0
        isSpeaking = false
    }
}
