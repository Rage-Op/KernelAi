/**
 * cues.ts — the daemon-side choreography PRODUCER (CLOUD-04).
 *
 * `assembleSpeak(id, reply, widgetPlan)` turns a reply string + a planned widget sequence into
 * ONE `speak` frame whose cues are keyed to CHARACTER OFFSETS in `reply` — a `stage.present` cue
 * at the char where each widget's topic phrase begins, with `onFinish` dissolving the LAST
 * presented widget. The daemon ships ALL cues up front and NEVER emits timing: the Face's TTS
 * clock (`willSpeakRangeOfSpeechString`) is the metronome (ARCHITECTURE choreography contract).
 *
 * Invariants the frame guarantees (and cues.test.ts checks):
 *   - validates against the frozen `SpeakSchema` (no schema change — this is the producer).
 *   - cues sorted ascending by `atChar`; every `atChar` in [0, reply.length].
 *   - one `stage.present` cue per planned widget, located at its phrase's offset (0 if not found).
 *   - `onFinish` dissolves the last-presented widget (by offset), so nothing lingers after speech.
 */
import { type Speak } from './protocol.js';

/** A planned widget: which widget to bloom, the phrase in `reply` it accompanies, its data. */
export interface WidgetPlanItem {
  /** The widget id the Face renders (e.g. 'events', 'accounts'). */
  widget: string;
  /** A substring of `reply` whose start offset anchors the present cue. */
  phrase: string;
  /** Optional structured payload for the widget (rendered as data, never auto-loaded markup). */
  data?: unknown;
}

/** A single cue, mirroring the frozen SpeakSchema cue shape. */
interface Cue {
  atChar: number;
  action: string;
  widget?: string;
  data?: unknown;
}

/**
 * Assemble a `speak` frame. With an empty plan, `cues` is `[]` and `onFinish` is omitted —
 * a plain spoken reply with no choreography.
 */
export function assembleSpeak(id: string, reply: string, widgetPlan: WidgetPlanItem[]): Speak {
  // Build one present cue per planned widget, anchored at its phrase offset (clamped into range).
  const cues: Cue[] = widgetPlan.map((item) => {
    const idx = reply.indexOf(item.phrase);
    const atChar = idx >= 0 ? idx : 0; // phrase not found → anchor at the start (still in-range)
    return { atChar, action: 'stage.present', widget: item.widget, data: item.data };
  });

  // Sort ascending by character offset — the Face fires cues as the TTS clock crosses each offset.
  cues.sort((a, b) => a.atChar - b.atChar);

  // onFinish dissolves the LAST presented widget (by offset) so nothing lingers after speech ends.
  const lastPresented = cues.length ? cues[cues.length - 1].widget : undefined;
  const onFinish = lastPresented ? [{ action: 'stage.dismiss', widget: lastPresented }] : undefined;

  const frame: Speak = {
    type: 'speak',
    id,
    text: reply,
    cues,
    ...(onFinish ? { onFinish } : {}),
  };
  return frame;
}
