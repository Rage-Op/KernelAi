import SwiftUI

/// Design tokens transcribed from the Phase 3 UI-SPEC DESIGN contract
/// (03-UI-SPEC.md). These are the single source of the Face's visual language:
/// near-black spatial canvas, zinc neutrals, ONE accent (indigo↔cyan), hairline
/// borders, SF Pro, a 4-pt spacing grid, and the material set.
///
/// The accent is used ONLY per the UI-SPEC "Accent reserved" list — never for
/// widget backgrounds, body text, icons at rest, or chip fills.
enum Tokens {

    // MARK: Color (60/30/10 split — UI-SPEC Color System)

    /// Dominant (60%): near-black spatial canvas behind the cloud (#08080A).
    static let canvas = Color(red: 0x08 / 255, green: 0x08 / 255, blue: 0x0A / 255)

    // Secondary (30%): zinc neutrals for glass bodies / pill / secondary text.
    /// Surface zinc-900 (#18181B) — frosted-glass widget body tint.
    static let surface = Color(red: 0x18 / 255, green: 0x18 / 255, blue: 0x1B / 255)
    /// Elevated zinc-800 (#27272A).
    static let elevated = Color(red: 0x27 / 255, green: 0x27 / 255, blue: 0x2A / 255)
    /// Primary text zinc-50 (#FAFAFA) — AA+ on every surface.
    static let textPrimary = Color(red: 0xFA / 255, green: 0xFA / 255, blue: 0xFA / 255)
    /// Muted/secondary text zinc-400 (#A1A1AA) — AA for ≥16px body on near-black.
    static let textMuted = Color(red: 0xA1 / 255, green: 0xA1 / 255, blue: 0xAA / 255)

    /// Accent low end (10%, reserved): indigo (#7C8CFF). The living cloud field
    /// drifts between this and `accentCyan` — never a fixed gradient.
    static let accentIndigo = Color(red: 0x7C / 255, green: 0x8C / 255, blue: 0xFF / 255)
    /// Accent high end (10%, reserved): cyan (#42E8E0).
    static let accentCyan = Color(red: 0x42 / 255, green: 0xE8 / 255, blue: 0xE0 / 255)

    /// Destructive (#F87171) — RESERVED, no destructive action ships in Phase 3.
    static let destructive = Color(red: 0xF8 / 255, green: 0x71 / 255, blue: 0x71 / 255)

    /// Hairline borders: white 7% at rest (UI-SPEC: white 6–8%).
    static let hairline = Color.white.opacity(0.07)

    /// SIMD color samples for the Metal shader uniform (the field lives between
    /// these in RGB; the shader interpolates by amplitude/noise).
    static var accentIndigoRGB: SIMD3<Float> { SIMD3(0x7C / 255.0, 0x8C / 255.0, 0xFF / 255.0) }
    static var accentCyanRGB: SIMD3<Float> { SIMD3(0x42 / 255.0, 0xE8 / 255.0, 0xE0 / 255.0) }

    // MARK: Spacing (4-pt grid — UI-SPEC Spacing Scale)

    enum Space {
        static let xs: CGFloat = 4
        static let sm: CGFloat = 8
        static let md: CGFloat = 16
        static let lg: CGFloat = 24   // glass-card interior padding
        static let xl: CGFloat = 32
        static let xxl: CGFloat = 48
        static let xxxl: CGFloat = 64
    }

    // MARK: Corner radii (UI-SPEC: glass widgets 16–20px)

    enum Radius {
        static let widget: CGFloat = 18   // within the 16–20 range
        static let pill: CGFloat = 14
    }

    // MARK: Typography (UI-SPEC: exactly 4 sizes, exactly 2 weights)

    /// SF Pro Display / Text via the system default. Only Regular (400) and
    /// Semibold (600) exist this phase — no light/medium/bold/black.
    enum Typography {
        /// Display 28 / Semibold — count headlines, balances (tabular).
        static let display = Font.system(size: 28, weight: .semibold, design: .default)
        /// Heading 20 / Semibold — widget titles, totals.
        static let heading = Font.system(size: 20, weight: .semibold, design: .default)
        /// Body 16 / Regular.
        static let body = Font.system(size: 16, weight: .regular, design: .default)
        /// Label 14 / Regular — muted metadata (times, locations).
        static let label = Font.system(size: 14, weight: .regular, design: .default)
    }

    // MARK: Materials (UI-SPEC Materials & Depth)

    /// Default frosted glass for an in-focus widget body.
    static let widgetMaterial: Material = .ultraThinMaterial
    /// Denser glass for text/chart-heavy bodies and the corner pill.
    static let denseMaterial: Material = .regularMaterial

    // MARK: Motion convenience (delegates to the Motion Law)

    /// Default spring for state transitions; see `Motion` for the full law.
    static let spring = Motion.cloudState
}
