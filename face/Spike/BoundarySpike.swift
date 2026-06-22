import AVFoundation
import Foundation
import os

/// THROWAWAY on-device spike for the mandated `willSpeakRangeOfSpeechString`
/// boundary check (ROADMAP criterion 2, VOICE-03, RESEARCH Pitfall 1).
///
/// Its only job: speak a FIXED sentence that contains a number on the target
/// macOS 26 system voice and log every boundary callback range so the owner
/// can answer two questions before the Stage is built in 03-04:
///   1. Do `willSpeakRangeOfSpeechString` callbacks fire at all on this OS+voice?
///   2. Do the reported ranges land on the right substring, or drift on numbers?
///
/// The verdict gates the dual-paced Stage design (03-04). This file lives under
/// `face/Spike/` so it is trivially deletable once the verdict is recorded.
///
/// DISCIPLINE (RESEARCH Pitfall 1 / Apple Forums 683471): the `AVSpeechSynthesizer`
/// MUST be a retained PROPERTY — a local-var synthesizer is deallocated before it
/// speaks and its delegate is never called. That is the #1 cause of "callbacks
/// never fire," so the retention is itself part of what the spike validates.
@MainActor
final class BoundarySpike: NSObject, ObservableObject, AVSpeechSynthesizerDelegate {

    /// One observed boundary callback: the raw NSRange plus the substring it
    /// actually selected from the spoken text (or a marker if out of bounds).
    struct Boundary: Identifiable {
        let id = UUID()
        let location: Int
        let length: Int
        let substring: String
    }

    /// The fixed sentence. It deliberately includes numbers ("3" and "2020")
    /// because Apple's TTS engine is documented to drift ranges on numerals
    /// (RESEARCH Pitfall 1 — "ranges drift on numbers like 2020").
    static let sentence =
        "You have 3 events today and your checking is at 2020 dollars."

    /// RETAINED for the app's lifetime — do not make this a local var (see note above).
    private let synth = AVSpeechSynthesizer()

    private let log = Logger(subsystem: "com.kernel.face", category: "boundary-spike")

    @Published private(set) var isSpeaking = false
    /// The boundary ranges captured from the most recent run, for UI display.
    @Published private(set) var lastRanges: [Boundary] = []
    /// Set true once a `willSpeakRangeOfSpeechString` callback fires this run.
    @Published private(set) var callbacksFired = false

    override init() {
        super.init()
        synth.delegate = self
    }

    /// Speak the fixed sentence and log every boundary callback. Idempotent
    /// while already speaking (the button is disabled, but guard anyway).
    func run() {
        guard !isSpeaking else { return }
        lastRanges = []
        callbacksFired = false
        isSpeaking = true

        let utterance = AVSpeechUtterance(string: Self.sentence)
        // Target voice: prefer the system default for the current locale so the
        // spike runs against whatever voice the owner actually has installed.
        utterance.voice = AVSpeechSynthesisVoice(language: AVSpeechSynthesisVoice.currentLanguageCode())
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate

        log.info("BoundarySpike: speaking fixed sentence: \(Self.sentence, privacy: .public)")
        synth.speak(utterance)
    }

    // MARK: AVSpeechSynthesizerDelegate

    func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        willSpeakRangeOfSpeechString characterRange: NSRange,
        utterance: AVSpeechUtterance
    ) {
        callbacksFired = true

        // Guard substring extraction against an out-of-bounds NSRange. A bad
        // range MUST NOT crash — that resilience is exactly what the Stage's
        // time-based fallback depends on (T-03-10), so the spike proves it here.
        let full = utterance.speechString as NSString
        let substring: String
        if characterRange.location != NSNotFound,
           characterRange.location >= 0,
           characterRange.length >= 0,
           characterRange.location + characterRange.length <= full.length {
            substring = full.substring(with: characterRange)
        } else {
            substring = "<out-of-bounds range>"
        }

        let boundary = Boundary(
            location: characterRange.location,
            length: characterRange.length,
            substring: substring
        )
        lastRanges.append(boundary)

        log.info(
            "willSpeakRange loc=\(characterRange.location) len=\(characterRange.length) sub=\(substring, privacy: .public)"
        )
    }

    func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didFinish utterance: AVSpeechUtterance
    ) {
        isSpeaking = false
        log.info(
            "didFinish — total boundary callbacks this run: \(self.lastRanges.count) (callbacksFired=\(self.callbacksFired))"
        )
    }

    func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didCancel utterance: AVSpeechUtterance
    ) {
        isSpeaking = false
        log.info("didCancel")
    }
}
