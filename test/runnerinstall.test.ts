// A runner's zips kept for sending to linked PCs (src/runtimes.ts fetchZips, unpack, remove): downloaded from a
// stand-in web server here, checked by SHA-256, unpacked into the home's runtime folder, removed from there only.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PIN_FILE, Runtimes } from '../src/runtimes.ts';
import { makeRunnerZips } from './runnerzips.ts';

const made: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'tomlin-runnerinstall-'));
  made.push(dir);
  return dir;
};
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A web server that hands out `files` by name (404 for anything else); its base address. */
async function serve(files: Record<string, Buffer>): Promise<{ base: string; close: () => void }> {
  const s = createServer((req, res) => {
    const f = files[(req.url ?? '').split('/').pop() ?? ''];
    if (!f) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-length': String(f.length) }).end(f);
  });
  await new Promise<void>(r => s.listen(0, '127.0.0.1', () => r()));
  return { base: `http://127.0.0.1:${(s.address() as { port: number }).port}`, close: () => s.close() };
}

test('the zips are downloaded and kept for sending, checked; unpacked they make the runner; Remove takes the home copy only', async () => {
  const zips = makeRunnerZips(tmp());
  const web = await serve(Object.fromEntries(zips.parts.map(p => [p.name, p.data])));
  try {
    const root = tmp();
    const pins = join(root, 'runtimes.json');
    writeFileSync(pins, JSON.stringify(zips.pinsFile(web.base)));
    const app = join(root, 'app-runtime');
    const home = join(root, 'home-runtime');
    // The app folder's own copy of another runner stays whatever happens in the home.
    mkdirSync(join(app, 'llama-cpu'), { recursive: true });
    writeFileSync(join(app, 'llama-cpu', 'llama-server.exe'), 'cpu');
    const rt = new Runtimes(app, pins, home);
    assert.equal(rt.zipsHere('llama', 'cuda'), false);

    const files = await rt.fetchZips('llama', 'cuda');
    assert.deepEqual(files.map(f => f.split(/[\\/]/).pop()), zips.parts.map(p => p.name));
    for (const [k, f] of files.entries()) assert.ok(readFileSync(f).equals(zips.parts[k].data));
    assert.equal(rt.zipsHere('llama', 'cuda'), true);
    // Kept: not unpacked by fetching.
    assert.equal(rt.installed('llama', 'cuda'), false);

    await rt.unpack('llama', 'cuda', files);
    assert.equal(rt.exe('llama', 'cuda'), join(home, 'llama-cuda', 'llama-server.exe'));
    assert.ok(existsSync(join(home, 'llama-cuda', 'cudart64_12.dll')));
    assert.ok(existsSync(join(home, 'llama-cuda', PIN_FILE)));

    await rt.remove('llama', 'cuda');
    assert.equal(rt.installed('llama', 'cuda'), false);
    assert.ok(!existsSync(join(home, 'llama-cuda')));
    assert.equal(rt.zipsHere('llama', 'cuda'), false, 'its kept zips go too');
    assert.ok(existsSync(join(app, 'llama-cpu', 'llama-server.exe')));
  } finally {
    web.close();
  }
});

test('a zip that does not match its pin is not kept, and nothing is unpacked from it', async () => {
  const zips = makeRunnerZips(tmp());
  const bad = Buffer.from(zips.parts[1].data);
  bad[bad.length - 1] ^= 0xff;
  const web = await serve({ [zips.parts[0].name]: zips.parts[0].data, [zips.parts[1].name]: bad });
  try {
    const root = tmp();
    const pins = join(root, 'runtimes.json');
    writeFileSync(pins, JSON.stringify(zips.pinsFile(web.base)));
    const home = join(root, 'home-runtime');
    const rt = new Runtimes(join(root, 'app-runtime'), pins, home);
    await assert.rejects(rt.fetchZips('llama', 'cuda'), /SHA-256|did not match|check/i);
    assert.equal(rt.zipsHere('llama', 'cuda'), false);
    assert.ok(!existsSync(join(home, 'llama-cuda')));
    const left = existsSync(join(home, '_downloads')) ? readdirSync(join(home, '_downloads')) : [];
    assert.ok(!left.includes(zips.parts[1].name), `left: ${left.join(', ')}`);
  } finally {
    web.close();
  }
});

test('unpacking a runner again starts from an empty folder (nothing left from the build before)', async () => {
  const zips = makeRunnerZips(tmp());
  const root = tmp();
  const pins = join(root, 'runtimes.json');
  writeFileSync(pins, JSON.stringify(zips.pinsFile('https://example.invalid')));
  const home = join(root, 'home-runtime');
  const rt = new Runtimes(join(root, 'app-runtime'), pins, home);
  mkdirSync(join(home, 'llama-cuda'), { recursive: true });
  writeFileSync(join(home, 'llama-cuda', 'old-ggml-cuda.dll'), 'old');
  const files = zips.parts.map(p => {
    const f = join(home, '_downloads', p.name);
    mkdirSync(join(home, '_downloads'), { recursive: true });
    writeFileSync(f, p.data);
    return f;
  });
  await rt.unpack('llama', 'cuda', files);
  assert.ok(!existsSync(join(home, 'llama-cuda', 'old-ggml-cuda.dll')));
  assert.ok(rt.installed('llama', 'cuda'));
  for (const f of files) assert.ok(!existsSync(f), 'the zips go once unpacked');
});
