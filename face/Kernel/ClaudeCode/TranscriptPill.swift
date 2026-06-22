import SwiftUI

/// The live Kernel↔Claude transcript shown inside the shipped corner pill (04-UI-SPEC §6; CC-02).
///
/// Reuses the `cornerPill` cloud state. When a Claude Code session runs, the cloud shrinks to the
/// top-left pill showing a LIVE, SCROLLABLE transcript of Kernel↔Claude — what KERNEL asks in the
/// first person, and what Claude is doing. Monospace-ish Label text, newest at bottom, auto-scroll
/// with manual scrollback. A subtle accent live-pulse dot indicates streaming; the owner can read
/// along, interject, or PAUSE (the pause control in the pill).
///
/// Renders ONLY the typed transcript text (T-04-19): no AsyncImage / URLRequest / WKWebView, no
/// auto-loading of any remote resource from session output. Defensive: an empty buffer renders a
/// quiet "Waiting…" line, never a crash.

/// One rendered transcript line (the Face-local view model of a `transcript` frame).
struct TranscriptLine: Identifiable, Equatable {
    /// The frame id (stable identity so a partial chunk updates rather than duplicates).
    let id: String
    let role: Frame.TranscriptRole
    var text: String
    /// True while this line is still streaming (a partial chunk); false once finalized.
    var partial: Bool
}

struct TranscriptPill: View {
    /// The buffered lines, oldest first (the coordinator owns the buffer; the pill renders it).
    let lines: [TranscriptLine]
    /// True while a partial chunk is in flight — drives the accent live-pulse dot.
    let isStreaming: Bool
    /// True when the owner has paused the stream (the pause control reflects this).
    let isPaused: Bool
    /// The pause control callback (toggles paused in the coordinator). Owner-driven.
    let onTogglePause: () -> Void

    /// Pulse phase for the streaming dot (eases, never snaps — Motion Law).
    @State private var pulse = false

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.xs) {
            header
            transcriptScroll
        }
        .frame(width: 280, height: 160, alignment: .topLeading)
        .padding(.horizontal, 12)                                  // 12px pill padding (UI-SPEC exception)
        .padding(.vertical, 8)
        .background(Tokens.denseMaterial, in: RoundedRectangle(cornerRadius: Tokens.Radius.pill))
        .overlay(
            RoundedRectangle(cornerRadius: Tokens.Radius.pill)
                .stroke(Tokens.hairline, lineWidth: 1))            // white-7% hairline
    }

    // MARK: Header (live-pulse dot + pause control)

    private var header: some View {
        HStack(spacing: Tokens.Space.sm) {
            // Accent live-pulse dot (UI-SPEC accent reserved use #5) — pulses while streaming.
            Circle()
                .fill(Tokens.accentCyan)
                .frame(width: 8, height: 8)
                .opacity(isStreaming ? (pulse ? 1.0 : 0.4) : 0.25)
                .animation(
                    isStreaming
                        ? Motion.focusRing.repeatForever(autoreverses: true)
                        : Motion.focusRing,
                    value: pulse)
                .onAppear { pulse = true }

            Text("Claude Code")
                .font(Tokens.Typography.label)
                .foregroundStyle(Tokens.textMuted)

            Spacer()

            // The pause control: owner can pause/resume the live stream.
            Button(action: onTogglePause) {
                Image(systemName: isPaused ? "play.fill" : "pause.fill")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Tokens.textMuted)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(isPaused ? "Resume transcript" : "Pause transcript")
        }
    }

    // MARK: Scrollable transcript (newest at bottom, auto-scroll with manual scrollback)

    private var transcriptScroll: some View {
        ScrollViewReader { proxy in
            ScrollView(.vertical, showsIndicators: true) {
                VStack(alignment: .leading, spacing: Tokens.Space.xs) {
                    if lines.isEmpty {
                        Text("Waiting…")
                            .font(Tokens.Typography.label)
                            .foregroundStyle(Tokens.textMuted)
                    } else {
                        ForEach(lines) { line in
                            lineView(line).id(line.id)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .onChange(of: lines.last?.id) { _, lastID in
                // Auto-scroll to newest while not paused; paused leaves the owner's scroll position.
                guard !isPaused, let lastID else { return }
                withAnimation(Motion.focusRing) { proxy.scrollTo(lastID, anchor: .bottom) }
            }
        }
    }

    /// One transcript row: a role prefix + the typed text (monospace-ish, structured only).
    private func lineView(_ line: TranscriptLine) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.xs) {
            Text(line.role == .kernel ? "› " : "· ")
                .font(.system(size: 13, weight: .semibold, design: .monospaced))
                .foregroundStyle(line.role == .kernel ? Tokens.accentIndigo : Tokens.textMuted)
            Text(line.text)
                .font(.system(size: 13, weight: .regular, design: .monospaced))
                .foregroundStyle(line.role == .kernel ? Tokens.textPrimary : Tokens.textMuted)
                .textSelection(.enabled)                           // owner can read along / copy
        }
    }
}
