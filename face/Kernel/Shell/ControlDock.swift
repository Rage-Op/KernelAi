import SwiftUI

/// The persistent control dock — the owner's always-available controls (the design's bottom bar):
/// mic (listen), pause (interrupt speech), restart (clear the local conversation), a runtime panel,
/// and settings. A horizontal pill of circular buttons; the accent fills ONLY the active control.
struct ControlDock: View {
    @ObservedObject var coordinator: AppCoordinator
    @State private var showRuntime = false
    @State private var showSettings = false

    var body: some View {
        HStack(spacing: Tokens.Space.md) {
            micButton
            circle(system: coordinator.isSpeaking ? "pause.fill" : "play.fill",
                   active: false,
                   label: coordinator.isSpeaking ? "Pause speech" : "Idle") {
                coordinator.interruptSpeech()
            }
            circle(system: "arrow.counterclockwise", active: false, label: "Clear conversation") {
                coordinator.clearConversation()
            }
            circle(system: "square.grid.2x2", active: showRuntime, label: "Runtime detail") {
                showRuntime.toggle()
            }
            .popover(isPresented: $showRuntime, arrowEdge: .top) {
                RuntimePanel(coordinator: coordinator)
            }
            circle(system: "gearshape", active: showSettings, label: "Settings") {
                showSettings.toggle()
            }
            .popover(isPresented: $showSettings, arrowEdge: .top) {
                SettingsPanel(coordinator: coordinator)
            }
            circle(system: "folder", active: false, label: "View brain directory") {
                coordinator.revealBrainDirectory()
            }
        }
        .padding(.horizontal, Tokens.Space.md)
        .padding(.vertical, Tokens.Space.sm)
        .background(Tokens.surface.opacity(0.9), in: Capsule())
        .overlay(Capsule().stroke(Tokens.hairline, lineWidth: 1))
    }

    /// PUSH-TO-TALK: hold to speak, release to send. The mic gets the only accent fill (it's the
    /// primary "talk to me" affordance) and swells while held. A press-drag gesture gives true
    /// hold semantics — KERNEL listens only while your finger is down, never all the time.
    private var micButton: some View {
        Image(systemName: "mic.fill")
            .font(.system(size: 15, weight: .medium))
            .foregroundStyle(coordinator.isListening ? Tokens.canvas : Tokens.textSecondary)
            .frame(width: 42, height: 42)
            .background(Circle().fill(coordinator.isListening ? Tokens.accentTerracotta : Tokens.chipFill))
            .scaleEffect(coordinator.isListening ? 1.1 : 1.0)
            .animation(Motion.focusRing, value: coordinator.isListening)
            .contentShape(Circle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in if !coordinator.isListening { coordinator.beginListening() } }
                    .onEnded { _ in coordinator.endListening() })
            .accessibilityLabel("Hold to talk")
    }

    private func circle(system: String, active: Bool, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: system)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(active ? Tokens.canvas : Tokens.textSecondary)
                .frame(width: 42, height: 42)
                .background(
                    Circle().fill(active ? Tokens.accentTerracotta : Tokens.chipFill))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

/// The runtime-detail popover (the grid button): what KERNEL is + can do, from `capabilities`.
private struct RuntimePanel: View {
    @ObservedObject var coordinator: AppCoordinator

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.md) {
            Text("RUNTIME")
                .font(Tokens.Typography.monoCaption)
                .tracking(2)
                .foregroundStyle(Tokens.textDim)

            if let caps = coordinator.capabilities {
                row("brain", caps.brainLabel)
                row("daemon", "\(caps.daemon) v\(caps.version)")
                row("context", "\(TelemetryFormat.commas(caps.injectCap)) chars")
                row("tools", "\(caps.tools.count) connected")
                if !caps.tools.isEmpty {
                    Text(caps.tools.joined(separator: " · "))
                        .font(Tokens.Typography.monoCaption)
                        .foregroundStyle(Tokens.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if !caps.integrations.isEmpty {
                    row("hands", caps.integrations.joined(separator: " · "))
                }
            } else {
                Text("Waiting for the daemon…")
                    .font(Tokens.Typography.mono)
                    .foregroundStyle(Tokens.textMuted)
            }

            // LAST TURN — live runtime detail: model speed, tokens, latency, and model-load time
            // (a non-zero load means the model just (re)loaded into memory — the "warming up" cost).
            if let s = coordinator.lastStats {
                Divider().overlay(Tokens.hairline).padding(.vertical, Tokens.Space.xs)
                Text("LAST TURN")
                    .font(Tokens.Typography.monoCaption).tracking(2).foregroundStyle(Tokens.textDim)
                if let tps = s.tokensPerSec { row("speed", String(format: "%.1f tok/s", tps)) }
                row("tokens", "\(s.promptTokens ?? 0) in · \(s.outputTokens ?? 0) out")
                if let ms = s.totalMs { row("latency", String(format: "%.0f ms", ms)) }
                if let load = s.loadMs, load > 1 { row("model load", String(format: "%.1f s", load / 1000)) }
            }
            if let activity = coordinator.toolActivity {
                row("tool", activity)
            }
        }
        .padding(Tokens.Space.lg)
        .frame(width: 300, alignment: .leading)
        .background(Tokens.surface)
    }

    private func row(_ key: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(key).font(Tokens.Typography.monoCaption).foregroundStyle(Tokens.textDim)
            Spacer()
            Text(value).font(Tokens.Typography.monoLabel).foregroundStyle(Tokens.textSecondary)
        }
    }
}

/// The settings popover (the gear): brain toggle + launch-at-login — the same controls the menubar
/// exposes, surfaced in-window.
private struct SettingsPanel: View {
    @ObservedObject var coordinator: AppCoordinator

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.md) {
            Text("SETTINGS")
                .font(Tokens.Typography.monoCaption)
                .tracking(2)
                .foregroundStyle(Tokens.textDim)

            VStack(alignment: .leading, spacing: Tokens.Space.sm) {
                Text("Brain").font(Tokens.Typography.label).foregroundStyle(Tokens.textMuted)
                Picker("Brain", selection: $coordinator.brain) {
                    Text("Cloud").tag(Frame.Brain.cloud)
                    Text("Local").tag(Frame.Brain.local)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .onChange(of: coordinator.brain) { _, newBrain in
                    coordinator.persistAndSendBrain(newBrain)
                }
            }

            Toggle("Launch at login", isOn: Binding(
                get: { coordinator.launchAtLogin },
                set: { coordinator.setLaunchAtLogin($0) }))
                .font(Tokens.Typography.label)
                .foregroundStyle(Tokens.textSecondary)
        }
        .padding(Tokens.Space.lg)
        .frame(width: 260, alignment: .leading)
        .background(Tokens.surface)
    }
}
