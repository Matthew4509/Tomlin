// Hire staff: one window for every way in (Home's role icons, the Staff window, HIRE STAFF in the left panel, a PC's
// window). Left: the profile (their look, name, role, level, and what they will run on). Right: the PC first, then the
// models on that PC as cards with the memory each needs, then Hire staff. The level starts at the size of the model
// picked (src/staff.ts levelOfSize) and can be changed: it only orders suggestions, never limits them.
// Everything here sits in one block: page scripts share one global scope, so no name of this file can clash.
'use strict';
{
  const dlg = $('#hire-dlg');
  const hs = { role: '', pc: '', model: '', level: '', levelPicked: false, look: null, lookPicked: false, nameAuto: '', q: '' };

  /** Names of four or five letters for Random, never one already on the team or the one in the box now. */
  const NAMES = ['Susan', 'June', 'Jane', 'Linda', 'Alice', 'Grace', 'Helen', 'Laura', 'Megan', 'Nancy', 'Ruth', 'Sarah', 'Emma', 'Clara', 'Ella', 'Julia', 'Maria', 'Nora', 'Olive', 'Paula', 'Rose', 'Tessa', 'Vera', 'Wendy', 'Anna', 'Beth', 'Carol', 'Diana', 'Edith', 'Fiona', 'Gwen', 'Holly', 'Irene', 'Joan', 'Kate', 'Lucy', 'Mabel', 'Molly', 'Nell', 'Polly', 'Rita', 'Sally', 'Tina', 'Adam', 'Alan', 'Brian', 'Colin', 'David', 'Dylan', 'Ethan', 'Frank', 'Gavin', 'Harry', 'Henry', 'Isaac', 'Jack', 'James', 'Jason', 'Kyle', 'Liam', 'Lucas', 'Mark', 'Mason', 'Neil', 'Noah', 'Oscar', 'Owen', 'Peter', 'Ryan', 'Simon', 'Tyler', 'Wade'];

  const d = () => team.data;
  const role = () => d()?.roles.find(r => r.id === hs.role);
  const kind = () => (role()?.kind === 'image' ? 'image' : 'chat');
  const GBs = n => `${(n / 2 ** 30).toFixed(n >= 10 * 2 ** 30 ? 0 : 1)} GB`;
  const pcName = id => (id ? homeUi.pcs.find(p => p.id === id)?.name ?? d()?.pcs.find(p => p.id === id)?.name ?? 'A linked PC' : app.pcProfileOf?.('here')?.name || 'My PC');

  function fault(text) {
    $('#hs-fault').textContent = text ?? '';
    $('#hs-fault').hidden = !text;
  }

  /** Every model of the role's kind on one PC ('' = this PC): a hidden one only once "Show hidden" is ticked. */
  const onPc = pc => (d()?.hireChoices?.[kind()] ?? []).filter(c => (c.pc ?? '') === pc);
  const offered = pc => visibleModels(onPc(pc), hs.model);

  // ---- The profile (left) ----

  function drawLook() {
    if (!app.look?.ready()) {
      $('#hs-pic').hidden = true;
      $('#hs-look-btn').hidden = true;
      return;
    }
    if (!hs.look || !hs.lookPicked) hs.look = app.look.random(hs.role);
    $('#hs-pic').src = app.look.picture(hs.look, 192);
    $('#hs-pic').hidden = false;
    $('#hs-look-btn').hidden = false;
  }
  function openLook() {
    const box = $('#hs-look-box');
    if (!box.hidden) return closeLook();
    const done = el('button', { class: 'btn primary', type: 'button', text: 'Done', onclick: closeLook });
    box.replaceChildren(el('h3', { text: 'Their look' }), app.look.editor({ look: hs.look, role: hs.role, extra: done, onChange: l => {
      hs.look = l;
      hs.lookPicked = true;
      $('#hs-pic').src = app.look.picture(l, 192);
    } }));
    box.hidden = false;
    $('#hs-look-btn').setAttribute('aria-expanded', 'true');
    box.scrollIntoView({ block: 'nearest' });
  }
  function closeLook() {
    $('#hs-look-box').hidden = true;
    $('#hs-look-box').replaceChildren();
    $('#hs-look-btn').setAttribute('aria-expanded', 'false');
  }

  function drawRoles() {
    $('#hs-roles').replaceChildren(...d().roles.map(r => el('label', { class: 'pick-card hs-role' },
      el('input', { type: 'radio', name: 'hs-role', value: r.id, checked: r.id === hs.role, onchange: () => pickRole(r.id) }),
      el('span', { class: 'role-icon', 'aria-hidden': 'true' }, roleIcon(r.id)), el('span', { text: r.name }))));
  }
  function pickRole(id) {
    const before = kind();
    hs.role = id;
    if (!hs.lookPicked) drawLook();
    // A chat role and a picture role start on different kinds of model.
    if (kind() !== before) {
      hs.model = '';
      if (!hs.levelPicked) hs.level = '';
    }
    drawAll();
  }

  /** The level: from the model picked (until one is picked by hand), each with the size it suggests. */
  function drawLevel() {
    const sel = $('#hs-level');
    const image = kind() === 'image';
    const picked = onPc(hs.pc).find(c => c.id === hs.model);
    if (!hs.levelPicked) hs.level = picked?.level ?? hs.level ?? '';
    if (!d().levels.some(l => l.id === hs.level)) hs.level = d().levels[0]?.id ?? '';
    sel.replaceChildren(...d().levels.map(l => el('option', { value: l.id, text: `${l.name} · ${image ? l.imageSize : String(l.size).replace(/ \(.*\)/, '')}` })));
    sel.value = hs.level;
    const level = d().levels.find(l => l.id === hs.level);
    $('#hs-level-line').textContent = hs.levelPicked ? 'Picked by you. It only orders the models suggested to them; any model works.'
      : picked?.level ? `From ${picked.label}'s size. Change it if you like: it only orders the models suggested to them.`
      : `${(image ? level?.imageSuggest : level?.suggest) ?? ''}`;
    $('#hs-role-line').textContent = role()?.hint ?? '';
  }

  /** The name: from the model ("Qwen", "Qwen 2" when a Qwen is on the team), unless one was typed. */
  function fillName() {
    const box = $('#hs-name');
    if (box.value.trim() && box.value !== hs.nameAuto) return;
    const nick = onPc(hs.pc).find(c => c.id === hs.model)?.nick || '';
    const taken = new Set((d()?.staff ?? []).map(m => m.name.trim().toLowerCase()));
    let name = nick;
    for (let n = 2; name && taken.has(name.toLowerCase()); n++) name = `${nick} ${n}`;
    box.value = name;
    hs.nameAuto = name;
  }

  function drawSummary() {
    const m = onPc(hs.pc).find(c => c.id === hs.model);
    $('#hs-sum-pc').textContent = pcName(hs.pc);
    $('#hs-sum-model').textContent = m ? m.label : kind() === 'image' ? 'None yet: pick one after hiring' : hs.pc ? 'None picked' : 'None yet: the model loaded here';
    $('#hs-go').disabled = !!hs.pc && !m;
  }

  // ---- Assign a PC (right, top) ----

  function pcCard(id) {
    const p = id ? d().pcs.find(x => x.id === id) : { ok: true, away: false, ...d().here };
    const n = offered(id).length;
    const thing = kind() === 'image' ? 'picture model' : 'chat model';
    const state = !id ? 'This PC' : !p?.ok ? 'Off now' : p.away ? 'Away: its owner is using it' : 'On';
    const mem = p?.ram ? `${GBs(p.ram)} RAM${p.vram ? ` · ${GBs(p.vram)} graphics memory` : ''}` : id ? 'Memory not known' : '';
    const count = n ? `${n} ${thing}${n === 1 ? '' : 's'}${id ? ' shared' : ''}` : id ? `Shares no ${thing}s` : `No ${thing}s yet`;
    return el('label', { class: 'pick-card hs-pc' },
      el('input', { type: 'radio', name: 'hs-pc', value: id, checked: hs.pc === id, onchange: () => pickPc(id) }),
      el('span', { class: 'hs-pc-icon', 'aria-hidden': 'true' }, el('span', { class: 'sdot', 'data-state': !id || (p?.ok && !p.away) ? 'on' : p?.ok ? 'asleep' : 'off' })),
      el('span', { class: 'hs-pc-text' },
        el('strong', { text: pcName(id) }),
        el('span', { class: 'hint', text: [state, mem].filter(Boolean).join(' · ') })),
      el('span', { class: 'hs-pc-count', text: count }));
  }
  function pickPc(id) {
    hs.pc = id;
    hs.model = '';
    drawAll();
  }

  // ---- Choose a model (right) ----

  const FIT = { ok: '', tight: 'Tight fit: little memory to spare', no: 'Needs more memory than is free' };
  function modelCard(c) {
    const state = c.busy ? (kind() === 'image' ? 'Drawing now' : 'Answering now') : c.loaded ? (c.pc ? 'Loaded there' : 'Loaded') : c.ok === false ? 'Off now' : c.pc ? 'Loads when asked' : 'Installed';
    const size = [c.need ? `Needs about ${GBs(c.need)}` : '', c.bytes ? `file ${GBs(c.bytes)}` : ''].filter(Boolean).join(' · ');
    const lvl = d().levels.find(l => l.id === c.level);
    return el('label', { class: `pick-card hs-model${c.fit === 'no' ? ' hs-tight' : ''}${c.hidden ? ' hidden-model' : ''}` },
      el('input', { type: 'radio', name: 'hs-model', value: c.id, checked: hs.model === c.id, onchange: () => pickModel(c.id) }),
      el('span', { class: 'hs-model-text' },
        el('strong', { text: c.label }),
        el('span', { class: 'hint', text: [size, lvl ? `${lvl.name} size` : '', c.hidden ? 'Hidden' : ''].filter(Boolean).join(' · ') || 'Size not known' }),
        FIT[c.fit] ? el('span', { class: 'hs-warn', text: `⚠ ${FIT[c.fit]}` }) : null),
      el('span', { class: `hs-state${c.loaded || c.busy ? ' on' : ''}`, text: state }));
  }
  function pickModel(id) {
    hs.model = id;
    drawLevel();
    fillName();
    drawSummary();
  }
  function drawModels() {
    const all = onPc(hs.pc);
    const tick = hiddenTick('show-hidden-hs', all.some(c => c.hidden));
    if (!tick.isConnected) $('#hs-tools').append(tick);
    const q = hs.q.trim().toLowerCase();
    // Loaded first, then those that fit, then by name.
    const rank = c => (c.loaded || c.busy ? 0 : c.fit === 'no' ? 2 : 1);
    const list = offered(hs.pc).filter(c => !q || c.label.toLowerCase().includes(q)).sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
    const thing = kind() === 'image' ? 'picture models' : 'chat models';
    const p = hs.pc ? d().pcs.find(x => x.id === hs.pc) : null;
    const empty = q && offered(hs.pc).length ? [el('p', { class: 'hint', text: `No ${thing} on ${pcName(hs.pc)} match "${hs.q.trim()}".` })]
      : hs.pc ? [el('p', { class: 'hint', text: !p?.ok && !all.length ? `${pcName(hs.pc)} is off and has not said which ${thing} it shares. Start it, or pick another PC.` : `${pcName(hs.pc)} shares no ${thing} with this PC. On that PC, open Nodes and memory and tick the models other PCs may use.` })]
      : [el('p', { class: 'hint' }, `No ${thing} on this PC yet. You can still hire them now and pick their model after; or `, el('button', { class: 'link', type: 'button', text: 'get a model', onclick: () => { dlg.close(); app.openModels(kind() === 'image' ? 'image' : 'chat'); } }), '.')];
    // The model kept when it is still offered; else the one loaded now on this PC; else the first on the list.
    if (!list.some(c => c.id === hs.model)) {
      const now = !hs.pc ? (kind() === 'image' ? d().connectedImage : d().connected) : null;
      hs.model = list.find(c => c.id === now)?.id ?? list[0]?.id ?? '';
    }
    keepCards($('#hs-models'), list.length ? list.map(modelCard) : empty);
    $('#hs-models-title').textContent = `Choose a model${list.length ? ` (${list.length})` : ''}`;
  }

  /** Cards drawn again keep the keyboard on the same card. */
  function keepCards(box, kids) {
    const was = document.activeElement && box.contains(document.activeElement) ? document.activeElement.value : null;
    box.replaceChildren(...kids);
    if (was !== null) box.querySelector(`input[value="${CSS.escape(was)}"]`)?.focus();
  }

  function drawAll() {
    keepCards($('#hs-pcs'), [pcCard(''), ...d().pcs.map(p => pcCard(p.id))]);
    $('#hs-pcs-block').hidden = !d().pcs.length;
    drawModels();
    drawLevel();
    fillName();
    drawSummary();
    for (const x of document.querySelectorAll('#hs-roles input')) x.checked = x.value === hs.role;
  }

  /** Opens Hire staff: `role` and `pc` pick those first (a PC's window passes its own). */
  app.openHire = async ({ role = '', pc = '' } = {}) => {
    try {
      team.data = await api('/api/staff');
    } catch (e) {
      return app.chatNote?.(e.message);
    }
    hs.role = d().roles.some(r => r.id === role) ? role : d().roles[0]?.id ?? '';
    hs.pc = pc === 'here' ? '' : d().pcs.some(p => p.id === pc) ? pc : '';
    hs.model = '';
    hs.level = '';
    hs.levelPicked = false;
    hs.lookPicked = false;
    hs.look = null;
    hs.q = '';
    hs.nameAuto = '';
    $('#hs-name').value = '';
    $('#hs-search').value = '';
    fault('');
    closeLook();
    drawRoles();
    drawLook();
    drawAll();
    if (!dlg.open) dlg.showModal();
    $('#hs-name').focus();
  };
  /** A model hidden, shown, deleted or got: the cards are read again while the window is open. */
  app.hireRedraw = async () => {
    if (!dlg.open) return;
    try {
      team.data = await api('/api/staff');
      drawAll();
    } catch {
      // The window keeps what it had.
    }
  };
  hiddenRedraws.push(() => {
    if (dlg.open) drawAll();
  });

  $('#hs-look-btn').addEventListener('click', openLook);
  $('#hs-level').addEventListener('change', e => {
    hs.level = e.target.value;
    hs.levelPicked = true;
    drawLevel();
  });
  $('#hs-search').addEventListener('input', e => {
    hs.q = e.target.value;
    drawModels();
    drawSummary();
  });
  $('#hs-random').addEventListener('click', () => {
    const box = $('#hs-name');
    const taken = new Set([...(d()?.staff ?? []).map(s => s.name.toLowerCase()), box.value.trim().toLowerCase()]);
    const free = NAMES.filter(n => !taken.has(n.toLowerCase()));
    box.value = (free.length ? free : NAMES)[Math.floor(Math.random() * (free.length || NAMES.length))];
    box.focus();
  });
  $('#hs-cancel').addEventListener('click', () => dlg.close());
  $('#hs-close').addEventListener('click', () => dlg.close());
  $('#hs-form').addEventListener('submit', async e => {
    e.preventDefault();
    const go = $('#hs-go');
    go.disabled = true;
    fault('');
    try {
      team.data = await api('/api/staff', { action: 'hire', name: $('#hs-name').value, role: hs.role, level: hs.level, model: hs.model || undefined, look: hs.look ?? undefined });
      dlg.close();
      // The rest of the page catches up (left panel, Home, chats, faces); a hire with no model opens their profile.
      await app.afterHire?.(team.data.staff.at(-1));
    } catch (err) {
      fault(err.message);
    } finally {
      go.disabled = false;
      drawSummary();
    }
  });
}
