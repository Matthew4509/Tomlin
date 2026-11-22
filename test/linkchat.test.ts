// A long chat with a hire on a linked PC (256k test, 22 Nov 2026): the whole chat crosses in one request, and a linked PC
// took at most 230,000 characters of it whatever its context, so a 262,144 context was refused past about 51,000
// word-pieces. Now that PC's cap follows its largest context, its hello says the cap, and this PC builds the chat to fit.
// And a message whose turn ended in a fault before any answer stays on screen but is never sent again, so a refused
// paste no longer fills the room and pushes the rest of the chat out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_TURNS, TURNS_CHARS, chatCharsFor, cleanTurns } from '../src/brains.ts';
import { RULES_ON_TOP, chatRoom, linkCtx } from '../src/memory.ts';
import { startPc, type Pc } from './pcs.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

test('a linked PC takes 4 characters a word-piece of its largest context, never less than before (230,000)', () => {
  assert.equal(TURNS_CHARS, 230_000);
  assert.equal(chatCharsFor(8192), 230_000);
  assert.equal(chatCharsFor(32_768), 230_000);
  assert.equal(chatCharsFor(262_144), 1_048_576);
  assert.equal(chatCharsFor(Number.NaN), 230_000);
  const big = [{ role: 'user', content: 'x'.repeat(300_000) }];
  assert.equal(cleanTurns(big), null, 'over the old cap');
  assert.ok(cleanTurns(big, chatCharsFor(262_144)), 'taken at a 262,144 context');
  assert.ok(cleanTurns(Array.from({ length: 401 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'hi' }))), 'more than 200 turns');
  assert.equal(cleanTurns(Array.from({ length: MAX_TURNS + 1 }, () => ({ role: 'user', content: 'hi' }))), null);
});

test('this PC builds a linked PC\'s chat to fit what it takes: smaller only when it must', () => {
  // A TOMLIN before 2.1.9 (230,000): a 262,144 context is built smaller, to fit.
  const old = linkCtx(262_144, TURNS_CHARS, 16_384);
  assert.ok(old < 262_144 && old > 32_768, String(old));
  assert.ok(chatRoom(old, 16_384) + RULES_ON_TOP <= TURNS_CHARS);
  // 2.1.9 at 262,144: it takes the whole context.
  assert.equal(linkCtx(262_144, chatCharsFor(262_144), 16_384), 262_144);
  // Small contexts are as they were.
  assert.equal(linkCtx(8192, TURNS_CHARS, 16_384), 8192);
  assert.equal(linkCtx(32_768, TURNS_CHARS, 16_384), 32_768);
});

test('the node says its cap and takes chats of that size; this PC reads it and fits the chat before it sends', () => {
  const node = read('src', 'jobrun', 'node.ts');
  assert.equal((node.match(/chatChars: await chatCharsHere\(\)/g) ?? []).length, 2, 'both hellos');
  assert.match(node, /p === '\/worker\/run' \|\| p === '\/worker\/tool-result' \? chatBytesFor\(await chatCharsHere\(\)\)/);
  assert.match(node, /brains\.cleanTurns\(b\.turns, await chatCharsHere\(\)\)/);
  assert.match(node, /the chat sent is longer than this PC takes at once/);
  assert.match(read('src', 'jobrun', 'links.ts'), /chatChars: Number\.isSafeInteger\(data\.chatChars\)/);
  const chat = read('src', 'server', 'chat.ts');
  assert.match(chat, /jobRoutes\.lastHello\(linkRef\.pc\)\?\.chatChars \|\| brains\.TURNS_CHARS/);
  assert.match(chat, /const ctx = linkChars \? memory\.linkCtx\(ctxSet, linkChars, ANSWER_CEILING\) : ctxSet;/);
});

/** Sends one chat message to a copy and gives the stream's text. */
async function say(pc: Pc, body: Record<string, unknown>): Promise<string> {
  const r = await fetch(`${pc.base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json', ...(pc.cookie ? { cookie: pc.cookie } : {}) }, body: JSON.stringify(body) });
  return r.text();
}

test('a real copy: a message whose turn ended in a fault stays on screen, is marked never sent, and is not in the next turn', { timeout: 300_000 }, async () => {
  const top = mkdtempSync(join(tmpdir(), 'tomlin-linkchat-'));
  let pc: Pc | null = null;
  try {
    // A model file that is not a model: the message is saved, then its load fails, so the turn ends in a fault before any answer.
    const home = join(top, 'home');
    mkdirSync(join(home, 'models', 'chat'), { recursive: true });
    writeFileSync(join(home, 'models', 'chat', 'Broken-1B-Q4_K_M.gguf'), 'G'.repeat(500));
    pc = await startPc({ root: ROOT, home, env: { OLLAMA: join(top, 'no-ollama') } });
    const hired = await pc.post('/api/staff', { action: 'hire', name: 'Test Hire', role: 'default', level: 'default', model: 'Broken-1B-Q4_K_M.gguf' });
    assert.equal(hired.status, 200, JSON.stringify(hired.body));
    const who = `staff:${(hired.body.staff as { id: string; name: string }[]).find(x => x.name === 'Test Hire')!.id}`;
    const made = await pc.post('/api/chats/new', { who });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const chatId = made.body.chat.id as string;
    const huge = `Please read this. ${'The pallet goes on the left rack after the morning check. '.repeat(1200)}`;
    const said = await say(pc, { chatId, who, message: huge, scanOk: true });
    assert.match(said, /event: error\ndata: /, said.slice(0, 600));
    const lines = (await pc.get(`/api/chat?id=${encodeURIComponent(chatId)}`)).body?.lines;
    assert.ok(Array.isArray(lines), JSON.stringify(lines).slice(0, 300));
    const mine = lines.find((l: { role: string; content: string }) => l.role === 'user' && l.content.trim() === huge.trim());
    assert.ok(mine, `the message stays on screen; said: ${said.slice(0, 300)}; lines: ${JSON.stringify(lines).slice(0, 300)}`);
    assert.equal(mine.refused, true, 'marked never sent');
    assert.equal(lines.at(-1).failed, true, 'the fault under it');
    // What the next turn would read: the refused message is not in it.
    const reading = await pc.get(`/api/memory/reading?chat=${encodeURIComponent(chatId)}&who=${encodeURIComponent(who)}`);
    assert.equal(reading.status, 200, JSON.stringify(reading.body));
    assert.ok(reading.body.used < 5000, `next turn reads ${reading.body.used} characters`);
  } finally {
    await pc?.stop();
    rmSync(top, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});
