// The office's purse and trophy: what is paid stays paid when the treat list is trimmed, the trophy stays earned, an
// energy drink is not saved and has a limit on the server, food is paid for once, and a damaged office.json does not
// empty the game. The first tests are plain functions, the rest the real routes on a home of their own.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as home from '../src/home.ts';

const { SHOP, buy, cleanBought, purseOf, roomsOf, trophyOf } = home;
type Bought = home.Bought;

const AT = '2026-01-02T03:04:05.000Z';
const row = (item: string, at = AT): Bought => ({ item: item as Bought['item'], price: SHOP.find(i => i.id === item)!.price, at });
/** Every kept piece, as many as the office holds. */
const PIECES = SHOP.filter(i => i.keeps).flatMap(i => Array.from({ length: i.most }, () => row(i.id)));
/** An office as saved before the running total was kept: everything bought, and the first cake and so on about to be trimmed. */
const OLD_LIST = [...PIECES, ...['cake', 'donuts', 'sandwiches', 'icecream'].map(i => row(i)), row('coffee', '2026-01-03T00:00:00.000Z'), ...Array.from({ length: 995 }, () => row('coffee', '2026-02-01T00:00:00.000Z'))];
const spentOn = (list: Bought[]) => list.reduce((n, b) => n + b.price, 0);

test('an office saved before the running total reads the same: same purse, same trophy', () => {
  const book = home.cleanBook({ bought: OLD_LIST });
  assert.equal(book.spentEarlier, 0);
  assert.deepEqual(book.bought, OLD_LIST);
  assert.deepEqual(book.trophy, { at: '2026-01-03T00:00:00.000Z' });
  assert.equal(purseOf(1e9, book.bought, book.spentEarlier).left, 1e9 - spentOn(OLD_LIST));
  // Junk in the new fields counts for nothing.
  const junk = home.cleanBook({ bought: [], spentEarlier: 'lots', trophy: { at: 5 } });
  assert.equal(junk.spentEarlier, 0);
  assert.equal(junk.trophy, null);
});

test('an old file saved with 1001 treats: the one trimmed on reading stays paid for, and the trophy is worked out first', () => {
  const list = [...OLD_LIST, row('coffee', '2026-03-01T00:00:00.000Z')];
  const book = home.cleanBook({ bought: list });
  assert.equal(book.bought.length, OLD_LIST.length);
  assert.equal(book.spentEarlier, row('cake').price);
  assert.deepEqual(book.trophy, { at: '2026-01-03T00:00:00.000Z' });
  assert.equal(purseOf(1e9, book.bought, book.spentEarlier).spent, spentOn(list));
});

test('the purse after the trim: each treat bought past 1000 costs its price, nothing comes back', () => {
  let book = home.cleanBook({ bought: OLD_LIST });
  let paid = spentOn(OLD_LIST);
  for (const item of ['coffee', 'cake', 'coffee', 'donuts', 'coffee']) {
    const r = buy(item, 1e9, book.bought, new Date(2026, 3, 1), { spentEarlier: book.spentEarlier });
    assert.ok('bought' in r, JSON.stringify(r));
    book = home.bookAfter(book, r.bought);
    paid += r.bought.price;
    assert.equal(purseOf(1e9, book.bought, book.spentEarlier).spent, paid, item);
  }
  assert.equal(book.bought.filter(b => !SHOP.find(i => i.id === b.item)?.keeps).length, 1000);
  // Saved as JSON and read back: the same.
  assert.deepEqual(home.cleanBook(JSON.parse(JSON.stringify(book))), book);
  // What was paid before the trim still counts when deciding what can be bought.
  const short = buy('coffee', paid, book.bought, new Date(2026, 3, 1), { spentEarlier: book.spentEarlier });
  assert.ok('error' in short, JSON.stringify(short));
});

test('the trophy stays earned when the treats that earned it are trimmed, dated by the purchase that finished it', () => {
  let book = home.cleanBook({ bought: OLD_LIST });
  for (let i = 0; i < 20; i++) book = home.bookAfter(book, row('coffee', '2026-05-01T00:00:00.000Z'));
  assert.equal(book.bought.some(b => b.item === 'cake'), false);
  assert.equal(trophyOf(book.bought), null);
  assert.deepEqual(book.trophy, { at: '2026-01-03T00:00:00.000Z' });
  assert.deepEqual(roomsOf(book.bought, book.trophy).trophy, { at: '2026-01-03T00:00:00.000Z' });
  // Saved once, it is what is read back from then on.
  assert.deepEqual(home.cleanBook(JSON.parse(JSON.stringify(book))).trophy, book.trophy);
  // Earned by a purchase made now: the same, through the same door.
  const nearly = home.cleanBook({ bought: OLD_LIST.filter(b => b.item !== 'cake') });
  assert.equal(nearly.trophy, null);
  const done = home.bookAfter(nearly, row('cake', '2026-06-01T00:00:00.000Z'));
  assert.deepEqual(done.trophy, { at: '2026-06-01T00:00:00.000Z' });
});

test('free energy drinks saved by older versions take up no place on the treat list; a paid row stays', () => {
  const free = Array.from({ length: 1000 }, () => row('energy'));
  const paid = { item: 'energy' as const, price: 500, at: AT };
  const book = home.cleanBook({ bought: [row('cake'), ...free, paid] });
  assert.deepEqual(book.bought, [row('cake'), paid]);
  assert.equal(book.spentEarlier, 0);
  assert.equal(cleanBought({ bought: [row('cake'), ...free] }).length, 1);
});

test('energy drinks: a second round is refused until the first has worn off, saying how long', () => {
  const now = new Date(2026, 6, 1, 12);
  const at = now.getTime();
  const soon = buy('energy', 0, [], now, { energyAt: at - 15_000 });
  assert.ok('error' in soon && /still buzzing/i.test(soon.error) && /45 s/.test(soon.error), JSON.stringify(soon));
  assert.ok('bought' in buy('energy', 0, [], now, { energyAt: at - home.ENERGY_SECONDS * 1000 }));
  assert.ok('bought' in buy('energy', 0, [], now));
  // Only the drinks wait.
  assert.ok('bought' in buy('coffee', 1e9, [], now, { energyAt: at }));
});

// ---- The page: food is paid for once ----

/** The page's table and shop button, cut from public/office.js and run on made-up surroundings. */
async function pageShop() {
  const js = await readFile(new URL('../public/office.js', import.meta.url), 'utf8');
  const cut = (from: string, to: string) => {
    const a = js.indexOf(from);
    const b = js.indexOf(to, a);
    assert.ok(a >= 0 && b > a, `${from} ... ${to}`);
    return js.slice(a, b);
  };
  const code = `${cut('let courier = null;', '/** Where a delivery is handed over')}\n${cut('const present = () =>', '// ---- The vending machine')}\nreturn { buyItem, deliveries, orderFood };`;
  const calls: { item: string; settle: (ok: boolean) => void }[] = [];
  const said: string[] = [];
  const world = { people: new Map([['mira', { id: 'mira', row: { doing: 'resting' } }]]), pizzaOn: false, rooms: {} };
  const api = (_path: string, body: { item: string }) => new Promise((resolve, reject) => {
    calls.push({ item: body.item, settle: ok => (ok ? resolve({ purse: { left: 1 } }) : reject(new Error('Not enough tokens yet (made-up).'))) });
  });
  const FOOD = { donuts: {}, cake: {}, pizza: {} };
  const noop = () => undefined;
  const made = new Function('api', 'world', 'FOOD', 'fullSay', 'officeData', 'num', 'wake', 'SHOP_WORDS', 'say', 'fullSaid', code);
  const page = made(api, world, FOOD, (t: string) => said.push(t), noop, String, noop, {}, noop, { textContent: '' });
  const item = (id: string) => ({ id, name: id, the: `the ${id}`, price: 1, room: 'treats' });
  return { ...page, item, calls, said, button: () => ({ disabled: false }) } as {
    buyItem: (i: unknown, b: unknown) => Promise<void>; deliveries: { kind: string }[]; orderFood: (k: string) => boolean;
    item: (id: string) => unknown; calls: typeof calls; said: string[]; button: () => unknown;
  };
}

test('food pressed twice quickly: the second is refused before it is paid for, and only one comes', { timeout: 5_000 }, async () => {
  const p = await pageShop();
  const first = p.buyItem(p.item('donuts'), p.button());
  const second = p.buyItem(p.item('cake'), p.button());
  await second;
  assert.deepEqual(p.calls.map(c => c.item), ['donuts'], 'only the first goes to the till');
  assert.match(p.said.at(-1)!, /on its way/);
  // Pizza, which is free, waits for the same table.
  assert.equal(p.orderFood('pizza'), false);
  p.calls[0].settle(true);
  await first;
  assert.deepEqual(p.deliveries, [{ kind: 'donuts' }]);
  assert.match(p.said.at(-1)!, /donuts ordered/);
});

test('food the server refuses leaves the table free for the next try', { timeout: 5_000 }, async () => {
  const p = await pageShop();
  const first = p.buyItem(p.item('cake'), p.button());
  p.calls[0].settle(false);
  await first;
  assert.deepEqual(p.deliveries, []);
  assert.match(p.said.at(-1)!, /Not enough tokens/);
  const again = p.buyItem(p.item('cake'), p.button());
  assert.equal(p.calls.length, 2);
  p.calls[1].settle(true);
  await again;
  assert.deepEqual(p.deliveries, [{ kind: 'cake' }]);
});

test('the page says when the office file is damaged, instead of showing an empty purse as the truth', async () => {
  const js = await readFile(new URL('../public/office.js', import.meta.url), 'utf8');
  assert.match(js, /d\.damaged/);
  assert.match(js, /world\.damaged/);
});

// ---- The routes, on a home of their own ----

const freePort = () => new Promise<number>(resolve => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const port = (s.address() as { port: number }).port;
    s.close(() => resolve(port));
  });
});

let dir = '';
let server: ChildProcess;
let base = '';
const EARNED = 1_000_000_000;
const officeFile = () => join(dir, 'data', 'office.json');
const backup = () => `${officeFile()}.bak`;
const setAsideNow = () => readdirSync(join(dir, 'data')).filter(f => f.startsWith('office.json.damaged-'));
const saved = () => JSON.parse(readFileSync(officeFile(), 'utf8'));
const post = (p: string, body: unknown) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const view = async () => (await fetch(`${base}/api/office`)).json();

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tomlin-purse-'));
  mkdirSync(join(dir, 'startup'));
  mkdirSync(join(dir, 'data'));
  writeFileSync(join(dir, 'models-folder.txt'), '');
  // Tokens written by the made-up hire of the first server test: the purse's money, and today's for an award.
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  writeFileSync(join(dir, 'data', 'usage-staff.json'), JSON.stringify({ mira: { out: EARNED, written: { [today]: 500 } } }));
  const port = await freePort();
  server = spawn(process.execPath, [fileURLToPath(new URL('../src/server.ts', import.meta.url))], {
    env: { ...process.env, TOMLIN_HOME: dir, TOMLIN_PORT: String(port), TOMLIN_MODELS_FILE: join(dir, 'models-folder.txt'), TOMLIN_NO_TOAST: '1', TOMLIN_STARTUP_DIR: join(dir, 'startup'), TOMLIN_OPEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let said = '';
  server.stdout!.on('data', d => (said += d));
  server.stderr!.on('data', d => (said += d));
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200 && !said.includes('is running at'); i++) await new Promise(r => setTimeout(r, 300));
  assert.match(said, /is running at/, said);
});

after(async () => {
  server.kill();
  await new Promise(r => setTimeout(r, 300));
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('the server: a treat with nobody hired is not paid for; the drinks stay free', { timeout: 30_000 }, async () => {
  writeFileSync(officeFile(), JSON.stringify({ bought: [] }));
  const none = await post('/api/office/buy', { item: 'coffee' });
  assert.equal(none.status, 400);
  assert.match(((await none.json()) as { error: string }).error, /Nobody is in the office/);
  assert.equal((await view()).purse.spent, 0);
  assert.equal((await post('/api/staff', { action: 'hire', name: 'Mira', role: 'writer', level: 'junior' })).status, 200);
});

test('the server: a treat bought past 1000 costs its price and the trophy stays, from a file saved by an older version', { timeout: 30_000 }, async () => {
  writeFileSync(officeFile(), JSON.stringify({ awards: [], bought: OLD_LIST }));
  const was = await view();
  assert.equal(was.purse.earned, EARNED);
  assert.equal(was.purse.spent, spentOn(OLD_LIST));
  assert.deepEqual(was.rooms.trophy, { at: '2026-01-03T00:00:00.000Z' });
  for (let i = 1; i <= 5; i++) {
    const r = await post('/api/office/buy', { item: 'coffee' });
    assert.equal(r.status, 200, await r.clone().text());
    const now = await view();
    assert.equal(now.purse.left, was.purse.left - i * 10_000, `after ${i}`);
    assert.deepEqual(now.rooms.trophy, was.rooms.trophy, `after ${i}`);
  }
  assert.ok(Array.isArray(saved().awards), 'what else is in the file stays');
});

test('the server: energy drinks are not saved, and a second round within the minute is refused', { timeout: 30_000 }, async () => {
  writeFileSync(officeFile(), JSON.stringify({ bought: [row('cake')] }));
  const first = await post('/api/office/buy', { item: 'energy' });
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal(saved().bought.length, 1);
  const second = await post('/api/office/buy', { item: 'energy' });
  assert.equal(second.status, 400);
  assert.match(((await second.json()) as { error: string }).error, /still buzzing/i);
  assert.equal(saved().bought.length, 1);
});

test('the server: a damaged office.json falls back to the last good save; the damaged one is kept beside it', { timeout: 30_000 }, async () => {
  writeFileSync(officeFile(), JSON.stringify({ bought: [row('table')], awards: [] }));
  const bought = await post('/api/office/buy', { item: 'rocks' });
  assert.equal(bought.status, 200, await bought.clone().text());
  const good = await view();
  assert.equal(good.rooms.desks.rocks, true);
  assert.ok(existsSync(backup()), 'a copy of the last good save');
  const aside = setAsideNow().length;
  writeFileSync(officeFile(), '{ "bought": [ {"item": "tab');
  const now = await view();
  assert.equal(now.damaged, undefined);
  assert.equal(now.rooms.boardroom.table, true);
  assert.equal(now.rooms.desks.rocks, true);
  assert.deepEqual(now.purse, good.purse);
  assert.equal(setAsideNow().length, aside + 1);
  assert.equal(saved().bought.length, 2, 'the good save is back under its own name');
  assert.equal((await post('/api/office/buy', { item: 'ducks' })).status, 200);
  assert.equal(saved().bought.length, 3);
});

test('the server: an office saved before the copies were kept gets one when it is opened', { timeout: 30_000 }, async () => {
  rmSync(backup(), { force: true });
  writeFileSync(officeFile(), JSON.stringify({ bought: [row('sofa')] }));
  assert.equal((await view()).rooms.lounge.sofa, true);
  assert.deepEqual(JSON.parse(readFileSync(backup(), 'utf8')).bought, [row('sofa')]);
});

test('the server: damaged with no good copy, buys and awards are refused in plain words and the file is left alone', { timeout: 30_000 }, async () => {
  rmSync(backup(), { force: true });
  const hurt = '{ "bought": [ {"item": "gym"';
  writeFileSync(officeFile(), hurt);
  const aside = setAsideNow().length;
  const now = await view();
  assert.match(now.damaged, /damaged/);
  assert.equal(now.purse, null);
  for (const [p, body] of [['/api/office/buy', { item: 'energy' }], ['/api/office/buy', { item: 'coffee' }], ['/api/office/award', {}], ['/api/office/award/undo', {}]] as const) {
    const r = await post(p, body);
    assert.equal(r.status, 400, p);
    assert.match(((await r.json()) as { error: string }).error, /damaged/, p);
  }
  assert.equal(readFileSync(officeFile(), 'utf8'), hurt);
  assert.equal(setAsideNow().length, aside);
  // Mended by hand or from a backup: the office is back at once.
  writeFileSync(officeFile(), JSON.stringify({ bought: [row('tv')] }));
  const back = await view();
  assert.equal(back.damaged, undefined);
  assert.equal(back.rooms.lounge.tv, true);
  // An award goes through the same door: what was bought stays, and the copy has both.
  const award = await post('/api/office/award', {});
  assert.equal(award.status, 200, await award.clone().text());
  assert.deepEqual(saved().bought, [row('tv')]);
  assert.equal(saved().awards.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(backup(), 'utf8')), saved());
  assert.equal((await post('/api/office/award/undo', {})).status, 200);
  assert.deepEqual(saved().awards, []);
  assert.deepEqual(JSON.parse(readFileSync(backup(), 'utf8')), saved());
});
