import SwiftUI

/// Design tokens seeded from the Phase 3 UI-SPEC DESIGN contract.
///
/// The Stage / CloudView in 03-04 will consume these; the shell seeds them now
/// so the single accent rule and spatial-black canvas are established from the
/// first build (UI-SPEC: "ONE accent only", "deep spatial black base").
enum Tokens {

    // MARK: Color (60/30/10 split — UI-SPEC Color System)

    /// Dominant (60%): near-black spatial canvas behind the cloud.
    static let canvas = Color(red: 0x08 / 255, green: 0x08 / 255, blue: 0x0A / 255) // #08080A

    /// Accent low end (10%, reserved): indigo. The living cloud field drifts
    /// between this and `accentCyan` — never a fixed gradient.
    static let accentIndigo = Color(red: 0x7C / 255, green: 0x8C / 255, blue: 0xFF / 255) // #7C8CFF

    /// Accent high end (10%, reserved): cyan.
    static let accentCyan = Color(red: 0x42 / 255, green: 0xE8 / 255, blue: 0xE0 / 255) // #42E8E0

    /// Hairline borders: white 6–8% at rest.
    static let hairline = Color.white.opacity(0.07)

    // MARK: Spacing (4-pt grid — UI-SPEC Spacing Scale)

    enum Space {
        static let xs: CGFloat = 4
        static let sm: CGFloat = 8
        static let md: CGFloat = 16
        static let lg: CGFloat = 24
        static let xl: CGFloat = 32
    }

    // MARK: Motion (UI-SPEC Motion Law — "nothing snaps")

    /// Default spring for state transitions (full-screen <-> corner pill, blooms).
    static let spring = Animation.spring(response: 0.5, dampingFraction: 0.8)
}
