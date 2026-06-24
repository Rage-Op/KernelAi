import SwiftUI

/// Design tokens for KERNEL's "Personal Agent Runtime" theme — a warm near-black
/// canvas, ONE terracotta accent (Claude clay), green for runtime status, SF Pro
/// for UI and **SF Mono for all runtime/telemetry data**. Transcribed from the
/// owner's design source (`Kernel.html`) + screenshots.
///
/// This is the single source of the Face's visual language. The accent stays
/// RESERVED — the living sphere, the active control, the focus ring, the breaker
/// countdown — never card body fills, body text, or icons at rest.
///
/// Migration note: the prior indigo↔cyan accent names are kept as ALIASES that now
/// resolve to the terracotta accent, so every existing view recolors from one place;
/// they're swept to the semantic names (`accentTerracotta`, `statusGreen`, …) as each
/// component is redesigned.
enum Tokens {

    // MARK: Color — warm canvas / surfaces (60/30/10)

    /// Dominant canvas behind the sphere — warm near-black (#0A0908).
    static let canvas = Color(hex: 0x0A0908)
    /// The deepest well, for vignettes / pressed states (#060504).
    static let canvasDeep = Color(hex: 0x060504)

    /// Warm-dark card body (#14110D) — the default surface for a bloomed card.
    static let surface = Color(hex: 0x14110D)
    /// Slightly raised warm surface (#16110D) — nested fills, chips.
    static let surfaceRaised = Color(hex: 0x16110D)
    /// Elevated, warmer surface (#1A0F09) — the next plane up / hovered.
    static let elevated = Color(hex: 0x1A0F09)

    // MARK: Color — accent (10%, RESERVED) — terracotta / amber

    /// Primary accent: Claude terracotta (#D97757). Active control, sphere core,
    /// focus ring, countdown — never a card fill or body text.
    static let accentTerracotta = Color(hex: 0xD97757)
    /// Amber companion (#CFA06E) — the sphere field drifts between this and terracotta.
    static let accentAmber = Color(hex: 0xCFA06E)
    /// Brighter terracotta (#E8916F) — peaks / hover on the accent.
    static let accentBright = Color(hex: 0xE8916F)
    /// Dim terracotta (#B9543A) — pressed / low-energy accent.
    static let accentDim = Color(hex: 0xB9543A)

    // MARK: Color — status

    /// Online / positive (#5FB37A) — the runtime status dots, "online", up-deltas.
    static let statusGreen = Color(hex: 0x5FB37A)
    /// Softer green (#7EB88F) — secondary positive / checks.
    static let statusGreenSoft = Color(hex: 0x7EB88F)
    /// Warm red (#D9544A) — destructive / urgent (Abort, Urgent badge). RESERVED.
    static let statusRed = Color(hex: 0xD9544A)

    /// Category marker dots (used ONLY as tiny dots, never fills): violet / blue / pink.
    static let catViolet = Color(hex: 0x8A82D6)
    static let catBlue = Color(hex: 0x7AA2D6)
    static let catPink = Color(hex: 0xC98AD0)

    // MARK: Color — text (warm ramp)

    /// Primary text — warm white (#F1ECE3).
    static let textPrimary = Color(hex: 0xF1ECE3)
    /// Secondary text (#CFC6B8) — supporting copy, card subtitles.
    static let textSecondary = Color(hex: 0xCFC6B8)
    /// Muted/metadata text (#A89E90) — times, captions, labels at rest.
    static let textMuted = Color(hex: 0xA89E90)
    /// Dim text / disabled (#6F675C).
    static let textDim = Color(hex: 0x6F675C)

    /// Hairline borders — a warm off-white at ~7% (the design's subtle separators).
    static let hairline = Color(hex: 0xF1ECE3).opacity(0.08)
    /// A stronger warm hairline for a card's leading edge / divider.
    static let hairlineStrong = Color(hex: 0xF1ECE3).opacity(0.14)

    // MARK: SIMD color samples for the Metal sphere shader

    /// The living field interpolates between these in RGB (shader samples by depth/energy).
    static var accentTerracottaRGB: SIMD3<Float> { SIMD3(0xD9 / 255.0, 0x77 / 255.0, 0x57 / 255.0) }
    static var accentAmberRGB: SIMD3<Float> { SIMD3(0xCF / 255.0, 0xA0 / 255.0, 0x6E / 255.0) }
    /// A hot core sample (lighter, pushes toward white-hot at the center).
    static var accentCoreRGB: SIMD3<Float> { SIMD3(0xF1 / 255.0, 0xB0 / 255.0, 0x8E / 255.0) }

    // MARK: Spacing (4-pt grid)

    enum Space {
        static let xs: CGFloat = 4
        static let sm: CGFloat = 8
        static let md: CGFloat = 16
        static let lg: CGFloat = 24   // card interior padding
        static let xl: CGFloat = 32
        static let xxl: CGFloat = 48
        static let xxxl: CGFloat = 64
    }

    // MARK: Corner radii

    enum Radius {
        static let widget: CGFloat = 18
        static let card: CGFloat = 16
        static let pill: CGFloat = 14
        static let chip: CGFloat = 10
    }

    // MARK: Typography — SF Pro (UI) + SF Mono (runtime/telemetry data)

    enum Typography {
        /// Display 28 / Semibold — counts, balances (tabular).
        static let display = Font.system(size: 28, weight: .semibold, design: .default)
        /// The KERNEL wordmark — large, light, WIDE tracking (apply `.tracking(8)` at the view).
        static let wordmark = Font.system(size: 34, weight: .light, design: .default)
        /// Heading 20 / Semibold — card titles, totals.
        static let heading = Font.system(size: 20, weight: .semibold, design: .default)
        /// Body 16 / Regular.
        static let body = Font.system(size: 16, weight: .regular, design: .default)
        /// Label 14 / Regular — muted metadata (times, locations).
        static let label = Font.system(size: 14, weight: .regular, design: .default)

        /// Mono body 14 — runtime data (status lines, paths).
        static let mono = Font.system(size: 14, weight: .regular, design: .monospaced)
        /// Mono label 12 — telemetry strip, port readouts, small counts.
        static let monoLabel = Font.system(size: 12, weight: .regular, design: .monospaced)
        /// Mono caption 11 — the titlebar `:port` / dense telemetry.
        static let monoCaption = Font.system(size: 11, weight: .regular, design: .monospaced)
        /// Mono emphasis 13 / Medium — a highlighted runtime value.
        static let monoEmphasis = Font.system(size: 13, weight: .medium, design: .monospaced)
    }

    // MARK: Materials & card fills

    /// Frosted glass underlay for a bloomed card (kept warm by an overlaid surface tint).
    static let widgetMaterial: Material = .ultraThinMaterial
    /// Denser glass for text/chart-heavy bodies and the corner pill.
    static let denseMaterial: Material = .regularMaterial

    /// The warm translucent card fill that defines the theme's surfaces (over the canvas
    /// or a material). Cards layer this so they read warm, not the system's cool gray glass.
    static let cardFill = Color(hex: 0x14110D).opacity(0.82)
    /// A nested fill (chips, inner wells) one step lighter than `cardFill`.
    static let chipFill = Color(hex: 0x1A0F09).opacity(0.9)

    // MARK: Motion convenience

    static let spring = Motion.cloudState

    // MARK: - Deprecated aliases (resolve to the terracotta theme; swept per-component)

    /// Was indigo; now the primary terracotta accent.
    static let accentIndigo = accentTerracotta
    /// Was cyan; now the primary terracotta accent (the single reserved accent).
    static let accentCyan = accentTerracotta
    /// Was the cool destructive red; now the warm theme red.
    static let destructive = statusRed
    static var accentIndigoRGB: SIMD3<Float> { accentTerracottaRGB }
    static var accentCyanRGB: SIMD3<Float> { accentAmberRGB }
}

// MARK: - Color(hex:) convenience

extension Color {
    /// Build an opaque color from a 0xRRGGBB literal — keeps the token table terse and
    /// greppable against the design's hex values.
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255.0,
            green: Double((hex >> 8) & 0xFF) / 255.0,
            blue: Double(hex & 0xFF) / 255.0)
    }
}
