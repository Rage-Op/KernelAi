import SwiftUI

/// The deep spatial-black canvas hosting the living cloud + the bloomed widgets
/// (CLOUD-02/04/05).
///
/// Two states, one element (CLOUD-05): full-screen (boot/speaking) ↔ a top-left
/// corner pill (Claude Code session). The transition is a spring (Motion.cloudState
/// — nothing snaps, no hard cut). Widgets bloom from the cloud on a Stage cue and
/// dissolve back into it (CLOUD-04); the widget views own their own bloom/dissolve.
struct CloudWindow: View {
    @ObservedObject var coordinator: AppCoordinator

    var body: some View {
        ZStack {
            // Layer 0: the spatial-black canvas (UI-SPEC dominant 60%).
            Tokens.canvas.ignoresSafeArea()

            switch coordinator.scene {
            case .fullscreen, .idle:
                fullScreen
            case .cornerPill:
                cornerPill
            }
        }
        .animation(Motion.cloudState, value: coordinator.scene)   // spring migration, no snap
    }

    // MARK: Full-screen state (boot / speaking) — cloud owns the canvas, widgets bloom.

    private var fullScreen: some View {
        ZStack {
            // The living cloud fills the canvas.
            CloudCanvas(state: coordinator.cloud)
                .ignoresSafeArea()

            // The bloomed widget layer. One or two in focus at a time (the coordinator
            // caps it). Each widget animates its own bloom/dissolve via `isPresented`.
            HStack(spacing: Tokens.Space.xl) {                    // 32px between co-focused widgets
                ForEach(coordinator.presentedWidgets, id: \.self) { name in
                    widgetView(named: name)
                }
            }
            .padding(.bottom, Tokens.Space.xxl)                    // 48px stage inset
        }
        .transition(.opacity)
    }

    /// Render a widget by name. Phase 3 shipped the events widget end-to-end; Phase 4
    /// adds the four remaining widgets (04-UI-SPEC §2–§5), bound to the shipped
    /// `coordinator.presentedData[name]` path. Chip / Send actions emit `ui.intent`s the
    /// daemon dispatches through the gate (the Face never acts locally).
    @ViewBuilder
    private func widgetView(named name: String) -> some View {
        switch name {
        case "events":
            EventsWidget(
                payload: EventsPayload.from(coordinator.presentedData["events"]),
                isPresented: true)
        case "mail":
            MailWidget(
                payload: MailPayload.from(coordinator.presentedData["mail"]),
                isPresented: true,
                onAction: { action, item in
                    coordinator.emitIntent("mail-action", payload: .object([
                        "action": .string(action.rawValue),
                        "subject": .string(item.subject),
                    ]))
                })
        case "accounts":
            AccountsWidget(
                payload: AccountsPayload.from(coordinator.presentedData["accounts"]),
                isPresented: true)
        case "spending":
            SpendingWidget(
                payload: SpendingPayload.from(coordinator.presentedData["spending"]),
                isPresented: true)
        case "email-preview":
            EmailPreviewWidget(
                payload: EmailPreviewPayload.from(coordinator.presentedData["email-preview"]),
                isPresented: true,
                onSend: { p in
                    coordinator.emitIntent("send-email", payload: .object([
                        "to": .string(p.to),
                        "subject": .string(p.subject),
                    ]))
                },
                onEdit: { coordinator.emitIntent("edit-email") })
        default:
            EmptyView()
        }
    }

    // MARK: Corner pill (Claude Code session) — miniature cloud + accent live-pulse dot.

    private var cornerPill: some View {
        VStack {
            HStack {
                pillBody
                    .padding(.top, 16)                             // 16px corner inset (UI-SPEC exception)
                    .padding(.leading, 16)
                Spacer()
            }
            Spacer()
        }
        .transition(.scale(scale: 0.9).combined(with: .opacity))
    }

    private var pillBody: some View {
        HStack(spacing: Tokens.Space.sm) {
            CloudCanvas(state: coordinator.cloud, particleCount: ParticleRenderer.minCount)
                .frame(width: 64, height: 48)
                .clipShape(RoundedRectangle(cornerRadius: Tokens.Radius.pill))
            // The accent live-pulse dot (UI-SPEC accent reserved use #5).
            Circle()
                .fill(Tokens.accentCyan)
                .frame(width: 8, height: 8)
                .opacity(0.9)
        }
        .padding(.horizontal, 12)                                  // 12px pill padding (UI-SPEC exception)
        .padding(.vertical, 8)
        .background(Tokens.denseMaterial, in: RoundedRectangle(cornerRadius: Tokens.Radius.pill))
        .overlay(
            RoundedRectangle(cornerRadius: Tokens.Radius.pill)
                .stroke(Tokens.hairline, lineWidth: 1))            // white-7% hairline
    }
}
