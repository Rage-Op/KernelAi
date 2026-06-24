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
    /// Resonance mode: 0 idle · 1 listening · 2 thinking · 3 speaking (CloudMode.rawValue).
    var mode: Float = 0
    /// 1 when "Reduce Motion" is on — the shader gentles rotation/breath/turbulence (keeps the glow).
    var reduceMotion: Float = 0
}

/// MUST match `Particle` in Particles.metal exactly (float3 first keeps the 16-byte alignment
/// identical across Swift SIMD3 and Metal float3).
private struct Particle {
    var home: SIMD3<Float>      // fixed point on the unit sphere
    var position: SIMD2<Float>  // current 2-D render position
    var velocity: SIMD2<Float>
    var seed: Float
    var brightness: Float
    var depth: Float
}

/// Shared, observable amplitude/scene source the MicEngine writes and the cloud reads.
/// Keeping it a tiny reference object means the 60fps RMS path never round-trips the
/// daemon (CLOUD-03) — MicEngine sets `amplitude` directly, the renderer samples it.
@MainActor
final class CloudState: ObservableObject {
    /// The sphere's resonance state — the "complex resonance" with both faces.
    /// idle = slow breath · listening = contracts + shimmers to your voice · thinking = internal
    /// swirl · speaking = radiates outward with KERNEL's speech.
    enum CloudMode: Int { case idle, listening, thinking, speaking }

    /// Smoothed Face-local mic RMS, 0..1. Written by MicEngine, read each frame.
    @Published var amplitude: Float = 0
    /// Transient boundary-burst impulse (set by the Stage on a cue, decays in-renderer).
    @Published var burst: Float = 0
    /// Cloud center in NDC; shifts when the scene migrates to the corner pill.
    @Published var center: SIMD2<Float> = .zero
    /// The active resonance mode, set by the coordinator from inbound frames + mic state.
    @Published var mode: CloudMode = .idle

    /// Fire a localized brighten/burst flash (TTS boundary crossing — UI-SPEC).
    func pulse() { burst = 1.0 }
}

/// SwiftUI host for the Metal cloud.
struct CloudCanvas: NSViewRepresentable {
    @ObservedObject var state: CloudState
    /// Pass a smaller count for the corner-pill miniature cloud.
    var particleCount: Int = ParticleRenderer.defaultCount
    /// Respect the system "Reduce Motion" accessibility setting — the sphere gentles its motion.
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeCoordinator() -> ParticleRenderer {
        ParticleRenderer(state: state, particleCount: particleCount)
    }

    func makeNSView(context: Context) -> MTKView {
        let view = MTKView()
        view.device = context.coordinator.device
        view.colorPixelFormat = .bgra8Unorm
        // Warm near-black canvas (#0A0908) — the "Personal Agent Runtime" base.
        view.clearColor = MTLClearColor(red: 0x0A / 255, green: 0x09 / 255, blue: 0x08 / 255, alpha: 1)
        view.framebufferOnly = true
        view.preferredFramesPerSecond = 60
        view.delegate = context.coordinator
        view.isPaused = false
        view.enableSetNeedsDisplay = false
        return view
    }

    func updateNSView(_ nsView: MTKView, context: Context) {
        context.coordinator.particleCount = particleCount
        context.coordinator.reduceMotion = reduceMotion
    }
}

/// The MTKView delegate: owns the buffers + pipelines and renders each frame.
@MainActor
final class ParticleRenderer: NSObject, MTKViewDelegate {

    // FEWER, BETTER-SHADED particles (WS-E): ~6k individually depth/fresnel-shaded points read as a
    // premium, alive orb where 40k flat dots read as noise. Cheaper too (lower fill-rate).
    // ~22k: enough additive DENSITY to read as a luminous orb, while still better-shaded + fewer
    // than the old 40k flat cloud (additive glow ∝ count × sprite-area × brightness). 60fps on M2 Pro.
    static let defaultCount = 22_000
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
    /// Mirrors the system "Reduce Motion" setting; folded into the uniforms each frame.
    var reduceMotion = false

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
        // Fibonacci sphere: an even, organic distribution of points over the unit sphere — the
        // structure that makes the cloud read as a dimensional orb rather than a flat disk.
        let golden = Float.pi * (3.0 - (5.0 as Float).squareRoot())   // golden angle
        let n = Float(max(particleCount, 1))
        for i in 0..<particleCount {
            let fi = Float(i)
            let y = 1.0 - (fi / max(n - 1, 1)) * 2.0                   // y: +1 → -1
            let rad = (max(0, 1.0 - y * y)).squareRoot()              // ring radius at y
            let phi = fi * golden
            // SHELL: most particles cluster near the surface (0.90–1.0) so the silhouette is crisp for
            // the fresnel rim; ~12% sit deep inside (0.45–0.70) forming a bright volumetric CORE so the
            // orb reads as a sphere with a heart, not a hollow shell. `length(home)` tells the shader
            // which is which (core particles glow warm/bright at center).
            let isCore = (i % 8 == 0)
            let shell = isCore ? (0.45 + 0.25 * Float.random(in: 0...1))
                               : (0.90 + 0.10 * Float.random(in: 0...1))
            let home = SIMD3<Float>(cos(phi) * rad, y, sin(phi) * rad) * shell
            // Seed near the projected position so the first frame doesn't ease in from the origin.
            // Smaller base radius (0.46) — a compact, energy-dense orb; the glow does the visual work.
            let pos = SIMD2<Float>(home.x, home.y) * 0.46
            particles.append(Particle(
                home: home,
                position: pos,
                velocity: .zero,
                seed: Float.random(in: 0...1),
                brightness: Float.random(in: 0.35...0.65),
                depth: home.z))
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
        uniforms.mode = Float(state.mode.rawValue)   // resonance mode → shader
        uniforms.reduceMotion = reduceMotion ? 1 : 0 // accessibility: gentle the motion
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
