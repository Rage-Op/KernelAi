import SwiftUI

/// The Motion Law (03-UI-SPEC.md "Motion Law" — load-bearing).
///
/// The one rule: **nothing ever snaps.** Everything eases, drifts, settles;
/// numbers count up. Every spring constant below is transcribed verbatim from
/// the UI-SPEC Motion Law table so the choreography can be greppable to it.
///
/// If a callback is missed, the fallback path must STILL ease — never snap into
/// place. There is intentionally no `.linear` / `.easeIn` step animation here.
enum Motion {

    // MARK: Springs (response / dampingFraction) — UI-SPEC Motion Law table

    /// Widget bloom (present): scale 0.96→1.0, opacity 0→1, forward-blur clears to 0.
    static let bloom = Animation.spring(response: 0.5, dampingFraction: 0.8)

    /// Widget dissolve (dismiss): scale 1.0→0.96, opacity 1→0, blur returns as it recedes.
    static let dissolve = Animation.spring(response: 0.45, dampingFraction: 0.85)

    /// Cloud full-screen ↔ corner-pill scene migration. No snap, no hard cut.
    static let cloudState = Animation.spring(response: 0.6, dampingFraction: 0.8)

    /// TTS boundary burst: localized particle burst + brighten flash, quick settle.
    static let boundaryBurst = Animation.spring(response: 0.3, dampingFraction: 0.7)

    /// Focus / active ring: gentle fade-in of the accent hairline/glow.
    static let focusRing = Animation.spring(response: 0.35, dampingFraction: 0.9)

    // MARK: Count-up (numbers ease to their final value — UI-SPEC Motion Law)

    /// Number count-up: ease-out, 0.6–0.9s to the final value. Tabular numerals
    /// keep the width stable while it counts. We use the mid-point of the range.
    static let countUpDuration: TimeInterval = 0.75
    static let countUp = Animation.easeOut(duration: countUpDuration)

    // MARK: Bloom/dissolve geometry constants (the scale + blur endpoints)

    /// Scale a widget starts/ends at when blooming from / dissolving into the cloud.
    static let bloomStartScale: CGFloat = 0.96
    static let bloomEndScale: CGFloat = 1.0

    /// Depth blur applied to an out-of-focus surface (UI-SPEC Depth Law, ~8–16pt).
    static let depthBlurRadius: CGFloat = 12
    /// Out-of-focus dim (UI-SPEC Depth Law, ~40–60% opacity → render at the lighter end).
    static let depthDimOpacity: Double = 0.5
}
