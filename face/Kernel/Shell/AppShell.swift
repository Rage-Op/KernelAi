import SwiftUI

/// The app's root shell: a slim left navigation rail + the active page. `Home` is the living sphere
/// stage (`RuntimeWindow`); `Chat`, `Files`, and `Settings` are dedicated pages. Forces the warm-dark
/// appearance so no system-default (light-mode) control text renders black-on-black — the bug the
/// owner hit. All pages share one `AppCoordinator`, so conversation state stays consistent.
struct AppShell: View {
    @ObservedObject var coordinator: AppCoordinator

    var body: some View {
        HStack(spacing: 0) {
            NavigationRail(coordinator: coordinator)
            Rectangle().fill(Tokens.hairline).frame(width: 1).ignoresSafeArea()
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Tokens.canvas.ignoresSafeArea())
        .preferredColorScheme(.dark)
    }

    @ViewBuilder private var content: some View {
        switch coordinator.page {
        case .home: RuntimeWindow(coordinator: coordinator)
        case .chat: ChatView(coordinator: coordinator)
        case .files: FilesView(coordinator: coordinator)
        case .settings: SettingsView(coordinator: coordinator)
        }
    }
}

/// The vertical icon rail (Home · Chat · Files · Settings) — the app's primary navigation. The active
/// page gets the terracotta accent fill; a live connection dot sits at the bottom.
private struct NavigationRail: View {
    @ObservedObject var coordinator: AppCoordinator

    var body: some View {
        VStack(spacing: Tokens.Space.md) {
            // A small KERNEL mark at the top of the rail.
            Circle()
                .fill(LinearGradient(colors: [Tokens.accentTerracotta, Tokens.accentAmber],
                                     startPoint: .top, endPoint: .bottom))
                .frame(width: 18, height: 18)
                .padding(.top, Tokens.Space.lg)
                .padding(.bottom, Tokens.Space.sm)

            ForEach(AppCoordinator.Page.allCases, id: \.self) { page in
                railButton(page)
            }
            Spacer()
            connectionDot.padding(.bottom, Tokens.Space.lg)
        }
        .frame(width: 64)
        .frame(maxHeight: .infinity)
        .background(Tokens.canvasDeep.ignoresSafeArea())
    }

    private func railButton(_ page: AppCoordinator.Page) -> some View {
        let active = coordinator.page == page
        return Button { coordinator.page = page } label: {
            Image(systemName: icon(page))
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(active ? Tokens.canvas : Tokens.textMuted)
                .frame(width: 40, height: 40)
                .background(Circle().fill(active ? Tokens.accentTerracotta : Color.clear))
        }
        .buttonStyle(.plain)
        .help(label(page))
        .accessibilityLabel(label(page))
    }

    private func icon(_ p: AppCoordinator.Page) -> String {
        switch p {
        case .home: return "house.fill"
        case .chat: return "bubble.left.and.bubble.right.fill"
        case .files: return "folder.fill"
        case .settings: return "gearshape.fill"
        }
    }

    private func label(_ p: AppCoordinator.Page) -> String {
        switch p {
        case .home: return "Home"
        case .chat: return "Chat"
        case .files: return "Files"
        case .settings: return "Settings"
        }
    }

    private var connectionDot: some View {
        Circle()
            .fill(coordinator.connection == .connected ? Tokens.statusGreen : Tokens.textDim)
            .frame(width: 9, height: 9)
            .help(connectionLabel)
            .accessibilityLabel(connectionLabel)
    }

    private var connectionLabel: String {
        switch coordinator.connection {
        case .connected: return "Daemon connected"
        case .connecting: return "Connecting…"
        case .failed: return "Daemon offline"
        case .idle: return "Idle"
        }
    }
}
