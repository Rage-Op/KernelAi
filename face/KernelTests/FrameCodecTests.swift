import XCTest
@testable import Kernel

/// Proves the Swift Frame codec mirrors the frozen daemon FrameSchema:
/// a `speak` (with cues[] + onFinish), a `ui.state`, and a `reply` each decode
/// to the right Swift case and round-trip re-encode; a malformed line is tolerated.
final class FrameCodecTests: XCTestCase {

    // MARK: speak (cues[] + onFinish)

    func testSpeakFrameDecodesAndRoundTrips() throws {
        let json = """
        {"type":"speak","id":"u1","text":"You have 3 events today.","cues":[\
        {"atChar":9,"action":"stage.present","widget":"events","data":{"count":3}},\
        {"atChar":24,"action":"stage.dismiss","widget":"events"}],\
        "onFinish":[{"action":"stage.dismiss","widget":"events"}]}
        """
        let frame = FrameCodec.decode(line: json)
        guard case let .speak(id, text, cues, onFinish) = frame else {
            return XCTFail("expected .speak, got \(String(describing: frame))")
        }
        XCTAssertEqual(id, "u1")
        XCTAssertEqual(text, "You have 3 events today.")
        XCTAssertEqual(cues.count, 2)
        XCTAssertEqual(cues[0].atChar, 9)
        XCTAssertEqual(cues[0].action, "stage.present")
        XCTAssertEqual(cues[0].widget, "events")
        XCTAssertEqual(cues[0].data?["count"]?.doubleValue, 3)
        XCTAssertEqual(onFinish?.count, 1)
        XCTAssertEqual(onFinish?.first?.widget, "events")

        // Re-encode → decode again must be structurally identical.
        let line = try FrameCodec.encodeLine(frame!)
        let reframe = FrameCodec.decode(line: line)
        XCTAssertEqual(frame, reframe, "speak frame must round-trip")
    }

    // MARK: ui.state

    func testUiStateFrameDecodesAndRoundTrips() throws {
        for raw in ["fullscreen", "cornerPill", "idle"] {
            let json = "{\"type\":\"ui.state\",\"state\":\"\(raw)\"}"
            let frame = FrameCodec.decode(line: json)
            guard case let .uiState(state) = frame else {
                return XCTFail("expected .uiState for \(raw), got \(String(describing: frame))")
            }
            XCTAssertEqual(state.rawValue, raw)
            let line = try FrameCodec.encodeLine(frame!)
            XCTAssertEqual(frame, FrameCodec.decode(line: line))
        }
    }

    // MARK: reply

    func testReplyFrameDecodesAndRoundTrips() throws {
        let json = "{\"type\":\"reply\",\"id\":\"u7\",\"text\":\"Got it.\"}"
        let frame = FrameCodec.decode(line: json)
        guard case let .reply(id, text) = frame else {
            return XCTFail("expected .reply, got \(String(describing: frame))")
        }
        XCTAssertEqual(id, "u7")
        XCTAssertEqual(text, "Got it.")
        let line = try FrameCodec.encodeLine(frame!)
        XCTAssertEqual(frame, FrameCodec.decode(line: line))
    }

    // MARK: ready / widget.data (the other inbound arms the app reacts to)

    func testReadyAndWidgetDataDecode() {
        let ready = FrameCodec.decode(line: "{\"type\":\"ready\",\"daemon\":\"kernel\",\"version\":\"0.1.0\"}")
        guard case let .ready(daemon, version) = ready else { return XCTFail("expected .ready") }
        XCTAssertEqual(daemon, "kernel")
        XCTAssertEqual(version, "0.1.0")

        let wd = FrameCodec.decode(line: "{\"type\":\"widget.data\",\"widget\":\"events\",\"data\":{\"count\":2}}")
        guard case let .widgetData(widget, data) = wd else { return XCTFail("expected .widgetData") }
        XCTAssertEqual(widget, "events")
        XCTAssertEqual(data["count"]?.doubleValue, 2)
    }

    // MARK: transcript (P4 additive — CC-02)

    func testTranscriptFrameDecodesAndRoundTrips() throws {
        // kernel line, no partial flag (the first-person prompt).
        let kernelJSON = "{\"type\":\"transcript\",\"id\":\"t1\",\"role\":\"kernel\",\"text\":\"I need you to refactor the parser.\"}"
        let kFrame = FrameCodec.decode(line: kernelJSON)
        guard case let .transcript(kid, krole, ktext, kpartial) = kFrame else {
            return XCTFail("expected .transcript(kernel), got \(String(describing: kFrame))")
        }
        XCTAssertEqual(kid, "t1")
        XCTAssertEqual(krole, .kernel)
        XCTAssertEqual(ktext, "I need you to refactor the parser.")
        XCTAssertNil(kpartial, "an absent partial decodes to nil")
        XCTAssertEqual(kFrame, FrameCodec.decode(line: try FrameCodec.encodeLine(kFrame!)), "kernel transcript round-trips")

        // claude line, streaming (partial:true).
        let partialJSON = "{\"type\":\"transcript\",\"id\":\"t2\",\"role\":\"claude\",\"text\":\"Reading the file…\",\"partial\":true}"
        let pFrame = FrameCodec.decode(line: partialJSON)
        guard case let .transcript(_, prole, _, ppartial) = pFrame else {
            return XCTFail("expected .transcript(claude), got \(String(describing: pFrame))")
        }
        XCTAssertEqual(prole, .claude)
        XCTAssertEqual(ppartial, true)
        XCTAssertEqual(pFrame, FrameCodec.decode(line: try FrameCodec.encodeLine(pFrame!)), "partial transcript round-trips")

        // claude line, finalized (partial:false).
        let finalJSON = "{\"type\":\"transcript\",\"id\":\"t3\",\"role\":\"claude\",\"text\":\"Done.\",\"partial\":false}"
        let fFrame = FrameCodec.decode(line: finalJSON)
        guard case let .transcript(_, _, _, fpartial) = fFrame else {
            return XCTFail("expected .transcript final, got \(String(describing: fFrame))")
        }
        XCTAssertEqual(fpartial, false)
        XCTAssertEqual(fFrame, FrameCodec.decode(line: try FrameCodec.encodeLine(fFrame!)), "final transcript round-trips")
    }

    func testMalformedTranscriptIsTolerated() {
        // out-of-enum role → nil (no crash).
        XCTAssertNil(FrameCodec.decode(line: "{\"type\":\"transcript\",\"id\":\"x\",\"role\":\"martian\",\"text\":\"x\"}"))
        // missing role → nil.
        XCTAssertNil(FrameCodec.decode(line: "{\"type\":\"transcript\",\"id\":\"x\",\"text\":\"x\"}"))
        // missing text → nil.
        XCTAssertNil(FrameCodec.decode(line: "{\"type\":\"transcript\",\"id\":\"x\",\"role\":\"kernel\"}"))
    }

    // MARK: breaker.preview / breaker.cancel (P5 additive — SAFE-03)

    func testBreakerPreviewFrameDecodesAndRoundTrips() throws {
        // a financial Red action — estimatedSpend shown to the owner, tier always red.
        let json = "{\"type\":\"breaker.preview\",\"id\":\"bp-1\",\"summary\":\"Red action: shop (purchase) — estimated spend 40 — 10s to cancel.\",\"estimatedSpend\":40,\"tier\":\"red\"}"
        let frame = FrameCodec.decode(line: json)
        guard case let .breakerPreview(id, summary, estimatedSpend, tier) = frame else {
            return XCTFail("expected .breakerPreview, got \(String(describing: frame))")
        }
        XCTAssertEqual(id, "bp-1")
        XCTAssertEqual(tier, .red)
        XCTAssertEqual(estimatedSpend, 40)
        XCTAssertTrue(summary.contains("Red action"))
        // Re-encode → decode again must be structurally identical.
        let line = try FrameCodec.encodeLine(frame!)
        XCTAssertEqual(frame, FrameCodec.decode(line: line), "breaker.preview must round-trip")

        // a non-financial Red action — estimatedSpend 0.
        let rmJSON = "{\"type\":\"breaker.preview\",\"id\":\"bp-2\",\"summary\":\"Red action: fs (rm -rf) — 10s to cancel.\",\"estimatedSpend\":0,\"tier\":\"red\"}"
        let rm = FrameCodec.decode(line: rmJSON)
        guard case let .breakerPreview(_, _, rmSpend, _) = rm else {
            return XCTFail("expected .breakerPreview (rm), got \(String(describing: rm))")
        }
        XCTAssertEqual(rmSpend, 0, "a non-financial Red op has estimatedSpend 0")
        XCTAssertEqual(rm, FrameCodec.decode(line: try FrameCodec.encodeLine(rm!)))
    }

    func testBreakerCancelFrameDecodesAndRoundTrips() throws {
        let json = "{\"type\":\"breaker.cancel\",\"id\":\"bp-1\"}"
        let frame = FrameCodec.decode(line: json)
        guard case let .breakerCancel(id) = frame else {
            return XCTFail("expected .breakerCancel, got \(String(describing: frame))")
        }
        XCTAssertEqual(id, "bp-1", "the cancel correlates to the preview id")
        let line = try FrameCodec.encodeLine(frame!)
        XCTAssertEqual(frame, FrameCodec.decode(line: line), "breaker.cancel must round-trip")
    }

    func testMalformedBreakerPreviewIsTolerated() {
        // out-of-enum tier → nil (no crash).
        XCTAssertNil(FrameCodec.decode(line: "{\"type\":\"breaker.preview\",\"id\":\"x\",\"summary\":\"s\",\"estimatedSpend\":0,\"tier\":\"yellow\"}"))
        // missing summary → nil.
        XCTAssertNil(FrameCodec.decode(line: "{\"type\":\"breaker.preview\",\"id\":\"x\",\"estimatedSpend\":0,\"tier\":\"red\"}"))
        // missing estimatedSpend → nil.
        XCTAssertNil(FrameCodec.decode(line: "{\"type\":\"breaker.preview\",\"id\":\"x\",\"summary\":\"s\",\"tier\":\"red\"}"))
    }

    // MARK: malformed tolerated (T-03-13)

    func testMalformedLineDoesNotCrashDecoder() {
        XCTAssertNil(FrameCodec.decode(line: "this is not json"))
        XCTAssertNil(FrameCodec.decode(line: "{\"type\":\"speak\""))          // truncated
        XCTAssertNil(FrameCodec.decode(line: "{\"type\":\"unknown.arm\"}"))    // unknown type
        XCTAssertNil(FrameCodec.decode(line: "{\"text\":\"no type field\"}"))  // missing discriminator
        XCTAssertNil(FrameCodec.decode(line: ""))                              // empty
        // A speak frame missing required `cues` must fail (not silently default).
        XCTAssertNil(FrameCodec.decode(line: "{\"type\":\"speak\",\"id\":\"x\",\"text\":\"hi\"}"))
    }
}
