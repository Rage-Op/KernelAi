import SwiftUI

/// The mail glass widget (04-UI-SPEC §2; ROUT-04 / MAIL).
///
/// Renders ONLY typed, structured fields parsed out of the `widget.data` payload
/// (T-04-04 / T-03-12: no AsyncImage / URLRequest / WKWebView). A card shows the
/// sender, subject and a one-line snippet, then a row of suggested-action chips
/// (Log / Reply / Open / Archive). The 7B triage tag is pre-highlighted: a chip
/// carries the accent ring ONLY when it is the active suggestion. Tapping a chip
/// emits a `ui.intent` that the daemon dispatches through the gate (the chip never
/// acts locally). Bloom/dissolve + tabular numerals mirror EventsWidget.

/// One suggested action a chip can dispatch.
enum MailAction: String, CaseIterable, Identifiable {
    case log, reply, open, archive
    var id: String { rawValue }
    var label: String {
        switch self {
        case .log: return "Log"
        case .reply: return "Reply"
        case .open: return "Open"
        case .archive: return "Archive"
        }
    }
}

/// One typed mail row (parsed from the widget.data payload — structured only).
struct MailItem: Identifiable, Equatable {
    let id = UUID()
    let sender: String
    let subject: String
    let snippet: String
    let source: String          // "external" | "internal" — external content is untrusted
    let suggestion: MailAction? // the active 7B triage tag (accent-ringed chip)
}

/// The mail payload, decoded defensively from a `JSONValue` (never trusts shape).
struct MailPayload: Equatable {
    let count: Int
    let items: [MailItem]
    let errored: Bool
    let errorReason: String?

    static func from(_ json: JSONValue?) -> MailPayload {
        guard let obj = json?.objectValue else {
            return MailPayload(count: 0, items: [], errored: false, errorReason: nil)
        }
        if let reason = obj["error"]?.stringValue {
            return MailPayload(count: 0, items: [], errored: true, errorReason: reason)
        }
        if (obj["errored"]?.doubleValue ?? 0) == 1 {
            return MailPayload(count: 0, items: [], errored: true, errorReason: nil)
        }
        let count = Int(obj["count"]?.doubleValue ?? 0)
        let items: [MailItem] = (obj["items"]?.arrayValue ?? []).compactMap { entry in
            guard let e = entry.objectValue, let subject = e["subject"]?.stringValue else { return nil }
            return MailItem(
                sender: e["sender"]?.stringValue ?? "",
                subject: subject,
                snippet: e["snippet"]?.stringValue ?? "",
                source: e["source"]?.stringValue ?? "external",
                suggestion: e["suggestion"]?.stringValue.flatMap(MailAction.init(rawValue:)))
        }
        return MailPayload(count: count, items: Array(items.prefix(3)), errored: false, errorReason: nil)
    }
}

struct MailWidget: View {
    let payload: MailPayload
    let isPresented: Bool
    /// Dispatched when a chip is tapped — the parent forwards it as a `ui.intent` (gate-routed).
    var onAction: ((MailAction, MailItem) -> Void)? = nil

    @State private var displayedCount: Int = 0

    var body: some View {
        content
            .kernelCard(isPresented: isPresented, maxWidth: 380)
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

    private var populated: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.md) {
            // "Inbox summary" header — blue marker + the tabular message count.
            CardHeader(dot: Tokens.catBlue, title: "Inbox summary") {
                Text("\(displayedCount)")
                    .font(Tokens.Typography.monoLabel)
                    .monospacedDigit()
                    .foregroundStyle(Tokens.textMuted)
            }

            VStack(alignment: .leading, spacing: Tokens.Space.md) {
                ForEach(payload.items) { item in mailRow(item) }
            }
        }
    }

    /// One mail row: sender + a source/urgent marker, the subject, a one-line snippet, then the
    /// suggested-action chips.
    private func mailRow(_ item: MailItem) -> some View {
        VStack(alignment: .leading, spacing: Tokens.Space.xs) {
            HStack(spacing: Tokens.Space.sm) {
                Text(item.sender)
                    .font(Tokens.Typography.label)
                    .foregroundStyle(Tokens.textSecondary)
                Spacer(minLength: Tokens.Space.sm)
                if item.source == "external" {
                    Text("external")
                        .font(Tokens.Typography.monoCaption)
                        .foregroundStyle(Tokens.textDim)
                        .padding(.horizontal, Tokens.Space.sm)
                        .frame(minHeight: 18)
                        .overlay(Capsule().stroke(Tokens.hairline, lineWidth: 1))
                }
            }
            Text(item.subject)
                .font(Tokens.Typography.body)
                .foregroundStyle(Tokens.textPrimary)
            Text(item.snippet)
                .font(Tokens.Typography.label)
                .foregroundStyle(Tokens.textMuted)
                .lineLimit(1)
            chips(for: item)
        }
    }

    /// Suggested-action chips. The active triage suggestion carries the accent ring;
    /// the rest are neutral. Min 28px height, 44px hit target (04-UI-SPEC §2).
    private func chips(for item: MailItem) -> some View {
        HStack(spacing: Tokens.Space.sm) {
            ForEach(MailAction.allCases) { action in
                let isActive = item.suggestion == action
                Button {
                    onAction?(action, item)
                } label: {
                    Text(action.label)
                        .font(Tokens.Typography.label)
                        .foregroundStyle(isActive ? Tokens.accentTerracotta : Tokens.textMuted)
                        .padding(.horizontal, Tokens.Space.md)
                        .frame(minHeight: 28)              // chip min height (§2)
                        .background(Tokens.chipFill, in: Capsule())
                        .overlay(
                            Capsule().stroke(
                                isActive ? Tokens.accentTerracotta : Tokens.hairline,
                                lineWidth: isActive ? 1.5 : 1))   // accent ring only when active
                }
                .buttonStyle(.plain)
                .frame(minWidth: 44, minHeight: 44, alignment: .center) // 44px hit target (§2)
            }
        }
    }

    private var emptyState: some View {
        Text("No unread.")
            .font(Tokens.Typography.heading)
            .foregroundStyle(Tokens.textPrimary)
    }

    private var errorState: some View {
        Text("Mail unavailable — \(payload.errorReason ?? "unknown").")
            .font(Tokens.Typography.heading)
            .foregroundStyle(Tokens.textPrimary)
    }

    private func startCountUp() {
        displayedCount = 0
        let target = payload.count
        guard target > 0 else { return }
        withAnimation(Motion.countUp) { displayedCount = target }
        let steps = max(1, min(target, 12))
        let interval = Motion.countUpDuration / Double(steps)
        for step in 1...steps {
            DispatchQueue.main.asyncAfter(deadline: .now() + interval * Double(step)) {
                displayedCount = Int(Double(target) * Double(step) / Double(steps))
            }
        }
    }
}
