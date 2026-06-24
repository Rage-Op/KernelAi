import SwiftUI

/// The Face's root window — the designed "Personal Agent Runtime" surface.
///
/// Composes the spatial stage (the living sphere + bloom widgets, owned by `CloudWindow`) with the
/// custom titlebar, a mode pill, and the persistent bottom chrome (telemetry · message bar · control
/// dock). Before the daemon introduces itself it shows the boot/runtime-status screen; once
/// `capabilities` arrive it springs to the live stage. The corner-pill (Claude Code session) scene
/// keeps its minimal chrome — the bottom bar hides so the pill stays unobtrusive.
struct RuntimeWindow: View {
    @ObservedObject var coordinator: AppCoordinator

    /// True once we've revealed the live stage. Normally this flips when the MODEL is ready
    /// (BRAIN-07) — so the owner's first prompt is never a cold start. It can also be forced by the
    /// boot screen's "Continue anyway" or a long fail-safe timeout, so the app is never stuck on boot
    /// (plug-and-play: a dead/headless daemon still lets you in).
    @State private var revealed = false
    /// Guards the one-shot reveal timer so re-renders don't schedule it repeatedly.
    @State private var didScheduleReveal = false

    /// Hold the boot/runtime-status screen until the model is loaded and READY (or a manual/fail-safe
    /// reveal). Gating on `modelReady` (not just `capabilities`) is the "wait for the model" behavior.
    private var showBoot: Bool { !revealed && !coordinator.modelReady }
    /// Full chrome only on the main stage (not boot, not the corner pill).
    private var showChrome: Bool { !showBoot && coordinator.scene != .cornerPill }

    /// Reserve room at the bottom of the stage so bloomed widgets clear the chrome.
    private let chromeInset: CGFloat = 168

    /// DEBUG-only: `KERNEL_GALLERY=1` shows the card gallery instead of the stage (design review).
    private var galleryMode: Bool {
        #if DEBUG
        return ProcessInfo.processInfo.environment["KERNEL_GALLERY"] != nil
        #else
        return false
        #endif
    }

    var body: some View {
        // @ViewBuilder if/else (NOT `return AnyView(...)`) so `stage`'s lifecycle (.onAppear) fires
        // normally — the early-return AnyView pattern suppressed it.
        #if DEBUG
        if galleryMode { CardGallery() } else { stage }
        #else
        stage
        #endif
    }

    private var stage: some View {
        ZStack {
            Tokens.canvas.ignoresSafeArea()

            if showBoot {
                BootScreen(coordinator: coordinator, onContinue: { revealed = true })
                    .transition(.opacity)
            } else {
                CloudWindow(coordinator: coordinator, bottomInset: showChrome ? chromeInset : 0)
            }
        }
        // Widget displayer — an OVERLAY (not a ZStack sibling): the Metal CloudWindow NSView
        // composites above SwiftUI siblings, but overlays always render above it (as the conversation
        // overlay does). Pinned right; the sphere shifts left via cloud.center.
        .overlay(alignment: .trailing) {
            if showChrome, let widget = coordinator.activeWidget {
                WidgetDisplayer(
                    spec: widget,
                    onOption: { coordinator.chooseWidgetOption($0, $1) },
                    onDismiss: { coordinator.dismissWidget($0) })
            }
        }
        .overlay(alignment: .top) {
            VStack(spacing: Tokens.Space.md) {
                TitleBar(coordinator: coordinator)
                if showChrome, let pill = modePill {
                    pill
                }
            }
        }
        .overlay(alignment: .bottomLeading) {
            if showChrome && !coordinator.conversationLines.isEmpty {
                ConversationOverlay(lines: coordinator.conversationLines)
                    .padding(.leading, Tokens.Space.xl)
                    .padding(.bottom, chromeInset + Tokens.Space.lg)
                    .allowsHitTesting(false)
            }
        }
        .overlay(alignment: .bottom) {
            if showChrome { bottomChrome }
        }
        .animation(Motion.cloudState, value: showBoot)
        .onAppear {
            guard !didScheduleReveal else { return }
            didScheduleReveal = true
            // FAIL-SAFE last resort: reveal the stage after a long grace even if the model never
            // reports ready (dead/headless daemon, Ollama down) — the app is never trapped on boot.
            // The normal path reveals far sooner via `modelReady`; the boot screen also offers an
            // explicit "Continue anyway". A guarded asyncAfter survives view re-renders.
            DispatchQueue.main.asyncAfter(deadline: .now() + 60) { revealed = true }
        }
    }

    // MARK: Bottom chrome — telemetry · message bar · dock (always visible on the stage)

    private var bottomChrome: some View {
        VStack(spacing: Tokens.Space.md) {
            TelemetryStrip(coordinator: coordinator)
            // BACKGROUND TOOL USE (live): shows what KERNEL is doing right now — "🔧 web · searching…".
            if let activity = coordinator.toolActivity {
                HStack(spacing: Tokens.Space.sm) {
                    Image(systemName: "wrench.and.screwdriver.fill").font(.system(size: 11))
                    Text(activity).font(Tokens.Typography.monoCaption)
                }
                .foregroundStyle(Tokens.accentTerracotta)
                .padding(.horizontal, Tokens.Space.md)
                .padding(.vertical, Tokens.Space.sm)
                .background(Tokens.chipFill, in: Capsule())
                .transition(.opacity)
            }
            VStack(spacing: Tokens.Space.md) {
                MessageBar(coordinator: coordinator)
                    .frame(maxWidth: 640)
                ControlDock(coordinator: coordinator)
            }
            .padding(.horizontal, Tokens.Space.xl)
            .padding(.bottom, Tokens.Space.lg)
            // Keep the input + dock clear of the slide-in widget panel on the right.
            .padding(.trailing, coordinator.activeWidget != nil ? 376 : 0)
            .animation(Motion.cloudState, value: coordinator.activeWidget != nil)
        }
        .animation(Motion.cloudState, value: coordinator.toolActivity)
        .background(
            // A soft scrim so the input + telemetry stay legible over the living sphere.
            LinearGradient(
                colors: [Tokens.canvas.opacity(0), Tokens.canvas.opacity(0.85), Tokens.canvas],
                startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea())
    }

    // MARK: Mode pill — "Listening" / "Thinking…" / "Kernel is speaking"

    private var modePill: ModePill? {
        guard let label = ModePill.label(
            speaking: coordinator.isSpeaking,
            awaiting: coordinator.isAwaitingReply,
            listening: coordinator.isListening)
        else { return nil }
        return ModePill(text: label, accented: coordinator.isSpeaking || coordinator.isListening)
    }
}

/// The small status pill that floats below the titlebar while KERNEL is engaged.
private struct ModePill: View {
    let text: String
    let accented: Bool

    /// The pill label for the current engagement, or nil when idle (no pill).
    static func label(speaking: Bool, awaiting: Bool, listening: Bool) -> String? {
        if speaking { return "Kernel is speaking" }
        if awaiting { return "Thinking…" }
        if listening { return "Listening" }
        return nil
    }

    var body: some View {
        HStack(spacing: Tokens.Space.sm) {
            Circle()
                .fill(accented ? Tokens.accentTerracotta : Tokens.textMuted)
                .frame(width: 7, height: 7)
            Text(text)
                .font(Tokens.Typography.label)
                .foregroundStyle(Tokens.textSecondary)
        }
        .padding(.horizontal, Tokens.Space.md)
        .padding(.vertical, Tokens.Space.sm)
        .background(Tokens.surface.opacity(0.9), in: Capsule())
        .overlay(Capsule().stroke(Tokens.hairline, lineWidth: 1))
        .transition(.scale(scale: 0.9).combined(with: .opacity))
    }
}
