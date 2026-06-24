import SwiftUI
import AppKit
import PDFKit
import UniformTypeIdentifiers

/// The text input bar — "Message Kernel …" — the typed path that complements voice. Submitting
/// (Return or the send button) emits an `utterance` frame via the coordinator and clears the field.
///
/// ATTACHMENTS (files/text): a paperclip opens a file picker; the selected text/PDF/code file is
/// read, its text extracted (PDFKit for PDFs), size-capped, and sent WITH the message as a fenced,
/// labeled block — no IPC change (the daemon just sees a longer utterance). The local model is
/// text-only, so images aren't supported here. The echoed transcript line stays clean.
struct MessageBar: View {
    @ObservedObject var coordinator: AppCoordinator
    @State private var text = ""
    @State private var attachment: Attachment?
    @FocusState private var focused: Bool

    /// Cap extracted attachment text so it fits the model context (≈ a few thousand tokens).
    private let maxAttachmentChars = 16_000

    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || attachment != nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.sm) {
            if let attachment { attachmentChip(attachment) }
            inputRow
        }
    }

    private var inputRow: some View {
        HStack(spacing: Tokens.Space.sm) {
            Button(action: pickFile) {
                Image(systemName: "paperclip")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Tokens.textMuted)
                    .frame(width: 30, height: 30)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Attach a file")
            .help("Attach a text, code, or PDF file")

            TextField("", text: $text, prompt: prompt, axis: .vertical)
                .textFieldStyle(.plain)
                .font(Tokens.Typography.body)
                .foregroundStyle(Tokens.textPrimary)
                .lineLimit(1...4)
                .focused($focused)
                .onSubmit(send)
                .submitLabel(.send)

            Button(action: send) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(canSend ? Tokens.canvas : Tokens.textMuted)
                    .frame(width: 30, height: 30)
                    .background(
                        Circle().fill(canSend ? Tokens.accentTerracotta : Tokens.chipFill))
            }
            .buttonStyle(.plain)
            .disabled(!canSend)
            .accessibilityLabel("Send message")
        }
        .padding(.leading, Tokens.Space.sm)
        .padding(.trailing, Tokens.Space.sm)
        .padding(.vertical, Tokens.Space.sm)
        .background(Tokens.surface, in: RoundedRectangle(cornerRadius: Tokens.Radius.widget))
        .overlay(
            RoundedRectangle(cornerRadius: Tokens.Radius.widget)
                .stroke(focused ? Tokens.accentTerracotta.opacity(0.5) : Tokens.hairline, lineWidth: 1))
        .animation(Motion.focusRing, value: focused)
    }

    private func attachmentChip(_ a: Attachment) -> some View {
        HStack(spacing: Tokens.Space.xs) {
            Image(systemName: "doc.text").font(.system(size: 11))
            Text("\(a.name) · \(a.text.count) chars").font(Tokens.Typography.monoLabel).lineLimit(1)
            Button { attachment = nil } label: {
                Image(systemName: "xmark.circle.fill").font(.system(size: 12))
            }
            .buttonStyle(.plain)
        }
        .foregroundStyle(Tokens.textSecondary)
        .padding(.horizontal, Tokens.Space.md)
        .padding(.vertical, Tokens.Space.xs)
        .background(Tokens.chipFill, in: Capsule())
    }

    private var prompt: Text {
        Text("Message Kernel — ask about spend, email, your day…")
            .foregroundColor(Tokens.textDim)
    }

    private func send() {
        guard canSend else { return }
        let typed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let a = attachment {
            // Send the extracted file content as a fenced block, then the owner's message. Echo a
            // clean one-line display so the transcript isn't flooded with the file body.
            let payload = "[Attached file: \(a.name)]\n```\n\(a.text)\n```\n\(typed)"
            let display = typed.isEmpty ? "📎 \(a.name)" : "📎 \(a.name) — \(typed)"
            coordinator.sendUtterance(payload, display: display)
        } else {
            coordinator.sendUtterance(typed)
        }
        text = ""
        attachment = nil
    }

    /// Open a file picker (text/code/PDF only), read & extract the text, and stage it as a chip.
    private func pickFile() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.text, .plainText, .pdf, .json, .sourceCode, .commaSeparatedText]
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let name = url.lastPathComponent
        let extracted = Self.extractText(from: url) ?? ""
        if extracted.isEmpty {
            attachment = Attachment(name: name, text: "(could not read text from \(name))")
        } else {
            attachment = Attachment(name: name, text: String(extracted.prefix(maxAttachmentChars)))
        }
        focused = true
    }

    /// Extract plain text from a supported file: PDFKit for PDFs, UTF-8 for everything else.
    static func extractText(from url: URL) -> String? {
        if url.pathExtension.lowercased() == "pdf" {
            return PDFDocument(url: url)?.string
        }
        if let data = try? Data(contentsOf: url) {
            return String(data: data, encoding: .utf8)
        }
        return nil
    }
}

/// A staged file attachment: its display name and the extracted text sent to the model.
struct Attachment: Equatable {
    let name: String
    let text: String
}
