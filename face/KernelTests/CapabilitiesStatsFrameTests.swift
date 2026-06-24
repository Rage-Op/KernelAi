import XCTest
@testable import Kernel

/// Proves the additive `capabilities` / `stats` / `override` frame mirrors decode the daemon's
/// `protocol.ts` shapes exactly (and round-trip), so the boot screen + telemetry strip get real
/// data. These arms were previously DROPPED by the Face (`try?`); mirroring them is the only IPC
/// change in the redesign — the frozen FrameSchema is otherwise untouched.
final class CapabilitiesStatsFrameTests: XCTestCase {

    func testCapabilitiesDecodesAllFields() {
        let line = """
        {"type":"capabilities","brain":"local","daemon":"kernel","version":"0.1.0",\
        "injectCap":16384,"tools":["mail","finance","peekaboo"],"integrations":["gmail","plaid"]}
        """
        let frame = FrameCodec.decode(line: line)
        XCTAssertEqual(frame, .capabilities(
            brain: .local, daemon: "kernel", version: "0.1.0",
            injectCap: 16384, tools: ["mail", "finance", "peekaboo"], integrations: ["gmail", "plaid"]))
    }

    func testStatsDecodesFullTelemetry() {
        let line = """
        {"type":"stats","id":"u1","brain":"local","model":"qwen2.5:7b","promptTokens":1205,\
        "outputTokens":24,"tokensPerSec":30.6,"evalMs":784.0,"loadMs":12.0,"totalMs":900.0,\
        "contextWindow":8192,"estCostUsd":0.0066}
        """
        let frame = FrameCodec.decode(line: line)
        XCTAssertEqual(frame, .stats(
            id: "u1", brain: .local, model: "qwen2.5:7b",
            promptTokens: 1205, outputTokens: 24, tokensPerSec: 30.6,
            evalMs: 784.0, loadMs: 12.0, totalMs: 900.0,
            contextWindow: 8192, estCostUsd: 0.0066))
    }

    func testStatsDecodesMinimalWhenBrainDoesNotMeasure() {
        // A brain that doesn't report usage sends only id/brain — every metric optional, no crash.
        let frame = FrameCodec.decode(line: #"{"type":"stats","id":"u2","brain":"cloud"}"#)
        XCTAssertEqual(frame, .stats(
            id: "u2", brain: .cloud, model: nil,
            promptTokens: nil, outputTokens: nil, tokensPerSec: nil,
            evalMs: nil, loadMs: nil, totalMs: nil, contextWindow: nil, estCostUsd: nil))
    }

    func testOverrideRoundTrips() throws {
        let frame = Frame.override(active: true, ttlMs: 60_000)
        let line = try FrameCodec.encodeLine(frame)
        XCTAssertEqual(FrameCodec.decode(line: line), frame)
        // ttlMs is optional on the wire.
        XCTAssertEqual(FrameCodec.decode(line: #"{"type":"override","active":false}"#),
                       .override(active: false, ttlMs: nil))
    }

    func testUnknownFrameStillDrops() {
        // A frame type the Face doesn't model is dropped (nil), never a crash (T-03-13).
        XCTAssertNil(FrameCodec.decode(line: #"{"type":"totally-unknown","x":1}"#))
    }

    func testSayStreamFrameRoundTrips() throws {
        let frame = Frame.say(id: "u1", delta: "Hello", final: false)
        let line = try FrameCodec.encodeLine(frame)
        XCTAssertEqual(FrameCodec.decode(line: line), frame)
        XCTAssertEqual(FrameCodec.decode(line: #"{"type":"say","id":"u1","delta":"","final":true}"#),
                       .say(id: "u1", delta: "", final: true))
    }

    func testWidgetCommandFrameRoundTrips() throws {
        let frame = Frame.widgetCommand(id: "w1", command: "focus email to:a@b.com options:abort,send(auto 15s)")
        let line = try FrameCodec.encodeLine(frame)
        XCTAssertEqual(FrameCodec.decode(line: line), frame)
    }

    func testToolActivityFrameRoundTrips() throws {
        // start (with detail) round-trips, and ok (detail omitted) decodes with nil detail.
        let frame = Frame.toolActivity(id: "u1", tool: "web", op: "search", status: "start", detail: "apple news")
        let line = try FrameCodec.encodeLine(frame)
        XCTAssertEqual(FrameCodec.decode(line: line), frame)
        XCTAssertEqual(
            FrameCodec.decode(line: #"{"type":"tool.activity","id":"u1","tool":"finance","op":"aggregate","status":"ok"}"#),
            .toolActivity(id: "u1", tool: "finance", op: "aggregate", status: "ok", detail: nil))
    }
}
