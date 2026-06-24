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
import { logger } from '../memory/log.js';

/** The model's lifecycle state for the boot gate. */
export type ModelStatus = 'loading' | 'ready' | 'error';

/** A snapshot of model readiness, broadcast to the Face as a `model.state` frame. */
export interface ModelState {
  status: ModelStatus;
  /** Which brain this state concerns. */
  brain: 'cloud' | 'local';
  /** The model tag (local brain only). */
  model?: string;
  /** A short, human-readable progress/error line for the boot screen. */
  detail?: string;
}

/** The live model state (one daemon, one model). Starts `loading` — warm-up resolves it. */
let current: ModelState = { status: 'loading', brain: 'local', detail: 'Starting…' };

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

/** Set + broadcast the model state. */
function emit(state: ModelState): void {
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

/** Dependencies for warm-up — all injectable so tests never touch a real Ollama. */
export interface WarmupDeps {
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Warm the ACTIVE brain and resolve `model.state`. Cloud → ready immediately (no local load). Local →
 * probe Ollama, confirm the model is installed, then load it; each failure resolves to `error` with an
 * actionable detail. Returns the terminal state. Safe to call again (e.g. on a brain switch).
 */
export async function warmupActiveBrain(
  brain: 'cloud' | 'local',
  deps: WarmupDeps = {},
): Promise<ModelState> {
  if (brain === 'cloud') {
    emit({ status: 'ready', brain: 'cloud', detail: 'Cloud brain (Claude) ready.' });
    return current;
  }

  const baseUrl = deps.baseUrl ?? OLLAMA_BASE_URL;
  const model = deps.model ?? OLLAMA_MODEL;
  const f = deps.fetchImpl ?? fetch;

  emit({ status: 'loading', brain: 'local', model, detail: 'Connecting to Ollama…' });

  if (!(await probeOllama(baseUrl, f))) {
    emit({
      status: 'error',
      brain: 'local',
      model,
      detail: "Ollama isn't running. Start it: `ollama serve` (or `brew services start ollama`).",
    });
    return current;
  }

  const models = await installedModels(baseUrl, f);
  if (!models.includes(model)) {
    emit({
      status: 'error',
      brain: 'local',
      model,
      detail: `Model ${model} isn't installed. Run: \`ollama pull ${model}\`.`,
    });
    return current;
  }

  emit({ status: 'loading', brain: 'local', model, detail: `Loading ${model}…` });

  const loaded = await loadModel(baseUrl, model, f);
  emit(
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
}
