// A3 + A4 (src/owner.ts): this PC's backup name and backup PIN on a linked PC that keeps its backups, and on a new PC
// "Get my backups" from one (the name with the backup PIN or a recovery code). On the backup PC: the owner's pop-up
// and the Network page's list, each with Allow / Don't allow.
'use strict';

/** "5 minutes ago", "2 hours ago", "3 days ago". */
function ownerAgo(iso) {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} minute${m > 1 ? 's' : ''} ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h > 1 ? 's' : ''} ago`;
  const days = Math.round(h / 24);
  return `${days} day${days > 1 ? 's' : ''} ago`;
}

const ownerField = (text, input) => el('label', { class: 'field' }, el('span', { text }), input);
const ownerPin = label => el('input', { type: 'password', inputmode: 'numeric', pattern: '[0-9 ]*', maxlength: '16', autocomplete: 'new-password', 'aria-label': label });

/**
 * The two rows under a linked PC in "Restore points" (network.js): Backup name and PIN (A3), and Get my backups (A4).
 * `bring` brings a restore point back through the window's own action (the usual check and Put back follow).
 */
app.ownerRows = (p, bring) => {
  const box = el('div', { class: 'net-list' });
  const said = el('p', { class: 'hint', role: 'status' });

  // ---- A3: Backup name and PIN ----
  const nameLine = el('span', { class: 'net-name hint', text: 'Backup name: reading…' });
  const setForm = el('div', { class: 'owner-form', hidden: true });
  const name = el('input', { type: 'text', maxlength: '40', autocomplete: 'off', 'aria-label': 'Backup name' });
  const pin = ownerPin('Backup PIN');
  const pin2 = ownerPin('The backup PIN again');
  const nudge = el('div', { class: 'owner-nudge', hidden: true });
  const save = async anyway => {
    nudge.hidden = true;
    try {
      const r = await api('/api/network/owner', { pc: p.id, name: name.value, pin: pin.value, pin2: pin2.value, ...(anyway ? { anyway: true } : {}) });
      if (r.same) {
        // Nothing is refused: the same PIN is kept only on "Keep it anyway".
        nudge.replaceChildren(el('p', { class: 'applock-warn', role: 'note', text: r.said }), el('div', { class: 'team-actions' },
          el('button', { class: 'btn primary', type: 'button', text: 'Use a different one', onclick: () => {
            nudge.hidden = true;
            pin.value = pin2.value = '';
            pin.focus();
          } }),
          el('button', { class: 'btn', type: 'button', text: 'Keep it anyway', onclick: () => save(true) })));
        nudge.hidden = false;
        return;
      }
      pin.value = pin2.value = '';
      setForm.hidden = true;
      said.textContent = r.said;
      drawName({ name: r.name });
    } catch (err) {
      said.textContent = err.message;
    }
  };
  setForm.append(
    el('p', { class: 'hint', text: `On a new PC, this name and PIN (or one of your recovery codes) get your backups back from "${p.name}". Its owner is asked first.` }),
    ownerField('Backup name (2 to 40 characters)', name),
    el('div', { class: 'team-actions' }, ownerField('Backup PIN (4 to 12 digits)', pin), ownerField('The backup PIN again', pin2)),
    nudge,
    el('div', { class: 'team-actions' }, el('button', { class: 'btn primary', type: 'button', text: 'Save it there', onclick: () => save(false) }), el('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: () => (setForm.hidden = true) })));
  const setBtn = el('button', { class: 'btn quiet', type: 'button', text: 'Set…', disabled: !p.ok, onclick: () => {
    setForm.hidden = false;
    name.focus();
  } });
  function drawName(v) {
    nameLine.textContent = v?.name ? `Backup name on "${p.name}": ${v.name}` : `Backup name and PIN: not set on "${p.name}" yet.`;
    setBtn.textContent = v?.name ? 'Change…' : 'Set…';
    if (v?.name) name.value = v.name;
  }
  api(`/api/network/owner?pc=${encodeURIComponent(p.id)}`).then(drawName, () => drawName(null));

  // ---- A4: Get my backups (on a new PC) ----
  const getForm = el('div', { class: 'owner-form', hidden: true });
  const gName = el('input', { type: 'text', maxlength: '40', autocomplete: 'off', 'aria-label': 'Your backup name' });
  const gSecret = el('input', { type: 'password', maxlength: '16', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Backup PIN or recovery code' });
  const state = el('div', { class: 'owner-state', role: 'status' });
  let timer = null;
  const stopWatch = () => {
    clearInterval(timer);
    timer = null;
  };
  /** Draws where the request stands; while it waits, asks again every 10 seconds (while the window is open). */
  function drawState(v) {
    if (!v?.state) return state.replaceChildren();
    const items = [el('p', { class: v.state === 'denied' || v.state === 'expired' ? 'fault' : 'hint', text: v.said })];
    if (v.state === 'allowed') {
      items.push(el('p', { class: 'hint', text: 'Then set your backup name and PIN from this PC (Set… above), so your new recovery codes go there too.' }));
      items.push(el('button', { class: 'btn primary', type: 'button', text: 'Bring back the newest restore point', onclick: async e => {
        e.target.disabled = true;
        try {
          const list = (await api(`/api/network/backups?pc=${encodeURIComponent(p.id)}`)).backups;
          if (!list.length) return void (said.textContent = `No restore points are kept on "${p.name}" under that name yet.`);
          const newest = [...list].sort((a, b) => b.name.localeCompare(a.name))[0];
          await bring(newest);
          said.textContent = 'Once it is here: Settings, Your data and updates, then Put back beside it. Your projects: Bring projects back.';
        } catch (err) {
          said.textContent = err.message;
          e.target.disabled = false;
        }
      } }));
    }
    if (v.state === 'waiting') items.push(el('button', { class: 'btn quiet', type: 'button', text: 'Check again', onclick: () => check() }));
    state.replaceChildren(...items);
    if (v.state === 'waiting' && !timer) timer = setInterval(() => (box.isConnected ? check() : stopWatch()), 10_000);
    if (v.state !== 'waiting') stopWatch();
  }
  async function check() {
    try {
      drawState(await api(`/api/network/claim?pc=${encodeURIComponent(p.id)}`));
    } catch (err) {
      said.textContent = err.message;
    }
  }
  getForm.append(
    el('p', { class: 'hint', text: `For a new PC (lost, reinstalled or replaced): the backup name and PIN set on the old one. A recovery code works in place of the PIN. The owner of "${p.name}" is asked to allow it.` }),
    el('div', { class: 'team-actions' }, ownerField('Your backup name', gName), ownerField('Backup PIN or a recovery code', gSecret)),
    el('div', { class: 'team-actions' }, el('button', { class: 'btn primary', type: 'button', text: 'Ask for them', onclick: async () => {
      const v = gSecret.value.trim();
      // Digits only: the backup PIN; letters too: a recovery code (XXXXX-XXXXX).
      const secret = /^[\d\s]+$/.test(v) ? { pin: v } : { code: v };
      try {
        const r = await api('/api/network/claim', { pc: p.id, name: gName.value, ...secret });
        gSecret.value = '';
        said.textContent = '';
        drawState(r);
      } catch (err) {
        said.textContent = err.message;
      }
    } }), el('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: () => (getForm.hidden = true) })));
  const getBtn = el('button', { class: 'btn quiet', type: 'button', text: 'Get my backups…', disabled: !p.ok, onclick: () => {
    getForm.hidden = false;
    gName.focus();
  } });
  if (p.ok) check();

  box.append(
    el('div', { class: 'net-row' }, nameLine, setBtn, getBtn),
    setForm,
    getForm,
    state,
    said);
  return box;
};

// ---- On the backup PC: the pop-up for each new request, once per page; the Network page lists them too (home.js) ----

const claimShown = new Set();
/** Allow / Don't allow: a node's change, so the app lock PIN is asked as for any other (home.js nodeShare). */
app.answerClaim = (id, allow) => nodeShare({ claimId: id, claimAllow: allow });

function showClaim(c) {
  const dlg = $('#claim-dlg');
  claimShown.add(c.id);
  if (dlg.open) return;
  $('#claim-line').textContent = `${c.name} wants their backups on a new PC (${c.pc}, linked ${ownerAgo(c.linkedAt)}).`;
  const end = () => dlg.close();
  $('#claim-allow').onclick = async () => {
    if (await app.answerClaim(c.id, true)) end();
  };
  $('#claim-deny').onclick = async () => {
    if (await app.answerClaim(c.id, false)) end();
  };
  $('#claim-later').onclick = end;
  dlg.showModal();
}

app.onStatus.push(s => {
  if (app.lockShown) return;
  const c = (s.claims ?? []).find(x => !claimShown.has(x.id));
  if (c) showClaim(c);
});

/** The Network page's list of requests waiting (this PC is a node). */
app.drawClaims = list => {
  const box = $('#node-claims');
  if (!box) return;
  box.replaceChildren(...(list?.length ? [el('p', { class: 'hint', text: 'Waiting for you: new PCs asking for backups kept here.' }), ...list.map(c => el('div', { class: 'job-remote' },
    el('span', { text: `${c.name} wants their backups on a new PC (${c.pc}, linked ${ownerAgo(c.linkedAt)}).` }),
    el('button', { class: 'btn primary', type: 'button', text: 'Allow', onclick: () => app.answerClaim(c.id, true) }),
    el('button', { class: 'btn', type: 'button', text: 'Don\'t allow', onclick: () => app.answerClaim(c.id, false) })))] : []));
};
