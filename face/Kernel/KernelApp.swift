import SwiftUI

/// Stable bundle identity for the Face. TCC grants (mic, later accessibility)
/// are bound to this id + signature + on-disk path, so it MUST NOT churn
/// across rebuilds (Pitfall 4). Mirrors PRODUCT_BUNDLE_IDENTIFIER in project.yml.
enum KernelBundle {
    static let identifier = "com.kernel.face"
    static let displayName = "Kernel"
}

/// The KERNEL Face: a menubar-only SwiftUI app plus the cloud Window (CLOUD-01/05).
///
/// 03-04 wires the full Face: the AppCoordinator owns the cloud, the dual-paced
/// Stage, the retained-synth Speaker, the Face-local MicEngine, and the
/// NWConnection UDS client; the CloudWindow renders the living Metal cloud and
/// switches between full-screen and the corner pill on a `ui.state` frame.
@main
struct KernelApp: App {
    @StateObject private var coordinator = AppCoordinator()
    /// The boundary spike trigger remains available for the owner's manual re-run
    /// (SPIKE-VERDICT.md §"Manual owner re-run").
    @StateObject private var spike = BoundarySpike()

    var body: some Scene {
        // The cloud canvas (CLOUD-02). Full-screen ↔ corner-pill states animate inside.
        Window("Kernel", id: "cloud") {
            CloudWindow(coordinator: coordinator)
                .frame(minWidth: 480, minHeight: 320)
                .background(Tokens.canvas)
                .onAppear { coordinator.start() }
        }
        .windowStyle(.hiddenTitleBar)

        MenuBarExtra("Kernel", systemImage: "circle.dotted") {
            MenuBarContent(coordinator: coordinator, spike: spike)
        }
        .menuBarExtraStyle(.window)
    }
}

/// The menubar dropdown panel: accent dot, connection state, the launch-at-login
/// toggle (CLOUD-01), and the owner-triggerable boundary spike control.
struct MenuBarContent: View {
    @ObservedObject var coordinator: AppCoordinator
    @ObservedObject var spike: BoundarySpike

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.md) {
            HStack(spacing: Tokens.Space.sm) {
                Circle()
                    .fill(
                        LinearGradient(
                            colors: [Tokens.accentIndigo, Tokens.accentCyan],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing))
                    .frame(width: 10, height: 10)
                Text(KernelBundle.displayName)
                    .font(.headline)
                Spacer()
                Text(connectionLabel)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Divider()

            Toggle("Launch at login", isOn: Binding(
                get: { coordinator.launchAtLogin },
                set: { coordinator.setLaunchAtLogin($0) }))

            Divider()

            Button {
                spike.run()
            } label: {
                Label(
                    spike.isSpeaking ? "Speaking…" : "Run boundary spike",
                    systemImage: "waveform")
            }
            .disabled(spike.isSpeaking)

            if !spike.lastRanges.isEmpty {
                Text("\(spike.lastRanges.count) boundary callback(s) logged")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Divider()

            Button("Quit Kernel") {
                NSApplication.shared.terminate(nil)
            }
            .keyboardShortcut("q")
        }
        .padding(Tokens.Space.lg)
        .frame(width: 280)
    }

    private var connectionLabel: String {
        switch coordinator.connection {
        case .idle: return "idle"
        case .connecting: return "connecting…"
        case .connected: return "connected"
        case .failed: return "offline"
        }
    }
}
