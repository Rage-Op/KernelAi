import Foundation

/// The widget-displayer COMMAND LANGUAGE (WS4). KERNEL (or `/widget …` typed locally) emits a single
/// string; this parses it into a `WidgetSpec` the displayer renders. Grammar:
///
///   `<verb> <kind> key:value key:value … options:opt,opt(auto Ns)`
///
/// e.g. `focus email to:john@x.com from:Acme subject:Renewal content:Let's proceed
///        options:abort,send(auto 15s)`
///
/// Values run until the next ` key:` token (so they may contain spaces). `options:` is a
/// comma-list; an option may carry an `(auto Ns)` auto-fire timer (the design's "send(auto 15s)").

/// One key:value field parsed from the command (ordered as written).
struct WidgetField: Identifiable, Equatable {
    let id = UUID()
    let key: String
    let value: String
}

/// One actionable option. `autoSeconds` (when set) auto-fires the option after a countdown unless
/// the owner picks/aborts first — the configurable interactivity the displayer offers.
struct WidgetOption: Identifiable, Equatable {
    enum Kind: Equatable { case confirm, abort, neutral }
    let id = UUID()
    let label: String
    let kind: Kind
    let autoSeconds: Int?
}

/// A parsed, renderable widget command.
struct WidgetSpec: Identifiable, Equatable {
    /// Correlation id (echoed back in the option `ui.intent` so the daemon matches the response).
    let id: String
    let verb: String
    let kind: String
    let title: String
    let fields: [WidgetField]
    let options: [WidgetOption]
}

enum WidgetCommand {
    /// Parse a command string into a `WidgetSpec`, or nil if it isn't a valid command.
    static func parse(id: String, _ raw: String) -> WidgetSpec? {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }

        // verb + kind = the first two whitespace tokens; the rest is "key:value …".
        let head = text.split(separator: " ", maxSplits: 2, omittingEmptySubsequences: true)
        guard head.count >= 2 else { return nil }
        let verb = head[0].lowercased()
        let kind = head[1].lowercased()
        let rest = head.count == 3 ? String(head[2]) : ""

        var fields: [WidgetField] = []
        var optionsRaw: String?

        // Key boundaries: a `word:` preceded by start-or-whitespace. Each value runs to the next key.
        let ns = rest as NSString
        let keyRegex = try? NSRegularExpression(pattern: "(?:^|\\s)([A-Za-z][\\w-]*):")
        let matches = keyRegex?.matches(in: rest, range: NSRange(location: 0, length: ns.length)) ?? []
        for (i, m) in matches.enumerated() {
            let key = ns.substring(with: m.range(at: 1)).lowercased()
            let valStart = m.range.location + m.range.length
            let valEnd = (i + 1 < matches.count) ? matches[i + 1].range.location : ns.length
            let value = ns
                .substring(with: NSRange(location: valStart, length: max(0, valEnd - valStart)))
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if key == "options" {
                optionsRaw = value
            } else if !value.isEmpty {
                fields.append(WidgetField(key: key, value: value))
            }
        }

        let title = kind.isEmpty ? "Widget" : kind.prefix(1).uppercased() + kind.dropFirst()
        return WidgetSpec(
            id: id, verb: verb, kind: kind, title: title,
            fields: fields, options: parseOptions(optionsRaw))
    }

    /// Parse `abort,send(auto 15s)` → [.abort, .confirm(auto: 15)].
    static func parseOptions(_ raw: String?) -> [WidgetOption] {
        guard let raw, !raw.isEmpty else { return [] }
        return raw.split(separator: ",").compactMap { part in
            let s = part.trimmingCharacters(in: .whitespaces)
            guard !s.isEmpty else { return nil }
            var name = s
            var autoSeconds: Int?
            if let r = s.range(of: "\\(\\s*auto\\s+\\d+\\s*s?\\s*\\)", options: .regularExpression) {
                let digits = String(s[r].filter(\.isNumber))   // robust: "(auto 15s)" → "15"
                autoSeconds = Int(digits)
                name = String(s[..<r.lowerBound]).trimmingCharacters(in: .whitespaces)
            }
            return WidgetOption(label: name, kind: optionKind(name), autoSeconds: autoSeconds)
        }
    }

    private static func optionKind(_ name: String) -> WidgetOption.Kind {
        switch name.lowercased() {
        case "abort", "cancel", "dismiss", "no", "reject", "discard": return .abort
        case "send", "confirm", "approve", "ok", "yes", "accept", "save": return .confirm
        default: return .neutral
        }
    }
}
