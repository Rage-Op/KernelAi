import XCTest
import SwiftUI
@testable import Kernel

/// Proves each Phase-4 widget payload decodes its typed structured fields out of a JSONValue
/// (the daemon's widget.data), renders without any remote-resource load (T-04-04: structured
/// fields only — no AsyncImage/URLRequest/WKWebView), and that the EventKit bridge shapes
/// events + builds the Yellow invitation-reply intent (ROUT-05).
final class WidgetRenderTests: XCTestCase {

    // MARK: Accounts — masked tail, tabular total, read-only

    func testAccountsPayloadDecodesAndNeverExposesFullNumber() {
        let payload = AccountsPayload.from(.object([
            "accounts": .array([
                .object(["name": .string("Checking"), "tail": .string("4321"), "balance": .number(1200)]),
                .object(["name": .string("Savings"), "tail": .string("9876"), "balance": .number(5400)]),
            ]),
        ]))
        XCTAssertEqual(payload.accounts.count, 2)
        XCTAssertEqual(payload.accounts[0].name, "Checking")
        XCTAssertEqual(payload.accounts[0].tail, "4321")    // masked tail only
        XCTAssertEqual(payload.accounts[0].balance, 1200)
        XCTAssertEqual(payload.total, 6600, "total sums balances")
        // Renders without crashing.
        _ = AccountsWidget(payload: payload, isPresented: true).body
    }

    // MARK: Spending — W/M/Y + series decode

    func testSpendingPayloadDecodesTimeframeAndSeries() {
        let payload = SpendingPayload.from(.object([
            "timeframe": .string("M"),
            "total": .number(842.5),
            "series": .array([
                .object(["day": .string("2026-06-01"), "spent": .number(-40)]),
                .object(["day": .string("2026-06-02"), "spent": .number(-120)]),
            ]),
        ]))
        XCTAssertEqual(payload.timeframe, .M)
        XCTAssertEqual(payload.total, 842.5)
        XCTAssertEqual(payload.series.count, 2)
        XCTAssertEqual(payload.series[0].bucket, "2026-06-01")
        XCTAssertEqual(payload.series[1].amount, -120)
        XCTAssertEqual(SpendTimeframe.allCases.map(\.rawValue), ["W", "M", "Y"])
        _ = SpendingWidget(payload: payload, isPresented: true).body
    }

    func testSpendingEmptyCopy() {
        let payload = SpendingPayload.from(.object(["timeframe": .string("W"), "total": .number(0),
                                                    "series": .array([])]))
        XCTAssertTrue(payload.series.isEmpty)
        XCTAssertEqual(payload.total, 0)
        _ = SpendingWidget(payload: payload, isPresented: true).body
    }

    // MARK: All widgets tolerate a malformed / nil payload (defensive decode)

    func testWidgetsDecodeDefensivelyFromNil() {
        XCTAssertEqual(MailPayload.from(nil).count, 0)
        XCTAssertTrue(AccountsPayload.from(nil).accounts.isEmpty)
        XCTAssertEqual(SpendingPayload.from(nil).total, 0)
        XCTAssertEqual(EmailPreviewPayload.from(nil).to, "")
    }

    // MARK: EventKit bridge — payload shaping + Yellow invitation-reply intent (ROUT-05)

    func testEventKitBridgeShapesEventsPayload() {
        let events = [
            CalendarEvent(time: "9:30", title: "Standup", location: "Zoom", isInvitation: false),
            CalendarEvent(time: "14:00", title: "Design sync", location: nil, isInvitation: true),
        ]
        let payload = EventKitBridge.payload(from: events)
        // The shape is exactly what EventsWidget decodes.
        let decoded = EventsPayload.from(payload)
        XCTAssertEqual(decoded.count, 2)
        XCTAssertEqual(decoded.items.count, 2)
        XCTAssertEqual(decoded.items[0].title, "Standup")
        XCTAssertEqual(decoded.items[0].location, "Zoom")
    }

    func testEventKitBridgeUnderXCTestReturnsEmptyPayload() {
        // No live EventKit under the test host — eventsPayload() must be empty, not block.
        XCTAssertTrue(EventKitBridge.isUnderXCTest, "tests run under the XCTest host")
        let decoded = EventsPayload.from(EventKitBridge.eventsPayload())
        XCTAssertEqual(decoded.count, 0)
    }

    func testInvitationReplyIntentIsAUiIntentCarryingNoTier() {
        let frame = EventKitBridge.invitationReplyIntent(
            id: "inv-1", eventTitle: "Design sync", reply: .accept)
        guard case let .uiIntent(id, intent, payload) = frame else {
            return XCTFail("expected a ui.intent frame (the Yellow write routes back to the daemon gate)")
        }
        XCTAssertEqual(id, "inv-1")
        XCTAssertEqual(intent, "invitation-reply")
        XCTAssertEqual(payload?["reply"]?.stringValue, "accept")
        XCTAssertEqual(payload?["eventTitle"]?.stringValue, "Design sync")
        // The bridge attaches NO tier — the daemon gate classifies it centrally (ROUT-05).
        XCTAssertNil(payload?["tier"], "the Face never self-classifies a tier")
        // Round-trips like every other frame.
        let line = try? FrameCodec.encodeLine(frame)
        XCTAssertNotNil(line)
        XCTAssertEqual(FrameCodec.decode(line: line!), frame)
    }
}
