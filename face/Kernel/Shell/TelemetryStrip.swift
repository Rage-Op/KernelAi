import SwiftUI

/// The always-on telemetry strip — KERNEL's "like Claude" runtime readout, visible at all times:
/// throughput (tok/s), context-window fill, estimated inference cost, the active model, and a
/// running session token total. Fed by the daemon's `stats` + `capabilities` frames; shows tasteful
/// "—" placeholders before the first measured turn.
struct TelemetryStrip: View {
    @ObservedObject var coordinator: AppCoordinator

    var body: some View {
        HStack(spacing: Tokens.Space.md) {
            // Live local-server (Ollama) health — ● ready / loading / error, from model.state.
            ollamaStatus
            dot
            // Throughput — the value already carries the "tok/s" unit, so no separate label.
            Text(TelemetryFormat.tokensPerSec(coordinator.lastStats?.tokensPerSec))
                .foregroundStyle(Tokens.textSecondary)
            dot
            contextMetric
            dot
            metric(label: "cost", value: TelemetryFormat.cost(coordinator.lastStats?.estCostUsd))
            dot
            metric(label: "model", value: modelLabel)
            Spacer(minLength: Tokens.Space.md)
            sessionTotal
        }
        .font(Tokens.Typography.monoCaption)
        .padding(.horizontal, Tokens.Space.lg)
        .padding(.vertical, Tokens.Space.sm)
        .background(Tokens.canvasDeep.opacity(0.5))
        .overlay(alignment: .top) { Rectangle().fill(Tokens.hairline).frame(height: 1) }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilitySummary)
    }

    private var dot: some View {
        Text("·").foregroundStyle(Tokens.textDim)
    }

    /// Live local-server health: a coloured dot + "ollama" (or "claude" for the cloud brain).
    /// Green = model loaded & ready, amber = warming up, red = down / model missing. Sourced from
    /// the daemon's `model.state` so it reflects the REAL Ollama state, not a guess.
    private var ollamaStatus: some View {
        let (color, label): (Color, String) = {
            if coordinator.brain == .cloud { return (Tokens.statusGreen, "claude") }
            switch coordinator.modelStatus {
            case .ready: return (Tokens.statusGreen, "ollama")
            case .loading: return (Tokens.accentAmber, "ollama")
            case .error: return (Tokens.statusRed, "ollama")
            }
        }()
        return HStack(spacing: 5) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text(label).foregroundStyle(Tokens.textDim)
        }
        .help(coordinator.modelDetail)
    }

    /// A `label value` pair: dim label, brighter mono value.
    private func metric(label: String, value: String) -> some View {
        HStack(spacing: 5) {
            Text(label).foregroundStyle(Tokens.textDim)
            Text(value).foregroundStyle(Tokens.textSecondary)
        }
    }

    /// Context: a small terracotta fill bar + percent + window size.
    private var contextMetric: some View {
        let used = coordinator.lastStats?.promptTokens
        let window = coordinator.lastStats?.contextWindow
        let fill = TelemetryFormat.contextFill(used: used, window: window)
        return HStack(spacing: 6) {
            Text("ctx").foregroundStyle(Tokens.textDim)
            ZStack(alignment: .leading) {
                Capsule().fill(Tokens.chipFill).frame(width: 44, height: 5)
                Capsule()
                    .fill(Tokens.accentTerracotta)
                    .frame(width: 44 * CGFloat(fill?.fraction ?? 0), height: 5)
            }
            Text(fill?.label ?? "—").foregroundStyle(Tokens.textSecondary)
            Text(TelemetryFormat.windowLabel(window)).foregroundStyle(Tokens.textDim)
        }
    }

    private var sessionTotal: some View {
        HStack(spacing: 5) {
            Text("Σ").foregroundStyle(Tokens.textDim)
            Text("\(TelemetryFormat.commas(coordinator.usage.totalTokens)) tok")
                .foregroundStyle(Tokens.textMuted)
        }
        .opacity(coordinator.usage.turns > 0 ? 1 : 0.4)
    }

    private var modelLabel: String {
        coordinator.lastStats?.model
            ?? coordinator.capabilities?.brainLabel
            ?? (coordinator.brain == .local ? "ollama" : "claude")
    }

    private var accessibilitySummary: String {
        "Telemetry: \(TelemetryFormat.tokensPerSec(coordinator.lastStats?.tokensPerSec)), "
            + "cost \(TelemetryFormat.cost(coordinator.lastStats?.estCostUsd)), "
            + "\(TelemetryFormat.commas(coordinator.usage.totalTokens)) tokens this session."
    }
}
