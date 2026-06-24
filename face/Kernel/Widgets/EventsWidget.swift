import SwiftUI

/// The events glass widget, choreographed end-to-end (CLOUD-04; 03-UI-SPEC §1).
///
/// Renders ONLY typed, structured fields parsed out of the `widget.data` payload
/// (T-03-12: no auto-load of remote images / markdown / URLs from model output).
/// Bloom = scale 0.96→1.0 + opacity 0→1 + forward-blur clears; dissolve = the
/// reverse, blur returns as it recedes into the cloud. Nothing snaps (Motion Law).

/// One typed event row (parsed from the widget.data payload — structured only).
struct EventItem: Identifiable, Equatable {
    let id = UUID()
    let time: String        // already-formatted, tabular ("9:30")
    let title: String
    let location: String?
}

/// The events payload, decoded defensively from a `JSONValue` (never trusts shape).
struct EventsPayload: Equatable {
    let count: Int
    let items: [EventItem]
    let errored: Bool

    static func from(_ json: JSONValue?) -> EventsPayload {
        guard let obj = json?.objectValue else { return EventsPayload(count: 0, items: [], errored: false) }
        if obj["error"]?.stringValue != nil || (obj["errored"]?.doubleValue ?? 0) == 1 {
            return EventsPayload(count: 0, items: [], errored: true)
        }
        let count = Int(obj["count"]?.doubleValue ?? 0)
        let items: [EventItem] = (obj["items"]?.arrayValue ?? []).compactMap { entry in
            guard let e = entry.objectValue, let title = e["title"]?.stringValue else { return nil }
            return EventItem(
                time: e["time"]?.stringValue ?? "",
                title: title,
                location: e["location"]?.stringValue)
        }
        return EventsPayload(count: count, items: Array(items.prefix(3)), errored: false)
    }
}

struct EventsWidget: View {
    let payload: EventsPayload
    /// True while the widget is bloomed in focus; false dissolves it into the cloud.
    let isPresented: Bool

    /// Animated count-up value (tabular numerals keep the width stable — Motion Law).
    @State private var displayedCount: Int = 0

    var body: some View {
        content
            .kernelCard(isPresented: isPresented, maxWidth: 360)
            .onChange(of: isPresented) { _, presented in
                if presented { startCountUp() } else { displayedCount = 0 }
            }
            .onAppear { if isPresented { startCountUp() } }
    }

    @ViewBuilder
    private var content: some View {
        if payload.errored {
            errorState
        } else if payload.count == 0 && payload.items.isEmpty {
            emptyState
        } else {
            populated
        }
    }

    // MARK: Populated

    private var populated: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.md) {
            // "Today" header — violet marker + a tabular count on the trailing edge.
            CardHeader(dot: Tokens.catViolet, title: "Today") {
                Text("\(displayedCount) \(displayedCount == 1 ? "event" : "events")")
                    .font(Tokens.Typography.monoLabel)
                    .monospacedDigit()
                    .foregroundStyle(Tokens.textMuted)
            }

            VStack(spacing: Tokens.Space.xs) {
                ForEach(Array(payload.items.enumerated()), id: \.element.id) { idx, item in
                    timelineRow(item, isNext: idx == 0)
                }
            }
        }
    }

    /// One timeline row: a tabular time on a left rail + the title/location, with the next event
    /// (the first) highlighted by a terracotta edge bar + warm well.
    private func timelineRow(_ item: EventItem, isNext: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.md) {
            Text(item.time)
                .font(Tokens.Typography.monoLabel)
                .monospacedDigit()
                .foregroundStyle(Tokens.textMuted)
                .frame(width: 52, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title)
                    .font(Tokens.Typography.body)
                    .foregroundStyle(Tokens.textPrimary)
                if let location = item.location, !location.isEmpty {
                    Text(location)
                        .font(Tokens.Typography.label)
                        .foregroundStyle(Tokens.textMuted)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 6)
        .padding(.horizontal, Tokens.Space.sm)
        .background(isNext ? Tokens.chipFill : .clear,
                    in: RoundedRectangle(cornerRadius: Tokens.Radius.chip, style: .continuous))
        .overlay(alignment: .leading) {
            if isNext {
                Capsule().fill(Tokens.accentTerracotta).frame(width: 2).padding(.vertical, 4)
            }
        }
    }

    // MARK: Empty / Error (UI-SPEC copy — terse, no accent, no CTA in P3)

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.xs) {
            Text("No events today")
                .font(Tokens.Typography.heading)
                .foregroundStyle(Tokens.textPrimary)
            Text("Your calendar's clear.")
                .font(Tokens.Typography.body)
                .foregroundStyle(Tokens.textMuted)
        }
    }

    private var errorState: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.xs) {
            Text("Couldn't reach the calendar.")
                .font(Tokens.Typography.heading)
                .foregroundStyle(Tokens.textPrimary)
            Text("KERNEL will retry on the next brief.")
                .font(Tokens.Typography.body)
                .foregroundStyle(Tokens.textMuted)
        }
    }

    // MARK: Count-up (ease-out — Motion Law)

    private func startCountUp() {
        displayedCount = 0
        let target = payload.count
        guard target > 0 else { return }
        // Ease the count up over the count-up duration; tabular numerals hold the width.
        withAnimation(Motion.countUp) { displayedCount = target }
        // SwiftUI does not interpolate Int text directly; step it on a short timer so
        // the figure visibly counts up rather than snapping (Motion Law: numbers count up).
        let steps = max(1, min(target, 12))
        let interval = Motion.countUpDuration / Double(steps)
        for step in 1...steps {
            DispatchQueue.main.asyncAfter(deadline: .now() + interval * Double(step)) {
                displayedCount = Int(Double(target) * Double(step) / Double(steps))
            }
        }
    }
}
