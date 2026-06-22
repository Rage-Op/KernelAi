import SwiftUI

/// Stable bundle identity for the Face. TCC grants (mic, later accessibility)
/// are bound to this id + signature + on-disk path, so it MUST NOT churn
/// across rebuilds (Pitfall 4). Mirrors PRODUCT_BUNDLE_IDENTIFIER in project.yml.
enum KernelBundle {
    static let identifier = "com.kernel.face"
    static let displayName = "Kernel"
}

/// The KERNEL Face: a single menubar-only SwiftUI app (CLOUD-01 surface).
///
/// This is the SHELL. Wave 1 (03-03) ships the menubar presence + the
/// on-device boundary spike trigger. The full cloud window, the NWConnection
/// UDS client, and SMAppService launch-at-login land in 03-04 (CLOUD-01/05),
/// gated on the SPIKE-VERDICT this plan produces.
@main
struct KernelApp: App {
    /// Retained for the lifetime of the app so its delegate callbacks fire
    /// (a local-var synthesizer never fires its delegate — Apple Forums 683471).
    /// Wired by the boundary spike (03-03 Task 2).
    @StateObject private var spike = BoundarySpike()

    var body: some Scene {
        MenuBarExtra("Kernel", systemImage: "circle.dotted") {
            MenuBarContent(spike: spike)
        }
        .menuBarExtraStyle(.window)
    }
}

/// The menubar dropdown panel. In 03-04 this gains the brain toggle, the
/// launch-at-login switch, and connection state. For Wave 1 it carries the
/// owner-triggerable boundary spike control (the gating manual check).
struct MenuBarContent: View {
    @ObservedObject var spike: BoundarySpike

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.md) {
            HStack(spacing: Tokens.Space.sm) {
                Circle()
                    .fill(
                        LinearGradient(
                            colors: [Tokens.accentIndigo, Tokens.accentCyan],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                    .frame(width: 10, height: 10)
                Text(KernelBundle.displayName)
                    .font(.headline)
            }

            Divider()

            Button {
                spike.run()
            } label: {
                Label(
                    spike.isSpeaking ? "Speaking…" : "Run boundary spike",
                    systemImage: "waveform"
                )
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
        .frame(width: 260)
    }
}
