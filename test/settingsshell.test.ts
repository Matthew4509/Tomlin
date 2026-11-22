// Settings' pages: a slow answer never replaces the page the person has moved on to, exactly one line of the Settings
// list is marked, the top bar never overlaps, Night colours every box and list, and the Files page has one Close that
// says where it goes back to. The page-change code is home.js's own, run here with a small stand-in for the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const read = (f: string) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/** home.js's pageTicket and setView, with the page around them stood in: the Settings list's lines and the view. */
function pages() {
  const home = read('home.js');
  const start = home.indexOf('let pageTurn = 0;');
  const end = home.indexOf('app.showPanes = ');
  assert.ok(start > 0 && end > start, 'home.js has pageTicket and setView');
  const lines = ['settings', 'staff', 'models', 'nodes', 'thispc', 'jobs', 'files', 'updates', 'data', 'colours'].map(setup => {
    const attrs = new Map<string, string>();
    return { dataset: { setup }, setAttribute: (k: string, v: string) => attrs.set(k, v), removeAttribute: (k: string) => attrs.delete(k), attrs };
  });
  const ctx: Record<string, unknown> = {
    homeUi: { view: 'home' },
    asPage: { dlg: null, view: '', back: 'settings', fromMenu: false },
    PAGE_VIEWS: ['staff', 'jobs', 'files'],
    shell: { dataset: {} },
    app: {},
    store: () => '',
    drawRail: () => undefined,
    pageFocus: false,
    focusPage: () => undefined,
    $: () => ({ scrollTop: 0 }),
    document: { querySelectorAll: () => lines },
  };
  runInNewContext(`${home.slice(start, end)}\nthis.pageTicket = pageTicket; this.setView = setView;`, ctx);
  const marked = () => lines.filter(l => l.attrs.get('aria-current') === 'page').map(l => l.dataset.setup);
  return { ctx: ctx as typeof ctx & { pageTicket: () => () => boolean; setView: (v: string) => void }, marked };
}

test('a slow page never lands on a page opened since: Hire staff, then Models, then Network stays on Network', () => {
  const { ctx, marked } = pages();
  // Hire staff pressed: its opener takes a ticket and waits for the server.
  const late = ctx.pageTicket();
  ctx.setView('models');
  ctx.setView('nodes');
  // The answer comes: the opener asks first, and shows nothing.
  assert.equal(late(), true);
  if (!late()) ctx.setView('staff');
  assert.equal((ctx.homeUi as { view: string }).view, 'nodes');
  assert.deepEqual(marked(), ['nodes']);
});

test('the last press wins between two slow pages, and a page nobody moved away from still opens', () => {
  const { ctx, marked } = pages();
  const jobs = ctx.pageTicket();
  const files = ctx.pageTicket();
  assert.equal(jobs(), true, 'Jobs pressed first is late once Files is pressed');
  assert.equal(files(), false, 'Files, pressed last, opens');
  if (!files()) ctx.setView('files');
  assert.deepEqual(marked(), ['files']);
  const again = ctx.pageTicket();
  assert.equal(again(), false);
});

test('exactly one line of the Settings list is marked after any run of pages', () => {
  const { ctx, marked } = pages();
  for (const v of ['staff', 'nodes', 'staff', 'thispc', 'models', 'files', 'settings', 'colours']) {
    ctx.setView(v);
    assert.deepEqual(marked(), [v]);
  }
  // Home and the chat are not in the list: nothing is marked.
  ctx.setView('home');
  assert.deepEqual(marked(), []);
  // The page marked looks unlike the line under the mouse, so the two are never taken for two pages marked: a pale
  // tint with a bar on its left (a tint is where you are; a filled shape is a button).
  const css = read('style.css');
  const current = css.match(/\.rail-links \.link\[aria-current="page"\][^{]*\{([^}]*)\}/g)!.filter(r => !/ svg \{/.test(r)).pop()!;
  assert.match(current, /background: var\(--accent-soft\)/);
  assert.match(current, /box-shadow: inset 3px 0 0 var\(--ink\)/);
  assert.match(css, /\.rail-links \.link:hover \{ background: var\(--hover\); \}/);
});

test('each opener that waits for the server shows its page only when it is not late', () => {
  const lateFirst = (src: string, from: string, show: string) => {
    const at = src.indexOf(from);
    assert.ok(at >= 0, from);
    const body = src.slice(at, src.indexOf(show, at));
    assert.match(body, /const late = app\.pageTicket\(\);/, `${from}: takes a ticket`);
    assert.match(body, /if \(late\(\)\) return/, `${from}: gives up when late`);
  };
  lateFirst(read('team.js'), 'app.seeAllStaff = async', "app.showAsPage(dlg, 'staff')");
  lateFirst(read('files.js'), "$('#files-open').addEventListener", "app.showAsPage(filesDlg, 'files')");
  lateFirst(read('jobs.js'), 'async function openJobs()', "app.showAsPage(jobsDlg, 'jobs')");
  // Staff opens All staff, which shows at once from the list already read and catches up (test/hirestaff.test.ts).
  const team = read('team.js');
  assert.match(team, /function openStaffMenu\(\) \{\n\s+return app\.seeAllStaff\(\);\n\}/);
  const all = team.slice(team.indexOf('app.seeAllStaff = async'));
  assert.ok(all.indexOf("app.showAsPage(dlg, 'staff')") < all.indexOf("await api('/api/staff')"), 'shown before the server is asked');
  // A plan pressed on Home still starts when the person has moved on; only the page stays put.
  assert.match(read('jobs.js'), /app\.planJob = async goal => \{\n[^\n]*\n  await openJobs\(\);/);
});

test('Staff, Jobs and Files opened from the Settings menu close back to Settings, and say so', () => {
  const home = read('home.js');
  assert.match(home, /if \(asPage\.fromMenu\) asPage\.back = 'settings';/);
  assert.match(home, /b\.textContent = `Close \(back to \$\{viewName\(asPage\.back\)\}\)`;/);
  assert.match(read('homeview.js'), /b\.addEventListener\('click', \(\) => \{\n[^\n]*\n    asPage\.fromMenu = true;/);
  const { ctx } = pages();
  (ctx.asPage as { fromMenu: boolean }).fromMenu = true;
  ctx.setView('thispc');
  assert.equal((ctx.asPage as { fromMenu: boolean }).fromMenu, false, 'a menu press counts for one page only');
});

test('a page opened on a narrow window is brought into sight; the phone list (no page) throws nothing', () => {
  const home = read('home.js');
  const fn = (name: string) => {
    const at = home.indexOf(`function ${name}(`);
    assert.ok(at > 0, name);
    return home.slice(at, home.indexOf('\n}\n', at) + 2);
  };
  // A page change brings the page up first, then moves the focus to it.
  assert.match(home, /if \(pageFocus && was !== view\) \{\n    bringUp\(view\);\n    focusPage\(view\);\n  \}/);
  const scrolled: string[] = [];
  const page = (id: string, top: number) => ({ offsetParent: {}, getBoundingClientRect: () => ({ top }), scrollIntoView: () => scrolled.push(id) });
  const pages: Record<string, unknown> = { '#nodes': page('nodes', 560), '#settings-data': page('data', -289), '#help': page('help', 60) };
  const ctx: Record<string, unknown> = {
    PAGE_VIEWS: ['staff', 'jobs', 'files'],
    PAGE_OF: { nodes: '#nodes', data: '#settings-data', help: '#help' },
    $: (s: string) => {
      if (!s) throw new SyntaxError('The provided selector is empty.');
      return pages[s] ?? null;
    },
    innerHeight: 800,
    asPage: { dlg: null },
    setTimeout: (f: () => void) => f(),
    document: { querySelectorAll: () => [], getElementById: () => null },
  };
  runInNewContext(`${fn('bringUp')}\n${fn('focusPage')}\nthis.bringUp = bringUp; this.focusPage = focusPage;`, ctx);
  const run = ctx as typeof ctx & { bringUp: (v: string) => void; focusPage: (v: string) => void };
  // Below the menu (a narrow window) and half way down (scrolled from the last page): both brought up. In sight: left.
  for (const v of ['nodes', 'data', 'help', 'rail', 'chat', 'staff']) run.bringUp(v);
  assert.deepEqual(scrolled, ['nodes', 'data']);
  // The phone's list has no page: nothing is looked for (an empty selector threw in the console on every visit).
  assert.doesNotThrow(() => run.focusPage('rail'));
});

test('Files: one Close (the title bar one), and sizes that stay on one line', () => {
  const css = read('style.css');
  assert.ok(css.includes('#setup-page > dialog.as-page > .help-body:has(> .dlg-top) > form[method="dialog"]:last-child { display: none; }'));
  assert.ok(css.includes('.file-item > .hint { flex: none; white-space: nowrap; }'));
});

test('Night: every box, list and choice takes the page colours, and the "any" hints are readable', () => {
  const css = read('style.css');
  assert.match(css, /:where\(input:not\([^)]*\), select, textarea\) \{\n  background-color: var\(--field\); color: var\(--field-ink\);/);
  assert.match(css, /:where\(input, textarea\)::placeholder \{ color: var\(--ink-soft\); opacity: 1; \}/);
  assert.match(css, /:where\(option, optgroup\) \{ background-color: var\(--field\); color: var\(--field-ink\); \}/);
});

test('the top bar wraps rather than overlap, and all muted says only Unmute', () => {
  const css = read('style.css');
  const tail = css.slice(css.indexOf('@media (min-width: 900px) { .bar { flex-wrap: nowrap; } }'));
  assert.match(tail, /\n\.bar \{ flex-wrap: wrap; \}/, 'the later rule wins');
  assert.match(css, /\.loaded > \.hint \{ white-space: nowrap; overflow: hidden; text-overflow: ellipsis; \}/);
  assert.doesNotMatch(css, /#mute-all-text/);
});
