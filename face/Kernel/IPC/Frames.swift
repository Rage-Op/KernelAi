import Foundation

/// Codable Swift mirrors of the FROZEN daemon FrameSchema (daemon/src/ipc/protocol.ts).
///
/// Transport is NDJSON over a Unix-domain socket: one `JSON.stringify(frame) + "\n"`
/// per frame. This file mirrors the discriminated union on `type` EXACTLY — no
/// invented fields. The daemon's `z.unknown()` payloads (`cue.data`, `ui.intent.payload`,
/// `widget.data.data`) are modelled as `JSONValue` so they round-trip losslessly
/// without the Face having to know their shape (the EventsWidget reads typed fields
/// out of `JSONValue` at render time — T-03-12: structured data only, never remote
/// resource auto-loading).

// MARK: - JSONValue (lossless mirror of zod's `z.unknown()`)

/// A loss-less JSON value used for the daemon's `z.unknown()` fields. Decodes any
/// JSON shape and re-encodes it identically, so a `speak`/`widget.data` frame
/// round-trips byte-for-byte at the value level.
enum JSONValue: Codable, Equatable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let b = try? c.decode(Bool.self) {
            self = .bool(b)
        } else if let n = try? c.decode(Double.self) {
            self = .number(n)
        } else if let s = try? c.decode(String.self) {
            self = .string(s)
        } else if let o = try? c.decode([String: JSONValue].self) {
            self = .object(o)
        } else if let a = try? c.decode([JSONValue].self) {
            self = .array(a)
        } else {
            throw DecodingError.dataCorruptedError(
                in: c, debugDescription: "Unsupported JSON value")
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .object(let o): try c.encode(o)
        case .array(let a): try c.encode(a)
        case .null: try c.encodeNil()
        }
    }

    // Convenience accessors for the widget renderers (typed-field reads only).
    var stringValue: String? { if case .string(let s) = self { return s }; return nil }
    var doubleValue: Double? { if case .number(let n) = self { return n }; return nil }
    var objectValue: [String: JSONValue]? { if case .object(let o) = self { return o }; return nil }
    var arrayValue: [JSONValue]? { if case .array(let a) = self { return a }; return nil }
    subscript(_ key: String) -> JSONValue? { objectValue?[key] }
}

// MARK: - Cue / onFinish (inside a `speak` frame)

/// One character-keyed choreography cue (mirrors SpeakSchema.cues[]).
struct FrameCue: Codable, Equatable {
    let atChar: Int
    let action: String
    let widget: String?
    let data: JSONValue?
}

/// One onFinish action (mirrors SpeakSchema.onFinish[]).
struct FrameOnFinish: Codable, Equatable {
    let action: String
    let widget: String?
}

/// One persisted chat turn inside a `history.data` frame (mirrors HistoryDataSchema.turns[]).
/// `role` is "user" or "assistant"; `ts` is a millisecond timestamp.
struct HistoryTurn: Codable, Equatable {
    let role: String
    let text: String
    let ts: Double
}

/// One audit entry inside an `audit.data` frame (mirrors AuditDataSchema.entries[]). The SAFE
/// projection only: tool name, terminal outcome, ISO timestamp — never a hash, args, or finance amount.
struct AuditEntry: Codable, Equatable, Identifiable {
    let tool: String
    let outcome: String
    let ts: String
    var id: String { "\(ts)-\(tool)-\(outcome)" }
}

// MARK: - Frame (the discriminated union on `type`)

/// The frozen frame contract, mirrored as a Swift enum keyed on `type`. A
/// malformed/unknown line throws on decode — the caller (KernelSocket) catches
/// it and drops the line WITHOUT crashing (T-03-13).
enum Frame: Codable, Equatable {
    // Face → daemon
    case hello(client: String, version: String)
    case utterance(id: String, text: String, final: Bool)
    case ping(id: String)
    case uiIntent(id: String, intent: String, payload: JSONValue?)
    case settings(brain: Brain)
    /// P5 additive (SAFE-03): the owner cancelled a Red action within the 10s window. Mirrors
    /// BreakerCancelSchema. `id` correlates to the breaker.preview the daemon broadcast.
    case breakerCancel(id: String)
    /// P5 additive (SAFE-02): `/override` activation from the Face. Mirrors OverrideSchema.
    /// `active:true` scopes Green/Yellow autonomy for `ttlMs`; NEVER unlocks Red.
    case override(active: Bool, ttlMs: Int?)
    // daemon → Face
    case ready(daemon: String, version: String)
    case reply(id: String, text: String)
    case pong(id: String)
    case speak(id: String, text: String, cues: [FrameCue], onFinish: [FrameOnFinish]?)
    case widgetData(widget: String, data: JSONValue)
    case uiState(state: SceneState)
    case error(id: String?, message: String)
    /// P4 additive (CC-02): one line of the live Kernel↔Claude transcript. Mirrors TranscriptSchema.
    case transcript(id: String, role: TranscriptRole, text: String, partial: Bool?)
    /// P5 additive (SAFE-03): the breaker's dry-run preview surfaced when a Red action enters the
    /// 10s cancel window. Mirrors BreakerPreviewSchema. `estimatedSpend` is SHOWN to the owner but
    /// NEVER written to the audit log (V7); `tier` is always `red`.
    case breakerPreview(id: String, summary: String, estimatedSpend: Double, tier: BreakerTier)
    /// ADDITIVE (daemon→Face): the daemon's runtime capabilities, pushed once on connect right
    /// after `ready`. Mirrors CapabilitiesSchema. Powers the boot/runtime-status screen and the
    /// telemetry strip's static fields (model, context cap, tool/integration counts).
    case capabilities(
        brain: Brain, daemon: String, version: String,
        injectCap: Int, tools: [String], integrations: [String])
    /// ADDITIVE (daemon→Face): per-turn telemetry correlated by `id`. Mirrors StatsSchema. All
    /// metric fields optional — a brain that doesn't measure sends only id/brain. Powers the
    /// always-on telemetry strip (tok/s, tokens, context fill, est cost).
    case stats(
        id: String, brain: Brain, model: String?,
        promptTokens: Int?, outputTokens: Int?, tokensPerSec: Double?,
        evalMs: Double?, loadMs: Double?, totalMs: Double?,
        contextWindow: Int?, estCostUsd: Double?)
    /// ADDITIVE (daemon→Face): one streamed reply delta for a real-time render + TTS. Each `say`
    /// appends `delta` to the in-progress reply; `final:true` (with empty delta) closes it. A
    /// streamed turn sends `say` frames INSTEAD of a single `reply`. Mirrors SaySchema.
    case say(id: String, delta: String, final: Bool)
    /// ADDITIVE (daemon→Face): a widget-displayer command-language string the Face parses + renders
    /// in the slide-in panel. Mirrors WidgetCommandSchema.
    case widgetCommand(id: String, command: String)
    /// ADDITIVE (daemon→Face): background tool-use activity so the Face can show what KERNEL is
    /// doing live ("🔧 web · searching…", then a brief ✓). Mirrors ToolActivitySchema. Informational.
    case toolActivity(id: String, tool: String, op: String, status: String, detail: String?)
    /// ADDITIVE (Face→daemon): request the persisted chat history for the Chat page. Mirrors
    /// HistoryRequestSchema. `limit` caps how many recent turns to return.
    case historyRequest(id: String, limit: Int?)
    /// ADDITIVE (daemon→Face): the persisted chat history answering a `history.request` (same `id`).
    /// Mirrors HistoryDataSchema. Owner/assistant turns only, chronological, with timestamps.
    case historyData(id: String, turns: [HistoryTurn])
    /// ADDITIVE (daemon→Face): the live `/override` state for the status pill + countdown. Mirrors
    /// OverrideStateSchema. `active:false` → no override (scope/expiresAt meaningless). `expiresAt`
    /// is a millisecond epoch the Face counts down to. NEVER reflects a Red bypass.
    case overrideState(active: Bool, scope: String?, expiresAt: Double?)
    /// ADDITIVE (Face→daemon): update the owner safety posture. Mirrors SettingsUpdateSchema. Every
    /// field optional (one toggle at a time): breaker on/off, daily spend ceiling, /override TTL.
    case settingsUpdate(breakerEnabled: Bool?, dailySpendCeiling: Double?, defaultTtlMs: Int?)
    /// ADDITIVE (daemon→Face): the current owner safety posture for the Settings page. Mirrors
    /// SettingsStateSchema. Broadcast on connect + after a settings.update.
    case settingsState(breakerEnabled: Bool, dailySpendCeiling: Double, defaultTtlMs: Int)
    /// ADDITIVE (Face→daemon): request the recent audit log for the Activity view. Mirrors
    /// AuditQuerySchema. `limit` caps how many recent entries to return.
    case auditQuery(id: String, limit: Int?)
    /// ADDITIVE (daemon→Face): the recent audit entries answering an `audit.query` (same `id`).
    /// Mirrors AuditDataSchema. Safe projection only (tool/outcome/ts).
    case auditData(id: String, entries: [AuditEntry])

    /// The Settings brain toggle enum (mirrors SettingsSchema.brain).
    enum Brain: String, Codable { case cloud, local }

    /// The breaker preview tier (mirrors BreakerPreviewSchema.tier — always `red`).
    enum BreakerTier: String, Codable { case red }

    /// The cloud scene state (mirrors UiStateSchema.state).
    enum SceneState: String, Codable { case fullscreen, cornerPill, idle }

    /// The transcript line author (mirrors TranscriptSchema.role).
    enum TranscriptRole: String, Codable { case kernel, claude }

    private enum CodingKeys: String, CodingKey {
        case type, client, version, id, text, final, intent, payload, brain
        case daemon, cues, onFinish, widget, data, state, message, role, partial
        case summary, estimatedSpend, tier
        // Additive arms: override (Face→daemon), capabilities + stats (daemon→Face).
        case active, ttlMs
        case injectCap, tools, integrations
        case model, promptTokens, outputTokens, tokensPerSec, evalMs, loadMs, totalMs, contextWindow, estCostUsd
        case delta
        case command
        case tool, op, status, detail
        case limit, turns
        // Control-surface additive arms (SAFE-08).
        case scope, expiresAt
        case breakerEnabled, dailySpendCeiling, defaultTtlMs
        case entries
    }

    // MARK: Decode (narrow by `type`, exactly like the zod discriminated union)

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "hello":
            self = .hello(
                client: try c.decode(String.self, forKey: .client),
                version: try c.decode(String.self, forKey: .version))
        case "utterance":
            self = .utterance(
                id: try c.decode(String.self, forKey: .id),
                text: try c.decode(String.self, forKey: .text),
                final: try c.decode(Bool.self, forKey: .final))
        case "ping":
            self = .ping(id: try c.decode(String.self, forKey: .id))
        case "ui.intent":
            self = .uiIntent(
                id: try c.decode(String.self, forKey: .id),
                intent: try c.decode(String.self, forKey: .intent),
                payload: try c.decodeIfPresent(JSONValue.self, forKey: .payload))
        case "settings":
            self = .settings(brain: try c.decode(Brain.self, forKey: .brain))
        case "breaker.cancel":
            self = .breakerCancel(id: try c.decode(String.self, forKey: .id))
        case "override":
            self = .override(
                active: try c.decode(Bool.self, forKey: .active),
                ttlMs: try c.decodeIfPresent(Int.self, forKey: .ttlMs))
        case "capabilities":
            self = .capabilities(
                brain: try c.decode(Brain.self, forKey: .brain),
                daemon: try c.decode(String.self, forKey: .daemon),
                version: try c.decode(String.self, forKey: .version),
                injectCap: try c.decode(Int.self, forKey: .injectCap),
                tools: try c.decode([String].self, forKey: .tools),
                integrations: try c.decode([String].self, forKey: .integrations))
        case "stats":
            self = .stats(
                id: try c.decode(String.self, forKey: .id),
                brain: try c.decode(Brain.self, forKey: .brain),
                model: try c.decodeIfPresent(String.self, forKey: .model),
                promptTokens: try c.decodeIfPresent(Int.self, forKey: .promptTokens),
                outputTokens: try c.decodeIfPresent(Int.self, forKey: .outputTokens),
                tokensPerSec: try c.decodeIfPresent(Double.self, forKey: .tokensPerSec),
                evalMs: try c.decodeIfPresent(Double.self, forKey: .evalMs),
                loadMs: try c.decodeIfPresent(Double.self, forKey: .loadMs),
                totalMs: try c.decodeIfPresent(Double.self, forKey: .totalMs),
                contextWindow: try c.decodeIfPresent(Int.self, forKey: .contextWindow),
                estCostUsd: try c.decodeIfPresent(Double.self, forKey: .estCostUsd))
        case "say":
            self = .say(
                id: try c.decode(String.self, forKey: .id),
                delta: try c.decode(String.self, forKey: .delta),
                final: try c.decode(Bool.self, forKey: .final))
        case "widget.command":
            self = .widgetCommand(
                id: try c.decode(String.self, forKey: .id),
                command: try c.decode(String.self, forKey: .command))
        case "tool.activity":
            self = .toolActivity(
                id: try c.decode(String.self, forKey: .id),
                tool: try c.decode(String.self, forKey: .tool),
                op: try c.decode(String.self, forKey: .op),
                status: try c.decode(String.self, forKey: .status),
                detail: try c.decodeIfPresent(String.self, forKey: .detail))
        case "history.request":
            self = .historyRequest(
                id: try c.decode(String.self, forKey: .id),
                limit: try c.decodeIfPresent(Int.self, forKey: .limit))
        case "history.data":
            self = .historyData(
                id: try c.decode(String.self, forKey: .id),
                turns: try c.decode([HistoryTurn].self, forKey: .turns))
        case "override.state":
            self = .overrideState(
                active: try c.decode(Bool.self, forKey: .active),
                scope: try c.decodeIfPresent(String.self, forKey: .scope),
                expiresAt: try c.decodeIfPresent(Double.self, forKey: .expiresAt))
        case "settings.update":
            self = .settingsUpdate(
                breakerEnabled: try c.decodeIfPresent(Bool.self, forKey: .breakerEnabled),
                dailySpendCeiling: try c.decodeIfPresent(Double.self, forKey: .dailySpendCeiling),
                defaultTtlMs: try c.decodeIfPresent(Int.self, forKey: .defaultTtlMs))
        case "settings.state":
            self = .settingsState(
                breakerEnabled: try c.decode(Bool.self, forKey: .breakerEnabled),
                dailySpendCeiling: try c.decode(Double.self, forKey: .dailySpendCeiling),
                defaultTtlMs: try c.decode(Int.self, forKey: .defaultTtlMs))
        case "audit.query":
            self = .auditQuery(
                id: try c.decode(String.self, forKey: .id),
                limit: try c.decodeIfPresent(Int.self, forKey: .limit))
        case "audit.data":
            self = .auditData(
                id: try c.decode(String.self, forKey: .id),
                entries: try c.decode([AuditEntry].self, forKey: .entries))
        case "breaker.preview":
            self = .breakerPreview(
                id: try c.decode(String.self, forKey: .id),
                summary: try c.decode(String.self, forKey: .summary),
                estimatedSpend: try c.decode(Double.self, forKey: .estimatedSpend),
                tier: try c.decode(BreakerTier.self, forKey: .tier))
        case "ready":
            self = .ready(
                daemon: try c.decode(String.self, forKey: .daemon),
                version: try c.decode(String.self, forKey: .version))
        case "reply":
            self = .reply(
                id: try c.decode(String.self, forKey: .id),
                text: try c.decode(String.self, forKey: .text))
        case "pong":
            self = .pong(id: try c.decode(String.self, forKey: .id))
        case "speak":
            self = .speak(
                id: try c.decode(String.self, forKey: .id),
                text: try c.decode(String.self, forKey: .text),
                cues: try c.decode([FrameCue].self, forKey: .cues),
                onFinish: try c.decodeIfPresent([FrameOnFinish].self, forKey: .onFinish))
        case "widget.data":
            self = .widgetData(
                widget: try c.decode(String.self, forKey: .widget),
                data: try c.decode(JSONValue.self, forKey: .data))
        case "ui.state":
            self = .uiState(state: try c.decode(SceneState.self, forKey: .state))
        case "error":
            self = .error(
                id: try c.decodeIfPresent(String.self, forKey: .id),
                message: try c.decode(String.self, forKey: .message))
        case "transcript":
            self = .transcript(
                id: try c.decode(String.self, forKey: .id),
                role: try c.decode(TranscriptRole.self, forKey: .role),
                text: try c.decode(String.self, forKey: .text),
                partial: try c.decodeIfPresent(Bool.self, forKey: .partial))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type, in: c,
                debugDescription: "Unknown frame type: \(type)")
        }
    }

    // MARK: Encode (re-emit `type` + exactly the arm's fields)

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .hello(let client, let version):
            try c.encode("hello", forKey: .type)
            try c.encode(client, forKey: .client)
            try c.encode(version, forKey: .version)
        case .utterance(let id, let text, let final):
            try c.encode("utterance", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encode(text, forKey: .text)
            try c.encode(final, forKey: .final)
        case .ping(let id):
            try c.encode("ping", forKey: .type)
            try c.encode(id, forKey: .id)
        case .uiIntent(let id, let intent, let payload):
            try c.encode("ui.intent", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encode(intent, forKey: .intent)
            try c.encodeIfPresent(payload, forKey: .payload)
        case .settings(let brain):
            try c.encode("settings", forKey: .type)
            try c.encode(brain, forKey: .brain)
        case .breakerCancel(let id):
            try c.encode("breaker.cancel", forKey: .type)
            try c.encode(id, forKey: .id)
        case .override(let active, let ttlMs):
            try c.encode("override", forKey: .type)
            try c.encode(active, forKey: .active)
            try c.encodeIfPresent(ttlMs, forKey: .ttlMs)
        case .capabilities(let brain, let daemon, let version, let injectCap, let tools, let integrations):
            try c.encode("capabilities", forKey: .type)
            try c.encode(brain, forKey: .brain)
            try c.encode(daemon, forKey: .daemon)
            try c.encode(version, forKey: .version)
            try c.encode(injectCap, forKey: .injectCap)
            try c.encode(tools, forKey: .tools)
            try c.encode(integrations, forKey: .integrations)
        case .stats(let id, let brain, let model, let promptTokens, let outputTokens, let tokensPerSec, let evalMs, let loadMs, let totalMs, let contextWindow, let estCostUsd):
            try c.encode("stats", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encode(brain, forKey: .brain)
            try c.encodeIfPresent(model, forKey: .model)
            try c.encodeIfPresent(promptTokens, forKey: .promptTokens)
            try c.encodeIfPresent(outputTokens, forKey: .outputTokens)
            try c.encodeIfPresent(tokensPerSec, forKey: .tokensPerSec)
            try c.encodeIfPresent(evalMs, forKey: .evalMs)
            try c.encodeIfPresent(loadMs, forKey: .loadMs)
            try c.encodeIfPresent(totalMs, forKey: .totalMs)
            try c.encodeIfPresent(contextWindow, forKey: .contextWindow)
            try c.encodeIfPresent(estCostUsd, forKey: .estCostUsd)
        case .say(let id, let delta, let final):
            try c.encode("say", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encode(delta, forKey: .delta)
            try c.encode(final, forKey: .final)
        case .widgetCommand(let id, let command):
            try c.encode("widget.command", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encode(command, forKey: .command)
        case .toolActivity(let id, let tool, let op, let status, let detail):
            try c.encode("tool.activity", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encode(tool, forKey: .tool)
            try c.encode(op, forKey: .op)
            try c.encode(status, forKey: .status)
            try c.encodeIfPresent(detail, forKey: .detail)
        case .historyRequest(let id, let limit):
            try c.encode("history.request", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encodeIfPresent(limit, forKey: .limit)
        case .historyData(let id, let turns):
            try c.encode("history.data", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encode(turns, forKey: .turns)
        case .overrideState(let active, let scope, let expiresAt):
            try c.encode("override.state", forKey: .type)
            try c.encode(active, forKey: .active)
            try c.encodeIfPresent(scope, forKey: .scope)
            try c.encodeIfPresent(expiresAt, forKey: .expiresAt)
        case .settingsUpdate(let breakerEnabled, let dailySpendCeiling, let defaultTtlMs):
            try c.encode("settings.update", forKey: .type)
            try c.encodeIfPresent(breakerEnabled, forKey: .breakerEnabled)
            try c.encodeIfPresent(dailySpendCeiling, forKey: .dailySpendCeiling)
            try c.encodeIfPresent(defaultTtlMs, forKey: .defaultTtlMs)
        case .settingsState(let breakerEnabled, let dailySpendCeiling, let defaultTtlMs):
            try c.encode("settings.state", forKey: .type)
            try c.encode(breakerEnabled, forKey: .breakerEnabled)
            try c.encode(dailySpendCeiling, forKey: .dailySpendCeiling)
            try c.encode(defaultTtlMs, forKey: .defaultTtlMs)
        case .auditQuery(let id, let limit):
            try c.encode("audit.query", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encodeIfPresent(limit, forKey: .limit)
        case .auditData(let id, let entries):
            try c.encode("audit.data", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encode(entries, forKey: .entries)
        case .breakerPreview(let id, let summary, let estimatedSpend, let tier):
            try c.encode("breaker.preview", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encode(summary, forKey: .summary)
            try c.encode(estimatedSpend, forKey: .estimatedSpend)
            try c.encode(tier, forKey: .tier)
        case .ready(let daemon, let version):
            try c.encode("ready", forKey: .type)
            try c.encode(daemon, forKey: .daemon)
            try c.encode(version, forKey: .version)
        case .reply(let id, let text):
            try c.encode("reply", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encode(text, forKey: .text)
        case .pong(let id):
            try c.encode("pong", forKey: .type)
            try c.encode(id, forKey: .id)
        case .speak(let id, let text, let cues, let onFinish):
            try c.encode("speak", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encode(text, forKey: .text)
            try c.encode(cues, forKey: .cues)
            try c.encodeIfPresent(onFinish, forKey: .onFinish)
        case .widgetData(let widget, let data):
            try c.encode("widget.data", forKey: .type)
            try c.encode(widget, forKey: .widget)
            try c.encode(data, forKey: .data)
        case .uiState(let state):
            try c.encode("ui.state", forKey: .type)
            try c.encode(state, forKey: .state)
        case .error(let id, let message):
            try c.encode("error", forKey: .type)
            try c.encodeIfPresent(id, forKey: .id)
            try c.encode(message, forKey: .message)
        case .transcript(let id, let role, let text, let partial):
            try c.encode("transcript", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encode(role, forKey: .role)
            try c.encode(text, forKey: .text)
            try c.encodeIfPresent(partial, forKey: .partial)
        }
    }
}

// MARK: - Codec (NDJSON line ↔ Frame)

/// Encode/decode a single NDJSON line. The decoder NEVER throws past the caller's
/// `try?` — a malformed line returns nil (mirrors server.ts: a bad line never crashes).
enum FrameCodec {
    static func decode(line: String) -> Frame? {
        guard let data = line.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(Frame.self, from: data)
    }

    /// Encode a frame to a single NDJSON line (NO trailing newline; the socket adds it).
    static func encodeLine(_ frame: Frame) throws -> String {
        let data = try JSONEncoder().encode(frame)
        return String(decoding: data, as: UTF8.self)
    }
}
