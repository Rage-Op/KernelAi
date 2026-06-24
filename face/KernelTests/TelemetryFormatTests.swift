import XCTest
@testable import Kernel

/// Proves the always-on telemetry strip's formatting + the cumulative session-usage accumulator —
/// the "like Claude" readouts (tok/s, context fill, cost, session totals).
final class TelemetryFormatTests: XCTestCase {

    func testCommasGroupThousands() {
        XCTAssertEqual(TelemetryFormat.commas(2418), "2,418")
        XCTAssertEqual(TelemetryFormat.commas(16384), "16,384")
        XCTAssertEqual(TelemetryFormat.commas(42), "42")
    }

    func testTokensPerSec() {
        XCTAssertEqual(TelemetryFormat.tokensPerSec(30.6), "31 tok/s")
        XCTAssertEqual(TelemetryFormat.tokensPerSec(nil), "— tok/s")
        XCTAssertEqual(TelemetryFormat.tokensPerSec(0), "— tok/s")
    }

    func testCost() {
        XCTAssertEqual(TelemetryFormat.cost(nil), "$0")
        XCTAssertEqual(TelemetryFormat.cost(0), "$0")
        XCTAssertEqual(TelemetryFormat.cost(0.0066), "$0.0066")
        XCTAssertEqual(TelemetryFormat.cost(1.5), "$1.50")
    }

    func testContextFill() {
        let f = TelemetryFormat.contextFill(used: 1205, window: 8192)
        XCTAssertNotNil(f)
        XCTAssertEqual(f?.label, "15%")
        XCTAssertEqual(f!.fraction, 1205.0 / 8192.0, accuracy: 0.0001)
        XCTAssertNil(TelemetryFormat.contextFill(used: nil, window: 8192))
        XCTAssertNil(TelemetryFormat.contextFill(used: 100, window: nil))
    }

    func testWindowLabel() {
        XCTAssertEqual(TelemetryFormat.windowLabel(8192), "8K")
        XCTAssertEqual(TelemetryFormat.windowLabel(1_000_000), "1M")
        XCTAssertEqual(TelemetryFormat.windowLabel(nil), "—")
    }

    func testSessionUsageFoldsTurns() {
        var usage = SessionUsage()
        XCTAssertEqual(usage.turns, 0)
        usage.record(TurnStats(
            id: "u1", brain: .local, model: "qwen2.5:7b",
            promptTokens: 1205, outputTokens: 24, tokensPerSec: 30.6,
            evalMs: nil, loadMs: nil, totalMs: nil, contextWindow: 8192, estCostUsd: 0))
        usage.record(TurnStats(
            id: "u2", brain: .local, model: "qwen2.5:7b",
            promptTokens: 300, outputTokens: 50, tokensPerSec: 28.0,
            evalMs: nil, loadMs: nil, totalMs: nil, contextWindow: 8192, estCostUsd: 0.0066))
        XCTAssertEqual(usage.turns, 2)
        XCTAssertEqual(usage.totalPromptTokens, 1505)
        XCTAssertEqual(usage.totalOutputTokens, 74)
        XCTAssertEqual(usage.totalTokens, 1579)
        XCTAssertEqual(usage.totalCostUsd, 0.0066, accuracy: 0.00001)
        XCTAssertEqual(usage.lastTokensPerSec, 28.0)
        XCTAssertEqual(usage.lastModel, "qwen2.5:7b")
        XCTAssertEqual(usage.lastBrain, .local)
    }
}
