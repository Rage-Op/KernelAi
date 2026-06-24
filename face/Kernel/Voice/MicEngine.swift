import AVFoundation
import Accelerate
import Speech
import simd
import os

/// AVAudioEngine input tap — PUSH-TO-TALK. The mic is OFF until the owner holds the mic control;
/// `start()` taps the input and `stop()` ends it (KERNEL is not listening all the time). While the
/// tap is live it does two Face-local things, decoupled:
///   - RMS → `CloudState.amplitude` (drives the sphere's `listening` resonance; CLOUD-03, never the
///     daemon).
///   - on-device speech recognition via `SFSpeechRecognizer` (privacy-preserving — no audio leaves
///     the machine), surfacing partial + final transcripts through `onTranscript`. The final
///     transcript becomes the utterance the coordinator sends to the daemon.
@MainActor
final class MicEngine: ObservableObject {

    private let log = Logger(subsystem: "com.kernel.face", category: "mic")
    private let engine = AVAudioEngine()
    private weak var cloud: CloudState?

    /// Partial (isFinal=false) + final (isFinal=true) transcripts from on-device recognition.
    var onTranscript: ((_ text: String, _ isFinal: Bool) -> Void)?

    @Published private(set) var isRunning = false

    /// Exponential smoothing factor for the RMS (so the cloud breathes, not jitters).
    private let smoothing: Float = 0.2
    private var smoothedRMS: Float = 0

    // On-device speech recognition.
    private let recognizer = SFSpeechRecognizer()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?

    init(cloud: CloudState) {
        self.cloud = cloud
    }

    /// Request Speech-recognition authorization once (the mic TCC prompt is driven by AVAudioEngine).
    /// Safe to call on launch; the system shows the prompt only the first time.
    static func requestSpeechAuthorization() {
        SFSpeechRecognizer.requestAuthorization { _ in }
    }

    /// Begin capturing: tap the mic, feed RMS to the cloud, and start on-device recognition. Called
    /// when the owner presses-and-holds the mic control. Safe to call twice.
    func start() {
        guard !isRunning else { return }
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            log.error("mic input format unavailable (no grant / no device)")
            return
        }

        // Start a fresh on-device recognition request for this utterance.
        startRecognition()

        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            guard let self else { return }
            let rms = MicEngine.computeRMS(buffer)
            // Feed the recognizer on the audio thread (thread-safe per Speech docs); apply RMS on main.
            self.request?.append(buffer)
            Task { @MainActor in self.applyRMS(rms) }
        }

        do {
            engine.prepare()
            try engine.start()
            isRunning = true
            log.info("mic engine started (push-to-talk: RMS + on-device STT)")
        } catch {
            log.error("mic engine failed to start: \(error.localizedDescription, privacy: .public)")
            cancelRecognition()
        }
    }

    /// End capturing: stop the tap and finish recognition (the final transcript is delivered to
    /// `onTranscript` asynchronously). Called when the owner releases the mic control.
    func stop() {
        guard isRunning else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        isRunning = false
        smoothedRMS = 0
        cloud?.amplitude = 0
        request?.endAudio()   // flush — the recognition task delivers its final result, then ends.
    }

    // MARK: On-device recognition

    private func startRecognition() {
        guard let recognizer, recognizer.isAvailable else {
            log.error("speech recognizer unavailable")
            return
        }
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        // Keep audio on-device when the model supports it (privacy; no network round-trip).
        if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        request = req
        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            guard let self else { return }
            Task { @MainActor in
                if let result {
                    self.onTranscript?(result.bestTranscription.formattedString, result.isFinal)
                    if result.isFinal { self.cleanupRecognition() }
                } else if error != nil {
                    self.onTranscript?("", true)   // surface an empty final so the UI resets
                    self.cleanupRecognition()
                }
            }
        }
    }

    private func cancelRecognition() {
        task?.cancel()
        cleanupRecognition()
    }

    private func cleanupRecognition() {
        request = nil
        task = nil
    }

    // MARK: RMS (Face-local — drives the cloud, never the daemon)

    private func applyRMS(_ rms: Float) {
        let level = min(1.0, rms * 12.0)
        smoothedRMS += (level - smoothedRMS) * smoothing
        cloud?.amplitude = smoothedRMS
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
}
