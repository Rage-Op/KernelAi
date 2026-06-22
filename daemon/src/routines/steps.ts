/**
 * steps.ts — one handler per morning-brief step id (ROUT-03/04/05).
 *
 * Each handler is a pure-ish async function `(deps, params) => StepResult`. A StepResult
 * carries the step's `narration` (the spoken line) and a `widgetPlan` (≤2 WidgetPlanItems the
 * engine feeds to the shipped assembleSpeak — never a static grid, ROUT-03). Two handlers also
 * emit a `toolCall` ENVELOPE for the loop to dispatch through registry.dispatch → gate.authorize.
 *
 * ANTI-BYPASS (load-bearing): this module NEVER imports safety/gate.ts or safety/tiers.ts. A step
 * never classifies its own tier — it emits a plain ToolCall ({tool, args}) and the central gate
 * derives the tier from the op (ROUT-05). mail_triage only TAGS via the always-on 7B helper; it
 * never auto-acts (T-04-02). Finance/email data is injected via `deps` (a provider seam) so this
 * plan is unit-testable in isolation — the finance/email plans supply the real providers later.
 */
import { classify } from '../brain/helper.js';
import type { WidgetPlanItem } from '../ipc/cues.js';
import type { ToolCall } from '../brain/BrainProvider.js';
import { logger } from '../memory/log.js';

const log = logger.child({ mod: 'routines/steps' });

// --- Injected provider seam (deps) -------------------------------------------------------

/** A short mail message the brief triages. `source:'external'` marks untrusted content. */
export interface MailMessage {
  sender: string;
  subject: string;
  snippet: string;
  source?: 'external' | 'internal';
}

/** A calendar invitation surfaced for an accept/propose reply (Face EventKit read). */
export interface Invitation {
  title: string;
  organizer?: string;
  source?: 'external' | 'internal';
}

/** Injected, already-fetched data the finance/email plans provide later. Optional here. */
export interface StepDeps {
  /** Correlation id (echoed into each produced speak frame's id). */
  id: string;
  /** Unread messages to triage / announce. */
  messages?: MailMessage[];
  /** Pending calendar invitations (read Face-side via EventKit). */
  invitations?: Invitation[];
  /** Injected balances payload for the accounts widget (finance plan supplies it). */
  balances?: unknown;
  /** Injected spending payload for the spending widget (finance plan supplies it). */
  spending?: unknown;
  /** Injected email-preview payload for the email-preview widget (mail plan supplies it). */
  emailPreview?: unknown;
  /** Injected calendar events payload for the events widget. */
  events?: unknown;
}

/** The structured result of one step handler. */
export interface StepResult {
  /** The spoken line for this step. */
  narration: string;
  /** ≤2 widgets to bloom alongside the narration (ROUT-03). */
  widgetPlan: WidgetPlanItem[];
  /** A ToolCall envelope for the loop to dispatch through the gate (no self-classified tier). */
  toolCall?: ToolCall;
  /** Per-message triage tags (mail_triage only) — for the SUMMARY/log, never auto-acted. */
  tags?: string[];
}

/** A handler runs a single step with the injected deps + its YAML params. */
export type StepHandler = (deps: StepDeps, params: Record<string, unknown>) => Promise<StepResult>;

// --- Handlers ----------------------------------------------------------------------------

const greeting: StepHandler = async () => ({
  narration: 'Good morning.',
  widgetPlan: [],
});

const weather: StepHandler = async () => ({
  narration: "Here's the weather for today.",
  widgetPlan: [],
});

const calendar: StepHandler = async (deps) => {
  const count = countOf(deps.events);
  return {
    narration: `You have ${count} ${count === 1 ? 'event' : 'events'} on the calendar.`,
    widgetPlan: [{ widget: 'events', phrase: `${count}`, data: deps.events }],
  };
};

/**
 * invitations — surface pending invitations and EMIT a Yellow-tier reply envelope. The handler
 * does NOT classify the tier (ROUT-05); the op 'reply' classifies Yellow centrally in tiers.ts.
 */
const invitations: StepHandler = async (deps) => {
  const list = deps.invitations ?? [];
  const first = list[0];
  const narration = first
    ? `There's an invitation: ${first.title}. I can reply.`
    : 'No pending invitations.';
  const result: StepResult = {
    narration,
    widgetPlan: [{ widget: 'events', phrase: 'invitation', data: { invitations: list } }],
  };
  if (first) {
    // Emit a plain ToolCall envelope — the loop dispatches it through registry.dispatch →
    // gate.authorize, which derives the Yellow tier from op:'reply'. NEVER a self-classified tier.
    result.toolCall = {
      tool: 'mail',
      args: { op: 'reply', kind: 'invitation', title: first.title, organizer: first.organizer },
    };
  }
  return result;
};

/**
 * mail_triage — TAG each message log/reply/open/archive via the always-on 7B helper.classify
 * (ROUT-04). Absent-tolerant: with Ollama unreachable classify() returns the neutral default
 * (the first label, 'log'). Triage ONLY tags — it never auto-acts (T-04-02).
 */
const mail_triage: StepHandler = async (deps, params) => {
  const labels = labelsFrom(params);
  const messages = deps.messages ?? [];
  const tags: string[] = [];
  for (const m of messages) {
    // Subject + snippet only — never log the full body or any finance value.
    const text = `${m.subject} — ${m.snippet}`;
    const tag = await classify(text, labels);
    tags.push(tag);
  }
  log.info({ count: messages.length }, 'mail_triage tagged messages');
  const count = messages.length;
  return {
    narration: `You have ${count} ${count === 1 ? 'message' : 'messages'} to triage.`,
    widgetPlan: [{ widget: 'mail', phrase: `${count}`, data: mailWidgetData(messages, tags) }],
    tags,
  };
};

const unread_announce: StepHandler = async (deps) => {
  const messages = deps.messages ?? [];
  const count = messages.length;
  return {
    narration: `${count} unread.`,
    widgetPlan: [{ widget: 'mail', phrase: 'unread', data: mailWidgetData(messages, []) }],
  };
};

/**
 * email_reply — surface the drafted reply in the email-preview widget. NO send happens here:
 * the Send is an explicit Face ui.intent (the Yellow gate lands in 04-02). This step only fills
 * the preview; it emits no auto-send ToolCall.
 */
const email_reply: StepHandler = async (deps) => ({
  narration: "I've drafted a reply for you to review.",
  widgetPlan: [{ widget: 'email-preview', phrase: 'reply', data: deps.emailPreview }],
});

const balances: StepHandler = async (deps) => ({
  narration: "Here are your balances.",
  widgetPlan: [{ widget: 'accounts', phrase: 'balances', data: deps.balances }],
});

const spending: StepHandler = async (deps) => ({
  narration: "And here's your spending.",
  widgetPlan: [{ widget: 'spending', phrase: 'spending', data: deps.spending }],
});

/** The handler registry, keyed by step id (ROUT-01 — ids come from the YAML, not hardcoded order). */
export const handlers: Record<string, StepHandler> = {
  greeting,
  weather,
  calendar,
  invitations,
  mail_triage,
  unread_announce,
  email_reply,
  balances,
  spending,
};

// --- helpers -----------------------------------------------------------------------------

/** Read the labels for mail_triage from params, defaulting to the ROUT-04 label set. */
function labelsFrom(params: Record<string, unknown>): string[] {
  const raw = params.labels;
  if (Array.isArray(raw) && raw.every((x) => typeof x === 'string') && raw.length > 0) {
    return raw as string[];
  }
  return ['log', 'reply', 'open', 'archive'];
}

/** Defensive count read out of an injected events-like payload. */
function countOf(payload: unknown): number {
  if (payload && typeof payload === 'object' && 'count' in payload) {
    const c = (payload as { count?: unknown }).count;
    if (typeof c === 'number' && Number.isFinite(c)) return c;
  }
  return 0;
}

/** Shape the mail-widget data payload (typed fields only — no remote-resource markup). */
function mailWidgetData(messages: MailMessage[], tags: string[]): unknown {
  return {
    count: messages.length,
    items: messages.map((m, i) => ({
      sender: m.sender,
      subject: m.subject,
      snippet: m.snippet,
      source: m.source ?? 'external',
      // The active suggested action (the triage tag) — the Face accent-rings only this chip.
      suggestion: tags[i],
    })),
  };
}
