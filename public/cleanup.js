// Free up space: a window that lists the models used least on a PC (one per kind: chat, code, pictures, then more until
// there is room), all that are installed, and the ones ticked to go. Opened from "Free up space" on the models lists
// (This PC and a linked PC) and from the "not enough room" message when a model cannot be installed. The ranking is done
// by the server (src/cleanup.ts, POST /api/cleanup); a model goes only when ticked and confirmed, one at a time, through
// the same Delete as the models list (POST /api/models/delete). A linked PC's models go the same way over the link
// (POST /api/network/model-remove): its app lock PIN is asked once, when Remove is pressed and the warnings are agreed,
// and used for each ticked model; only a real block (off, its tick not set, a wrong PIN) is said, in one line.
'use strict';
{
  const GB = 2 ** 30;
  // --- math (the same as tally() and tallyWords() in src/cleanup.ts; test/cleanup.test.ts runs both and compares) ---
  const gbWords = n => (n <= 0 ? '0 GB' : n >= GB ? `${(n / GB).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 2 ** 20))} MB`);
  const tally = (ticked, free, wanted, spare = 2 * GB) => {
    const freed = ticked.reduce((n, r) => n + r.bytes, 0);
    const need = wanted === null ? 0 : wanted + spare;
    const left = Math.max(0, need - free - freed);
    return { need, free, freed, left, enough: wanted === null ? freed > 0 : left === 0 };
  };
  const tallyWords = t => `${t.need ? `Needs ${gbWords(t.need)}, ` : ''}free ${gbWords(t.free)}, freed so far ${gbWords(t.freed)}`;
  // --- end math ---
  app.cleanupMath = { tally, tallyWords, gbWords };

  const CAT_WORDS = { chat: 'Chat', code: 'Code', pictures: 'Pictures' };
  const dlg = $('#cleanup-dlg');
  let st = null;

  const ago = (at, now) => {
    const d = Math.floor(Math.max(0, now - at) / 86_400_000);
    return d < 1 ? 'today' : d === 1 ? 'yesterday' : d < 60 ? `${d} days ago` : `${Math.floor(d / 30)} months ago`;
  };
  /** Models on more than one drive: each drive's free space ("C: 201.8 GB free of 476.0 GB; D: ..."), else ''. */
  const drivesWords = d => (d.drives?.length > 1 ? d.drives.map(x => `${x.drive} ${gbWords(x.free)} free of ${gbWords(x.total)}`).join('; ') : '');
  /** Whether removing `r` makes room on the drive a wanted model goes to (src/cleanup.ts onDrive, the same rule). */
  const onDrive = (r, drive) => !drive || !r.drive || r.drive === drive;
  const usedWords = (r, now) => (r.recorded ? `last used ${ago(r.sortAt, now)}` : r.sortAt ? `not used since install (${ago(r.sortAt, now)})` : 'not used since install');

  function say(text, fault = false) {
    const p = $('#cleanup-said');
    p.textContent = text;
    p.hidden = !text;
    p.classList.toggle('fault-line', fault);
  }

  /** One model's row: tick box, name, size, last used, and why it cannot go (if it cannot). */
  function row(r) {
    const box = el('input', { type: 'checkbox', 'data-id': r.id, disabled: !!r.block, 'aria-label': `Remove ${r.name}` });
    box.checked = st.sel.has(r.id);
    box.addEventListener('change', () => {
      if (box.checked) st.sel.add(r.id);
      else st.sel.delete(r.id);
      sync();
    });
    const notes = [r.block, r.only ? 'only one of its kind' : ''].filter(Boolean).join('; ');
    // Where else it is held (other linked PCs, a Backups only PC), and for this PC's models, Move: copied to a linked PC,
    // checked, then removed here.
    const move = st.data.pc === 'here' && !r.block && !r.ollama
      ? el('button', { class: 'btn quiet', type: 'button', text: 'Move', title: `Copy ${r.name} to a linked PC, check the copy, then remove it from this PC`, disabled: st.working, onclick: () => moveRow(r) })
      : null;
    // The left: the name and kind, then when it was last used. The right: Move, then where else it is held.
    const held = st.info?.copies?.[`${r.kind}:${r.id}`];
    return el('li', { class: `cleanup-row${r.block ? ' blocked' : ''}` },
      el('label', {}, box,
        el('span', { class: 'cleanup-name' }, el('strong', { text: r.name }), el('span', { class: 'hint', text: ` ${CAT_WORDS[r.cat]}${r.drive && st.data.drives?.length > 1 ? `, on ${r.drive}` : ''}` })),
        el('span', { class: 'cleanup-size', text: app.cleanupMath.gbWords(r.bytes) }),
        el('span', { class: 'cleanup-used hint', text: usedWords(r, st.data.now) })),
      el('div', { class: 'cleanup-side' }, move, el('span', { class: 'hint cleanup-copies', text: held?.only ? 'Only copy' : app.copiesLine(st.info, r) })),
      notes ? el('p', { class: 'hint cleanup-note', text: notes }) : null);
  }

  /** Move one model of this PC to a linked PC (the question, the start, then what became of it). */
  async function moveRow(r) {
    if (st.working) return;
    // The tiles open under "Approved to remove": click Move, then pick the PC.
    const res = await app.moveAsk($('#cleanup-move'), r, st.info, { copy: false });
    if (!res) return;
    if (res.said) return say(res.said, true);
    say(`Moving ${r.name} to "${res.to}". It stays on this PC until the copy there is checked; the progress is under Network, Models on my other PCs.`);
    app.followMove(res.transfer, async t => {
      const wanted = st.data?.wanted ?? null;
      const onChanged = st.onChanged;
      try {
        await load(st.data.pc, wanted);
      } catch (e) {
        say(e.message, true);
      }
      st.onChanged = onChanged;
      if (typeof modelListsChanged === 'function') modelListsChanged();
      await onChanged?.();
      say(t.state === 'done' ? t.said : `${t.state === 'stopped' ? 'Stopped' : 'Not moved'}: ${t.said}`, t.state !== 'done');
    });
  }

  /** Whether another PC (or a backup) holds a copy of this model: the safe ones to remove. */
  const hasCopy = r => (st.info?.copies?.[`${r.kind}:${r.id}`]?.held ?? 0) > 0;
  /** "Show models that have copies elsewhere": on, both lists show only those. Kept while the window stays open. */
  let copiesOnly = false;
  /** The kinds shown in All installed: '' every one, else 'standard' (chat and code), 'images' or 'video'. */
  let kindsShown = '';
  const KIND_GROUPS = [
    { key: 'standard', title: 'Standard', has: r => r.cat === 'chat' || r.cat === 'code', none: 'No chat or code models here.' },
    { key: 'images', title: 'Images', has: r => r.cat === 'pictures', none: 'No picture models here.' },
    // Video models are not in this list yet: TOMLIN cannot remove them from a PC (they stay in their own folder).
    { key: 'video', title: 'Video', has: () => false, none: 'Video models are not listed here yet: TOMLIN cannot remove them.' },
  ];
  for (const b of dlg.querySelectorAll('.cleanup-kinds button')) {
    b.addEventListener('click', () => {
      kindsShown = b.dataset.kinds;
      for (const x of dlg.querySelectorAll('.cleanup-kinds button')) x.setAttribute('aria-pressed', String(x === b));
      if (st) drawLeft();
    });
  }

  function drawLeft() {
    const by = new Map(st.data.rows.map(r => [r.id, r]));
    const keep = r => !copiesOnly || hasCopy(r);
    const sug = st.data.ids.map(id => by.get(id)).filter(Boolean).filter(keep);
    const all = [...st.data.rows].filter(keep).sort((a, b) => a.name.localeCompare(b.name));
    const btn = $('#cleanup-copied');
    const n = st.data.rows.filter(hasCopy).length;
    btn.setAttribute('aria-pressed', String(copiesOnly));
    btn.disabled = !st.info;
    btn.textContent = `Show models that have copies elsewhere${st.info ? ` (${n})` : ''}`;
    const noneCopied = 'No model here has a copy on another PC.';
    $('#cleanup-suggested').replaceChildren(...(sug.length ? sug.map(row) : [el('li', { class: 'hint', text: copiesOnly ? noneCopied : 'Nothing to suggest: every model is in use, hidden, or the only one of its kind.' })]));
    // All installed, in groups: Standard, Images, Video (one group when a filter is pressed).
    const groups = KIND_GROUPS.filter(g => !kindsShown || g.key === kindsShown).map(g => {
      const rows = all.filter(g.has);
      return el('section', { class: 'cleanup-group', 'aria-label': g.title },
        el('h4', { text: g.title }),
        el('ul', { class: 'cleanup-list' }, ...(rows.length ? rows.map(row) : [el('li', { class: 'hint', text: copiesOnly && g.key !== 'video' ? noneCopied : g.none })])));
    });
    $('#cleanup-all').replaceChildren(...groups);
  }

  const chosen = () => st.data.rows.filter(r => st.sel.has(r.id));

  /** The right side, the numbers and the buttons, from what is ticked now. */
  function sync() {
    for (const b of dlg.querySelectorAll('input[data-id]')) b.checked = st.sel.has(b.dataset.id);
    const picked = chosen();
    const wanted = st.data.wanted ? st.data.wanted.bytes : null;
    const free = st.data.disk ? st.data.disk.free : 0;
    // A model to install: only what is ticked on its drive makes room for it.
    const drive = wanted !== null ? st.data.drive : '';
    const counted = picked.filter(r => onDrive(r, drive));
    const elsewhere = picked.filter(r => !onDrive(r, drive));
    const t = tally(counted, free, wanted, st.data.spare);
    $('#cleanup-chosen').replaceChildren(...(picked.length ? picked.map(r => el('li', {}, el('span', { text: r.name }), el('span', { class: 'cleanup-size', text: gbWords(r.bytes) }))) : [el('li', { class: 'hint', text: 'Nothing ticked. Tick the models to remove.' })]));
    $('#cleanup-tally').textContent = st.data.disk ? tallyWords(t) : `Free space is not known; freed so far ${gbWords(t.freed)}`;
    const canDelete = st.data.canDelete;
    const unknown = !st.data.disk;
    $('#cleanup-remove').disabled = !canDelete || !picked.length || (wanted !== null && !unknown && !t.enough) || st.working;
    // "Remove anyway": only when a model is wanted and what is ticked does not make room, and the person only wants space.
    const any = $('#cleanup-anyway');
    any.hidden = !canDelete || wanted === null || t.enough || unknown;
    any.disabled = !picked.length || st.working;
    const other = elsewhere.length ? ` Removing ${elsewhere.map(r => `${r.name} (on ${r.drive})`).join(', ')} frees nothing on ${drive}.` : '';
    $('#cleanup-left').textContent = `${wanted !== null && !t.enough && picked.length && !unknown ? `${gbWords(t.left)} more is needed.` : ''}${other}`.trim();
  }

  function head() {
    const d = st.data;
    const lines = [];
    if (d.wanted) {
      const why = d.disk ? `${d.wanted.name} (${gbWords(d.wanted.bytes)}) has not got room on ${d.name}${d.drive ? ` (drive ${d.drive})` : ''}: ${gbWords(d.disk.free)} is free, and ${gbWords(d.spare)} is kept free after the install, so ${gbWords(d.short)} more is needed.` : `${d.wanted.name} is ${gbWords(d.wanted.bytes)}; how much room ${d.name} has is not known.`;
      lines.push(d.short > 0 || !d.disk ? `Insufficient room: ${why}` : `${d.wanted.name} (${gbWords(d.wanted.bytes)}) fits now: ${gbWords(d.disk.free)} is free.`);
    } else if (drivesWords(d)) lines.push(`${d.name}: ${drivesWords(d)}. A model frees room only on its own drive. Tick the models to remove; the ones used least are suggested.`);
    else lines.push(d.disk ? `${d.name}: ${gbWords(d.disk.free)} free of ${gbWords(d.disk.total)}. Tick the models to remove; the ones used least are suggested.` : `${d.name}: the free space is not known. Tick the models to remove; the ones used least are suggested.`);
    if (d.wanted && !d.covers) lines.push('All the suggested models together would not make enough room: tick more from "All installed".');
    if (!d.canDelete) lines.push(d.why);
    $('#cleanup-head').replaceChildren(...lines.map((t, i) => el('p', { class: i === 0 && d.wanted && d.short > 0 ? 'fault-line' : 'hint', text: t })));
  }

  async function load(pc, wanted) {
    const data = await api('/api/cleanup', { pc, wanted: wanted ?? undefined });
    const info = data.rows.length ? await app.copiesFor(data.pc, data.rows) : null;
    st = { data, info, sel: new Set(data.ticked), working: false, onChanged: st?.onChanged };
    $('#cleanup-title').textContent = data.pc === 'here' ? 'Free up space on this PC' : `Free up space on ${data.name}`;
    head();
    drawLeft();
    sync();
  }

  let busy = false;

  /** The removal screen (like the update screen): the list steps aside while models go, then it says what was freed. */
  function showResult(on) {
    for (const s of ['#cleanup-head', '.cleanup-bar', '.cleanup-cols']) dlg.querySelector(s).hidden = on;
    $('#cleanup-result').hidden = !on;
    $('#cleanup-close').disabled = on && busy;
  }

  /** One step per model: later (waiting), now (going), done, failed; each with a mark as well as its colour. */
  function drawSteps(steps, title, line, finished) {
    $('#cleanup-result-title').textContent = title;
    $('#cleanup-result-steps').replaceChildren(...steps.map(s => el('li', { class: `upd-${s.state}`, 'aria-current': s.state === 'now' ? 'step' : null },
      el('span', { class: 'upd-mark', 'aria-hidden': 'true', text: { done: '✓', now: '●', failed: '✕', later: '○' }[s.state] }),
      el('span', { text: s.text }))));
    $('#cleanup-result-line').textContent = line;
    $('#cleanup-result-done').hidden = !finished;
    if (finished) $('#cleanup-result-done').focus();
  }

  async function removeSelected() {
    const picked = chosen();
    if (!picked.length || st.working) return;
    const total = picked.reduce((n, r) => n + r.bytes, 0);
    const remote = st.data.pc !== 'here';
    const files = picked.map(r => (r.files?.length ? `${r.name} (${r.files.join(', ')})` : r.name)).join('; ');
    // Staff on them (this PC's, and that PC's own), before anything is asked.
    const staffed = picked.map(r => st.info?.copies?.[`${r.kind}:${r.id}`]).map((c, k) => (c?.staff ? `${picked[k].name}: ${c.staff} ${c.staffWarning}` : '')).filter(Boolean).join(' ');
    // Say before it goes which of them has no other copy that was found (or could not be checked).
    const alone = picked.filter(r => !st.info?.copies?.[`${r.kind}:${r.id}`]?.held).map(r => `${r.name}: ${app.copiesLine(st.info, r)}`);
    const lone = alone.length ? ` No other copy was found of ${alone.length === picked.length ? 'any of them' : 'some of them'}. ${alone.join(' ')}${st.data.pc === 'here' ? ' Keep them, then press Move… beside a model to keep one on another PC instead.' : ''}` : '';
    const ok = await askHere($('#cleanup-ask'), `Delete ${picked.length} model${picked.length > 1 ? 's' : ''} from ${st.data.name}? ${files}. This frees ${gbWords(total)} and cannot be undone.${staffed ? ` ${staffed}` : ''}${lone}${remote ? ` You are asked for the PIN of "${st.data.name}" next.` : ''}`, `Delete ${picked.length} model${picked.length > 1 ? 's' : ''}`, 'Keep them');
    if (!ok) return;
    st.working = true;
    busy = true;
    sync();
    const verb = remote ? 'Removing' : 'Deleting';
    const steps = picked.map(r => ({ state: 'later', text: r.name }));
    const redraw = () => drawSteps(steps, `${verb} ${picked.length} model${picked.length > 1 ? 's' : ''} on ${st.data.name}…`, 'Please wait: nothing else is needed from you here.', false);
    showResult(true);
    redraw();
    const gone = [];
    const failed = [];
    // A linked PC: its PIN is asked once, here, and used for each model; a wrong one is asked again, a cancel stops the rest.
    const doing = { button: 'Remove', about: `Removing models on another PC needs the PIN (or password) that opens TOMLIN on "${st.data.name}", typed here for this removal. It is checked there and not kept here.` };
    let nodePin;
    let stopped = false;
    for (const [k, r] of picked.entries()) {
      if (stopped) {
        failed.push(`${r.name}: not removed (no PIN given)`);
        steps[k] = { state: 'failed', text: `${r.name}: not removed (no PIN given)` };
        redraw();
        continue;
      }
      steps[k] = { state: 'now', text: `${verb} ${r.name} (${k + 1} of ${picked.length})…` };
      redraw();
      for (;;) {
        try {
          if (!remote) await api('/api/models/delete', { id: r.id, kind: r.kind });
          else {
            if (nodePin === undefined) {
              nodePin = await askAppPin('', st.data.name, doing);
              if (nodePin === null) throw Object.assign(new Error('not removed (no PIN given)'), { cancelled: true });
            }
            await api('/api/network/model-remove', { pc: st.data.pc, id: r.id, kind: r.kind, nodePin });
          }
          gone.push(r);
          steps[k] = { state: 'done', text: `${r.name}: ${remote ? 'removed' : 'deleted'}, ${gbWords(r.bytes)} freed` };
          break;
        } catch (e) {
          if (e.cancelled) {
            stopped = true;
            failed.push(`${r.name}: ${e.message}`);
            steps[k] = { state: 'failed', text: `${r.name}: ${e.message}` };
            break;
          }
          // Wrong PIN there (it counts the tries): asked again with its words; a cancel ends the removal.
          if (remote && e.data?.needNodePin) {
            const again = await askAppPin(e.message, st.data.name, doing);
            if (again === null) {
              stopped = true;
              failed.push(`${r.name}: ${e.message}`);
              steps[k] = { state: 'failed', text: `${r.name}: ${e.message}` };
              break;
            }
            nodePin = again;
            continue;
          }
          failed.push(`${r.name}: ${e.message}`);
          steps[k] = { state: 'failed', text: `${r.name}: ${e.message}` };
          break;
        }
      }
      redraw();
    }
    $('#cleanup-result-line').textContent = 'Checking what is free now…';
    const wanted = st.data.wanted;
    const onChanged = st.onChanged;
    try {
      await load(st.data.pc, wanted);
    } catch (e) {
      say(e.message, true);
    }
    st.onChanged = onChanged;
    if (typeof modelListsChanged === 'function') modelListsChanged();
    await onChanged?.();
    const freedNow = gone.reduce((n, r) => n + r.bytes, 0);
    const room = wanted && st.data.short === 0 ? ` There is room for ${wanted.name} now: start the download again.` : '';
    const left = drivesWords(st.data) ? ` ${st.data.name} now has ${drivesWords(st.data)}.` : st.data.disk ? ` ${st.data.name} now has ${gbWords(st.data.disk.free)} free of ${gbWords(st.data.disk.total)}.` : ` How much room ${st.data.name} has now is not known.`;
    const title = !gone.length ? `Nothing was ${remote ? 'removed' : 'deleted'}` : failed.length ? 'Finished, with problems' : 'Completed';
    busy = false;
    say('');
    drawSteps(steps, title, `${gone.length ? `${gbWords(freedNow)} freed.` : ''}${left}${room}`, true);
    $('#cleanup-close').disabled = false;
  }

  /**
   * Opens the window for a PC ('here' or a linked PC's id). `wanted` {name, bytes}: the model that did not fit.
   * `onChanged` runs after models were deleted (the list behind redraws).
   */
  app.openCleanup = async ({ pc = 'here', wanted = null, onChanged = null } = {}) => {
    st = { data: null, sel: new Set(), working: false, onChanged };
    copiesOnly = false;
    busy = false;
    showResult(false);
    say('');
    $('#cleanup-head').replaceChildren(el('p', { class: 'hint', text: 'Reading…' }));
    for (const id of ['cleanup-suggested', 'cleanup-all', 'cleanup-chosen']) $(`#${id}`).replaceChildren();
    $('#cleanup-tally').textContent = '';
    $('#cleanup-ask').hidden = true;
    if (!dlg.open) dlg.showModal();
    try {
      await load(pc, wanted);
    } catch (e) {
      $('#cleanup-head').replaceChildren(el('p', { class: 'fault-line', text: e.message }));
    }
  };

  /** A "Free up space" button for a failed install (the error from the server carries `room`). */
  app.cleanupButton = (room, pc = 'here') => el('button', { class: 'btn', type: 'button', text: 'Free up space', onclick: () => app.openCleanup({ pc, wanted: { name: room.name, bytes: room.bytes } }) });

  $('#cleanup-remove').addEventListener('click', removeSelected);
  $('#cleanup-anyway').addEventListener('click', removeSelected);
  $('#cleanup-close').addEventListener('click', () => dlg.close());
  $('#cleanup-copied').addEventListener('click', () => {
    copiesOnly = !copiesOnly;
    drawLeft();
  });
  // A question left open (Move, Remove) is called off with the window, so it is not waiting when the window opens again.
  dlg.addEventListener('close', () => {
    for (const id of ['cleanup-move', 'cleanup-ask']) {
      const box = $(`#${id}`);
      if (box && !box.hidden && box.cancelAsk) {
        const cancel = box.cancelAsk;
        box.cancelAsk = null;
        cancel();
      }
    }
  });
  // Back to the list (already read again, with what is left) from the removal screen; Esc cannot close it while models go.
  $('#cleanup-result-done').addEventListener('click', () => showResult(false));
  dlg.addEventListener('cancel', e => {
    if (busy) e.preventDefault();
  });
  $('#cleanup-untick').addEventListener('click', () => {
    st.sel.clear();
    sync();
  });
  $('#cleanup-suggest').addEventListener('click', () => {
    st.sel = new Set(st.data.ticked.length ? st.data.ticked : st.data.ids);
    sync();
  });
}
