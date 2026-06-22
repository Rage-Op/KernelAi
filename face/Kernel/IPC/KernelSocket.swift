import Foundation
import Network
import os

/// NWConnection client to the daemon's Unix-domain socket
/// (`~/Library/Application Support/Kernel/kernel.sock`), speaking NDJSON frames
/// that mirror the frozen FrameSchema.
///
/// PARTIAL-FRAME-SAFE: a single `receive` may deliver 0..n complete lines plus a
/// trailing partial, so a per-connection byte buffer carries the partial across
/// reads — the EXACT discipline daemon/src/ipc/server.ts `attachReader` uses
/// (RESEARCH Pitfall 3 / T-03-13). A malformed line is dropped, never fatal.
///
/// The socket is the ONLY remote attach surface; UDS is file-permission scoped
/// (no network port), so there is no remote spoof vector (T-03-14).
@MainActor
final class KernelSocket: ObservableObject {

    /// Connection lifecycle, surfaced for the menubar/UI.
    enum Status: Equatable { case idle, connecting, connected, failed(String) }

    @Published private(set) var status: Status = .idle

    /// Inbound frames the app reacts to (ready / reply / speak / widget.data / ui.state / …).
    /// A subscriber (the app coordinator) routes these to Speaker / Stage / CloudWindow.
    var onFrame: ((Frame) -> Void)?

    private let log = Logger(subsystem: "com.kernel.face", category: "socket")
    private let socketPath: String
    private var connection: NWConnection?

    /// The partial-frame-safe line buffer (mirrors server.ts `let buffer = ''`).
    private var buffer = Data()
    /// Hard cap so a never-newline-terminated stream can't grow the buffer without
    /// bound (DoS guard — a pathological peer cannot exhaust memory; T-03-13).
    private let maxBufferBytes = 1 << 20  // 1 MiB

    /// Default to the daemon's config.socketPath: ~/Library/Application Support/Kernel/kernel.sock.
    init(socketPath: String = KernelSocket.defaultSocketPath()) {
        self.socketPath = socketPath
    }

    nonisolated static func defaultSocketPath() -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser
        return home
            .appendingPathComponent("Library/Application Support/Kernel/kernel.sock")
            .path
    }

    // MARK: Lifecycle

    func connect() {
        guard connection == nil else { return }
        status = .connecting
        buffer.removeAll(keepingCapacity: true)

        let endpoint = NWEndpoint.unix(path: socketPath)
        let conn = NWConnection(to: endpoint, using: .tcp)
        connection = conn

        conn.stateUpdateHandler = { [weak self] state in
            Task { @MainActor in self?.handleState(state) }
        }
        conn.start(queue: .global(qos: .userInitiated))
        receiveLoop(on: conn)
    }

    func disconnect() {
        connection?.cancel()
        connection = nil
        status = .idle
        buffer.removeAll(keepingCapacity: false)
    }

    /// Send a frame as one NDJSON line (`{json}\n`).
    func send(_ frame: Frame) {
        guard let conn = connection else { return }
        do {
            let line = try FrameCodec.encodeLine(frame) + "\n"
            conn.send(content: Data(line.utf8), completion: .contentProcessed { [weak self] error in
                if let error {
                    Task { @MainActor in self?.log.error("send failed: \(error.localizedDescription, privacy: .public)") }
                }
            })
        } catch {
            log.error("encode failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: Internals

    private func handleState(_ state: NWConnection.State) {
        switch state {
        case .ready:
            status = .connected
            log.info("socket connected: \(self.socketPath, privacy: .public)")
            // Announce ourselves (optional in the contract, but mirrors the handshake).
            send(.hello(client: "face", version: KernelBundle.displayName))
        case .failed(let error):
            status = .failed(error.localizedDescription)
            log.error("socket failed: \(error.localizedDescription, privacy: .public)")
            connection = nil
        case .cancelled:
            status = .idle
        default:
            break
        }
    }

    private func receiveLoop(on conn: NWConnection) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) {
            [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data, !data.isEmpty {
                Task { @MainActor in self.ingest(data) }
            }
            if let error {
                Task { @MainActor in
                    self.status = .failed(error.localizedDescription)
                    self.connection = nil
                }
                return
            }
            if isComplete {
                Task { @MainActor in self.disconnect() }
                return
            }
            self.receiveLoop(on: conn)
        }
    }

    /// Append bytes, then drain every COMPLETE line (split on `\n`), keeping the
    /// trailing partial in the buffer — the partial-frame-safe discipline.
    private func ingest(_ chunk: Data) {
        buffer.append(chunk)

        // DoS guard: if no newline has arrived and the buffer is over the cap, the
        // peer is misbehaving — drop the buffered garbage rather than grow forever.
        if buffer.count > maxBufferBytes, buffer.firstIndex(of: 0x0A) == nil {
            log.error("inbound buffer exceeded cap with no newline — dropping")
            buffer.removeAll(keepingCapacity: false)
            return
        }

        let newline: UInt8 = 0x0A
        while let idx = buffer.firstIndex(of: newline) {
            let lineData = buffer.subdata(in: buffer.startIndex..<idx)
            buffer.removeSubrange(buffer.startIndex...idx)  // drop the line + its newline
            guard let line = String(data: lineData, encoding: .utf8) else { continue }
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { continue }
            handleLine(trimmed)
        }
    }

    /// Decode + dispatch a single complete line. A malformed/unknown line is
    /// dropped (logged) — it never crashes the Face (T-03-13).
    private func handleLine(_ line: String) {
        guard let frame = FrameCodec.decode(line: line) else {
            log.error("dropped malformed inbound line (\(line.count) chars)")
            return
        }
        onFrame?(frame)
    }
}
