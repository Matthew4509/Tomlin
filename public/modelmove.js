// Before a model is deleted: where else it is held (other linked PCs, a Backups only PC), and Move as the other choice
// (copied to a linked PC, checked byte for byte, then removed here). The sums and the check are the server's
// (src/modelcopies.ts, POST /api/network/copies; src/jobrun/copies.ts moveTo, POST /api/network/move). Used by the Models
// lists (public/pcs.js) and Free up space (public/cleanup.js).
'use strict';
{
  const GBs = n => `${(n / 2 ** 30).toFixed(n >= 10 * 2 ** 30 ? 0 : 1)} GB`;

  /** { copies: { 'chat:id': { words, ask, held, only, unchecked, places } }, targets, refused } for models of a PC ('here' or a linked PC's id); null when it could not be read. */
  app.copiesFor = async (pc, models) => {
    try {
      return await api('/api/network/copies', { pc, models: models.map(m => ({ kind: m.kind, id: m.id })) });
    } catch {
      return null;
    }
  };

  /** The line that says where else a model is held ("not checked" when the answer could not be read). */
  app.copiesLine = (info, m) => info?.copies?.[`${m.kind}:${m.id}`]?.summary ?? 'Other copies: not checked (TOMLIN could not read the other PCs just now).';

  /** The question's sentence for a delete: the copies lines, or "not checked" when they could not be read. */
  app.copiesAsk = (info, m) => info?.copies?.[`${m.kind}:${m.id}`]?.ask ?? 'Other copies: not checked (TOMLIN could not read the other PCs just now), so this may be the only one.';

  /** Follows a started move until it ends: calls `done(transfer)` (the transfer as the server last said it). */
  app.followMove = (transfer, done) => {
    const tick = async () => {
      let t = null;
      try {
        t = (await api('/api/network/transfers')).transfers.find(x => x.id === transfer.id) ?? null;
      } catch {
        // TOMLIN did not answer just now: try again.
      }
      if (t && t.state === 'working') return void setTimeout(tick, 3000);
      done(t ?? { ...transfer, state: 'failed', said: 'TOMLIN was restarted while it moved, so nothing was removed from this PC. Look at Models: if it is on both PCs, delete it here.' });
    };
    setTimeout(tick, 3000);
  };

  /**
   * Asks which PC to move a model of this PC to, and starts the move. `box`: the ask box. Returns { transfer } when it started,
   * { said } when nothing was started (with why), or null when the person kept it.
   */
  app.moveAsk = async (box, m, info, opts = {}) => {
    info ??= await app.copiesFor('here', [m]);
    if (!info) return { said: 'TOMLIN could not read the linked PCs just now, so nothing was moved. Try again.' };
    if (!info.targets.length) {
      const why = info.refused.length ? ` ${info.refused.map(r => `"${r.name}": ${r.why}.`).join(' ')}` : ' No other PC is linked to this one.';
      return { said: `${m.name} cannot be moved now.${why}` };
    }
    const pick = await askTiles(box, m, info, `Move ${m.name} to another PC?\n(Moving is a way to retain a copy while freeing up space on a device)`, opts.copy !== false);
    if (!pick) return null;
    const target = info.targets.find(t => t.id === pick.id);
    return pick.copy ? startCopy(m, target) : startMove(m, target);
  };

  /** One tile per PC that can take the model: its name, what it is, its free space, then Move here and Copy here. */
  function askTiles(box, m, info, text, withCopy) {
    return new Promise(done => {
      const end = value => {
        box.replaceChildren();
        box.hidden = true;
        box.classList.remove('move-ask');
        done(value);
      };
      const held = t => info.copies?.[`${m.kind}:${m.id}`]?.places?.some(p => p.pc === t.id && p.state === 'has');
      const tile = t => {
        const specs = [t.ram ? `${GBs(t.ram)} RAM` : '', t.gpu ? `${t.gpu.replace(/^(NVIDIA|AMD)\s+/i, '')}${t.vram ? ` ${GBs(t.vram)}` : ''}` : (t.ram ? 'no graphics card' : '')].filter(Boolean).join(' · ');
        const noRoom = t.disk && t.disk.free < m.bytes && !held(t);
        const go = (label, copy) => el('button', { class: `btn ${copy ? '' : 'primary'}`, type: 'button', text: label, disabled: !!noRoom, onclick: () => end({ id: t.id, copy }) });
        return el('div', { class: 'move-tile' },
          el('strong', { text: t.name }),
          el('span', { class: 'hint', text: specs || 'Specs not known yet' }),
          // The drive the model would be written to there (its models folder's); an older PC: the one drive it says.
          el('span', { class: noRoom ? 'hint fault-line' : 'hint', text: t.disk ? `Free space${t.disk.drive ? ` on ${t.disk.drive}` : ''}: ${GBs(t.disk.free)}${noRoom ? ' (not enough)' : ''}` : 'Free space: not known' }),
          held(t) ? el('span', { class: 'hint', text: 'Already has a copy' }) : null,
          el('div', { class: 'team-actions' }, go('Move here', false), ...(withCopy ? [go('Copy here', true)] : [])));
      };
      app.askFor?.(box, () => end(null));
      box.classList.add('page-ask', 'move-ask');
      box.setAttribute('role', 'alert');
      box.replaceChildren(el('span', { text }), el('div', { class: 'move-tiles' }, ...info.targets.map(tile)), el('button', { class: 'btn quiet', type: 'button', text: 'Keep it here', onclick: () => end(null) }));
      box.hidden = false;
      box.querySelector('.move-tile button')?.focus();
    });
  }

  async function startMove(m, target) {
    try {
      const r = await api('/api/network/move', { pc: target.id, kind: m.kind, model: m.id });
      return { transfer: r.transfer, to: target.name };
    } catch (e) {
      return { said: e.message };
    }
  }

  /** Copy here: the same send as "Send a copy"; nothing is removed from this PC. */
  async function startCopy(m, target) {
    try {
      const r = await api('/api/network/send', { pc: target.id, kind: m.kind, model: m.id });
      return { transfer: r.transfer, to: target.name, copy: true };
    } catch (e) {
      return { said: e.message };
    }
  }

  /**
   * The question before a delete: where else the model is held, then Delete or (a model of this PC) Move to each PC that can
   * take it. `m`: { kind, id, name, bytes }; `pc`: 'here' or the linked PC's id; `text`: the question without the copies lines.
   * Returns 'delete', { transfer, to } or { said } for a move, or null when the person kept it.
   */
  app.deleteAsk = async (box, m, { pc = 'here', text, yes, info = null }) => {
    info ??= await app.copiesFor(pc, [m]);
    const moves = pc === 'here' && info ? info.targets : [];
    const choice = await askPick(box, `${text} ${app.copiesAsk(info, m)}${moves.length ? ' Or move it: it is copied to another PC, checked byte for byte, and only then removed from this PC.' : ''}`, [{ label: yes, value: 'delete', danger: true }, ...moves.map(t => ({ label: `Move to ${t.name}`, value: t.id, danger: false }))], 'Keep it');
    if (!choice) return null;
    if (choice === 'delete') return 'delete';
    return startMove(m, moves.find(t => t.id === choice));
  };
}
