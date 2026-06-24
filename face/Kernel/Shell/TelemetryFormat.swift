import Foundation

/// Plain formatting helpers for the always-on telemetry strip + boot screen. Kept tiny and pure so
/// they're unit-testable without a view. Mirrors the CLI dashboard's readouts (tok/s, tokens,
/// context fill, cost) — the "like Claude" runtime surface.
enum TelemetryFormat {

    /// Group an integer with thousands separators: 2418 → "2,418".
    static func commas(_ n: Int) -> String {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.groupingSeparator = ","
        return f.string(from: NSNumber(value: n)) ?? String(n)
    }

    /// "31 tok/s" or "— tok/s" when no measured turn yet. Rounds to whole tokens/sec.
    static func tokensPerSec(_ tps: Double?) -> String {
        guard let tps, tps > 0 else { return "— tok/s" }
        return "\(Int(tps.rounded())) tok/s"
    }

    /// Cost readout. Local turns are $0 (shown plainly); cloud shows up to 4 decimals.
    static func cost(_ usd: Double?) -> String {
        guard let usd, usd > 0 else { return "$0" }
        if usd < 0.01 { return String(format: "$%.4f", usd) }
        return String(format: "$%.2f", usd)
    }

    /// Context fill as a fraction 0..1 and a percent label, given used prompt tokens (or chars) and
    /// the window. Falls back to nil when nothing's known yet.
    static func contextFill(used: Int?, window: Int?) -> (fraction: Double, label: String)? {
        guard let window, window > 0, let used, used >= 0 else { return nil }
        let frac = min(1.0, Double(used) / Double(window))
        return (frac, "\(Int((frac * 100).rounded()))%")
    }

    /// A compact context-window label: 8192 → "8K", 1_000_000 → "1M".
    static func windowLabel(_ window: Int?) -> String {
        guard let window, window > 0 else { return "—" }
        if window >= 1_000_000 { return "\(window / 1_000_000)M" }
        if window >= 1_000 { return "\(window / 1_000)K" }
        return String(window)
    }
}
