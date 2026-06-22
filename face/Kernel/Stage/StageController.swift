import Foundation
import os

/// The DUAL-PACED choreography conductor (VOICE-03 + VOICE-04; SPIKE-VERDICT.md).
///
/// Two pacing paths, both idempotent — a cue fires EXACTLY once regardless of
/// which path triggers it:
///
///  1. **PRIMARY — word-level callback clock:** `Speaker.willSpeakRangeOfSpeechString`
///     calls `fireCuesUpTo(charOffset:)` with the boundary's `location`. Proven
///     PRIMARY-viable on macOS 26.5 + Samantha (SPIKE-VERDICT.md: callbacks fire,
///     ranges accurate, no numeral drift).
///  2. **FALLBACK — sentence-time schedule (ALWAYS armed at speak start):** the
///     reply is split into sentences, each sentence's duration estimated, and any
///     not-yet-fired cue at/after a passed sentence boundary is fired on a timer.
///     Mandatory regardless of the clean verdict (VOICE-04 requires BOTH paths) —
///     it covers other voices/locales where callbacks may drift or not fire.
///
/// Out-of-bounds resilience (T-03-16): an invalid/negative `charOffset` is
/// clamped and simply fires nothing past the end — it never crashes; the
/// time-based path still fires the remaining cues.
@MainActor
final class StageController: ObservableObject {

    private let log = Logger(subsystem: "com.kernel.face", category: "stage")

    /// Cues loaded for the current utterance, sorted by `atChar`.
    private(set) var pendingCues: [Cue] = []
    /// The set of cue ids that have already fired (the idempotence guard).
    private(set) var firedSet: Set<Int> = []
    /// onFinish actions to run when speech completes (dissolve the last widget).
    private var onFinishActions: [FrameOnFinish] = []
    private var onFinishFired = false

    /// The view layer subscribes here; each fired cue/onFinish emits a StageAction.
    /// Closure-based so the controller stays pure-logic + unit-testable (no SwiftUI).
    var onAction: ((StageAction) -> Void)?

    /// The full reply text (for the time fallback's sentence splitting).
    private var text: String = ""

    /// The fallback timer that fires any cues the callbacks missed.
    private var fallbackTimer: DispatchSourceTimer?

    // MARK: Loading a speak frame

    /// Arm the controller for a new utterance. Loads cues + onFinish, resets the
    /// fired set, and (per the dual-paced contract) schedules the sentence-time
    /// fallback. `estimatedDuration` is the total speak time the caller estimates
    /// (chars × per-char ms, or from the AVSpeechUtterance rate).
    func load(text: String, cues: [Cue], onFinish: [FrameOnFinish], estimatedDuration: TimeInterval) {
        cancelFallback()
        self.text = text
        self.pendingCues = cues.sorted { $0.atChar < $1.atChar }
        self.firedSet = []
        self.onFinishActions = onFinish
        self.onFinishFired = false
        armFallback(estimatedDuration: estimatedDuration)
    }

    /// Reset to an empty, disarmed state.
    func reset() {
        cancelFallback()
        text = ""
        pendingCues = []
        firedSet = []
        onFinishActions = []
        onFinishFired = false
    }

    // MARK: PRIMARY — word-level callback path

    /// Fire every not-yet-fired cue whose `atChar <= charOffset`, EXACTLY ONCE.
    /// Tolerates an out-of-bounds / negative offset (clamped; never crashes — T-03-16).
    func fireCuesUpTo(charOffset rawOffset: Int) {
        // Clamp a garbage range into a sane bound. NSNotFound / negative ⇒ fire nothing
        // here and fall through to the time path (the spike proved this guard is safe).
        guard rawOffset != NSNotFound, rawOffset >= 0 else { return }
        let offset = rawOffset
        for cue in pendingCues where cue.atChar <= offset && !firedSet.contains(cue.id) {
            fire(cue)
        }
    }

    /// Speech finished: run the onFinish actions once (dissolve the last widget).
    func fireOnFinish() {
        cancelFallback()
        guard !onFinishFired else { return }
        onFinishFired = true
        // Any cue not yet fired by either path gets fired now so nothing stalls
        // mid-screen (Motion Law: a widget must never freeze un-dissolved).
        for cue in pendingCues where !firedSet.contains(cue.id) { fire(cue) }
        for action in onFinishActions { emit(forAction: action.action, widget: action.widget, data: nil) }
    }

    // MARK: FALLBACK — sentence-time path

    /// Arm a coarse sentence-level timer. At each sentence boundary's scheduled
    /// time, fire any cues whose `atChar` falls within the sentences spoken so far
    /// but which the callbacks missed. Always present (VOICE-04), even when the
    /// callback path is healthy — it simply finds nothing left to fire.
    private func armFallback(estimatedDuration: TimeInterval) {
        guard !text.isEmpty, estimatedDuration > 0 else { return }
        let sentences = Self.sentenceRanges(in: text)
        guard !sentences.isEmpty else { return }

        let totalChars = max(text.count, 1)
        // Schedule each sentence's END proportionally across the estimated duration.
        var schedule: [(deadline: TimeInterval, throughChar: Int)] = []
        for r in sentences {
            let endChar = r.upperBound
            let fraction = Double(endChar) / Double(totalChars)
            schedule.append((deadline: estimatedDuration * fraction, throughChar: endChar))
        }

        let timer = DispatchSource.makeTimerSource(queue: .main)
        // Tick at a fraction of the shortest interval so we don't overshoot a boundary.
        timer.schedule(deadline: .now() + 0.05, repeating: 0.05)
        let start = DispatchTime.now()
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            let elapsed = Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1_000_000_000
            for entry in schedule where elapsed >= entry.deadline {
                // Fire any unfired cue whose atChar is within the sentences elapsed.
                self.fireMissedCues(throughChar: entry.throughChar)
            }
            if elapsed >= estimatedDuration { self.cancelFallback() }
        }
        fallbackTimer = timer
        timer.resume()
    }

    /// Time-path firing: fire unfired cues at/under `throughChar` (idempotent).
    private func fireMissedCues(throughChar: Int) {
        for cue in pendingCues where cue.atChar <= throughChar && !firedSet.contains(cue.id) {
            fire(cue)
        }
    }

    private func cancelFallback() {
        fallbackTimer?.cancel()
        fallbackTimer = nil
    }

    // MARK: Firing core (idempotent — the single mutation point)

    private func fire(_ cue: Cue) {
        guard !firedSet.contains(cue.id) else { return }
        firedSet.insert(cue.id)
        emit(forAction: cue.action, widget: cue.widget, data: cue.data)
    }

    private func emit(forAction action: String, widget: String?, data: JSONValue?) {
        let stageAction: StageAction
        switch action {
        case "stage.present":
            stageAction = .present(widget: widget ?? "", data: data)
        case "stage.dismiss":
            stageAction = .dismiss(widget: widget ?? "")
        default:
            stageAction = .other(action: action, widget: widget)
        }
        onAction?(stageAction)
    }

    // MARK: Sentence splitting (for the fallback schedule)

    /// Split text into sentence character ranges on `. ! ?` boundaries. Always
    /// returns at least one range (the whole string) so a no-punctuation reply
    /// still gets a single fallback deadline.
    static func sentenceRanges(in text: String) -> [Range<Int>] {
        guard !text.isEmpty else { return [] }
        var ranges: [Range<Int>] = []
        var startChar = 0
        let chars = Array(text)
        for (i, ch) in chars.enumerated() {
            if ch == "." || ch == "!" || ch == "?" {
                ranges.append(startChar..<(i + 1))
                startChar = i + 1
            }
        }
        if startChar < chars.count {
            ranges.append(startChar..<chars.count)
        }
        return ranges.isEmpty ? [0..<chars.count] : ranges
    }
}
