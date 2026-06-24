import SwiftUI

/// The text input bar — "Message Kernel …" — the typed path that complements voice. Submitting
/// (Return or the send button) emits an `utterance` frame via the coordinator and clears the field.
/// The owner's words echo into the transcript immediately and the sphere flips to its thinking
/// resonance.
struct MessageBar: View {
    @ObservedObject var coordinator: AppCoordinator
    @State private var text = ""
    @FocusState private var focused: Bool

    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        HStack(spacing: Tokens.Space.sm) {
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
        .padding(.leading, Tokens.Space.lg)
        .padding(.trailing, Tokens.Space.sm)
        .padding(.vertical, Tokens.Space.sm)
        .background(Tokens.surface, in: RoundedRectangle(cornerRadius: Tokens.Radius.widget))
        .overlay(
            RoundedRectangle(cornerRadius: Tokens.Radius.widget)
                .stroke(focused ? Tokens.accentTerracotta.opacity(0.5) : Tokens.hairline, lineWidth: 1))
        .animation(Motion.focusRing, value: focused)
    }

    private var prompt: Text {
        Text("Message Kernel — ask about spend, email, your day…")
            .foregroundColor(Tokens.textDim)
    }

    private func send() {
        guard canSend else { return }
        coordinator.sendUtterance(text)
        text = ""
    }
}
