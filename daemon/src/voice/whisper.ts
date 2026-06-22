/**
 * whisper.ts — the daemon-side STT seam (VOICE-01): an ABSENT-TOLERANT whisper.cpp subprocess
 * wrapper. Audio in (a temp WAV path / 16kHz mono PCM piped from the Face), a clean transcript out.
 *
 * §7 OWNERSHIP (KERNEL_MASTER_BUILD_PROMPT.md §7, RESEARCH.md Open Question 2): the DAEMON spawns
 * `whisper-cli` as a subprocess; the FACE owns mic capture (AVAudioEngine) and streams 16kHz mono
 * PCM (or hands a temp WAV path) to this wrapper. Mic access + low latency live in the Face;
 * transcription is a daemon-spawned subprocess so STT logic stays unit-testable behind the §2
 * subprocess boundary (the daemon NEVER embeds a model).
 *
 * ABSENT-TOLERANT (RESEARCH.md Pitfall 5 — whisper.cpp is verified ABSENT on this machine; the
 * owner builds the Core ML/ANE binary). A spawn ENOENT (no `whisper-cli` on PATH) or a non-zero
 * exit each return a TYPED ESCALATION ({ ok:false, escalation:{ reason } }) — NEVER a throw across
 * the loop boundary. This mirrors the Peekaboo adapter's probe-then-escalate discipline
 * (tools/peekaboo.ts) and the ClaudeCodeBrain runner seam.
 *
 * The transcript a successful call yields is the text a future utterance frame carries (the
 * Utterance shape is already FROZEN in ipc/protocol.ts) — this wrapper adds NO new frame. The
 * transcript is EXTERNAL-sourced content (T-03-08): it enters the loop as an utterance and any
 * resulting tool action still passes gate.authorize (Phase-2 chokepoint). This wrapper does not
 * bypass the gate.
 *
 * Test seam: `__setSpawnForTest(fn)` injects a mock runner so the unit lane runs with NO binary and
 * NO mic (mirrors peekaboo `__setClientForTest` / ClaudeCodeBrain `__setRunnerForTest`).
 */
import { spawn } from 'node:child_process';

/**
 * The whisper.cpp CLI binary (A-series: configurable, kept in a named constant — overridable by the
 * owner via WHISPER_CLI, never hardcoded-and-buried). Recent whisper.cpp ships `whisper-cli`.
 */
export const WHISPER_CLI = process.env.WHISPER_CLI?.trim() || 'whisper-cli';

/**
 * The whisper model file (Core ML/ANE build, owner-supplied). Configurable via WHISPER_MODEL.
 * Passed as a discrete argv entry (T-03-07: no shell interpolation).
 */
export const WHISPER_MODEL = process.env.WHISPER_MODEL?.trim() || 'models/ggml-base.en.bin';

/** The audio the wrapper transcribes: a temp WAV path the Face wrote (16kHz mono PCM). */
export interface WhisperInput {
  wavPath: string;
}

/** The captured result of running whisper-cli: exit code, streams, and any spawn error. */
export interface WhisperRun {
  code: number;
  stdout: string;
  stderr: string;
  /** Present when the spawn itself failed (e.g. ENOENT — binary absent). */
  error?: Error & { code?: string };
}

/** A runner spawns whisper-cli with the given argv and resolves its captured result. */
export type WhisperSpawn = (cmd: string, args: string[]) => Promise<WhisperRun>;

/** The wrapper's typed outcome: a clean transcript, or a structured escalation (never a throw). */
export type WhisperResult =
  | { ok: true; transcript: string }
  | { ok: false; escalation: { reason: string; recommendation?: string } };

/** The active runner (test seam overrides it). Defaults to the real node:child_process spawn. */
let runner: WhisperSpawn | null = null;

/** TEST-ONLY seam: inject a mock spawn (or null to reset to the real spawn). */
export function __setSpawnForTest(fn: WhisperSpawn | null): void {
  runner = fn;
}

/**
 * The real runner: spawn whisper-cli with an EXPLICIT argv array (T-03-07 — NO shell string, so the
 * audio path and model path cannot be shell-interpolated). A spawn ENOENT surfaces as an 'error'
 * event — captured into `error`, translated to a typed escalation by `transcribe`, never thrown.
 */
const realSpawn: WhisperSpawn = (cmd: string, args: string[]) =>
  new Promise<WhisperRun>((resolve) => {
    let stdout = '';
    let stderr = '';
    // stdio pipes only; argv array means no shell — the discrete args are never interpolated.
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr?.on('data', (d) => (stderr += d.toString('utf8')));
    child.on('error', (err) =>
      resolve({ code: 127, stdout, stderr, error: err as Error & { code?: string } }),
    );
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });

/** Build the whisper-cli argv: the model, the input WAV, and `-nt` (no timestamps in stdout). */
function argvFor(input: WhisperInput): string[] {
  return ['-m', WHISPER_MODEL, '-f', input.wavPath];
}

/** True when a captured run looks like a missing-binary failure (spawn ENOENT / exit 127). */
function isAbsent(run: WhisperRun): boolean {
  return run.error?.code === 'ENOENT' || /ENOENT/.test(run.stderr) || run.code === 127;
}

/**
 * Parse raw whisper-cli stdout into a single clean transcript string: strip the
 * `[hh:mm:ss.mmm --> hh:mm:ss.mmm]` segment timestamp scaffolding, join the segment lines, and
 * normalize all whitespace to single spaces (the known-flaky number-bearing segments survive
 * verbatim — only timestamps and whitespace are touched).
 */
export function parseTranscript(raw: string): string {
  return raw
    .split('\n')
    // Drop the leading bracketed timestamp marker on each segment line, keep the spoken text.
    .map((line) => line.replace(/^\s*\[[^\]]*\]\s*/, ''))
    .join(' ')
    // Collapse every run of whitespace (newlines included) into a single space.
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Transcribe an audio input via the whisper-cli subprocess. ABSENT-TOLERANT: a missing binary
 * (spawn ENOENT) or a non-zero exit returns a typed escalation; never throws across the loop
 * boundary (VOICE-01 / Pitfall 5 / T-03-06).
 */
export async function transcribe(input: WhisperInput): Promise<WhisperResult> {
  const spawnFn = runner ?? realSpawn;
  const run = await spawnFn(WHISPER_CLI, argvFor(input));

  if (isAbsent(run)) {
    // Binary absent — the owner has not built whisper.cpp yet. Probe-then-escalate.
    return {
      ok: false,
      escalation: {
        reason: `whisper.cpp not found — build it (\`${WHISPER_CLI}\` is not on PATH).`,
        recommendation:
          'Build whisper.cpp with the Core ML/ANE backend, put `whisper-cli` on PATH (or set ' +
          'WHISPER_CLI), and supply a model (set WHISPER_MODEL), then retry.',
      },
    };
  }

  if (run.code !== 0) {
    // The binary ran but failed (bad model path, unreadable WAV, decode error). Structured, no throw.
    return {
      ok: false,
      escalation: {
        reason: `whisper-cli exited ${run.code}` + (run.stderr ? `: ${run.stderr.slice(0, 200)}` : ''),
        recommendation:
          'Confirm the model path (WHISPER_MODEL) and the input WAV are valid 16kHz mono, then retry.',
      },
    };
  }

  return { ok: true, transcript: parseTranscript(run.stdout) };
}
