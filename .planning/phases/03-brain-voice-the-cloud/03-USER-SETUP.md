# Phase 3: User Setup Required

**Generated:** 2026-06-22
**Phase:** 03-brain-voice-the-cloud
**Status:** Incomplete

Complete these items for the live brains to function. Claude automated everything possible (all four brains + the helper are unit-tested with the SDK/HTTP/CLI **mocked**, so the daemon builds and the full suite passes WITHOUT any of these). These items unlock the **live** owner checks (real cloud reply, live local inference, a real Claude Code run) — they are not required for the automated phase gate.

## Environment Variables

| Status | Variable | Source | Add to |
|--------|----------|--------|--------|
| [ ] | `ANTHROPIC_API_KEY` | console.anthropic.com → Settings → API Keys → Create Key | `daemon/.env` (loaded via Node 24 `--env-file=.env`) |

`ANTHROPIC_API_KEY` powers both the default **ClaudeBrain** (`@anthropic-ai/sdk`) and **ClaudeCodeBrain** (`claude -p --bare`, which reads the env key, not the keychain). It is read from the env ONLY — never logged by pino, never written to `kernel-memory/` (T-03-03).

## Account Setup

- [ ] **Anthropic account** (for the API key)
  - URL: https://console.anthropic.com
  - Skip if: you already have an API key

## Service Setup (Ollama — optional, for the local brain + 7B helper)

Ollama is **absent on this machine**. Without it, `brain=local` and the always-on 7B helper degrade gracefully to a typed escalation / neutral default (they never crash the loop). To enable live local inference:

- [ ] **Install Ollama**
  - URL: https://ollama.com/download
- [ ] **Pull the pinned model**
  ```bash
  ollama pull qwen2.5:7b-instruct-q4_K_M
  ```
- [ ] **Start the server (idle-unload defaults; never pin keep_alive)**
  ```bash
  OLLAMA_MAX_LOADED_MODELS=1 ollama serve
  ```

## Verification

After completing setup, verify with:

```bash
# 1. Env key is present
grep ANTHROPIC_API_KEY daemon/.env

# 2. Daemon builds + full suite still green (does NOT require any of the above)
cd daemon && npm run build && npm test

# 3. (Optional) Ollama is reachable for the local brain + 7B helper
curl -s http://localhost:11434/api/tags | head
```

Expected:
- Build passes; full daemon suite is green (105 tests) with mocks — no live key/Ollama needed.
- With `ANTHROPIC_API_KEY` set: a live ClaudeBrain reply and a real `claude -p` run succeed (manual owner check).
- With Ollama running + model pulled: `brain=local` returns a live reply (manual owner check).

---

**Once all items complete:** Mark status as "Complete" at top of file.
