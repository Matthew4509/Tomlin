// The server itself, started on an empty home: the other tests read the server's files as text, so a route that throws
// when it is called showed only when someone pressed its button (2.0.28 to 2.0.34: Stop on "Try each way" named an
// answer slot that no longer existed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const freePort = () => new Promise<number>(resolve => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const port = (s.address() as { port: number }).port;
    s.close(() => resolve(port));
  });
});

test('the server starts on an empty home, serves the page, and the stops answer without a fault', { timeout: 120_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'sm-server-'));
  mkdirSync(join(home, 'startup'));
  writeFileSync(join(home, 'models-folder.txt'), '');
  // A project the Bridge part lists (a copy with a home of its own starts from its workspace).
  mkdirSync(join(home, 'data', 'workspace', 'demo-site'), { recursive: true });
  writeFileSync(join(home, 'data', 'workspace', 'demo-site', 'index.html'), '<p>made-up site</p>');
  const port = await freePort();
  const server = spawn(process.execPath, [fileURLToPath(new URL('../src/server.ts', import.meta.url))], {
    env: { ...process.env, TOMLIN_HOME: home, TOMLIN_PORT: String(port), TOMLIN_MODELS_FILE: join(home, 'models-folder.txt'), TOMLIN_NO_TOAST: '1', TOMLIN_STARTUP_DIR: join(home, 'startup'), TOMLIN_OPEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let said = '';
  server.stdout.on('data', d => (said += d));
  server.stderr.on('data', d => (said += d));
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 200 && !said.includes('is running at'); i++) await new Promise(r => setTimeout(r, 300));
    assert.match(said, /is running at/, said);
    assert.equal((await fetch(`${base}/`)).status, 200);
    const status = await (await fetch(`${base}/api/status`)).json();
    assert.equal(typeof status.version, 'string');
    const post = (p: string, body: unknown) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const tryStop = await post('/api/place/try', { stop: true });
    assert.equal(tryStop.status, 200, await tryStop.clone().text());
    // Stop names its chat: one that names none stops nothing (it used to stop every answer, another window's too).
    assert.equal((await post('/api/chat/stop', {})).status, 400);
    const chatStop = await post('/api/chat/stop', { chatId: 'no-such-chat' });
    assert.equal(chatStop.status, 200, await chatStop.text());
    // Power settings out of range are refused with the range, not quietly emptied; an empty box still means "not used".
    const tooMuch = await post('/api/pc/power', { id: 'here', watts: 9000, kwh: '' });
    assert.equal(tooMuch.status, 400);
    assert.match(((await tooMuch.json()) as { error: string }).error, /at most 5,000 watts/);
    assert.equal((await post('/api/pc/power', { id: 'here', watts: 120, kwh: -1 })).status, 400);
    assert.equal((await post('/api/pc/power', { id: 'here', watts: 120, kwh: '' })).status, 200);
    // Undo award with no award this month says so.
    const noAward = await post('/api/office/award/undo', {});
    assert.equal(noAward.status, 400);
    assert.match(((await noAward.json()) as { error: string }).error, /no award for/);

    // Every send names its chat: the server's "open chat" is whichever window opened one last (two windows, or the
    // second look beside today's), so a message must never land in that one instead of its own.
    const hire = async (name: string) => {
      const r = await post('/api/staff', { action: 'hire', name, role: 'writer', level: 'junior' });
      assert.equal(r.status, 200, await r.clone().text());
      return `staff:${name.toLowerCase()}`;
    };
    const maya = await hire('Maya');
    const otto = await hire('Otto');
    const open = async (who: string) => ((await (await post('/api/chats/new', { who })).json()) as { chat: { id: string } }).chat.id;
    const chatA = await open(maya);
    const chatB = await open(otto);
    // Hiring someone else leaves the open chat (Otto's) as it was: it used to turn every window's chat to the new hire.
    await hire('Nora');
    const current = (await (await fetch(`${base}/api/chat`)).json()) as { chat: { id: string; who: string } | null };
    assert.equal(current.chat?.id, chatB, 'a hire does not change the open chat');
    const answer = async (body: Record<string, unknown>) => {
      const r = await post('/api/chat', body);
      return { status: r.status, text: await r.text() };
    };
    assert.equal((await answer({ message: 'remember: no chat named' })).status, 400, 'a message that names no chat is refused');
    assert.equal((await answer({ chatId: 'gone-chat', message: 'remember: gone' })).status, 404);
    assert.equal((await answer({ chatId: '', who: 'staff:nobody', message: 'remember: nobody' })).status, 400);
    // "remember: ..." is answered by the app, no model: sent to Maya's chat while Otto's is the open one.
    const toA = await answer({ chatId: chatA, message: 'remember: the test colour is teal' });
    assert.equal(toA.status, 200);
    assert.match(toA.text, /event: done/, toA.text);
    assert.match(toA.text, new RegExp(`"chat":"${chatA}"`), 'the stream names the chat it answered in');
    const linesOf = async (id: string) => ((await (await fetch(`${base}/api/chat?id=${encodeURIComponent(id)}`)).json()) as { lines: { role: string; content: string }[]; chat: { id: string } | null });
    assert.ok((await linesOf(chatA)).lines.some(l => l.content === 'remember: the test colour is teal'), 'in the chat it named');
    assert.equal((await linesOf(chatB)).lines.length, 0, 'not in the open chat');
    assert.equal((await linesOf('gone-chat')).chat, null);
    // A chat with no messages yet: {chatId: '', who} makes a new chat with that person, not one with whoever is open.
    const toNew = await answer({ chatId: '', who: maya, message: 'remember: a second note' });
    const made = /"chat":"([^"]+)"/.exec(toNew.text)?.[1] ?? '';
    assert.ok(made && made !== chatA && made !== chatB, toNew.text);
    const madeChat = (await (await fetch(`${base}/api/chats`)).json()) as { chats: { id: string; who: string }[] };
    assert.equal(madeChat.chats.find(c => c.id === made)?.who, maya);
    // Continue, the handoff, Empty, Ignore and documents name their chat too; so does a picture.
    assert.equal((await post('/api/chat/continue', {})).status, 400);
    assert.equal((await post('/api/chat/handoff', { chatId: 'gone-chat' })).status, 404);
    assert.equal((await post('/api/chat/clear', {})).status, 400);
    assert.equal((await post('/api/chat/large', {})).status, 400);
    assert.equal((await post('/api/chat/doc/remove', { id: 'x' })).status, 400);
    const doc = await fetch(`${base}/api/chat/doc`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-name': 'notes.txt' }, body: 'hello' });
    assert.equal(doc.status, 400, 'a document that names no chat is refused');
    const docB = await fetch(`${base}/api/chat/doc`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-name': 'notes.txt', 'x-chat': chatB }, body: 'made-up notes for the test' });
    assert.equal(docB.status, 200, await docB.clone().text());
    assert.equal(((await docB.json()) as { chat: string }).chat, chatB);
    assert.equal((await post('/api/images/generate', { prompt: 'a lighthouse' })).status, 400);
    assert.equal((await post('/api/images/generate', { prompt: 'a lighthouse', chat: 'gone-chat' })).status, 404);
    // No picture model: refused, and the chat is not renamed after a picture that was never started.
    const artist = await post('/api/staff', { action: 'hire', name: 'Clara', role: 'artist', level: 'junior' });
    assert.equal(artist.status, 200, await artist.clone().text());
    const chatC = await open('staff:clara');
    assert.equal((await post('/api/images/generate', { prompt: 'a red lighthouse at dusk', chat: chatC })).status, 409);
    const named = (await (await fetch(`${base}/api/chats`)).json()) as { chats: { id: string; title: string }[] };
    assert.equal(named.chats.find(c => c.id === chatC)?.title, 'New chat');
    // Hiring an artist leaves "Draw as" as it was for every window: the window that hired picks them itself.
    assert.equal(((await artist.json()) as { settings: { imageAs: string } }).settings.imageAs, '', 'a hire does not change who draws');

    // "What ... reads" (and Pin, which uses it for the notebook) names its chat: Clara's chat is the open one now.
    const reading = async (q: string) => {
      const r = await fetch(`${base}/api/memory/reading${q}`);
      return { status: r.status, body: (await r.json()) as { name?: string; scope?: string; error?: string } };
    };
    assert.equal((await reading('')).status, 400, 'a reading that names no chat is refused');
    const ofB = await reading(`?chat=${encodeURIComponent(chatB)}`);
    assert.equal(ofB.status, 200, JSON.stringify(ofB.body));
    assert.equal(ofB.body.name, 'Otto', 'the chat named, not the open one');
    assert.equal(ofB.body.scope, otto);
    assert.equal((await reading(`?chat=&who=${encodeURIComponent(maya)}`)).body.name, 'Maya', 'a chat with no messages yet: the person named');
    assert.equal((await reading('?chat=gone-chat')).status, 404);

    // Choosing who to talk to answers with the chat it opened ({opened}): the window that chose reads that one by id,
    // and another window opening a chat in between does not swap it.
    const chose = async (body: Record<string, unknown>) => (await (await post('/api/settings', body)).json()) as { opened?: string };
    const toOtto = await chose({ who: otto });
    assert.ok(toOtto.opened, JSON.stringify(toOtto));
    assert.equal((await post('/api/chats/open', { id: chatA })).status, 200);
    const ottoChat = await linesOf(toOtto.opened!);
    assert.equal((ottoChat.chat as { who?: string } | null)?.who, otto, 'the chat that choice opened, read by its id');
    assert.equal(((await (await fetch(`${base}/api/chat`)).json()) as { chat: { id: string } | null }).chat?.id, chatA, 'the server\'s open chat is the other window\'s now');
    assert.equal('opened' in (await chose({ tone: 'natural' })), false, 'a change that chooses nobody opens nothing');

    // The blog writer's picture names its chat and its artist ('' = none): one naming neither is refused before anything.
    assert.equal((await post('/api/blog/picture', { path: 'blog/a.md', prompt: 'a lighthouse' })).status, 400);
    assert.equal((await post('/api/blog/picture', { path: 'blog/a.md', prompt: 'a lighthouse', as: '', chat: 'gone-chat' })).status, 404);

    // A new subject takes the name of the empty chat on the asking window's screen only, never another window's.
    const chatE = await open(otto);
    const subject = async (body: Record<string, unknown>) => ((await (await post('/api/chats/new', { who: otto, ...body })).json()) as { chat: { id: string; title: string } }).chat;
    const garden = await subject({ title: 'Garden plans' });
    assert.notEqual(garden.id, chatE, 'the open chat (another window\'s) keeps its name');
    const kitchen = await subject({ title: 'Kitchen plans', chatId: chatE });
    assert.equal(kitchen.id, chatE, 'the empty chat on this window\'s screen takes the name');
    assert.equal(kitchen.title, 'Kitchen plans');

    // Pinning a chat (the left panel keeps it under Projects): kept by the server until unpinned; a gone chat says so.
    const pinned = async (on: boolean) => ((await (await post('/api/chats/pin', { id: garden.id, on })).json()) as { chats: { id: string; pinned?: boolean }[] }).chats.find(c => c.id === garden.id)?.pinned;
    assert.equal(await pinned(true), true);
    assert.equal(((await (await fetch(`${base}/api/chats`)).json()) as { chats: { id: string; pinned?: boolean }[] }).chats.find(c => c.id === garden.id)?.pinned, true);
    assert.equal(await pinned(false), false);
    assert.equal((await post('/api/chats/pin', { id: 'gone-chat', on: true })).status, 404);

    // The second look is dropped for now: /alt/ goes to the app.
    const alt = await fetch(`${base}/alt/`, { redirect: 'manual' });
    assert.equal(alt.status, 302);
    assert.equal(alt.headers.get('location'), '/');

    // The Bridge part: its page at /bridge/ with its own key, its API behind that key, and the app lock over both.
    const bare = await fetch(`${base}/bridge`, { redirect: 'manual' });
    assert.equal(bare.status, 301);
    assert.equal(bare.headers.get('location'), '/bridge/');
    const page = await fetch(`${base}/bridge/`);
    const html = await page.text();
    assert.equal(page.status, 200, html);
    const key = /name="bridge-key" content="([0-9a-f]+)"/.exec(html)?.[1];
    assert.ok(key, 'the page carries its key');
    assert.doesNotMatch(page.headers.get('content-security-policy') ?? '', /unsafe-inline/);
    assert.equal((await fetch(`${base}/bridge/api/projects`)).status, 403, 'no key, no answer');
    const projects = await fetch(`${base}/bridge/api/projects`, { headers: { 'x-bridge-key': key! } });
    assert.equal(projects.status, 200, await projects.clone().text());
    assert.ok(Array.isArray((await projects.json()).projects));
    const listed = (await (await fetch(`${base}/bridge/api/projects`, { headers: { 'x-bridge-key': key! } })).json()) as { projects: { id: string; folder: string; node: unknown }[]; stats: { nodes: unknown } };
    const demo = listed.projects.find(x => x.folder === 'demo-site');
    assert.ok(demo, JSON.stringify(listed.projects.map(x => x.folder)));
    assert.deepEqual(demo.node, { on: false }, 'not ticked: no copies');
    // Copies on other PCs: ticked here, nothing linked, so Back up now says how to link one.
    const kpost = (p: string, body: unknown) => fetch(`${base}/bridge${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-key': key! }, body: JSON.stringify(body) });
    const on = await (await kpost('/api/node-backup/set', { id: demo.id, on: true })).json() as { ok: boolean; pcs: unknown[]; project: { files: number; how: string; copies: unknown[] } };
    assert.ok(on.ok && on.pcs.length === 0, JSON.stringify(on));
    assert.equal(on.project.files, 1);
    assert.equal(on.project.how, 'folder');
    assert.deepEqual(on.project.copies, []);
    const now = await (await kpost('/api/node-backup/now', { id: demo.id })).json() as { ok: boolean; error: string };
    assert.ok(!now.ok && /No PC is linked yet/.test(now.error), JSON.stringify(now));
    const after = (await (await fetch(`${base}/bridge/api/projects`, { headers: { 'x-bridge-key': key! } })).json()) as typeof listed;
    assert.deepEqual(after.stats.nodes, { pcs: 0, ready: 0 });
    assert.deepEqual(after.projects.find(x => x.folder === 'demo-site')!.node, { on: true, name: 'demo-site', at: null, pcName: null, current: false, copies: 0 });
    assert.equal((await kpost('/api/node-backup/set', { id: demo.id, on: false })).status, 200);
    assert.equal((await fetch(`${base}/bridge/app.css`)).status, 200);
    assert.notEqual((await fetch(`${base}/bridge/config.js`)).status, 200, 'only the page\'s own files are served');
    // A page from another site cannot post to it (TOMLIN's own origin check runs first).
    assert.equal((await fetch(`${base}/bridge/api/scan`, { method: 'POST', headers: { origin: 'https://example.com', 'x-bridge-key': key! }, body: '{}' })).status, 403);
    const lockOn = await post('/api/applock', { action: 'set', pin: '4826', pin2: '4826', agree: true });
    assert.equal(lockOn.status, 200, await lockOn.clone().text());
    const locked = await fetch(`${base}/bridge/`, { redirect: 'manual' });
    assert.equal(locked.status, 302, 'locked: the page goes to the PIN screen');
    assert.equal(locked.headers.get('location'), '/');
    assert.equal((await fetch(`${base}/bridge/api/projects`, { headers: { 'x-bridge-key': key! } })).status, 423, 'locked: the API is shut');
  } finally {
    server.kill();
    await new Promise(r => server.once('exit', r));
    rmSync(home, { recursive: true, force: true });
  }
});
