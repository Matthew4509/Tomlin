// The PC status grid: every linked PC as one small cell, its status mark then its name, in "Models on my other PCs"
// (network.js) and on Network (home.js, Linked PCs). Green: up to date and well. Yellow: working, an older TOMLIN. Red:
// a fault (the reason on hover and in the cell's line when pressed; a failed update has See progress and Retry). Grey:
// off or not answering. Turning: updating, copying or downloading now (what and how far in its tip). Hover or keyboard
// focus on a cell shows that PC's specs. A summary line on top counts each kind; pressing one shows only those.
// The words and states are worked out by plain functions (window.pcGrid), so the tests can run them without a page.
// Data: /api/nodes/others (each PC's hello), /api/network/transfers (copies and updates), and the left panel's PCs
// (homeUi.pcs: the computer name). Nothing here asks the server for anything new.
'use strict';
(() => {
  const GiB = 2 ** 30;
  const size = n => (n >= GiB ? `${(n / GiB).toFixed(n >= 10 * GiB ? 0 : 1)} GB` : n >= 2 ** 20 ? `${Math.round(n / 2 ** 20)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  /** What each state is called: in the summary, in a cell's tip, and for a screen reader (colour is never the only sign). */
  const WORDS = { ok: 'up to date', busy: 'updating', old: 'outdated', error: 'with a fault', off: 'off' };
  const ORDER = ['ok', 'busy', 'old', 'error', 'off'];
  /** What a transfer is doing, as a short line in a cell's tip. */
  const DOING = { update: 'Updating to', pull: 'Giving this PC', copy: 'Copying here', send: 'Receiving', move: 'Receiving', backup: 'Keeping a restore point', bring: 'Sending back a restore point', projects: 'Backing up projects', restore: 'Sending projects back', fetch: 'Downloading', runner: 'Receiving the runner' };

  /** How far a transfer is: "1.2 GB of 4.0 GB (30%)", or what it waits for. */
  function howFar(t) {
    if (t.queued) return 'waiting its turn';
    if (!t.bytes) return t.kind === 'update' ? 'comparing the files' : 'starting';
    if (t.done >= t.bytes) return t.kind === 'update' ? `${size(t.bytes)} sent, starting it there` : `${size(t.bytes)}, finishing`;
    return `${size(t.done)} of ${size(t.bytes)} (${Math.floor((t.done / t.bytes) * 100)}%)`;
  }

  /**
   * One PC's state from its hello and the transfers: { state, word, why, doing, failed }. `failed` is the last update to it
   * that did not finish, while it is still behind (the cell offers See progress and Retry).
   */
  function stateOf(p, transfers = []) {
    const mine = transfers.filter(t => t.pc === p.id);
    const going = mine.filter(t => t.state === 'working');
    const doing = going.map(t => `${DOING[t.kind] ?? 'Working on'} ${t.what ? `${t.what}: ` : ''}${howFar(t)}`);
    // Newest first, as the server lists them (src/carry.ts Transfers).
    const lastUpdate = mine.find(t => t.kind === 'update');
    const failed = !going.length && lastUpdate && (lastUpdate.state === 'failed' || lastUpdate.state === 'stopped') && (p.update || !p.ok) ? lastUpdate : null;
    if (going.length || p.updating) return { state: 'busy', word: going.every(t => t.kind === 'update') ? 'Updating' : 'Busy', why: '', doing: doing.length ? doing : [`Updating to ${p.updating.what}`], failed: null };
    if (failed) return { state: 'error', word: 'Update did not finish', why: failed.said || 'the update stopped', doing: [], failed };
    if (!p.ok && (p.relink || p.answered)) return { state: 'error', word: p.relink ? 'Not linked any more' : 'Refused', why: p.error || 'it answered but refused this PC', doing: [], failed: null };
    if (!p.ok) return { state: 'off', word: 'Off or not answering', why: p.seenAt ? `last seen ${new Date(p.seenAt).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}` : '', doing: [], failed: null };
    if (p.away) return { state: 'off', word: 'Stepped aside for now', why: 'its owner is using it', doing: [], failed: null };
    if (p.update) return { state: 'old', word: 'Older TOMLIN', why: p.update.why ? `${p.update.why}` : `runs ${p.version ?? 'an older version'}, this PC ${p.update.mine ?? 'a newer one'}`, doing: [], failed: null };
    return { state: 'ok', word: 'Up to date', why: '', doing: [], failed: null };
  }

  /** The summary line's counts, in order, zeros left out (the total always said): "100 PCs: 92 up to date, 5 updating, …". */
  function summary(states) {
    const n = states.length;
    const count = Object.fromEntries(ORDER.map(k => [k, states.filter(s => s.state === k).length]));
    const parts = ORDER.filter(k => count[k]).map(k => ({ state: k, count: count[k], text: `${count[k]} ${k === 'busy' && states.some(s => s.state === 'busy' && s.word !== 'Updating') ? 'busy' : WORDS[k]}` }));
    return { head: `${n} PC${n === 1 ? '' : 's'}`, parts, count };
  }

  /**
   * A PC's specs for its tip: computer name, processor and threads, RAM, graphics card and its memory, TOMLIN version,
   * free space on its models drive, the model loaded, what it is doing now. Only what it has told this PC.
   */
  function specLines(p, computer, st) {
    const total = bar => (bar?.segments ?? []).reduce((n, s) => n + s.bytes, 0);
    const ram = p.memory?.ram?.total ?? total(p.memory?.ram?.bar);
    const gpu = p.memory?.gpu;
    const vram = gpu?.total ?? total(gpu?.bar);
    const drive = p.modelsDrive ? (p.drives ?? []).find(d => d.drive === p.modelsDrive) : null;
    const room = drive ?? p.disk ?? null;
    return [
      `${st.word}${st.why ? `: ${st.why}` : ''}`,
      computer ? `Computer name: ${computer}` : null,
      p.cpu?.name || p.cpu?.cores ? `Processor: ${p.cpu.name || 'not named'}${p.cpu.cores ? `, ${p.cpu.cores} cores` : ''}${p.cpu.threads > (p.cpu.cores ?? 0) ? `, ${p.cpu.threads} threads` : ''}` : null,
      ram ? `RAM: ${size(ram)}` : null,
      gpu?.name ? `Graphics card: ${gpu.name}${vram ? `, ${size(vram)}` : ''}` : null,
      p.version ? `TOMLIN ${p.version}${p.build ? ` (build ${p.build})` : ''}` : null,
      room?.free != null ? `Free on its models drive${drive ? ` (${drive.drive})` : ''}: ${size(room.free)}` : null,
      p.ok ? `Model loaded: ${p.model || p.image?.model || 'none'}` : null,
      ...st.doing.map(d => `Now: ${d}`),
    ].filter(Boolean);
  }

  /** The short tip (the Updating linked PCs window): its state, then CPU, RAM and GPU, one short line each. */
  function briefLines(p, st) {
    const total = bar => (bar?.segments ?? []).reduce((n, s) => n + s.bytes, 0);
    const ram = p.memory?.ram?.total ?? total(p.memory?.ram?.bar);
    const gpu = p.memory?.gpu;
    const vram = gpu?.total ?? total(gpu?.bar);
    const cpu = String(p.cpu?.name ?? '').replace(/\((R|TM)\)|\bCPU\b|@.*$/gi, '').replace(/\s+/g, ' ').trim();
    return [
      `${st.word}${st.why ? `: ${st.why}` : ''}`,
      cpu || p.cpu?.threads ? `CPU: ${cpu || 'not named'}${p.cpu?.threads ? `, ${p.cpu.threads} threads` : ''}` : null,
      ram ? `RAM: ${size(ram)}` : null,
      gpu?.name ? `GPU: ${gpu.name.replace(/^NVIDIA\s+/i, '')}${vram ? `, ${size(vram)}` : ''}` : p.memory ? 'GPU: none' : null,
    ].filter(Boolean);
  }

  const pcGrid = { stateOf, summary, specLines, briefLines, howFar, WORDS, ORDER };
  if (typeof window !== 'undefined') window.pcGrid = pcGrid;

  // ---- Drawing (only in the page: the tests above need none of it) ----
  if (typeof document === 'undefined') return;
  /** Puts a cell's tip under it (above it when there is no room below), kept inside the window's edges. */
  function placeTip(cell, tip) {
    const r = cell.getBoundingClientRect();
    tip.style.visibility = 'hidden';
    tip.style.display = 'block';
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    tip.style.display = '';
    tip.style.visibility = '';
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    const below = r.bottom + 4 + h <= window.innerHeight - 8;
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(below ? r.bottom + 4 : Math.max(8, r.top - 4 - h))}px`;
  }

  /** Each grid on screen: its filter (a state, or '') and the cell opened, kept across the redraws. */
  const held = new Map();

  /**
   * Draws the grid into `host` for `pcs` (as /api/nodes/others gives them) and `transfers`. `name(p)` is the name to show
   * (two PCs of one name are told apart), `computer(p)` the computer's own name, `onChanged` reads again after an action.
   */
  pcGrid.draw = (host, pcs, transfers, { name = p => p.name, computer = () => '', onChanged = () => undefined, brief = false } = {}) => {
    const key = host.id;
    const keep = held.get(key) ?? { filter: '', open: '', said: {} };
    held.set(key, keep);
    if (!pcs.length) return void host.replaceChildren();
    const rows = pcs.map(p => ({ p, st: stateOf(p, transfers) }));
    const sum = summary(rows.map(r => r.st));
    if (keep.filter && !sum.count[keep.filter]) keep.filter = '';
    const redraw = () => pcGrid.draw(host, pcs, transfers, { name, computer, onChanged, brief });
    // The summary: each count is a button that shows only those PCs (pressed again: all of them).
    const head = el('p', { class: 'pcg-sum' }, el('b', { text: `${sum.head}: ` }),
      ...sum.parts.flatMap((x, i) => [i ? ', ' : '', el('button', { class: `link pcg-pick pcg-${x.state}`, type: 'button', 'aria-pressed': String(keep.filter === x.state), title: keep.filter === x.state ? 'Show every PC again' : `Show only the PCs ${WORDS[x.state]}`, onclick: () => { keep.filter = keep.filter === x.state ? '' : x.state; redraw(); } },
        el('span', { class: 'pcg-mark', 'data-state': x.state, 'aria-hidden': 'true' }), x.text)]),
      keep.filter ? el('button', { class: 'link pcg-all', type: 'button', text: 'Show all', onclick: () => { keep.filter = ''; redraw(); } }) : '');
    // One button for every PC behind that can be updated now (each asks its own PIN unless it holds this admin PC's key).
    const can = pcs.filter(p => p.ok && p.update && !p.update.why && !p.updating);
    const all = can.length && typeof updateAllLinked === 'function' ? el('button', { class: 'btn primary pcg-update', type: 'button', text: `Update all outdated (${can.length})`, onclick: async e => { e.target.disabled = true; await updateAllLinked(); onChanged(); } }) : null;
    const shown = rows.filter(r => !keep.filter || r.st.state === keep.filter);
    const cells = shown.map(({ p, st }) => {
      const tipId = `pcg-tip-${key}-${p.id}`.replace(/[^\w-]/g, '_');
      const lines = brief ? briefLines(p, st) : specLines(p, computer(p), st);
      const cell = el('button', { class: 'pcg-cell', type: 'button', 'data-key': `pcg:${p.id}`, 'data-state': st.state, 'aria-describedby': tipId, 'aria-expanded': String(keep.open === p.id), onclick: () => { keep.open = keep.open === p.id ? '' : p.id; redraw(); } },
        el('span', { class: 'pcg-mark', 'data-state': st.state, 'aria-hidden': 'true' }),
        el('span', { class: 'sr-only', text: `${st.word}: ` }),
        el('span', { class: 'pcg-name', text: name(p) }));
      const tip = el('span', { class: 'pcg-tip', role: 'tooltip', id: tipId }, ...lines.map(l => el('span', { text: l })));
      // The tip floats over the page beside its cell (fixed, placed when shown), so showing it never moves or
      // squeezes anything, even inside a window that scrolls.
      const item = el('li', { class: 'pcg-item' }, cell, tip);
      const place = () => placeTip(cell, tip);
      item.addEventListener('mouseenter', place);
      cell.addEventListener('focus', place);
      return item;
    });
    // The cell pressed: its state and reason in a line under the grid, with what can be done about it.
    const open = rows.find(r => r.p.id === keep.open);
    let line = null;
    if (open) {
      const { p, st } = open;
      const acts = [];
      if (st.failed) {
        acts.push(el('button', { class: 'btn', type: 'button', text: 'See progress', onclick: () => app.openUpdate?.(st.failed) }));
        if (p.ok && typeof updatePcWithPin === 'function') acts.push(el('button', { class: 'btn primary', type: 'button', text: 'Retry', onclick: async e => { e.target.disabled = true; try { await updatePcWithPin({ id: p.id, name: p.name }); keep.said[p.id] = ''; } catch (err) { keep.said[p.id] = err.message; } onChanged(); } }));
      } else if (st.state === 'busy' && p.updating) acts.push(el('button', { class: 'btn', type: 'button', text: 'See progress', onclick: () => app.showUpdate?.(p.updating.id) }));
      else if (st.state === 'old' && !p.update?.why && typeof updatePcWithPin === 'function') acts.push(el('button', { class: 'btn primary', type: 'button', text: 'Update it', onclick: async e => { e.target.disabled = true; try { await updatePcWithPin({ id: p.id, name: p.name }); keep.said[p.id] = ''; } catch (err) { keep.said[p.id] = err.message; } onChanged(); } }));
      acts.push(el('button', { class: 'btn quiet', type: 'button', text: 'Open its window', onclick: () => { host.closest('dialog')?.close(); app.openPc?.(p.id); } }));
      line = el('div', { class: `pcg-open pcg-open-${st.state}`, role: st.state === 'error' ? 'alert' : 'status' },
        el('b', { text: `${name(p)}: ${st.word}` }), st.why ? el('span', { text: ` (${st.why})` }) : null, keep.said[p.id] ? el('span', { class: 'fault-line', text: ` ${keep.said[p.id]}` }) : null, ...st.doing.map(d => el('span', { class: 'hint', text: ` ${d}.` })),
        el('span', { class: 'pcg-acts' }, ...acts));
    }
    // Focus stays on the cell pressed (the grid is drawn again every few seconds).
    const had = host.contains(document.activeElement) ? document.activeElement.dataset?.key : null;
    host.replaceChildren(el('div', { class: 'pcg-top' }, head, all), el('ul', { class: 'pcg-grid', 'aria-label': 'Linked PCs and how each stands' }, ...cells), ...(line ? [line] : []));
    if (had) host.querySelector(`[data-key="${CSS.escape(had)}"]`)?.focus({ preventScroll: true });
  };
})();
