import XCTest
@testable import Kernel

/// Proves the XCTest lane builds + runs against the Kernel app target.
/// Wave 1 has no Stage logic yet (that lands in 03-04 with StageControllerTests);
/// this asserts the stable bundle identity that TCC permanence depends on (Pitfall 4).
final class BootstrapTests: XCTestCase {

    func testBundleIdentifierIsStable() {
        XCTAssertEqual(
            KernelBundle.identifier,
            "com.kernel.face",
            "The bundle id MUST stay com.kernel.face — TCC mic grants are bound to it (Pitfall 4)."
        )
    }

    func testDisplayName() {
        XCTAssertEqual(KernelBundle.displayName, "Kernel")
    }

    func testSpikeSentenceContainsANumber() {
        // The boundary spike's value comes from a number-containing sentence
        // (numerals are where AVSpeech ranges are documented to drift).
        let hasDigit = BoundarySpike.sentence.contains { $0.isNumber }
        XCTAssertTrue(hasDigit, "Spike sentence must contain a number to exercise range drift.")
    }
}
