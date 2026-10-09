// Status bar, This PC, the Running list, Hosted live and Git marks.
'use strict';

// ---- status bar, This PC, audits ----
// ---- Running (nav pane) ----
// A Stop click stops at once, so the list must not move under the pointer: the row being stopped stays, greyed, until
// it has gone, and for a moment after the list changes shape a Stop click is ignored (the row below has just slid
// into the place that was clicked).
const stoppingPorts = new Set();
let runShape = '', runShapeAt = 0;
async function runStop(port, job) {
  if (Date.now() - runShapeAt < 1000 || stoppingPorts.has(port)) return;
  stoppingPorts.add(port); renderRunning();
  try { await job(); } finally { stoppingPorts.delete(port); renderRunning(); }
}
function renderRunning() {
  const mine = rows.filter(r => r.running), other = rows.filter(r => !r.running && r.portInUse);
  const n = mine.length + other.length;
  const shape = [...mine.map(r => r.running.port), ...other.map(r => r.portInUse)].join(',');
  if (shape !== runShape) { runShape = shape; runShapeAt = Date.now(); }
  const item = (r, isMine) => {
    const port = isMine ? r.running.port : r.portInUse;
    if (stoppingPorts.has(port)) return h('div', { class: 'run-item' },
      h('span', { class: 'run-open', 'aria-busy': 'true' }, h('span', { class: 'run-dot ' + (isMine ? 'mine' : 'other'), 'aria-hidden': 'true' }, isMine ? '●' : '◐'),
        h('span', { class: 'nm' }, 'Stopping ' + r.name + '…'), h('span', { class: 'pt' }, ':' + port)));
    return h('div', { class: 'run-item' },
      h('button', { class: 'run-open', type: 'button', title: 'Open localhost:' + port + ' in your browser' + (isMine ? '' : '\nHeld by another program, not started by the Bridge'), onclick: () => act('open-browser', r) },
        h('span', { class: 'run-dot ' + (isMine ? 'mine' : 'other'), 'aria-hidden': 'true' }, isMine ? '●' : '◐'),
        h('span', { class: 'nm' }, r.name), h('span', { class: 'pt' }, ':' + port)),
      h('button', { class: 'run-stop', type: 'button', title: isMine ? 'Stop ' + r.name : 'Stop what holds port ' + port, 'aria-label': 'Stop ' + r.name,
        onclick: () => runStop(port, () => isMine ? stop(r) : stopPort(port)) }, icon(0xE71A)));
  };
  $('runpanel').replaceChildren(
    h('div', { class: 'run-head' }, 'Running', n ? h('span', { class: 'n' }, String(n)) : null,
      n ? h('button', { class: 'linkbtn', type: 'button', onclick: stopAllDialog }, 'Stop all') : null),
    ...(n ? [...mine.map(r => item(r, true)), ...other.map(r => item(r, false))]
          : [h('div', { class: 'run-empty' }, 'Nothing running. Start one with Run local copy.')]));
}

// ---- Hosted live: the address each project is hosted at, checked when the Bridge starts and every 5, 10 or 15 minutes.
// A light per project (row, nav pane, status pill); a site that goes down shows an error once. ----
const LIVE = { up: { mark: '●', text: 'Live', cls: 'l-up', word: 'Up' }, unsure: { mark: '▲', text: 'Live?', cls: 'l-unsure', word: 'Unsure' }, down: { mark: '✕', text: 'Down', cls: 'l-down', word: 'Down' } };
const LIVE_NONE = { mark: '○', text: 'Not checked', cls: 'l-none', word: 'Not checked yet' };
const hostOf = u => { try { return new URL(u).host; } catch { return String(u || ''); } };
function liveLabel(r) { return r.liveUrl ? (r.live && LIVE[r.live.state]) || LIVE_NONE : null; }
function liveTip(r) { return hostOf(r.liveUrl) + ': ' + (r.live ? r.live.reason + '\nChecked ' + fmtWhen(Date.parse(r.live.at)) : 'not checked yet'); }
function liveChip(r) {
  const l = liveLabel(r);
  if (!l) return null;
  return h('button', { class: 'live ' + l.cls, type: 'button', title: liveTip(r), 'aria-label': 'Live site ' + hostOf(r.liveUrl) + ': ' + l.word, onclick: () => liveDialog(r) },
    h('span', { class: 'dot', 'aria-hidden': 'true' }, l.mark), l.text);
}
const LIVE_ORDER = { down: 0, unsure: 1, none: 2, up: 3 };

// ---- Git: where each project stands (read only; the Bridge never commits or pushes). Shape + colour, like Live. ----
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
function gitLabel(g) {
  if (!g) return null;
  switch (g.state) {
    case 'none': return { mark: '○', text: 'No git', cls: 'l-none', say: 'Not in git: no saved history and no backup copy.' };
    case 'empty': return { mark: '○', text: 'Git, nothing saved', cls: 'l-none', say: 'Git is set up here, but nothing has been saved (committed) yet.' };
    case 'local': return { mark: '▲', text: 'Only on this PC', cls: 'l-unsure', say: 'Saved in git on this PC only. If this PC is lost, the history goes with it.' };
    case 'unpushed': return { mark: '▲', text: 'Not pushed', cls: 'l-unsure', say: 'Linked to ' + g.remote + ', but this PC has no record of a push, so the saved history may exist only here. (A push made from another PC or folder shows here only after a fetch.)' };
    case 'ahead': return { mark: '▲', text: plural(g.ahead, 'not pushed', 'not pushed'), cls: 'l-unsure', say: plural(g.ahead, 'save is', 'saves are') + ' not on ' + g.remote + ' yet. Push to back them up.' };
    case 'changes': return { mark: '▲', text: plural(g.changes, 'unsaved', 'unsaved'), cls: 'l-unsure', say: plural(g.changes, 'file has', 'files have') + ' changes not saved in git yet' + (g.ahead ? ', and ' + plural(g.ahead, 'save is', 'saves are') + ' not pushed' : '') + '. Commit, then push, to back them up.' };
    case 'ok': return { mark: '●', text: 'Backed up', cls: 'l-up', say: 'Everything saved is on ' + g.remote + ' (as of this PC\'s last push or fetch).' };
    default: return { mark: '?', text: 'Git error', cls: 'l-down', say: g.reason || 'git could not read this folder.' };
  }
}
function gitChip(r) {
  const l = gitLabel(r.git);
  if (!l) return null;
  return h('button', { class: 'live ' + l.cls, type: 'button', title: l.say, 'aria-label': 'Git: ' + l.text, onclick: () => gitDialog(r) },
    h('span', { class: 'dot', 'aria-hidden': 'true' }, l.mark), l.text);
}
function gitDialog(r, opts = {}) {
  const g = r.git, l = gitLabel(g);
  const fact = (k, v) => v == null || v === '' ? null : h('div', { class: 'git-fact' }, h('span', { class: 'muted' }, k), h('span', null, v));
  const gitPart = [
    h('h4', { class: 'split-head' }, 'Git'),
    h('p', null, h('b', { class: l.cls }, l.mark + ' ' + l.text), h('br'), l.say),
    fact('Branch', g.branch),
    fact('Changed files not saved', g.state === 'none' ? null : String(g.changes || 0)),
    fact('Last save (commit)', g.lastCommit ? fmtWhen(Date.parse(g.lastCommit)) : null),
    fact('Backup copy', g.remote || (g.state === 'none' || g.state === 'error' ? null : 'none')),
    fact('Folder', r.dir),
    g.changes || g.state === 'empty' ? h('p', { style: 'margin:12px 0 0' }, h('button', { class: 'btn', type: 'button', onclick: () => changesDialog(r) }, icon(0xE7C3), 'See what changed')) : null,
    ...(gitSteps(g) || []),
    h('p', { class: 'muted', style: 'font-size:13px;margin-top:12px' }, 'The Bridge only reads git here: it never commits, pushes or changes the folder. Refresh reads it again.')];
  const close = [h('button', { class: 'btn accent', type: 'button', onclick: closeDialog }, 'Close')];
  // Inside TOMLIN: git on the left, the copies on my other PCs on the right (one column on a narrow window).
  const nodes = nodeSection(r, opts);
  if (!nodes) return dialog(r.name + ': git', gitPart.slice(1), close, 'wide');
  dialog(r.name + ': git and backups', [h('div', { class: 'split-cols' },
    h('section', { class: 'split-col', 'aria-label': 'Git' }, ...gitPart.filter(k => k != null && k !== false)),
    h('section', { class: 'split-col', 'aria-label': 'Copies on my other PCs' }, nodes))], close, 'split');
}
// See what changed: every changed file since the last save, line by line, to read before committing. Read only.
async function changesDialog(r) {
  let d;
  try { d = await api('/api/git/changes?id=' + encodeURIComponent(r.id)); } catch (e) { return info(e.message, true); }
  if (!d.ok) return info(d.error, true);
  const back = h('button', { class: 'btn', type: 'button', onclick: () => gitDialog(r) }, 'Back to ' + r.name + ': git');
  const close = h('button', { class: 'btn accent', type: 'button', onclick: closeDialog }, 'Close');
  if (!d.files.length) return dialog(r.name + ': what changed', [h('p', null, 'Nothing has changed since the last save.')], [close, back]);
  const add = d.files.reduce((n, f) => n + f.added, 0), rem = d.files.reduce((n, f) => n + f.removed, 0);
  const lineCls = l => l[0] === '+' ? 'df-add' : l[0] === '-' ? 'df-del' : l.startsWith('@@') ? 'df-hunk' : '';
  const fileView = (f, i) => h('details', { class: 'df-file', open: i < 5 },
    h('summary', null, h('span', { class: 'df-kind df-' + f.kind }, f.kind), h('span', { class: 'df-path' }, f.from ? f.from + ' → ' + f.path : f.path),
      f.binary ? h('span', { class: 'df-n' }, 'binary') : h('span', { class: 'df-n' }, h('span', { class: 'df-add' }, '+' + f.added), ' ', h('span', { class: 'df-del' }, '−' + f.removed))),
    f.binary ? h('p', { class: 'muted df-note' }, 'A binary file (a picture, zip or similar): its contents are not shown.')
    : f.note ? h('p', { class: 'muted df-note' }, f.note)
    : f.lines.length ? h('pre', { class: 'df-lines' }, f.lines.map(l => h('span', { class: lineCls(l) }, l)), f.cut ? h('span', { class: 'df-hunk' }, '… ' + f.cut.toLocaleString() + ' more lines not shown') : null)
    : h('p', { class: 'muted df-note' }, f.kind === 'renamed' ? 'Renamed only; the contents are the same.' : 'No line changes (only the file mode, say).'));
  dialog(r.name + ': what changed', [
    h('p', null, plural(d.files.length, 'file', 'files') + ' changed since the ' + (d.against === 'last save' ? 'last save (commit)' : 'start: nothing is saved yet') + ': ',
      h('span', { class: 'df-add' }, plural(add, 'line', 'lines') + ' added'), ', ', h('span', { class: 'df-del' }, rem.toLocaleString() + ' removed'), '.',
      d.more ? ' The first 300 files are shown; ' + d.more + ' more are not.' : ''),
    h('p', { class: 'muted', style: 'font-size:13px' }, 'Green lines are new, red lines are gone. Read only: the Bridge never saves, undoes or changes anything here.'),
    ...d.files.map(fileView)], [close, back], 'wide');
}
function gitSummary() {
  if (!rows.length || !rows.some(r => r.git)) return '';
  const n = f => rows.filter(r => r.git && f(r.git.state)).length;
  const parts = [[n(s => s === 'ok'), 'backed up'], [n(s => s === 'ahead' || s === 'changes' || s === 'unpushed'), 'to save or push'],
    [n(s => s === 'local'), 'only on this PC'], [n(s => s === 'none' || s === 'empty'), 'no git'], [n(s => s === 'error'), 'git error']];
  return 'Git: ' + parts.filter(([c]) => c).map(([c, t]) => c + ' ' + t).join(' · ');
}
// Made once and kept: the panel is redrawn every 5 s, which would close an open list.
let liveEveryEl = null;
function liveEveryRow() {
  if (!liveEveryEl) liveEveryEl = h('label', { class: 'live-every' }, 'Check every ', h('select', { class: 'sel', 'aria-label': 'Check the live sites every', onchange: e => setLiveEvery(e.target.value) },
    [5, 10, 15].map(m => h('option', { value: m }, m + ' min'))));
  const sel = liveEveryEl.querySelector('select');
  if (stats && stats.liveEvery && document.activeElement !== sel) sel.value = String(stats.liveEvery);
  return liveEveryEl;
}
function renderLivePanel() {
  const list = rows.filter(r => r.liveUrl).sort((a, b) => LIVE_ORDER[a.live ? a.live.state : 'none'] - LIVE_ORDER[b.live ? b.live.state : 'none'] || a.name.localeCompare(b.name));
  const busy = stats && stats.liveBusy;
  const n = s => list.filter(r => r.live && r.live.state === s).length;
  const sum = list.length ? [n('up') && n('up') + ' up', n('unsure') && n('unsure') + ' unsure', n('down') && n('down') + ' down'].filter(Boolean).join(' · ') : '';
  $('livepanel').replaceChildren(
    h('div', { class: 'run-head' }, 'Live sites',
      list.length ? h('button', { class: 'linkbtn', type: 'button', disabled: !!busy, title: 'Ask every live address again (one plain request each)', onclick: checkAllLive }, busy ? 'Checking…' : 'Check now') : null),
    sum ? h('div', { class: 'live-sum' }, sum) : '', // replaceChildren prints a null as the word "null"
    list.length ? liveEveryRow() : '',
    ...(list.length ? list.map(r => {
      const l = liveLabel(r);
      return h('div', { class: 'run-item' }, h('button', { class: 'run-open', type: 'button', title: liveTip(r), onclick: () => liveDialog(r) },
        h('span', { class: 'run-dot ' + l.cls, 'aria-hidden': 'true' }, l.mark), h('span', { class: 'nm' }, r.name), r.live && r.live.ms != null && r.live.state !== 'down' ? h('span', { class: 'ms', title: 'How long the page took to answer' }, r.live.ms < 1000 ? r.live.ms + ' ms' : (r.live.ms / 1000).toFixed(1) + ' s') : '', h('span', { class: 'pt ' + l.cls }, l.word)));
    }) : [h('div', { class: 'run-empty' }, 'No live addresses yet. Add one from a project\'s … menu › Hosted live.')]));
}
async function setLiveEvery(m) {
  try { const d = await api('/api/live/every', { minutes: Number(m) }); if (!d.ok) return info(d.error, true); if (stats) stats.liveEvery = d.every; info('Live sites are checked every ' + d.every + ' minutes, the next time ' + d.every + ' minutes from now. A site that goes down shows a message here.'); }
  catch (e) { info(e.message, true); }
}
async function checkAllLive() {
  try { const d = await api('/api/live/check-all', {}); if (!d.ok) return info(d.error, true); info('Checking the live sites, one at a time…'); setTimeout(load, 800); }
  catch (e) { info(e.message, true); }
}
function liveStateView(l, url) {
  if (!url) return null;
  if (!l) return h('div', { class: 'livestate l-none' }, h('b', null, '○ Not checked'), h('span', { class: 'what' }, 'Not checked yet.'));
  const s = LIVE[l.state] || LIVE_NONE;
  const bits = ['Checked ' + fmtWhen(Date.parse(l.at))];
  if (l.status) bits.push('answer ' + l.status);
  if (l.ms != null) bits.push((l.ms / 1000).toFixed(1) + ' s');
  if (l.certTo) bits.push('certificate until ' + new Date(l.certTo).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }));
  if (l.finalUrl && l.finalUrl !== url) bits.push('ends at ' + l.finalUrl);
  return h('div', { class: 'livestate ' + s.cls, role: 'status' }, h('b', null, s.mark + ' ' + s.word), h('span', { class: 'what' }, l.reason, h('span', { class: 'where' }, bits.join(' · '))));
}
function liveDialog(r) {
  const input = h('input', { type: 'text', inputmode: 'url', value: r.liveUrl || '', placeholder: 'example.com', 'aria-label': 'Live address', spellcheck: 'false', autocomplete: 'off' });
  const err = h('div', { class: 'err', role: 'alert' });
  const state = h('div', null, liveStateView(r.live, r.liveUrl));
  const busy = on => { for (const b of $('dlg-foot').querySelectorAll('button')) b.disabled = on; };
  const set = async (url, closing) => {
    busy(true); err.textContent = '';
    if (url) state.replaceChildren(h('p', { class: 'muted' }, 'Checking ' + url + '…'));
    try {
      const d = await api('/api/live/set', { id: r.id, url });
      if (!d.ok) { err.textContent = d.error; state.replaceChildren(liveStateView(r.live, r.liveUrl) || ''); }
      else if (!d.url) { closeDialog(); info('Live address removed from ' + r.name + '.'); }
      else { r.liveUrl = d.url; r.live = d.live; input.value = d.url; state.replaceChildren(liveStateView(d.live, d.url)); if (closing) closeDialog(); }
      load();
    } catch (e) { err.textContent = e.message; }
    busy(false);
  };
  const buttons = [
    h('button', { class: 'btn accent', type: 'button', onclick: () => {
      const v = input.value.trim();
      if (!v) { err.textContent = r.liveUrl ? 'Use Remove address to take it off.' : 'Type the address the site is hosted at, like example.com.'; return input.focus(); }
      set(v);
    } }, r.liveUrl ? 'Save and check' : 'Add and check'),
    r.liveUrl ? h('button', { class: 'btn', type: 'button', onclick: async () => {
      busy(true); err.textContent = ''; state.replaceChildren(h('p', { class: 'muted' }, 'Checking ' + r.liveUrl + '…'));
      try { const d = await api('/api/live/check', { id: r.id }); if (!d.ok) err.textContent = d.error; else { r.live = d.live; state.replaceChildren(liveStateView(d.live, r.liveUrl)); load(); } }
      catch (e) { err.textContent = e.message; }
      busy(false);
    } }, 'Check now') : null,
    r.liveUrl && !(stats && stats.demo) ? h('a', { class: 'btn', href: r.liveUrl, target: '_blank', rel: 'noopener noreferrer' }, icon(0xE8A7), 'Open live site') : null,
    r.liveUrl ? h('button', { class: 'btn danger', type: 'button', onclick: () => set('') }, 'Remove address') : null,
    cancelBtn('Close')].filter(Boolean);
  dialog('Hosted live: ' + r.name, [
    h('p', { class: 'muted' }, 'Where ' + r.name + ' is hosted on the internet. The Bridge checks it when it starts and every ' + ((stats && stats.liveEvery) || 15) + ' minutes (Live sites panel) with one plain request, the same as opening the page, and shows a light: ● up, ▲ unsure, ✕ down. Scan app also compares the live pages with your local copy (one page every 5 seconds).'),
    h('div', { class: 'field' }, input), err, state], buttons);
}
// A site that is down shows an error once (when first seen down, including right after the Bridge starts).
const downSeen = new Set();
function announceDown() {
  const fresh = [];
  for (const r of rows) {
    const down = r.liveUrl && r.live && r.live.state === 'down';
    if (down && !downSeen.has(r.id)) { downSeen.add(r.id); fresh.push(r); }
    if (!down) downSeen.delete(r.id);
  }
  if (fresh.length === 1) info('Live site down: ' + fresh[0].name + ' (' + hostOf(fresh[0].liveUrl) + '). ' + fresh[0].live.reason, true);
  else if (fresh.length > 1) info(fresh.length + ' live sites are down: ' + fresh.map(r => r.name).join(', ') + '. Live sites in the left panel has the details.', true);
}
