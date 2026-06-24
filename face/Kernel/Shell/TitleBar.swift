import SwiftUI

/// The custom window titlebar — "Kernel — Personal Agent" centered, with a mono runtime readout
/// (active brain + a connection status dot) on the right. The native traffic lights float at the
/// top-left (the window uses `.hiddenTitleBar`), so the bar leaves room for them.
struct TitleBar: View {
    @ObservedObject var coordinator: AppCoordinator

    var body: some View {
        ZStack {
            // Centered wordmark — "Kernel" emphasized, "— Personal Agent" muted.
            HStack(spacing: 6) {
                Text("Kernel")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Tokens.textPrimary)
                Text("— Personal Agent")
                    .font(.system(size: 13, weight: .regular))
                    .foregroundStyle(Tokens.textMuted)
            }

            HStack {
                Spacer()
                runtimeReadout
            }
        }
        .frame(height: 38)
        .padding(.horizontal, Tokens.Space.md)
        .padding(.leading, 64)   // clear the native traffic lights at the top-left
        .background(Tokens.canvas.opacity(0.6))
        .overlay(alignment: .bottom) {
            Rectangle().fill(Tokens.hairline).frame(height: 1)
        }
    }

    /// `ollama · ● online` style readout — brain + a status dot, all monospaced.
    private var runtimeReadout: some View {
        HStack(spacing: 8) {
            Text(brainLabel)
                .font(Tokens.Typography.monoCaption)
                .foregroundStyle(Tokens.textMuted)
            Text("·")
                .font(Tokens.Typography.monoCaption)
                .foregroundStyle(Tokens.textDim)
            HStack(spacing: 5) {
                Circle()
                    .fill(statusColor)
                    .frame(width: 7, height: 7)
                Text(statusLabel)
                    .font(Tokens.Typography.monoCaption)
                    .foregroundStyle(Tokens.textMuted)
            }
        }
    }

    private var brainLabel: String {
        coordinator.capabilities?.brainLabel ?? (coordinator.brain == .local ? "ollama" : "claude")
    }

    private var statusColor: Color {
        switch coordinator.connection {
        case .connected: return Tokens.statusGreen
        case .connecting: return Tokens.accentAmber
        case .idle, .failed: return Tokens.textDim
        }
    }

    private var statusLabel: String {
        switch coordinator.connection {
        case .connected: return "online"
        case .connecting: return "linking…"
        case .idle: return "idle"
        case .failed: return "offline"
        }
    }
}
