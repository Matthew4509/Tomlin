// A runner sent from one PC to a linked PC (src/runnerpush.ts): the node takes only the build its own runtimes.json
// pins, checks every zip's SHA-256 before unpacking it into its home's runtime folder, and refuses a PC with no NVIDIA
// card. Driven through the node's doors in this process (as test/carry.test.ts does for models).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NodeAnswer, Wire } from '../src/carry.ts';
import { PIN_FILE, Runtimes } from '../src/runtimes.ts';
import * as rp from '../src/runnerpush.ts';
import { runnerEnv } from '../src/worker.ts';
import { makeRunnerZips, type RunnerZips } from './runnerzips.ts';

const made: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'tomlin-runnerpush-'));
  made.push(dir);
  return dir;
};
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const laptop = { key: 'b1b2b3b4', name: 'Laptop' };

/** A node with its own runtimes.json (the same pins as the zips, unless `pins` says otherwise). */
function aNode(zips: RunnerZips, o: { why?: (id: string) => string; free?: number; inUse?: () => boolean; pins?: object } = {}) {
  const root = tmp();
  const pins = join(root, 'runtimes.json');
  writeFileSync(pins, JSON.stringify(o.pins ?? zips.pinsFile('https://example.invalid/b1')));
  const home = join(root, 'home-runtime');
  const runtimes = new Runtimes(join(root, 'app-runtime'), pins, home);
  let changed = 0;
  const side = rp.runnerSide({ runtimes, pcName: () => 'Worker PC', why: o.why ?? (() => ''), freeBytes: async () => o.free ?? Infinity, inUse: o.inUse, onChange: () => void changed++ });
  const wireAs = (who: { key: string; name: string }, hooks: { beforePut?: (n: number) => void } = {}): Wire => {
    let puts = 0;
    const json = (a: NodeAnswer) => {
      if (!('json' in a)) throw new Error('a piece came where words were expected');
      if (a.status !== 200 && !(a.status === 409 && typeof a.json.at === 'number')) throw new Error(String(a.json.error));
      return a.json;
    };
    return {
      ask: async (p, b) => json(await side.handle(p, b, who)),
      getPiece: async () => {
        throw new Error('nothing is read back from a node for a runner');
      },
      putPiece: async (p, b, piece) => {
        hooks.beforePut?.(++puts);
        return json(await side.handle(p, b, who, piece));
      },
    };
  };
  return { root, home, runtimes, side, wireAs, changes: () => changed };
}

const filesOf = (z: RunnerZips) => z.parts.map(p => ({ path: p.path, bytes: p.data.length, sha256: p.sha256 }));
const send = (node: ReturnType<typeof aNode>, z: RunnerZips, o: { files?: ReturnType<typeof filesOf>; signal?: AbortSignal; wire?: Wire; id?: string } = {}) =>
  rp.pushRunner(o.wire ?? node.wireAs(laptop), { id: o.id ?? 'llama-cuda', files: o.files ?? filesOf(z), progress: () => undefined, signal: o.signal ?? new AbortController().signal, every: 20 });

test('a runner sent to a node is checked, unpacked in its home runtime folder and used from then on; sent again, nothing crosses', async () => {
  const z = makeRunnerZips(tmp());
  const node = aNode(z);
  assert.equal(node.side.state('llama-cuda').state, 'none');
  assert.equal(await send(node, z), 'sent');
  assert.equal(node.runtimes.exe('llama', 'cuda'), join(node.home, 'llama-cuda', 'llama-server.exe'));
  assert.ok(existsSync(join(node.home, 'llama-cuda', 'cudart64_12.dll')));
  assert.ok(existsSync(join(node.home, 'llama-cuda', PIN_FILE)));
  assert.equal(node.side.state('llama-cuda').state, 'installed');
  assert.match(node.side.state('llama-cuda').said, /ready on "Worker PC"/);
  // The zips do not stay on the node once unpacked.
  assert.deepEqual(readdirSync(join(node.home, '_downloads')), []);
  assert.ok(node.changes() >= 1);
  let puts = 0;
  assert.equal(await send(node, z, { wire: node.wireAs(laptop, { beforePut: () => void puts++ }) }), 'had');
  assert.equal(puts, 0);
});

test('a big zip crosses in pieces; a send that is stopped leaves no half file and no runner', async () => {
  const z = makeRunnerZips(tmp(), 20 * 2 ** 20);
  const node = aNode(z);
  const stop = new AbortController();
  const w = node.wireAs(laptop, { beforePut: n => { if (n === 2) stop.abort(); } });
  await assert.rejects(send(node, z, { wire: w, signal: stop.signal }), /Stopped/);
  const left = existsSync(join(node.home, '_downloads')) ? readdirSync(join(node.home, '_downloads')).filter(n => n.endsWith('.part')) : [];
  assert.deepEqual(left, []);
  assert.equal(node.runtimes.installed('llama', 'cuda'), false);
  // Sent again from the start, it arrives whole.
  assert.equal(await send(node, z), 'sent');
  assert.ok(node.runtimes.installed('llama', 'cuda'));
});

test('refused: a PC with no NVIDIA card, a runner it does not pin, another build, a CPU runner, no room', async () => {
  const z = makeRunnerZips(tmp());
  await assert.rejects(send(aNode(z, { why: () => '"Worker PC" has no NVIDIA card of its own, so the CUDA runner cannot help there.' }), z), /no NVIDIA card of its own/);
  await assert.rejects(send(aNode(z), z, { id: 'llama-rocm' }), /does not know the runner llama-rocm: update TOMLIN there first/);
  await assert.rejects(send(aNode(z), z, { id: 'llama-cpu' }), /Only the NVIDIA \(CUDA\) runners/);
  const other = filesOf(z).map((f, k) => (k === 1 ? { ...f, sha256: 'f'.repeat(64) } : f));
  await assert.rejects(send(aNode(z), z, { files: other }), /another build of that runner.*update TOMLIN on both PCs/);
  await assert.rejects(send(aNode(z, { free: 1024 }), z), /not enough room on "Worker PC"/);
  // A file the node does not name (out of range) is refused before anything is written.
  const node = aNode(z);
  const a = await node.side.handle('/worker/runner-put', { id: 'llama-cuda', parts: filesOf(z).map(({ bytes, sha256 }) => ({ bytes, sha256 })), file: 5, from: 0 }, laptop, Buffer.from('x'));
  assert.equal(a.status, 400);
});

test('a zip changed on the way (its bytes, not its pin) is thrown away on the node and nothing is unpacked', async () => {
  const z = makeRunnerZips(tmp());
  const node = aNode(z);
  const bad = join(tmp(), 'changed.zip');
  const data = Buffer.from(z.parts[1].data);
  data[100] ^= 0xff;
  writeFileSync(bad, data);
  const files = filesOf(z).map((f, k) => (k === 1 ? { ...f, path: bad } : f));
  await assert.rejects(send(node, z, { files }), /changed on the way.*SHA-256/);
  assert.equal(node.side.state('llama-cuda').state, 'failed');
  assert.equal(node.runtimes.installed('llama', 'cuda'), false);
  assert.ok(!existsSync(join(node.home, 'llama-cuda', 'llama-server.exe')));
  assert.ok(!readdirSync(join(node.home, '_downloads')).includes(z.parts[1].name), 'the changed zip is not kept');
  // Sent again, right this time, it is used.
  assert.equal(await send(node, z), 'sent');
  assert.ok(node.runtimes.installed('llama', 'cuda'));
});

test('Remove on a node takes its runner away, unless a model runs on it now', async () => {
  const z = makeRunnerZips(tmp());
  let running = true;
  const node = aNode(z, { inUse: () => running });
  await send(node, z);
  const busy = await node.side.handle('/worker/runner-remove', { id: 'llama-cuda' }, laptop);
  assert.equal(busy.status, 409);
  assert.match(String('json' in busy && busy.json.error), /a model runs on it on "Worker PC" now/);
  assert.ok(node.runtimes.installed('llama', 'cuda'));
  running = false;
  const gone = await node.side.handle('/worker/runner-remove', { id: 'llama-cuda' }, laptop);
  assert.equal(gone.status, 200, JSON.stringify('json' in gone && gone.json));
  assert.equal(node.runtimes.installed('llama', 'cuda'), false);
  assert.equal(node.side.state('llama-cuda').state, 'none');
});

test('what a node says about its runners in its hello, read back as the host keeps it', () => {
  assert.deepEqual(rp.cleanRunner(undefined), null);
  const h = rp.cleanRunner({ nvidia: true, driver: '581.57', why: '', cuda: 'installed', said: 'x'.repeat(500), last: { device: 'cuda', seconds: 41.2, lines: ['ggml_cuda_init: found 1 CUDA devices', 7, 'llama_context: graph splits = 2'] } });
  assert.equal(h!.nvidia, true);
  assert.equal(h!.driver, '581.57');
  assert.equal(h!.cuda, 'installed');
  assert.ok(h!.said.length <= 300);
  assert.deepEqual(h!.last, { device: 'cuda', seconds: 41.2, lines: ['ggml_cuda_init: found 1 CUDA devices', 'llama_context: graph splits = 2'] });
  assert.equal(rp.cleanRunner({ nvidia: 'yes', cuda: 'odd' })!.cuda, 'none');
});

test('why a runner cannot be sent to a linked PC now, in plain words', () => {
  const pc = (o: Partial<rp.RunnerPc> = {}): rp.RunnerPc => ({ name: 'Worker PC', ok: true, away: null, can: ['carry', 'runner'], backupsOnly: false, runner: { nvidia: true, driver: '581.57', why: '', cuda: 'none', said: '', last: null }, ...o });
  assert.equal(rp.sendRunnerWhy(pc()), '');
  assert.match(rp.sendRunnerWhy(pc({ ok: false })), /off or not answering/);
  assert.match(rp.sendRunnerWhy(pc({ away: '2026-10-21T10:00:00Z' })), /being used by its owner/);
  assert.match(rp.sendRunnerWhy(pc({ can: ['carry'], runner: null })), /older TOMLIN that cannot take a runner: update it first/);
  assert.match(rp.sendRunnerWhy(pc({ backupsOnly: true })), /Backups only/);
  assert.match(rp.sendRunnerWhy(pc({ runner: { nvidia: false, driver: null, why: '"Worker PC" has no NVIDIA card of its own, so the CUDA runner cannot help there.', cuda: 'none', said: '', last: null } })), /no NVIDIA card/);
  assert.match(rp.sendRunnerWhy(pc({ runner: { nvidia: true, driver: '581.57', why: '', cuda: 'installed', said: '', last: null } })), /already has it/);
});

test('the start lines kept from a runner: which device it found and how the model was split, nothing else', () => {
  const lines = [
    'build: 11284 (abc) with MSVC',
    'ggml_cuda_init: found 1 CUDA devices:',
    '  Device 0: NVIDIA GeForce GTX 1060 6GB, compute capability 6.1, VMM: yes',
    'load_tensors: offloaded 37/37 layers to GPU',
    'srv  log_server_r: request: GET /health 127.0.0.1 200',
    'llama_context: graph splits = 2',
    'ggml_vulkan: Found 1 Vulkan devices:',
  ];
  assert.deepEqual(lines.filter(rp.startFact), [lines[1], lines[2], lines[3], lines[5], lines[6]]);
});

test('a CUDA runner starts with room for the card\'s compiled code kept (it compiles once, not at every start)', () => {
  assert.equal(runnerEnv('cuda', { PATH: 'x' })!.CUDA_CACHE_MAXSIZE, String(4 * 2 ** 30));
  assert.equal(runnerEnv('cuda', { PATH: 'x' })!.PATH, 'x');
  // A size the PC's owner set is kept.
  assert.equal(runnerEnv('cuda', { CUDA_CACHE_MAXSIZE: '1000' })!.CUDA_CACHE_MAXSIZE, '1000');
  assert.equal(runnerEnv('vulkan', { PATH: 'x' }), undefined);
  assert.equal(runnerEnv('cpu', { PATH: 'x' }), undefined);
});
