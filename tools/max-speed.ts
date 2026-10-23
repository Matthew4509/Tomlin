// Measures the chat model loaded in TOMLIN on this PC, the same way every time, for Max mode's speed test
// (docs/handoffs/HANDOFF-2026-10-23-MAX-MODE-PLUMBING.md): writing speed from a short question, reading speed from a
// long one, each asked three times. TOMLIN must be running with the model loaded and its page open (the /v1 door
// passes only then). Nothing is saved; the figures are printed.
//   node tools/max-speed.ts            (TOMLIN on 8740)
//   node tools/max-speed.ts 8741
const port = Number(process.argv[2]) || 8740;
const base = `http://127.0.0.1:${port}`;

// About 2,000 tokens of plain text to read (the same every run).
const LONG = Array.from({ length: 80 }, (_, i) => `Line ${i + 1}: the storage shed holds ${i % 7 + 2} boxes of tiles, ${i % 5 + 1} ladders and a blue tarp.`).join('\n');

async function ask(content: string, maxTokens: number): Promise<{ read: number; write: number; promptTokens: number; written: number }> {
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content }], max_tokens: maxTokens, temperature: 0, cache_prompt: false, chat_template_kwargs: { enable_thinking: false } }),
  });
  const j = (await r.json().catch(() => ({}))) as { timings?: Record<string, number>; error?: { message?: string } | string };
  if (!r.ok || !j.timings) throw new Error(`TOMLIN answered ${r.status}: ${typeof j.error === 'string' ? j.error : j.error?.message ?? 'no timings'}`);
  const t = j.timings;
  return { read: t.prompt_per_second, write: t.predicted_per_second, promptTokens: t.prompt_n, written: t.predicted_n };
}

const status = (await (await fetch(`${base}/api/status`)).json().catch(() => null)) as { panes?: { chat?: { modelName?: string; note?: string; state?: string } } } | null;
const chat = status?.panes?.chat;
console.log(`Model: ${chat?.modelName ?? '(could not read; is the page open?)'}${chat?.state ? ` (${chat.state})` : ''}`);
if (chat?.note) console.log(`Loaded as: ${chat.note}`);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const writes: number[] = [];
const reads: number[] = [];
for (let i = 1; i <= 3; i++) {
  const w = await ask('Write a 150-word description of a garden shed. Plain prose, no lists.', 200);
  writes.push(w.write);
  const l = await ask(`${LONG}\n\nHow many lines mention a blue tarp? Answer with one number.`, 8);
  reads.push(l.read);
  console.log(`Run ${i}: writing ${w.write.toFixed(1)} tok/s (${w.written} tokens) | reading ${l.read.toFixed(1)} tok/s (${l.promptTokens} tokens)`);
}
console.log(`Middle of three: writing ${median(writes).toFixed(1)} tok/s, reading ${median(reads).toFixed(1)} tok/s`);
