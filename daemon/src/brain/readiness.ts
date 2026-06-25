/**
 * readiness.ts (BRAIN-07) — model warm-up + a broadcastable readiness state, so the Face can hold
 * its boot screen until the model is actually LOADED and ready to take a prompt (no cold first turn).
 *
 * The local model (qwen3.5:9b via Ollama) lazy-loads into memory on the FIRST request — several
 * seconds on a cold box — which is why the very first prompt used to crawl. This module force-loads
 * it at daemon boot and reports progress as a `model.state` frame the Face mirrors:
 *
 *     loading ──▶ ready          (Ollama up, model installed, weights resident)
 *     loading ──▶ error          (Ollama down / model not installed / load failed) — with a
 *                                 plain-language, actionable detail; the Face shows it + a Retry.
 *
 * The cloud brain has no local load → it reports `ready` immediately. State is a module singleton
 * (one daemon) with an injected broadcast hook (set by the IPC server, mirroring setBreakerBroadcast),
 * so this module has NO static dependency on the server (no import cycle). Every Ollama call is
 * injectable (fetchImpl) + timeout-guarded so a wedged server can never hang the warm-up.
 */
import { OLLAMA_BASE_URL, OLLAMA_MODEL } from './LocalBrain.js';
import { LMSTUDIO_BASE_URL, LMSTUDIO_MODELS_URL, resolveLmStudioModel } from './LMStudioBrain.js';
import { logger } from '../memory/log.js';

/** The model's lifecycle state for the boot gate. */
export type ModelStatus = 'loading' | 'ready' | 'error';

/** Which engine a readiness snapshot concerns. `lmstudio` is the second local engine (LM Studio). */
export type BrainKind = 'cloud' | 'local' | 'lmstudio';

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
let current: ModelState = { status: 'loading', brain: 'local', detail: 'Starting…' };

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

/** A fetch with a hard timeout so a wedged Ollama can never hang warm-up. */
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

/** True iff the Ollama server answers `GET /api/tags` (i.e. it is running). */
export async function probeOllama(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(fetchImpl, `${baseUrl}/api/tags`, { method: 'GET' }, 3000);
    return res.ok;
  } catch {
    return false;
  }
}

/** The installed model tags from `GET /api/tags` (e.g. ["qwen3.5:9b"]); [] on any error. */
export async function installedModels(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  try {
    const res = await fetchWithTimeout(fetchImpl, `${baseUrl}/api/tags`, { method: 'GET' }, 3000);
    if (!res.ok) return [];
    const body = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
    return (body.models ?? []).map((m) => m.name ?? m.model ?? '').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Force-load a model into memory via `POST /api/generate` with an empty prompt (Ollama's documented
 * preload — it loads the weights and returns without generating). Returns true on a 200. Generous
 * timeout: a cold 9B load can take tens of seconds.
 */
export async function loadModel(
  baseUrl: string,
  model: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      `${baseUrl}/api/generate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, prompt: '', stream: false }),
      },
      120_000,
    );
    return res.ok;
  } catch {
    return false;
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

/** Dependencies for warm-up — all injectable so tests never touch a real Ollama / LM Studio. */
export interface WarmupDeps {
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Warm the ACTIVE brain and resolve `model.state`. Cloud → ready immediately (no local load). Local
 * (Ollama) → probe, confirm the model is installed, then load it. LM Studio → probe its server and
 * confirm a model is loaded (LM Studio loads models itself; we don't force-load). Each failure resolves
 * to `error` with an actionable detail. Returns the terminal state. Safe to call again (brain switch).
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

  if (brain === 'lmstudio') {
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

  const baseUrl = deps.baseUrl ?? OLLAMA_BASE_URL;
  const model = deps.model ?? OLLAMA_MODEL;
  const f = deps.fetchImpl ?? fetch;

  emitFor(gen, { status: 'loading', brain: 'local', model, detail: 'Connecting to Ollama…' });

  if (!(await probeOllama(baseUrl, f))) {
    emitFor(gen, {
      status: 'error',
      brain: 'local',
      model,
      detail: "Ollama isn't running. Start it: `ollama serve` (or `brew services start ollama`).",
    });
    return current;
  }

  const models = await installedModels(baseUrl, f);
  if (!models.includes(model)) {
    emitFor(gen, {
      status: 'error',
      brain: 'local',
      model,
      detail: `Model ${model} isn't installed. Run: \`ollama pull ${model}\`.`,
    });
    return current;
  }

  emitFor(gen, { status: 'loading', brain: 'local', model, detail: `Loading ${model}…` });

  const loaded = await loadModel(baseUrl, model, f);
  emitFor(
    gen,
    loaded
      ? { status: 'ready', brain: 'local', model, detail: `${model} loaded — ready.` }
      : { status: 'error', brain: 'local', model, detail: `Model ${model} failed to load.` },
  );
  return current;
}

/** TEST-ONLY: reset the singleton to its initial loading state. */
export function __resetModelStateForTest(): void {
  current = { status: 'loading', brain: 'local', detail: 'Starting…' };
  broadcastFn = null;
  generation = 0;
}
