import XCTest
@testable import Kernel

/// Proves the cornerPill transcript invariants (04-UI-SPEC §6; CC-02):
///   - streamed transcript frames render in order (kernel prompt first, then claude lines);
///   - a partial claude chunk UPDATES the in-progress line rather than duplicating it;
///   - a non-partial line finalizes the in-progress line;
///   - the pause control toggles `transcriptPaused`;
///   - the streaming pulse (`transcriptStreaming`) is live while a partial claude chunk arrives,
///     and clears on finalization / pause.
///
/// The buffer + flags live on the @MainActor AppCoordinator; the TranscriptPill renders them.
@MainActor
final class TranscriptPillTests: XCTestCase {

    // MARK: streamed events render in order

    func testStreamedEventsAppendInOrder() {
        let c = AppCoordinator()
        c.appendTranscript(id: "k1", role: .kernel, text: "I need you to refactor the parser.", partial: false)
        c.appendTranscript(id: "a1", role: .claude, text: "Reading the file.", partial: false)
        c.appendTranscript(id: "a2", role: .claude, text: "Refactored.", partial: false)

        XCTAssertEqual(c.transcriptLines.count, 3, "three finalized lines buffer in order")
        XCTAssertEqual(c.transcriptLines[0].role, .kernel)
        XCTAssertEqual(c.transcriptLines[0].text, "I need you to refactor the parser.")
        XCTAssertEqual(c.transcriptLines[1].role, .claude)
        XCTAssertEqual(c.transcriptLines[2].text, "Refactored.")
    }

    // MARK: a partial chunk updates in place (no duplicate)

    func testPartialChunkUpdatesInPlaceNotDuplicate() {
        let c = AppCoordinator()
        c.appendTranscript(id: "k1", role: .kernel, text: "Do the thing.", partial: false)
        // a streaming claude chunk, then a longer chunk: same in-progress line, updated text.
        c.appendTranscript(id: "a1", role: .claude, text: "Reading", partial: true)
        c.appendTranscript(id: "a2", role: .claude, text: "Reading the file", partial: true)
        c.appendTranscript(id: "a3", role: .claude, text: "Reading the file…", partial: true)

        XCTAssertEqual(c.transcriptLines.count, 2, "the streaming claude chunk updates one line, not three")
        XCTAssertEqual(c.transcriptLines.last?.text, "Reading the file…", "the latest partial text wins")
        XCTAssertEqual(c.transcriptLines.last?.partial, true, "still streaming")

        // a non-partial line finalizes that same in-progress line.
        c.appendTranscript(id: "a4", role: .claude, text: "Done reading.", partial: false)
        XCTAssertEqual(c.transcriptLines.count, 2, "finalization updates the in-progress line, no new row")
        XCTAssertEqual(c.transcriptLines.last?.text, "Done reading.")
        XCTAssertEqual(c.transcriptLines.last?.partial, false, "finalized")

        // a NEW claude line after a finalized one appends a fresh row.
        c.appendTranscript(id: "a5", role: .claude, text: "Now compiling.", partial: false)
        XCTAssertEqual(c.transcriptLines.count, 3, "a finalized line does not get overwritten by the next event")
    }

    // MARK: streaming pulse reflects partial events

    func testStreamingPulseWhilePartialArrives() {
        let c = AppCoordinator()
        XCTAssertFalse(c.transcriptStreaming, "no stream before any event")

        c.appendTranscript(id: "a1", role: .claude, text: "working…", partial: true)
        XCTAssertTrue(c.transcriptStreaming, "a partial claude chunk lights the streaming pulse")

        c.appendTranscript(id: "a2", role: .claude, text: "done.", partial: false)
        XCTAssertFalse(c.transcriptStreaming, "finalization clears the streaming pulse")
    }

    // MARK: pause control toggles paused

    func testPauseControlTogglesPaused() {
        let c = AppCoordinator()
        XCTAssertFalse(c.transcriptPaused, "not paused initially")

        c.appendTranscript(id: "a1", role: .claude, text: "streaming…", partial: true)
        XCTAssertTrue(c.transcriptStreaming)

        c.toggleTranscriptPause()
        XCTAssertTrue(c.transcriptPaused, "pause toggles paused on")
        XCTAssertFalse(c.transcriptStreaming, "pausing freezes the streaming pulse")

        c.toggleTranscriptPause()
        XCTAssertFalse(c.transcriptPaused, "toggling again resumes")
        XCTAssertTrue(c.transcriptStreaming, "resuming with a partial line in flight re-lights the pulse")
    }

    // MARK: the pill renders the buffered lines (defensive — empty does not crash)

    func testPillConstructsFromBufferAndEmptyBuffer() {
        let lines = [
            TranscriptLine(id: "k1", role: .kernel, text: "Hi", partial: false),
            TranscriptLine(id: "a1", role: .claude, text: "On it.", partial: true),
        ]
        let pill = TranscriptPill(lines: lines, isStreaming: true, isPaused: false, onTogglePause: {})
        XCTAssertEqual(pill.lines.count, 2, "the pill renders the buffered lines in order")
        XCTAssertTrue(pill.isStreaming)

        // an empty buffer is valid (renders the quiet "Waiting…" line, never a crash).
        let empty = TranscriptPill(lines: [], isStreaming: false, isPaused: false, onTogglePause: {})
        XCTAssertEqual(empty.lines.count, 0)
    }
}
