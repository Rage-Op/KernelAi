import Foundation
#if canImport(EventKit)
import EventKit
#endif

/// The Face-side EventKit bridge (ROUT-05).
///
/// Calendar lives behind the FACE app's TCC identity — the daemon never reads the calendar
/// directly (Pitfall 3). This bridge READS events via EventKit and exposes them as a
/// `widget.data`-shaped payload (the same typed shape EventsWidget decodes), and it BUILDS a
/// `ui.intent{intent:'invitation-reply'}` frame for accept/propose. That intent is the YELLOW
/// write — it routes back to the daemon gate (the bridge never classifies the tier itself).
///
/// Under the XCTest host there is no live EventKit/Calendar TCC (the runner would block on the
/// permission prompt), so the read is guarded exactly like `AppCoordinator.isUnderXCTest`. Tests
/// exercise the pure payload/intent shaping, not a live calendar.
struct CalendarEvent: Equatable {
    let time: String
    let title: String
    let location: String?
    /// Whether this event is an unanswered invitation the owner can accept/propose.
    let isInvitation: Bool
}

/// An accept-or-propose decision on an invitation.
enum InvitationReply: String {
    case accept
    case propose
}

enum EventKitBridge {

    /// True when hosted by XCTest — mirrors AppCoordinator.isUnderXCTest. No live EventKit here.
    static var isUnderXCTest: Bool {
        ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
            || NSClassFromString("XCTestCase") != nil
    }

    /// Read today's events via EventKit and shape them as a `widget.data`-style JSONValue payload
    /// (the typed shape EventsWidget.from(_:) decodes). Returns an empty payload under XCTest or
    /// when EventKit is unavailable/denied — never throws, never blocks the runner.
    static func eventsPayload() -> JSONValue {
        guard !isUnderXCTest else { return payload(from: []) }
        #if canImport(EventKit)
        let store = EKEventStore()
        let status = EKEventStore.authorizationStatus(for: .event)
        guard status == .authorized || status == .fullAccess else {
            return payload(from: [])
        }
        let start = Calendar.current.startOfDay(for: Date())
        let end = Calendar.current.date(byAdding: .day, value: 1, to: start) ?? start
        let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
        let formatter = DateFormatter()
        formatter.dateFormat = "H:mm"
        let events: [CalendarEvent] = store.events(matching: predicate).map { ev in
            CalendarEvent(
                time: formatter.string(from: ev.startDate),
                title: ev.title ?? "(no title)",
                location: ev.location,
                isInvitation: ev.hasAttendees && (ev.organizer?.isCurrentUser == false))
        }
        return payload(from: events)
        #else
        return payload(from: [])
        #endif
    }

    /// Shape a list of events into the typed `widget.data` payload EventsWidget decodes.
    static func payload(from events: [CalendarEvent]) -> JSONValue {
        let items: [JSONValue] = events.map { ev in
            var obj: [String: JSONValue] = [
                "time": .string(ev.time),
                "title": .string(ev.title),
            ]
            if let loc = ev.location, !loc.isEmpty { obj["location"] = .string(loc) }
            return .object(obj)
        }
        return .object([
            "count": .number(Double(events.count)),
            "items": .array(items),
        ])
    }

    /// Build the Yellow `ui.intent{intent:'invitation-reply'}` frame for accept/propose. The
    /// daemon gate classifies the tier centrally — the bridge attaches NO tier (ROUT-05).
    static func invitationReplyIntent(id: String, eventTitle: String, reply: InvitationReply,
                                      proposedTime: String? = nil) -> Frame {
        var payload: [String: JSONValue] = [
            "eventTitle": .string(eventTitle),
            "reply": .string(reply.rawValue),
        ]
        if let proposedTime { payload["proposedTime"] = .string(proposedTime) }
        return .uiIntent(id: id, intent: "invitation-reply", payload: .object(payload))
    }
}
