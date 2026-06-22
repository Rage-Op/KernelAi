import MetalKit
import SwiftUI
import simd
import os

/// GPU Metal compute-shader particle cloud (CLOUD-02), wrapped as a SwiftUI view.
///
/// Particle state lives in an `MTLBuffer`, advanced by the `advanceParticles`
/// compute kernel each frame, drawn additively in an `MTKView`. Idle = gentle
/// drift; the Face-local mic RMS amplitude (CLOUD-03 — never the daemon) pushes
/// particles outward + brightens indigo↔cyan. Particle count is budgeted to hold
/// 60fps and sheds under memory/thermal pressure (RESEARCH Pitfall 7).

/// Per-frame uniforms — MUST match `CloudUniforms` in Particles.metal exactly.
struct CloudUniforms {
    var time: Float = 0
    var amplitude: Float = 0
    var burst: Float = 0
    var dt: Float = 0
    var center: SIMD2<Float> = .zero
}

private struct Particle {
    var position: SIMD2<Float>
    var velocity: SIMD2<Float>
    var home: SIMD2<Float>
    var seed: Float
    var brightness: Float
}

/// Shared, observable amplitude/scene source the MicEngine writes and the cloud reads.
/// Keeping it a tiny reference object means the 60fps RMS path never round-trips the
/// daemon (CLOUD-03) — MicEngine sets `amplitude` directly, the renderer samples it.
@MainActor
final class CloudState: ObservableObject {
    /// Smoothed Face-local mic RMS, 0..1. Written by MicEngine, read each frame.
    @Published var amplitude: Float = 0
    /// Transient boundary-burst impulse (set by the Stage on a cue, decays in-renderer).
    @Published var burst: Float = 0
    /// Cloud center in NDC; shifts when the scene migrates to the corner pill.
    @Published var center: SIMD2<Float> = .zero

    /// Fire a localized brighten/burst flash (TTS boundary crossing — UI-SPEC).
    func pulse() { burst = 1.0 }
}

/// SwiftUI host for the Metal cloud.
struct CloudCanvas: NSViewRepresentable {
    @ObservedObject var state: CloudState
    /// Pass a smaller count for the corner-pill miniature cloud.
    var particleCount: Int = ParticleRenderer.defaultCount

    func makeCoordinator() -> ParticleRenderer {
        ParticleRenderer(state: state, particleCount: particleCount)
    }

    func makeNSView(context: Context) -> MTKView {
        let view = MTKView()
        view.device = context.coordinator.device
        view.colorPixelFormat = .bgra8Unorm
        view.clearColor = MTLClearColor(red: 0x08 / 255, green: 0x08 / 255, blue: 0x0A / 255, alpha: 1)
        view.framebufferOnly = true
        view.preferredFramesPerSecond = 60
        view.delegate = context.coordinator
        view.isPaused = false
        view.enableSetNeedsDisplay = false
        return view
    }

    func updateNSView(_ nsView: MTKView, context: Context) {
        context.coordinator.particleCount = particleCount
    }
}

/// The MTKView delegate: owns the buffers + pipelines and renders each frame.
@MainActor
final class ParticleRenderer: NSObject, MTKViewDelegate {

    static let defaultCount = 24_000        // holds 60fps on Apple-silicon iGPU
    static let minCount = 6_000             // floor when shedding under pressure

    let device: MTLDevice
    private let queue: MTLCommandQueue
    private var computePipeline: MTLComputePipelineState?
    private var renderPipeline: MTLRenderPipelineState?
    private var particleBuffer: MTLBuffer?
    private let state: CloudState
    private let log = Logger(subsystem: "com.kernel.face", category: "cloud")

    var particleCount: Int {
        didSet { if particleCount != oldValue { rebuildParticles() } }
    }

    private var uniforms = CloudUniforms()
    private var startTime = CFAbsoluteTimeGetCurrent()
    private var lastFrame = CFAbsoluteTimeGetCurrent()

    init(state: CloudState, particleCount: Int) {
        self.state = state
        self.particleCount = max(Self.minCount, particleCount)
        self.device = MTLCreateSystemDefaultDevice() ?? MTLCopyAllDevices().first!
        self.queue = device.makeCommandQueue()!
        super.init()
        buildPipelines()
        rebuildParticles()
    }

    private func buildPipelines() {
        guard let library = device.makeDefaultLibrary() else {
            log.error("no default Metal library — particle cloud disabled")
            return
        }
        if let fn = library.makeFunction(name: "advanceParticles") {
            computePipeline = try? device.makeComputePipelineState(function: fn)
        }
        let desc = MTLRenderPipelineDescriptor()
        desc.vertexFunction = library.makeFunction(name: "particleVertex")
        desc.fragmentFunction = library.makeFunction(name: "particleFragment")
        let att = desc.colorAttachments[0]!
        att.pixelFormat = .bgra8Unorm
        // Additive blending — the soft nebula glow.
        att.isBlendingEnabled = true
        att.rgbBlendOperation = .add
        att.alphaBlendOperation = .add
        att.sourceRGBBlendFactor = .one
        att.sourceAlphaBlendFactor = .one
        att.destinationRGBBlendFactor = .one
        att.destinationAlphaBlendFactor = .one
        renderPipeline = try? device.makeRenderPipelineState(descriptor: desc)
    }

    private func rebuildParticles() {
        var particles: [Particle] = []
        particles.reserveCapacity(particleCount)
        for _ in 0..<particleCount {
            // Seed a soft gaussian-ish disk around the center.
            let r = Float.random(in: 0...1).squareRoot() * 0.7
            let theta = Float.random(in: 0...(2 * .pi))
            let home = SIMD2<Float>(cos(theta) * r, sin(theta) * r)
            particles.append(Particle(
                position: home,
                velocity: .zero,
                home: home,
                seed: Float.random(in: 0...1),
                brightness: Float.random(in: 0.2...0.5)))
        }
        particleBuffer = device.makeBuffer(
            bytes: particles,
            length: MemoryLayout<Particle>.stride * particleCount,
            options: .storageModeShared)
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    func draw(in view: MTKView) {
        guard
            let buffer = particleBuffer,
            let compute = computePipeline,
            let render = renderPipeline,
            let drawable = view.currentDrawable,
            let pass = view.currentRenderPassDescriptor,
            let cmd = queue.makeCommandBuffer()
        else { return }

        let now = CFAbsoluteTimeGetCurrent()
        uniforms.dt = Float(now - lastFrame)
        uniforms.time = Float(now - startTime)
        lastFrame = now
        // Sample the Face-local mic amplitude + decaying boundary burst (CLOUD-03).
        uniforms.amplitude = state.amplitude
        uniforms.burst = state.burst
        uniforms.center = state.center
        state.burst *= 0.85               // ease the burst back down (Motion Law: no snap)
        if state.burst < 0.01 { state.burst = 0 }

        // Compute pass: advance the simulation.
        if let enc = cmd.makeComputeCommandEncoder() {
            enc.setComputePipelineState(compute)
            enc.setBuffer(buffer, offset: 0, index: 0)
            enc.setBytes(&uniforms, length: MemoryLayout<CloudUniforms>.stride, index: 1)
            let w = compute.threadExecutionWidth
            enc.dispatchThreads(
                MTLSize(width: particleCount, height: 1, depth: 1),
                threadsPerThreadgroup: MTLSize(width: w, height: 1, depth: 1))
            enc.endEncoding()
        }

        // Render pass: additive point sprites.
        if let enc = cmd.makeRenderCommandEncoder(descriptor: pass) {
            enc.setRenderPipelineState(render)
            enc.setVertexBuffer(buffer, offset: 0, index: 0)
            enc.setVertexBytes(&uniforms, length: MemoryLayout<CloudUniforms>.stride, index: 1)
            enc.drawPrimitives(type: .point, vertexStart: 0, vertexCount: particleCount)
            enc.endEncoding()
        }

        cmd.present(drawable)
        cmd.commit()
    }

    /// Shed particles under memory/thermal pressure (RESEARCH Pitfall 7).
    func shedUnderPressure() {
        particleCount = max(Self.minCount, particleCount / 2)
        log.info("shed particle budget to \(self.particleCount) under pressure")
    }
}
