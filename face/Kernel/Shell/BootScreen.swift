import SwiftUI

/// The boot / runtime-status screen (the design's first frame): a small living orb, the KERNEL
/// wordmark, and a monospaced status list rendered from the daemon's `capabilities` + model warm-up.
///
/// BRAIN-07: the window holds here until the MODEL is loaded and ready (`coordinator.modelReady`) —
/// so the owner's first prompt is never a cold start. It is never STUCK: on a load error it shows the
/// reason + Retry + "Continue anyway", and a dim "Continue anyway" also appears after a few seconds of
/// loading. `onContinue` forces the reveal (plug-and-play: a dead/headless daemon still lets you in).
struct BootScreen: View {
    @ObservedObject var coordinator: AppCoordinator
    /// Force-reveal the live stage (the fail-safe escape from the boot gate).
    var onContinue: () -> Void

    /// After a few seconds of loading, surface a dim escape so the owner is never trapped.
    @State private var showEscape = false

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
            controls
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(Tokens.Space.xxl)
        .task {
            try? await Task.sleep(nanoseconds: 6_000_000_000)
            showEscape = true
        }
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
            modelRow
            if let caps = coordinator.capabilities {
                statusRow("Tool bridge", value: "\(caps.tools.count) connected", ok: !caps.tools.isEmpty)
                statusRow("Context", value: "\(TelemetryFormat.commas(caps.injectCap)) chars", ok: true)
            }
        }
        .frame(width: 320)
    }

    /// The model warm-up row: a spinner + the live detail while loading, green when ready, red on error.
    private var modelRow: some View {
        HStack {
            switch coordinator.modelStatus {
            case .ready:
                Circle().fill(Tokens.statusGreen).frame(width: 7, height: 7)
            case .error:
                Circle().fill(Tokens.statusRed).frame(width: 7, height: 7)
            case .loading:
                ProgressView().controlSize(.mini).tint(Tokens.accentTerracotta)
            }
            Text("Model")
                .font(Tokens.Typography.mono)
                .foregroundStyle(Tokens.textSecondary)
            Spacer()
            Text(modelValue)
                .font(Tokens.Typography.mono)
                .foregroundStyle(modelColor)
                .lineLimit(1)
                .truncationMode(.tail)
        }
    }

    /// Retry / Continue affordances so the boot gate is never a dead end.
    @ViewBuilder private var controls: some View {
        if coordinator.modelStatus == .error {
            VStack(spacing: Tokens.Space.sm) {
                Text(coordinator.modelDetail)
                    .font(Tokens.Typography.label)
                    .foregroundStyle(Tokens.statusRed)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: Tokens.Space.lg) {
                    Button("Retry") { coordinator.retryModelLoad() }
                        .buttonStyle(.plain).foregroundStyle(Tokens.accentBright)
                    Button("Continue anyway") { onContinue() }
                        .buttonStyle(.plain).foregroundStyle(Tokens.textMuted)
                }
                .font(Tokens.Typography.monoLabel)
            }
            .frame(width: 320)
            .padding(.top, Tokens.Space.sm)
        } else if showEscape {
            Button("Continue anyway →") { onContinue() }
                .buttonStyle(.plain)
                .font(Tokens.Typography.monoLabel)
                .foregroundStyle(Tokens.textDim)
                .padding(.top, Tokens.Space.sm)
        }
    }

    private var modelValue: String {
        switch coordinator.modelStatus {
        case .ready: return coordinator.modelName.map { "\($0) · ready" } ?? "ready"
        case .error: return "unavailable"
        case .loading: return coordinator.modelDetail
        }
    }

    private var modelColor: Color {
        switch coordinator.modelStatus {
        case .ready: return Tokens.statusGreen
        case .error: return Tokens.statusRed
        case .loading: return Tokens.textMuted
        }
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
