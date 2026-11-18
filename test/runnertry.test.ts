// The guided runner flow (bug 13): after a crash or a failed Test now the notice suggests the next runner from that PC's
// own pinned list (src/faults.ts orderTries, nextTry), skipping runners that failed with this model there and putting
// those that worked there with other models first; when the list is used up it says so. Installing a runner on a linked
// PC goes through the node's own pin check (src/runnerpush.ts), which refuses anything it does not pin or whose SHA-256
// does not match. Nothing here starts TOMLIN or a runner.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanFault, makeFault, nextTry, orderTries, RunHistory, tryOptions, type TryOption } from '../src/faults.ts';
import type { NodeAnswer, Wire } from '../src/carry.ts';
import { Runtimes } from '../src/runtimes.ts';
import * as rp from '../src/runnerpush.ts';
import { makeRunnerZips } from './runnerzips.ts';

const ROOT = join(import.meta.dirname, '..');
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');
const made: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'tomlin-runnertry-'));
  made.push(dir);
  return dir;
};
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const pin = (p: string, device: TryOption['device'], o: Partial<TryOption> = {}) => ({ pin: p, name: p, device, build: 'b1', installed: true, bytes: 0, why: '', ...o });
/** A made-up NVIDIA PC's chat runners: three CUDA builds (one with no code for its card, one not installed), Vulkan, the CPU. */
const PINS = [pin('llama-cpu', 'cpu'), pin('llama-vulkan', 'vulkan'), pin('llama-cuda', 'cuda'), pin('llama-cuda13', 'cuda', { why: 'no code for this card' }), pin('llama-cuda2', 'cuda', { installed: false, bytes: 600 }), pin('llama-cuda3', 'cuda')];
const failedOn = { runner: 'llama-cuda', device: 'cuda' as const };
const order = (shaky: string[] = [], worked: string[] = []) => orderTries(tryOptions(failedOn, PINS, new Set(shaky)), { shaky: new Set(shaky), worked: new Set(worked) });

test('the order: another version first, then the other type, then the CPU; the one that failed is not offered; one that cannot run here is last', () => {
  assert.deepEqual(order().map(t => t.pin), ['llama-cuda3', 'llama-cuda2', 'llama-vulkan', 'llama-cpu', 'llama-cuda13']);
  assert.equal(nextTry(order())?.pin, 'llama-cuda3');
});

test('runners that worked on that PC with other models are suggested first, and marked', () => {
  const t = order([], ['llama-vulkan']);
  assert.deepEqual(t.map(x => x.pin).slice(0, 3), ['llama-vulkan', 'llama-cuda3', 'llama-cuda2']);
  assert.equal(t[0].worked, true);
  assert.equal(t[1].worked, undefined);
  assert.equal(nextTry(t)?.pin, 'llama-vulkan');
  // Worked there, but failed with this model since: not "worked", and skipped.
  const both = order(['llama-vulkan'], ['llama-vulkan']);
  assert.equal(both.find(x => x.pin === 'llama-vulkan')!.worked, undefined);
  assert.equal(nextTry(both)?.pin, 'llama-cuda3');
});

test('the skip rules: failed with this model there, failed in this round, cannot run there; the CPU comes after every card runner', () => {
  const t = order(['llama-cuda3']);
  // Still listed (the person sees why), after the CPU and before the ones that cannot run there.
  assert.deepEqual(t.map(x => x.pin), ['llama-cuda2', 'llama-vulkan', 'llama-cpu', 'llama-cuda3', 'llama-cuda13']);
  assert.equal(t.find(x => x.pin === 'llama-cuda3')!.failedHere, true);
  assert.equal(nextTry(t)?.pin, 'llama-cuda2');
  assert.equal(nextTry(t, new Set(['llama-cuda2']))?.pin, 'llama-vulkan');
  assert.equal(nextTry(t, new Set(['llama-cuda2', 'llama-vulkan']))?.pin, 'llama-cpu');
  // Never the one with a reason, never the failed one.
  assert.ok(!['llama-cuda13', 'llama-cuda3'].includes(nextTry(t, new Set(['llama-cuda2']))!.pin));
});

test('a whole round: each fail suggests the next, and when the list is used up there is nothing (the notice says so)', () => {
  const t = order(['llama-cuda3'], ['llama-vulkan']);
  const tried = new Set<string>();
  const seen: string[] = [];
  for (let n = nextTry(t, tried); n; n = nextTry(t, tried)) {
    seen.push(n.pin);
    tried.add(n.pin);
    assert.ok(seen.length < 10, 'it never goes round in a circle');
  }
  assert.deepEqual(seen, ['llama-vulkan', 'llama-cuda2', 'llama-cpu']);
  assert.equal(nextTry(t, tried), null);
  // Nothing that can run there at all: the list is used up from the start.
  assert.equal(nextTry(orderTries(tryOptions(failedOn, [pin('llama-cuda', 'cuda'), pin('llama-cuda13', 'cuda', { why: 'no code for this card' })]), { shaky: new Set(), worked: new Set() })), null);
  assert.equal(nextTry([]), null);
});

test('a list from an older PC (no marks) still works: only its reasons and this round count', () => {
  const old: TryOption[] = [{ ...pin('llama-cuda3', 'cuda'), kind: 'version' }, { ...pin('llama-vulkan', 'vulkan', { why: 'no Vulkan driver' }), kind: 'type' }];
  assert.equal(nextTry(old)?.pin, 'llama-cuda3');
  assert.equal(nextTry(old, new Set(['llama-cuda3'])), null);
});

test('the run history: what worked on a PC lately, with any model, and nothing that failed since', async () => {
  const dir = tmp();
  const h = new RunHistory(join(dir, 'run-history.json'));
  h.wait = 1;
  h.success('Desk PC', 'other.gguf', 'llama-vulkan', 30, '2026-11-01T10:00:00Z');
  h.success('Desk PC', 'other.gguf', 'llama-cuda3', 40, '2026-11-01T10:00:00Z');
  await h.failure(makeFault({ pc: 'Desk PC', model: 'other.gguf', modelName: 'Other', runner: 'llama-cuda3', runnerName: 'b12250', device: 'cuda', kind: 'crash', tail: 'CUDA error', at: '2026-11-02T10:00:00Z' }));
  h.success('Back Room PC', 'other.gguf', 'llama-cuda2', 40, '2026-11-01T10:00:00Z');
  assert.deepEqual([...h.workedOn('Desk PC')].sort(), ['llama-vulkan']);
  // Worked again after the fault: it counts again.
  h.success('Desk PC', 'other.gguf', 'llama-cuda3', 40, '2026-11-03T10:00:00Z');
  assert.deepEqual([...h.workedOn('Desk PC')].sort(), ['llama-cuda3', 'llama-vulkan']);
  // A test that failed for this model is skipped next time (shaky), whatever it did with other models.
  await h.failure(makeFault({ pc: 'Desk PC', model: 'this.gguf', modelName: 'This', runner: 'llama-vulkan', runnerName: 'Vulkan', device: 'vulkan', kind: 'load', tail: 'failed to load', at: '2026-11-04T10:00:00Z' }));
  const t = orderTries(tryOptions(failedOn, PINS, h.shaky('Desk PC', 'this.gguf')), { shaky: h.shaky('Desk PC', 'this.gguf'), worked: h.workedOn('Desk PC') });
  assert.equal(nextTry(t)?.pin, 'llama-cuda3');
  assert.equal(t.find(x => x.pin === 'llama-vulkan')!.failedHere, true);
  await h.save();
});

test('the marks cross the link checked: only true is kept', () => {
  const f = makeFault({ pc: 'Desk PC', model: 'q', modelName: 'Q', runner: 'llama-cuda', runnerName: 'b11284', device: 'cuda', kind: 'crash', tail: 'CUDA error' });
  const tries = [{ ...pin('llama-cuda3', 'cuda'), kind: 'version', worked: true }, { ...pin('llama-vulkan', 'vulkan'), kind: 'type', failedHere: 'yes', worked: 1 }];
  const c = cleanFault({ ...f, tries })!;
  assert.equal(c.tries![0].worked, true);
  assert.equal(c.tries![1].failedHere, undefined);
  assert.equal(c.tries![1].worked, undefined);
});

// ---- The install step on a linked PC: the node checks the id and every SHA-256 against its own pins ----

function aNode() {
  const root = tmp();
  const z = makeRunnerZips(root);
  const pins = join(root, 'runtimes.json');
  writeFileSync(pins, JSON.stringify(z.pinsFile('https://example.invalid/b1')));
  const home = join(root, 'home-runtime');
  const runtimes = new Runtimes(join(root, 'app-runtime'), pins, home);
  const side = rp.runnerSide({ runtimes, pcName: () => 'Desk PC', why: () => '', freeBytes: async () => Infinity });
  const who = { key: 'c1c2c3c4', name: 'Front Room PC' };
  const json = (a: NodeAnswer) => {
    if (!('json' in a)) throw new Error('a piece came where words were expected');
    if (a.status !== 200 && !(a.status === 409 && typeof a.json.at === 'number')) throw new Error(String(a.json.error));
    return a.json;
  };
  const wire: Wire = {
    ask: async (p, b) => json(await side.handle(p, b, who)),
    getPiece: async () => {
      throw new Error('nothing is read back');
    },
    putPiece: async (p, b, piece) => json(await side.handle(p, b, who, piece)),
  };
  const files = z.parts.map(p => ({ path: p.path, bytes: p.data.length, sha256: p.sha256 }));
  const push = (id: string, f = files) => rp.pushRunner(wire, { id, files: f, progress: () => undefined, signal: new AbortController().signal, every: 20 });
  return { z, home, runtimes, side, files, push };
}

test('the node refuses a runner it does not pin, even one named like a CUDA build, and unpacks nothing', async () => {
  const n = aNode();
  await assert.rejects(n.push('llama-cuda9'), /does not know the runner llama-cuda9: update TOMLIN there first/);
  await assert.rejects(n.push('llama-trial-b99999'), /does not know the runner/);
  await assert.rejects(n.push('llama-cpu'), /Only the NVIDIA \(CUDA\) runners/);
  assert.equal(n.runtimes.installed('llama', 'cuda'), false);
  assert.ok(!existsSync(join(n.home, 'llama-cuda9')));
});

test('the node refuses another checksum than its own pin, and throws away a file whose bytes changed on the way', async () => {
  const n = aNode();
  // The host names another SHA-256 (another build, or a forged list): refused before a byte is written.
  await assert.rejects(n.push('llama-cuda', n.files.map((f, k) => (k === 0 ? { ...f, sha256: 'a'.repeat(64) } : f))), /pins another build/);
  // The same pin named, but the bytes sent are not that build: checked on the node, thrown away, nothing unpacked.
  const bad = join(tmp(), 'changed.zip');
  const data = Buffer.from(n.z.parts[0].data);
  data[64] ^= 0xff;
  writeFileSync(bad, data);
  await assert.rejects(n.push('llama-cuda', n.files.map((f, k) => (k === 0 ? { ...f, path: bad } : f))), /changed on the way.*SHA-256/);
  assert.equal(n.runtimes.installed('llama', 'cuda'), false);
  // The right files, checked there: installed.
  assert.equal(await n.push('llama-cuda'), 'sent');
  assert.ok(n.runtimes.installed('llama', 'cuda'));
});

// ---- The pages and doors ----

test('the notice: one button tries the next runner, every step asks first, a fail moves on, the end says so and offers Report a problem', () => {
  const js = read('public/crash.js');
  // The same rule as src/faults.ts nextTry.
  assert.match(js, /const crashNext = \(tries, tried = new Set\(\)\) => tries\.find\(t => !t\.why && !t\.failedHere && !tried\.has\(t\.pin\)\) \?\? null;/);
  assert.match(js, /pick\.value = \(crashNext\(tries\) \?\? usable\[0\]\)\.pin/);
  assert.match(js, /if \(!confirm\(`\$\{t\.name\} is not installed \$\{where\}\. Install it now/);
  assert.match(js, /if \(!confirm\(`Test \$\{model\} on \$\{t\.name\}, \$\{where\}\?/);
  assert.match(js, /if \(!confirm\(`Use \$\{t\.name\} for \$\{model\} \$\{where\} from now on\?/);
  assert.match(js, /A model loaded there is let go for the test/);
  assert.match(js, /Keep it for this model/);
  assert.match(js, /No runner is left to try for \$\{model\} \$\{where\}/);
  assert.match(js, /report\.className = 'btn primary'/);
  assert.match(js, /app\.openReport\(crashReport\(f\)/);
  assert.match(js, /f\.triedSaid \?\? ''/);
  // A linked PC: only a CUDA runner is sent (that PC checks it against its own pin); any other it downloads itself.
  assert.match(js, /api\('\/api\/network\/runner', \{ pc: f\.pcId, id: t\.pin \}\)/);
  assert.match(js, /if \(away && t\.device !== 'cuda'\)/);
  assert.match(js, /only if its own TOMLIN pins this exact build/);
});

test('the gear: a failed Test now shows the guided notice; the server keeps the fail before it says failed', () => {
  const app = read('public/app.js');
  assert.match(app, /s\?\.state === 'failed' && app\.crashNotice/);
  assert.match(app, /\/api\/runner-next\?model=/);
  const srv = read('src/server/faults.ts');
  assert.match(srv, /faultsGet\['\/api\/runner-next'\]/);
  assert.match(srv, /orderTries\(tryOptions\(/);
  assert.match(srv, /await history\.failure\(makeFault\(\{[^\n]+kind: 'load'[^\n]+\n\s+me\.state = 'failed';/);
});
