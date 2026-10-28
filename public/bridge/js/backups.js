// The Backups page (the engine is src/bridge/backup.js): the backup drives (Turn on backups, Add another drive, Open,
// Forget), every project with its Backup tick and the state of its backups, Run backups now (a window listing each
// ticked project with its size, the time it should take and the drive's free space, then the run itself), one
// project's backups, and what goes in a backup (Keep, Full backup).
'use strict';

let backupView = null;
// The backup routes answer { ok: false, fault, reason, wayOut } for a refusal: thrown here as one message.
async function bk(path, body) {
  const r = await api(path, body);
  if (r && r.ok === false) throw new Error(r.error || [r.fault, r.reason, r.wayOut].filter(Boolean).join(' '));
  return r;
}
const bkPlural = (n, one, many) => n.toLocaleString() + ' ' + (n === 1 ? one : many);
const bkSize = n => (n >= 1e12 ? (n / 1e12).toFixed(1) + ' TB' : n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? Math.round(n / 1e6) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB');
const bkDur = s => (s == null ? '' : s < 60 ? 'under a minute' : s < 3600 ? 'about ' + Math.round(s / 60) + ' min' : 'about ' + Math.floor(s / 3600) + ' h ' + Math.round((s % 3600) / 60) + ' min');
function bkAgo(ms) {
  const s = Math.max(0, Date.now() - ms) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  const d = Math.round(s / 86400); return d + (d === 1 ? ' day' : ' days') + ' ago';
}
const bkWhen = ms => new Date(ms).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const driveKind = d => (d.network ? 'network folder' : d.removable ? 'USB / removable' : 'fixed drive');
const driveName = d => d.name + (d.label ? ' "' + d.label + '"' : '') + (d.letter ? ' (' + d.letter + ':)' : '');
const faultWords = f => [f.fault, f.reason, f.wayOut].filter(Boolean).join(' ');

/** What a project's backups say: running now, failed, changed since, backed up, or never. */
function backupMark(b) {
  if (!b) return null;
  if (b.busy) return { text: '◐ ' + (b.busy.state === 'waiting' ? 'Waiting' : (b.busy.state === 'checking' ? 'Checking ' : 'Backing up ') + b.busy.pct + '%'), cls: 'a-low' };
  if (b.fault) return { text: '✕ Backup failed', cls: 'a-bad' };
  if (b.last && b.changed) return { text: '▲ Changed since ' + bkAgo(b.last.at), cls: 'a-warn' };
  if (b.last) return { text: '● Backed up ' + bkAgo(b.last.at), cls: 'a-ok' };
  if (b.listed) return { text: '○ Never backed up', cls: 'a-low' };
  return null;
}

// The mark on a project's row (Projects page), shaped and coloured like the Live and Git marks beside it. Called a
// "zip backup" there, since the Git mark's "Backed up" means pushed. Only once there is something to say.
function backupChip(r) {
  const b = r.backup;
  if (!b) return null;
  const on = (mark, text, cls, say) => h('button', { class: 'live ' + cls, type: 'button', title: say, 'aria-label': 'Zip backup: ' + text, onclick: () => historyDialog(r.id) },
    h('span', { class: 'dot', 'aria-hidden': 'true' }, mark), text);
  if (b.busy) return on('◐', b.busy.state === 'waiting' ? 'Zip backup waiting' : 'Zipping ' + b.busy.pct + '%', 'l-none', 'A zip backup is running.');
  if (b.fault) return on('✕', 'Zip backup failed', 'l-down', faultWords(b.fault));
  if (b.last && b.changed) return on('▲', 'Changed since zip', 'l-unsure', 'Changed after its last zip backup, ' + bkAgo(b.last.at) + ' on ' + b.last.drive + '.');
  if (b.last) return on('●', 'Zipped ' + bkAgo(b.last.at), 'l-up', 'Last zip backup ' + bkWhen(b.last.at) + ' on ' + b.last.drive + ', read back and checked.');
  if (b.listed) return on('○', 'No zip backup yet', 'l-none', 'On the backup list, never backed up: Backups › Run backups now.');
  return null;
}

async function setListed(ids, on) {
  try { await bk('/api/backup/list', { ids, on }); } catch (e) { info(e.message, true); }
  await load();
}

// ---- the page ----
async function loadBackups() {
  try { backupView = await bk('/api/backup'); renderBackups(); } catch (e) { info(e.message, true); }
}
function renderBackups() {
  const v = backupView;
  if (!v) return;
  const listed = rows.filter(r => r.backup && r.backup.listed);
  $('bk-listed').textContent = listed.length ? bkPlural(listed.length, 'project', 'projects') + ' on the backup list' : 'Tick Backup on a project to put it on the list';
  $('cmd-backup-run').classList.toggle('accent', !!listed.length);

  // Drives
  const driveRow = d => h('div', { class: 'set-row' }, icon(d.network ? 0xE968 : d.removable ? 0xE88E : 0xEDA2),
    h('div', { class: 'txt' }, h('b', null, driveName(d)),
      h('span', null, d.here
        ? [driveKind(d), d.free != null ? bkSize(d.free) + ' free of ' + bkSize(d.total) : '', bkPlural(d.backups, 'backup', 'backups'), d.lastAt ? 'last ' + bkAgo(d.lastAt) : '', d.movedFrom ? 'now ' + d.letter + ':, was ' + d.movedFrom + ':' : ''].filter(Boolean).join(' · ')
        : 'Not plugged in · ' + bkPlural(d.backups, 'backup', 'backups') + ' on it' + (d.lastAt ? ', the last ' + bkAgo(d.lastAt) : '')),
      d.path ? h('span', null, d.path) : null),
    d.here ? h('button', { class: 'btn', type: 'button', onclick: async () => {
      try { const r = await bk('/api/backup/drive/open', { drive: d.id }); if (r.dryRun) info('Test copy, not opened: ' + r.dryRun); } catch (e) { info(e.message, true); }
    } }, 'Open') : null,
    h('button', { class: 'btn', type: 'button', onclick: () => forgetDriveDialog(d) }, 'Forget'));
  $('bk-drives').replaceChildren(...(v.drives.length ? v.drives.map(driveRow)
    : [h('div', { class: 'set-row' }, icon(0xE88E), h('div', { class: 'txt' }, h('b', null, 'Backups are not turned on yet'),
      h('span', null, 'Choose where they go. A USB drive is best, so a copy survives this PC.')),
    h('button', { class: 'btn accent', type: 'button', onclick: () => addDriveDialog() }, 'Turn on backups…'))]));
  $('cmd-backup-add').hidden = !v.drives.length;

  // Projects
  const projRow = r => {
    const m = backupMark(r.backup);
    return h('div', { class: 'set-row' },
      h('input', { type: 'checkbox', checked: !!(r.backup && r.backup.listed), 'aria-label': 'Back up ' + r.name, title: r.backup && r.backup.listed ? r.name + ' is on the backup list' : 'Put ' + r.name + ' on the backup list', onchange: e => setListed([r.id], e.target.checked) }),
      h('div', { class: 'txt' }, h('b', null, r.name), h('span', null, r.dir)),
      m ? h('button', { class: 'btn ' + m.cls, type: 'button', title: 'This project\'s backups', onclick: () => historyDialog(r.id) }, m.text) : null,
      h('button', { class: 'btn', type: 'button', onclick: () => openRun([r.id]) }, 'Back up now…'));
  };
  const shown = rows.filter(r => !r.hiddenView);
  $('bk-projects').replaceChildren(...(shown.length ? shown.map(projRow)
    : [h('div', { class: 'set-row' }, h('div', { class: 'txt' }, h('b', null, 'No projects yet'), h('span', null, 'Add a working folder on the Folders page.')))]));
  const ticked = shown.filter(r => r.backup && r.backup.listed).length;
  $('cmd-backup-all').hidden = !shown.length || ticked === shown.length;
  $('cmd-backup-none').hidden = !ticked;

  // What goes in
  $('bk-keep').value = String(v.keepLast || 0);
  $('bk-full').checked = !!v.full;
  $('bk-what').textContent = v.full ? 'Everything in the project\'s folder, with its git history and the rebuildable folders.'
    : 'Everything in the project\'s folder, with its git history. Left out: ' + v.leaveOut + '.';
  $('bk-where').textContent = 'On the drive: ' + v.folderName + '\\<project>\\<project>-<date>-<time>.zip, with a .txt beside each saying what is in it, and an index another PC reads when the drive is added there. To restore: right-click a zip › Extract All.';
}

$('cmd-backup-run').addEventListener('click', () => openRun());
$('cmd-backup-add').addEventListener('click', () => addDriveDialog());
$('cmd-backup-all').addEventListener('click', () => setListed(rows.filter(r => !r.hiddenView).map(r => r.id), true));
$('cmd-backup-none').addEventListener('click', () => setListed(rows.filter(r => !r.hiddenView && r.backup && r.backup.listed).map(r => r.id), false));
$('bk-keep').addEventListener('change', async e => {
  try {
    const r = await bk('/api/backup/keep', { keep: Number(e.target.value) });
    info(r.keepLast ? 'The last ' + r.keepLast + ' backups of each project are kept on each drive; older ones are deleted after a new one passes its check.' : 'Every backup is kept. Nothing is deleted.');
  } catch (err) { info(err.message, true); }
  loadBackups();
});
$('bk-full').addEventListener('change', async e => {
  try {
    const r = await bk('/api/backup/full', { on: e.target.checked });
    info(r.full ? 'Full backup is on: the rebuildable folders go in too, so backups are bigger and slower.' : 'Full backup is off: the rebuildable folders are left out again.');
  } catch (err) { info(err.message, true); e.target.checked = !e.target.checked; }
  loadBackups();
});

// ---- adding and forgetting a drive ----
// The folder window (purpose "backup") or a typed path; the reply says where backups go, or why not.
function addDriveDialog(then) {
  folderDialog({ title: 'Choose where backups go', purpose: 'backup', okLabel: 'Use this folder', placeholder: 'E:\\ or E:\\Backups',
    lead: 'A USB drive is best, so a copy survives this PC. Another drive or a network share works too. The backups go in a "TOMLIN Backups" folder inside it.',
    submit: async p => {
      const r = await bk('/api/backup/drive/add', { path: p });
      if (r.cancelled) return;
      if (r.dryRun) return { error: 'Test copy: ' + r.dryRun };
      const d = r.drive;
      closeDialog();
      info(['Backups go to ' + d.path + ' (' + d.name + (d.free != null ? ', ' + bkSize(d.free) + ' free' : '') + ').',
        r.already ? d.name + ' was already added.' : '', r.imported ? 'It already holds ' + bkPlural(r.imported, 'backup', 'backups') + ', now counted here too.' : '', ...(r.warnings || [])].filter(Boolean).join(' '));
      await load(); await loadBackups();
      if (then) then();
    } });
}
function forgetDriveDialog(d) {
  dialog('Forget ' + d.name + '?', [
    h('p', null, 'TOMLIN stops using it. Its backups stay on the drive, and adding it again brings them back.')],
    [h('button', { class: 'btn accent', type: 'button', onclick: async () => {
      try { await bk('/api/backup/drive/forget', { drive: d.id }); closeDialog(); info(d.name + ' is forgotten. Its backups were not touched.'); await load(); loadBackups(); }
      catch (e) { info(e.message, true); }
    } }, 'Forget'), cancelBtn()]);
}

// ---- Run backups now ----
let run = null; // { ids, off: Set, drive, plan }
let runPoll = 0;
const runOpen = () => $('dlg').open && $('dlg').dataset.kind === 'backup';
function runDialog(title, kids, buttons) { dialog(title, kids, buttons, 'wide'); $('dlg').dataset.kind = 'backup'; }
$('dlg').addEventListener('close', () => { delete $('dlg').dataset.kind; clearTimeout(runPoll); });

async function openRun(ids) {
  clearTimeout(runPoll);
  // A run under way: its progress, whatever was asked.
  let st = null;
  try { st = (await bk('/api/backup/status')).job; } catch { /* drawn as not running */ }
  if (st && !st.finished) return drawJob(st);
  const list = ids || rows.filter(r => r.backup && r.backup.listed).map(r => r.id);
  run = { ids: list, off: new Set(), drive: (run && run.drive) || null, plan: null };
  // No backup drive yet: say so at once, before sizing every project (that takes a while for a long list).
  try { if (list.length && !(await bk('/api/backup')).drives.length) { run.plan = { drives: [] }; return drawPlan(); } } catch { /* the plan says why */ }
  if (!list.length) {
    return runDialog('Run backups now', [h('p', null, 'No project is on the backup list yet.'),
      h('p', { class: 'muted' }, 'Tick each project you want backed up on the Backups page (or Tick all), then come back here. The list is kept.')],
    [h('button', { class: 'btn accent', type: 'button', onclick: closeDialog }, 'Close')]);
  }
  await planAndDraw();
}
async function planAndDraw(note = '') {
  runDialog('Run backups now', [h('p', { class: 'muted' }, 'Working out the size of ' + bkPlural(run.ids.length, 'project', 'projects') + '…')], [cancelBtn('Close')]);
  try { run.plan = await bk('/api/backup/plan', { ids: run.ids, drive: run.drive }); }
  catch (e) { return runDialog('Run backups now', [h('p', { class: 'err' }, e.message)], [cancelBtn('Close')]); }
  if (run.plan.drive) run.drive = run.plan.drive.id;
  drawPlan(note);
}
function drawPlan(note = '') {
  const pl = run.plan;
  const said = h('p', { class: 'muted', role: 'status' }, note);
  // No drive yet: one click to choose where.
  if (!pl.drives.length) {
    return runDialog('Run backups now', [
      h('p', null, 'Backups are not turned on yet: choose where they go first. A USB drive is best, so a copy survives this PC.'), said],
    [h('button', { class: 'btn accent', type: 'button', onclick: () => addDriveDialog(() => openRun(run.ids)) }, 'Choose where backups go…'), cancelBtn('Close')]);
  }
  const here = pl.drives.filter(d => d.here);
  let driveLine;
  if (pl.choose || (run.drive && !pl.drive)) {
    const pick = h('select', { class: 'sel', 'aria-label': 'Backup drive', onchange: e => { run.drive = e.target.value || null; planAndDraw(); } },
      h('option', { value: '' }, 'Choose a drive…'), ...here.map(d => h('option', { value: d.id }, driveName(d) + ' · ' + bkSize(d.free || 0) + ' free')));
    driveLine = h('p', null, h('b', null, here.length + ' backup drives are plugged in: back up to '), pick);
  } else if (!pl.drive || !pl.drive.here) {
    driveLine = h('div', null, h('p', { class: 'a-warn' }, '▲ No backup drive is plugged in. ' + pl.drives.map(driveName).join(', ') + (pl.drives.length > 1 ? ' are' : ' is') + ' not found on this PC now.'),
      h('p', { class: 'muted' }, 'Plug one in and press Look again, or add another drive on the Backups page.'));
  } else {
    const d = pl.drive;
    driveLine = h('p', null, h('b', null, 'To ' + driveName(d)), ' · ' + driveKind(d) + ' · ' + bkSize(d.free || 0) + ' free' + (d.movedFrom ? ' · found under ' + d.letter + ': (it was ' + d.movedFrom + ': before)' : ''),
      here.length > 1 ? h('button', { class: 'btn', type: 'button', style: 'margin-left:8px', onclick: () => { run.drive = null; run.plan.choose = true; drawPlan(); } }, 'Change drive') : null);
  }
  const on = r => !r.error && !run.off.has(r.id);
  const list = h('div', { class: 'card' }, ...pl.rows.map(r => h('div', { class: 'set-row' },
    h('input', { type: 'checkbox', checked: on(r), disabled: !!r.error, 'aria-label': 'Back up ' + r.name, onchange: e => { if (e.target.checked) run.off.delete(r.id); else run.off.add(r.id); drawPlan(); } }),
    h('div', { class: 'txt' }, h('b', null, r.name),
      h('span', { class: r.error ? 'a-bad' : '' }, r.error ? '✕ ' + r.error
        : bkPlural(r.files, 'file', 'files') + ' · ' + bkSize(r.bytes) + (r.sure ? ', zip about ' + bkSize(r.zip) : '') + (Object.keys(r.leftOut || {}).length ? ' · leaves out ' + Object.keys(r.leftOut).join(', ') : '')),
      h('span', null, [r.secs != null ? bkDur(r.secs) : '', r.last ? 'last ' + bkAgo(r.last.at) + ' on ' + r.last.drive : 'never backed up'].filter(Boolean).join(' · '))))));
  const picked = pl.rows.filter(on);
  const tot = { bytes: picked.reduce((s, r) => s + r.bytes, 0), zip: picked.reduce((s, r) => s + r.zip, 0), secs: picked.reduce((s, r) => s + (r.secs || 0), 0) };
  const d = pl.drive && pl.drive.here ? pl.drive : null;
  const left = d && d.free != null ? d.free - tot.zip : null;
  const fits = left == null ? null : left >= 256e6;
  const sum = !picked.length ? h('p', { class: 'muted' }, 'Nothing ticked.') : h('div', null,
    h('p', null, h('b', null, bkPlural(picked.length, 'project', 'projects') + ' · ' + bkSize(tot.bytes) + (d ? ' · ' + bkDur(tot.secs) : '')),
      d && pl.firstGuess ? h('span', { class: 'muted' }, ' (a first guess: the time is learnt from this drive\'s first backup)') : null),
    d ? h('p', { class: fits ? 'muted' : 'a-bad' }, fits
      ? 'Needs up to ' + bkSize(tot.zip) + '; ' + d.name + ' has ' + bkSize(d.free) + ' free, so about ' + bkSize(left) + ' is left after.'
      : '✕ It will not fit: it needs up to ' + bkSize(tot.zip) + ', and ' + d.name + ' has ' + bkSize(d.free) + ' free. Nothing is ever deleted to make room: untick some projects, or plug in another drive and add it on the Backups page.') : null);
  const start = h('button', { class: 'btn accent', type: 'button', disabled: !(d && fits && picked.length), title: 'Each project is zipped, then read back and checked, one at a time. TOMLIN keeps working meanwhile.', onclick: async e => {
    const b = e.currentTarget;
    b.disabled = true; b.textContent = 'Starting…'; // the drive is looked for again first (a few seconds)
    try { const r = await bk('/api/backup/start', { ids: picked.map(r => r.id), drive: run.drive }); drawJob(r.job); load(); }
    catch (err) { said.textContent = err.message; b.disabled = false; b.textContent = 'Start'; }
  } }, 'Start');
  runDialog('Run backups now', [driveLine, said, list, sum,
    h('p', { class: 'muted' }, pl.full ? 'Full backup: the rebuildable folders (node_modules and the like) go in too.' : 'Rebuildable folders (node_modules and the like) are left out. Full backup on the Backups page takes them too.'),
    h('p', { class: 'muted' }, 'Each zip is read back and every file checked before it counts. Backups are only added: nothing on the drive is deleted.')],
  [start, h('button', { class: 'btn', type: 'button', onclick: () => planAndDraw() }, 'Look again'), cancelBtn('Close')]);
}

const JOB_STATE = { waiting: ['○', 'Waiting', 'a-low'], zipping: ['◐', 'Zipping', 'a-low'], checking: ['◑', 'Checking', 'a-low'], done: ['✓', 'Checked', 'a-ok'], failed: ['✕', 'Failed', 'a-bad'], skipped: ['–', 'Not done', 'a-warn'], cancelled: ['–', 'Cancelled', 'a-low'] };
function drawJob(j) {
  clearTimeout(runPoll);
  if (!j) return;
  const busy = !j.finished;
  const list = h('div', { class: 'card' }, ...j.items.map(i => {
    const [mark, word, cls] = JOB_STATE[i.state] || ['?', i.state, 'a-low'];
    const detail = i.state === 'done' ? [bkSize(i.bytes), bkPlural(i.files, 'file', 'files'), i.secs != null ? i.secs + ' s' : ''].filter(Boolean).join(' · ')
      : ['zipping', 'checking'].includes(i.state) ? i.pct + '%' : i.state === 'waiting' && i.est != null ? bkDur(i.est) : i.note || '';
    return h('div', { class: 'set-row' }, h('div', { class: 'txt' }, h('b', null, i.name),
      h('span', { class: cls }, mark + ' ' + word + (detail ? ' · ' + detail : '')),
      ['zipping', 'checking'].includes(i.state) ? h('progress', { max: '100', value: String(i.pct), style: 'width:100%', 'aria-label': i.name + ' ' + i.pct + '%' }) : null,
      i.state === 'done' && i.note ? h('span', null, i.note) : null,
      i.fault ? h('span', null, faultWords(i.fault)) : null));
  }));
  const done = j.items.filter(i => i.state === 'done').length;
  const head = busy ? h('p', null, h('b', null, 'Backing up to ' + j.drive + '…'), h('span', { class: 'muted' }, ' You can close this window: the backup goes on, and its progress shows on each project.'))
    : h('p', null, h('b', null, done + ' of ' + j.items.length + ' backed up and checked on ' + j.drive + '.'),
      done && j.removable ? h('span', { class: 'muted' }, ' Safe to unplug the drive once Windows says so (the eject icon by the clock).') : null);
  runDialog('Run backups now', [head, list],
    busy ? [h('button', { class: 'btn', type: 'button', title: 'Stops after the file being written: the unfinished zip is removed', onclick: async e => {
      e.currentTarget.disabled = true; try { await bk('/api/backup/cancel', {}); } catch (err) { info(err.message, true); }
    } }, 'Cancel backup'), h('button', { class: 'btn accent', type: 'button', onclick: closeDialog }, 'Close')]
      : [h('button', { class: 'btn', type: 'button', onclick: () => openRun(j.items.map(i => i.id)) }, 'Back up again…'), h('button', { class: 'btn accent', type: 'button', onclick: closeDialog }, 'Close')]);
  if (busy) runPoll = setTimeout(async () => {
    if (!runOpen()) return;
    try { drawJob((await bk('/api/backup/status')).job); } catch { /* TOMLIN is restarting */ }
  }, 700);
  else { load(); if (!$('page-backups').hidden) loadBackups(); }
}

// ---- one project's backups ----
async function historyDialog(id) {
  let x;
  try { x = await api('/api/backup/history?id=' + encodeURIComponent(id)); } catch (e) { return info(e.message, true); }
  const b = x.backup;
  dialog('Backups · ' + x.name, [
    b.fault ? h('p', { class: 'a-bad' }, '✕ The last try failed: ' + faultWords(b.fault)) : null,
    b.changed ? h('p', { class: 'a-warn' }, '▲ ' + x.name + ' changed after its last backup (' + bkAgo(b.last.at) + ').') : null,
    x.history.length ? h('div', { class: 'card' }, ...x.history.map(e => h('div', { class: 'set-row' },
      h('div', { class: 'txt' }, h('b', null, bkWhen(e.at)), h('span', null, e.driveName + ' · ' + e.file)),
      h('span', { class: e.checked ? 'a-ok' : 'a-warn' }, (e.checked ? '✓ checked' : 'not checked') + ' · ' + bkSize(e.bytes) + ' · ' + bkPlural(e.files, 'file', 'files')))))
      : h('p', { class: 'muted' }, 'No backup yet.'),
    h('label', { style: 'display:flex;gap:8px;align-items:center;margin-top:12px' },
      h('input', { type: 'checkbox', checked: !!b.listed, onchange: e => setListed([id], e.target.checked) }),
      h('span', null, 'On the backup list (Run backups now takes ' + x.name + ')'))],
  [h('button', { class: 'btn accent', type: 'button', onclick: () => openRun([id]) }, 'Back up now…'), cancelBtn('Close')], 'wide');
}
