// Help (public/help/): a group list, one page per topic, breadcrumbs and previous / next links on every page, a search box,
// no broken link, nothing from the internet, every picture of the old single-page Help still shown, and the app and the
// Bridge reaching it. The map is public/help/topics.js; tools/help-nav.ts writes the breadcrumbs from it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMap, navBottom, navTop } from '../tools/help-nav.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { useTestEnv } from './env.ts';

const home = mkdtempSync(join(tmpdir(), 'tomlin-help-'));
useTestEnv({ TOMLIN_HOME: home, TOMLIN_PORT: '0', TOMLIN_OPEN: '', TOMLIN_NO_TOAST: '1', TOMLIN_MODELS_FILE: join(home, 'models-folder.txt'), TOMLIN_STARTUP_DIR: join(home, 'startup') });
writeFileSync(join(home, 'models-folder.txt'), '');
const { staticFile } = await import('../src/server/core.ts');
test.after(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  // The server module keeps timers that hold this process open; the results are out by now (a failure has set the exit code).
  setTimeout(() => process.exit(), 300);
});

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HELP = join(ROOT, 'public', 'help');
const map = await loadMap();
const read = (name: string) => readFileSync(join(HELP, name), 'utf8').replace(/\r\n/g, '\n');
const idsIn = (html: string) => new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));

test('the map is whole: unique ids, every group used, every topic in a real group with a page', () => {
  assert.ok(map.groups.length >= 6 && map.topics.length >= 30);
  assert.equal(new Set(map.topics.map(t => t.id)).size, map.topics.length, 'topic ids are unique');
  assert.equal(new Set(map.groups.map(g => g.id)).size, map.groups.length, 'group ids are unique');
  for (const g of map.groups) assert.ok(map.topics.some(t => t.group === g.id), `${g.id} has topics`);
  for (const t of map.topics) {
    assert.ok(map.groups.some(g => g.id === t.group), `${t.id} is in a group`);
    assert.ok(t.title && t.blurb, `${t.id} has a title and a summary`);
    assert.ok(existsSync(join(HELP, `${t.id}.html`)), `${t.id}.html exists`);
  }
  // Every page in the folder is a topic (no page the index does not know).
  const pages = readdirSync(HELP).filter(n => n.endsWith('.html') && n !== 'index.html').map(n => n.replace(/\.html$/, ''));
  assert.deepEqual(pages.sort(), map.topics.map(t => t.id).sort());
});

test('the topics the owner asked for are there', () => {
  const have = new Set(map.topics.map(t => t.id));
  for (const id of ['first-steps', 'hiring', 'saving', 'models', 'network-roles', 'adding-pc', 'linked-pcs', 'guest-passes', 'cluster', 'node-windows', 'moving-staff', 'backups', 'files-blog', 'jobs', 'updates', 'data-lock', 'tool-permissions', 'colours']) assert.ok(have.has(id), id);
  const windows = read('node-windows.html');
  for (const w of ['hibernation', 'Sign in automatically', 'reminders', 'powercfg /h off', 'netplwiz']) assert.ok(windows.includes(w), w);
});

test('the index lists every group and every topic, with a search box', () => {
  const index = read('index.html');
  for (const g of map.groups) assert.ok(index.includes(`id="group-${g.id}"`) && index.includes(`>${g.title.replace(/&/g, '&amp;')}<`), g.id);
  for (const t of map.topics) assert.ok(index.includes(`href="${t.id}.html"`), `${t.id} is in the index`);
  assert.match(index, /<input type="search" id="q"/);
});

test('every page has its breadcrumbs (Help > Group > Topic), previous and next, a title, and the search', () => {
  for (const t of map.topics) {
    const html = read(`${t.id}.html`);
    assert.ok(html.includes(navTop(map, t)), `${t.id}: breadcrumbs (run node tools/help-nav.ts)`);
    assert.ok(html.includes(navBottom(map, t)), `${t.id}: previous and next (run node tools/help-nav.ts)`);
    assert.match(html, new RegExp(`<h1[^>]*>${t.title.replace(/[()]/g, '\\$&')}</h1>`), `${t.id}: its h1 is the title`);
    assert.ok(html.includes('<script src="help.js" defer>') && html.includes('rel="stylesheet" href="help.css"'), t.id);
    assert.ok(html.includes('id="q"'), `${t.id}: search box`);
    assert.equal((html.match(/<h1[ >]/g) ?? []).length, 1, `${t.id}: one h1`);
    assert.ok(html.length > 700, `${t.id} has text`);
  }
  // The ends: no previous before the first, no next after the last; every other topic is reached from the one before it.
  assert.ok(!read(`${map.topics[0].id}.html`).includes('rel="prev"'));
  assert.ok(!read(`${map.topics.at(-1)!.id}.html`).includes('rel="next"'));
});

test('no link is broken: every href and src goes to a file or a place on a page, and nothing comes from the internet', () => {
  const files = ['index.html', ...map.topics.map(t => `${t.id}.html`)];
  const idCache = new Map<string, Set<string>>();
  const idsOf = (name: string) => idCache.get(name) ?? (idCache.set(name, idsIn(read(name))), idCache.get(name)!);
  let checked = 0;
  for (const f of files) {
    const html = read(f);
    assert.doesNotMatch(html, /\b(?:src|href)\s*=\s*"(?:https?:)?\/\//i, `${f}: nothing from the internet`);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i, `${f}: no inline script`);
    assert.doesNotMatch(html, /\sstyle="/i, `${f}: no inline style (the page's own policy forbids it)`);
    for (const [, attr, url] of html.matchAll(/\b(href|src)="([^"]*)"/g)) {
      checked++;
      assert.ok(url && !/^(javascript:|data:)/i.test(url), `${f}: ${attr} ${url}`);
      const [path, hash] = url.split('#');
      if (!path) { assert.ok(!hash || idsOf(f).has(hash), `${f}: #${hash}`); continue; }
      const target = join(HELP, path);
      assert.ok(existsSync(target), `${f}: ${url} exists`);
      if (hash) assert.ok(path.endsWith('.html') && idsOf(path).has(hash), `${f}: ${url} has its place`);
    }
  }
  assert.ok(checked > 400, `checked ${checked} links`);
  // The group links in each page's breadcrumbs land on the index's groups (the loop above checked the places).
  const index = read('index.html');
  for (const g of map.groups) assert.ok(index.includes(`id="group-${g.id}"`));
});

test('the old section names still land: every alias goes to a page (and a place) that exists', () => {
  assert.ok(Object.keys(map.aliases).length >= 25);
  for (const [old, to] of Object.entries(map.aliases)) {
    const [page, hash] = to.split('#');
    assert.ok(old.startsWith('help-'), old);
    assert.ok(existsSync(join(HELP, page)), `${old} -> ${to}`);
    if (hash) assert.ok(idsIn(read(page)).has(hash), `${old} -> ${to} has its place`);
  }
  // The names the app itself uses to open Help are all known.
  const app = ['index.html', 'chatview.js', 'home.js', 'app.js'].map(n => readFileSync(join(ROOT, 'public', n), 'utf8')).join('\n');
  for (const [, name] of app.matchAll(/data-help="([\w-]+)"/g)) assert.ok(name === 'help-title' || map.aliases[name], `data-help="${name}" is known`);
});

test('every picture of the old Help is still shown, and every picture used is there', () => {
  const shown = new Set<string>();
  for (const t of map.topics) for (const [, src] of read(`${t.id}.html`).matchAll(/<img src="([^"]+)"/g)) {
    assert.match(src, /^\.\.\/help-[\w-]+\.webp$/, src);
    assert.ok(existsSync(join(ROOT, 'public', src.slice(3))), src);
    shown.add(src.slice(3));
  }
  const all = readdirSync(join(ROOT, 'public')).filter(n => /^help-.*\.webp$/.test(n));
  assert.ok(all.length >= 13);
  for (const n of all) assert.ok(shown.has(n), `${n} is shown on a Help page`);
  for (const t of map.topics) for (const [, alt] of read(`${t.id}.html`).matchAll(/<img [^>]*alt="([^"]*)"/g)) assert.ok(alt.length > 20, `${t.id}: a picture has its words`);
});

test('what the old Help said is still said: a spread of its facts, found on the pages', () => {
  const text = map.topics.map(t => read(`${t.id}.html`)).join('\n');
  for (const fact of [
    'Qwen 3.5 35B-A3B', 'Realistic Vision 6', 'Florence-2', 'Award employee of the month', 'Energy drinks', 'Sharing and cluster permissions',
    'Allow host to update TOMLIN remotely', 'Allow to be used as part of a cluster', 'Back up projects now', 'Syncthing', 'UrBackup', 'Update by hand (offline)',
    'Set the host PIN', 'Link helper', 'Max: off', 'Answer now', 'remember: …', 'Find the fastest setup', 'Install TOMLIN.cmd', 'Repair install',
    'app-lock.json', 'TOMLIN\\data\\logs', 'Hosted live', 'Push live', 'Scan app (audit)', 'Rescan Hugging Face', 'Add to the queue', 'Lets create a project',
    'Orbital', 'Backups to a drive', 'Copies on my other PCs', 'What leaves this PC', 'settings.damaged-', 'Not found? Type its address instead',
  ]) assert.ok(text.includes(fact), fact);
});

test('the app shows Help in a frame on the new pages, keeps its two buttons, and the Bridge points at it', () => {
  const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
  const section = html.slice(html.indexOf('id="help" aria-labelledby'), html.indexOf('</section>', html.indexOf('id="help" aria-labelledby')));
  assert.match(section, /<iframe id="help-frame"/);
  assert.match(section, /href="help\/index\.html"/);
  assert.ok(section.includes('id="log-open"') && section.includes('id="report-open"') && section.includes('id="log-said"'));
  assert.ok(!section.includes('<h4'), 'the long page is gone from index.html');
  assert.match(readFileSync(join(ROOT, 'public', 'chatview.js'), 'utf8'), /help\/index\.html\?go=/);
  const bridge = readFileSync(join(ROOT, 'public', 'bridge', 'index.html'), 'utf8');
  const card = bridge.slice(bridge.indexOf('id="page-help"'), bridge.indexOf('</section>', bridge.indexOf('id="page-help"')));
  const links = [...card.matchAll(/href="\/help\/([\w-]+\.html)"/g)].map(m => m[1]);
  assert.ok(links.length >= 5);
  for (const l of links) assert.ok(existsSync(join(HELP, l)), l);
  assert.ok(links.includes('bridge-projects.html') && links.includes('index.html'));
});

/** staticFile answered into a plain object. */
async function get(path: string) {
  const out: { code: number; headers: Record<string, string>; body: Buffer } = { code: 0, headers: {}, body: Buffer.alloc(0) };
  const res = {
    writeHead(code: number, headers: Record<string, string> = {}) { out.code = code; out.headers = headers; return res; },
    end(data?: Buffer | string) { out.body = Buffer.from(data ?? ''); },
  };
  await staticFile(res as never, path);
  return out;
}

test('the page server serves the help folder, to its own page only, and keeps the other pages unframed', async () => {
  const index = await get('/help/');
  assert.equal(index.code, 200);
  assert.match(index.headers['content-type'], /text\/html/);
  assert.match(index.body.toString(), /How can we help\?/);
  assert.match(index.headers['content-security-policy'], /frame-ancestors 'self'/);
  assert.match(index.headers['content-security-policy'], /script-src 'self'/, 'the rest of the policy stays');
  assert.equal((await get('/help')).code, 302);
  assert.equal((await get('/help/models.html')).code, 200);
  assert.match((await get('/help/help.css')).headers['content-type'], /text\/css/);
  assert.match((await get('/help/topics.js')).headers['content-type'], /javascript/);
  assert.equal((await get('/help/nothing.html')).code, 404);
  assert.equal((await get('/help/../server.ts')).code, 404);
  assert.equal((await get('/help/..')).code, 404);
  assert.equal((await get('/help/sub/x.html')).code, 404);
  const app = await get('/');
  assert.equal(app.code, 200);
  assert.match(app.headers['content-security-policy'], /frame-ancestors 'none'/, 'the app itself is still never framed');
});
