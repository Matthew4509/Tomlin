// The top bar's downloads chip, beside the models loaded: while anything is downloading or waiting in a downloads list
// (this PC's or a linked PC's: src/dlqueue.ts), or being copied between PCs, "3 downloads · 1 of 3 · 56%". It runs on
// the servers, so it carries on with this window closed. A press opens the downloads window: one line per download,
// "Z820 · Qwen3-8B-Q4_K_M · 56%" or "pending", with Cancel; finished ones with Download again, and Clear finished.
'use strict';

const dlChip = $('#dl-chip');
const dlDlg = $('#dl-dlg');
/** The last lists read: { pcs: [{ pc, pcName, ok, why, lines }] }, and the copies between PCs going now. */
let dlLast = { pcs: [] };
let dlCopies = [];
let dlSaid = '';

const dlOpen = x => x.state === 'running' || x.state === 'waiting';
const dlGB = n => (n >= 2 ** 30 ? `${(n / 2 ** 30).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 2 ** 20))} MB`);

/** Every PC's lines as one list: the ones running, then the ones pending (in the order added), then the finished ones. */
function dlAll() {
  const all = dlLast.pcs.flatMap(p => p.lines.map(x => ({ ...x, pc: p.pc, pcName: p.pcName, pcOk: p.ok })));
  const rank = x => (x.state === 'running' ? 0 : x.state === 'waiting' ? 1 : 2);
  return all.sort((a, b) => rank(a) - rank(b) || (rank(a) < 2 ? String(a.added).localeCompare(String(b.added)) : String(b.ended).localeCompare(String(a.ended))));
}

async function dlRead() {
  const [lists, net] = await Promise.all([api('/api/network/downloads').catch(() => null), api('/api/network/transfers').catch(() => null)]);
  if (lists) dlLast = lists;
  // A download a linked PC makes is in its own list (shown once, there); the other copies between PCs are counted here.
  dlCopies = (net?.transfers ?? []).filter(t => t.state === 'working' && t.kind !== 'fetch');
  const going = dlAll().filter(dlOpen);
  const count = going.length + dlCopies.length;
  dlChip.hidden = !count && !dlDlg.open;
  if (count) {
    const now = going.find(x => x.state === 'running');
    const copy = dlCopies.find(t => !t.queued);
    const pct = now ? now.words : copy?.bytes ? `${Math.floor((copy.done / copy.bytes) * 100)}%` : 'starting';
    dlChip.textContent = count === 1 ? `Downloading · ${pct}` : `${count} downloads · 1 of ${count} · ${pct}`;
    dlChip.title = 'Press to see each download, with Cancel.';
  }
  if (dlDlg.open) dlDraw();
}
app.refreshDownloads = dlRead;

async function dlDo(pc, id, act) {
  try {
    await api('/api/network/download-line', { pc, id, act });
    dlSaid = '';
  } catch (e) {
    dlSaid = e.message;
  }
  await dlRead();
}

function dlLine(x) {
  const running = x.state === 'running';
  const pct = running && x.bytes ? Math.floor((x.got / x.bytes) * 100) : 0;
  const fill = el('span', { class: 'dl-fill' });
  fill.style.width = `${pct}%`;
  const act = dlOpen(x)
    ? el('button', { class: 'btn quiet', type: 'button', text: 'Cancel', title: running ? 'Stops it and takes it out of the list: the next one starts.' : 'Takes it out of the list.', onclick: () => dlDo(x.pc, x.id, 'cancel') })
    : x.state !== 'done' && x.pcOk ? el('button', { class: 'btn quiet', type: 'button', text: 'Download again', title: 'Back at the end of the list: it carries on from what it has.', onclick: () => dlDo(x.pc, x.id, 'again') }) : null;
  const words = x.state === 'failed' ? `failed: ${x.error}` : running ? `${x.words} of ${dlGB(x.bytes)}` : x.words;
  return el('li', { class: `dl-line is-${x.state}` }, ...[
    el('span', { class: 'dl-line-pc', text: x.pcName }),
    el('span', { class: 'dl-line-name', title: `${x.repo} · into the ${x.where}${x.by && x.by !== 'This PC' ? ` · added by ${x.by}` : ''}`, text: x.name }),
    el('span', { class: x.state === 'failed' ? 'dl-line-words fault-line' : 'dl-line-words', text: words }),
    act,
    running ? el('div', { class: 'dl-track', 'aria-hidden': 'true' }, fill) : null].filter(Boolean));
}

/** Arriving at this PC, or going to the PC named: the words for each kind of copy between PCs (src/jobrun/copies.ts). */
const DL_HERE = ['copy', 'pull', 'bring', 'restore'];
const DL_WHY = { backup: 'backup in progress', projects: 'backup in progress', restore: 'backup in progress', update: 'update in progress', pull: 'update in progress', bring: 'update in progress' };
const dlWhy = t => DL_WHY[t.kind] ?? 'copy in progress';
/** "about 25 min left", from the copy's own speed so far; '' until it has moved enough to tell. */
function dlLeft(t) {
  const secs = (Date.now() - (t.started ?? Date.now())) / 1000;
  if (!t.bytes || !t.done || secs < 10) return '';
  const left = (t.bytes - t.done) / (t.done / secs);
  if (!Number.isFinite(left) || left <= 0) return '';
  return left < 90 ? 'about a minute left' : left < 5400 ? `about ${Math.round(left / 60)} min left` : `about ${(left / 3600).toFixed(1)} h left`;
}
/** One copy between PCs: "Downloading to Worker PC · Qwen3-8B · 34% of 12.0 GB · about 6 min left", with Stop. */
function dlCopyLine(t) {
  const here = DL_HERE.includes(t.kind);
  const pct = t.bytes ? Math.floor((t.done / t.bytes) * 100) : 0;
  const fill = el('span', { class: 'dl-fill' });
  fill.style.width = `${pct}%`;
  const words = t.bytes ? [`${pct}% of ${dlGB(t.bytes)}`, dlLeft(t)].filter(Boolean).join(' · ') : t.wait || 'starting';
  return el('li', { class: 'dl-line is-running' },
    el('span', { class: 'dl-line-pc', text: here ? `Downloading to this PC from ${t.pcName}` : `Downloading to ${t.pcName}` }),
    el('span', { class: 'dl-line-name', text: t.what }),
    el('span', { class: 'dl-line-words', text: words }),
    el('button', { class: 'btn quiet', type: 'button', text: 'Stop', title: 'Stops it; what has come is kept, and copying it again carries on from there.', onclick: async () => { await api('/api/network/stop', { id: t.id }).catch(e => { dlSaid = e.message; }); await dlRead(); } }),
    el('div', { class: 'dl-track', 'aria-hidden': 'true' }, fill));
}
/**
 * Which PCs must stay on for what is going now, and why: a copy between PCs needs this PC and the other one; a download
 * from the internet needs only the PC downloading it.
 */
function dlStayOn(open) {
  const why = new Map();
  const add = (name, w) => { if (!why.has(name)) why.set(name, w); };
  for (const t of dlCopies) {
    add('This PC', dlWhy(t));
    add(t.pcName, dlWhy(t));
  }
  for (const x of open) add(x.pcName === 'This PC' || x.pc === 'here' ? 'This PC' : x.pcName, 'download in progress');
  return [...why].map(([name, w]) => `${name} (${w})`);
}

function dlDraw() {
  const all = dlAll();
  const open = all.filter(dlOpen);
  const done = all.filter(x => !dlOpen(x));
  const off = dlLast.pcs.filter(p => !p.ok && p.why);
  const stay = dlStayOn(open);
  // null for a part left out (el and replaceChildren would write it as text).
  dlDlg.replaceChildren(...[
    el('h2', { id: 'dl-title', text: 'Downloads' }),
    // What must stay on for it, first: so a PC is not switched off part way through a copy.
    stay.length ? el('p', { class: 'dl-stay' }, 'This runs in the background. Other PCs can be used or turned off, as long as these stay on: ', el('b', { text: stay.join(', ') }), '.') : null,
    !open.length && !dlCopies.length ? el('p', { class: 'hint', text: 'Nothing is downloading or waiting.' }) : null,
    dlCopies.length ? el('h3', { text: 'Between your PCs' }) : null,
    dlCopies.length ? el('ol', { class: 'dl-lines' }, ...dlCopies.map(dlCopyLine)) : null,
    open.length ? el('h3', { text: 'From the internet' }) : null,
    open.length ? el('p', { class: 'hint', text: 'Each PC works through its own list, one download at a time, even with this PC turned off.' }) : null,
    open.length ? el('ol', { class: 'dl-lines' }, ...open.map(dlLine)) : null,
    ...off.map(p => el('p', { class: 'hint', text: `${p.pcName}: ${p.why}` })),
    done.length ? el('h3', { text: 'Finished' }) : null,
    done.length ? el('ol', { class: 'dl-lines' }, ...done.map(dlLine)) : null,
    dlSaid ? el('p', { class: 'fault-line', role: 'alert', text: dlSaid }) : null,
    el('div', { class: 'team-actions' }, ...[
      done.length ? el('button', { class: 'btn quiet', type: 'button', text: 'Clear finished', onclick: async () => { for (const p of new Set(done.filter(x => x.pcOk).map(x => x.pc))) await dlDo(p, '', 'clear'); } }) : null,
      el('button', { class: 'btn primary', type: 'button', text: 'Close', onclick: () => dlDlg.close() })].filter(Boolean))].filter(Boolean));
}

dlChip.addEventListener('click', async () => {
  dlDraw();
  if (!dlDlg.open) dlDlg.showModal();
  await dlRead();
});
dlRead();
setInterval(() => {
  if (!document.hidden) dlRead();
}, 4000);
