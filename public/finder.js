// Find the fastest setup (src/server/finder.ts): one window for a chat model on this PC or on a linked PC. First what the
// test would try and how long it takes (Quick or Full; other context sizes only when ticked), then each try as it is
// timed, with Stop, then the list with the recommended one selected, "more info" on each, and Go with this config (or
// Undo). Nothing changes until Go with this config. Opened from This PC's model rows, a linked PC's card, Edit staff and
// after a hire. Uses app.js's helpers ($, el, api, app).
'use strict';

const finder = { t: null, size: 'quick', contexts: new Set(), preview: null, poll: 0, open: false };

/** A hire's or a row's model as the finder takes it: this PC's model id, or "remote:<pc>:<model>". */
function finderTarget(ref) {
  const m = /^remote:([0-9a-f]{8}):(.+)$/.exec(String(ref ?? ''));
  if (m) return { pc: m[1], model: m[2] };
  return ref && !String(ref).startsWith('remote:') ? { pc: 'here', model: String(ref) } : null;
}

/** One step, here or on the linked PC (that PC runs its own test; only ids and sizes cross). */
function finderAsk(action, b = {}) {
  const t = finder.t;
  if (t.pc !== 'here') return api('/api/network/tune', { pc: t.pc, action, model: t.model, ...b });
  if (action === 'preview') return api(`/api/speed/find?model=${encodeURIComponent(t.model)}&size=${b.size}&contexts=${(b.contexts ?? []).join(',')}`);
  if (action === 'state') return api('/api/speed/find/state');
  return api(`/api/speed/find/${action}`, { model: t.model, ...b });
}

const fGB = n => `${(Math.round((n / 2 ** 30) * 10) / 10).toFixed(1)} GB`;
const fNum = n => (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10);
const fWhere = () => (finder.t.pc === 'here' ? 'this PC' : `"${finder.t.pcName}"`);

function finderBox() {
  return $('#finder-dlg');
}

function finderFrame(...kids) {
  finderBox().replaceChildren(el('div', { class: 'help-body finder' },
    el('h2', { id: 'finder-title', text: 'Find the fastest setup' }),
    el('p', { class: 'hint', text: `${finder.t.name || finder.t.model} on ${fWhere()}` }),
    ...kids));
}

async function finderPreview() {
  const box = el('p', { class: 'hint', role: 'status', text: 'Working out what to try…' });
  finderFrame(box);
  let p;
  try {
    p = await finderAsk('preview', { size: finder.size, contexts: [...finder.contexts] });
  } catch (e) {
    box.textContent = e.message;
    finderBox().querySelector('.finder').append(el('div', { class: 'team-actions' }, el('button', { class: 'btn', type: 'button', text: 'Close', onclick: () => finderBox().close() })));
    return;
  }
  finder.preview = p;
  if (p.pcName) finder.t.pcName = p.pcName;
  finder.t.name = p.name;
  // A test already running there: show it instead.
  if (p.running) return finderWatch();
  const sizeRow = (v, label) => el('label', { class: 'check' }, el('input', { type: 'radio', name: 'finder-size', value: v, checked: finder.size === v, onchange: () => { finder.size = v; finderPreview(); } }), ` ${label}: about ${p.minutes[v]} minute${p.minutes[v] === 1 ? '' : 's'}`);
  const ctxs = el('details', { class: 'finder-ctx', open: finder.contexts.size > 0 },
    el('summary', { text: `Also test other context sizes (your choice; it keeps ${p.ctx.toLocaleString()} tokens unless you pick another)` }),
    el('div', { class: 'finder-ctx-list' }, ...p.contexts.map(n => el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: finder.contexts.has(n), onchange: e => { if (e.target.checked) finder.contexts.add(n); else finder.contexts.delete(n); finderPreview(); } }), ` ${n.toLocaleString()}`))));
  const start = el('button', { class: 'btn primary', type: 'button', text: 'Start the test', onclick: () => finderStart(start) });
  finderFrame(
    finder.t.ask ? el('p', { text: `Test ${p.name} on ${fWhere()} now, to find its fastest setup? If you skip, it keeps the settings it has now; you can run the test later from Edit staff.` }) : null,
    el('p', { text: `TOMLIN starts this model a few different ways and times each one with the same example prompts. Nothing changes until you press Go with this config. While it runs, chats on ${fWhere()} wait.` }),
    el('div', { class: 'finder-sizes', role: 'radiogroup', 'aria-label': 'How long' }, sizeRow('quick', 'Quick'), sizeRow('full', 'Full')),
    el('h3', { text: 'It will try' }),
    el('ol', { class: 'finder-plan' }, ...p.rows.map(r => el('li', {}, el('strong', { text: r.name }), r.tight ? ' (leaves little on the card)' : '', el('span', { class: 'hint', text: ` ${r.why}` })))),
    p.left.length ? el('details', {}, el('summary', { text: `Not tried (${p.left.length})` }), el('ul', { class: 'finder-plan' }, ...p.left.map(l => el('li', {}, el('strong', { text: l.name }), el('span', { class: 'hint', text: `: ${l.why}` }))))) : null,
    p.card ? el('p', { class: 'hint', text: 'The list may change a little once the model is loaded as it is now (what it really holds on the card is read first).' }) : null,
    p.contexts.length ? ctxs : null,
    p.last ? el('p', { class: 'hint' }, `Last test: ${new Date(p.last.at).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}. `, el('button', { class: 'link', type: 'button', text: 'Show its results', onclick: () => finderResults(p.last.run, p.undo) })) : null,
    el('p', { class: 'hint fault-line', id: 'finder-say', role: 'status' }),
    el('div', { class: 'team-actions' }, start, el('button', { class: 'btn', type: 'button', text: finder.t.ask ? 'Skip' : 'Close', onclick: () => finderBox().close() })));
}

async function finderStart(btn) {
  btn.disabled = true;
  try {
    await finderAsk('start', { size: finder.size, contexts: [...finder.contexts] });
    finderWatch();
  } catch (e) {
    $('#finder-say').textContent = e.message;
    btn.disabled = false;
  }
}

const STATE_MARK = { done: '✓', failed: '✗', running: '…', waiting: '·', 'not tried': '–' };

/** While it runs: each row as it is timed, what it is doing now, and Stop. */
async function finderWatch() {
  clearTimeout(finder.poll);
  if (!finder.open) return;
  let job = null;
  try {
    job = (await finderAsk('state')).job;
  } catch (e) {
    finderFrame(el('p', { class: 'fault', text: e.message }), el('div', { class: 'team-actions' }, el('button', { class: 'btn', type: 'button', text: 'Close', onclick: () => finderBox().close() })));
    return;
  }
  if (job && job.model !== finder.t.model) {
    finderFrame(el('p', { text: `A speed test of ${job.name} is running on ${fWhere()} now. Wait for it, then try again.` }), el('div', { class: 'team-actions' }, el('button', { class: 'btn', type: 'button', text: 'Close', onclick: () => finderBox().close() })));
    return;
  }
  if (!job) {
    finderFrame(el('p', { text: `No speed test is running on ${fWhere()} now.` }), el('div', { class: 'team-actions' }, el('button', { class: 'btn', type: 'button', text: 'Close', onclick: () => finderBox().close() })));
    return;
  }
  const run = job.run;
  if (run && run.state !== 'running') return finderResults(run, null);
  const rows = run?.rows ?? [];
  finderFrame(
    el('p', { role: 'status', text: run?.now || 'Starting…' }),
    el('ol', { class: 'finder-rows' }, ...rows.map(r => el('li', { class: `finder-row is-${r.state.replace(' ', '-')}` },
      el('span', { class: 'finder-mark', 'aria-hidden': 'true', text: STATE_MARK[r.state] ?? '' }),
      el('strong', { text: r.name }),
      el('span', { class: 'hint', text: r.state === 'done' ? ` ${fNum(r.write)} tok/s writing` : r.state === 'failed' ? ` failed: ${r.why}` : r.state === 'not tried' ? ` ${r.why}` : r.state === 'running' ? ' being timed now' : '' })))),
    el('div', { class: 'team-actions' },
      el('button', { class: 'btn', type: 'button', text: 'Stop', onclick: async e => {
        e.target.disabled = true;
        await finderAsk('stop').catch(() => undefined);
      } }),
      el('button', { class: 'btn', type: 'button', text: 'Close (it carries on)', onclick: () => finderBox().close() })));
  finder.poll = setTimeout(finderWatch, 2000);
}

/** One row's more info: every figure, the setup in plain words, and why it was or was not recommended. */
function finderInfo(r, run) {
  const line = (k, v) => (v === null || v === undefined || v === '' ? null : el('li', {}, el('span', { class: 'hint', text: `${k}: ` }), String(v)));
  return el('ul', { class: 'finder-info' },
    line('Writing', r.write ? `${fNum(r.write)} tokens a second (the middle of ${r.state === 'done' ? 'two or three runs' : 'its runs'})` : null),
    line('Reading', r.read ? `${fNum(r.read)} tokens a second` : null),
    line('Copying (the second prompt\'s answer)', r.copy ? `${fNum(r.copy)} tokens a second` : null),
    line('First word after', r.firstWord ? `${r.firstWord} s` : null),
    line('Loaded in', r.loadSeconds ? `${r.loadSeconds} s${r.slowLoad ? ' (read from disk: its figure may be low)' : ''}` : null),
    line('On the card', r.cardBytes ? fGB(r.cardBytes) : null),
    line('In RAM', r.ramBytes ? fGB(r.ramBytes) : null),
    line('Borrowed from RAM by the card', r.borrowed ? fGB(r.borrowed) : null),
    line('Card memory left free', r.cardFree !== null && r.cardFree !== undefined ? fGB(r.cardFree) : null),
    line('Guesses kept', r.accepted !== null && r.accepted !== undefined ? `${Math.round(r.accepted * 100)}%` : null),
    line('Same words as without the trick', r.sameWords === null || r.sameWords === undefined ? null : r.sameWords ? 'yes' : 'no'),
    line('Why it was tried', r.why && r.state === 'done' ? null : r.why),
    line('Recommended', run.best === r.id ? 'yes' : run.why?.[r.id] ? `no: ${run.why[r.id]}` : r.state === 'done' ? 'no: another was faster' : null));
}

/** The results: the recommended row selected, more info on each, Go with this config, Undo. */
function finderResults(run, undo) {
  clearTimeout(finder.poll);
  let picked = run.best ?? run.rows.find(r => r.state === 'done')?.id ?? null;
  const say = el('p', { class: 'hint', id: 'finder-say', role: 'status', text: run.said || '' });
  const go = el('button', { class: 'btn primary', type: 'button', text: 'Go with this config', onclick: async () => {
    if (picked === 'a') {
      say.textContent = 'That is the setup it has now: nothing to change.';
      return;
    }
    go.disabled = true;
    try {
      say.textContent = (await finderAsk('apply', { row: picked })).said;
    } catch (e) {
      say.textContent = e.message;
    }
    go.disabled = false;
  } });
  const back = undo ? el('button', { class: 'btn', type: 'button', text: 'Undo: back to the setup from before', onclick: async () => {
    try {
      say.textContent = (await finderAsk('undo')).said;
      back.remove();
    } catch (e) {
      say.textContent = e.message;
    }
  } }) : null;
  finderFrame(
    el('p', { role: 'status', text: run.state === 'stopped' ? 'Stopped: the rows done so far are below, and the model was put back as it was.' : run.state === 'failed' ? 'The test stopped part way. The model was put back as it was.' : run.keep ? 'Keep what you have: nothing tried was clearly faster.' : 'Done. The recommended setup is selected.' }),
    run.best ? null : el('p', { class: 'hint', text: 'Nothing is recommended: what it has now was not measured, so there is nothing to compare with.' }),
    run.drift ? el('p', { class: 'hint fault-line', text: 'The PC\'s speed changed during the test (something else was running?): the figures are less certain.' }) : null,
    el('div', { class: 'finder-results', role: 'radiogroup', 'aria-label': 'Setups' }, ...run.rows.map(r => {
      const mark = run.best === r.id ? '★ recommended' : r.state === 'failed' ? '✗ failed' : r.tight ? '⚠ tight' : '';
      const radio = el('input', { type: 'radio', name: 'finder-pick', value: r.id, checked: r.id === picked, disabled: r.state !== 'done', onchange: () => { picked = r.id; } });
      const more = el('details', { class: 'finder-more' }, el('summary', { text: 'more info' }), finderInfo(r, run));
      return el('div', { class: `finder-result${run.best === r.id ? ' is-best' : ''}` },
        el('label', { class: 'check' }, radio, ' ', el('strong', { text: r.name })),
        el('span', { class: 'finder-fig', text: r.state === 'done' ? `${fNum(r.write)} tok/s writing${r.copy && (r.run.spec || r.run.draft) ? ` · ${fNum(r.copy)} copying` : ''}` : r.state === 'failed' ? `failed: ${r.why}` : r.why }),
        mark ? el('span', { class: 'finder-tag', text: mark }) : null,
        more);
    })),
    say,
    el('div', { class: 'team-actions' }, picked ? go : null, back, el('button', { class: 'btn', type: 'button', text: 'Test again', onclick: () => finderPreview() }), el('button', { class: 'btn', type: 'button', text: 'Close', onclick: () => finderBox().close() })));
}

/**
 * Opens the window for a model: `ref` is this PC's model id or "remote:<pc>:<model>". `ask`: after a hire, worded as a
 * question (Skip keeps the settings it has). Resolves when the window closes.
 */
app.openFinder = (ref, o = {}) => new Promise(done => {
  const t = finderTarget(ref);
  if (!t) return done();
  finder.t = { ...t, name: o.name ?? '', pcName: o.pcName ?? '', ask: o.ask === true };
  finder.size = 'quick';
  finder.contexts = new Set();
  finder.open = true;
  const box = finderBox();
  box.onclose = () => {
    finder.open = false;
    clearTimeout(finder.poll);
    done();
  };
  box.showModal();
  finderPreview();
});

/** A "Find the fastest setup" button for a chat model (null when there is none: a picture model, or a PC's loaded one). */
app.finderButton = (ref, o = {}) => (finderTarget(ref) ? el('button', { class: o.link ? 'link' : 'btn', type: 'button', text: 'Find the fastest setup', title: 'Starts this model a few different ways, times each, and recommends the fastest (about 5 to 25 minutes; nothing changes until you choose)', onclick: () => app.openFinder(ref, o) }) : null);

/**
 * After a hire on a chat model that has never been through the test: asks whether to run it now (Skip keeps the
 * settings it has). Says nothing when that PC cannot run it (an older TOMLIN, or its owner has not ticked it).
 */
app.offerFinder = async (ref, name) => {
  const t = finderTarget(ref);
  if (!t) return;
  finder.t = { ...t, name, pcName: '', ask: true };
  try {
    const p = await finderAsk('preview', { size: 'quick' });
    if (p.last || p.found || p.running) return;
  } catch {
    return;
  }
  await app.openFinder(ref, { name, ask: true });
};
