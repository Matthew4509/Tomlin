// A sustained speed run: keeps a loaded model writing for a set time (default 5 minutes) and reports how fast it wrote,
// minute by minute and overall, so a heat or memory slowdown shows. It talks to TOMLIN's own /v1 door (or any OpenAI-style
// server), so the model, its settings (Run on: CPU, threads, context) are whatever is loaded now; it changes none of them.
//   node tools/speedrun.ts [--url http://127.0.0.1:8740] [--seconds 300] [--max 256] [--key <api key>] [--think]
//   (an installed copy: "<install folder>\tomlin-<version>\runtime\node\node.exe" tools\speedrun.ts)
// Each request starts "Run N." so nothing is answered from a cache; temperature 0. Speed is counted from the first word
// to the last word of each answer (the wait for the first word is reported apart). Results also go to speedrun-<time>.jsonl in the folder it is run from.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { WRITE_PROMPT } from '../src/finderrun.ts';

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const base = opt('url', 'http://127.0.0.1:8740').replace(/\/+$/, '');
const seconds = Math.max(10, Number(opt('seconds', '300')));
const maxTokens = Math.max(16, Number(opt('max', '256')));
const key = opt('key', '');
const think = argv.includes('--think');
const out = join(process.cwd(), `speedrun-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
const headers = { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) };

const models = await fetch(`${base}/v1/models`, { headers }).then(r => r.json() as Promise<{ data?: { id: string }[] }>).catch(() => null);
const model = models?.data?.[0]?.id;
if (!model) {
  console.error(`No model answered at ${base}/v1/models. Load one in TOMLIN first (press Connect), then run this again.`);
  process.exit(1);
}
console.log(`Model: ${model}`);
console.log(`Writing for ${seconds} s (answers of up to ${maxTokens} tokens, back to back) at ${new Date().toLocaleTimeString()} ...`);

interface Row { n: number; atS: number; firstWordS: number; tps: number; tokens: number }
const rows: Row[] = [];
const start = performance.now();

async function one(n: number): Promise<Row | null> {
  const body = { model, stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: `Run ${n}.\n${WRITE_PROMPT}` }], max_tokens: maxTokens, temperature: 0, seed: 42, cache_prompt: false, ...(think ? {} : { chat_template_kwargs: { enable_thinking: false } }) };
  const t0 = performance.now();
  const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok || !r.body) throw new Error(`${r.status} ${await r.text()}`);
  let first = 0, last = 0, chunks = 0, tokens = 0, buf = '';
  const dec = new TextDecoder();
  for await (const part of r.body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(part, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const d = line.slice(5).trim();
      if (d === '[DONE]') continue;
      const j = JSON.parse(d);
      if (j.usage?.completion_tokens) tokens = j.usage.completion_tokens;
      const delta = j.choices?.[0]?.delta ?? {};
      if ((delta.content ?? '') + (delta.reasoning_content ?? delta.reasoning ?? '')) {
        const now = performance.now();
        if (!first) first = now;
        last = now;
        chunks++;
      }
    }
  }
  const count = tokens || chunks;
  if (!first || count < 2 || last <= first) return null;
  return { n, atS: (t0 - start) / 1000, firstWordS: (first - t0) / 1000, tps: (count - 1) / ((last - first) / 1000), tokens: count };
}

for (let n = 0; (performance.now() - start) / 1000 < seconds; n++) {
  const row = await one(n).catch(e => {
    console.error(`Request ${n} failed: ${(e as Error).message}`);
    return null;
  });
  if (!row) continue;
  if (n > 0) rows.push(row); // the first is a warm-up (loading, cold caches) and is not counted
  appendFileSync(out, `${JSON.stringify({ ...row, warmup: n === 0 })}\n`);
  console.log(`#${n}${n === 0 ? ' (warm-up, not counted)' : ''} at ${row.atS.toFixed(0)} s: first word ${row.firstWordS.toFixed(1)} s, ${row.tps.toFixed(2)} tok/s (${row.tokens} tokens)`);
}

if (!rows.length) {
  console.log('No finished answer to count.');
  process.exit(1);
}
const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const totalTokens = rows.reduce((s, r) => s + r.tokens, 0);
const writing = rows.reduce((s, r) => s + r.tokens / r.tps, 0);
console.log('\nBy minute (answers started in that minute):');
for (let m = 0; m * 60 < seconds; m++) {
  const inMin = rows.filter(r => r.atS >= m * 60 && r.atS < (m + 1) * 60);
  if (inMin.length) console.log(`  minute ${m + 1}: ${inMin.length} answers, median ${med(inMin.map(r => r.tps)).toFixed(2)} tok/s (${Math.min(...inMin.map(r => r.tps)).toFixed(2)}-${Math.max(...inMin.map(r => r.tps)).toFixed(2)})`);
}
const half = Math.floor(rows.length / 2) || 1;
console.log(`\nOverall: ${rows.length} answers, ${totalTokens} tokens, median ${med(rows.map(r => r.tps)).toFixed(2)} tok/s, average ${(totalTokens / writing).toFixed(2)} tok/s while writing.`);
console.log(`First half median ${med(rows.slice(0, half).map(r => r.tps)).toFixed(2)}, second half median ${med(rows.slice(half).map(r => r.tps)).toFixed(2)} tok/s (a lower second half means it slowed as it ran).`);
console.log(`First word: median ${med(rows.map(r => r.firstWordS)).toFixed(1)} s.`);
console.log(`Rows kept in ${out}`);
