#include <metal_stdlib>
using namespace metal;

// KERNEL's living face — a COMPACT, DEPTH-RICH terracotta persona orb (CLOUD-02/03, WS-E redesign).
//
// Fewer-but-better: ~6k individually-shaded points (not 40k flat dots) on a slowly-rotating sphere,
// composited additively. The premium look comes from real depth shading + a glowing FRESNEL RIM +
// organic CURL-FLOW churn + a bright volumetric CORE + subtle iridescence/sparkle — a small dense
// orb whose glow does the work, not a big sparse cloud. It RESONATES with both faces:
//   • the owner's voice — Face-local mic RMS (`amplitude`, never round-tripped — CLOUD-03)
//   • KERNEL's own speech — TTS boundary cues (`burst`, decays in Swift)
// across four states (`mode`): idle breath · listening (cool, draws in, shimmers) · thinking
// (cool, faster internal swirl) · speaking (warm, radiates with each phrase).
//
// Palette: a warm terracotta/amber BODY with COOL cyan/violet energy accents on the rim + sparkles
// (the Apple-Intelligence glow family) — a warm body with cool energy reads more alive than mono.
// Motion Law: positions EASE toward their target every frame — nothing ever snaps.

struct Particle {
    float3 home;       // fixed point on the sphere (Fibonacci-seeded; length<~0.7 = CORE particle)
    float2 position;   // current 2-D render position (eased toward the projected target)
    float2 velocity;   // for smooth spring easing + turbulence
    float  seed;       // per-particle phase offset (drives sparkle + size + iridescence)
    float  brightness; // eased shade, lifted by depth/fresnel/core/energy
    float  depth;      // last projected z (-1 back .. +1 front) — drives size + color temperature
};

// Per-frame uniforms — MUST match `CloudUniforms` in Particles.swift exactly.
struct CloudUniforms {
    float time;
    float amplitude;
    float burst;
    float dt;
    float2 center;
    float mode;        // 0 idle · 1 listening · 2 thinking · 3 speaking
    float reduceMotion;
};

static inline float hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
}

// A cheap, organic, swirling flow field (curl-noise flavour without the cost): layered trig of the
// position, decorrelated per axis. Combined with a spring back to the sphere it reads as particles
// suspended in a slow turbulent current — the motion that makes the orb feel alive.
static inline float3 flowField(float3 p, float t) {
    return float3(
        sin(p.y * 2.3 + t * 0.70) + 0.5 * sin(p.z * 3.7 - t * 0.50),
        sin(p.z * 2.1 + t * 0.60) + 0.5 * sin(p.x * 3.3 - t * 0.40),
        sin(p.x * 2.5 + t * 0.80) + 0.5 * sin(p.y * 3.1 - t * 0.60));
}

// Per-mode rotation speed (rad/s) — thinking spins a touch faster (alive, searching).
static inline float rotSpeed(float mode) {
    if (mode > 2.5) return 0.18;   // speaking
    if (mode > 1.5) return 0.34;   // thinking (faster internal churn)
    if (mode > 0.5) return 0.09;   // listening (calm, attentive)
    return 0.13;                   // idle
}

// Per-mode curl-flow strength — thinking churns most, idle gentlest.
static inline float curlStrength(float mode) {
    if (mode > 2.5) return 0.040;  // speaking
    if (mode > 1.5) return 0.055;  // thinking
    if (mode > 0.5) return 0.030;  // listening
    return 0.022;                  // idle
}

// COMPUTE: place every particle on the rotating sphere, apply curl-flow + mode resonance, ease in.
kernel void advanceParticles(
    device Particle*      particles [[buffer(0)]],
    constant CloudUniforms& u       [[buffer(1)]],
    uint                  gid       [[thread_position_in_grid]],
    uint                  count     [[threads_per_grid]])
{
    if (gid >= count) return;
    Particle p = particles[gid];

    float dt = clamp(u.dt, 0.0, 0.05);
    float t = u.time;
    float motionScale = 1.0 - 0.85 * u.reduceMotion;
    float homeLen = length(p.home);                 // <~0.7 → a deep CORE particle

    // --- Rotate the home point: spin about Y, then a fixed 3/4-view tilt about X. ---
    float ang = t * rotSpeed(u.mode) * motionScale;
    float ca = cos(ang), sa = sin(ang);
    float3 r = float3(p.home.x * ca + p.home.z * sa,
                      p.home.y,
                     -p.home.x * sa + p.home.z * ca);
    const float tilt = 0.34;
    float ct = cos(tilt), st = sin(tilt);
    float3 v = float3(r.x, r.y * ct - r.z * st, r.y * st + r.z * ct);
    float depth = v.z;                               // -1 (back) .. +1 (front)

    // --- Breathing / resonance per mode (stronger audio coupling than before). ---
    float breath;
    if (u.mode > 2.5)       breath = 1.00 + 0.14 * u.burst + 0.04 * sin(t * 4.0);     // speaking radiates
    else if (u.mode > 1.5)  breath = 0.97 + 0.02 * sin(t * 1.6 + p.seed * 6.2831);    // thinking, contained
    else if (u.mode > 0.5)  breath = 0.88 + 0.13 * u.amplitude;                       // listening draws in + pulses
    else                    breath = 1.00 + 0.045 * sin(t * 0.8);                     // idle breath
    breath = 1.0 + (breath - 1.0) * motionScale;

    const float radius = 0.46;                       // compact orb; the glow carries the presence
    float2 base = u.center + v.xy * (radius * breath);

    // --- Curl-flow churn (project the 3D flow to screen, mostly tangential so the shell holds). ---
    float3 fl = flowField(r * 2.0, t * (u.mode > 1.5 ? 0.16 : 0.10));
    float2 churn = fl.xy * curlStrength(u.mode) * motionScale;

    // --- Mode-specific extra displacement (radial / tangential / ripple), audio-reactive. ---
    float2 dir = base - u.center;
    float dist = max(length(dir), 1e-4);
    float2 radDir = dir / dist;
    float2 tang = float2(-radDir.y, radDir.x);
    float2 disp = radDir * (u.amplitude * 0.10 + u.burst * 0.16);          // base outward energy
    if (u.mode > 2.5) {                                                    // speaking: traveling ripple
        disp += radDir * (0.06 * sin(dist * 9.0 - t * 6.0) * u.burst);
    } else if (u.mode > 1.5) {                                            // thinking: swirl inward
        disp += tang * (0.040 * sin(t * 1.2 + p.seed * 6.2831)) - radDir * 0.015;
    } else if (u.mode > 0.5) {                                            // listening: inward shimmer
        float jitter = (hash11(p.seed * 91.7 + t * 3.0) - 0.5);           // 3 Hz-ish shimmer
        disp += radDir * (-0.04) + tang * (jitter * 0.06 * (0.4 + u.amplitude));
    }
    float2 targetFinal = base + (churn + disp) * motionScale;

    // --- Ease toward the target (spring). A whisper of idle drift so the back never deadens. ---
    float2 drift = float2(sin(p.home.y * 3.0 + t * 0.5 + p.seed * 6.2831),
                          cos(p.home.x * 3.0 - t * 0.4 + p.seed * 6.2831)) * 0.0030;
    p.velocity += ((targetFinal - p.position) * 9.0 + drift) * dt * 6.0;
    p.velocity *= 0.86;
    p.position += p.velocity * dt;

    // --- Brightness: front-lit + hot core + FRESNEL RIM + voice/speech energy. ---
    float front = 0.5 + 0.5 * depth;                                       // 0 back .. 1 front
    float fresnel = pow(1.0 - abs(depth), 4.0);                            // glowing silhouette edge
    float coreGlow = smoothstep(0.72, 0.0, homeLen) * (0.4 + 0.6 * front); // deep particles = bright heart
    float energy = (u.mode > 2.5) ? u.burst
                 : ((u.mode > 0.5 && u.mode < 1.5) ? u.amplitude : 0.0);
    float tBright = clamp(0.48 + front * 0.55 + fresnel * 1.00 + coreGlow * 1.10 + energy * 0.60,
                          0.0, 2.0);
    p.brightness += (tBright - p.brightness) * clamp(dt * 9.0, 0.0, 1.0);  // snappier response
    p.depth = depth;

    particles[gid] = p;
}

// ---- Additive point rendering -------------------------------------------------

struct VSOut {
    float4 position [[position]];
    float  pointSize [[point_size]];
    float4 color;
};

// Vertex: depth-attenuated soft points; warm body, cool fresnel-rim + sparkle accents, hot core.
vertex VSOut particleVertex(
    const device Particle*  particles [[buffer(0)]],
    constant CloudUniforms& u         [[buffer(1)]],
    uint                    vid       [[vertex_id]])
{
    Particle p = particles[vid];
    VSOut out;
    out.position = float4(p.position, 0.0, 1.0);

    float front = 0.5 + 0.5 * p.depth;
    float homeLen = length(p.home);
    float fresnel = pow(1.0 - abs(p.depth), 4.0);

    // Per-particle size: small base, varied 0.7–1.4×, bigger for bright/front; a few bright accents.
    float sizeVar = 0.7 + 0.7 * hash11(p.seed * 17.3);
    float accent = step(0.90, hash11(p.seed * 53.1));                      // ~10% accent particles
    out.pointSize = (2.2 + p.brightness * 5.0) * (0.65 + 0.6 * front) * sizeVar * (1.0 + accent * 0.6);

    // --- Palette: warm terracotta/amber body → hot core; cool cyan/violet on rim + accents. ---
    float3 amber = float3(1.00, 0.70, 0.42);   // warm amber body (front)
    float3 terra = float3(0xD9 / 255.0, 0x77 / 255.0, 0x57 / 255.0); // terracotta mid
    float3 core  = float3(1.00, 0.78, 0.52);   // hot near-white-warm core
    float3 cyan  = float3(0.43, 0.78, 1.00);   // #6EC6FF cool energy
    float3 violet= float3(0.63, 0.43, 0.93);   // #A06EEE cool energy

    float3 rgb = mix(terra, amber, clamp(front, 0.0, 1.0));
    rgb = mix(rgb, core, smoothstep(0.72, 0.0, homeLen));                  // core glows hot
    // A WARM amber fresnel rim by default (keeps idle vibrant terracotta, never grey). Cool cyan/
    // violet accents are reserved for the listening/thinking states (so state reads by colour).
    float3 warmRim = float3(1.00, 0.62, 0.34);
    rgb = mix(rgb, warmRim, fresnel * 0.45);
    bool coolState = (u.mode > 0.5 && u.mode < 2.5);
    if (coolState) {
        float3 coolMix = mix(cyan, violet, hash11(p.seed * 7.7));
        rgb = mix(rgb, coolMix, clamp(fresnel * 0.5 + accent * 0.25, 0.0, 0.75));
    }
    // Subtle WARM iridescent shimmer (no negative-blue greying) so the hue lives without going muddy.
    float irid = 0.06 * sin(p.seed * 28.0 + u.time * 0.8 + fresnel * 6.0);
    rgb += float3(irid, irid * 0.45, irid * 0.1);
    // Sparkle: accent particles spike briefly on a per-particle hashed timer (glints of energy).
    float spark = accent * pow(max(0.0, sin(u.time * 2.0 + p.seed * 30.0)), 12.0);
    rgb += spark * float3(0.9, 0.7, 0.5);

    float a = clamp(p.brightness, 0.0, 1.2);
    out.color = float4(max(rgb, 0.0), a);
    return out;
}

// Fragment: tight soft falloff (a glowing dab with a bright center), additively blended.
fragment float4 particleFragment(
    VSOut in [[stage_in]],
    float2 pointCoord [[point_coord]])
{
    float d = length(pointCoord - float2(0.5));
    float core = pow(saturate(1.0 - d * 2.0), 1.7);   // soft glowing dab (wider, brighter halo)
    float alpha = core * in.color.a;
    return float4(in.color.rgb * alpha, alpha);
}
