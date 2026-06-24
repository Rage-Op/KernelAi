import SwiftUI
import ServiceManagement
import Combine
import os
import AppKit

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
    /// Owns the daemon lifecycle for the hybrid model: spawns one when none answers (so Cmd+R / a
    /// plain app launch starts the daemon), terminating only a daemon IT spawned.
    let supervisor = DaemonSupervisor()

    /// The pages reachable from the app shell's left navigation rail.
    enum Page: String, CaseIterable { case home, chat, files, settings }

    /// The active page in the navigation rail. `.home` is the living sphere stage.
    @Published var page: Page = .home

    /// The single animated scene state (CLOUD-05). Driven by inbound `ui.state`.
    @Published var scene: Frame.SceneState = .fullscreen

    /// Connection status mirrored for the menubar.
    @Published var connection: KernelSocket.Status = .idle

    // MARK: Telemetry (capabilities + stats frames → boot screen + telemetry strip)

    /// The daemon's runtime capabilities, received once on connect (nil until then).
    @Published private(set) var capabilities: RuntimeCapabilities?
    /// The most recent per-turn stats (drives the live tok/s · ctx · cost readout).
    @Published private(set) var lastStats: TurnStats?
    /// Cumulative session usage, folded from every `stats` turn.
    @Published private(set) var usage = SessionUsage()
    /// A short, transient label of the tool KERNEL is using RIGHT NOW (nil when idle). Drives the
    /// live "🔧 web · searching…" indicator so background tool use is visible, not an opaque pause.
    @Published private(set) var toolActivity: String? = nil

    // MARK: Cloud resonance mode (drives the living sphere — the "complex resonance")

    /// The owner is actively addressing KERNEL (mic open). Set by the control dock's mic.
    @Published var isListening = false { didSet { refreshCloudMode() } }
    /// An utterance is in flight and we're awaiting KERNEL's reply/speech (→ thinking).
    @Published private(set) var isAwaitingReply = false { didSet { refreshCloudMode() } }
    /// Mirror of `speaker.isSpeaking`, republished here so views observing the coordinator (the
    /// control dock's pause/play, the mode pill) update reactively.
    @Published private(set) var isSpeaking = false

    /// The on-screen YOU ↔ KERNEL conversation (the design's stage transcript), oldest→newest.
    @Published private(set) var conversationLines: [ConversationLine] = []
    private var convSeq = 0

    /// The persisted chat history loaded from the daemon on connect (`history.data`). Shown in the
    /// Chat page ABOVE this session's live `conversationLines`. Ids are NEGATIVE so they never
    /// collide with the positive `convSeq` of live turns.
    @Published private(set) var chatHistory: [ConversationLine] = []

    // MARK: Streaming reply (the `say` frame path — real-time render + TTS)

    /// True while a streamed reply is in flight (drives the sphere into `speaking` immediately,
    /// before TTS has even started, so the transition feels instant).
    @Published private(set) var isStreamingReply = false
    /// The frame id of the streaming reply currently building (nil when none).
    private var streamFrameId: String?
    /// The conversation line id being appended to as deltas arrive.
    private var streamLineId: Int?
    /// How many chars of the streaming line have already been handed to TTS.
    private var spokenChars = 0

    // MARK: Widget displayer (WS4 — the slide-in command panel)

    /// The widget command currently shown in the slide-in displayer (nil when none). When set, the
    /// sphere minimizes + shifts left and the panel slides in from the right.
    @Published private(set) var activeWidget: WidgetSpec?
    private var widgetSeq = 0
    /// When the active widget was presented — a brief debounce so a spurious dismiss (e.g. from
    /// re-render churn while the daemon reconnects) can't instantly nil a just-shown panel.
    private var widgetPresentedAt: Date?
    /// Append a line to the on-screen conversation, bounded to the most recent few.
    private func appendConversation(_ role: ConversationLine.Role, _ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        convSeq += 1
        conversationLines.append(ConversationLine(id: convSeq, role: role, text: trimmed))
        if conversationLines.count > 12 { conversationLines.removeFirst(conversationLines.count - 12) }
    }

    /// Cancels a pending tool-activity auto-clear so back-to-back tool calls don't flicker.
    private var toolActivityClear: DispatchWorkItem?

    /// Handle a `tool.activity` frame: show what KERNEL is doing in the background ("🔧 web ·
    /// searching…"), then a brief ✓/⚠ that fades. Informational — it drives no action.
    private func handleToolActivity(tool: String, op: String, status: String, detail: String?) {
        toolActivityClear?.cancel()
        let label = (detail?.isEmpty == false) ? detail! : op
        switch status {
        case "start":
            toolActivity = "\(tool) · \(label)…"
            cloud.mode = .thinking          // the orb churns while a tool runs (the "working" state)
        case "ok":
            toolActivity = "\(tool) ✓"
            scheduleToolActivityClear()
        default: // "error"
            toolActivity = "\(tool) unavailable"
            scheduleToolActivityClear()
        }
    }

    private func scheduleToolActivityClear() {
        let work = DispatchWorkItem { [weak self] in self?.toolActivity = nil }
        toolActivityClear = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6, execute: work)
    }

    /// Handle a streamed reply delta (`say` frame): open a KERNEL line on the first delta of a new
    /// turn, append each delta live (real-time render), and hand newly-completed sentences to TTS
    /// (real-time speech). `final` finalizes the line + flushes any unspoken remainder.
    private func handleSay(id: String, delta: String, final: Bool) {
        isAwaitingReply = false
        if streamFrameId != id {
            // New streamed reply — open a fresh, empty KERNEL line (bypasses the non-empty guard).
            streamFrameId = id
            convSeq += 1
            conversationLines.append(ConversationLine(id: convSeq, role: .kernel, text: ""))
            if conversationLines.count > 12 { conversationLines.removeFirst(conversationLines.count - 12) }
            streamLineId = convSeq
            spokenChars = 0
            isStreamingReply = true
            refreshCloudMode()
        }
        if !delta.isEmpty, let idx = conversationLines.lastIndex(where: { $0.id == streamLineId }) {
            conversationLines[idx].text += delta
            speakNewSentences(final: false)
        }
        if final {
            speakNewSentences(final: true)
            streamFrameId = nil
            isStreamingReply = false
            refreshCloudMode()
        }
    }

    /// Speak the not-yet-spoken portion of the streaming line, up to the last completed sentence
    /// (or all of it when `final`). Keeps TTS roughly one sentence behind the visible text so KERNEL
    /// starts talking almost immediately instead of after the whole reply.
    private func speakNewSentences(final: Bool) {
        guard let idx = conversationLines.lastIndex(where: { $0.id == streamLineId }) else { return }
        let full = conversationLines[idx].text
        guard full.count > spokenChars else { if final { spokenChars = full.count }; return }
        let start = full.index(full.startIndex, offsetBy: spokenChars)
        let pending = String(full[start...])

        if final {
            let rest = pending.trimmingCharacters(in: .whitespacesAndNewlines)
            if !rest.isEmpty { speaker.enqueueChunk(rest) }
            spokenChars = full.count
            return
        }
        let terminators: Set<Character> = [".", "!", "?", "\n"]
        if let lastTerm = pending.lastIndex(where: { terminators.contains($0) }) {
            let speakable = String(pending[...lastTerm]).trimmingCharacters(in: .whitespacesAndNewlines)
            if !speakable.isEmpty { speaker.enqueueChunk(speakable) }
            spokenChars += pending.distance(from: pending.startIndex, to: lastTerm) + 1
        }
    }

    private var cancellables = Set<AnyCancellable>()

    /// Resolve the sphere's resonance mode by priority: speaking > thinking > listening > idle.
    /// Re-run whenever any input changes (mic toggles, an utterance is sent, speech starts/ends).
    func refreshCloudMode() {
        let m: CloudState.CloudMode
        if speaker.isSpeaking || isStreamingReply { m = .speaking }
        else if isAwaitingReply { m = .thinking }
        else if isListening { m = .listening }
        else { m = .idle }
        if cloud.mode != m { cloud.mode = m }
    }

    /// Note that an utterance was just sent (text or voice) — KERNEL is now thinking until a
    /// reply/speak/stats frame returns. Called by the message bar + the mic control.
    func noteUtteranceSent() {
        isAwaitingReply = true
    }

    /// Launch-at-login (SMAppService.mainApp), user-toggled, default off (CLOUD-01).
    @Published var launchAtLogin: Bool = false

    /// The active brain shown in the menubar Settings toggle (CLOUD-01). Seeded from UserDefaults
    /// so the visible choice survives Face restarts; the daemon persists its own copy (settings.ts)
    /// so the active brain survives daemon restarts. Default `.local` (LocalBrain / qwen3.5 via
    /// Ollama) — a local-first assistant that uses tools and works offline without a cloud key. This
    /// mirrors the daemon's boot default (index.ts) so the UI and daemon agree out of the box.
    @Published var brain: Frame.Brain = AppCoordinator.loadBrainPreference()

    /// UserDefaults key for the persisted brain selection (UI-side mirror of the daemon's brain.json).
    private static let brainDefaultsKey = "kernel.brain"

    /// Read the persisted UI brain choice, defaulting to `.local` when unset/invalid.
    static func loadBrainPreference() -> Frame.Brain {
        Frame.Brain(rawValue: UserDefaults.standard.string(forKey: brainDefaultsKey) ?? "") ?? .local
    }

    init() {
        self.speaker = Speaker(stage: stage)
        self.mic = MicEngine(cloud: cloud)
        wireFrames()
        wireStageActions()
        refreshLaunchAtLogin()
        // Speech start/finish drives the sphere into/out of its `speaking` resonance.
        speaker.$isSpeaking
            .receive(on: RunLoop.main)
            .sink { [weak self] speaking in
                self?.isSpeaking = speaking
                self?.refreshCloudMode()
            }
            .store(in: &cancellables)
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
        // HYBRID daemon lifecycle: if nothing answers shortly, spawn the daemon ourselves and
        // reconnect. A launchd-owned daemon answers first (no spawn); a plain Cmd+R with launchd not
        // loaded triggers a spawn. The daemon's single-instance guard makes any accidental double safe.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            guard let self, self.connection != .connected else { return }
            if self.supervisor.spawnIfNeeded() {
                // Give the freshly-spawned daemon a moment to bind the socket, then (re)connect.
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.3) { [weak self] in
                    guard let self, self.connection != .connected else { return }
                    self.socket.disconnect()
                    self.socket.connect()
                }
            }
        }
        // PUSH-TO-TALK: the mic is NOT started here — KERNEL doesn't listen until the owner holds
        // the mic control (beginListening). Request Speech authorization once so the first hold works.
        MicEngine.requestSpeechAuthorization()
        mic.onTranscript = { [weak self] text, isFinal in self?.handleTranscript(text, isFinal: isFinal) }
        #if DEBUG
        // DEBUG-only design-review hook: KERNEL_DEMO_WIDGET=1 presents a sample widget command so the
        // displayer can be reviewed without live text input (env-gated; compiled out of release).
        if ProcessInfo.processInfo.environment["KERNEL_DEMO_WIDGET"] != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.2) { [weak self] in
                self?.presentWidgetCommand(
                    id: "demo",
                    command: "focus email to:john@acme.com from:Acme subject:Renewal content:Glad to move forward at locked pricing. options:abort,send(auto 15s)")
            }
        }
        #endif
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
            requestHistory()   // pull the persisted transcript so the Chat page shows past conversations
        case .speak(let id, let text, let frameCues, let onFinish):
            _ = id
            isAwaitingReply = false   // the reply has arrived; isSpeaking will take over the mode
            appendConversation(.kernel, text)
            let cues = Cue.from(frameCues: frameCues)
            speaker.speak(text, cues: cues, onFinish: onFinish ?? [])
        case .reply(let id, let text):
            _ = id
            isAwaitingReply = false
            appendConversation(.kernel, text)
            // A bare reply with no cues still speaks (no choreography).
            speaker.speak(text, cues: [])
        case .widgetData(let widget, let data):
            latestWidgetData[widget] = data
        case .uiState(let state):
            scene = state
            updateCloudCenter()
        case .transcript(let id, let role, let text, let partial):
            appendTranscript(id: id, role: role, text: text, partial: partial ?? false)
        case .breakerPreview(let id, let summary, let estimatedSpend, _):
            // SAFE-03: a Red action entered the breaker. Surface the dry-run preview card with the
            // 10s cancel window. The owner Cancel emits a breaker.cancel{id}; the window elapsing
            // (or an audit/cancel resolution) clears it.
            presentBreakerPreview(BreakerPreview(id: id, summary: summary, estimatedSpend: estimatedSpend))
        case .capabilities(let brain, let daemon, let version, let injectCap, let tools, let integrations):
            capabilities = RuntimeCapabilities(
                brain: brain, daemon: daemon, version: version,
                injectCap: injectCap, tools: tools, integrations: integrations)
            log.info("capabilities: \(tools.count, privacy: .public) tools, \(integrations.count, privacy: .public) integrations")
        case .stats(let id, let brain, let model, let promptTokens, let outputTokens, let tokensPerSec, let evalMs, let loadMs, let totalMs, let contextWindow, let estCostUsd):
            let stats = TurnStats(
                id: id, brain: brain, model: model,
                promptTokens: promptTokens, outputTokens: outputTokens, tokensPerSec: tokensPerSec,
                evalMs: evalMs, loadMs: loadMs, totalMs: totalMs,
                contextWindow: contextWindow, estCostUsd: estCostUsd)
            lastStats = stats
            usage.record(stats)
        case .say(let id, let delta, let final):
            handleSay(id: id, delta: delta, final: final)
        case .widgetCommand(let id, let command):
            presentWidgetCommand(id: id, command: command)
        case .toolActivity(_, let tool, let op, let status, let detail):
            handleToolActivity(tool: tool, op: op, status: status, detail: detail)
        case .historyData(_, let turns):
            // The persisted transcript. Map to conversation lines with NEGATIVE ids (never collide
            // with live convSeq). Shown as the Chat page's scrollback above this session's turns.
            chatHistory = turns.enumerated().map { idx, t in
                ConversationLine(id: -(idx + 1), role: t.role == "user" ? .you : .kernel, text: t.text)
            }
            log.info("history: loaded \(turns.count, privacy: .public) persisted turns")
        case .error(_, let message):
            log.error("daemon error: \(message, privacy: .public)")
        default:
            break  // hello/ping/pong/utterance/ui.intent/settings/breaker.cancel/override are not inbound-handled here
        }
    }

    // MARK: Red breaker preview (SAFE-03) — the §8 human-in-the-loop 10s cancel window

    /// The Red action currently awaiting the owner's cancel decision (nil when none is in flight).
    /// The CloudWindow renders the BreakerPreviewCard while this is set.
    @Published private(set) var activeBreakerPreview: BreakerPreview? = nil

    /// Surface a breaker dry-run preview. A new preview replaces any prior one (the breaker runs
    /// one gated action at a time, serialized by the daemon loop).
    func presentBreakerPreview(_ preview: BreakerPreview) {
        activeBreakerPreview = preview
        cloud.pulse()   // boundary-burst — a Red gate is a moment worth flashing.
    }

    /// The owner tapped Cancel within the window: emit `breaker.cancel{id}` so the daemon aborts the
    /// pending Red action, then clear the card. The Face NEVER decides the action — it only cancels.
    func cancelBreakerPreview(_ preview: BreakerPreview) {
        let frame = Frame.breakerCancel(id: preview.id)
        if Self.isUnderXCTest {
            log.info("under XCTest host — not sending breaker.cancel \(preview.id, privacy: .public)")
        } else {
            socket.send(frame)
        }
        if activeBreakerPreview?.id == preview.id { activeBreakerPreview = nil }
    }

    /// The window elapsed with no cancel — the locked SAFE-03 default is PROCEED (the daemon's
    /// breaker proceeds after ceiling+audit). The card auto-dismisses; nothing is sent.
    func breakerPreviewElapsed(_ preview: BreakerPreview) {
        if activeBreakerPreview?.id == preview.id { activeBreakerPreview = nil }
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

    /// Ask the daemon for the persisted chat history. The reply arrives as a `history.data` frame
    /// and (re)seeds `chatHistory` for the Chat page. Called on each fresh `.ready` so a reconnect
    /// (e.g. after the supervisor spawns the daemon) re-syncs. Cheap + idempotent; test-safe.
    func requestHistory() {
        guard !Self.isUnderXCTest else { return }
        socket.send(.historyRequest(id: "hist-\(String(UUID().uuidString.prefix(8)))", limit: 200))
    }

    // MARK: Owner input (message bar + control dock)

    /// Monotonic id for Face-originated utterances.
    private var utteranceSeq = 0

    /// Send a typed utterance to the daemon (the text path that complements voice). Appends it to
    /// the local transcript as the OWNER's line and flips the sphere to thinking. `display` overrides
    /// the echoed transcript text while the full `text` is sent to the daemon — used by attachments so
    /// the visible line stays clean ("📎 notes.pdf — summarize this") while KERNEL receives the
    /// extracted file contents.
    func sendUtterance(_ text: String, display: String? = nil) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        // Local widget-displayer shortcut (demo / manual): `/widget focus email to:.. options:..`.
        if trimmed.lowercased().hasPrefix("/widget ") {
            widgetSeq += 1
            presentWidgetCommand(id: "local-\(widgetSeq)", command: String(trimmed.dropFirst(8)))
            return
        }
        utteranceSeq += 1
        let id = "face-\(utteranceSeq)"
        // Echo the owner's words onto the stage conversation immediately (optimistic).
        appendConversation(.you, display ?? trimmed)
        noteUtteranceSent()
        guard !Self.isUnderXCTest else {
            log.info("under XCTest host — not sending utterance")
            return
        }
        socket.send(.utterance(id: id, text: trimmed, final: true))
    }

    /// The live "you're speaking" conversation line id while holding the mic (nil when not).
    private var voiceLineId: Int?

    /// Press-and-hold the mic: start capturing + on-device recognition. The sphere draws inward and
    /// shimmers to your voice; a live YOU line shows the partial transcript as you speak.
    func beginListening() {
        guard !isListening else { return }
        isListening = true
        convSeq += 1
        conversationLines.append(ConversationLine(id: convSeq, role: .you, text: "…"))
        if conversationLines.count > 12 { conversationLines.removeFirst(conversationLines.count - 12) }
        voiceLineId = convSeq
        guard !Self.isUnderXCTest else { refreshCloudMode(); return }
        mic.start()
        refreshCloudMode()
    }

    /// Release the mic: stop capturing. The final transcript arrives async (handleTranscript) and,
    /// if non-empty, is sent to the daemon as the utterance.
    func endListening() {
        guard isListening else { return }
        isListening = false
        if !Self.isUnderXCTest { mic.stop() }
        refreshCloudMode()
    }

    /// On-device recognition callback: update the live YOU line with each partial; on the final,
    /// finalize it and send it to the daemon (or drop the line if nothing was heard).
    private func handleTranscript(_ text: String, isFinal: Bool) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let id = voiceLineId, let idx = conversationLines.lastIndex(where: { $0.id == id }) {
            conversationLines[idx].text = trimmed.isEmpty ? "…" : trimmed
        }
        guard isFinal else { return }
        if let id = voiceLineId,
           let idx = conversationLines.lastIndex(where: { $0.id == id }),
           trimmed.isEmpty {
            conversationLines.remove(at: idx)   // heard nothing — drop the placeholder line
        }
        voiceLineId = nil
        if !trimmed.isEmpty { sendVoiceUtterance(trimmed) }
    }

    /// Send a finalized voice transcript to the daemon. The YOU line already shows the text (from the
    /// live partials), so — unlike `sendUtterance` — this does NOT append another conversation line.
    private func sendVoiceUtterance(_ text: String) {
        utteranceSeq += 1
        let id = "voice-\(utteranceSeq)"
        noteUtteranceSent()
        guard !Self.isUnderXCTest else { return }
        socket.send(.utterance(id: id, text: text, final: true))
    }

    // MARK: Widget displayer (WS4)

    /// Parse a widget command string and present it in the slide-in displayer (the sphere shifts
    /// left). Used by the daemon's `widget.command` frame and the local `/widget …` shortcut.
    func presentWidgetCommand(id: String, command: String) {
        guard let spec = WidgetCommand.parse(id: id, command) else { return }
        activeWidget = spec
        widgetPresentedAt = Date()
        updateCloudCenter()
    }

    /// Close the displayer (the sphere re-centers). Ignores a stale dismiss for a replaced command.
    func dismissWidget(_ spec: WidgetSpec? = nil) {
        // Debounce: ignore a dismiss in the first moment after present (kills spurious churn dismisses).
        if let t = widgetPresentedAt, Date().timeIntervalSince(t) < 2.0 { return }
        if let spec, activeWidget?.id != spec.id { return }
        activeWidget = nil
        updateCloudCenter()
    }

    /// The owner chose a displayer option (or it auto-fired): emit a gate-routed `ui.intent` so the
    /// daemon performs the action (the Face never sends/aborts locally), then close the panel.
    func chooseWidgetOption(_ spec: WidgetSpec, _ option: WidgetOption) {
        let role = option.kind == .confirm ? "confirm" : (option.kind == .abort ? "abort" : "neutral")
        emitIntent("widget-option", payload: .object([
            "command": .string(spec.id),
            "kind": .string(spec.kind),
            "option": .string(option.label),
            "role": .string(role),
        ]))
        // Dismiss only on an explicit abort; confirm/auto leave the panel for the daemon to clear,
        // so a mis-firing timer can't yank the panel out from under the owner.
        if option.kind == .abort { dismissWidget(spec) }
    }

    /// Keep the cloud center consistent: corner-pill > widget-shift > centered.
    private func updateCloudCenter() {
        if scene == .cornerPill {
            cloud.center = SIMD2<Float>(-0.6, 0.6)
        } else if activeWidget != nil {
            cloud.center = SIMD2<Float>(-0.45, 0)   // minimize-left so the right panel has room
        } else {
            cloud.center = .zero
        }
    }

    /// Interrupt KERNEL mid-speech (the dock pause control). Stops the synth and re-settles the
    /// sphere; never destructive.
    func interruptSpeech() {
        speaker.stop()
        refreshCloudMode()
    }

    /// Clear the local conversation transcript + dissolve any bloomed widgets (the dock restart
    /// control). Face-local only — it does not touch daemon memory.
    func clearConversation() {
        conversationLines.removeAll()
        streamFrameId = nil
        streamLineId = nil
        spokenChars = 0
        isStreamingReply = false
        transcriptLines.removeAll()
        transcriptStreaming = false
        for w in presentedWidgets { presentedData[w] = nil }
        presentedWidgets.removeAll()
        isAwaitingReply = false
        // Also clear the daemon's SHORT-TERM conversation buffer so the model forgets too — not just
        // the Face transcript. Routed as the `/clear` meta-command (long-term memory is untouched).
        guard !Self.isUnderXCTest else { return }
        utteranceSeq += 1
        socket.send(.utterance(id: "face-clear-\(utteranceSeq)", text: "/clear", final: true))
    }

    // MARK: Brain directory (the dock folder icon — view KERNEL's soul/identity files)

    /// Reveal KERNEL's persistent "brain" directory in Finder — `kernel-memory/` holds IDENTITY.md
    /// (the soul/purpose contract), `self/`, `knowledge/`, and the day logs. The dock's folder icon
    /// calls this so the owner can see what KERNEL is and what it remembers. Path honors a
    /// `KERNEL_MEMORY_PATH` override, else defaults to `~/KernelAi/kernel-memory`.
    func revealBrainDirectory() {
        let path = ProcessInfo.processInfo.environment["KERNEL_MEMORY_PATH"]
            ?? FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("KernelAi/kernel-memory").path
        NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: path)
    }

    // MARK: Launch-at-login (SMAppService.mainApp — CLOUD-01)

    func refreshLaunchAtLogin() {
        launchAtLogin = (SMAppService.mainApp.status == .enabled)
    }

    // MARK: Brain selection (CLOUD-01 Settings toggle)

    /// Programmatic brain switch (also used by tests): update the published selection, then run the
    /// side-effects. The menubar Picker does NOT call this — it drives `brain` through its
    /// synthesized binding (`$coordinator.brain`) and runs the side-effects from `.onChange`, which
    /// fires AFTER the view update so it never publishes from within a view update.
    func setBrain(_ newBrain: Frame.Brain) {
        guard newBrain != brain else { return }
        brain = newBrain
        persistAndSendBrain(newBrain)
    }

    /// Persist the UI choice (UserDefaults) and emit the `settings` frame so the daemon swaps the
    /// active BrainProvider (cloud→ClaudeBrain, local→LocalBrain) and persists its own copy. Does
    /// NOT mutate `brain` — the binding owns that. The Face NEVER runs a model; it only asks the
    /// daemon to switch.
    func persistAndSendBrain(_ newBrain: Frame.Brain) {
        UserDefaults.standard.set(newBrain.rawValue, forKey: Self.brainDefaultsKey)
        guard !Self.isUnderXCTest else {
            log.info("under XCTest host — not sending settings brain=\(newBrain.rawValue, privacy: .public)")
            return
        }
        socket.send(.settings(brain: newBrain))
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
