// A transfer to a linked PC that stops answering in the middle of a request (it took the connection and went quiet):
// Stop ends it at once, its place in the line of four is given back, and nothing more is sent to that PC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import * as link from '../src/link.ts';
import { Transfers } from '../src/carry.ts';
import { wireFor } from '../src/jobrun/copies.ts';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** A made-up PC that takes every request and never answers it. */
async function silentPc(): Promise<{ url: string; server: Server; asked: () => number }> {
  let n = 0;
  const server = createServer(req => {
    n++;
    req.resume();
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server, asked: () => n };
}

test('Stop ends a transfer whose PC went quiet part way through a request, and its place is given back', { timeout: 60_000 }, async () => {
  const pc = await silentPc();
  try {
    const r = { id: 'quiet1', name: 'Quiet PC', url: pc.url, token: randomBytes(32).toString('hex'), key: link.keysText(randomBytes(64)) };
    const w = wireFor(r);
    const list = new Transfers();
    const t = list.start({ kind: 'send', what: 'Made-up model', pc: r.id, pcName: r.name }, async () => {
      await w.ask('/worker/carry-offer', { model: 'made-up.gguf' });
      return 'sent';
    });
    assert.ok(!('error' in t));
    for (let k = 0; k < 100 && pc.asked() < 1; k++) await sleep(50);
    assert.equal(pc.asked(), 1, 'the request reached that PC');
    const stoppedAt = Date.now();
    assert.equal(list.stop(t.id), true);
    let state = 'working';
    while (Date.now() - stoppedAt < 10_000) {
      state = list.view().find(x => x.id === t.id)!.state;
      if (state !== 'working') break;
      await sleep(50);
    }
    assert.equal(state, 'stopped', 'shown as stopped, not working until the 5-minute wait runs out');
    await sleep(3500);
    assert.equal(pc.asked(), 1, 'nothing was sent again after Stop');
    // Its place in the line of four is free: four more run at once.
    let ran = 0;
    for (let k = 0; k < Transfers.AT_ONCE; k++) {
      const u = list.start({ kind: 'send', what: `Model ${k}`, pc: `pc${k}`, pcName: `PC ${k}` }, async () => {
        ran++;
        return 'sent';
      });
      assert.ok(!('error' in u));
    }
    await sleep(100);
    assert.equal(ran, Transfers.AT_ONCE);
  } finally {
    pc.server.closeAllConnections();
    pc.server.close();
  }
});

test('Stop on a link that still answers sends the tidy-up, so nothing half-sent is left there', { timeout: 60_000 }, async () => {
  const { push } = await import('../src/carry.ts');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'sm-stop-tidy-'));
  const asked: string[] = [];
  // A made-up PC that answers plainly: it has nothing yet, and takes each piece a moment after it comes.
  const server = createServer((req, res) => {
    asked.push(req.url ?? '');
    req.resume();
    req.on('end', () => setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/worker/carry-offer' ? { at: [0] } : req.url === '/worker/carry-put' ? { at: 1024 } : { ok: true }));
    }, req.url === '/worker/carry-put' ? 600 : 0));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    const file = join(dir, 'made-up.gguf');
    writeFileSync(file, randomBytes(4096));
    const r = { id: 'tidy1', name: 'Tidy PC', url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: randomBytes(32).toString('hex'), key: link.keysText(randomBytes(64)) };
    const w = wireFor(r);
    const list = new Transfers();
    const t = list.start({ kind: 'send', what: 'Made-up model', pc: r.id, pcName: r.name }, async (progress, signal) => {
      await push(w, { kind: 'chat', model: 'made-up.gguf', name: 'Made-up', files: [{ name: 'made-up.gguf', path: file, bytes: 4096 }], progress, signal });
      return 'sent';
    });
    assert.ok(!('error' in t));
    for (let k = 0; k < 100 && !asked.includes('/worker/carry-put'); k++) await sleep(50);
    list.stop(t.id);
    for (let k = 0; k < 200 && list.view().find(x => x.id === t.id)!.state === 'working'; k++) await sleep(50);
    assert.equal(list.view().find(x => x.id === t.id)!.state, 'stopped');
    assert.ok(asked.includes('/worker/carry-drop'), `asked: ${asked.join(', ')}`);
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('thirty transfers at once: never more than four run, failures and stops give their place back, none is lost', { timeout: 60_000 }, async () => {
  const list = new Transfers();
  let running = 0;
  let most = 0;
  const forever: { id: string }[] = [];
  const ids: string[] = [];
  for (let k = 0; k < 30; k++) {
    const kind = k % 5;
    const t = list.start({ kind: 'send', what: `Model ${k}`, pc: `pc${k}`, pcName: `PC ${k}` }, async (_progress, signal) => {
      running++;
      most = Math.max(most, running);
      try {
        // 0: done after a moment; 1: fails; 2: never ends unless stopped; 3 and 4: done after a moment.
        if (kind === 1) {
          await sleep(20);
          throw new Error('that PC said no');
        }
        if (kind === 2) await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Stopped.')), { once: true }));
        await sleep(30);
        return 'sent';
      } finally {
        running--;
      }
    });
    assert.ok(!('error' in t));
    ids.push(t.id);
    if (kind === 2) forever.push(t);
  }
  // Some are stopped while they still wait their turn.
  for (const k of [27, 28, 29]) list.stop(ids[k]);
  await sleep(500);
  // The ones that never end hold places: stop them, and the line moves on.
  for (const t of forever) list.stop(t.id);
  for (let i = 0; i < 100 && list.view().some(x => x.state === 'working'); i++) await sleep(50);
  const states = list.view();
  assert.ok(most <= Transfers.AT_ONCE, `${most} ran at once`);
  assert.equal(states.filter(x => x.state === 'working').length, 0, 'none left working');
  // Every place is free again: four more start at once.
  let started = 0;
  for (let k = 0; k < Transfers.AT_ONCE; k++) list.start({ kind: 'send', what: `Late ${k}`, pc: `late${k}`, pcName: `Late ${k}` }, async () => { started++; return 'sent'; });
  await sleep(50);
  assert.equal(started, Transfers.AT_ONCE);
});
