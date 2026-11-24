// Hire staff: one window for every way in (Home's role icons, the Staff window, Hire staff in the left panel, a PC's
// window). Left: the profile (their look, name, role, and what they will run on). Right: the PC first, then the
// models on that PC as cards with the memory each needs, then Hire staff. There is no Level to pick (2.0.75): it
// follows the size of the model they use (src/staff.ts levelOfHire).
// The same window moves a hire (Edit staff, "Move to another PC, see more models"; app.openMove): their name, look and
// role are fixed, the PC and model are picked as when hiring, a model elsewhere is installed first, and the button
// moves them.
// Everything here sits in one block: page scripts share one global scope, so no name of this file can clash.
'use strict';
{
  const dlg = $('#hire-dlg');
  // fromMenu: opened from the Staff menu's Create, so Cancel and Close go back to that menu.
  // turn: each opening counts one, so a slow answer for an earlier one is not drawn over a later one.
  const hs = { role: '', pc: '', model: '', look: null, lookPicked: false, q: '', net: null, moving: new Map(), fromMenu: false, turn: 0, fresh: false, move: null };

  /** Names of four or five letters for Random and the name filled in on opening: a woman's, then a man's. */
  const WOMEN = ['Susan', 'June', 'Jane', 'Linda', 'Alice', 'Grace', 'Helen', 'Laura', 'Megan', 'Nancy', 'Ruth', 'Sarah', 'Emma', 'Clara', 'Ella', 'Julia', 'Maria', 'Nora', 'Olive', 'Paula', 'Rose', 'Tessa', 'Vera', 'Wendy', 'Anna', 'Beth', 'Carol', 'Diana', 'Edith', 'Fiona', 'Gwen', 'Holly', 'Irene', 'Joan', 'Kate', 'Lucy', 'Mabel', 'Molly', 'Nell', 'Polly', 'Rita', 'Sally', 'Tina'];
  const MEN = ['Adam', 'Alan', 'Brian', 'Colin', 'David', 'Dylan', 'Ethan', 'Frank', 'Gavin', 'Harry', 'Henry', 'Isaac', 'Jack', 'James', 'Jason', 'Kyle', 'Liam', 'Lucas', 'Mark', 'Mason', 'Neil', 'Noah', 'Oscar', 'Owen', 'Peter', 'Ryan', 'Simon', 'Tyler', 'Wade'];
  const NAMES = [...WOMEN, ...MEN];
  /** The look's gender a name calls for: a woman's name a woman, a man's name a man; null for a name not on the lists. */
  const genderOf = name => {
    const first = String(name ?? '').trim().split(/\s+/)[0].toLowerCase();
    return WOMEN.some(n => n.toLowerCase() === first) ? 'woman' : MEN.some(n => n.toLowerCase() === first) ? 'man' : null;
  };
  app.genderOfName = genderOf;

  const d = () => team.data;
  const role = () => d()?.roles.find(r => r.id === hs.role);
  const kind = () => (role()?.kind === 'image' ? 'image' : 'chat');
  const GBs = n => `${(n / 2 ** 30).toFixed(n >= 10 * 2 ** 30 ? 0 : 1)} GB`;
  // Two linked PCs with one name are told apart (app.pcLabel, public/home.js); before Home has read the PCs, by the
  // names the staff list gave (src/brains.ts pcLabels).
  const pcName = id => (id ? (homeUi.pcs.some(p => p.id === id) ? app.pcLabel?.(id) : null) ?? d()?.pcs.find(p => p.id === id)?.label ?? homeUi.pcs.find(p => p.id === id)?.name ?? d()?.pcs.find(p => p.id === id)?.name ?? 'A linked PC' : app.pcProfileOf?.('here')?.name || 'My PC');

  /** A fault shows in the Hire staff window. */
  function fault(text) {
    for (const box of [$('#hs-fault')]) {
      box.textContent = text ?? '';
      box.hidden = !text;
    }
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
    // A look not chosen by hand follows the name: a woman's name draws a woman, a man's name a man.
    if (!hs.look || !hs.lookPicked) hs.look = app.look.random(hs.role, undefined, undefined, genderOf($('#hs-name').value));
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

  /**
   * Role is two tiles, Text / coding and Images (a role's `kind`), and the sub-role is a drop-down of the roles of the
   * tile picked. A tile picked again goes back to the sub-role last picked under it.
   */
  const KINDS = [{ id: 'chat', name: 'Text / coding', icon: 'coder' }, { id: 'image', name: 'Images', icon: 'artist' }];
  const kindOf = r => (r?.kind === 'image' ? 'image' : 'chat');
  const lastSub = {};
  function drawRoles() {
    $('#hs-roles').replaceChildren(...KINDS.filter(k => d().roles.some(r => kindOf(r) === k.id)).map(k => el('label', { class: 'pick-card hs-role' },
      el('input', { type: 'radio', name: 'hs-kind', value: k.id, checked: k.id === kind(), onchange: () => pickKind(k.id) }),
      el('span', { class: 'role-icon', 'aria-hidden': 'true' }, roleIcon(k.icon)), el('span', { text: k.name }))));
    drawSubRoles();
  }
  function drawSubRoles() {
    const sel = $('#hs-subrole');
    sel.replaceChildren(...d().roles.filter(r => kindOf(r) === kind()).map(r => el('option', { value: r.id, text: r.name, selected: r.id === hs.role })));
    sel.value = hs.role;
    sel.disabled = false;
  }
  function pickKind(id) {
    if (id === kind()) return;
    lastSub[kind()] = hs.role;
    const keep = d().roles.find(r => r.id === lastSub[id]);
    pickRole((keep ?? d().roles.find(r => kindOf(r) === id))?.id ?? hs.role);
    drawSubRoles();
  }
  function pickRole(id) {
    const before = kind();
    hs.role = id;
    if (!hs.lookPicked) drawLook();
    // A chat role and a picture role start on different kinds of model.
    if (kind() !== before) hs.model = '';
    drawAll();
  }

  /** The line under the role: what it is for. */
  function drawRoleLine() {
    $('#hs-role-line').textContent = role()?.hint ?? '';
  }

  /** A name typed or drawn: a look not chosen by hand is drawn again when the name calls for the other gender. */
  function nameChanged() {
    const want = genderOf($('#hs-name').value);
    if (want && !hs.lookPicked && hs.look && hs.look.gender !== want) {
      hs.look = null;
      drawLook();
    }
  }

  function drawSummary() {
    const m = onPc(hs.pc).find(c => c.id === hs.model);
    $('#hs-sum-pc').textContent = pcName(hs.pc);
    $('#hs-sum-model').textContent = m ? m.label : kind() === 'image' ? 'None yet: pick one after hiring' : hs.pc ? 'None picked' : 'None yet: the model loaded here';
    // Moving: a model on the PC picked, and not the one they have now.
    $('#hs-go').disabled = hs.move ? !m || m.id === hs.move.model : !!hs.pc && !m;
  }

  // ---- Assign a PC (right, top) ----

  function pcCard(id) {
    const p = id ? d().pcs.find(x => x.id === id) : { ok: true, away: false, ...d().here };
    const state = !id ? 'This PC' : p?.asking ? 'Asking it…' : !p?.ok ? 'Off now' : p.away ? 'Away: its owner is using it' : 'On';
    const was = id ? homeUi.pcMem?.[id] : null;
    const ram = p?.ram || was?.ram, vram = p?.ram ? p.vram : was?.vram;
    const mem = ram ? `${GBs(ram)} RAM${vram ? ` · ${GBs(vram)} graphics memory` : ''}` : id ? 'Memory not known' : '';
    return el('label', { class: `pick-card hs-pc${p?.asking ? ' hs-wait' : ''}` },
      el('input', { type: 'radio', name: 'hs-pc', value: id, checked: hs.pc === id, onchange: () => pickPc(id) }),
      el('span', { class: 'hs-pc-icon', 'aria-hidden': 'true' }, el('span', { class: 'sdot', 'data-state': !id || (p?.ok && !p.away) ? 'on' : p?.ok || p?.asking ? 'asleep' : 'off' })),
      el('span', { class: 'hs-pc-text' },
        el('strong', { text: pcName(id) }),
        el('span', { class: 'hint', text: [state, mem].filter(Boolean).join(' · ') })));
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
        // A linked PC's fit is against all its memory (src/calc.ts ramFit), not what is free on it now.
        FIT[c.fit] ? el('span', { class: 'hs-warn', text: `⚠ ${c.pc && c.fit === 'no' ? 'Needs more memory than that PC has' : FIT[c.fit]}` }) : null),
      el('span', { class: `hs-state${c.loaded || c.busy ? ' on' : ''}`, text: state }));
  }
  function pickModel(id) {
    hs.model = id;
    drawRoleLine();
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
      : hs.pc ? [el('p', { class: 'hint', text: !p?.ok && !all.length ? `${pcName(hs.pc)} is off and has not said which ${thing} it shares. Start it, or pick another PC.` : `${pcName(hs.pc)} has no ${thing} yet. Send one there from Models, or pick another PC.` })]
      : [el('p', { class: 'hint' }, `No ${thing} on this PC yet. You can still hire them now and pick their model after; or `, el('button', { class: 'link', type: 'button', text: 'get a model', onclick: () => { dlg.close(); app.openModels(kind() === 'image' ? 'image' : 'chat'); } }), '.')];
    // The model kept when it is still offered; else the one loaded now on this PC; else the first on the list.
    if (!list.some(c => c.id === hs.model)) {
      // Moving: their own model first, when it is on the PC picked.
      const now = hs.move?.model && list.some(c => c.id === hs.move.model) ? hs.move.model : !hs.pc ? (kind() === 'image' ? d().connectedImage : d().connected) : null;
      hs.model = list.find(c => c.id === now)?.id ?? list[0]?.id ?? '';
    }
    keepCards($('#hs-models'), list.length ? list.map(modelCard) : empty);
    $('#hs-models-title').textContent = `Choose a model${list.length ? ` (${list.length})` : ''}`;
  }

  // ---- All models: every model on the network that the PC picked has not got, to copy there (then hire on it) ----

  /** A model's key across PCs, as src/carry.ts modelKey makes it: a chat model by its file name, a picture model by its id. */
  const keyOf = (k, id) => (k === 'image' ? `image:${id}` : `chat:${String(id).replace(/\\/g, '/').split('/').pop().toLowerCase()}`);
  /** A hire choice's key: a linked PC's is "remote:<pc>:<its model id>". */
  const choiceKey = c => keyOf(kind(), c.pc ? c.id.slice(`remote:${c.pc}:`.length) : c.id);

  /** The models on the network: as the PCs said last (at once), then asked now. `turn`: the opening it is for. */
  async function loadNet(turn = hs.turn) {
    for (const known of [true, false]) {
      const net = await api(`/api/network${known ? '?known=1' : ''}`).catch(() => null);
      if (turn !== hs.turn || !dlg.open) return;
      // The quick list never replaces one already asked now (a copy that just ended reads the full list again).
      if (net && (!known || !hs.net?.fresh)) hs.net = { ...net, fresh: !known };
      drawAllModels();
    }
  }

  /** Each model on the network of this kind: where it is ('' = this PC), by its key. */
  function networkModels() {
    const k = kind();
    const all = new Map();
    const add = (key, name, bytes, on) => {
      const e = all.get(key) ?? { key, name, bytes, on: [] };
      e.on.push(on);
      all.set(key, e);
    };
    for (const m of hs.net?.mine ?? []) if (m.kind === k) add(keyOf(k, m.id), m.name, m.bytes, { pc: '', model: m.id, copy: true, why: '' });
    for (const r of hs.net?.rows ?? []) if (r.kind === k) for (const o of r.on) add(r.key, r.name, r.bytes, { pc: o.pc, name: o.pcName, model: o.model, copy: o.copy, why: o.why, backup: o.backup === true });
    return [...all.values()];
  }

  /**
   * How a model gets to the PC picked: { from } (this PC sends it, or this PC pulls it), { from, direct } (one linked
   * PC to another, straight, src/jobrun/peercopy.ts: nothing passes through this PC), or { why } it cannot now.
   */
  function routeTo(e, target) {
    const here = e.on.find(o => !o.pc);
    const linked = e.on.find(o => o.pc && o.copy) ?? null;
    const room = roomWhy(e, target);
    if (!target) return room ? { why: room } : linked ? { from: linked } : { why: e.on.find(o => o.pc)?.why || 'it cannot be copied now' };
    const send = hs.net?.pcs.find(p => p.id === target)?.send;
    if (send) return { why: send };
    if (room) return { why: room };
    if (here) return { from: here };
    // A Backups only PC's copy comes to this PC first, then goes on (it is not introduced to the other PCs for copying).
    return linked ? { from: linked, direct: !linked.backup } : { why: e.on.find(o => o.pc)?.why || 'it cannot be copied now' };
  }
  /** "Insufficient space" when the PC's models drive (as it last said) has not room for the file and the spare kept free. */
  function roomWhy(e, target) {
    const free = target ? hs.net?.pcs.find(p => p.id === target)?.free : hs.net?.free;
    if (typeof free !== 'number' || !e.bytes || e.bytes + (hs.net?.spare ?? 0) <= free) return '';
    return `insufficient space on ${pcName(target)}: needs ${GBs(e.bytes)}, ${GBs(free)} free`;
  }

  function drawAllModels() {
    const block = $('#hs-all-block');
    // Only with other PCs linked: alone, Models: add or remove is where models come from.
    block.hidden = !d()?.pcs.length;
    if (block.hidden) return;
    const target = hs.pc;
    const there = new Set(onPc(target).map(choiceKey));
    const q = hs.q.trim().toLowerCase();
    // A model only on PCs that are off is not a card (it cannot be installed now): it is listed under that PC, folded, below.
    const off = new Set((hs.net?.pcs ?? []).filter(p => p.ok === false).map(p => p.id));
    const reachable = e => e.on.some(o => !o.pc || !off.has(o.pc));
    const list = networkModels().filter(e => reachable(e) && !there.has(e.key) && (!q || e.name.toLowerCase().includes(q))).sort((a, b) => a.name.localeCompare(b.name));
    drawOffPcs(off);
    const thing = kind() === 'image' ? 'picture models' : 'chat models';
    block.classList.toggle('hs-wait', !hs.net);
    $('#hs-all-line').textContent = !hs.net ? 'Asking the linked PCs which models they have…'
      : list.length ? 'Choose and pull a model from across your network.'
      : `${pcName(target)} has every ${thing.slice(0, -1)} your linked PCs share${q ? ` that matches "${hs.q.trim()}"` : ''}.`;
    // The PC that Install puts a model on, as a tile like the left panel's.
    $('#hs-all-to').replaceChildren(railPc(target), el('span', { class: 'hint hs-all-to-line', text: 'Install puts a model here' }));
    // Blurred stand-ins while the PCs are asked: the page keeps its shape, then the cards come in.
    keepButtons($('#hs-all'), !hs.net ? [1, 2, 3, 4].map(waitCard) : list.map(allCard));
  }
  /**
   * Each linked PC that is off, folded: "This node is offline, last reported to have:" and the models it last said it
   * has (of this role's kind), as a plain list in two columns. Nothing to press: it comes back as cards once it is on.
   */
  function drawOffPcs(off) {
    const when = t => new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    const all = networkModels();
    $('#hs-off-pcs').replaceChildren(...(hs.net?.pcs ?? []).filter(p => off.has(p.id)).map(p => {
      const names = all.filter(e => e.on.some(o => o.pc === p.id)).map(e => `${e.name}${e.bytes ? ` (${GBs(e.bytes)})` : ''}`).sort((a, b) => a.localeCompare(b));
      return el('details', { class: 'hs-off-pc' },
        el('summary', {}, el('strong', { text: pcName(p.id) }), el('span', { class: 'hint', text: ` · Offline${p.seenAt ? `, last seen ${when(p.seenAt)}` : ''}` })),
        el('p', { class: 'hint', text: names.length ? 'This node is offline, last reported to have:' : 'This node is offline, last reported to have none of these models.' }),
        names.length ? el('ul', { class: 'hs-off-list' }, ...names.map(n => el('li', { text: n }))) : null);
    }));
  }
  const waitCard = () => el('div', { class: 'pick-card hs-model hs-wait-card', 'aria-hidden': 'true' }, el('span', { class: 'hs-model-text' }, el('strong', { text: 'A model name here' }), el('span', { class: 'hint', text: 'file 0.0 GB · On a PC' })));

  const whereOpen = new Set();
  function allCard(e) {
    const target = hs.pc;
    const where = whereOf(e);
    const route = routeTo(e, target);
    const moving = hs.moving.get(e.key);
    const btn = el('button', { class: 'btn', type: 'button', 'data-key': e.key, text: 'Install', title: `Install on ${pcName(target)}`, disabled: !!route.why || !!moving, onclick: () => pull(e) });
    // Where it is stays behind a "!": hover for it, or press to show it under the size (kept open when the cards redraw).
    const open = whereOpen.has(e.key);
    const bang = el('button', { class: 'hs-where', type: 'button', 'data-key': `where:${e.key}`, text: '!', title: `On ${where}`, 'aria-label': `Where it is: on ${where}`, 'aria-expanded': String(open), onclick: () => {
      if (!whereOpen.delete(e.key)) whereOpen.add(e.key);
      drawAllModels();
    } });
    return el('div', { class: 'pick-card hs-model hs-net' },
      el('span', { class: 'hs-model-text' },
        el('strong', { text: e.name }),
        el('span', { class: 'hint' }, e.bytes ? `file ${GBs(e.bytes)} ` : '', bang),
        open ? el('span', { class: 'hint', text: `On ${where}` }) : null,
        moving ? el('span', { class: 'hint', role: 'status', text: moving.said }) : route.why ? el('span', { class: 'hs-warn', text: `${cap(route.why)}.` }) : null),
      el('span', { class: 'hs-net-acts' }, btn));
  }
  const cap = t => `${t.charAt(0).toUpperCase()}${t.slice(1)}`;
  // Each PC by the name that tells it apart (two linked PCs both called "Worker PC" are not one PC).
  const whereOf = e => e.on.map(o => pcName(o.pc)).filter((n, i, a) => a.indexOf(n) === i).join(', ');

  /**
   * A PC drawn as the left panel draws it (home.js staffRow): its picture with the activity dot, its name, its memory
   * ("48 GB / 5 GB VRAM") and make, and the one word (Available, Offline...). Not a button: it only shows the PC picked.
   */
  function railPc(pc) {
    const p = pc ? d().pcs.find(x => x.id === pc) : null;
    const net = pc ? hs.net?.pcs.find(x => x.id === pc) : null;
    const on = !pc || (p ? p.ok : net?.ok === true);
    const activity = !on ? 'offline' : p?.away ? 'owner' : 'available';
    const mem = pc ? { ram: p?.ram || homeUi.pcMem?.[pc]?.ram, vram: p?.ram ? p.vram : homeUi.pcMem?.[pc]?.vram } : d().here;
    const sub = [mem?.ram ? memWords(mem.ram, mem.vram) : pc ? 'Memory not known' : 'This PC', app.pcProfileOf?.(pc || 'here')?.model || ''].filter(Boolean).join(' · ');
    const mark = activityDot(activity);
    const pic = app.avatar ? app.avatar(pc ? `pc:${pc}` : 'pc:mine', 'PC', mark) : el('span', { class: 'rail-avatar', 'aria-hidden': 'true' }, 'PC', mark);
    return el('div', { class: 'rail-row hs-rail-pc', 'data-pc': pc || 'here' }, pic,
      el('span', { class: 'rail-text' },
        el('span', { class: 'rail-name', text: pcName(pc) }),
        el('span', { class: 'rail-sub', text: sub }),
        el('span', { class: `rail-state a-${activity}`, text: ACTIVITY_WORD[activity] })));
  }

  /** Buttons drawn again keep the keyboard on the same one. */
  function keepButtons(box, kids) {
    const was = document.activeElement && box.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    box.replaceChildren(...kids);
    if (was) box.querySelector(`button[data-key="${CSS.escape(was)}"]`)?.focus();
  }

  /** Waits for a copy or a send to end, saying how far it is on the model's card. */
  async function follow(e, id, words) {
    for (;;) {
      const t = (await api('/api/network/transfers').catch(() => null))?.transfers?.find(x => x.id === id);
      if (!t) throw new Error('the copy is no longer listed: look in Models on my other PCs (Network)');
      if (t.state === 'done') return t;
      if (t.state !== 'working') throw new Error(t.said || 'it stopped');
      hs.moving.set(e.key, { ...hs.moving.get(e.key), said: `${words}${t.bytes ? `: ${Math.round((t.done / t.bytes) * 100)}%` : '…'}` });
      if (dlg.open) drawAllModels();
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  /** A direct copy from one linked PC to another, followed until it ends (the host only asks how far it is). */
  async function followDirect(e, from, to, words) {
    for (;;) {
      const t = (await api('/api/share', { peerCopy: { from, to, action: 'state' } })).peerCopy?.transfer;
      if (!t) throw new Error(`${pcName(to)} has no copy under way from ${pcName(from)}`);
      if (t.state === 'done') return t;
      if (t.state !== 'working') throw new Error(t.said || 'it stopped');
      hs.moving.set(e.key, { ...hs.moving.get(e.key), said: `${words}${t.bytes ? `: ${Math.round((t.done / t.bytes) * 100)}%` : '…'}` });
      if (dlg.open) drawAllModels();
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  /** Copies a model to a PC (the one picked): from a linked PC, from this PC, or from one linked PC straight to another. */
  async function pull(e) {
    const target = hs.pc;
    const k = kind();
    const route = routeTo(e, target);
    if (route.why) return;
    hs.moving.set(e.key, { said: 'Starting…', to: target });
    drawAllModels();
    try {
      let local = route.from.pc ? null : route.from.model;
      if (route.direct) {
        // Node to node: the target pulls it from the PC that has it; this PC only gives the order (src/jobrun/peersync.ts copyOrder).
        await api('/api/share', { peerCopy: { from: route.from.pc, to: target, kind: k, model: route.from.model } });
        await followDirect(e, route.from.pc, target, `Copying straight from ${route.from.name || pcName(route.from.pc)}`);
      } else if (route.from.pc) {
        const r = await api('/api/network/copy', { pc: route.from.pc, model: route.from.model, kind: k });
        await follow(e, r.transfer.id, `Copying from ${route.from.name || pcName(route.from.pc)}`);
        await loadNet();
        local = hs.net?.mine.find(m => m.kind === k && keyOf(k, m.id) === e.key)?.id ?? null;
      }
      if (target && !route.direct) {
        if (!local) throw new Error('it came to this PC but is not listed here yet: send it from Models on my other PCs');
        const r = await api('/api/network/send', { pc: target, model: local, kind: k });
        await follow(e, r.transfer.id, `Sending to ${pcName(target)}`);
      }
      hs.moving.delete(e.key);
      await app.hireRedraw();
      await loadNet();
      // Picked for this hire, when it is on that PC's list now.
      const c = onPc(target).find(x => choiceKey(x) === e.key);
      if (c && hs.pc === target) {
        pickModel(c.id);
        drawModels();
      }
      fault('');
    } catch (err) {
      hs.moving.delete(e.key);
      drawAllModels();
      fault(`${e.name} was not copied to ${pcName(target)}: ${err.message}`);
    }
  }

  /** Cards drawn again keep the keyboard on the same card. */
  function keepCards(box, kids) {
    const was = document.activeElement && box.contains(document.activeElement) ? document.activeElement.value : null;
    box.replaceChildren(...kids);
    if (was !== null) box.querySelector(`input[value="${CSS.escape(was)}"]`)?.focus();
  }

  function drawAll() {
    keepCards($('#hs-pcs'), [pcCard('')]);
    keepCards($('#hs-net-pcs'), d().pcs.map(p => pcCard(p.id)));
    $('#hs-pcs-block').hidden = !d().pcs.length;
    drawModels();
    drawAllModels();
    drawRoleLine();
    drawSummary();
    for (const x of document.querySelectorAll('#hs-roles input')) x.checked = x.value === kind();
    if ($('#hs-subrole').value !== hs.role) drawSubRoles();
  }

  /** Before the first staff list has come: the window's frame with blurred stand-ins where the roles and models go. */
  function drawWaiting() {
    $('#hs-subrole').replaceChildren(el('option', { text: 'Reading the roles…' }));
    $('#hs-subrole').disabled = true;
    $('#hs-roles').replaceChildren(...['Text / coding', 'Images'].map(t => el('span', { class: 'pick-card hs-role hs-wait-card', 'aria-hidden': 'true' }, el('span', { class: 'role-icon' }), el('span', { text: t }))));
    $('#hs-pcs-block').hidden = true;
    $('#hs-all-block').hidden = true;
    $('#hs-models-title').textContent = 'Choose a model';
    $('#hs-models').replaceChildren(...[1, 2, 3, 4].map(waitCard));
    $('#hs-role-line').textContent = '';
    $('#hs-sum-pc').textContent = pcName('');
    $('#hs-sum-model').textContent = 'Reading the models…';
    $('#hs-go').disabled = true;
  }

  /** A role or PC asked for that the list has not got: the first role, this PC. A choice made since is kept. */
  function settle() {
    if (!d().roles.some(r => r.id === hs.role)) hs.role = d().roles[0]?.id ?? '';
    if (hs.pc && !d().pcs.some(p => p.id === hs.pc)) hs.pc = '';
  }

  /** A name nobody on the team has (nor the one in the box now): a woman's or a man's, at random. */
  function freeName(now = '') {
    const taken = new Set([...(d()?.staff ?? []).map(s => s.name.trim().toLowerCase()), now.trim().toLowerCase()]);
    const free = NAMES.filter(n => !taken.has(n.toLowerCase()));
    const list = free.length ? free : NAMES;
    return list[Math.floor(Math.random() * list.length)];
  }

  /**
   * Opens Hire staff: `role` and `pc` pick those first (a PC's window passes its own). `page`: as the Staff page, with
   * the Settings menu on the left; else a window over the page. `name`: typed on the Staff menu (`fromMenu`); else a
   * name is made up. Shown at once, never waiting on a linked PC: blurred stand-ins first (before any staff list has
   * come), then the PCs as they said last, then as they answer now (one that is off takes 3 s to give up on).
   */
  app.openHire = async ({ role = '', pc = '', page = false, name = '', fromMenu = false, move = null } = {}) => {
    const turn = ++hs.turn;
    hs.role = role;
    hs.pc = pc === 'here' ? '' : pc;
    hs.model = '';
    // Moving a hire: the same window, their own name, look and role, and Move for Hire.
    hs.move = move;
    dlg.classList.toggle('hs-moving', !!move);
    $('#hs-name').readOnly = !!move;
    $('#hs-title').textContent = move ? `Move ${move.first} to another PC` : 'Hire staff';
    $('#hs-go').textContent = move ? `Move ${move.first} here` : 'Hire staff';
    hs.lookPicked = !!move?.look;
    hs.look = move?.look ?? null;
    hs.q = '';
    hs.net = null;
    hs.fromMenu = fromMenu;
    $('#hs-name').value = move ? move.name : name.trim() || freeName();
    $('#hs-search').value = '';
    fault('');
    closeLook();
    drawLook();
    if (d()?.roles) {
      settle();
      drawRoles();
      drawAll();
    } else drawWaiting();
    if (page) app.showAsPage(dlg, 'staff');
    else {
      // Shown as the page before: back to a window of its own (closing it there goes back to where it was opened from).
      if (dlg.classList.contains('as-page')) {
        dlg.close();
        dlg.classList.remove('as-page');
        document.body.append(dlg);
      }
      if (!dlg.open) dlg.showModal();
    }
    // The made-up name is selected: typing replaces it.
    $('#hs-name').focus();
    $('#hs-name').select();
    void loadNet(turn);
    for (const known of [true, false]) {
      let got;
      try {
        got = await api(`/api/staff${known ? '?known=1' : ''}`);
      } catch (e) {
        if (!known && turn === hs.turn && dlg.open && !d()?.roles) fault(e.message);
        continue;
      }
      // Closed, or opened again, while the list was read: nothing is drawn over what is on screen now.
      if (turn !== hs.turn || !dlg.open) return;
      const first = !d()?.roles;
      team.data = got;
      settle();
      if (first) drawRoles();
      if (!hs.look) drawLook();
      drawAll();
    }
  };
  /** Edit staff's "Move to another PC, see more models": this window for that hire, on the PC they work on now. */
  app.openMove = (m, pc = '') => app.openHire({ role: m.role, pc: pc || 'here', move: { id: m.id, name: m.name, first: m.name.split(/s+/)[0], look: m.look ?? null, model: m.model ?? null } });
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

  $('#hs-look-btn').replaceChildren(app.pencilIcon?.() ?? '✎');
  $('#hs-look-btn').addEventListener('click', openLook);
  // The search is inside the form: Enter there only filters, it never presses Hire.
  $('#hs-search').addEventListener('keydown', e => {
    if (e.key === 'Enter') e.preventDefault();
  });
  $('#hs-search').addEventListener('input', e => {
    hs.q = e.target.value;
    drawModels();
    drawAllModels();
    drawSummary();
  });
  /** A random name for `box`: never one already on the team or the one in the box now (Random here, the Staff menu's dice). */
  app.randomName = box => {
    box.value = freeName(box.value);
    box.focus();
    if (box === $('#hs-name')) nameChanged();
  };
  $('#hs-random').addEventListener('click', () => app.randomName($('#hs-name')));
  $('#hs-subrole').addEventListener('change', e => pickRole(e.target.value));
  // A name typed: the look follows it (a woman's name, a woman) until a look is chosen by hand.
  $('#hs-name').addEventListener('input', nameChanged);
  // Add new: the Models page (Models: add or remove), as "get a model" does.
  $('#hs-add-model').addEventListener('click', () => {
    dlg.close();
    app.openModels(kind() === 'image' ? 'image' : 'chat');
  });
  // Back to where Hire staff was opened from (as a page: Settings, or All staff; else the page under the window).
  const leave = () => dlg.close();
  $('#hs-cancel').addEventListener('click', leave);
  $('#hs-close').addEventListener('click', leave);
  // See all staff opens the list of everyone (it used to open the person last edited).
  $('#hs-see-staff').addEventListener('click', () => {
    if (!dlg.classList.contains('as-page')) dlg.close();
    app.seeAllStaff({ fromMenu: hs.fromMenu });
  });
  $('#hs-form').addEventListener('submit', async e => {
    e.preventDefault();
    const go = $('#hs-go');
    const goText = go.textContent;
    go.disabled = true;
    go.textContent = hs.move ? 'Moving…' : 'Hiring…';
    fault('');
    try {
      if (hs.move) {
        team.data = await api('/api/staff', { action: 'change', id: hs.move.id, model: hs.model });
        dlg.close();
        await app.afterMove?.(hs.move.id);
        return;
      }
      team.data = await api('/api/staff', { action: 'hire', name: $('#hs-name').value, role: hs.role, model: hs.model || undefined, look: hs.look ?? undefined });
      dlg.close();
      // The rest of the page catches up (left panel, Home, chats, faces); a hire with no model opens their profile.
      await app.afterHire?.(team.data.staff.at(-1));
    } catch (err) {
      fault(err.message);
    } finally {
      go.disabled = false;
      go.textContent = goText;
      drawSummary();
    }
  });
}
