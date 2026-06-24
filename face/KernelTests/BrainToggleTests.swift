import XCTest
@testable import Kernel

/// Proves the menubar brain toggle (CLOUD-01):
///   - the coordinator defaults to `.local` (LocalBrain / qwen3.5) on a clean install — a local-first
///     assistant that uses tools and works offline; mirrors the daemon's boot default (index.ts);
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

    func testDefaultsToLocalOnCleanInstall() {
        let c = AppCoordinator()
        XCTAssertEqual(c.brain, .local, "no persisted choice → local (LocalBrain) default")
    }

    func testSetBrainUpdatesSelectionAndPersists() {
        let c = AppCoordinator()
        // Default is .local — flip to cloud first (a real change), then back to local.
        c.setBrain(.cloud)
        XCTAssertEqual(c.brain, .cloud, "selection flips to cloud")
        XCTAssertEqual(UserDefaults.standard.string(forKey: key), "cloud", "cloud is persisted")

        c.setBrain(.local)
        XCTAssertEqual(c.brain, .local, "selection flips back to local")
        XCTAssertEqual(UserDefaults.standard.string(forKey: key), "local", "local overwrites the persisted choice")
    }

    func testSelectingActiveBrainIsANoOp() {
        let c = AppCoordinator()
        XCTAssertEqual(c.brain, .local)
        c.setBrain(.local) // same as current — guarded no-op
        XCTAssertEqual(c.brain, .local, "re-selecting the active brain leaves the selection unchanged")
    }

    func testFreshCoordinatorReadsPersistedSelection() {
        // Simulate a prior session having chosen cloud (a non-default value)…
        UserDefaults.standard.set("cloud", forKey: key)
        // …then a Face relaunch constructs a new coordinator.
        let c = AppCoordinator()
        XCTAssertEqual(c.brain, .cloud, "a new coordinator reflects the persisted brain (survives Face restart)")
    }

    func testInvalidPersistedValueFallsBackToLocal() {
        UserDefaults.standard.set("martian", forKey: key)
        let c = AppCoordinator()
        XCTAssertEqual(c.brain, .local, "an unrecognized persisted value falls back to local")
    }
}
