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
