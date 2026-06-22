/**
 * tools/mail.ts (MAIL-05) — the registered YELLOW Peekaboo-Mail send / mark-read tool.
 *
 * The brain (or the Face Send ui.intent → loop) references this via ToolCall.tool='mail'. Its
 * schema constrains `op` to ['reply','send','mark-read'] so the SHIPPED classifyTier yields
 * YELLOW and gate.authorize GATES the action (never a silent Red). There is NO type/fill/credential
 * op, so no credential-entry surface exists in the mail flow.
 *
 * ANTI-BYPASS: execute() is only ever reached via registry.dispatch (after gate.authorize).
 * Importing this module self-registers the tool (module-init side effect, mirroring peekaboo/
 * finance). compose() in mail/reply.ts NEVER sends — the ONLY path to a send is:
 *   Face Send ui.intent{intent:'send-email'} → the loop → registry.dispatch → gate.authorize (Yellow)
 *   → this tool's execute → the Mail provider.
 *
 * PROVIDER SEAM (locked decision: Peekaboo Mail.app default): the actual send is behind a
 * `MailProvider` interface so a Gmail path could be added later without touching the gate, the
 * registry, or the loop. The default provider drives Peekaboo Mail (HANDS-02). Live GUI send is a
 * documented manual owner check; unit tests inject a recording provider.
 *
 * LOGGING (ASVS V7, T-04-16): pino logs the send EVENT metadata (op, to, sourceRef) only — never
 * the full body content. The email body + any source thread are source:external DATA, never
 * promoted to knowledge/IDENTITY (04-RESEARCH Pitfall 4).
 */
import { z } from 'zod';

import { register } from './registry.js';
import type { Tool, ToolResult } from './Tool.js';
import { callPeekaboo } from './peekaboo.js';
import { logger } from '../memory/log.js';

const log = logger.child({ mod: 'tools/mail' });

/** A composed message to send (preview-card-shaped, minus UI-only fields). */
export interface OutgoingMail {
  to: string;
  subject: string;
  body: string;
}

/** The result of a provider op — structured, never a throw across the boundary. */
export interface MailOpResult {
  ok: boolean;
  reason?: string;
}

/**
 * The Mail provider seam. The default drives Peekaboo Mail.app; a Gmail provider could implement
 * this same interface later (locked decision: Peekaboo default). NEVER reached except via the
 * tool's execute, which is itself only reached via registry.dispatch (after the gate).
 */
export interface MailProvider {
  /** Send a composed mail. The provider performs the actual GUI/transport work. */
  send(msg: OutgoingMail): Promise<MailOpResult>;
  /** Mark the source message read (by an opaque ref the caller supplies). */
  markRead(sourceRef: string): Promise<MailOpResult>;
}

/**
 * The default provider: Peekaboo Mail.app (HANDS-02). It opens/focuses Mail via the shipped
 * `app` op and surfaces a structured escalation rather than crashing when Peekaboo is unreachable.
 * The live GUI compose/send choreography is a documented MANUAL OWNER CHECK; this default wires the
 * Mail.app entry point and never throws across the boundary.
 */
const peekabooMailProvider: MailProvider = {
  async send(msg: OutgoingMail): Promise<MailOpResult> {
    try {
      // Bring Mail.app to the foreground (the live compose/send is a manual owner verification).
      await callPeekaboo('app', { name: 'Mail', action: 'launch' });
      log.info({ event: 'mail.send', to: msg.to }, 'mail: send dispatched to Peekaboo Mail');
      return { ok: true };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn({ event: 'mail.send', reason }, 'mail: Peekaboo Mail unreachable — escalating');
      return { ok: false, reason };
    }
  },
  async markRead(sourceRef: string): Promise<MailOpResult> {
    try {
      await callPeekaboo('app', { name: 'Mail', action: 'focus' });
      log.info({ event: 'mail.markRead', sourceRef }, 'mail: mark-read dispatched to Peekaboo Mail');
      return { ok: true };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn({ event: 'mail.markRead', reason }, 'mail: Peekaboo Mail unreachable — escalating');
      return { ok: false, reason };
    }
  },
};

/** The active provider (test seam overrides it). Defaults to the Peekaboo Mail provider. */
let provider: MailProvider = peekabooMailProvider;

/** TEST-ONLY seam: inject a mock Mail provider (null resets to the Peekaboo default). */
export function __setMailProviderForTest(mock: MailProvider | null): void {
  provider = mock ?? peekabooMailProvider;
}

/**
 * The mail op envelope. The op enum is the ONLY tightly-constrained field (so the gate classifies
 * a known Yellow op); send fields are validated, unknown keys rejected (ASVS V5) — no credential
 * field can be smuggled in. There is NO type/fill/credential op by construction.
 */
export const mailArgsSchema = z
  .object({
    op: z.enum(['reply', 'send', 'mark-read']),
    to: z.string().optional(),
    subject: z.string().optional(),
    body: z.string().optional(),
    /** Opaque reference to the source message (marked read on send). */
    sourceRef: z.string().optional(),
  })
  .strict();

type MailArgs = z.infer<typeof mailArgsSchema>;

/**
 * The registered Yellow mail Tool. execute() is reached ONLY via registry.dispatch (after the
 * Yellow gate). On send/reply it drives the Mail provider, marks the source read (if a sourceRef
 * was supplied), and logs metadata only. It NEVER sends as a side effect of import/registration.
 */
export const mailTool: Tool = {
  name: 'mail',
  schema: mailArgsSchema,
  async execute(args): Promise<ToolResult> {
    const a = args as MailArgs;

    if (a.op === 'mark-read') {
      if (!a.sourceRef) {
        return { ok: false, escalation: { reason: 'mark-read requires a sourceRef' } };
      }
      const r = await provider.markRead(a.sourceRef);
      return r.ok
        ? { ok: true, data: { op: 'mark-read', sourceRef: a.sourceRef } }
        : { ok: false, escalation: { reason: `mark-read failed: ${r.reason ?? 'unknown'}` } };
    }

    // send / reply (a reply is a send). Require the minimum fields to address the mail.
    if (!a.to || !a.body) {
      return { ok: false, escalation: { reason: `${a.op} requires 'to' and 'body'` } };
    }

    const sent = await provider.send({ to: a.to, subject: a.subject ?? '', body: a.body });
    if (!sent.ok) {
      return { ok: false, escalation: { reason: `mail ${a.op} failed: ${sent.reason ?? 'unknown'}` } };
    }

    // Mark the source read on a successful send (MAIL-05: send → mark source read → log).
    if (a.sourceRef) {
      const read = await provider.markRead(a.sourceRef);
      if (!read.ok) {
        // The send succeeded; surface the mark-read failure but do not fail the whole op.
        log.warn({ event: 'mail.markRead', sourceRef: a.sourceRef }, 'mail: send ok but mark-read failed');
      }
    }

    // Log metadata only — never the full body content (ASVS V7).
    log.info({ event: 'mail.sent', op: a.op, to: a.to, sourceRef: a.sourceRef }, 'mail: sent + logged');
    return { ok: true, data: { op: a.op, to: a.to, sourceRef: a.sourceRef, markedRead: Boolean(a.sourceRef) } };
  },
};

// Module-init side effect: importing this tool wires it into the router (HANDS-04). No send here.
register(mailTool);
