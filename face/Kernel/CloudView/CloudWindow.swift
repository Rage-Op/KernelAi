import SwiftUI

/// The deep spatial-black canvas hosting the living cloud (CLOUD-02/05).
///
/// Task 2 establishes the full-screen canvas + the cloud. Task 3 adds the
/// full-screen ↔ corner-pill scene switch and the bloomed widget layer; the
/// scaffolding for both scene states already lives here so the switch is a
/// spring transition, never a hard cut (Motion Law).
struct CloudWindow: View {
    @ObservedObject var coordinator: AppCoordinator

    var body: some View {
        ZStack {
            // Layer 0: the spatial-black canvas (UI-SPEC dominant 60%).
            Tokens.canvas.ignoresSafeArea()

            switch coordinator.scene {
            case .fullscreen, .idle:
                fullScreenCloud
            case .cornerPill:
                cornerPillCloud
            }
        }
        .animation(Motion.cloudState, value: coordinator.scene)
    }

    // MARK: Full-screen state (boot / speaking) — Task 3 layers widgets on top.

    private var fullScreenCloud: some View {
        CloudCanvas(state: coordinator.cloud)
            .ignoresSafeArea()
            .transition(.opacity)
    }

    // MARK: Corner pill (Task 3 fleshes out the migration + transcript).

    private var cornerPillCloud: some View {
        VStack {
            HStack {
                CloudCanvas(state: coordinator.cloud, particleCount: ParticleRenderer.minCount)
                    .frame(width: 220, height: 120)
                    .clipShape(RoundedRectangle(cornerRadius: Tokens.Radius.pill))
                    .overlay(
                        RoundedRectangle(cornerRadius: Tokens.Radius.pill)
                            .stroke(Tokens.hairline, lineWidth: 1))
                    .padding(.top, 16)
                    .padding(.leading, 16)
                Spacer()
            }
            Spacer()
        }
    }
}
