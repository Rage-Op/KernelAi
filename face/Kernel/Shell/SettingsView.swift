import SwiftUI

/// The Settings page: the brain toggle + launch-at-login (same controls the menubar exposes),
/// plus a **keys/env status** readout and a **Tools** section that lists what KERNEL can do with
/// tappable example prompts — so the owner can see the tools exist and learn how they get used
/// (the "I have no idea how the tools are meant to be used" gap).
struct SettingsView: View {
    @ObservedObject var coordinator: AppCoordinator
    @State private var env = EnvStatus.load()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Tokens.Space.xl) {
                Text("SETTINGS")
                    .font(Tokens.Typography.monoCaption).tracking(2).foregroundStyle(Tokens.textDim)
                brainSection
                launchSection
                keysSection
                toolsSection
            }
            .frame(maxWidth: 640, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(Tokens.Space.xxl)
        }
        .background(Tokens.canvas)
    }

    // MARK: Brain

    private var brainSection: some View {
        card("BRAIN") {
            Picker("Brain", selection: $coordinator.brain) {
                Text("Local (qwen3.5)").tag(Frame.Brain.local)
                Text("Cloud (Claude)").tag(Frame.Brain.cloud)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .onChange(of: coordinator.brain) { _, newBrain in
                coordinator.persistAndSendBrain(newBrain)
            }
            Text(coordinator.brain == .local
                 ? "Runs on-device via Ollama — uses tools, works offline, no cloud key needed."
                 : "Routes to the cloud Claude brain — needs an Anthropic key in ~/.kernel.env.")
                .font(Tokens.Typography.label).foregroundStyle(Tokens.textMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: Launch at login

    private var launchSection: some View {
        card("STARTUP") {
            Toggle("Launch KERNEL at login", isOn: Binding(
                get: { coordinator.launchAtLogin },
                set: { coordinator.setLaunchAtLogin($0) }))
                .font(Tokens.Typography.body).foregroundStyle(Tokens.textSecondary)
        }
    }

    // MARK: Keys / env

    private var keysSection: some View {
        card("KEYS") {
            keyRow("Web search (Tavily)", ok: env.tavily, hint: "TAVILY_API_KEY")
            keyRow("Cloud brain (Anthropic)", ok: env.anthropic, hint: "ANTHROPIC_API_KEY")
            Text("Add keys to ~/.kernel.env (chmod 600), one per line as `export KEY=value`, then restart the daemon.")
                .font(Tokens.Typography.label).foregroundStyle(Tokens.textMuted)
                .fixedSize(horizontal: false, vertical: true)
            Button("Re-check") { env = EnvStatus.load() }
                .font(Tokens.Typography.label).buttonStyle(.plain).foregroundStyle(Tokens.accentBright)
        }
    }

    private func keyRow(_ label: String, ok: Bool, hint: String) -> some View {
        HStack {
            Circle().fill(ok ? Tokens.statusGreen : Tokens.textDim).frame(width: 8, height: 8)
            Text(label).font(Tokens.Typography.body).foregroundStyle(Tokens.textSecondary)
            Spacer()
            Text(ok ? "configured" : "not set")
                .font(Tokens.Typography.monoLabel)
                .foregroundStyle(ok ? Tokens.statusGreen : Tokens.textMuted)
        }
    }

    // MARK: Tools

    private var toolsSection: some View {
        card("TOOLS") {
            if let tools = coordinator.capabilities?.tools, !tools.isEmpty {
                Text("KERNEL decides when to use these. Tap an example to try it.")
                    .font(Tokens.Typography.label).foregroundStyle(Tokens.textMuted)
                ForEach(tools, id: \.self) { tool in toolRow(tool) }
            } else {
                Text("Waiting for the daemon to report its tools…")
                    .font(Tokens.Typography.label).foregroundStyle(Tokens.textMuted)
            }
        }
    }

    private func toolRow(_ tool: String) -> some View {
        let info = ToolCatalog.info[tool]
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: Tokens.Space.sm) {
                Image(systemName: info?.icon ?? "wrench.and.screwdriver")
                    .font(.system(size: 12)).foregroundStyle(Tokens.accentTerracotta)
                Text(tool).font(Tokens.Typography.monoEmphasis).foregroundStyle(Tokens.textPrimary)
            }
            Text(info?.desc ?? "A KERNEL tool.")
                .font(Tokens.Typography.label).foregroundStyle(Tokens.textMuted)
            if let example = info?.example {
                Button {
                    coordinator.page = .chat
                    coordinator.sendUtterance(example)
                } label: {
                    Text("Try: \(example)")
                        .font(Tokens.Typography.monoLabel).foregroundStyle(Tokens.accentBright)
                }
                .buttonStyle(.plain)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, Tokens.Space.xs)
    }

    // MARK: Card chrome

    private func card<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: Tokens.Space.md) {
            Text(title).font(Tokens.Typography.monoCaption).tracking(2).foregroundStyle(Tokens.textDim)
            content()
        }
        .padding(Tokens.Space.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Tokens.surface, in: RoundedRectangle(cornerRadius: Tokens.Radius.card))
        .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.card).stroke(Tokens.hairline, lineWidth: 1))
    }
}

/// Friendly descriptions + example prompts for the daemon's tool names (tool discoverability).
enum ToolCatalog {
    struct Info { let icon: String; let desc: String; let example: String? }
    static let info: [String: Info] = [
        "web": Info(icon: "globe", desc: "Search and read the live web for up-to-date answers.",
                    example: "What's the latest news about Apple?"),
        "search": Info(icon: "globe", desc: "Search the live web.",
                       example: "Search the web for the new Swift release notes"),
        "finance": Info(icon: "dollarsign.circle", desc: "Your accounts, balances, and spending.",
                        example: "How much did I spend this month?"),
        "mail": Info(icon: "envelope", desc: "Triage your inbox and draft replies.",
                     example: "Summarize my unread email"),
        "peekaboo": Info(icon: "camera.viewfinder", desc: "See and control your screen.",
                         example: "What app is in focus right now?"),
        "browser": Info(icon: "safari", desc: "Browse the web headlessly for automations.",
                        example: nil),
        "claude-code": Info(icon: "chevron.left.forwardslash.chevron.right",
                            desc: "Delegate a coding task to a Claude Code session.", example: nil),
    ]
}

/// Reads ~/.kernel.env to report which keys are configured (the Face is non-sandboxed). It only
/// checks for a non-empty value — it never displays the secret.
struct EnvStatus {
    let tavily: Bool
    let anthropic: Bool

    static func load() -> EnvStatus {
        let path = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".kernel.env")
        guard let text = try? String(contentsOf: path, encoding: .utf8) else {
            return EnvStatus(tavily: false, anthropic: false)
        }
        func hasValue(_ key: String) -> Bool {
            for raw in text.split(separator: "\n") {
                let line = raw.trimmingCharacters(in: .whitespaces)
                guard let r = line.range(of: "\(key)=") else { continue }
                return !line[r.upperBound...].trimmingCharacters(in: .whitespaces).isEmpty
            }
            return false
        }
        return EnvStatus(tavily: hasValue("TAVILY_API_KEY"), anthropic: hasValue("ANTHROPIC_API_KEY"))
    }
}
