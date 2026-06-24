import SwiftUI

/// The Red-tier circuit-breaker dry-run preview card (KERNEL_MASTER_BUILD_PROMPT §8 / §15; SAFE-03).
///
/// When a Red action enters the breaker the daemon broadcasts a `breaker.preview` frame; this glass
/// card surfaces WHAT would happen (the dry-run summary), the tier, and the spend impact (if any),
/// then gives Pravin a visible 10-SECOND countdown with ONE accent **Cancel** control. Tapping
/// Cancel emits a `breaker.cancel{id}` frame (the daemon flips the breaker's cancel latch and the
/// pending action aborts WITHOUT executing). The card auto-dismisses when the window elapses or when
/// a cancel/audit resolution arrives (the coordinator clears the active preview).
///
/// §15 glass: regular-material body, hairline border, ONE accent reserved for the active control
/// (Cancel) and the countdown ring. Renders ONLY typed fields — no remote-resource load.

/// The Face-local view model of a `breaker.preview` frame (decoded by the coordinator).
struct BreakerPreview: Identifiable, Equatable {
    /// The correlation id — the matching `breaker.cancel{id}` carries it back to the daemon.
    let id: String
    /// Human-readable dry-run summary: what would happen, to whom, why.
    let summary: String
    /// Estimated spend (0 for non-financial Red ops). Shown to the owner; never audit-logged.
    let estimatedSpend: Double
}

struct BreakerPreviewCard: View {
    let preview: BreakerPreview
    let isPresented: Bool
    /// The total cancel window in seconds (spec §8 = 10s). Injectable so tests run without waiting.
    var windowSeconds: Int = 10
    /// The ONLY cancel path: tapping Cancel invokes this so the parent emits `breaker.cancel{id}`.
    var onCancel: ((BreakerPreview) -> Void)? = nil
    /// Fired when the countdown reaches 0 (the window elapsed with no cancel — the action proceeds).
    var onElapsed: ((BreakerPreview) -> Void)? = nil

    /// Seconds remaining in the cancel window; counts down to 0, then the card calls onElapsed.
    @State private var remaining: Int = 10
    /// True once the owner tapped Cancel — freezes the countdown + shows the cancelled confirmation.
    @State private var didCancel = false

    /// One-second tick driving the visible countdown.
    private let ticker = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        content
            .kernelCard(isPresented: isPresented, maxWidth: 420)
            .onAppear { remaining = windowSeconds }
            .onReceive(ticker) { _ in tick() }
    }

    @ViewBuilder
    private var content: some View {
        if didCancel {
            Text("Cancelled. Nothing ran.")
                .font(Tokens.Typography.heading)
                .foregroundStyle(Tokens.textPrimary)
        } else {
            populated
        }
    }

    private var populated: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.md) {
            // Tier marker — a Red action is gated; the accent-ringed marker says so plainly.
            HStack(spacing: Tokens.Space.sm) {
                Text("Red action")
                    .font(Tokens.Typography.label)
                    .foregroundStyle(Tokens.accentTerracotta)
                    .padding(.horizontal, Tokens.Space.sm)
                    .frame(minHeight: 22)
                    .overlay(Capsule().stroke(Tokens.accentTerracotta, lineWidth: 1))
                Spacer()
                countdown
            }
            // The dry-run summary: what would happen.
            Text(preview.summary)
                .font(Tokens.Typography.body)
                .foregroundStyle(Tokens.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            // Spend impact, only when this Red op costs money.
            if preview.estimatedSpend > 0 {
                Text("Estimated spend: \(spendString)")
                    .font(Tokens.Typography.label)
                    .foregroundStyle(Tokens.textMuted)
            }
            controls
        }
    }

    /// The visible 10-second countdown — a draining terracotta ring around the seconds remaining.
    private var countdown: some View {
        HStack(spacing: Tokens.Space.sm) {
            ZStack {
                Circle()
                    .stroke(Tokens.chipFill, lineWidth: 3)
                Circle()
                    .trim(from: 0, to: CGFloat(max(0, remaining)) / CGFloat(max(windowSeconds, 1)))
                    .stroke(Tokens.accentTerracotta, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .animation(.linear(duration: 1), value: remaining)
                Text("\(remaining)")
                    .font(Tokens.Typography.monoEmphasis)
                    .monospacedDigit()
                    .foregroundStyle(Tokens.textSecondary)
            }
            .frame(width: 34, height: 34)
            Text("to cancel")
                .font(Tokens.Typography.label)
                .foregroundStyle(Tokens.textMuted)
        }
    }

    /// Exactly one control: Cancel (the single accent-filled CTA — §15 accent reserved for the
    /// active control). There is NO "proceed" button: the locked SAFE-03 default is to proceed
    /// when the window elapses, so the owner only ever needs to cancel.
    private var controls: some View {
        Button {
            guard !didCancel else { return }
            didCancel = true
            onCancel?(preview)
        } label: {
            Text("Cancel")
                .font(Tokens.Typography.body)
                .foregroundStyle(Tokens.canvas)
                .padding(.horizontal, Tokens.Space.lg)
                .frame(minHeight: 44)
                .background(Capsule().fill(Tokens.accentTerracotta))   // accent-filled CTA
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Cancel the Red action")
    }

    private var spendString: String {
        let n = preview.estimatedSpend
        return n == n.rounded() ? String(Int(n)) : String(format: "%.2f", n)
    }

    /// One countdown tick. Stops at 0 and fires onElapsed exactly once (unless already cancelled).
    private func tick() {
        guard !didCancel else { return }
        if remaining > 0 {
            remaining -= 1
            if remaining == 0 { onElapsed?(preview) }
        }
    }
}
