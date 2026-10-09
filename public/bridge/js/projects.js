// The project list: rows and tiles, Stop all, Copy prompt, My order, and the … menus.
'use strict';

// ---- projects list ----
function stateBadge(r) {
  if (r.running) return h('span', { class: 'badge b-run' }, '● Running :' + r.running.port);
  if (r.portInUse) return h('span', { class: 'badge b-busy', title: 'Something is answering on this port, but the Bridge did not start it.' }, '◐ Port ' + r.portInUse + ' in use');
  if (r.portSharedWith) return h('span', { class: 'badge b-off', title: 'This project starts on the same port as ' + r.portSharedWith.name + ', which the Bridge is running. Stop that one first to run this one.' }, '○ Port ' + r.portSharedWith.port + ' used by ' + r.portSharedWith.name);
  if (!r.commands.length) return h('span', { class: 'badge b-off' }, '– No start command');
  return h('span', { class: 'badge b-off' }, '○ Stopped');
}

// Per-viewer display choices (List/Tiles, sort, show hidden) are remembered in this browser only.
const pref = {
  get(k, d) { try { const v = localStorage.getItem('bridge.' + k); return v == null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('bridge.' + k, v); } catch {} },
};
let view = pref.get('view', 'list');
let showHidden = pref.get('showHidden', '0') === '1';

// "My order": projects the person has placed come first, in their order; the rest follow, newest first.
function myOrder(list) {
  return list.slice().sort((a, b) => {
    if (a.order != null && b.order != null) return a.order - b.order;
    if (a.order != null) return -1;
    if (b.order != null) return 1;
    return (b.updated || 0) - (a.updated || 0);
  });
}
function sorted(list) {
  const by = { updated: (a, b) => (b.updated || 0) - (a.updated || 0), tokens: (a, b) => b.tokens - a.tokens,
    name: (a, b) => a.name.localeCompare(b.name), running: (a, b) => (!!b.running - !!a.running) || (b.updated || 0) - (a.updated || 0) };
  return $('sort').value === 'mine' ? myOrder(list) : list.slice().sort(by[$('sort').value]);
}

function setView(v) {
  view = v; pref.set('view', v);
  $('view-list').setAttribute('aria-pressed', v === 'list');
  $('view-tiles').setAttribute('aria-pressed', v === 'tiles');
  renderList();
}
function renderHiddenToggle() {
  const n = rows.filter(r => r.hiddenView).length;
  const b = $('cmd-hidden');
  b.hidden = !n;
  b.setAttribute('aria-pressed', showHidden);
  $('hidden-label').textContent = (showHidden ? 'Showing hidden' : 'Show hidden') + ' (' + n + ')';
}

function runButton(r) {
  if (r.running) return [
    h('button', { class: 'btn', type: 'button', onclick: () => act('open-browser', r) }, icon(0xE774), 'Open'),
    h('button', { class: 'btn', type: 'button', onclick: () => stop(r) }, icon(0xE71A), 'Stop')];
  if (!r.commands.length) return h('button', { class: 'btn', type: 'button', disabled: true, title: 'No start command in the project\'s .claude/launch.json or project.json' }, icon(0xE768), 'Run local copy');
  return h('button', { class: 'btn', type: 'button', 'aria-haspopup': r.commands.length > 1 ? 'menu' : null,
    onclick: e => r.commands.length > 1 ? openRunMenu(r, e.currentTarget) : askStart(r, r.commands[0]) },
    icon(0xE768), 'Run local copy', r.commands.length > 1 ? icon(0xE70D) : null);
}

function renderStopAll() {
  const run = rows.filter(r => r.running).length, other = new Set(rows.filter(r => !r.running && r.portInUse).map(r => r.portInUse)).size;
  $('cmd-stopall').hidden = !run && !other;
  $('stopall-label').textContent = 'Stop all (' + (run + other) + ')';
}

// ---- Stop all / stop a port someone else holds ----
const ownerLine = o => h('div', { class: 'check' }, h('span', { class: 'sev' }, ':' + o.port),
  h('span', { class: 'what' }, (o.name || 'unknown program') + ' (process ' + o.pid + ')' + (o.projects && o.projects.length ? ' · ' + o.projects.join(', ') : ''),
    h('span', { class: 'where' }, o.cmd || ''), o.why ? h('span', { class: 'where a-bad' }, 'Will not be stopped: ' + o.why + '.') : null));
const OTHER_WARN = 'These were not started by the Bridge: another app, a window you opened, or a preview another AI session is using. Stopping one ends that program (and anything it started).';

async function stopAllDialog() {
  const mine = rows.filter(r => r.running);
  dialog('Stop all', [h('p', { class: 'muted' }, 'Looking up what holds your projects\' ports…')], []);
  let owners = [];
  try { owners = (await api('/api/port-owners', {})).owners; } catch (e) { return dialog('Stop all', [h('p', null, e.message)], [cancelBtn('Close')]); }
  const stoppable = owners.filter(o => !o.why);
  const tick = h('input', { type: 'checkbox', id: 'stop-others' });
  dialog('Stop all', [
    mine.length ? h('p', null, 'Stops what the Bridge started: ', h('b', null, mine.map(r => r.name + ' (:' + r.running.port + ')').join(', ')), '.')
                : h('p', { class: 'muted' }, 'The Bridge is not running anything itself.'),
    owners.length ? h('div', null,
      stoppable.length ? h('label', { style: 'display:flex;gap:8px;align-items:flex-start;margin:8px 0' }, tick, h('span', null, 'Also stop ' + stoppable.length + ' other program' + (stoppable.length === 1 ? '' : 's') + ' holding project ports')) : null,
      h('p', { class: 'muted', style: 'font-size:13px' }, OTHER_WARN),
      ...owners.map(ownerLine)) : h('p', { class: 'muted' }, 'No other program is holding a project port.')],
    [h('button', { class: 'btn accent', type: 'button', disabled: !mine.length && !stoppable.length, onclick: async () => {
      try {
        const r = await api('/api/stop-all', { others: tick.checked, listed: tick.checked ? stoppable.map(o => ({ port: o.port, pid: o.pid })) : [] });
        const bad = r.others.filter(x => !x.ok), dry = r.others.filter(x => x.dryRun);
        closeDialog();
        const parts = [];
        if (r.stopped.length) parts.push('Stopped ' + r.stopped.join(', ') + '.');
        const ok = r.others.filter(x => x.ok && !x.dryRun);
        if (ok.length) parts.push('Stopped ' + ok.map(x => x.name + ' (:' + x.port + ')').join(', ') + '.');
        if (dry.length) parts.push('Test copy, not stopped: ' + dry.map(x => x.dryRun).join('; ') + '.');
        if (bad.length) parts.push(bad.map(x => x.error).join(' '));
        info(parts.join(' ') || 'Nothing was running.', bad.length > 0);
      } catch (e) { info(e.message, true); }
      load();
    } }, 'Stop'), cancelBtn()]);
}

// The click is the decision: no question first. The Bridge looks the holder up again and stops it; Windows' own
// programs and the Bridge's window are still refused, and the message says why.
async function stopPort(port, onStopping) {
  info('Stopping what holds port ' + port + '…');
  const job = api('/api/stop-port', { port });
  if (onStopping) onStopping(job.then(r => !!r.ok && !r.dryRun, () => false));
  try { const r = await job; info(r.dryRun ? 'Test copy, not stopped: ' + r.dryRun : r.free ? 'Port ' + port + ' is already free.' : r.ok ? 'Stopped ' + r.name + ' (port ' + port + ' is free).' : r.error, !r.ok); }
  catch (e) { info(e.message, true); }
  if (!onStopping) await load();
}

function renderList() {
  const q = $('search').value.trim().toLowerCase();
  renderHiddenToggle();
  renderStopAll();
  const visible = rows.filter(r => showHidden || !r.hiddenView);
  const list = sorted(visible.filter(r => !q || (r.name + ' ' + r.description + ' ' + r.folder).toLowerCase().includes(q)));
  const L = $('list');
  L.className = 'list' + (view === 'tiles' ? ' tiles' : '');
  $('list-head').hidden = view === 'tiles';
  if (!loaded) return L.replaceChildren(h('div', { class: 'empty' }, 'Loading projects…'));
  if (!rows.length) {
    return L.replaceChildren(h('div', { class: 'empty' }, 'No projects yet. ',
      h('button', { class: 'btn accent', type: 'button', onclick: () => addFolderDialog() }, 'Add a working folder'), ' ',
      h('button', { class: 'btn', type: 'button', onclick: () => addProjectDialog() }, 'Add one project')));
  }
  if (!list.length) {
    const hiddenN = rows.length - visible.length;
    return L.replaceChildren(h('div', { class: 'empty' }, q ? 'No project matches "' + q + '".' : 'Every project is hidden. ',
      !q && hiddenN ? h('button', { class: 'btn', type: 'button', onclick: toggleHidden }, 'Show hidden (' + hiddenN + ')') : null));
  }
  const canDrag = $('sort').value === 'mine' && !q;
  L.replaceChildren(...list.map(r => {
    const a = auditLabel(r.audit);
    const row = h('div', { class: 'row' + (r.hiddenView ? ' dim' : ''), 'data-id': r.id, draggable: canDrag ? 'true' : null },
      h('div', { style: 'min-width:0' },
        h('div', { class: 'title' },
          canDrag ? h('span', { class: 'grip', title: 'Drag to move', 'aria-hidden': 'true' }, icon(0xE76F)) : null,
          h('span', { class: 'nm' }, r.name),
          r.isNew ? h('span', { class: 'badge b-new' }, 'New') : null,
          r.hiddenView ? h('span', { class: 'badge b-off' }, 'Hidden') : null,
          a ? h('button', { class: 'audit-link ' + a.cls, type: 'button', title: 'Last audit ' + a.when, onclick: () => showLastAudit(r) }, a.text) : null,
          liveChip(r), gitChip(r), nodeChip(r)),
        h('div', { class: 'desc', title: r.description + '\n' + r.dir }, r.description || r.dir)),
      h('div', { class: 'facts' },
        h('div', { class: 'num', title: 'This month: ' + fmtTok(r.tokensMonth) }, tokensCounting() ? 'counting…' : [h('b', null, fmtTok(r.tokens)), view === 'tiles' ? 'tokens' : (r.tokensMonth ? fmtTok(r.tokensMonth) + ' this month' : '')]),
        h('div', { class: 'num upd', title: 'Updated ' + fmtWhen(r.updated) }, view === 'tiles' ? 'Updated ' : null, whenParts(r.updated)),
        h('div', null, stateBadge(r))),
      h('div', { class: 'acts' },
        h('button', { class: 'btn accent', type: 'button', title: 'Copies the project name and full folder, to paste into the AI of your choice', onclick: () => copyPrompt(r) }, icon(0xE8C8), 'Copy prompt'),
        runButton(r),
        h('button', { class: 'btn icon', type: 'button', 'aria-label': 'More for ' + r.name, 'aria-haspopup': 'menu', onclick: e => openMenu(r, e.currentTarget) }, icon(0xE712))));
    if (canDrag) wireDrag(row);
    return row;
  }));
}

// ---- Copy prompt: the project name and full folder, for the AI of the person's choice. Opens nothing. ----
// A name comes from a project.json that may sit in a downloaded folder; flatten it to one line and drop control and
// bidi characters, so what is pasted into an AI cannot carry hidden extra lines that read as separate instructions.
const oneLine = s => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
function promptFor(r) { return 'Project: ' + oneLine(r.name).slice(0, 100) + '\nFull folder: ' + r.dir; }
async function copyPrompt(r) {
  const text = promptFor(r);
  try { await navigator.clipboard.writeText(text); info('Prompt copied for ' + r.name + '. Paste it into Claude, ChatGPT or the AI you use.'); }
  catch {
    const ta = h('textarea', { readonly: true, rows: '3', style: 'width:100%;font:inherit;padding:8px;border:1px solid var(--line2);border-radius:4px;background:var(--card);color:var(--ink)' }, text);
    dialog('Copy this prompt', [h('p', { class: 'muted' }, 'The clipboard was blocked, so copy it from here (Ctrl+C):'), ta], [h('button', { class: 'btn accent', type: 'button', onclick: closeDialog }, 'Done')]);
    ta.focus(); ta.select();
  }
}

// ---- My order: move with the menu or by dragging (only while sorted by "My order") ----
async function saveOrder(ids) {
  try { await api('/api/projects/order', { ids }); await load(); } catch (e) { info(e.message, true); }
}
function move(r, where) {
  const ids = myOrder(rows).map(x => x.id);
  const i = ids.indexOf(r.id);
  ids.splice(i, 1);
  const j = where === 'top' ? 0 : where === 'bottom' ? ids.length : where === 'up' ? Math.max(0, i - 1) : Math.min(ids.length, i + 1);
  ids.splice(j, 0, r.id);
  if ($('sort').value !== 'mine') { $('sort').value = 'mine'; pref.set('sort', 'mine'); info('Sorted by My order, so you can see where ' + r.name + ' went.'); }
  saveOrder(ids);
}
let dragId = null;
function wireDrag(row) {
  row.addEventListener('dragstart', e => { dragId = row.dataset.id; row.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
  row.addEventListener('dragend', () => { dragId = null; row.classList.remove('dragging'); document.querySelectorAll('.drop-before,.drop-after').forEach(x => x.classList.remove('drop-before', 'drop-after')); });
  row.addEventListener('dragover', e => {
    if (!dragId || dragId === row.dataset.id) return;
    e.preventDefault();
    const b = row.getBoundingClientRect();
    const after = view === 'tiles' ? e.clientX > b.left + b.width / 2 : e.clientY > b.top + b.height / 2;
    row.classList.toggle('drop-after', after); row.classList.toggle('drop-before', !after);
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
  row.addEventListener('drop', e => {
    e.preventDefault();
    if (!dragId || dragId === row.dataset.id) return;
    const after = row.classList.contains('drop-after');
    const ids = myOrder(rows).map(x => x.id).filter(id => id !== dragId);
    ids.splice(ids.indexOf(row.dataset.id) + (after ? 1 : 0), 0, dragId);
    saveOrder(ids);
  });
}

async function setHidden(r, hidden) {
  try {
    await api('/api/projects/hide', { id: r.id, hidden });
    info(hidden ? r.name + ' is hidden. Find it again with "Show hidden" on the bar.' : r.name + ' is shown again.');
    await load();
  } catch (e) { info(e.message, true); }
}
function toggleHidden() { showHidden = !showHidden; pref.set('showHidden', showHidden ? '1' : '0'); renderList(); }

// ---- flyouts: the "..." menu and the Run local copy choice ----
let menuFor = null;
function placeMenu(items, anchor) {
  const m = $('menu');
  m.replaceChildren(...items);
  m.hidden = false;
  const b = anchor.getBoundingClientRect(), mw = m.offsetWidth, mh = m.offsetHeight;
  m.style.left = Math.max(8, Math.min(b.right - mw, innerWidth - mw - 8)) + 'px';
  m.style.top = (b.bottom + 4 + mh > innerHeight - 8 ? Math.max(8, b.top - mh - 4) : b.bottom + 4) + 'px';
  const first = m.querySelector('button'); if (first) first.focus();
}
const menuItem = (cp, label, small, fn, cls) => h('button', { type: 'button', role: 'menuitem', class: cls, onclick: () => { closeMenu(); fn(); } }, icon(cp), label, small ? h('small', null, small) : null);
function openRunMenu(r, anchor) {
  if (menuFor === 'run:' + r.id && !$('menu').hidden) return closeMenu();
  menuFor = 'run:' + r.id;
  placeMenu([h('div', { class: 'note' }, r.name + ' has more than one start command:'),
    ...r.commands.map(c => menuItem(0xE768, c.name, c.ports ? ':' + c.ports.join(' / ') : c.port ? ':' + c.port : '', () => askStart(r, c)))], anchor);
}
function openMenu(r, anchor) {
  if (menuFor === r.id && !$('menu').hidden) return closeMenu();
  menuFor = r.id;
  const items = [];
  if (!r.running && r.portInUse) items.push(menuItem(0xE774, 'Open in browser', 'localhost:' + r.portInUse, () => act('open-browser', r)),
    menuItem(0xE71A, 'Stop what holds port ' + r.portInUse, 'another program', () => stopPort(r.portInUse)), h('hr'));
  if (inTomlin()) items.push(menuItem(0xE768, 'Start with a hire…', 'its prompt, in TOMLIN', () => startWithHire(promptFor(r), r.name)), h('hr'));
  items.push(menuItem(0xEA18, 'Scan app (audit)', scanParts(r), () => scan(r)));
  if (r.audit) items.push(menuItem(0xE81C, 'Last audit', auditLabel(r.audit).when, () => showLastAudit(r)));
  items.push(menuItem(0xE909, 'Hosted live…', r.liveUrl ? hostOf(r.liveUrl) : 'add the address', () => liveDialog(r)));
  items.push(h('hr'));
  items.push(menuItem(0xE838, 'Open folder', r.folder, () => act('open-folder', r)));
  items.push(menuItem(0xE756, 'Open terminal here', null, () => act('open-terminal', r)));
  items.push(h('hr'));
  items.push(menuItem(0xE74A, 'Move to top', null, () => move(r, 'top')));
  items.push(menuItem(0xE70E, 'Move up', null, () => move(r, 'up')));
  items.push(menuItem(0xE70D, 'Move down', null, () => move(r, 'down')));
  items.push(menuItem(0xE74B, 'Move to bottom', null, () => move(r, 'bottom')));
  items.push(h('hr'));
  items.push(r.hiddenView ? menuItem(0xE7B3, 'Unhide', 'show in the list again', () => setHidden(r, false))
                          : menuItem(0xED1A, 'Hide from display', 'find it with Show hidden', () => setHidden(r, true)));
  items.push(menuItem(0xE738, 'Remove from list…', null, () => removeProjectDialog(r), 'danger'));
  placeMenu(items, anchor);
}
function closeMenu() { $('menu').hidden = true; menuFor = null; }
document.addEventListener('click', e => { if (!$('menu').hidden && !e.target.closest('#menu') && !e.target.closest('[aria-haspopup="menu"]')) closeMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
$('menu').addEventListener('keydown', e => {
  const items = [...$('menu').querySelectorAll('button')], i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
});
document.querySelector('main').addEventListener('scroll', closeMenu);
