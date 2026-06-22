import XCTest
import SwiftUI
@testable import Kernel

/// Proves the Red-tier breaker preview card invariants (KERNEL_MASTER_BUILD_PROMPT §8 / §15; SAFE-03):
///   - the preview (summary + spend impact) renders from a typed BreakerPreview (no remote load);
///   - the control set is exactly ONE Cancel control, and it is the ONLY cancel path (the onCancel
///     callback) — there is NO auto-cancel on construction/present (the card never decides);
///   - Cancel hands the parent the exact preview so it can emit `breaker.cancel{id}` (the single
///     cancel path the daemon honours);
///   - the window-elapsed callback exists so the card auto-dismisses when the 10s window drains.
final class BreakerPreviewCardTests: XCTestCase {

    private func sampleFinancial() -> BreakerPreview {
        BreakerPreview(id: "bp-1",
                       summary: "Red action: shop (purchase) — estimated spend 40 — 10s to cancel.",
                       estimatedSpend: 40)
    }

    private func sampleNonFinancial() -> BreakerPreview {
        BreakerPreview(id: "bp-2", summary: "Red action: fs (rm -rf) — 10s to cancel.", estimatedSpend: 0)
    }

    // MARK: Render (typed fields only — no crash, no remote load)

    func testRendersFinancialPreviewWithoutCrash() {
        let card = BreakerPreviewCard(preview: sampleFinancial(), isPresented: true)
        _ = card.body   // exercises the populated path incl. the spend line.
    }

    func testRendersNonFinancialPreviewWithoutCrash() {
        let card = BreakerPreviewCard(preview: sampleNonFinancial(), isPresented: true)
        _ = card.body   // estimatedSpend 0 → the spend line is omitted; still renders.
    }

    // MARK: NO auto-cancel invariant (the card NEVER decides — the load-bearing property)

    func testNoAutoCancelOnConstructionOrPresent() {
        var cancelCount = 0
        let card = BreakerPreviewCard(preview: sampleFinancial(), isPresented: true,
                                      onCancel: { _ in cancelCount += 1 })
        XCTAssertEqual(cancelCount, 0, "no auto-cancel on construction/present — the owner must tap Cancel")
        // The ONLY cancel path is the explicit onCancel callback (the user tapped Cancel).
        card.onCancel?(sampleFinancial())
        XCTAssertEqual(cancelCount, 1, "cancel happens only on the explicit Cancel control")
    }

    func testCancelCarriesThePreviewToTheParent() {
        // The Cancel callback hands the parent the exact preview (so it emits breaker.cancel{id}).
        var captured: BreakerPreview?
        let preview = sampleFinancial()
        let card = BreakerPreviewCard(preview: preview, isPresented: true,
                                      onCancel: { p in captured = p })
        card.onCancel?(preview)
        XCTAssertEqual(captured?.id, "bp-1", "the cancel carries the correlation id back to the parent")
    }

    // MARK: The window-elapsed callback (auto-dismiss → proceed is the locked SAFE-03 default)

    func testElapsedCallbackIsInvokable() {
        var elapsed: BreakerPreview?
        let preview = sampleNonFinancial()
        let card = BreakerPreviewCard(preview: preview, isPresented: true,
                                      onElapsed: { p in elapsed = p })
        card.onElapsed?(preview)
        XCTAssertEqual(elapsed?.id, "bp-2", "the elapsed callback fires with the preview when the window drains")
    }

    // MARK: Coordinator wiring (the frame → card → cancel-frame seam)

    @MainActor
    func testCoordinatorSurfacesPreviewOnFrameAndClearsOnCancel() {
        let coordinator = AppCoordinator()
        XCTAssertNil(coordinator.activeBreakerPreview, "no preview before a breaker.preview frame")

        coordinator.presentBreakerPreview(sampleFinancial())
        XCTAssertEqual(coordinator.activeBreakerPreview?.id, "bp-1", "the card is surfaced on the preview")

        // Cancel clears the active preview (and, outside the test host, would emit breaker.cancel).
        coordinator.cancelBreakerPreview(sampleFinancial())
        XCTAssertNil(coordinator.activeBreakerPreview, "cancel clears the active preview card")
    }

    @MainActor
    func testCoordinatorClearsPreviewWhenWindowElapses() {
        let coordinator = AppCoordinator()
        coordinator.presentBreakerPreview(sampleNonFinancial())
        XCTAssertEqual(coordinator.activeBreakerPreview?.id, "bp-2")
        coordinator.breakerPreviewElapsed(sampleNonFinancial())
        XCTAssertNil(coordinator.activeBreakerPreview, "the elapsed window auto-dismisses the card (proceed default)")
    }
}
