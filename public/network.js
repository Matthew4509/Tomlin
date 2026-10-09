// "My local LLMs" (src/carry.ts): the models the linked PCs share with others, copied here over the
// home network; an update going to a linked PC; restore points kept on them. The copies run on the
// server, so closing this window does not stop them; while it is open it reads how they go once a second.
'use strict';

const netDlg = $('#net-dlg');
const netSize = n => (n >= GB ? gb(n) : n >= 2 ** 20 ? `${Math.round(n / 2 ** 20)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const netUp = w => `${w.charAt(0).toUpperCase()}${w.slice(1)}`;
let netTimer = null;
/** Copies that were running at the last look: when one ends, the lists are read again (what is here has changed). */
let netRunning = new Set();

function netSaid(text) {
  $('#net-said').textContent = text ?? '';
}

/** Runs one of the window's actions; its fault is said at the top. */
async function netDo(path, body) {
  try {
    const r = await api(path, body);
    netSaid('');
    if (r.transfer) {
      drawNetTransfers([r.transfer, ...netLast.filter(t => t.id !== r.transfer.id)]);
      // Watched from now: when it ends, the lists are read again (and its button is pressable again).
      netRunning.add(r.transfer.id);
    }
    netWatch();
    return r;
  } catch (e) {
    netSaid(e.message);
    return null;
  }
}

let netLast = [];
function drawNetTransfers(list) {
  netLast = list;
  const verb = t => (t.state === 'done'
    ? { copy: `Copied ${t.what} from "${t.pcName}"`, send: `Sent ${t.what} to "${t.pcName}"`, backup: `Backed up to "${t.pcName}"`, bring: `Brought back a restore point from "${t.pcName}"`, update: `Updated "${t.pcName}" to ${t.what}`, projects: `Projects backed up to "${t.pcName}"`, restore: `Brought projects back from "${t.pcName}"` }
    : { copy: `Copying ${t.what} from "${t.pcName}"`, send: `Sending ${t.what} to "${t.pcName}"`, backup: `Backing up to "${t.pcName}"`, bring: `Bringing back a restore point from "${t.pcName}"`, update: `Updating "${t.pcName}" to ${t.what}`, projects: `Backing up projects to "${t.pcName}"`, restore: `Bringing projects back from "${t.pcName}"` })[t.kind];
  $('#net-transfers').replaceChildren(...list.map(t => {
    const fill = el('div', { class: 'p-fill' });
    const frac = t.bytes ? t.done / t.bytes : 0;
    fill.style.width = `${Math.round(frac * 100)}%`;
    const working = t.state === 'working';
    // An update says only what was sent, in one short line.
    const sent = t.kind === 'update' && t.state !== 'failed' && t.state !== 'stopped'
      ? `Sent: ${!t.bytes ? (working ? 'comparing the files…' : 'nothing had changed.') : t.done < t.bytes ? `${netSize(t.done)} of ${netSize(t.bytes)}` : working ? `${netSize(t.bytes)}, starting it there…` : `${netSize(t.bytes)}. ${t.said}`}`
      : null;
    const line = sent ?? (working ? (t.bytes ? `${netSize(t.done)} of ${netSize(t.bytes)}` : 'Starting…') : t.state === 'done' ? t.said : `${t.state === 'stopped' ? 'Stopped' : 'Did not finish'}: ${t.said}`);
    return el('div', { class: 'net-row' },
      el('span', { class: 'net-name' }, el('strong', { text: verb(t) })),
      working ? el('button', { class: 'btn quiet', type: 'button', text: 'Stop', onclick: () => netDo('/api/network/stop', { id: t.id }) }) : null,
      el('div', { class: 'progress' }, working ? el('div', { class: 'p-track' }, fill) : null, el('div', { class: 'p-text', role: t.state === 'failed' ? 'alert' : null, text: line })));
  }));
}

function drawNet(v) {
  drawNetTransfers(v.transfers);
  const running = new Set(v.transfers.filter(t => t.state === 'working').map(t => `${t.kind}|${t.pc}|${t.what}`));
  const busyPc = pc => v.transfers.some(t => t.pc === pc && t.state === 'working');

  // Shared by linked PCs: each model once, with where it can be copied from.
  $('#net-rows').replaceChildren(...(v.rows.length ? v.rows.map(r => {
    const from = r.on.find(o => o.copy);
    const about = [r.kind === 'image' ? 'picture model' : 'chat model', netSize(r.bytes), `on ${r.on.map(o => `"${o.pcName}"`).join(' and ')}`].join(' · ');
    let action;
    if (r.here) action = el('span', { class: 'hint', text: 'On this PC' });
    else if (from && running.has(`copy|${from.pc}|${r.name}`)) action = el('span', { class: 'hint', text: 'Copying…' });
    else if (from) action = el('button', { class: 'btn primary', type: 'button', text: `Get a copy from ${from.pcName}`, disabled: busyPc(from.pc), onclick: e => { e.target.disabled = true; netDo('/api/network/copy', { pc: from.pc, kind: r.kind, model: from.model }); } });
    else action = null;
    const why = !r.here && !from ? `${netUp(r.on[0].why)}.` : '';
    return el('div', { class: 'net-row' },
      el('span', { class: 'net-name' }, el('strong', { text: r.name }), el('br'), el('span', { class: 'hint', text: about }), why ? el('br') : null, why ? el('span', { class: 'hint', text: why }) : null),
      action);
  }) : [el('p', { class: 'hint', text: v.pcs.length ? 'No shared models yet. Each node has to select "yes" to sharing. It will then display here.' : 'No PCs are linked to this one yet: link one above, under Other PCs.' })]));

  drawKept(v.pcs);

  // Restore points: back up to a PC that allows it; the ones kept there, to bring back.
  $('#net-backups').replaceChildren(...(v.pcs.length ? v.pcs.map(p => {
    const list = el('div', { class: 'net-list' });
    const show = el('button', { class: 'link', type: 'button', text: 'Restore points kept there', disabled: !p.ok, onclick: async () => {
      show.disabled = true;
      list.replaceChildren(el('p', { class: 'hint', text: 'Asking…' }));
      try {
        const r = await api(`/api/network/backups?pc=${encodeURIComponent(p.id)}`);
        list.replaceChildren(...(r.backups.length ? r.backups.map(b => el('div', { class: 'net-row' },
          el('span', { class: 'net-name', text: `${keepName(b.name)} · ${netSize(b.bytes)}` }),
          el('button', { class: 'btn quiet', type: 'button', text: 'Bring back', onclick: e => { e.target.disabled = true; netDo('/api/network/bring', { pc: p.id, name: b.name, bytes: b.bytes }); } })))
          : [el('p', { class: 'hint', text: `None kept on "${p.name}".` })]));
      } catch (e) {
        list.replaceChildren(el('p', { class: 'hint', text: e.message }));
      }
      show.disabled = false;
    } });
    // Projects: a git repository there, backed up every 10 minutes when something changed (src/gitstore.ts).
    const d = p.projectsDone;
    const projLine = p.projects ? `Projects: ${p.projects}.` : d ? `Projects: last backed up ${new Date(d.at).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })} (${d.files} file${d.files === 1 ? '' : 's'}). Backed up every 10 minutes when something changed.` : 'Projects: not backed up there yet. Backed up every 10 minutes when something changed.';
    return el('div', {},
      el('div', { class: 'net-row' },
        el('span', { class: 'net-name' }, el('strong', { text: p.name }), p.backup ? el('br') : null, p.backup ? el('span', { class: 'hint', text: `${netUp(p.backup)}.` }) : null),
        p.backup ? null : el('button', { class: 'btn', type: 'button', text: 'Back up to it now', disabled: busyPc(p.id), onclick: e => { e.target.disabled = true; netDo('/api/network/backup', { pc: p.id }); } }),
        show),
      el('div', { class: 'net-row' },
        el('span', { class: 'net-name hint', text: projLine }),
        p.projects ? null : el('button', { class: 'btn', type: 'button', text: 'Back up projects now', disabled: busyPc(p.id), onclick: e => { e.target.disabled = true; netDo('/api/network/projects', { pc: p.id }); } }),
        d || !p.projects ? el('button', { class: 'btn quiet', type: 'button', text: 'Bring projects back', disabled: !p.ok || busyPc(p.id), title: 'Copies the newest backup into a new folder on this PC ("restored projects"); nothing in your workspace is changed', onclick: e => { e.target.disabled = true; netDo('/api/network/projects-back', { pc: p.id }); } }) : null),
      list);
  }) : [el('p', { class: 'hint', text: 'No PCs are linked to this one yet.' })]));
}

/** Every restore point kept on the linked PCs that answer, newest first, each with Bring back; or "No recent backups". */
let netKeptAsk = 0;
async function drawKept(pcs) {
  const ask = ++netKeptAsk;
  const box = $('#net-kept');
  const on = pcs.filter(p => p.ok);
  if (!on.length) return box.replaceChildren(el('p', { class: 'hint', text: 'No recent backups' }));
  box.replaceChildren(el('p', { class: 'hint', text: 'Asking…' }));
  const all = [];
  await Promise.all(on.map(async p => {
    try {
      for (const b of (await api(`/api/network/backups?pc=${encodeURIComponent(p.id)}`)).backups) all.push({ ...b, pc: p });
    } catch {
      // A PC that does not answer now lists nothing; its own row below says why.
    }
  }));
  if (ask !== netKeptAsk) return;
  all.sort((a, b) => b.name.localeCompare(a.name));
  box.replaceChildren(...(all.length ? all.map(b => el('div', { class: 'net-row' },
    el('span', { class: 'net-name', text: `${keepName(b.name)} · ${netSize(b.bytes)} · on "${b.pc.name}"` }),
    el('button', { class: 'btn quiet', type: 'button', text: 'Bring back', onclick: e => { e.target.disabled = true; netDo('/api/network/bring', { pc: b.pc.id, name: b.name, bytes: b.bytes }); } })))
    : [el('p', { class: 'hint', text: 'No recent backups' })]));
}

async function netRead() {
  try {
    const v = await api('/api/network');
    drawNet(v);
    netRunning = new Set(v.transfers.filter(t => t.state === 'working').map(t => t.id));
    netSaid('');
  } catch (e) {
    netSaid(e.message);
  }
}

/** While the window is open and a copy runs: how it goes, once a second; the lists again when one ends. */
function netWatch() {
  if (netTimer) return;
  netTimer = setInterval(async () => {
    if (!netDlg.open) {
      clearInterval(netTimer);
      netTimer = null;
      return;
    }
    try {
      const { transfers } = await api('/api/network/transfers');
      drawNetTransfers(transfers);
      const now = new Set(transfers.filter(t => t.state === 'working').map(t => t.id));
      const ended = [...netRunning].some(id => !now.has(id));
      netRunning = now;
      if (ended) await netRead();
    } catch {
      // the next second asks again
    }
  }, 1000);
}

/** Opens the window (its buttons, and Update it on a linked PC's tile, which shows the update going here). */
app.openNet = async () => {
  netSaid('Asking the linked PCs…');
  $('#net-rows').replaceChildren();
  $('#net-kept').replaceChildren();
  $('#net-backups').replaceChildren();
  if (!netDlg.open) netDlg.showModal();
  await netRead();
  netWatch();
};
for (const b of document.querySelectorAll('[data-net]')) b.addEventListener('click', () => app.openNet());

// ---- The update screen: the four steps of "Update it", each ticked only once it has really happened ----

const updDlg = $('#upd-dlg');
const UPD_STEPS = ['compare', 'send', 'start', 'check'];
let updTimer = null;

/** Where each step stands: 0..3 the step under way, 4 all done. A step is never ticked before the PC says it is done. */
const updAt = t => (t.state === 'done' ? UPD_STEPS.length : Math.max(0, UPD_STEPS.indexOf(t.stage ?? 'compare')));

function drawUpd(t, shown) {
  const pc = `"${t.pcName}"`;
  const version = t.what.replace(/^TOMLIN /, '');
  const sending = t.bytes ? (t.done < t.bytes ? `: ${netSize(t.done)} of ${netSize(t.bytes)}` : `: ${netSize(t.bytes)}`) : '';
  const labels = [
    'Comparing the files',
    shown > 1 && !t.bytes ? 'Sending what changed: nothing had changed' : `Sending what changed${shown >= 1 ? sending : ''}`,
    `Starting the new version on ${pc}`,
    `Checking ${pc} answers with ${version}`,
  ];
  const failed = t.state === 'failed' || t.state === 'stopped';
  $('#upd-title').textContent = t.state === 'done' ? `${pc} is updated to TOMLIN ${version}` : `Updating ${pc} to TOMLIN ${version}`;
  $('#upd-steps').replaceChildren(...labels.map((text, i) => {
    const state = i < shown ? 'done' : i === shown ? (failed ? 'failed' : 'now') : 'later';
    return el('li', { class: `upd-${state}`, 'aria-current': state === 'now' ? 'step' : null },
      el('span', { class: 'upd-mark', 'aria-hidden': 'true', text: { done: '✓', now: '●', failed: '✕', later: '○' }[state] }),
      el('span', { text }), state === 'now' && i === 1 && t.bytes ? updBar(t.done / t.bytes) : null);
  }));
  const line = $('#upd-line');
  line.setAttribute('role', failed ? 'alert' : 'status');
  line.className = failed ? 'fault-line' : 'hint';
  line.textContent = failed ? `${t.state === 'stopped' ? 'Stopped' : 'Did not finish'}: ${t.said}`
    : t.state === 'done' && shown >= UPD_STEPS.length ? t.said
    : shown === 2 && t.wait ? `${pc} is busy (${t.wait}): the new version starts there when that is done.` : '';
  const over = failed || (t.state === 'done' && shown >= UPD_STEPS.length);
  $('#upd-keep').hidden = over;
  $('#upd-stop').hidden = over || shown >= 2;
  $('#upd-close').hidden = !over;
}

function updBar(frac) {
  const fill = el('div', { class: 'p-fill' });
  fill.style.width = `${Math.round(Math.min(1, frac) * 100)}%`;
  return el('div', { class: 'p-track' }, fill);
}

/**
 * Opens the screen for an update just started. It reads how it goes every half second; the steps on screen move on
 * at most one each 0.7 s, so a fast step is still seen, and never past where the update really is.
 */
app.openUpdate = transfer => {
  let t = transfer;
  let shown = 0;
  let moved = 0;
  clearInterval(updTimer);
  $('#upd-stop').onclick = async () => {
    $('#upd-stop').disabled = true;
    await api('/api/network/stop', { id: t.id }).catch(() => undefined);
    $('#upd-stop').disabled = false;
  };
  $('#upd-close').onclick = () => updDlg.close();
  drawUpd(t, shown);
  if (!updDlg.open) updDlg.showModal();
  updTimer = setInterval(async () => {
    if (!updDlg.open) return void clearInterval(updTimer);
    try {
      t = (await api('/api/network/transfers')).transfers.find(x => x.id === t.id) ?? t;
    } catch {
      // the next half second asks again
    }
    const real = updAt(t);
    // A fault is said at the step it happened in, at once.
    if (t.state === 'failed' || t.state === 'stopped') shown = real;
    else if (shown < real && Date.now() - moved >= 700) {
      shown++;
      moved = Date.now();
    }
    drawUpd(t, shown);
    if (t.state !== 'working' && (t.state !== 'done' || shown >= UPD_STEPS.length)) clearInterval(updTimer);
  }, 500);
};
