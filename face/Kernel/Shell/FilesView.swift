import SwiftUI
import AppKit

/// The Files page: a read-only peek into KERNEL's "brain" directory — `kernel-memory/` holds
/// IDENTITY.md (the soul/purpose contract), `self/`, `knowledge/`, and the day logs. Pick a file to
/// read it in place; "Reveal in Finder" opens the directory. Read-only by design — the Face never
/// edits KERNEL's memory (IDENTITY is never auto-edited).
struct FilesView: View {
    @ObservedObject var coordinator: AppCoordinator

    @State private var entries: [BrainFile] = []
    @State private var selected: BrainFile?
    @State private var content: String = ""

    var body: some View {
        HStack(spacing: 0) {
            fileList
            Rectangle().fill(Tokens.hairline).frame(width: 1)
            detail
        }
        .background(Tokens.canvas)
        .onAppear(perform: reload)
    }

    // MARK: List

    private var fileList: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("BRAIN")
                    .font(Tokens.Typography.monoCaption).tracking(2).foregroundStyle(Tokens.textDim)
                Spacer()
                Button { coordinator.revealBrainDirectory() } label: {
                    Image(systemName: "arrow.up.forward.app").font(.system(size: 12))
                }
                .buttonStyle(.plain).foregroundStyle(Tokens.textMuted).help("Reveal in Finder")
            }
            .padding(.horizontal, Tokens.Space.md).padding(.vertical, Tokens.Space.md)
            Rectangle().fill(Tokens.hairline).frame(height: 1)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 1) {
                    if entries.isEmpty {
                        Text("No memory files found.")
                            .font(Tokens.Typography.label).foregroundStyle(Tokens.textMuted)
                            .padding(Tokens.Space.md)
                    }
                    ForEach(entries) { file in
                        Button { select(file) } label: {
                            Text(file.relativePath)
                                .font(Tokens.Typography.monoLabel)
                                .foregroundStyle(selected?.id == file.id ? Tokens.canvas : Tokens.textSecondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, Tokens.Space.md)
                                .padding(.vertical, Tokens.Space.sm)
                                .background(selected?.id == file.id ? Tokens.accentTerracotta : Color.clear)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .frame(width: 260)
        .background(Tokens.canvasDeep)
    }

    // MARK: Detail

    private var detail: some View {
        Group {
            if let file = selected {
                ScrollView {
                    VStack(alignment: .leading, spacing: Tokens.Space.md) {
                        Text(file.name)
                            .font(Tokens.Typography.heading).foregroundStyle(Tokens.textPrimary)
                        Text(content.isEmpty ? "(empty)" : content)
                            .font(Tokens.Typography.mono)
                            .foregroundStyle(Tokens.textSecondary)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(Tokens.Space.xl)
                }
            } else {
                VStack(spacing: Tokens.Space.md) {
                    Image(systemName: "brain.head.profile").font(.system(size: 34)).foregroundStyle(Tokens.textDim)
                    Text("Select a file to read KERNEL's memory.")
                        .font(Tokens.Typography.body).foregroundStyle(Tokens.textMuted)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: Data

    /// Resolve the brain directory (mirrors `AppCoordinator.revealBrainDirectory`).
    private func brainRoot() -> URL {
        if let override = ProcessInfo.processInfo.environment["KERNEL_MEMORY_PATH"] {
            return URL(fileURLWithPath: override)
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("KernelAi/kernel-memory")
    }

    private func reload() {
        let root = brainRoot()
        let fm = FileManager.default
        var found: [BrainFile] = []
        let allowed: Set<String> = ["md", "txt", "json", "log", "yaml", "yml"]
        if let en = fm.enumerator(at: root, includingPropertiesForKeys: nil,
                                  options: [.skipsHiddenFiles]) {
            for case let url as URL in en {
                guard allowed.contains(url.pathExtension.lowercased()) else { continue }
                let rel = url.path.replacingOccurrences(of: root.path + "/", with: "")
                found.append(BrainFile(url: url, name: url.lastPathComponent, relativePath: rel))
                if found.count >= 300 { break }   // bound the listing
            }
        }
        entries = found.sorted { $0.relativePath.lowercased() < $1.relativePath.lowercased() }
    }

    private func select(_ file: BrainFile) {
        selected = file
        // Read up to ~200 KB so a giant log can't stall the UI.
        if let data = try? Data(contentsOf: file.url),
           let text = String(data: data.prefix(200_000), encoding: .utf8) {
            content = text
        } else {
            content = "(unable to read this file)"
        }
    }
}

/// One file in the brain directory listing.
struct BrainFile: Identifiable, Equatable {
    let url: URL
    let name: String
    let relativePath: String
    var id: String { url.path }
}
