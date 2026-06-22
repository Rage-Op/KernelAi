#include <metal_stdlib>
using namespace metal;

// The living particle cloud (CLOUD-02/03; 03-UI-SPEC "The Cloud" + "Motion Law").
//
// Tens of thousands of soft, additively-blended particles forming a breathing
// nebula. Idle = gentle drift on a low-amplitude noise field. The Face-local mic
// RMS amplitude (NEVER round-tripped through the daemon — CLOUD-03) pushes
// particles OUTWARD + brightens the field toward indigo on peaks; the color
// lives BETWEEN indigo (#7C8CFF) and cyan (#42E8E0) and slowly migrates.

struct Particle {
    float2 position;   // normalized device coords, roughly [-1, 1]
    float2 velocity;
    float2 home;       // rest position the particle eases back toward
    float  seed;       // per-particle phase offset for the noise field
    float  brightness; // 0..1, eased by amplitude + boundary bursts
};

// Per-frame uniforms fed from Particles.swift.
struct CloudUniforms {
    float time;        // seconds since start (drives the drift noise)
    float amplitude;   // smoothed Face-local mic RMS, 0..1 (CLOUD-03)
    float burst;       // transient boundary-burst impulse, 0..1 (decays in Swift)
    float dt;          // frame delta time (seconds)
    float2 center;     // cloud center in NDC (shifts between scene states)
};

// Cheap hash noise (no texture dependency) for the idle drift field.
static inline float hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
}

static inline float2 noiseField(float2 pos, float t, float seed) {
    // A swirling, low-amplitude curl-ish field so idle motion looks alive, not random.
    float a = sin(pos.y * 3.0 + t * 0.6 + seed * 6.2831);
    float b = cos(pos.x * 3.0 - t * 0.5 + seed * 6.2831);
    return float2(a, b) * 0.012;
}

// COMPUTE: advance every particle's position/velocity + brightness each frame.
kernel void advanceParticles(
    device Particle*      particles [[buffer(0)]],
    constant CloudUniforms& u       [[buffer(1)]],
    uint                  gid       [[thread_position_in_grid]],
    uint                  count     [[threads_per_grid]])
{
    if (gid >= count) return;
    Particle p = particles[gid];

    float dt = clamp(u.dt, 0.0, 0.05);

    // Idle drift: gentle noise-field velocity.
    float2 drift = noiseField(p.position, u.time, p.seed);

    // Outward push from the cloud center scaled by mic amplitude + boundary burst.
    float2 fromCenter = p.position - u.center;
    float dist = max(length(fromCenter), 1e-4);
    float2 outward = (fromCenter / dist);
    float push = (u.amplitude * 0.9 + u.burst * 1.4);
    float2 ampForce = outward * push * 0.04;

    // Spring back toward home so the field re-coheres when quiet (the "quiet pull").
    float2 restoring = (p.home - p.position) * (0.9 + push) * 0.6;

    p.velocity += (drift + ampForce + restoring) * dt * 6.0;
    p.velocity *= 0.92;                 // damping so it settles, never jitters
    p.position += p.velocity * dt;

    // Brightness eases toward amplitude (+ burst flash), then decays.
    float target = clamp(0.35 + u.amplitude * 0.65 + u.burst, 0.0, 1.0);
    p.brightness += (target - p.brightness) * clamp(dt * 8.0, 0.0, 1.0);

    particles[gid] = p;
}

// ---- Additive point rendering --------------------------------------------------

struct VSOut {
    float4 position [[position]];
    float  pointSize [[point_size]];
    float4 color;
};

// Vertex: place each particle as a point sprite, color sampled between indigo↔cyan.
vertex VSOut particleVertex(
    const device Particle*  particles [[buffer(0)]],
    constant CloudUniforms& u         [[buffer(1)]],
    uint                    vid       [[vertex_id]])
{
    Particle p = particles[vid];
    VSOut out;
    out.position = float4(p.position, 0.0, 1.0);
    out.pointSize = 2.0 + p.brightness * 4.0;

    // The living field: indigo on peaks/brightness, easing toward cyan when calm.
    float3 indigo = float3(0x7C / 255.0, 0x8C / 255.0, 0xFF / 255.0);
    float3 cyan   = float3(0x42 / 255.0, 0xE8 / 255.0, 0xE0 / 255.0);
    // Mix by brightness + a slow per-particle migration so it's a field, not a fixed gradient.
    float mixT = clamp(p.brightness * 0.7 + 0.3 * (0.5 + 0.5 * sin(u.time * 0.3 + p.seed * 6.2831)), 0.0, 1.0);
    float3 rgb = mix(cyan, indigo, mixT);
    out.color = float4(rgb, p.brightness);
    return out;
}

// Fragment: soft round falloff for an additively-blended particle.
fragment float4 particleFragment(
    VSOut in [[stage_in]],
    float2 pointCoord [[point_coord]])
{
    float d = length(pointCoord - float2(0.5));
    float alpha = smoothstep(0.5, 0.0, d) * in.color.a;
    return float4(in.color.rgb * alpha, alpha);
}
