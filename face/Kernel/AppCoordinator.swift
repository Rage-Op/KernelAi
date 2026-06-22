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
        case .error(_, let message):
            log.error("daemon error: \(message, privacy: .public)")
        default:
            break  // hello/ping/pong/utterance/ui.intent/settings are not inbound-handled here
        }
    }

    /// Latest widget payloads, keyed by widget name (events/mail/…). Task 3 reads
    /// `events` here when the Stage presents the events widget.
    @Published var latestWidgetData: [String: JSONValue] = [:]

    // MARK: Stage actions → cloud burst (Task 3 wires the widget bloom/dissolve)

    private func wireStageActions() {
        // Task 3 replaces/extends this to drive EventsWidget present/dismiss. For
        // Task 2 each fired cue pulses the cloud (the boundary-burst flash, UI-SPEC).
        stage.onAction = { [weak self] _ in self?.cloud.pulse() }
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
