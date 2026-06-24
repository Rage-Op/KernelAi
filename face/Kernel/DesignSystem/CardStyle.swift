import SwiftUI

/// The shared "Personal Agent Runtime" card chrome — a warm, frosted surface that blooms from the
/// cloud and dissolves back into it. Every widget wears this so the theme stays consistent in one
/// place: warm tint over a thin material, a hairline edge, soft depth shadow, and the bloom/dissolve
/// motion (scale + opacity + forward-blur — nothing snaps).
extension View {
    func kernelCard(isPresented: Bool, maxWidth: CGFloat = 360) -> some View {
        self
            .padding(Tokens.Space.lg)
            .frame(maxWidth: maxWidth, alignment: .leading)
            .background {
                ZStack {
                    RoundedRectangle(cornerRadius: Tokens.Radius.widget, style: .continuous)
                        .fill(.ultraThinMaterial)
                    RoundedRectangle(cornerRadius: Tokens.Radius.widget, style: .continuous)
                        .fill(Tokens.surface.opacity(0.86))   // warm tint so the glass reads warm
                }
            }
            .overlay {
                RoundedRectangle(cornerRadius: Tokens.Radius.widget, style: .continuous)
                    .stroke(Tokens.hairline, lineWidth: 1)
            }
            .shadow(color: .black.opacity(0.45), radius: 20, x: 0, y: 10)
            .scaleEffect(isPresented ? Motion.bloomEndScale : Motion.bloomStartScale)
            .opacity(isPresented ? 1 : 0)
            .blur(radius: isPresented ? 0 : Motion.depthBlurRadius)
            .animation(isPresented ? Motion.bloom : Motion.dissolve, value: isPresented)
    }
}

/// A card title row: a small color marker dot + the title, with optional trailing content (a toggle,
/// a badge). Matches the design's "● Inbox summary … overnight" header pattern.
struct CardHeader<Trailing: View>: View {
    let dot: Color
    let title: String
    let trailing: Trailing

    init(dot: Color, title: String, @ViewBuilder trailing: () -> Trailing) {
        self.dot = dot
        self.title = title
        self.trailing = trailing()
    }

    var body: some View {
        HStack(spacing: Tokens.Space.sm) {
            RoundedRectangle(cornerRadius: 2, style: .continuous)
                .fill(dot)
                .frame(width: 8, height: 8)
            Text(title)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Tokens.textPrimary)
            Spacer(minLength: Tokens.Space.sm)
            trailing
        }
    }
}

extension CardHeader where Trailing == EmptyView {
    init(dot: Color, title: String) {
        self.init(dot: dot, title: title) { EmptyView() }
    }
}
