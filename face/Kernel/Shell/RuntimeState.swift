import Foundation

/// Face-local view models for the daemon's `capabilities` + `stats` telemetry frames, plus a
/// cumulative session-usage accumulator that mirrors the daemon's `session-usage.ts`. These feed
/// the boot/runtime-status screen and the always-on telemetry strip — the "like Claude" readouts.
///
/// The Frame enum's associated values aren't storable as published state, so the coordinator
/// decodes each frame into one of these once and republishes it.

/// One line of the on-screen YOU ↔ KERNEL conversation (the design's stage transcript). Distinct
/// from the Claude Code `TranscriptLine` (which is the kernel↔claude session shown in the pill).
struct ConversationLine: Identifiable, Equatable {
    enum Role { case you, kernel }
    let id: Int
    let role: Role
    var text: String
}

/// Decoded `capabilities` frame — the daemon's runtime surface, pushed once on connect.
struct RuntimeCapabilities: Equatable {
    let brain: Frame.Brain
    let daemon: String
    let version: String
    /// Memory-injection context cap in characters (daemon config.injectCap).
    let injectCap: Int
    let tools: [String]
    let integrations: [String]

    /// The model label shown in the titlebar / boot screen. The daemon doesn't send a model name in
    /// `capabilities` (it's per-turn in `stats`); derive a sensible default from the brain so the
    /// boot screen reads well before the first turn.
    var brainLabel: String { brain == .local ? "ollama" : "claude" }
}

/// Decoded `stats` frame — per-turn telemetry. All metrics optional (a brain that doesn't measure
/// sends only id/brain).
struct TurnStats: Equatable {
    let id: String
    let brain: Frame.Brain
    let model: String?
    let promptTokens: Int?
    let outputTokens: Int?
    let tokensPerSec: Double?
    let evalMs: Double?
    let loadMs: Double?
    let totalMs: Double?
    let contextWindow: Int?
    let estCostUsd: Double?

    /// Tokens that filled the model's context this turn (prompt side) — for the context fill bar.
    var promptFill: Int? { promptTokens }
}

/// Cumulative session usage — folds in every `stats` turn, mirroring the daemon's authoritative
/// accumulator so the Face can show session totals without a round-trip.
struct SessionUsage: Equatable {
    private(set) var turns = 0
    private(set) var totalPromptTokens = 0
    private(set) var totalOutputTokens = 0
    private(set) var totalCostUsd = 0.0
    private(set) var lastTokensPerSec: Double?
    private(set) var lastModel: String?
    private(set) var lastBrain: Frame.Brain?
    private(set) var lastPromptTokens: Int?

    var totalTokens: Int { totalPromptTokens + totalOutputTokens }

    /// Fold one turn's stats into the running totals.
    mutating func record(_ s: TurnStats) {
        turns += 1
        totalPromptTokens += s.promptTokens ?? 0
        totalOutputTokens += s.outputTokens ?? 0
        totalCostUsd += s.estCostUsd ?? 0
        if let tps = s.tokensPerSec { lastTokensPerSec = tps }
        if let m = s.model { lastModel = m }
        lastBrain = s.brain
        if let p = s.promptTokens { lastPromptTokens = p }
    }
}
