/**
 * tool-smoke.ts — live check that the upgraded LocalBrain now SELECTS the right tool (WS-A4 + the
 * expanded catalog/exemplars). Needs Ollama + a TAVILY_API_KEY in the env. Run:
 *   set -a; source ~/.kernel.env; set +a; npx tsx scripts/tool-smoke.ts
 * The registry's pino "gate: classified" lines reveal which tool was dispatched per turn.
 */
import { LocalBrain } from '../src/brain/LocalBrain.js';
import { conversation } from '../src/memory/conversation.js';
import { registerBuiltinTools } from '../src/tools/register-builtins.js';

const CONTEXT = "# IDENTITY\n\nKERNEL is Pravin's local agent.\n";

async function turn(brain: LocalBrain, label: string, prompt: string): Promise<void> {
  conversation.clear(); // isolate each probe
  const d = await brain.reason(prompt, CONTEXT);
  console.log(`\n━━━ ${label} ━━━\nQ: ${prompt}\nA: ${(d.reply ?? '').slice(0, 280)}\n[${d.thought}]`);
}

async function main(): Promise<void> {
  await registerBuiltinTools();
  const brain = new LocalBrain();
  await turn(brain, 'finance (expect: finance tool)', 'How much did I spend this month?');
  await turn(brain, 'web (expect: web tool, real results)', 'What is the latest news about Apple this week?');
  await turn(brain, 'math (expect: NO tool)', 'What is 12 times 8?');
  await turn(brain, 'geography (expect: NO tool)', 'What is the capital of France?');
}

main().catch((e) => {
  console.error('smoke failed:', e);
  process.exit(1);
});
