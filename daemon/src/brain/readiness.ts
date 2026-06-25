/**
 * readiness.ts (BRAIN-07) — model warm-up + a broadcastable readiness state, so the Face can hold
 * its boot screen until the model is actually ready to take a prompt (no cold first turn).
 *
 * The LOCAL engine is LM Studio (its server loads the model itself). This module probes it at daemon
 * boot and reports progress as a `model.state` frame the Face mirrors:
 *
 *     loading ──▶ ready          (LM Studio up + a model loaded)
 *     loading ──▶ error          (LM Studio server down / no model loaded) — with a plain-language,
 *                                 actionable detail; the Face shows it + a Retry.
 *
 * The cloud brain has no local load → it reports `ready` immediately. State is a module singleton
 * (one daemon) with an injected broadcast hook (set at boot, mirroring setBreakerBroadcast), so this
 * module has NO static dependency on the server (no import cycle). Every probe is injectable
 * (fetchImpl) + timeout-guarded so a wedged server can never hang the warm-up.
 */
import { LMSTUDIO_BASE_URL, LMSTUDIO_MODELS_URL, resolveLmStudioModel } from './LMStudioBrain.js';
import { logger } from '../memory/log.js';

/** The model's lifecycle state for the boot gate. */
export type ModelStatus = 'loading' | 'ready' | 'error';

/** Which engine a readiness snapshot concerns: the LOCAL `lmstudio` engine, or `cloud` (Claude). */
export type BrainKind = 'cloud' | 'lmstudio';

/** A snapshot of model readiness, broadcast to the Face as a `model.state` frame. */
export interface ModelState {
  status: ModelStatus;
  /** Which brain this state concerns. */
  brain: BrainKind;
  /** The model tag (local engines only). */
  model?: string;
  /** A short, human-readable progress/error line for the boot screen. */
  detail?: string;
}

/** The live model state (one daemon, one model). Starts `loading` — warm-up resolves it. */
let current: ModelState = { status: 'loading', brain: 'lmstudio', detail: 'Starting…' };

/**
 * Monotonic warm-up generation. Each `warmupActiveBrain` call captures `++generation` and only its
 * own emits are honored while it is the latest — so a SLOW in-flight warm-up (e.g. a cold 9B Ollama
 * load, up to 120s) can't clobber the state of a NEWER warm-up started by a brain switch. Without
 * this, the stale warm-up's terminal emit would land last on the shared singleton and broadcast the
 * wrong brain/status to every Face (and to the next client on connect).
 */
let generation = 0;

/** The server-injected push that broadcasts a `model.state` frame to every connected Face. */
let broadcastFn: ((state: ModelState) => void) | null = null;

/** The IPC server injects its broadcast here at startup (avoids a server↔readiness import cycle). */
export function setModelBroadcast(fn: ((state: ModelState) => void) | null): void {
  broadcastFn = fn;
}

/** The current model state — sent to a client on connect (so a warm daemon transitions instantly). */
export function getModelState(): ModelState {
  return current;
}

/** Set + broadcast the model state, but ONLY if `gen` is still the latest warm-up generation — a
 *  superseded warm-up drops its (possibly contradictory) emit instead of clobbering the active brain. */
function emitFor(gen: number, state: ModelState): void {
  if (gen !== generation) return; // a newer warm-up has taken over — ignore this stale transition
  current = state;
  logger.info({ event: 'model.state', ...state }, `model ${state.status}`);
  broadcastFn?.(state);
}

/** A fetch with a hard timeout so a wedged server can never hang warm-up. */
async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  ms: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** True iff LM Studio's OpenAI-compatible server answers `GET /v1/models` (i.e. it is running). */
export async function probeLmStudio(
  baseUrl: string = LMSTUDIO_BASE_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const url = baseUrl === LMSTUDIO_BASE_URL ? LMSTUDIO_MODELS_URL : `${baseUrl}/v1/models`;
    const res = await fetchWithTimeout(fetchImpl, url, { method: 'GET' }, 3000);
    return res.ok;
  } catch {
    return false;
  }
}

/** Dependencies for warm-up — all injectable so tests never touch a real LM Studio. */
export interface WarmupDeps {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Warm the ACTIVE brain and resolve `model.state`. Cloud → ready immediately (no local load). LM Studio
 * → probe its server and confirm a model is loaded (LM Studio loads models itself; we don't force-load).
 * Each failure resolves to `error` with an actionable detail. Returns the terminal state. Safe to call
 * again (brain switch).
 */
export async function warmupActiveBrain(
  brain: BrainKind,
  deps: WarmupDeps = {},
): Promise<ModelState> {
  const gen = ++generation; // claim this warm-up's generation; later emits no-op if superseded

  if (brain === 'cloud') {
    emitFor(gen, { status: 'ready', brain: 'cloud', detail: 'Cloud brain (Claude) ready.' });
    return current;
  }

  // brain === 'lmstudio' — the only LOCAL engine.
  const f = deps.fetchImpl ?? fetch;
  emitFor(gen, { status: 'loading', brain: 'lmstudio', detail: 'Connecting to LM Studio…' });
  if (!(await probeLmStudio(deps.baseUrl, f))) {
    emitFor(gen, {
      status: 'error',
      brain: 'lmstudio',
      detail:
        "LM Studio's server isn't running. Open LM Studio → developer tab → Start (or `lms server start`).",
    });
    return current;
  }
  const model = await resolveLmStudioModel(f);
  emitFor(
    gen,
    model
      ? { status: 'ready', brain: 'lmstudio', model, detail: `LM Studio ready — ${model}.` }
      : {
          status: 'error',
          brain: 'lmstudio',
          detail: 'LM Studio is running but no model is loaded. Load a model (MLX or GGUF) in LM Studio.',
        },
  );
  return current;
}

/** TEST-ONLY: reset the singleton to its initial loading state. */
export function __resetModelStateForTest(): void {
  current = { status: 'loading', brain: 'lmstudio', detail: 'Starting…' };
  broadcastFn = null;
  generation = 0;
}
