import AVFoundation
import Accelerate
import simd
import os

/// AVAudioEngine input tap. Computes mic RMS ENTIRELY in the Face (CLOUD-03 — the
/// RMS NEVER round-trips the daemon; it's a 60fps signal that drives the cloud
/// directly) and, independently, exposes 16kHz mono PCM for the daemon's whisper
/// STT path (the daemon spawns whisper per 03-02; the Face streams PCM).
///
/// Two paths, decoupled:
///   - RMS → `CloudState.amplitude` (Face-local, smoothed so the cloud breathes,
///     not jitters). This is the ONLY thing the cloud listens to.
///   - 16kHz PCM → `onPCM16k` callback (the only audio that crosses to the LOCAL
///     daemon for STT). The RMS value itself is never sent anywhere (T-03-15).
@MainActor
final class MicEngine: ObservableObject {

    private let log = Logger(subsystem: "com.kernel.face", category: "mic")
    private let engine = AVAudioEngine()
    private weak var cloud: CloudState?

    /// Downsampled 16kHz mono PCM for the daemon STT path (LOCAL only — never leaves
    /// the machine; T-03-15). Set by the app coordinator that streams to the daemon.
    var onPCM16k: (([Float]) -> Void)?

    @Published private(set) var isRunning = false

    /// Exponential smoothing factor for the RMS (so the cloud breathes, not jitters).
    private let smoothing: Float = 0.2
    private var smoothedRMS: Float = 0

    /// 16kHz mono converter target format for the STT path.
    private lazy var targetFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)

    init(cloud: CloudState) {
        self.cloud = cloud
    }

    /// Start tapping the mic. Requires the TCC mic grant (declared in 03-03's
    /// Info.plist; the owner approves the prompt on first run). Safe to call twice.
    func start() {
        guard !isRunning else { return }
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            log.error("mic input format unavailable (no grant / no device)")
            return
        }

        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            guard let self else { return }
            // RMS is computed on the audio thread but applied on the main actor so
            // the cloud (a @MainActor object) is touched safely.
            let rms = MicEngine.computeRMS(buffer)
            let pcm = self.targetFormat.map { MicEngine.downsample(buffer, to: $0) } ?? nil
            Task { @MainActor in
                self.applyRMS(rms)
                if let pcm { self.onPCM16k?(pcm) }
            }
        }

        do {
            engine.prepare()
            try engine.start()
            isRunning = true
            log.info("mic engine started (Face-local RMS; PCM→daemon STT)")
        } catch {
            log.error("mic engine failed to start: \(error.localizedDescription, privacy: .public)")
        }
    }

    func stop() {
        guard isRunning else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        isRunning = false
        smoothedRMS = 0
        cloud?.amplitude = 0
    }

    // MARK: RMS (Face-local — drives the cloud, never the daemon)

    private func applyRMS(_ rms: Float) {
        // Map raw RMS into a perceptual 0..1 and smooth it.
        let level = min(1.0, rms * 12.0)
        smoothedRMS += (level - smoothedRMS) * smoothing
        cloud?.amplitude = smoothedRMS    // the ONLY consumer of the RMS (CLOUD-03)
    }

    /// Root-mean-square of a float PCM buffer (the mic loudness). Accelerate-backed.
    nonisolated static func computeRMS(_ buffer: AVAudioPCMBuffer) -> Float {
        guard let channel = buffer.floatChannelData?[0] else { return 0 }
        let n = vDSP_Length(buffer.frameLength)
        guard n > 0 else { return 0 }
        var rms: Float = 0
        vDSP_rmsqv(channel, 1, &rms, n)
        return rms.isFinite ? rms : 0
    }

    /// Downsample/convert a buffer to 16kHz mono float PCM for the STT path.
    nonisolated static func downsample(_ buffer: AVAudioPCMBuffer, to target: AVAudioFormat) -> [Float]? {
        guard let converter = AVAudioConverter(from: buffer.format, to: target) else { return nil }
        let ratio = target.sampleRate / buffer.format.sampleRate
        let outCapacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 1)
        guard outCapacity > 0,
              let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: outCapacity)
        else { return nil }

        var fed = false
        var err: NSError?
        converter.convert(to: out, error: &err) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true
            status.pointee = .haveData
            return buffer
        }
        if err != nil { return nil }
        guard let ch = out.floatChannelData?[0] else { return nil }
        return Array(UnsafeBufferPointer(start: ch, count: Int(out.frameLength)))
    }
}
