// The real card on this PC, through a whole copy of TOMLIN (test/pcs.ts) with a real small model: Auto, a model held
// to each card runner (CUDA 12, CUDA 13, Vulkan), the CPU, and the speed finder. Which program really ran is read from
// Windows (the runner's own path), not from what TOMLIN says. Skipped unless this PC has an NVIDIA card, the card
// runners (npm run fetch -- llama-vulkan llama-cuda llama-cuda13) and the 0.8B model in the folder models-folder.txt
// names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPc, until, type Pc } from './pcs.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const Q08 = 'Qwen3.5-0.8B-Q4_K_M.gguf';

function realModel(): string | null {
  try {
    const p = join(readFileSync(join(ROOT, 'models-folder.txt'), 'utf8').trim(), Q08);
    return existsSync(p) ? p : null;
  } catch {
    return null;
  }
}
function nvidiaCard(): { name: string; cc: number } | null {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'nvidia-smi.exe'), ['--query-gpu=name,compute_cap', '--format=csv,noheader'], { encoding: 'utf8' });
    const [name, cc] = out.trim().split('\n')[0].split(',').map(s => s.trim());
    return { name, cc: Math.round(Number(cc) * 10) };
  } catch {
    return null;
  }
}
const runnerThere = (id: string) => existsSync(join(ROOT, 'runtime', id, 'llama-server.exe'));

const model = realModel();
const card = nvidiaCard();
const ready = model && card && ['llama-vulkan', 'llama-cuda', 'llama-cuda13'].every(runnerThere);

/** The program a process runs, as Windows has it. */
const pathOf = (pid: number) => execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).Path`], { encoding: 'utf8' }).trim();

test('the real card: Auto, each runner held, the CPU and the speed finder all end on a runner that can run this card', { timeout: 900_000, skip: ready ? false : 'needs an NVIDIA card, the card runners and the 0.8B model' }, async () => {
  const top = mkdtempSync(join(tmpdir(), 'tomlin-real-'));
  let pc: Pc | null = null;
  const seen: Record<string, unknown> = { card };
  try {
    const home = join(top, 'home');
    mkdirSync(join(home, 'models', 'chat'), { recursive: true });
    linkSync(model!, join(home, 'models', 'chat', Q08));
    pc = await startPc({ root: ROOT, home });
    const p = pc;
    // '' takes a saved runner away (the model is on Auto's again); a missing one would keep the saved one.
    const setRunner = (runner: string | null) => p.post('/api/settings', { pane: 'chat', runModel: Q08, run: { runner: runner ?? '' } });
    const load = async (device: 'auto' | 'gpu' | 'cpu') => {
      const r = await p.post(`/api/models/${encodeURIComponent(Q08)}/load`, { device });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      return until(`the model to load (${device})`, async () => {
        const c = (await p.get('/api/status')).body.panes.chat;
        return c.state === 'connected' || c.state === 'failed' ? c : null;
      }, 240_000, 500);
    };
    const unload = async () => {
      await p.post(`/api/models/${encodeURIComponent(Q08)}/unload`, {});
      await until('the model to unload', async () => ((await p.get('/api/status')).body.panes.chat.state === 'disconnected' ? true : null), 60_000, 300);
    };
    const ask = async () => {
      const t0 = Date.now();
      const r = await fetch(`${p.base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Say the word "orange" and nothing else.' }], max_tokens: 40, temperature: 0, chat_template_kwargs: { enable_thinking: false } }) });
      assert.equal(r.status, 200);
      const j = (await r.json()) as { choices: { message: { content: string } }[]; timings?: { predicted_per_second?: number; prompt_per_second?: number } };
      assert.match(j.choices[0].message.content, /orange/i);
      return { ms: Date.now() - t0, write: j.timings?.predicted_per_second ?? null, read: j.timings?.prompt_per_second ?? null };
    };
    const ran = (c: { pid: number | null }) => {
      const path = pathOf(c.pid!);
      return /runtime[\\/](llama-[\w]+)[\\/]/i.exec(path)?.[1] ?? path;
    };

    // Auto: the CUDA build with code for this card (a Pascal card: 12.4; CUDA 13 has none for it).
    let c = await load('auto');
    assert.equal(c.state, 'connected', JSON.stringify(c));
    const autoPick = ran(c);
    seen.auto = { device: c.device, runner: autoPick, note: c.note, ...(await ask()) };
    assert.equal(c.device, 'cuda');
    assert.equal(autoPick, card!.cc < 75 ? 'llama-cuda' : card!.cc >= 120 ? 'llama-cuda13' : 'llama-cuda');
    await unload();

    // Each runner the model can be held to.
    for (const [runner, device, expect] of [['vulkan', 'gpu', 'llama-vulkan'], ['cuda', 'gpu', 'llama-cuda'], ['cuda13', 'gpu', card!.cc < 75 ? 'llama-cuda' : 'llama-cuda13']] as const) {
      await setRunner(runner);
      c = await load(device);
      assert.equal(c.state, 'connected', `${runner}: ${JSON.stringify(c)}`);
      const got = ran(c);
      seen[runner] = { device: c.device, runner: got, note: c.note, ...(await ask()) };
      assert.equal(got, expect, `held to ${runner}`);
      // A runner that has no code for this card is not started at all (CUDA 13 on Pascal crashes): said, then Auto.
      if (expect !== RUNNER_PIN[runner]) assert.match(c.note ?? '', /set to the CUDA 13 runner, which is not installed here or has no code for this PC's cards: Auto picked the runner instead/);
      await unload();
    }
    await setRunner(null);

    // The CPU.
    c = await load('cpu');
    assert.equal(c.state, 'connected');
    assert.equal(ran(c), 'llama-cpu');
    seen.cpu = { device: c.device, ...(await ask()) };
    await unload();
    // Run on: back to Auto (a CPU load sets it to the CPU, and the finder plans for what it is set to).
    await p.post('/api/settings', { pane: 'chat', asked: 'auto' });

    // The speed finder (Quick): its runner rows are only runners that can run this card, and it ends with a pick.
    // Quick in the suite; FINDER_SIZE=full runs the whole test (an overnight run).
    const size = process.env.FINDER_SIZE === 'full' ? 'full' : 'quick';
    const pre = (await p.get(`/api/speed/find?model=${encodeURIComponent(Q08)}&size=${size}`)).body;
    seen.finderRows = pre.rows.map((r: { name: string }) => r.name);
    seen.finderLeft = pre.left.map((l: { name: string; why: string }) => `${l.name}: ${l.why}`);
    if (card!.cc < 75) assert.ok(!pre.rows.some((r: { name: string }) => /CUDA 13/.test(r.name)), 'no CUDA 13 row on a Pascal card');
    assert.ok(pre.rows.some((r: { name: string }) => /Vulkan runner/.test(r.name)), 'Vulkan is tried against CUDA');
    const st = await p.post('/api/speed/find/start', { model: Q08, size });
    assert.equal(st.status, 202, JSON.stringify(st.body));
    const done = await until('the speed test to end', async () => {
      const j = (await p.get('/api/speed/find/state')).body.job;
      // Done, put back as it was, and its pick made ("now" empties once it is).
      return j?.run && j.run.state !== 'running' && !j.run.now ? j.run : null;
    }, 600_000, 1000);
    seen.finder = { state: done.state, said: done.said, best: done.best, keep: done.keep, why: done.why, rows: (done.rows ?? []).map((r: Record<string, unknown>) => ({ id: r.id, name: r.name, state: r.state, write: r.write, read: r.read })) };
    assert.equal(done.state, 'done', JSON.stringify(seen.finder));
    // Every row loaded and answered: no runner tried on a card it cannot run.
    for (const r of done.rows ?? []) assert.equal(r.state, 'done', `row "${r.name}": ${JSON.stringify(r)}`);
    assert.ok((done.rows ?? []).some((r: { id: string; write: number | null }) => r.id === 'runner-vulkan' && r.write), 'Vulkan was measured against CUDA 12');
    assert.ok(done.best, `a pick was made: ${JSON.stringify(seen.finder)}`);
  } finally {
    console.log(`REAL CARD RESULTS ${JSON.stringify(seen, null, 1)}`);
    await pc?.stop().catch(() => undefined);
    rmSync(top, { recursive: true, force: true, maxRetries: 5 });
  }
});

const RUNNER_PIN: Record<string, string> = { vulkan: 'llama-vulkan', cuda: 'llama-cuda', cuda13: 'llama-cuda13' };
