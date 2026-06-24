import Foundation
import AppKit
import os

/// Owns the daemon's lifecycle for the **hybrid** model (the owner's locked decision):
///   - launchd remains the always-on owner of the persistent daemon.
///   - When the app launches and NO daemon answers the socket (e.g. a plain Xcode Cmd+R with launchd
///     not loaded), the supervisor spawns one — so "run the app → the daemon starts" just works.
///   - It spawns the embedded daemon if the app bundle carries one, else the repo daemon at
///     `~/KernelAi/daemon/dist/index.js`. It loads `~/.kernel.env` into the child (so the Tavily /
///     Anthropic keys reach it — the env-less manual-daemon bug) and resolves a real PATH.
///   - On quit it terminates ONLY a daemon it spawned — never a launchd-owned one.
///
/// Safety: even if it races and spawns while launchd's daemon is alive, the daemon's own
/// single-instance guard makes the second copy exit immediately, so there is never a socket fight.
@MainActor
final class DaemonSupervisor {
    private let log = Logger(subsystem: "com.kernel.face", category: "supervisor")
    private var child: Process?
    private var didSpawn = false

    init() {
        NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.terminateIfOwned() }
        }
    }

    /// Spawn the daemon if we haven't already. Idempotent. Returns true if a process was launched.
    @discardableResult
    func spawnIfNeeded() -> Bool {
        guard !didSpawn else { return false }
        guard let entry = daemonEntry() else {
            log.error("cannot locate a daemon entry (bundled or repo) — not spawning")
            return false
        }
        guard let node = nodePath() else {
            log.error("cannot find a node binary on PATH — not spawning")
            return false
        }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: node)
        proc.arguments = [entry.path]
        // daemon/ working dir (entry is …/daemon/dist/index.js).
        proc.currentDirectoryURL = entry.deletingLastPathComponent().deletingLastPathComponent()

        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (env["PATH"] ?? "")
        for (k, v) in loadDotEnv() { env[k] = v }                 // ← Tavily/Anthropic keys
        if env["KERNEL_MEMORY_DIR"] == nil {
            env["KERNEL_MEMORY_DIR"] = repoRoot().appendingPathComponent("kernel-memory").path
        }
        proc.environment = env

        do {
            try proc.run()
            child = proc
            didSpawn = true
            log.info("spawned daemon: \(node, privacy: .public) \(entry.path, privacy: .public)")
            return true
        } catch {
            log.error("failed to spawn daemon: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    /// Terminate the daemon ONLY if this app spawned it (never a launchd-owned daemon).
    func terminateIfOwned() {
        guard didSpawn, let child, child.isRunning else { return }
        log.info("terminating app-spawned daemon on quit")
        child.terminate()
    }

    // MARK: Resolution

    /// The daemon entry point: the bundled copy (`Resources/daemon/dist/index.js`) if the app embeds
    /// one, else the repo copy. nil if neither exists.
    private func daemonEntry() -> URL? {
        let fm = FileManager.default
        if let res = Bundle.main.resourcePath {
            let bundled = URL(fileURLWithPath: res)
                .appendingPathComponent("daemon/dist/index.js")
            // Only use the bundled daemon if its deps were embedded too (else it can't run).
            let bundledModules = URL(fileURLWithPath: res).appendingPathComponent("daemon/node_modules")
            if fm.fileExists(atPath: bundled.path), fm.fileExists(atPath: bundledModules.path) {
                return bundled
            }
        }
        let repo = repoRoot().appendingPathComponent("daemon/dist/index.js")
        return fm.fileExists(atPath: repo.path) ? repo : nil
    }

    private func repoRoot() -> URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("KernelAi")
    }

    private func nodePath() -> String? {
        let candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
        let fm = FileManager.default
        return candidates.first { fm.isExecutableFile(atPath: $0) }
    }

    /// Parse `~/.kernel.env` (`export KEY=value` / `KEY=value`, `#` comments) into a dict. Mirrors
    /// what `kernel-launch.sh` sources for the launchd daemon, so a Face-spawned daemon gets the
    /// same keys.
    private func loadDotEnv() -> [String: String] {
        let path = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".kernel.env")
        guard let text = try? String(contentsOf: path, encoding: .utf8) else { return [:] }
        var out: [String: String] = [:]
        for raw in text.split(separator: "\n") {
            var line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("#") { continue }
            if line.hasPrefix("export ") { line = String(line.dropFirst("export ".count)) }
            guard let eq = line.firstIndex(of: "=") else { continue }
            let key = String(line[..<eq]).trimmingCharacters(in: .whitespaces)
            var val = String(line[line.index(after: eq)...]).trimmingCharacters(in: .whitespaces)
            if val.count >= 2,
               (val.hasPrefix("\"") && val.hasSuffix("\"")) || (val.hasPrefix("'") && val.hasSuffix("'")) {
                val = String(val.dropFirst().dropLast())
            }
            if !key.isEmpty { out[key] = val }
        }
        return out
    }
}
