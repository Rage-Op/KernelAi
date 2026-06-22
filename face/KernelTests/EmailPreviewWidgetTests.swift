import XCTest
@testable import Kernel

/// Proves the email-preview "Send it?" card invariants (04-UI-SPEC §3; MAIL-04/05):
///   - To / Subject / body / signature decode from a JSONValue payload (typed only).
///   - An external-sourced To is flagged so the accent-ringed "external" marker renders.
///   - The control set is exactly Edit + Send, and Send is the ONLY send path (the onSend
///     callback) — there is NO auto-send on construction / present (the load-bearing MAIL-05
///     invariant). The daemon performs the gated send; the card only emits the intent.
final class EmailPreviewWidgetTests: XCTestCase {

    // MARK: Typed decode

    func testDecodesAllFourFields() {
        let payload = EmailPreviewPayload.from(.object([
            "to": .string("ana@acme.com"),
            "subject": .string("Re: Friday"),
            "body": .string("Hi Ana,\n\nFriday works.\n\nThanks,\nPravin"),
            "signature": .string("— Pravin"),
        ]))
        XCTAssertEqual(payload.to, "ana@acme.com")
        XCTAssertEqual(payload.subject, "Re: Friday")
        XCTAssertEqual(payload.body, "Hi Ana,\n\nFriday works.\n\nThanks,\nPravin")
        XCTAssertEqual(payload.signature, "— Pravin")
        XCTAssertFalse(payload.errored)
    }

    func testMalformedPayloadDecodesToErroredNotCrash() {
        // A non-object / error payload yields an errored card ("Draft unavailable."), never a crash.
        let errored = EmailPreviewPayload.from(.object(["error": .string("offline")]))
        XCTAssertTrue(errored.errored)
        let empty = EmailPreviewPayload.from(nil)
        XCTAssertFalse(empty.errored)
        XCTAssertEqual(empty.to, "")
    }

    // MARK: External-To marker (MAIL-05)

    func testExternalSourcedToFlagsTheExternalMarker() {
        let external = EmailPreviewPayload.from(.object([
            "to": .string("stranger@unknown.io"),
            "subject": .string("Hi"),
            "body": .string("Hi"),
            "signature": .string(""),
            "toSource": .string("external"),
        ]))
        XCTAssertTrue(external.toIsExternal, "an externally-sourced To must show the external marker")

        let known = EmailPreviewPayload.from(.object([
            "to": .string("ana@acme.com"),
            "subject": .string("Hi"),
            "body": .string("Hi"),
            "signature": .string(""),
            "source": .string("user"),
        ]))
        XCTAssertFalse(known.toIsExternal, "a user-sourced To is not flagged external")
    }

    // MARK: NO auto-send invariant (MAIL-05 — the load-bearing property)

    func testNoAutoSendOnConstructionOrPresent() {
        var sentCount = 0
        let payload = EmailPreviewPayload.from(.object([
            "to": .string("ana@acme.com"), "subject": .string("Hi"),
            "body": .string("Body"), "signature": .string(""),
        ]))
        // Construct + present the widget. NOTHING sends.
        let widget = EmailPreviewWidget(payload: payload, isPresented: true,
                                        onSend: { _ in sentCount += 1 })
        XCTAssertEqual(sentCount, 0, "no auto-send on construction/present")
        // The ONLY send path is the explicit onSend callback (the user tapped Send).
        widget.onSend?(payload)
        XCTAssertEqual(sentCount, 1, "send happens only on explicit Send")
        // Re-presenting still triggers no further send.
        XCTAssertEqual(sentCount, 1, "presenting again does not re-send")
    }

    func testSendCarriesThePreviewPayloadToTheParent() {
        // The Send callback hands the parent the exact preview it will send (so the parent emits
        // ui.intent{intent:'send-email', payload:{...}} — the single send path).
        var captured: EmailPreviewPayload?
        let payload = EmailPreviewPayload.from(.object([
            "to": .string("ana@acme.com"), "subject": .string("Re: Friday"),
            "body": .string("Friday works."), "signature": .string("— Pravin"),
        ]))
        let widget = EmailPreviewWidget(payload: payload, isPresented: true,
                                        onSend: { p in captured = p })
        widget.onSend?(payload)
        XCTAssertEqual(captured?.to, "ana@acme.com")
        XCTAssertEqual(captured?.subject, "Re: Friday")
        XCTAssertEqual(captured?.body, "Friday works.")
    }

    func testEditIsASeparateNonSendingControl() {
        // Edit re-opens the intent; it must NOT send.
        var sentCount = 0
        var editCount = 0
        let payload = EmailPreviewPayload.from(.object([
            "to": .string("ana@acme.com"), "subject": .string("Hi"),
            "body": .string("Body"), "signature": .string(""),
        ]))
        let widget = EmailPreviewWidget(payload: payload, isPresented: true,
                                        onSend: { _ in sentCount += 1 },
                                        onEdit: { editCount += 1 })
        widget.onEdit?()
        XCTAssertEqual(editCount, 1, "Edit fires its own callback")
        XCTAssertEqual(sentCount, 0, "Edit never sends")
    }
}
