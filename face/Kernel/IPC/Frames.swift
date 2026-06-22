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
    // daemon → Face
    case ready(daemon: String, version: String)
    case reply(id: String, text: String)
    case pong(id: String)
    case speak(id: String, text: String, cues: [FrameCue], onFinish: [FrameOnFinish]?)
    case widgetData(widget: String, data: JSONValue)
    case uiState(state: SceneState)
    case error(id: String?, message: String)

    /// The Settings brain toggle enum (mirrors SettingsSchema.brain).
    enum Brain: String, Codable { case cloud, local }

    /// The cloud scene state (mirrors UiStateSchema.state).
    enum SceneState: String, Codable { case fullscreen, cornerPill, idle }

    private enum CodingKeys: String, CodingKey {
        case type, client, version, id, text, final, intent, payload, brain
        case daemon, cues, onFinish, widget, data, state, message
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
