import Foundation

/// One character-keyed choreography cue, fired when speech crosses `atChar`.
///
/// `atChar` is a character offset into the spoken reply text; the daemon ships
/// cues up front (it NEVER sends timing — ARCHITECTURE Anti-Pattern 1), and the
/// Face owns the clock. `action` is e.g. `stage.present` / `stage.dismiss`.
struct Cue: Equatable, Identifiable {
    let id: Int                 // stable index within the speak frame (dedupe key)
    let atChar: Int
    let action: String
    let widget: String?
    let data: JSONValue?

    init(id: Int, atChar: Int, action: String, widget: String? = nil, data: JSONValue? = nil) {
        self.id = id
        self.atChar = atChar
        self.action = action
        self.widget = widget
        self.data = data
    }

    /// Build the ordered cue list from a decoded `speak` frame's cues, assigning
    /// each a stable index so the StageController can dedupe by identity.
    static func from(frameCues: [FrameCue]) -> [Cue] {
        frameCues.enumerated().map { idx, c in
            Cue(id: idx, atChar: c.atChar, action: c.action, widget: c.widget, data: c.data)
        }
    }
}

/// A choreography action the StageController emits when a cue (or onFinish) fires.
/// The view layer (CloudWindow / EventsWidget) subscribes and animates it.
enum StageAction: Equatable {
    case present(widget: String, data: JSONValue?)
    case dismiss(widget: String)
    /// Any non-present/dismiss action (e.g. a particle burst) keyed by its raw name.
    case other(action: String, widget: String?)
}
