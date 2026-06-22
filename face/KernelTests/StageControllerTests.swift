import XCTest
@testable import Kernel

/// Proves the dual-paced StageController contract (VOICE-04):
///  - each cue fires EXACTLY once across repeated `fireCuesUpTo` calls (idempotence);
///  - the sentence-time FALLBACK fires cues the callbacks missed;
///  - an out-of-bounds / invalid range is tolerated (no crash, falls through).
@MainActor
final class StageControllerTests: XCTestCase {

    /// Record the StageActions a controller emits, in order.
    private func makeRecorder(_ stage: StageController) -> () -> [StageAction] {
        var actions: [StageAction] = []
        stage.onAction = { actions.append($0) }
        return { actions }
    }

    private func sampleCues() -> [Cue] {
        [
            Cue(id: 0, atChar: 9,  action: "stage.present", widget: "events"),
            Cue(id: 1, atChar: 24, action: "stage.dismiss", widget: "events"),
        ]
    }

    // MARK: fire-once idempotence (PRIMARY path)

    func testEachCueFiresExactlyOnceAcrossRepeatedCalls() {
        let stage = StageController()
        let read = makeRecorder(stage)
        // estimatedDuration 0 ⇒ no fallback armed; this isolates the callback path.
        stage.load(text: "You have 3 events today and more.", cues: sampleCues(), onFinish: [], estimatedDuration: 0)

        stage.fireCuesUpTo(charOffset: 9)   // fires cue 0
        stage.fireCuesUpTo(charOffset: 9)   // no-op (already fired)
        stage.fireCuesUpTo(charOffset: 10)  // no-op
        stage.fireCuesUpTo(charOffset: 24)  // fires cue 1
        stage.fireCuesUpTo(charOffset: 99)  // no-op (both fired)

        XCTAssertEqual(read().count, 2, "exactly two actions, each cue once")
        XCTAssertEqual(read()[0], .present(widget: "events", data: nil))
        XCTAssertEqual(read()[1], .dismiss(widget: "events"))
        XCTAssertEqual(stage.firedSet, [0, 1])
    }

    func testCuesBelowOffsetAllFireInOneCall() {
        let stage = StageController()
        let read = makeRecorder(stage)
        stage.load(text: "abcdefghijklmnopqrstuvwxyz0123456789", cues: sampleCues(), onFinish: [], estimatedDuration: 0)
        stage.fireCuesUpTo(charOffset: 30) // both cues' atChar (9, 24) <= 30
        XCTAssertEqual(read().count, 2)
        XCTAssertEqual(stage.firedSet, [0, 1])
    }

    // MARK: sentence-time FALLBACK fires missed cues

    func testFallbackFiresCuesTheCallbacksMissed() {
        let stage = StageController()
        // Arm a short fallback and NEVER call fireCuesUpTo — only the timer can fire.
        var actions: [StageAction] = []
        let exp = expectation(description: "fallback fired both cues")
        stage.onAction = {
            actions.append($0)
            if stage.firedSet.count == 2 { exp.fulfill() }
        }
        stage.load(
            text: "You have 3 events today and your checking is fine.",
            cues: sampleCues(),
            onFinish: [],
            estimatedDuration: 0.3)
        wait(for: [exp], timeout: 2.0)
        XCTAssertEqual(stage.firedSet, [0, 1], "the time fallback fired the cues with no callbacks")
        XCTAssertEqual(actions.count, 2)
    }

    func testFallbackIsIdempotentWithCallbackPath() {
        let stage = StageController()
        var actions: [StageAction] = []
        let exp = expectation(description: "all fired")
        stage.onAction = {
            actions.append($0)
            if stage.firedSet.count == 2 { exp.fulfill() }
        }
        stage.load(
            text: "You have 3 events today and your checking is fine.",
            cues: sampleCues(), onFinish: [], estimatedDuration: 0.3)
        // Callback path fires cue 0 first; the timer must NOT re-fire it.
        stage.fireCuesUpTo(charOffset: 9)
        wait(for: [exp], timeout: 2.0)
        // Give the timer a moment to (not) double-fire.
        let settle = expectation(description: "settle")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { settle.fulfill() }
        wait(for: [settle], timeout: 2.0)
        XCTAssertEqual(actions.count, 2, "no cue fired twice across both paths")
    }

    // MARK: out-of-bounds tolerated (T-03-16)

    func testOutOfBoundsRangeDoesNotCrashAndFallsThrough() {
        let stage = StageController()
        let read = makeRecorder(stage)
        stage.load(text: "short", cues: sampleCues(), onFinish: [], estimatedDuration: 0)

        // NSNotFound + negative + far-beyond-end ranges must not crash.
        stage.fireCuesUpTo(charOffset: NSNotFound)
        stage.fireCuesUpTo(charOffset: -5)
        XCTAssertEqual(read().count, 0, "garbage ranges fire nothing")
        XCTAssertTrue(stage.firedSet.isEmpty)

        // A huge valid offset still fires correctly (no crash on the upper side).
        stage.fireCuesUpTo(charOffset: 1_000_000)
        XCTAssertEqual(stage.firedSet, [0, 1])
    }

    // MARK: onFinish dissolves the last widget + flushes unfired cues

    func testOnFinishFlushesUnfiredCuesAndRunsOnFinishOnce() {
        let stage = StageController()
        let read = makeRecorder(stage)
        stage.load(
            text: "hi", cues: sampleCues(),
            onFinish: [FrameOnFinish(action: "stage.dismiss", widget: "events")],
            estimatedDuration: 0)
        stage.fireOnFinish()
        stage.fireOnFinish() // must be idempotent
        // 2 flushed cues + 1 onFinish dismiss = 3 actions, no doubles.
        XCTAssertEqual(read().count, 3)
        XCTAssertEqual(read().last, .dismiss(widget: "events"))
    }

    // MARK: sentence splitting helper

    func testSentenceRangesSplitOnPunctuation() {
        let r = StageController.sentenceRanges(in: "One. Two! Three?")
        XCTAssertEqual(r.count, 3)
        let none = StageController.sentenceRanges(in: "no punctuation here")
        XCTAssertEqual(none.count, 1)
        XCTAssertTrue(StageController.sentenceRanges(in: "").isEmpty)
    }
}
