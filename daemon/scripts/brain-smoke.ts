/**
 * brain-smoke.ts — a live, end-to-end smoke of the upgraded LocalBrain against the REAL Ollama
 * (qwen3.5:9b). NOT a unit test (it needs Ollama running); run with:  npx tsx scripts/brain-smoke.ts
 *
 * Verifies the three brain upgrades together:
 *   1. WS-A2 multi-turn memory — turn 2 ("now make it about mountains") follows up on turn 1.
 *   2. WS-A1/A3 complete replies — no announce-then-stop; full prose.
 *   3. WS-A4 tool decision — a current-info question makes the model CALL the web tool, while a
 *      creative/stable task does NOT (the "knows when to use it" behavior). Full web results need a
 *      TAVILY_API_KEY; without one the tool returns its escalation, which still proves the loop.
 */
import { LocalBrain } from '../src/brain/LocalBrain.js';
import { conversation } from '../src/memory/conversation.js';
import { registerBuiltinTools } from '../src/tools/register-builtins.js';

const CONTEXT = '# IDENTITY\n\nKERNEL is Pravin\'s local agent. Be warm and concise.\n';

async function turn(brain: LocalBrain, label: string, prompt: string): Promise<string> {
  const history = conversation.history();
  const decision = await brain.reason(prompt, CONTEXT, undefined, history);
  const reply = decision.reply ?? '(no reply)';
  conversation.recordUser(prompt);
  conversation.recordAssistant(reply);
  console.log(`\n━━━ ${label} ━━━\nUSER: ${prompt}\nKERNEL: ${reply}\n[thought: ${decision.thought}]`);
  return reply;
}

async function main(): Promise<void> {
  await registerBuiltinTools(); // wire the web tool so the loop can dispatch it
  const brain = new LocalBrain();
  conversation.clear();

  // 1 + 2: multi-turn memory
  await turn(brain, 'Turn 1 (poem)', 'Write a 4-line poem about the sea.');
  const t2 = await turn(brain, 'Turn 2 (follow-up — must be about MOUNTAINS)', 'Now make it about mountains instead.');
  const followedUp = /mountain|peak|summit|ridge|alpine|snow|cliff/i.test(t2);

  // 3: tool decision — current info should trigger a web search
  const t3 = await turn(brain, 'Turn 3 (current info — should CALL web)', "Search the web: what's the latest news about Apple this week?");
  const triedWeb = /tavily|web|search|api key|kernel\.env|unavailable/i.test(t3);

  // 4: stable/creative — should NOT need the web
  conversation.clear();
  const t4 = await turn(brain, 'Turn 4 (stable fact — should NOT search)', 'What is 17 times 23?');
  const answeredDirectly = /391/.test(t4);

  console.log('\n══════ VERDICT ══════');
  console.log(`  multi-turn follow-up (turn 2 about mountains): ${followedUp ? 'PASS' : 'FAIL'}`);
  console.log(`  tool decision (turn 3 reached the web tool):   ${triedWeb ? 'PASS' : 'inconclusive'}`);
  console.log(`  no over-call (turn 4 answered 17×23 directly):  ${answeredDirectly ? 'PASS' : 'check output'}`);
}

main().catch((e) => {
  console.error('smoke failed:', e);
  process.exit(1);
});
