import SwiftUI

/// The boot / runtime-status screen (the design's first frame): a small living orb, the KERNEL
/// wordmark, and a monospaced status list rendered from the daemon's `capabilities`. Shown until
/// the daemon introduces itself; then the window springs to the live sphere stage.
struct BootScreen: View {
    @ObservedObject var coordinator: AppCoordinator

    var body: some View {
        VStack(spacing: Tokens.Space.lg) {
            orb
            VStack(spacing: Tokens.Space.sm) {
                Text("KERNEL")
                    .font(Tokens.Typography.wordmark)
                    .tracking(12)
                    .foregroundStyle(Tokens.textPrimary)
                Text("PERSONAL AGENT RUNTIME")
                    .font(Tokens.Typography.monoCaption)
                    .tracking(4)
                    .foregroundStyle(Tokens.textMuted)
            }
            Rectangle()
                .fill(Tokens.accentTerracotta)
                .frame(width: 120, height: 2)
                .padding(.vertical, Tokens.Space.sm)
            statusList
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(Tokens.Space.xxl)
    }

    /// A small instance of the living sphere — alive even at rest (idle breath).
    private var orb: some View {
        CloudCanvas(state: coordinator.cloud, particleCount: ParticleRenderer.minCount)
            .frame(width: 150, height: 150)
            .clipShape(Circle())
            .overlay(Circle().stroke(Tokens.accentTerracotta.opacity(0.5), lineWidth: 1))
            .shadow(color: Tokens.accentTerracotta.opacity(0.35), radius: 24)
    }

    /// Monospaced status rows — only fields KERNEL actually reports (no fabricated data).
    private var statusList: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.sm) {
            statusRow("Local server", value: serverStatus, ok: coordinator.connection == .connected)
            if let caps = coordinator.capabilities {
                statusRow("Brain", value: "\(caps.brainLabel) loaded", ok: true)
                statusRow("Tool bridge", value: "\(caps.tools.count) connected", ok: !caps.tools.isEmpty)
                statusRow("Context", value: "\(TelemetryFormat.commas(caps.injectCap)) chars", ok: true)
            } else {
                statusRow("Brain", value: "starting…", ok: false)
            }
        }
        .frame(width: 300)
    }

    private func statusRow(_ label: String, value: String, ok: Bool) -> some View {
        HStack {
            Circle()
                .fill(ok ? Tokens.statusGreen : Tokens.textDim)
                .frame(width: 7, height: 7)
            Text(label)
                .font(Tokens.Typography.mono)
                .foregroundStyle(Tokens.textSecondary)
            Spacer()
            Text(value)
                .font(Tokens.Typography.mono)
                .foregroundStyle(ok ? Tokens.statusGreen : Tokens.textMuted)
        }
    }

    private var serverStatus: String {
        switch coordinator.connection {
        case .connected: return "online"
        case .connecting: return "linking…"
        case .idle: return "idle"
        case .failed: return "offline"
        }
    }
}
