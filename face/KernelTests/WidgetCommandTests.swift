import XCTest
@testable import Kernel

/// Proves the widget-displayer command-language parser (WS4): the grammar
/// `<verb> <kind> key:value … options:opt,opt(auto Ns)` parses into a renderable WidgetSpec with
/// ordered fields, space-bearing values, and options that carry an optional auto-fire timer.
final class WidgetCommandTests: XCTestCase {

    func testParsesTheEmailExample() throws {
        let spec = WidgetCommand.parse(
            id: "w1",
            "focus email to:john@x.com from:Acme subject:Renewal content:Let's proceed today options:abort,send(auto 15s)")
        let s = try XCTUnwrap(spec)
        XCTAssertEqual(s.verb, "focus")
        XCTAssertEqual(s.kind, "email")
        XCTAssertEqual(s.title, "Email")

        XCTAssertEqual(s.fields.map(\.key), ["to", "from", "subject", "content"])
        XCTAssertEqual(s.fields.first { $0.key == "to" }?.value, "john@x.com")
        XCTAssertEqual(s.fields.first { $0.key == "content" }?.value, "Let's proceed today",
                       "a value runs (with spaces) until the next key")

        XCTAssertEqual(s.options.count, 2)
        XCTAssertEqual(s.options[0].label, "abort")
        XCTAssertEqual(s.options[0].kind, .abort)
        XCTAssertNil(s.options[0].autoSeconds)
        XCTAssertEqual(s.options[1].label, "send")
        XCTAssertEqual(s.options[1].kind, .confirm)
        XCTAssertEqual(s.options[1].autoSeconds, 15, "send(auto 15s) carries a 15s auto-fire timer")
    }

    func testParsesWithoutOptions() throws {
        let s = try XCTUnwrap(WidgetCommand.parse(id: "w2", "show note content:remember the milk"))
        XCTAssertEqual(s.kind, "note")
        XCTAssertEqual(s.fields.first?.value, "remember the milk")
        XCTAssertEqual(s.options.count, 0)
    }

    func testRejectsMalformed() {
        XCTAssertNil(WidgetCommand.parse(id: "w3", ""))
        XCTAssertNil(WidgetCommand.parse(id: "w3", "focus"), "needs at least a verb + kind")
    }

    func testOptionKindKeywords() {
        let opts = WidgetCommand.parseOptions("cancel,approve,snooze")
        XCTAssertEqual(opts.map(\.kind), [.abort, .confirm, .neutral])
    }
}
