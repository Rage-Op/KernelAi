# GOAL — KERNEL Intelligence & Presence Upgrade

**Created:** 2026-06-24 · **Status:** proposed (awaiting go) · **Machine:** Apple M2 Pro / 16 GB
**Theme:** Make KERNEL actually smart (brain, memory, tools, internet), well-tested where it
touches the real world (browser/finance), legible (brain-directory viewer), and alive (orb persona).

Grounded in firsthand code reading + a 10-agent discovery/research sweep
(`workflows/scripts/kernel-upgrade-discovery-*.js`). Every root cause below was confirmed in code.

---

## Why KERNEL feels dumb — the three confirmed root causes

1. **No conversation memory (stateless single-shot).** `LocalBrain.reason()` POSTs exactly
   `[system(memory+persona), user(prompt)]` to Ollama `/api/chat` every turn. Ollama keeps **no**
   server-side session state, and the daemon never resends prior turns — so it behaves like a
   disguised `/api/generate`. The model literally cannot see your previous message. This is *the*
   "doesn't remember context between two consecutive prompts" bug.
   *(LocalBrain.ts:88-91, loop.ts:171-174 — confirmed.)*
2. **No tool-calling loop wired to the local brain.** The `Decision.action` seam + a real tool
   registry (browser, peekaboo, mail, finance) exist and `loop.ts` already dispatches
   `decision.action` — but `LocalBrain` never advertises tools to the model and never populates
   `action`. So the model can only emit prose; the MCPs/integrations are unreachable by it, and
   there is **no internet/web-search tool at all**. *(LocalBrain.ts, BrainProvider.ts, loop.ts — confirmed.)*
3. **A 3-sentence system prompt with no scaffolding.** No tool catalog, no when-to-search rule, no
   plan/ReAct structure, no completion contract → the "announce-then-stop" / rambling failure modes
   of small models are unguarded. *(LocalBrain.ts:41-45 — confirmed.)*

---

## Workstreams

### WS-A — Brain upgrade (the "make it smart" core)
One integrated change to the local brain. Sub-parts ordered by dependency.

- **A1 · Model.** *Answers "is there a better model / a distilled one?"* → **Better: yes. Distilled
  reasoning: no, not for this role.** Swap the local model `qwen2.5:7b-instruct-q4_K_M` → a
  current-gen ~8-9B **instruct/tool** model. Verified-available candidates: **`qwen3.5:9b`**
  (~6.6 GB, primary) with **`qwen3.5:4b`** (~3.4 GB) as a lighter, highest-tool-reliability fallback.
  Keep it in **non-thinking/instruct mode** (eager tool dispatch, ~40% fewer tokens). Explicitly
  **reject** distilled-reasoning models (DeepSeek-R1-Distill, Phi-4-reasoning): they *ruminate
  instead of acting* — the exact announce-then-stop failure we already fought — and score far lower
  on tool-calling. Keep Cloud `claude-opus-4-8` (existing menubar toggle) as the hard-reasoning
  escalation tier. **Gate:** pull → local benchmark (full multi-line reply, a real tool dispatch,
  `ollama ps` resident ≤ ~7 GB so the Metal Face stays un-pressured) before making it the default.
  *Near-zero code change — a model-tag swap on the existing `/api/chat` path.*
- **A2 · Conversation memory (the headline fix).** Extend the brain seam additively to
  `reason(prompt, context, history?, onToken?)` with `ChatTurn = {role:'user'|'assistant', content}`.
  New `daemon/src/memory/conversation.ts` `ConversationBuffer` singleton: rolling **~8 turns**,
  **token-budgeted** against `num_ctx − num_predict − estTokens(context) − margin` (reuse
  `estTokens`), **summary-fold** older turns (reuse `compact-cmd.ts`'s summarizer), `clear()` wired
  to `/clear`. **Provenance rule:** only `source:'user'` turns enter the buffer (a poisoned
  email/tool result can never gain conversational standing). System message (IDENTITY+persona+memory)
  stays element 0 / `system` field so front-truncation evicts old dialogue *before* instructions.
  Likely bump `OLLAMA_NUM_CTX` 8192→16384 (verify VRAM headroom).
- **A3 · Prompt / thought-process scaffolding.** Rewrite `SYSTEM_PROMPT` into a **constrained
  plan-then-ReAct** skeleton: short IDENTITY lock · WHEN-TO-USE-TOOLS rule · Hermes-style
  `<tools>` JSON-Schema block (≤8 tools, one-line descriptions) · a 2-5 bullet plan step · brief
  bounded reasoning · **a non-negotiable completion contract** ("every turn ends in exactly one
  `<tool_call>` OR a `Final Answer:` — never end by only describing what you'll do") · **2-4
  few-shot exemplars** (incl. one no-tool case to curb over-calling). Low temperature (0.1-0.3) for
  the agentic loop. This is the single highest-leverage lever against the dumbness.
- **A4 · Tool-calling loop for LocalBrain.** Teach LocalBrain to advertise tools via **Ollama
  native `tools:[…]`** (qwen Hermes template) and map returned `tool_calls` → `Decision.action` →
  `registry.dispatch` → append a `role:'tool'` observation → re-call for the final prose (the
  search→answer round-trip; streaming preserved). **Harness fix:** branch on *presence of
  `tool_calls`*, not `finish_reason` (Ollama returns `stop` even with a call). Loop guards: dedupe
  identical calls, max-iteration cap with a forced final answer, re-prompt-once on
  announce-without-call. Fallback to a JSON-`Decision` catalog in the prompt if native calling is
  flaky on the q4 quant.

### WS-B — Internet access (always available, knows when to use it)
New **GREEN, read-only `daemon/src/tools/web.ts`** modeled on `finance.ts`: ops `search` + `fetch`,
strict zod schema, returns only top 3-5 `{title,url,snippet}` (protect the context window), every
result tagged **`source:'external'`** (data, never instruction — reuses the quarantine/leak seam).
**Backend pluggable** behind an env var: **Tavily** default (LLM-clean text, search+extract in one
key, free tier, no billing instrument) with a **SearXNG self-hosted** adapter for a zero-cost/private
posture. **TTL cache** (news 15-30 min, reference 6-24 h) keyed on normalized query, kept *out* of
`kernel-memory`. **When-to-search calibration** lives in the tool *description* ("use for current/
unknown info or when unsure; do NOT search stable facts you know") + a one-line balancing clause in
the system prompt. Validate with a small must-search / must-not-search eval set. *(Depends on A4.)*

### WS-C — Browser automation hardening (finance & automation, well-tested)
Current: Playwright 1.61 headful Chromium, isolated persistent profile, navigate/scrape/fill through
the single gate chokepoint. Harden for real, flaky, authenticated sites:
- Exponential-backoff retry around `goto()` (transient errors stop escalating).
- **Session validation + recovery** (detect logged-out state; offer gate-approved re-login).
- Configurable timeouts + per-site profiles (drop the hardcoded 2000 ms; default 10 s for finance).
- **2FA / CAPTCHA detection → gated owner handoff** in the headful window, then resume.
- **URL allowlist + navigation audit trail**; escalate on off-allowlist redirects.
- **Peekaboo GUI fallback** when a role/label/text locator returns zero elements + richer diagnostics.
- A documented **finance e2e test plan** (sandbox: login → fill(email, Yellow) → password(Red) →
  2FA → scrape balance → cookie persistence) as the integration baseline.

### WS-D — Brain-directory file icon (Face, legibility)
Add a 6th `ControlDock` button (SF Symbol `brain.head.profile` or `folder`, "View brain directory")
→ new `AppCoordinator.revealBrainDirectory()` → `NSWorkspace.shared.selectFile(nil,
inFileViewerRootedAtPath: <kernel-memory>)` revealing IDENTITY.md / self/ / knowledge/ in Finder.
Dock has room (6×42px + gaps ≪ window width). **Stretch:** an in-app read-only panel for
IDENTITY.md + the soul/identity files. *(Small, independent — good first win.)*

### WS-E — Orb persona redesign (Face, "alive")
Current: ~40 k flat additive point-sprites, uniform brightness/size → "too big, too many dots,
underwhelming." Fix is **fewer-but-better**, not more. Direction: a compact luminous orb (~40-55% of
view) = soft **core** + **3-8 k well-shaded particles** + a glowing **fresnel rim**, composited in
HDR with **dual-filter bloom**, organic **curl-noise** churn, subtle **iridescence + sparkle**, and
**four distinct audio-reactive states** (idle/listening/thinking/speaking) eased with a critically-
damped spring. Audio-reactive via mic RMS (listening) + TTS envelope (speaking) → radius/brightness/
displacement. Palette: warm terracotta body with cool cyan/violet energy accents (Apple-Intelligence
glow family); ACES tonemap. Concrete drop-in starting numbers captured in the research (particle
counts, point sizes, curl freq/strength, fresnel exponents, bloom knees, audio gains).

---

## Suggested sequence
1. **WS-D** (quick, independent, visible win) →
2. **WS-A** A2 → A3 → A1 → A4 (the brain; A2 alone kills the headline "dumb" complaint) →
3. **WS-B** (internet, builds on A4) →
4. **WS-C** (browser hardening) →
5. **WS-E** (orb — the big visual polish; independent, can run in parallel with daemon work).

## Verification (per the Stop-hook discipline)
- Daemon: `npm test` stays green + new tests (conversation buffer, web tool, tool-loop, browser
  hardening). Face: `xcodebuild … test` stays green + new tests.
- **Live smoke** for the brain: two consecutive prompts where the 2nd references the 1st ("write a
  haiku about the sea" → "now make it about mountains") — it must follow up. A web-search query that
  needs current info must trigger the tool; a stable fact must NOT. The orb must read as a small,
  alive, depth-rich persona with distinct states. The file icon reveals `kernel-memory` in Finder.

## Open decisions (need owner input — see questions)
- Approve the **model swap** (downloads ~6.6 GB; changes behavior) vs. stay on qwen2.5:7b.
- **Internet backend**: Tavily (free key) vs self-hosted SearXNG (Docker) vs defer internet.
- Build **autonomously now** in the sequence above, or review the plan first.

## Constraints (carried)
FrameSchema frozen (additive Swift mirrors only) · TCC/bundle identity stable · no secrets/finance
in the Face · API keys in `~/.kernel.env` (chmod 600), never in `kernel-memory` · accent discipline.
