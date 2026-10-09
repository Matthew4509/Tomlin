// Copies on my other PCs: TOMLIN's node backups for a project from this list (src/jobrun/copies.ts). A row's
// mark beside its git mark, and a part of the project's git window to tick it on, back up now or bring it back.
// Only inside TOMLIN (stats.nodes is null in the tests' stand-alone copy).
'use strict';

const fmtSize = b => b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : b >= 1048576 ? Math.round(b / 1048576) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';

// The row's "Local backup" mark (shape + colour, like Git and Live): off, not yet, on with its last date, or out of
// date. Pressed: its git window; when it is on, the backup starts at once there (its progress shows in the window).
function nodeLabel(n) {
  if (!n) return null;
  if (!n.on) return { mark: '○', text: 'Local backup: off', cls: 'l-none', say: 'No copy on your other PCs. Press to open its window, then tick "Copy this project to my other PCs".' };
  if (!n.at) return { mark: '○', text: 'Local backup: not yet', cls: 'l-none', say: 'Ticked to copy to your other PCs, but no copy has been made yet. Press to back it up now.' };
  if (n.current) return { mark: '●', text: 'Local backup: on · ' + fmtWhen(n.at), cls: 'l-up', say: 'A copy of everything in it is on ' + n.pcName + ' (' + fmtWhen(n.at) + '). Press to back it up again.' };
  return { mark: '▲', text: 'Local backup: out of date', cls: 'l-unsure', say: 'It changed after its last copy on ' + n.pcName + ' (' + fmtWhen(n.at) + '). Press to back it up now.' };
}
function nodeChip(r) {
  const l = nodeLabel(r.node);
  if (!l) return null;
  return h('button', { class: 'live ' + l.cls, type: 'button', title: l.say, 'aria-label': l.text + '. ' + l.say, onclick: () => gitDialog(r, { backupNow: !!r.node.on }) },
    h('span', { class: 'dot', 'aria-hidden': 'true' }, l.mark), l.text);
}

// Safe = a copy away from this PC that holds everything: pushed with nothing unsaved, or an up-to-date node copy.
const pushedAll = g => !!g && g.state === 'ok' && !g.changes;
const nodeCurrent = n => !!n && n.on && !!n.at && n.current;
const isSafe = r => pushedAll(r.git) || nodeCurrent(r.node);

// The part of a project's git window about its copies on other PCs: filled in when it answers. Everything it says
// is said inside the window (the message bar sits behind an open window, so a word there is never seen).
function nodeSection(r, opts = {}) {
  if (!stats || !stats.nodes) return null;
  const box = h('div', { class: 'node-part' }, h('p', { class: 'muted' }, 'Reading the copies on your other PCs…'));
  fillNodeSection(r, box, null, opts).catch(e => box.replaceChildren(h('p', { class: 'err' }, e.message)));
  return box;
}
// A PC by name and address: two PCs can have the same name ("Worker PC").
const pcLabel = (name, where) => where ? name + ' (' + where + ')' : name;
// What else tells it apart: its RAM, graphics card, and its backup disk with the room left ("" when it said none).
const diskSize = b => b >= 2 ** 40 ? (b / 2 ** 40).toFixed(1) + ' TB' : b >= 10 * 2 ** 30 ? Math.round(b / 2 ** 30) + ' GB' : fmtSize(b);
function pcSpecs(pc) {
  const bits = [];
  if (pc.ram) bits.push(Math.round(pc.ram / 2 ** 30) + ' GB RAM');
  if (pc.gpu) bits.push(pc.gpu + (pc.vram ? ' ' + Math.round(pc.vram / 2 ** 30) + ' GB' : ''));
  bits.push(pc.disk ? 'disk ' + diskSize(pc.disk.total) + ', ' + diskSize(pc.disk.free) + ' free' : 'free space not reported (update TOMLIN there)');
  return bits.join(' · ');
}
// The PCs unticked under "Back up to", kept while the same project's window is open.
let nodePick = null;
async function fillNodeSection(r, box, said, opts = {}) {
  const v = await api('/api/node-backup?id=' + encodeURIComponent(r.id));
  if (!v.ok) return box.replaceChildren(h('p', { class: 'err' }, v.error));
  const p = v.project, pcs = v.pcs || [];
  if (!nodePick || nodePick.id !== r.id) nodePick = { id: r.id, off: new Set() };
  const status = h('div', { class: 'node-status', role: 'status', 'aria-live': 'polite' });
  const say = (lines, err) => status.replaceChildren(...[].concat(lines).map(t => h('p', { class: err ? 'err' : '' }, t)));
  if (said) say(said);
  const parts = [h('h4', { class: 'split-head' }, 'Copies on my other PCs'),
    h('p', null, 'A copy away from this PC, besides git: TOMLIN sends it to each linked PC that keeps backups, every 10 minutes when something changed. Only what changed crosses your home network, and each PC keeps the older versions too.')];
  parts.push(h('label', { class: 'tick' }, h('input', { type: 'checkbox', checked: !!p, onchange: async e => {
    e.target.disabled = true;
    try {
      const x = await api('/api/node-backup/set', { id: r.id, on: e.target.checked });
      if (!x.ok) throw new Error(x.error);
      await fillNodeSection(r, box, e.target.checked ? 'Ticked: it goes with the next backup. Back up now sends it straight away.' : 'Unticked: no more copies are made. The copies already on your other PCs stay there.');
      load();
    } catch (er) { e.target.checked = !e.target.checked; e.target.disabled = false; say('The tick did not change: ' + er.message, true); }
  } }), ' Copy this project to my other PCs'));
  if (!pcs.length) parts.push(h('p', { class: 'warn-line' }, '▲ No other PC is linked yet. In TOMLIN, Link another PC, then tick "Enable backups" on that PC (Nodes and memory, Sharing permissions).'));
  if (!p) {
    for (const pc of pcs.filter(x => x.why)) parts.push(h('p', { class: 'muted node-why' }, '○ ' + pcLabel(pc.name, pc.where) + ': ' + pc.why + '.'));
    parts.push(status);
    box.replaceChildren(...parts);
    // Opened from "Local backup: off": the tick is the next step.
    if (opts.backupNow === false) box.querySelector('.tick input')?.focus();
    return;
  }
  parts.push(h('p', null, 'Each copy takes ' + plural(p.files, 'file', 'files') + ', ' + fmtSize(p.bytes) + ': ' + (p.how === 'git' ? 'what git keeps (saved files and new ones its .gitignore does not leave out, so no node_modules, builds or models listed there).' : 'the whole folder except .git and node_modules' + (p.note ? ' (' + p.note + ')' : '') + '.')));
  if (p.left.length) parts.push(h('p', { class: 'warn-line' }, '▲ Left out for their size (over 256 MB): ' + p.left.slice(0, 5).map(f => f.path + ' (' + fmtSize(f.bytes) + ')').join(', ') + (p.left.length > 5 ? ', and ' + (p.left.length - 5) + ' more' : '') + '.'));

  parts.push(h('p', { class: 'node-sub' }, h('b', null, 'Copies now')));
  if (!p.copies.length) parts.push(h('p', { class: 'muted' }, 'No copy yet.'));
  for (const c of p.copies) {
    const back = h('button', { class: 'btn', type: 'button', onclick: async () => {
      back.disabled = true;
      try {
        const x = await api('/api/node-backup/back', { id: r.id, pc: c.pc });
        if (!x.ok) throw new Error(x.error);
        say('Bringing ' + r.name + ' back from ' + pcLabel(c.pcName, c.where) + ' into a new folder in ' + x.to + '. Nothing in the project is replaced: copy what you need from there. TOMLIN shows the progress under My local LLMs.');
      } catch (e) { say('It was not brought back: ' + e.message, true); }
      back.disabled = false;
    } }, icon(0xE777), 'Bring back');
    parts.push(h('div', { class: 'git-fact node-copy' }, h('span', { class: c.current ? 'l-up' : 'l-unsure' }, (c.current ? '● ' : '▲ ') + pcLabel(c.pcName, c.where)),
      h('span', null, fmtWhen(c.at) + (c.current ? ', up to date' : ', changed since')), back));
  }

  // Back up to: each linked PC, ticked unless unticked here; one that cannot take a backup says why and stays off.
  const picks = pcs.map(pc => {
    const tickPc = h('input', { type: 'checkbox', checked: !pc.why && !nodePick.off.has(pc.id), disabled: !!pc.why, onchange: e => {
      if (e.target.checked) nodePick.off.delete(pc.id); else nodePick.off.add(pc.id);
    } });
    return { pc, tickPc, row: h('div', { class: 'node-pick' }, h('label', { class: 'tick' }, tickPc, ' ' + pcLabel(pc.name, pc.where),
      pc.backupsOnly ? h('span', { class: 'node-tag' }, 'Backups only') : null),
      pcSpecs(pc) ? h('p', { class: 'muted node-specs' }, pcSpecs(pc)) : null,
      pc.why ? h('p', { class: 'muted node-why' }, '○ It cannot take a backup now: ' + pc.why + '.') : null) };
  });
  const chosen = () => picks.filter(x => !x.pc.why && x.tickPc.checked).map(x => x.pc);
  if (pcs.length) parts.push(h('p', { class: 'node-sub' }, h('b', null, 'Back up to')), ...picks.map(x => x.row));
  // Pressable even with no PC chosen (a greyed button says nothing): it then says why, here.
  const lock = on => { now.disabled = on; for (const x of picks) x.tickPc.disabled = on || !!x.pc.why; };
  const now = h('button', { class: 'btn accent', type: 'button', onclick: async () => {
    const to = chosen();
    if (!to.length) {
      return say(!pcs.length ? 'Nothing was backed up: no other PC is linked yet. In TOMLIN, Link another PC, then tick "Enable backups" on that PC.'
        : picks.some(x => !x.pc.why) ? 'Nothing was backed up: no PC is ticked under Back up to. Tick at least one, then press Back up now.'
        : 'Nothing was backed up: none of your linked PCs can take a backup now (the line under each says why).', true);
    }
    lock(true);
    now.replaceChildren(icon(0xE895), 'Backing up…');
    say('Backup in progress to ' + to.map(pc => pcLabel(pc.name, pc.where)).join(' and ') + ': your workspace and every ticked project. Starting…');
    try {
      const x = await api('/api/node-backup/now', { id: r.id, pcs: to.map(pc => pc.id) });
      if (!x.ok) throw new Error(x.error);
      const result = await followBackup(r, x.ids, pcs, say, box);
      if (result) await fillNodeSection(r, box, result);
    } catch (e) {
      say('The backup did not start: ' + e.message, true);
      now.replaceChildren(icon(0xE898), 'Back up now');
      lock(false);
    }
  } }, icon(0xE898), 'Back up now');
  parts.push(h('p', { class: 'node-now' }, now), status);
  box.replaceChildren(...parts);
  // Opened from the row's "Local backup" mark while it is on: the backup starts at once (as if Back up now was pressed).
  if (opts.backupNow) { now.focus(); now.click(); }
}

// Follows the copies Back up now started, once a second, saying each PC's state in the window until all are done.
// Returns the words to keep showing after the list is read again (null when the window was closed meanwhile).
async function followBackup(r, ids, pcs, say, box) {
  const whereOf = id => (pcs.find(pc => pc.id === id) || {}).where;
  const line = c => {
    const who = pcLabel(c.pcName, whereOf(c.pc));
    if (c.state === 'working') return '◐ ' + who + ': sending' + (c.bytes ? ', ' + fmtSize(c.done) + ' of ' + fmtSize(c.bytes) : '…');
    if (c.state === 'done') return '● ' + who + ': ' + c.said;
    return '▲ ' + who + ' (' + c.state + '): ' + (c.said || 'no reason was given.') + (c.state === 'failed' ? ' Press Back up now to try again.' : '');
  };
  const until = Date.now() + 30 * 60_000;
  for (;;) {
    if (!box.isConnected) return null;
    const x = await api('/api/node-backup/progress', { id: r.id, ids });
    if (!x.ok) throw new Error(x.error);
    const copies = x.copies || [];
    const working = copies.filter(c => c.state === 'working');
    if (!working.length) {
      return copies.length ? ['Backup finished at ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + ':', ...copies.map(line)]
        : 'Backup finished, but TOMLIN no longer lists those copies (was it restarted?). "Copies now" above shows what each PC holds.';
    }
    say(['Backup in progress (' + (copies.length - working.length) + ' of ' + plural(copies.length, 'PC', 'PCs') + ' done):', ...copies.map(line)]);
    if (Date.now() > until) return ['Still sending after 30 minutes. TOMLIN carries on and shows the progress under My local LLMs.', ...copies.map(line)];
    await new Promise(ok => setTimeout(ok, 1000));
  }
}

// The bar at the bottom: how many projects have an up-to-date copy on another PC.
function nodeSummary() {
  if (!stats || !stats.nodes) return '';
  const on = rows.filter(r => r.node && r.node.on);
  if (!on.length) return '';
  return 'Copies: ' + on.filter(r => nodeCurrent(r.node)).length + ' of ' + on.length + ' up to date';
}
