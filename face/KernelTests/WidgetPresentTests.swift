import XCTest
@testable import Kernel

/// Verifies the live wiring (independent of the UI): presenting a widget command sets the
/// coordinator's `activeWidget` (which the RuntimeWindow overlay renders), using the exact demo
/// string — em-dash, multi-word values, and an auto-fire option.
@MainActor
final class WidgetPresentTests: XCTestCase {

    func testPresentSetsActiveWidget() {
        let c = AppCoordinator()
        XCTAssertNil(c.activeWidget)
        c.presentWidgetCommand(
            id: "demo",
            command: "focus email to:john@acme.com from:Acme Corp subject:Renewal decision content:Glad to move forward at the revised terms — 3-year at locked pricing. options:abort,send(auto 15s)")
        let w = c.activeWidget
        XCTAssertNotNil(w, "presenting a valid command must set activeWidget")
        XCTAssertEqual(w?.kind, "email")
        XCTAssertEqual(w?.fields.first { $0.key == "to" }?.value, "john@acme.com")
        XCTAssertEqual(w?.options.last?.autoSeconds, 15)
    }

    func testLocalWidgetShortcutPresents() {
        let c = AppCoordinator()
        c.sendUtterance("/widget focus note content:remember the milk options:abort,save(auto 20s)")
        XCTAssertNotNil(c.activeWidget, "a /widget … utterance presents the displayer instead of sending")
        XCTAssertEqual(c.activeWidget?.kind, "note")
    }
}
