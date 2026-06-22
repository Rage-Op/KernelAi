import SwiftUI
import ServiceManagement
import os

/// The Face's central coordinator: owns the shared runtime objects and wires the
/// inbound-frame → Speaker/Stage/Cloud loop. This is where talk→reason→speak→
/// choreograph converges (Task 3 wires the EventsWidget bloom/dissolve off the
/// Stage actions; Task 2 establishes the objects + the socket + launch-at-login).
@MainActor
final class AppCoordinator: ObservableObject {

    private let log = Logger(subsystem: "com.kernel.face", category: "coordinator")

    /// The living cloud's amplitude/burst/center source (Face-local — CLOUD-03).
    let cloud = CloudState()
    /// The dual-paced choreography conductor.
    let stage = StageController()
    /// TTS surface (retained synth) driving the Stage.
    let speaker: Speaker
    /// Face-local mic RMS + PCM-to-daemon.
    let mic: MicEngine
    /// NWConnection UDS NDJSON client to the daemon.
    let socket = KernelSocket()

    /// The single animated scene state (CLOUD-05). Driven by inbound `ui.state`.
    @Published var scene: Frame.SceneState = .fullscreen

    /// Connection status mirrored for the menubar.
    @Published var connection: KernelSocket.Status = .idle

    /// Launch-at-login (SMAppService.mainApp), user-toggled, default off (CLOUD-01).
    @Published var launchAtLogin: Bool = false

    init() {
        self.speaker = Speaker(stage: stage)
        self.mic = MicEngine(cloud: cloud)
        wireFrames()
        wireStageActions()
        refreshLaunchAtLogin()
    }

    // MARK: Lifecycle

    /// True when the app binary is hosted by XCTest. Under the test host the
    /// CoreAudio HAL has no device and `AVAudioEngine` blocks indefinitely (the
    /// runner then hangs until timeout), and we must not attach to a live socket.
    /// The pure-logic XCTests (Frame/Stage) need none of the runtime services.
    static var isUnderXCTest: Bool {
        ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
            || NSClassFromString("XCTestCase") != nil
    }

    /// Attach to the daemon socket + start the Face-local mic (CLOUD-03).
    func start() {
        // Never start runtime services under the XCTest host (CoreAudio hangs there).
        guard !Self.isUnderXCTest else {
            log.info("under XCTest host — skipping socket + mic startup")
            return
        }
        socket.onFrame = { [weak self] frame in self?.handle(frame) }
        socket.$status.assign(to: &$connection)
        socket.connect()
        // Stream 16kHz PCM to the daemon STT path; the RMS stays Face-local.
        mic.onPCM16k = { [weak self] _ in
            // The PCM→daemon utterance streaming is wired with the STT plumbing;
            // the RMS→cloud path (CLOUD-03) is already live inside MicEngine.
            _ = self
        }
        mic.start()
    }

    func stop() {
        mic.stop()
        socket.disconnect()
    }

    // MARK: Inbound frame routing (Task 3 expands widget.data handling)

    private func handle(_ frame: Frame) {
        switch frame {
        case .ready(let daemon, let version):
            log.info("daemon ready: \(daemon, privacy: .public) v\(version, privacy: .public)")
        case .speak(let id, let text, let frameCues, let onFinish):
            _ = id
            let cues = Cue.from(frameCues: frameCues)
            speaker.speak(text, cues: cues, onFinish: onFinish ?? [])
        case .reply(let id, let text):
            _ = id
            // A bare reply with no cues still speaks (no choreography).
            speaker.speak(text, cues: [])
        case .widgetData(let widget, let data):
            latestWidgetData[widget] = data
        case .uiState(let state):
            scene = state
            cloud.center = (state == .cornerPill) ? SIMD2<Float>(-0.6, 0.6) : .zero
        case .transcript(let id, let role, let text, let partial):
            appendTranscript(id: id, role: role, text: text, partial: partial ?? false)
        case .error(_, let message):
            log.error("daemon error: \(message, privacy: .public)")
        default:
            break  // hello/ping/pong/utterance/ui.intent/settings are not inbound-handled here
        }
    }

    // MARK: Claude Code transcript buffer (CC-02)

    /// The live Kernel↔Claude transcript, oldest first. The cornerPill's TranscriptPill renders it.
    @Published private(set) var transcriptLines: [TranscriptLine] = []

    /// True while a partial chunk is in flight — drives the pill's accent live-pulse dot.
    @Published private(set) var transcriptStreaming: Bool = false

    /// True when the owner has paused the live stream (the pill's pause control toggles this).
    @Published private(set) var transcriptPaused: Bool = false

    /// Append (or merge) a transcript frame into the buffer. A partial CLAUDE chunk updates the
    /// in-progress claude line in place (it does not duplicate); a non-partial line finalizes it.
    /// Kernel lines (the first-person prompt) always append as their own finalized line. While
    /// paused, frames are still buffered (the owner resumes to a current transcript) but the
    /// auto-scroll/pulse reflect the paused state.
    func appendTranscript(id: String, role: Frame.TranscriptRole, text: String, partial: Bool) {
        if role == .claude,
           let lastIdx = transcriptLines.indices.last,
           transcriptLines[lastIdx].role == .claude,
           transcriptLines[lastIdx].partial {
            // the previous claude line was still streaming — update it in place (no duplicate).
            transcriptLines[lastIdx].text = text
            transcriptLines[lastIdx].partial = partial
        } else {
            transcriptLines.append(TranscriptLine(id: id, role: role, text: text, partial: partial))
        }
        // streaming is live while the newest line is a partial claude chunk and not paused.
        transcriptStreaming = !transcriptPaused && partial && role == .claude
    }

    /// Toggle the owner's pause control. Pausing freezes the streaming pulse; resuming re-enables it.
    func toggleTranscriptPause() {
        transcriptPaused.toggle()
        if transcriptPaused {
            transcriptStreaming = false
        } else if let last = transcriptLines.last, last.role == .claude, last.partial {
            transcriptStreaming = true
        }
    }

    /// Latest widget payloads, keyed by widget name (events/mail/…). The Stage reads
    /// `events` here when it presents the events widget; a `widget.data` frame fills it.
    @Published var latestWidgetData: [String: JSONValue] = [:]

    /// Widgets currently bloomed in focus, in present order. The CloudWindow renders
    /// these as glass widgets blooming from the cloud. Choreography contract: one or
    /// two in focus at a time — a third present dissolves the oldest first.
    @Published private(set) var presentedWidgets: [String] = []
    /// The data bound to each presented widget at present time (cue data wins, else
    /// the latest widget.data payload for that widget).
    @Published private(set) var presentedData: [String: JSONValue] = [:]

    /// Max widgets in focus simultaneously (UI-SPEC: one or two, never a wall).
    private let maxInFocus = 2

    // MARK: Stage actions → widget bloom/dissolve + cloud burst (CLOUD-04)

    private func wireStageActions() {
        stage.onAction = { [weak self] action in
            guard let self else { return }
            // Every fired cue flashes the cloud (the boundary-burst, UI-SPEC).
            self.cloud.pulse()
            switch action {
            case .present(let widget, let data):
                self.present(widget: widget, data: data)
            case .dismiss(let widget):
                self.dismiss(widget: widget)
            case .other:
                break
            }
        }
    }

    /// Bloom a widget into focus. Cue `data` wins; else fall back to the latest
    /// `widget.data` payload. Dissolves the oldest if we're over the focus cap.
    private func present(widget: String, data: JSONValue?) {
        guard !widget.isEmpty else { return }
        presentedData[widget] = data ?? latestWidgetData[widget]
        if !presentedWidgets.contains(widget) {
            presentedWidgets.append(widget)
            while presentedWidgets.count > maxInFocus {
                let oldest = presentedWidgets.removeFirst()
                presentedData[oldest] = nil
            }
        }
    }

    /// Dissolve a widget back into the cloud.
    private func dismiss(widget: String) {
        presentedWidgets.removeAll { $0 == widget }
        presentedData[widget] = nil
    }

    // MARK: Widget-originated UI intents (ROUT-04/05, MAIL) — gate-routed

    /// Emit a `ui.intent` frame to the daemon. Widget chips (mail Log/Reply/Open/Archive),
    /// the email-preview Send, and EventKit invitation replies all flow through here so the
    /// daemon dispatches the resulting action through registry.dispatch → gate.authorize. The
    /// Face never classifies a tier and never acts locally — it only emits the intent.
    func emitIntent(_ intent: String, payload: JSONValue? = nil) {
        let id = "ui-\(UUID().uuidString.prefix(8))"
        let frame = Frame.uiIntent(id: id, intent: intent, payload: payload)
        guard !Self.isUnderXCTest else {
            log.info("under XCTest host — not sending ui.intent \(intent, privacy: .public)")
            return
        }
        socket.send(frame)
    }

    private func wireFrames() { /* socket.onFrame set in start() */ }

    // MARK: Launch-at-login (SMAppService.mainApp — CLOUD-01)

    func refreshLaunchAtLogin() {
        launchAtLogin = (SMAppService.mainApp.status == .enabled)
    }

    /// Toggle launch-at-login. User-driven, default off; failures are logged, not fatal.
    func setLaunchAtLogin(_ enabled: Bool) {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
            refreshLaunchAtLogin()
        } catch {
            log.error("launch-at-login toggle failed: \(error.localizedDescription, privacy: .public)")
            refreshLaunchAtLogin()
        }
    }
}
