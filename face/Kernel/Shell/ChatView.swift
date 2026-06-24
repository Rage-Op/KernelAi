import SwiftUI

/// The Chat page: a scrollable, PERSISTED transcript + its own input bar. It shows the durable
/// history the daemon sends on connect (`chatHistory`) followed by this session's live turns
/// (`conversationLines`) — so the conversation survives restarts, which is what the owner asked for.
/// New / clear starts a fresh conversation (the daemon writes a /clear sentinel; history is kept).
struct ChatView: View {
    @ObservedObject var coordinator: AppCoordinator

    /// Persisted history (older) followed by this session's live turns (newer).
    private var allLines: [ConversationLine] { coordinator.chatHistory + coordinator.conversationLines }

    var body: some View {
        VStack(spacing: 0) {
            header
            Rectangle().fill(Tokens.hairline).frame(height: 1)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: Tokens.Space.lg) {
                        if allLines.isEmpty { emptyState }
                        ForEach(allLines) { line in bubble(line).id(line.id) }
                        Color.clear.frame(height: 1).id("chat-bottom")
                    }
                    .padding(Tokens.Space.xl)
                    .frame(maxWidth: 760, alignment: .leading)
                    .frame(maxWidth: .infinity, alignment: .center)
                }
                .onChange(of: coordinator.conversationLines.count) { _, _ in
                    withAnimation(Motion.cloudState) { proxy.scrollTo("chat-bottom", anchor: .bottom) }
                }
                .onChange(of: coordinator.chatHistory.count) { _, _ in
                    proxy.scrollTo("chat-bottom", anchor: .bottom)
                }
            }
            MessageBar(coordinator: coordinator)
                .frame(maxWidth: 760)
                .padding(.horizontal, Tokens.Space.xl)
                .padding(.vertical, Tokens.Space.lg)
        }
        .background(Tokens.canvas)
    }

    private var header: some View {
        HStack {
            Text("CHAT")
                .font(Tokens.Typography.monoCaption).tracking(2).foregroundStyle(Tokens.textDim)
            Spacer()
            Button { coordinator.clearConversation() } label: {
                Label("New", systemImage: "square.and.pencil").font(Tokens.Typography.label)
            }
            .buttonStyle(.plain)
            .foregroundStyle(Tokens.textMuted)
            .help("Start a fresh conversation")
        }
        .padding(.horizontal, Tokens.Space.xl)
        .padding(.vertical, Tokens.Space.md)
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.md) {
            Text("Talk to KERNEL")
                .font(Tokens.Typography.heading).foregroundStyle(Tokens.textSecondary)
            Text("KERNEL uses tools when it helps. Try one of these:")
                .font(Tokens.Typography.label).foregroundStyle(Tokens.textMuted)
            ForEach(ChatStarters.all, id: \.self) { starter in
                Button { coordinator.sendUtterance(starter) } label: {
                    HStack(spacing: Tokens.Space.sm) {
                        Image(systemName: "arrow.up.right").font(.system(size: 11))
                        Text(starter).font(Tokens.Typography.body)
                    }
                    .foregroundStyle(Tokens.accentBright)
                    .padding(.horizontal, Tokens.Space.md)
                    .padding(.vertical, Tokens.Space.sm)
                    .background(Tokens.chipFill, in: RoundedRectangle(cornerRadius: Tokens.Radius.chip))
                }
                .buttonStyle(.plain)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, Tokens.Space.xxl)
    }

    private func bubble(_ line: ConversationLine) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(line.role == .you ? "YOU" : "KERNEL")
                .font(Tokens.Typography.monoCaption).tracking(2)
                .foregroundStyle(line.role == .you ? Tokens.textDim : Tokens.accentTerracotta)
            Text(line.text.isEmpty ? "…" : line.text)
                .font(Tokens.Typography.body)
                .foregroundStyle(line.role == .you ? Tokens.textSecondary : Tokens.textPrimary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Suggested opening prompts — surfaced in the Chat empty-state and the Settings → Tools section so
/// the owner can learn what KERNEL can do and how its tools get used.
enum ChatStarters {
    static let all = [
        "What's the latest news about Apple?",
        "How much did I spend this month?",
        "Summarize my unread email.",
        "What's on my calendar today?",
    ]
}
