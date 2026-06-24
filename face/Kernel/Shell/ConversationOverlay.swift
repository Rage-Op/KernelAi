import SwiftUI

/// The on-screen conversation — the YOU / KERNEL lines that float on the stage as you talk (the
/// design's ss3/ss4). Renders the most recent few lines, oldest fading, newest fully lit. Distinct
/// from the Claude Code transcript pill; this is the main owner↔KERNEL dialogue.
struct ConversationOverlay: View {
    let lines: [ConversationLine]

    /// How many recent lines to keep on the stage at once.
    private let visible = 5

    var body: some View {
        let recent = Array(lines.suffix(visible))
        VStack(alignment: .leading, spacing: Tokens.Space.md) {
            ForEach(Array(recent.enumerated()), id: \.element.id) { idx, line in
                lineView(line)
                    .opacity(opacity(idx, of: recent.count))
            }
        }
        .frame(maxWidth: 380, alignment: .leading)
        .animation(Motion.cloudState, value: lines.count)
    }

    private func lineView(_ line: ConversationLine) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(line.role == .you ? "YOU" : "KERNEL")
                .font(Tokens.Typography.monoCaption)
                .tracking(2)
                .foregroundStyle(line.role == .you ? Tokens.textDim : Tokens.accentTerracotta)
            Text(line.text)
                .font(Tokens.Typography.body)
                .foregroundStyle(line.role == .you ? Tokens.textMuted : Tokens.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// Oldest line dim, newest full — a gentle recency fade.
    private func opacity(_ index: Int, of count: Int) -> Double {
        guard count > 1 else { return 1 }
        return 0.35 + 0.65 * (Double(index) / Double(count - 1))
    }
}
