import XCTest
@testable import Kernel

/// Proves the menubar brain toggle (CLOUD-01):
///   - the coordinator defaults to `.cloud` (ClaudeBrain — BRAIN-02) on a clean install;
///   - `setBrain` updates the published selection and persists it to UserDefaults so the visible
///     choice survives a Face restart;
///   - selecting the already-active brain is a no-op (no redundant churn);
///   - a freshly constructed coordinator re-reads the persisted selection (the "survives restart"
///     contract from the UI side; the daemon persists its own copy in settings.ts).
///
/// Under the XCTest host `setBrain` does NOT touch the socket (AppCoordinator.isUnderXCTest guard),
/// so this exercises the state + persistence without a live daemon.
@MainActor
final class BrainToggleTests: XCTestCase {

    private let key = "kernel.brain"
    private var saved: String?

    override func setUp() {
        super.setUp()
        // Snapshot + clear the real preference so tests are deterministic and leave no residue.
        saved = UserDefaults.standard.string(forKey: key)
        UserDefaults.standard.removeObject(forKey: key)
    }

    override func tearDown() {
        if let saved {
            UserDefaults.standard.set(saved, forKey: key)
        } else {
            UserDefaults.standard.removeObject(forKey: key)
        }
        super.tearDown()
    }

    func testDefaultsToCloudOnCleanInstall() {
        let c = AppCoordinator()
        XCTAssertEqual(c.brain, .cloud, "no persisted choice → cloud (ClaudeBrain) default")
    }

    func testSetBrainUpdatesSelectionAndPersists() {
        let c = AppCoordinator()
        c.setBrain(.local)
        XCTAssertEqual(c.brain, .local, "selection flips to local")
        XCTAssertEqual(UserDefaults.standard.string(forKey: key), "local", "local is persisted")

        c.setBrain(.cloud)
        XCTAssertEqual(c.brain, .cloud, "selection flips back to cloud")
        XCTAssertEqual(UserDefaults.standard.string(forKey: key), "cloud", "cloud overwrites the persisted choice")
    }

    func testSelectingActiveBrainIsANoOp() {
        let c = AppCoordinator()
        XCTAssertEqual(c.brain, .cloud)
        c.setBrain(.cloud) // same as current — guarded no-op
        XCTAssertEqual(c.brain, .cloud, "re-selecting the active brain leaves the selection unchanged")
    }

    func testFreshCoordinatorReadsPersistedSelection() {
        // Simulate a prior session having chosen local…
        UserDefaults.standard.set("local", forKey: key)
        // …then a Face relaunch constructs a new coordinator.
        let c = AppCoordinator()
        XCTAssertEqual(c.brain, .local, "a new coordinator reflects the persisted brain (survives Face restart)")
    }

    func testInvalidPersistedValueFallsBackToCloud() {
        UserDefaults.standard.set("martian", forKey: key)
        let c = AppCoordinator()
        XCTAssertEqual(c.brain, .cloud, "an unrecognized persisted value falls back to cloud")
    }
}
