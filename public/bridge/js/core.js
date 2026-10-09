// Shared helpers: the per-run key, building elements as text (never HTML), API calls, the info bar, connection lost.
// This page is TOMLIN's Bridge part: it lives at /bridge/ and its API at /bridge/api/ (src/server/bridge.ts).
'use strict';

const KEY = document.querySelector('meta[name="bridge-key"]').content;
let rows = [], stats = null, folders = null, loaded = false;

// ---- DOM helper: text always goes in as text, never as HTML ----
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const k in attrs || {}) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    // A style through the element, never as an attribute: the page's rules refuse inline style attributes.
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
const icon = cp => h('i', { class: 'ic', 'aria-hidden': 'true' }, String.fromCodePoint(cp));
const $ = id => document.getElementById(id);
// Every API path is written as the Bridge's own (/api/...); TOMLIN answers it under /bridge.
const BASE = '/bridge';
// TOMLIN's app lock closed (its PIN, idle minutes): its own page asks for the PIN, then comes back here.
function toLock(res) { if (res.status === 423) { location.href = '/'; return true; } return false; }

async function api(path, body) {
  const opt = { headers: { 'X-Bridge-Key': KEY } };
  if (body) { opt.method = 'POST'; opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(BASE + path, opt); }
  catch { setLost(true); throw new Error('TOMLIN is not answering. Start it again; this page reconnects by itself.'); }
  if (toLock(res)) throw new Error('TOMLIN is locked: type its PIN.');
  const data = await res.json().catch(() => ({}));
  if (res.status === 403) { location.reload(); throw new Error('TOMLIN was restarted; reloading.'); }
  if (lost) { setLost(false); load(); }
  if (!res.ok) throw new Error(data.error || ('TOMLIN answered ' + res.status + '.'));
  return data;
}

// Messages: a problem stays until closed; anything else goes after 8 s, but never while the pointer is on it
// (a message that vanishes before it can be copied is no help). Copy puts the text on the clipboard.
let ibTimer = null, ibErr = false;
function ibArm() { clearTimeout(ibTimer); ibTimer = ibErr ? null : setTimeout(() => { $('infobar').hidden = true; }, 8000); }
function info(msg, err) {
  if (err && lost) return; // the Connection lost bar already says it
  ibErr = !!err;
  $('infobar').className = 'infobar' + (err ? ' err' : '');
  $('ib-ic').textContent = String.fromCodePoint(err ? 0xE783 : 0xE946);
  $('ib-text').textContent = msg; $('infobar').hidden = false;
  ibArm();
}
$('ib-close').addEventListener('click', () => { clearTimeout(ibTimer); $('infobar').hidden = true; });
$('ib-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('ib-text').textContent); $('ib-copy').title = 'Copied'; $('ib-copy').querySelector('.ic').textContent = String.fromCodePoint(0xE73E); setTimeout(() => { $('ib-copy').querySelector('.ic').textContent = String.fromCodePoint(0xE8C8); $('ib-copy').title = 'Copy'; }, 1500); }
  catch { const r = document.createRange(); r.selectNodeContents($('ib-text')); getSelection().removeAllRanges(); getSelection().addRange(r); }
});
$('infobar').addEventListener('mouseenter', () => clearTimeout(ibTimer));
$('infobar').addEventListener('mouseleave', ibArm);

const fmtTok = n => !n ? '0' : n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n);
const fmtGB = b => (b / 1073741824).toFixed(1);
function fmtWhen(ms) {
  if (!ms) return 'unknown';
  const d = new Date(ms), now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}
// The Updated cell in two parts ("Today" / "9:58 AM", "3 Mar" / "2025"): the CSS puts the second under the first
// in a narrow list column, next to it on a wide window.
function whenParts(ms) {
  if (!ms) return [h('span', null, 'unknown')];
  const d = new Date(ms), now = new Date();
  const two = (a, b) => [h('span', null, a), h('span', { class: 't' }, ' ' + b)];
  if (d.toDateString() === now.toDateString()) return two('Today', d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));
  const dm = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return d.getFullYear() !== now.getFullYear() ? two(dm, String(d.getFullYear())) : [h('span', null, dm)];
}
function fmtUp(s) { const d = Math.floor(s / 86400), hr = Math.floor(s % 86400 / 3600); return d ? d + ' day' + (d > 1 ? 's' : '') + ' ' + hr + ' h' : hr + ' h ' + Math.floor(s % 3600 / 60) + ' min'; }
const tokensCounting = () => stats && stats.tokensBusy && !stats.tokensAt;

function auditLabel(a) {
  if (!a) return null;
  const c = a.counts, when = fmtWhen(Date.parse(a.ranAt));
  if (c.Critical || c.High) return { cls: 'a-bad', text: '▲ ' + [c.Critical && c.Critical + ' Critical', c.High && c.High + ' High'].filter(Boolean).join(', '), when };
  if (c.Medium) return { cls: 'a-warn', text: '■ ' + c.Medium + ' Medium', when };
  return { cls: 'a-ok', text: '✓ Passed', when };
}

// ---- Connection lost. The page stays open when TOMLIN stops; a bar over every page and a Reconnect item at
// the bottom of the nav pane say so. TOMLIN is started from its own icon (or Start TOMLIN.cmd), never from this
// page. The status check every 5 s is also the reconnect check: when it answers again the bar goes, and a new run (new
// key) reloads the page by itself. ----
let lost = false, restartAt = 0, fastPoll = null;
function setLost(on) {
  if (lost === on) return;
  lost = on;
  if (!on) { restartAt = 0; clearInterval(fastPoll); fastPoll = null; }
  renderLost();
}
function restartBridge() {
  restartAt = Date.now(); uplinkHidden = false;
  clearInterval(fastPoll);
  fastPoll = setInterval(() => {
    if (!lost || Date.now() - restartAt > 15000) { clearInterval(fastPoll); fastPoll = null; renderLost(); return; }
    api('/api/stats').then(d => { stats = d; renderStatus(); }).catch(() => {});
  }, 1500);
  renderLost();
}
function renderLost() {
  if (!$('lostbar')) return;
  renderConn();
  if (!lost) uplinkEnd();
  $('lostbar').hidden = !lost; $('nav-restart').hidden = !lost;
  if (!lost) return;
  const dry = stats && stats.dryRun, waiting = restartAt && Date.now() - restartAt < 15000;
  const again = label => h('button', { class: 'btn accent', id: 'lost-link', type: 'button', onclick: restartBridge }, icon(0xE72C), label);
  let text, act = null;
  if (dry) text = 'This test copy stopped. Start it again (node test/bridge/serve.js --dry-run with BRIDGE_PORT=' + location.port + '); this page reconnects by itself.';
  else if (waiting) { text = 'Looking for TOMLIN… This page reconnects by itself.'; act = h('button', { class: 'btn', type: 'button', disabled: true }, 'Looking…'); }
  else if (restartAt) { text = 'It did not answer. Start TOMLIN (its icon on the desktop or by the clock); this page reconnects by itself.'; act = again('Try again'); }
  else { text = 'TOMLIN stopped answering, so what you see may be out of date. Start it again; this page reconnects by itself.'; act = again('Try now'); }
  $('lost-text').textContent = text;
  $('lost-act').replaceChildren(...(act ? [act] : []));
  // The uplink joke (Orbital only) reads the bar's words, so it comes after them.
  if (waiting) uplinkStart();
  else if (restartAt) uplinkFail();
}
$('nav-restart').addEventListener('click', () => { const a = $('lost-link'); if (a) a.click(); else $('lostbar').scrollIntoView(); });

const UPLINK_LINES = ['Contacting ground station 127.0.0.1…', 'Uplink: no carrier. Retrying…', 'Warming up the lasers…',
  'Counting satellites in orbit…', 'Asking the Bridge nicely…', 'Polishing the solar panels…', 'Checking the kettle is on…',
  'Handshake 3 of 3…', 'Recalibrating the dish…', 'Waking the night shift…', 'Reticulating orbits…', 'Still here. Still trying…'];
let uplinkTimer = null, uplinkShown = false, uplinkHidden = false, uplinkFrom = null;
function uplinkLog(text) {
  const li = h('li', null, text), log = $('uplink-log');
  log.append(li);
  while (log.children.length > 4) log.firstChild.remove();
}
function uplinkStart() {
  if (uplinkShown || uplinkHidden || document.documentElement.dataset.theme !== 'orbital') return;
  uplinkShown = true;
  const u = $('uplink'); u.className = 'uplink'; u.hidden = false;
  // A modal: focus moves into it (and back where it was when it closes), and Tab stays inside it.
  uplinkFrom = document.activeElement;
  $('uplink-x').focus();
  $('uplink-title').textContent = 'Re-establishing uplink';
  $('uplink-log').replaceChildren(); $('uplink-act').replaceChildren();
  const op = 'operator@' + ((stats && stats.host) || 'this-pc').toLowerCase();
  let i = 0, line = 0;
  $('uplink-op').textContent = '';
  clearInterval(uplinkTimer);
  uplinkTimer = setInterval(() => {
    if (i < op.length) { $('uplink-op').textContent = op.slice(0, ++i); return; }
    if ((i++ - op.length) % 12 === 0) uplinkLog(UPLINK_LINES[line++ % UPLINK_LINES.length]);
  }, 90);
}
function uplinkFail() {
  if (!uplinkShown || $('uplink').classList.contains('failed')) return;
  clearInterval(uplinkTimer);
  $('uplink').classList.add('failed');
  $('uplink-title').textContent = 'Uplink failed';
  uplinkLog('No answer from TOMLIN.');
  $('uplink-act').replaceChildren(h('p', { class: 'uplink-note', style: 'margin:0 0 10px;color:#e4f0ff' }, $('lost-text').textContent),
    h('button', { class: 'btn accent', type: 'button', onclick: () => { uplinkEnd(true); restartBridge(); } }, icon(0xE72C), 'Try again'));
}
function uplinkEnd(quiet) {
  clearInterval(uplinkTimer);
  if (!uplinkShown) return;
  uplinkShown = false;
  const back = () => { $('uplink').hidden = true; if (uplinkFrom && uplinkFrom.isConnected && uplinkFrom.focus) uplinkFrom.focus(); uplinkFrom = null; };
  if (quiet) { back(); return; }
  $('uplink').classList.remove('failed'); $('uplink').classList.add('won');
  $('uplink-title').textContent = 'Uplink established';
  uplinkLog('Welcome back.');
  setTimeout(back, 900);
}
$('uplink-x').addEventListener('click', () => { uplinkHidden = true; uplinkEnd(true); });
$('uplink').addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); $('uplink-x').click(); return; }
  if (e.key !== 'Tab') return;
  const f = [...$('uplink').querySelectorAll('button, a[href]')].filter(x => !x.hidden && x.offsetParent !== null);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  else if (!$('uplink').contains(document.activeElement)) { e.preventDefault(); first.focus(); }
});
// A tick of the clock turns "Starting…" into "It did not answer" when nothing came up.
setInterval(() => { if (lost && restartAt) renderLost(); }, 1000);
