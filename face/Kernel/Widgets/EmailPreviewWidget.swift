import SwiftUI

/// The email-preview "Send it?" glass card (04-UI-SPEC §3; MAIL-04/05) — the Yellow gate.
///
/// Renders To / Subject / body / signature read-only, exactly as it will send. If the To
/// address came from external content, a subtle accent-ringed "external" marker is shown next
/// to it (never silently send to it). Only TWO controls: Edit and Send. There is NO auto-send
/// path — nothing sends until the user taps Send, which emits a `ui.intent{intent:'send-email'}`
/// the daemon dispatches through the gate (the actual send wiring lands in 04-02). Renders ONLY
/// typed structured fields (T-04-04: no AsyncImage / URLRequest / WKWebView).

/// The email-preview payload, decoded defensively from a `JSONValue` (never trusts shape).
struct EmailPreviewPayload: Equatable {
    let to: String
    let subject: String
    let body: String
    let signature: String
    let toIsExternal: Bool   // true → show the accent-ringed "external" marker before Send
    let errored: Bool

    static func from(_ json: JSONValue?) -> EmailPreviewPayload {
        guard let obj = json?.objectValue else {
            return EmailPreviewPayload(to: "", subject: "", body: "", signature: "",
                                       toIsExternal: false, errored: false)
        }
        if obj["error"]?.stringValue != nil || (obj["errored"]?.doubleValue ?? 0) == 1 {
            return EmailPreviewPayload(to: "", subject: "", body: "", signature: "",
                                       toIsExternal: false, errored: true)
        }
        // The To address is external when the payload tags its source as external.
        let source = obj["toSource"]?.stringValue ?? obj["source"]?.stringValue
        return EmailPreviewPayload(
            to: obj["to"]?.stringValue ?? "",
            subject: obj["subject"]?.stringValue ?? "",
            body: obj["body"]?.stringValue ?? "",
            signature: obj["signature"]?.stringValue ?? "",
            toIsExternal: source == "external",
            errored: false)
    }
}

struct EmailPreviewWidget: View {
    let payload: EmailPreviewPayload
    let isPresented: Bool
    /// The ONLY send path: tapping Send invokes this so the parent emits a `ui.intent`.
    /// There is no code path that sends without this being called (MAIL-05 no-auto-send).
    var onSend: ((EmailPreviewPayload) -> Void)? = nil
    /// Re-open the intent to re-preview.
    var onEdit: (() -> Void)? = nil

    /// After the user taps Send, the card shows a one-line "Sent. Marked read." confirmation.
    /// This is a UI acknowledgement only — the daemon performs the gated send (MAIL-05).
    @State private var didSend = false

    var body: some View {
        content
            .padding(Tokens.Space.lg)
            .frame(maxWidth: 400, alignment: .leading)
            .background(Tokens.denseMaterial, in: RoundedRectangle(cornerRadius: Tokens.Radius.widget))
            .overlay(
                RoundedRectangle(cornerRadius: Tokens.Radius.widget)
                    .stroke(Tokens.hairline, lineWidth: 1))
            .scaleEffect(isPresented ? Motion.bloomEndScale : Motion.bloomStartScale)
            .opacity(isPresented ? 1 : 0)
            .blur(radius: isPresented ? 0 : Motion.depthBlurRadius)
            .animation(isPresented ? Motion.bloom : Motion.dissolve, value: isPresented)
    }

    @ViewBuilder
    private var content: some View {
        if payload.errored {
            Text("Draft unavailable.")
                .font(Tokens.Typography.heading)
                .foregroundStyle(Tokens.textPrimary)
        } else if didSend {
            // One-line confirmation after the explicit Send (no credentials, ever).
            Text("Sent. Marked read.")
                .font(Tokens.Typography.heading)
                .foregroundStyle(Tokens.textPrimary)
        } else {
            populated
        }
    }

    private var populated: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.md) {
            // To (addresses in Label 14) + external marker when externally sourced.
            HStack(spacing: Tokens.Space.sm) {
                Text("To")
                    .font(Tokens.Typography.label)
                    .foregroundStyle(Tokens.textMuted)
                Text(payload.to)
                    .font(Tokens.Typography.label)
                    .foregroundStyle(Tokens.textPrimary)
                if payload.toIsExternal {
                    Text("external")
                        .font(Tokens.Typography.label)
                        .foregroundStyle(Tokens.accentCyan)
                        .padding(.horizontal, Tokens.Space.sm)
                        .frame(minHeight: 22)
                        .overlay(Capsule().stroke(Tokens.accentCyan, lineWidth: 1)) // accent-ringed marker
                }
            }
            // Subject.
            Text(payload.subject)
                .font(Tokens.Typography.heading)
                .foregroundStyle(Tokens.textPrimary)
            // Body (Body 16) + signature, read-only.
            Text(payload.body)
                .font(Tokens.Typography.body)
                .foregroundStyle(Tokens.textPrimary)
            if !payload.signature.isEmpty {
                Text(payload.signature)
                    .font(Tokens.Typography.label)
                    .foregroundStyle(Tokens.textMuted)
            }
            controls
        }
    }

    /// Exactly two controls: Edit (re-preview) and Send (the single accent-filled CTA).
    private var controls: some View {
        HStack(spacing: Tokens.Space.md) {
            Button {
                onEdit?()
            } label: {
                Text("Edit")
                    .font(Tokens.Typography.body)
                    .foregroundStyle(Tokens.textPrimary)
                    .padding(.horizontal, Tokens.Space.lg)
                    .frame(minHeight: 44)
                    .overlay(Capsule().stroke(Tokens.hairline, lineWidth: 1))
            }
            .buttonStyle(.plain)

            Button {
                // The ONLY send path — emits the Yellow ui.intent via the parent. The daemon
                // dispatches the gated send; this card then shows the "Sent. Marked read." line.
                onSend?(payload)
                didSend = true
            } label: {
                Text("Send")
                    .font(Tokens.Typography.body)
                    .foregroundStyle(Tokens.canvas)
                    .padding(.horizontal, Tokens.Space.lg)
                    .frame(minHeight: 44)
                    .background(Capsule().fill(Tokens.accentCyan))   // accent-filled CTA
            }
            .buttonStyle(.plain)
        }
    }
}
