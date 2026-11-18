// Does "At once" (src/slots.ts) pay on this PC? Starts llama-server by itself (on a private port, with the same
// arguments TOMLIN would give it: src/llama.ts chatArgs) and sends 1, 2 and 3 requests at the same moment, first with one
// slot (they queue, as TOMLIN's line does at At once 1) and then with as many slots as requests. Prints, for each stream,
// the wait for its first word and how fast it wrote, and the time until all were done. Nothing in TOMLIN is changed;
// unload the model in TOMLIN first, so both do not hold it in memory at once.
//   node tools/slotspeed.ts --model "D:\models\Qwen3.6-35B-A3B-Q4_K_M.gguf" [--runner runtime\llama-cuda\llama-server.exe]
//        [--device cuda|vulkan|cpu] [--ctx 8192] [--max 256] [--streams 1,2,3] [--threads 8]
//   (an installed copy: "<install folder>\tomlin-<version>\runtime\node\node.exe" tools\slotspeed.ts ...)
// Suggested on the Z820: Qwen3.6-35B-A3B Q4, then Q2, with --device cuda. Results also go to slotspeed-<time>.jsonl.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { chatArgs } from '../src/llama.ts';
import { WRITE_PROMPT } from '../src/finderrun.ts';
import { parallelSupport } from '../src/slots.ts';

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const model = opt('model', '');
if (!model || !existsSync(model)) {
  console.error('Name the model file: node tools/slotspeed.ts --model "D:\\models\\some-model.gguf" (unload it in TOMLIN first).');
  process.exit(1);
}
/** The first llama-server found under runtime\ (a CUDA one first), unless one is named. */
function findRunner(): string {
  const root = join(process.cwd(), 'runtime');
  const dirs = existsSync(root) ? readdirSync(root).filter(d => d.startsWith('llama-')).sort((a, b) => Number(b.includes('cuda')) - Number(a.includes('cuda'))) : [];
  for (const d of dirs) if (existsSync(join(root, d, 'llama-server.exe'))) return join(root, d, 'llama-server.exe');
  return '';
}
const runner = opt('runner', findRunner());
if (!runner || !existsSync(runner)) {
  console.error('No llama-server.exe found under runtime\\. Name one: --runner runtime\\llama-cuda\\llama-server.exe');
  process.exit(1);
}
const device = (opt('device', runner.includes('cuda') ? 'cuda' : runner.includes('vulkan') ? 'vulkan' : 'cpu')) as 'cuda' | 'vulkan' | 'cpu';
const ctx = Math.max(1024, Number(opt('ctx', '8192')));
const maxTokens = Math.max(16, Number(opt('max', '256')));
const streams = opt('streams', '1,2,3').split(',').map(Number).filter(n => n >= 1 && n <= 8);
const threads = Math.max(1, Number(opt('threads', String(Math.max(1, Math.floor(cpus().length / 2))))));
const out = join(process.cwd(), `slotspeed-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);

const freePort = () => new Promise<number>(ok => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const port = (s.address() as { port: number }).port;
    s.close(() => ok(port));
  });
});
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Starts llama-server with `slots` slots; resolves once it answers /health, with its address and a way to stop it. */
async function startServer(slots: number): Promise<{ base: string; stop: () => Promise<void> }> {
  const help = await new Promise<string>(ok => {
    const p = spawn(runner, ['--help'], { windowsHide: true });
    let t = '';
    p.stdout.on('data', d => (t += d));
    p.stderr.on('data', d => (t += d));
    p.on('close', () => ok(t));
    p.on('error', () => ok(''));
  });
  const support = parallelSupport(help);
  if (slots > 1 && !support.parallel) throw new Error(`${runner} does not take --parallel: it cannot run ${slots} at once.`);
  const port = await freePort();
  const args = chatArgs(model, port, device, threads, false, { ctx, cache: 'f16', place: 'auto', slots, slotSplit: support.split }, device !== 'cpu');
  // One slot is a true queue (-np 1): the runner's own default may make several, and TOMLIN's line sends one at a time at At once 1.
  if (slots === 1 && support.parallel) args.push('-np', '1');
  const proc = spawn(runner, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let tail = '';
  proc.stderr.on('data', d => (tail = (tail + d).slice(-4000)));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 1200; i++) {
    if (proc.exitCode !== null) throw new Error(`llama-server stopped while loading (code ${proc.exitCode}). Its last words:\n${tail}`);
    if (await fetch(`${base}/health`).then(r => r.ok, () => false)) break;
    await sleep(500);
  }
  return {
    base,
    stop: () => new Promise<void>(ok => {
      if (proc.exitCode !== null) return ok();
      proc.once('exit', () => ok());
      proc.kill();
    }),
  };
}

interface Stream { firstWordMs: number; tokens: number; perSecond: number; totalMs: number }

/** One request, streamed: when its first word came, how many tokens it wrote, and how fast (first word to last). */
async function one(base: string, n: number): Promise<Stream> {
  const t0 = Date.now();
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: `Run ${n}. ${WRITE_PROMPT}` }], max_tokens: maxTokens, temperature: 0, stream: true, cache_prompt: false }),
  });
  if (!res.ok || !res.body) throw new Error(`llama-server answered ${res.status}`);
  let first = 0;
  let last = 0;
  let pieces = 0;
  let tokens = 0;
  let buf = '';
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
      const j = JSON.parse(line.slice(5)) as { choices?: { delta?: { content?: string; reasoning_content?: string } }[]; timings?: { predicted_n?: number } };
      const words = j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.delta?.reasoning_content ?? '';
      if (words) {
        if (!first) first = Date.now();
        last = Date.now();
        pieces++;
      }
      if (j.timings?.predicted_n) tokens = j.timings.predicted_n;
    }
  }
  const written = tokens || pieces;
  return { firstWordMs: first ? first - t0 : -1, tokens: written, perSecond: last > first ? Math.round((written / ((last - first) / 1000)) * 10) / 10 : 0, totalMs: Date.now() - t0 };
}

console.log(`slotspeed: ${model}\n  runner ${runner} (${device}), context ${ctx} per stream, ${maxTokens} tokens each, ${threads} threads.\n  Not a TOMLIN measurement until it has run on this PC: these are this run's figures only.\n`);
for (const k of streams) {
  for (const slots of k === 1 ? [1] : [1, k]) {
    const label = `${k} at once on ${slots} slot${slots > 1 ? 's' : ''}${slots === 1 && k > 1 ? ' (queued)' : ''}`;
    let server: Awaited<ReturnType<typeof startServer>> | null = null;
    try {
      server = await startServer(slots);
      await one(server.base, 0); // a first answer warms the runner, not counted
      const t0 = Date.now();
      const got = await Promise.all(Array.from({ length: k }, (_, i) => one(server!.base, i + 1)));
      const allMs = Date.now() - t0;
      console.log(`${label}: all done in ${(allMs / 1000).toFixed(1)} s`);
      got.forEach((s, i) => console.log(`  stream ${i + 1}: first word after ${(s.firstWordMs / 1000).toFixed(2)} s, ${s.tokens} tokens at ${s.perSecond} tok/s`));
      appendFileSync(out, `${JSON.stringify({ at: new Date().toISOString(), model, runner, device, ctx, maxTokens, streams: k, slots, allMs, got })}\n`);
    } catch (e) {
      console.log(`${label}: failed: ${(e as Error).message}`);
    } finally {
      await server?.stop();
    }
  }
}
console.log(`\nSaved in ${out}. Compare "N at once on N slots" with "N at once on 1 slot (queued)": the slots pay only when all are done sooner and each stream's first word comes early enough.`);
