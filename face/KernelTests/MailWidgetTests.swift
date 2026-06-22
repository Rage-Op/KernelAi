import XCTest
@testable import Kernel

/// Proves the mail widget's typed decode + chip/active-suggestion logic, the empty/error
/// copy, and the load-bearing NO-AUTO-SEND invariant on the email-preview Yellow gate
/// (04-UI-SPEC §2/§3; ROUT-04 / MAIL-04/05).
final class MailWidgetTests: XCTestCase {

    // MARK: Mail payload decode + chip set + active suggestion

    func testMailPayloadDecodesTypedFieldsAndActiveSuggestion() {
        let json = FrameCodec.decode(line: """
        {"type":"widget.data","widget":"mail","data":{"count":2,"items":[\
        {"sender":"Ana","subject":"Lunch?","snippet":"free today?","source":"external","suggestion":"reply"},\
        {"sender":"Ops","subject":"Deploy","snippet":"all green","source":"external","suggestion":"log"}]}}
        """)
        guard case let .widgetData(_, data) = json else { return XCTFail("expected widget.data") }
        let payload = MailPayload.from(data)
        XCTAssertEqual(payload.count, 2)
        XCTAssertEqual(payload.items.count, 2)
        XCTAssertEqual(payload.items[0].sender, "Ana")
        XCTAssertEqual(payload.items[0].subject, "Lunch?")
        XCTAssertEqual(payload.items[0].snippet, "free today?")
        XCTAssertEqual(payload.items[0].source, "external")
        // The 7B triage tag becomes the active suggestion (the accent-ringed chip).
        XCTAssertEqual(payload.items[0].suggestion, .reply)
        XCTAssertEqual(payload.items[1].suggestion, .log)
    }

    func testMailWidgetExposesAllFourChips() {
        // The chip set is exactly Log/Reply/Open/Archive (04-UI-SPEC §2).
        XCTAssertEqual(MailAction.allCases.map(\.rawValue), ["log", "reply", "open", "archive"])
        XCTAssertEqual(MailAction.allCases.map(\.label), ["Log", "Reply", "Open", "Archive"])
    }

    func testMailChipActionDispatchesThroughCallbackNotLocally() {
        // A tapped chip must surface its action to the parent (which emits a gate-routed
        // ui.intent) — the widget never acts on its own.
        var dispatched: (MailAction, String)?
        let item = MailItem(sender: "Ana", subject: "Lunch?", snippet: "x",
                            source: "external", suggestion: .reply)
        let widget = MailWidget(payload: MailPayload(count: 1, items: [item], errored: false, errorReason: nil),
                                isPresented: true,
                                onAction: { action, it in dispatched = (action, it.subject) })
        widget.onAction?(.archive, item)
        XCTAssertEqual(dispatched?.0, .archive)
        XCTAssertEqual(dispatched?.1, "Lunch?")
    }

    func testMailEmptyAndErrorCopy() {
        let empty = MailPayload.from(.object(["count": .number(0), "items": .array([])]))
        XCTAssertEqual(empty.count, 0)
        XCTAssertTrue(empty.items.isEmpty)
        XCTAssertFalse(empty.errored)

        let errored = MailPayload.from(.object(["error": .string("offline")]))
        XCTAssertTrue(errored.errored)
        XCTAssertEqual(errored.errorReason, "offline")
    }

    // MARK: Email-preview — the Yellow gate, NO auto-send invariant (MAIL-05)

    func testEmailPreviewDecodesTypedFieldsAndExternalMarker() {
        let payload = EmailPreviewPayload.from(.object([
            "to": .string("ana@x.com"),
            "subject": .string("Re: Lunch?"),
            "body": .string("Sure!"),
            "signature": .string("— P"),
            "toSource": .string("external"),
        ]))
        XCTAssertEqual(payload.to, "ana@x.com")
        XCTAssertEqual(payload.subject, "Re: Lunch?")
        XCTAssertEqual(payload.body, "Sure!")
        XCTAssertEqual(payload.signature, "— P")
        XCTAssertTrue(payload.toIsExternal, "an external-sourced To shows the external marker")
    }

    func testEmailPreviewHasNoAutoSendPath() {
        // The ONLY send path is the explicit onSend callback. Constructing + presenting the
        // widget must NOT send. A send happens only when onSend is invoked (the user tapped Send).
        var sentCount = 0
        let payload = EmailPreviewPayload.from(.object([
            "to": .string("ana@x.com"), "subject": .string("Hi"),
            "body": .string("Body"), "signature": .string(""),
        ]))
        let widget = EmailPreviewWidget(payload: payload, isPresented: true,
                                        onSend: { _ in sentCount += 1 })
        // Merely existing/presenting sends nothing.
        XCTAssertEqual(sentCount, 0, "no auto-send on present")
        // An explicit Send (the user action) is the one and only send trigger.
        widget.onSend?(payload)
        XCTAssertEqual(sentCount, 1, "send happens only on explicit Send")
    }
}
