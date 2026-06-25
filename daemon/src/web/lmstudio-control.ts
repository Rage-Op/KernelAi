/**
 * lmstudio-control.ts — daemon-side LM Studio MODEL control for the web Face.
 *
 * Lets the owner list the models LM Studio has downloaded, see which one is loaded (+ its context
 * window and capabilities), and LOAD / UNLOAD a model — driving LM Studio's NATIVE REST API
 * (`/api/v1`, LM Studio 0.4.0+) rather than the read-only OpenAI-compat surface. Like `services.ts`
 * this is a CONTROL surface reached only over the token-gated, loopback-bound web server by the owner —
 * never the model's gated tools. It can only talk to LM Studio on localhost and only act on a model KEY
 * that LM Studio actually lists (an unknown key is refused by both this module and LM Studio), so there
 * is no arbitrary-command path here. ABSENT-TOLERANT: a stopped/unreachable LM Studio yields
 * `serverUp:false`, never a throw.
 *
 * v1 contract (confirmed against LM Studio 0.4.16):
 *   GET  /api/v1/models                         → { models: [ { key, display_name, format, size_bytes,
 *                                                   params_string, max_context_length, loaded_instances:
 *                                                   [{ id, config:{ context_length } }], capabilities:
 *                                                   { trained_for_tool_use, reasoning } } ] }
 *   POST /api/v1/models/load    { model, context_length? }   → instance info (or { error })
 *   POST /api/v1/models/unload  { instance_id }              → ok (or { error }); the instance_id is the
 *                                                              loaded_instances[].id, NOT the model key.
 */
import { LMSTUDIO_BASE_URL, LMSTUDIO_MODEL } from '../brain/LMStudioBrain.js';
import { logger } from '../memory/log.js';

/** LM Studio native REST base (respects KERNEL_LMSTUDIO_URL via LMSTUDIO_BASE_URL). */
const V1 = `${LMSTUDIO_BASE_URL}/api/v1`;

/** One model row the web control panel renders. */
export interface LmStudioModelInfo {
  key: string;
  displayName: string;
  format?: string;
  sizeBytes?: number;
  paramsString?: string;
  maxContextLength?: number;
  loaded: boolean;
  loadedContextLength?: number;
  instanceId?: string;
  reasoning?: boolean;
  toolUse?: boolean;
}

export interface LmStudioInventory {
  serverUp: boolean;
  models: LmStudioModelInfo[];
}

/** The raw v1 model entry shape (only the fields we read). */
interface RawV1Model {
  type?: string;
  key?: string;
  display_name?: string;
  format?: string;
  size_bytes?: number;
  params_string?: string;
  max_context_length?: number;
  loaded_instances?: { id?: string; config?: { context_length?: number } }[];
  capabilities?: { trained_for_tool_use?: boolean; reasoning?: unknown };
}

/** fetch with a hard timeout so a wedged LM Studio can never hang the web handler. */
async function v1Fetch(pathname: string, init: RequestInit, ms = 5000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(`${V1}${pathname}`, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Pull a short, human-readable error message out of LM Studio's `{ error: { message } }` body. */
function errMsg(body: unknown, fallback: string): string {
  const e = (body as { error?: { message?: string } } | null)?.error;
  return (e && typeof e.message === 'string' && e.message) || fallback;
}

/** Map a raw v1 entry to the compact row. */
function toInfo(m: RawV1Model): LmStudioModelInfo {
  const inst = m.loaded_instances?.[0];
  const reasoning = m.capabilities?.reasoning;
  return {
    key: m.key ?? '',
    displayName: m.display_name || m.key || '(unknown)',
    format: m.format,
    sizeBytes: m.size_bytes,
    paramsString: m.params_string,
    maxContextLength: m.max_context_length,
    loaded: (m.loaded_instances?.length ?? 0) > 0,
    loadedContextLength: inst?.config?.context_length,
    instanceId: inst?.id,
    // `reasoning` is an object (allowed_options/default) when the model supports it, absent otherwise.
    reasoning: reasoning != null && typeof reasoning === 'object',
    toolUse: m.capabilities?.trained_for_tool_use === true,
  };
}

/** The downloaded LM Studio models (chat models only — embeddings are filtered out). */
export async function listLmStudioModels(): Promise<LmStudioInventory> {
  let res: Response;
  try {
    res = await v1Fetch('/models', { method: 'GET' });
  } catch {
    return { serverUp: false, models: [] };
  }
  if (!res.ok) return { serverUp: true, models: [] };
  const body = (await res.json().catch(() => null)) as { models?: RawV1Model[] } | null;
  const raw = body?.models ?? [];
  const models = raw
    // Keep chat models only — LM Studio's v1 reports embedding models as type 'embedding' (and older
    // surfaces as 'embeddings'); a model with no type is kept (treated as a usable LLM).
    .filter((m) => !(m.type ?? '').startsWith('embedding') && typeof m.key === 'string')
    .map(toInfo);
  return { serverUp: true, models };
}

/** The model key the brain's resolver would currently drive (pin wins, else the first loaded model). */
export function activeModelKey(inv: LmStudioInventory): string | undefined {
  if (LMSTUDIO_MODEL) return LMSTUDIO_MODEL;
  return inv.models.find((m) => m.loaded)?.key;
}

/**
 * Load a model by key, optionally at a specific context length. Refuses a key LM Studio doesn't list
 * (defence in depth — LM Studio also validates). Returns a short human-readable outcome; never throws.
 */
export async function loadLmStudioModel(key: string, contextLength?: number): Promise<string> {
  const inv = await listLmStudioModels();
  if (!inv.serverUp) return 'LM Studio is not running';
  if (!inv.models.some((m) => m.key === key)) return `unknown model: ${key}`;
  let res: Response;
  try {
    res = await v1Fetch(
      '/models/load',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: key, ...(contextLength ? { context_length: contextLength } : {}) }),
      },
      // Loading a model can take many seconds (disk → GPU); give it a generous deadline.
      120_000,
    );
  } catch {
    return `load timed out for ${key}`;
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) return errMsg(body, `load failed (HTTP ${res.status})`);
  logger.info({ key, contextLength }, 'lm studio model loaded via web control');
  const ctx = contextLength ? ` @ ${contextLength} ctx` : '';
  return `Loaded ${key}${ctx}`;
}

/** Unload a model (resolving its live instance_id from the inventory). Returns a short outcome. */
export async function unloadLmStudioModel(key: string): Promise<string> {
  const inv = await listLmStudioModels();
  if (!inv.serverUp) return 'LM Studio is not running';
  const target = inv.models.find((m) => m.key === key);
  if (!target?.loaded) return `${key} is not loaded`;
  const instanceId = target.instanceId ?? key;
  let res: Response;
  try {
    res = await v1Fetch('/models/unload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instance_id: instanceId }),
    });
  } catch {
    return `unload timed out for ${key}`;
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) return errMsg(body, `unload failed (HTTP ${res.status})`);
  logger.info({ key, instanceId }, 'lm studio model unloaded via web control');
  return `Unloaded ${key}`;
}
