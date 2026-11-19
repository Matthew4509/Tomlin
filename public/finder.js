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
    el('h2', { id: 'finder-title', text: `Optimize ${finder.t.name || finder.t.model} on ${fWhere()}` }),
    ...kids));
}

/** A small (!) that opens its words on hover or focus: the long explanations are kept, out of the way. */
const fBang = words => el('span', { class: 'net-spec', tabindex: '0', role: 'img', 'aria-label': words, title: words, text: '(!)' });

/** What the PC the test runs on is, from what it last told this PC (RAM, card, its memory). */
function finderSpecs() {
  const d = typeof team !== 'undefined' ? team.data : null;
  const m = finder.t.pc === 'here' ? d?.here : d?.pcs?.find(p => p.id === finder.t.pc);
  const g = n => `${(n / 2 ** 30).toFixed(n >= 10 * 2 ** 30 ? 0 : 1)} GB`;
  return [m?.ram ? `${g(m.ram)} of RAM` : null, m?.gpu ? String(m.gpu) : null, m?.vram ? `${g(m.vram)} of card memory` : null].filter(Boolean).join(' · ');
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
    el('p', {}, `Times ${p.name} a few ways with the same example prompts, then recommends one. `, fBang(`TOMLIN starts this model a few different ways and times each one with the same example prompts. Nothing changes until you press Go with this config. While it runs, chats on ${fWhere()} wait.${finder.t.ask ? ' If you skip, it keeps the settings it has now; you can run the test later from Edit staff.' : ''}`)),
    el('div', { class: 'finder-sizes', role: 'radiogroup', 'aria-label': 'How long' }, sizeRow('quick', 'Quick'), sizeRow('full', 'Full')),
    el('details', { class: 'finder-tries' },
      el('summary', { text: `What it will try (${p.rows.length}${p.left.length ? `, ${p.left.length} not tried` : ''})` }),
      el('ol', { class: 'finder-plan' }, ...p.rows.map(r => el('li', {}, el('strong', { text: r.name }), r.tight ? ' (leaves little on the card)' : '', el('span', { class: 'hint', text: ` ${r.why}` })))),
      p.left.length ? el('p', { class: 'hint', text: 'Not tried:' }) : null,
      p.left.length ? el('ul', { class: 'finder-plan' }, ...p.left.map(l => el('li', {}, el('strong', { text: l.name || l.id || 'Another setup' }), l.why ? el('span', { class: 'hint', text: `: ${l.why}` }) : null))) : null,
      p.card ? el('p', { class: 'hint', text: 'The list may change a little once the model is loaded as it is now (what it really holds on the card is read first).' }) : null),
    p.smaller ? finderSmaller(p.smaller) : null,
    p.contexts.length ? ctxs : null,
    p.last ? el('p', { class: 'hint' }, `Last test: ${new Date(p.last.at).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}. `, el('button', { class: 'link', type: 'button', text: 'Show its results', onclick: () => finderResults(p.last.run, p.undo) })) : null,
    el('p', { class: 'hint fault-line', id: 'finder-say', role: 'status' }),
    el('div', { class: 'team-actions' }, start, el('button', { class: 'btn finder-right', type: 'button', text: finder.t.ask ? 'Skip, open chat' : 'Close', onclick: () => finderBox().close() })));
}

/**
 * Same model, smaller file, fits the card (src/server/smaller.ts): offered beside the tries, never run by the test. Its
 * Download button says the size; nothing is downloaded before it is pressed, and the file in use is kept.
 */
function finderSmaller(x) {
  const box = el('section', { class: 'finder-smaller', 'aria-labelledby': 'finder-smaller-title' });
  const say = el('p', { class: 'hint', role: 'status' });
  const about = [
    el('h3', { id: 'finder-smaller-title', text: x.name }),
    el('p', { text: `${x.file}: ${x.bits} bits a weight instead of ${x.bitsNow}, so it sits wholly on the card with ${x.leftGb} GB left free.` }),
    el('p', { class: 'hint', text: `About ${fNum(x.expect)} tokens a second writing by the sums (${fNum(x.now)} now). Fewer bits can make answers a little weaker: test it before your staff use it.` }),
  ];
  const testIt = () => app.openFinder(finder.t.pc === 'here' ? x.have : `remote:${finder.t.pc}:${x.have}`, { name: x.file, pcName: finder.t.pcName });
  const offer = () => box.replaceChildren(...about, x.have
    ? el('div', { class: 'team-actions' }, el('p', { class: 'hint', text: `It is on ${fWhere()} already.` }), el('button', { class: 'btn', type: 'button', text: 'Find the fastest setup for it', onclick: testIt }))
    : el('div', { class: 'team-actions' }, el('button', { class: 'btn', type: 'button', text: `Download… (${fGB(x.bytes)})`, onclick: confirm })), say);
  function confirm() {
    const go = el('button', { class: 'btn primary', type: 'button', text: `Download (${fGB(x.bytes)})`, onclick: async () => {
      go.disabled = true;
      try {
        say.textContent = (await finderAsk('smaller', { yes: true, repo: x.repo, rev: x.rev, name: x.file, bytes: x.bytes, size: finder.size })).said;
        go.remove();
      } catch (e) {
        say.textContent = e.message;
        go.disabled = false;
      }
    } });
    box.replaceChildren(...about,
      el('ul', { class: 'finder-info' },
        el('li', {}, el('span', { class: 'hint', text: 'File: ' }), x.file),
        el('li', {}, el('span', { class: 'hint', text: 'From: ' }), `${x.repo} on Hugging Face${x.licence ? ` (licence: ${x.licence})` : ''}`),
        el('li', {}, el('span', { class: 'hint', text: 'Download size: ' }), fGB(x.bytes)),
        el('li', {}, el('span', { class: 'hint', text: 'Downloads to: ' }), fWhere()),
        el('li', {}, 'The file you use now is kept, and no hire changes. Once it is here, test it with Find the fastest setup, then give it to a hire in Edit staff if you like it.')),
      el('div', { class: 'team-actions' }, go, el('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: offer })),
      say);
    go.focus();
  }
  offer();
  return box;
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
  // "now" empties only once the model is put back and the pick is made: before that, best and why are not filled in yet.
  if (run && run.state !== 'running' && !run.now) return finderResults(run, null);
  const rows = run?.rows ?? [];
  // How far it is: the rows timed (or failed) of those that will be tried; the time left from the plan's minutes.
  const planned = rows.filter(r => r.state !== 'not tried');
  const finished = planned.filter(r => r.state === 'done' || r.state === 'failed').length;
  const total = Math.max(planned.length, 1);
  const mins = finder.preview?.minutes?.[finder.size];
  const left = mins ? Math.max(1, Math.round(mins * (1 - finished / total))) : null;
  const who = finder.t.who;
  const specs = finderSpecs();
  finderFrame(
    el('div', { class: 'finder-card' },
      who ? app.avatar?.(who, (finder.t.staff || '?').slice(0, 2).toUpperCase()) : null,
      el('div', { class: 'finder-card-text' },
        who && finder.t.staff ? el('strong', { text: finder.t.staff }) : null,
        el('span', { text: finder.preview?.name || finder.t.model }),
        el('span', { class: 'hint', text: `${finder.t.pc === 'here' ? 'This PC' : finder.t.pcName}${specs ? ` · ${specs}` : ''}` }))),
    el('progress', { class: 'finder-bar', max: total, value: finished, 'aria-label': 'Test progress' }),
    el('p', { role: 'status', text: `${run?.now || 'Starting…'}${left ? ` About ${left} minute${left === 1 ? '' : 's'} left.` : ''}` }),
    el('details', { class: 'finder-tries' }, el('summary', { text: `Each setup (${finished} of ${total} timed)` }),
      el('ol', { class: 'finder-rows' }, ...rows.map(r => el('li', { class: `finder-row is-${r.state.replace(' ', '-')}` },
        el('span', { class: 'finder-mark', 'aria-hidden': 'true', text: STATE_MARK[r.state] ?? '' }),
        el('strong', { text: r.name || 'A setup' }),
        el('span', { class: 'hint', text: r.state === 'done' ? ` ${fNum(r.write)} tok/s writing` : r.state === 'failed' ? ` failed: ${r.why}` : r.state === 'not tried' ? ` ${r.why}` : r.state === 'running' ? ' being timed now' : '' }))))),
    el('p', { class: 'hint', text: 'You can close this window; the test continues in the background.' }),
    el('div', { class: 'team-actions' },
      el('button', { class: 'btn', type: 'button', text: 'Stop', onclick: async e => {
        e.target.disabled = true;
        await finderAsk('stop').catch(() => undefined);
      } }),
      el('button', { class: 'btn finder-right', type: 'button', text: 'Close', onclick: () => finderBox().close() })));
  finder.poll = setTimeout(finderWatch, 2000);
}

/** One row's more info: every figure, the setup in plain words, and why it was or was not recommended. */
function finderInfo(r, run) {
  const line = (k, v) => (v === null || v === undefined || v === '' ? null : el('li', {}, el('span', { class: 'hint', text: `${k}: ` }), String(v)));
  return el('ul', { class: 'finder-info' },
    line('Writing', r.write ? `${fNum(r.write)} tokens a second (the middle of ${r.state === 'done' ? 'two or three runs' : 'its runs'})` : null),
    line('Reading', r.read ? `${fNum(r.read)} tokens a second` : null),
    line('Copying (the second prompt\'s answer)', r.copy ? `${fNum(r.copy)} tokens a second` : null),
    line('Writing code (the third prompt)', r.code ? `${fNum(r.code)} tokens a second` : null),
    line('First word after', r.firstWord ? `${r.firstWord} s` : null),
    line('Loaded in', r.loadSeconds ? `${r.loadSeconds} s${r.slowLoad ? ' (read from disk: its figure may be low)' : ''}` : null),
    line('On the card', r.cardBytes ? fGB(r.cardBytes) : null),
    line('In RAM', r.ramBytes ? fGB(r.ramBytes) : null),
    line('Borrowed from RAM by the card', r.borrowed ? fGB(r.borrowed) : null),
    line('Card memory left free', r.cardFree !== null && r.cardFree !== undefined ? fGB(r.cardFree) : null),
    line('Guesses kept', r.accepted !== null && r.accepted !== undefined ? `${Math.round(r.accepted * 100)}%` : null),
    line('Same words as without the trick', r.sameWords === null || r.sameWords === undefined ? null : r.sameWords ? 'yes' : 'no'),
    line('Why it was tried', r.why && r.state === 'done' ? null : r.why),
    line('Recommended', run.best === r.id ? 'yes' : run.why?.[r.id] ? `no: ${run.why[r.id]}` : r.state === 'done' ? `no: ${slowerThan(r, run)}` : null));
}

/** Why a timed row was not picked when no fault was found: slower than the one recommended (or the fastest). */
function slowerThan(r, run) {
  const best = run.rows.find(x => x.id === run.best && x.state === 'done');
  return best?.write ? `slower (${fNum(r.write)} against ${fNum(best.write)} tok/s for the recommended one)` : 'another was faster';
}

/** How a timed row's writing speed compares with the fastest timed row: the fastest, within 30% of it, or further behind. */
function speedBand(r, run) {
  if (r.state !== 'done' || !r.write) return r.state === 'failed' ? 'slow' : '';
  const top = Math.max(...run.rows.filter(x => x.state === 'done' && x.write).map(x => x.write));
  return r.write >= top ? 'fastest' : r.write >= top * 0.7 ? 'near' : 'slow';
}

/** The results: the recommended row selected, more info on each, Go with this config, Undo. */
function finderResults(run, undo) {
  clearTimeout(finder.poll);
  let picked = run.best ?? run.rows.find(r => r.state === 'done')?.id ?? null;
  const say = el('p', { class: 'hint', id: 'finder-say', role: 'status', text: run.said || '' });
  const go = el('button', { class: 'btn primary', type: 'button', text: 'Go with this config', onclick: async () => {
    // After a hire (ask), the chat with them opens once this window closes (team.js afterHire): Go ends here.
    if (picked === 'a') {
      if (finder.t.ask) return finderBox().close();
      say.textContent = 'That is the setup it has now: nothing to change.';
      return;
    }
    go.disabled = true;
    try {
      say.textContent = (await finderAsk('apply', { row: picked })).said;
      if (finder.t.ask) return finderBox().close();
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
    el('p', { role: 'status', text: run.state === 'stopped' ? 'Stopped: the rows done so far are below, and the model was put back as it was.' : run.state === 'failed' ? 'The test stopped part way. The model was put back as it was.' : run.keep ? 'Keep what you have: nothing tried was clearly faster.' : `Done. Recommended: ${run.rows.find(r => r.id === run.best)?.name || 'the one marked below'}. It is selected below.` }),
    run.best || run.rows[0]?.state === 'done' ? null : el('p', { class: 'hint', text: 'Nothing is recommended: what it has now was not measured, so there is nothing to compare with.' }),
    run.drift ? el('p', { class: 'hint fault-line', text: 'The PC\'s speed changed during the test (something else was running?): the figures are less certain.' }) : null,
    el('div', { class: 'finder-results', role: 'radiogroup', 'aria-label': 'Setups' }, ...run.rows.map(r => {
      const mark = run.best === r.id ? '★ recommended' : r.state === 'failed' ? '✗ failed' : r.tight ? '⚠ tight' : '';
      const radio = el('input', { type: 'radio', name: 'finder-pick', value: r.id, checked: r.id === picked, disabled: r.state !== 'done', onchange: () => { picked = r.id; } });
      const more = el('details', { class: 'finder-more' }, el('summary', { text: 'more info' }), finderInfo(r, run));
      const band = speedBand(r, run);
      return el('div', { class: `finder-result${run.best === r.id ? ' is-best' : ''}${band ? ` is-${band}` : ''}` },
        el('label', { class: 'check' }, radio, ' ', el('strong', { text: r.name })),
        el('span', { class: 'finder-fig', text: r.state === 'done' ? `${fNum(r.write)} tok/s writing${r.code ? ` · ${fNum(r.code)} on code` : ''}${r.copy && (r.run.spec || r.run.draft) ? ` · ${fNum(r.copy)} copying` : ''}` : r.state === 'failed' ? `failed: ${r.why}` : r.why }),
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
  finder.t = { ...t, name: o.name ?? '', pcName: o.pcName ?? '', ask: o.ask === true, who: o.who ?? '', staff: o.who ? o.name ?? '' : '' };
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
 * After a hire on a chat model: the Quick test's minutes when it has never been through the test, for the "X is hired"
 * window (team.js) to offer it; null when it was tested, is being tested, or that PC cannot run it (an older TOMLIN, or
 * its owner has not ticked it). Nothing runs from here.
 */
app.finderOffer = async ref => {
  const t = finderTarget(ref);
  if (!t) return null;
  finder.t = { ...t, name: '', pcName: '', ask: true };
  try {
    const p = await finderAsk('preview', { size: 'quick' });
    return p.last || p.found || p.running ? null : { minutes: p.minutes?.quick ?? null };
  } catch {
    return null;
  }
};
