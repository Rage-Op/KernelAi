import SwiftUI

/// The widget DISPLAYER (WS4) — a panel that slides in from the right while the sphere minimizes to
/// the left. It renders a parsed `WidgetSpec`: a titled card with the command's fields and its
/// options. An option carrying `(auto Ns)` shows a live countdown and auto-fires when it elapses
/// (the design's `send(auto 15s)`), unless the owner taps another option or aborts first.
///
/// The displayer NEVER acts on an option itself — `onOption` hands it up so the coordinator emits a
/// gate-routed `ui.intent` (send/abort stay chokepointed at the daemon). `onDismiss` just closes it.
struct WidgetDisplayer: View {
    let spec: WidgetSpec
    var onOption: (WidgetSpec, WidgetOption) -> Void
    var onDismiss: (WidgetSpec) -> Void

    @State private var remaining: Int = 0
    /// When the panel appeared — the auto-fire is gated on REAL elapsed time since this, so no amount
    /// of spurious re-renders / extra timer ticks can fire it early (the bug that auto-dismissed it).
    @State private var appearedAt: Date?
    @State private var didFire = false
    private let ticker = Timer.publish(every: 0.5, on: .main, in: .common).autoconnect()

    private var autoOption: WidgetOption? { spec.options.first { $0.autoSeconds != nil } }

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.lg) {
            header
            if !spec.fields.isEmpty { fieldsView }
            if autoOption != nil { autoHint }
            controls
        }
        .padding(Tokens.Space.xl)
        .frame(width: 360, alignment: .topLeading)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Tokens.surface)
        .overlay(alignment: .leading) { Rectangle().fill(Tokens.hairline).frame(width: 1) }
        .onAppear {
            if appearedAt == nil {
                appearedAt = Date()
                remaining = autoOption?.autoSeconds ?? 0
            }
        }
        .onReceive(ticker) { _ in tick() }
    }

    // MARK: Header — kind icon + title + a quiet close

    private var header: some View {
        HStack(spacing: Tokens.Space.sm) {
            Image(systemName: icon)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(Tokens.accentTerracotta)
            Text(spec.title)
                .font(Tokens.Typography.heading)
                .foregroundStyle(Tokens.textPrimary)
            Spacer()
            Button { onDismiss(spec) } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Tokens.textMuted)
                    .frame(width: 28, height: 28)
                    .background(Circle().fill(Tokens.chipFill))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close")
        }
    }

    private var icon: String {
        switch spec.kind {
        case "email", "mail": return "envelope.fill"
        case "note", "memo": return "note.text"
        case "list", "tasks": return "list.bullet"
        case "event", "calendar": return "calendar"
        case "spend", "spending", "finance": return "dollarsign.circle"
        default: return "square.grid.2x2"
        }
    }

    // MARK: Fields — key→value rows; a long "content"/"body" renders as a warm well

    private var fieldsView: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.md) {
            ForEach(spec.fields) { field in
                if field.key == "content" || field.key == "body" {
                    Text(field.value)
                        .font(Tokens.Typography.body)
                        .foregroundStyle(Tokens.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(Tokens.Space.md)
                        .background(Tokens.chipFill, in: RoundedRectangle(cornerRadius: Tokens.Radius.chip, style: .continuous))
                } else {
                    HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.sm) {
                        Text(field.key.uppercased())
                            .font(Tokens.Typography.monoCaption)
                            .foregroundStyle(Tokens.textDim)
                            .frame(width: 64, alignment: .leading)
                        Text(field.value)
                            .font(Tokens.Typography.body)
                            .foregroundStyle(Tokens.textPrimary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }

    private var autoHint: some View {
        Text(autoHintText)
            .font(Tokens.Typography.label)
            .foregroundStyle(Tokens.textMuted)
    }

    private var autoHintText: String {
        guard let auto = autoOption else { return "" }
        return "\(auto.label) auto-fires in \(remaining)s unless you choose."
    }

    // MARK: Controls — one button per option; the auto option shows its countdown

    private var controls: some View {
        HStack(spacing: Tokens.Space.md) {
            ForEach(spec.options) { option in
                optionButton(option)
            }
        }
    }

    private func optionButton(_ option: WidgetOption) -> some View {
        let isAuto = option.autoSeconds != nil
        let label = isAuto ? "\(option.label) (\(remaining)s)" : option.label
        return Button {
            didFire = true   // cancel the auto-timer once a choice is made
            onOption(spec, option)
        } label: {
            Text(label)
                .font(Tokens.Typography.body)
                .foregroundStyle(foreground(option))
                .padding(.horizontal, Tokens.Space.lg)
                .frame(minHeight: 44)
                .frame(maxWidth: option.kind == .confirm ? .infinity : nil)
                .background(background(option))
                .overlay(border(option))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(option.label)
    }

    private func foreground(_ o: WidgetOption) -> Color {
        o.kind == .confirm ? Tokens.canvas : (o.kind == .abort ? Tokens.statusRed : Tokens.textSecondary)
    }

    @ViewBuilder private func background(_ o: WidgetOption) -> some View {
        if o.kind == .confirm { Capsule().fill(Tokens.accentTerracotta) } else { Capsule().fill(Color.clear) }
    }

    @ViewBuilder private func border(_ o: WidgetOption) -> some View {
        if o.kind == .confirm { EmptyView() }
        else { Capsule().stroke(o.kind == .abort ? Tokens.statusRed.opacity(0.6) : Tokens.hairline, lineWidth: 1) }
    }

    // MARK: Auto-fire countdown

    private func tick() {
        guard let auto = autoOption, let start = appearedAt, !didFire,
              let total = auto.autoSeconds, total > 0 else { return }
        let elapsed = Date().timeIntervalSince(start)
        remaining = max(0, total - Int(elapsed))
        if elapsed >= Double(total) {   // fires ONLY after `total` real seconds — never early
            didFire = true
            onOption(spec, auto)
        }
    }
}
