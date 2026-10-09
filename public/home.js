// Home: the left rail (Home, the chats, the staff with their state, other PCs, set-up links) and the Home view (what is
// waiting for you, what is working now, paused jobs, "Lets create a project" and the recent projects). Every line comes from /api/home, written by code
// from the job files and the model states, never by a model. On a phone the rail is the first screen, like Teams.
// Uses app.js's helpers ($, el, api, store, app, panes, loadModels, drawChat) and team.js's useModelOf.
'use strict';

const homeUi = { data: null, pcs: [], view: 'home', drawn: {}, pcMem: {}, dragging: null };
// "32 GB / 4 GB VRAM", "16 GB / 0 VRAM": the memory, then the graphics card's own (none when the graphics use the RAM).
/** A backup disk in words: "931 GB, 412 GB free" (TB from 1 TB up). */
const diskWords = k => { const w = n => n >= 2 ** 40 ? `${(n / 2 ** 40).toFixed(1)} TB` : gb(n); return `${w(k.total)} disk, ${w(k.free)} free`; };
const memWords = (ram, vram) => `${Math.round(ram / 2 ** 30)} GB / ${vram ? `${Math.round(vram / 2 ** 30)} GB VRAM` : '0 VRAM'}`;
/** A PC's name as you gave it (the PC window), else its make and model, else `fallback`; and its make and model. */
const pcName = (key, fallback) => app.pcProfileOf?.(key)?.name || app.pcProfileOf?.(key)?.model || fallback;
const pcMake = key => (app.pcProfileOf?.(key)?.name ? app.pcProfileOf(key).model : '');
const shell = $('#shell');
const phone = window.matchMedia('(max-width: 760px)');
const PICTURE_RUNNING = ['queued', 'starting', 'drawing', 'decoding', 'finishing'];

// ---- Which view: Home, the chat and image panes, or (phone only) the list ----

function setView(view) {
  homeUi.view = view;
  shell.dataset.view = view;
  if (view !== 'rail') store('view', view);
  if (view === 'home') $('#home').scrollTop = 0;
  drawRail();
  // The top bar shows a linked PC only while a chat with someone on it is on screen (chats.js).
  app.onView?.(view);
}
app.showPanes = () => setView('chat');
for (const b of document.querySelectorAll('[data-back]')) b.addEventListener('click', () => setView('rail'));
$('#rail-home').addEventListener('click', () => setView('home'));
$('#rail-home-row').addEventListener('click', () => setView('home'));
phone.addEventListener('change', e => {
  if (!e.matches && homeUi.view === 'rail') setView(store('view') === 'chat' ? 'chat' : 'home');
});
// The chat is where the page starts (the Chats tab beside it lists the chats); Home opens first only when it was left open.
setView(phone.matches ? 'rail' : store('view') === 'home' ? 'home' : 'chat');
// The staff list under "Staff" starts open; folding it is kept in this browser.
$('#rail-staff-fold').open = store('staff-open') !== '0';
$('#rail-staff-fold').addEventListener('toggle', e => store('staff-open', e.target.open ? '1' : '0'));
$('#rail-setup-fold').open = store('setup-open') !== '0';
$('#rail-setup-fold').addEventListener('toggle', e => store('setup-open', e.target.open ? '1' : '0'));
// Home's "Waiting for you" panel folds to a strip (it keeps the number); folding it is kept in this browser.
$('#home-side-fold').open = store('home-waiting-open') !== '0';
$('#home-side').classList.toggle('folded', !$('#home-side-fold').open);
$('#home-side-fold').addEventListener('toggle', e => {
  $('#home-side').classList.toggle('folded', !e.target.open);
  store('home-waiting-open', e.target.open ? '1' : '0');
});
// Its two tabs, Waiting for you | Staff overview (the one picked is kept in this browser). A tab never folds the panel:
// pressed while it is folded to its strip, it opens it on that tab.
const homeTabs = [$('#tab-waiting'), $('#tab-home-staff')];
function homeTab(tab, focus = false) {
  for (const t of homeTabs) {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    $(`#${t.getAttribute('aria-controls')}`).hidden = !on;
  }
  if (focus) tab.focus();
  store('home-side-tab', tab.id);
}
for (const t of homeTabs) {
  t.addEventListener('click', e => {
    e.preventDefault();
    $('#home-side-fold').open = true;
    homeTab(t);
  });
  t.addEventListener('keydown', e => {
    const i = homeTabs.indexOf(t);
    const to = e.key === 'ArrowRight' || e.key === 'ArrowLeft' ? homeTabs[(i + 1) % 2] : e.key === 'Home' ? homeTabs[0] : e.key === 'End' ? homeTabs[1] : null;
    if (!to) return;
    e.preventDefault();
    homeTab(to, true);
  });
}
{
  const kept = homeTabs.find(t => t.id === store('home-side-tab'));
  if (kept) homeTab(kept);
}

// ---- Talking to someone ----

/** The manager is the plain "who" last chosen (Standard, Professional, Friend), never a hire. */
function plainWho() {
  const list = app.models?.who ?? [];
  const kept = store('plain-who');
  return list.some(w => w.id === kept) ? kept : list.find(w => !w.staff)?.id ?? 'standard';
}
const keepPlain = v => {
  if (v && !String(v).startsWith('staff:')) store('plain-who', v);
};
$('#who').addEventListener('change', e => keepPlain(e.target.value));

async function talkTo(row) {
  // Someone asleep opens straight to their chat: Connect there loads their model (nothing loads by itself).
  try {
    if (row !== 'manager' && row.kind === 'image') {
      // An artist, here or on a linked PC: their own chat opens, in the pictures pane. What is typed there is drawn
      // just as typed: no chat model rewrites it first.
      await app.openArtist(row.who ?? `staff:${row.id}`);
      refresh();
      return;
    }
    if (row === 'manager') {
      await api('/api/settings', { who: plainWho() });
      await loadModels();
      // The host's own model (its pencil), as a hire's chat picks theirs.
      await useModelOf({ model: app.models?.settings?.hostModel, kind: 'chat' });
      showChat(await api('/api/chat'));
    } else if (row.who) {
      // Someone who lives on a paired PC: their latest chat opens (they answer there).
      await api('/api/settings', { who: row.who });
      await loadModels();
      showChat(await api('/api/chat'));
    } else {
      await api('/api/settings', { who: `staff:${row.id}` });
      await loadModels();
      showChat(await api('/api/chat'));
      await useModelOf(row);
    }
  } catch (e) {
    app.chatNote?.(e.message);
  }
  setView('chat');
  if (!phone.matches) $('#chat-input').focus();
  refresh();
}

// ---- The rail ----

/** A row's expected speed (" · 12 tok/s"), from a figure or a speed summary; nothing until it is measured. */
const tokSub = v => {
  const n = typeof v === 'number' ? v : v?.expect;
  return n ? ` · ${app.speedWords(n, true)}` : '';
};

const initials = name => name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();

/** A dot with a shape per state (filled, ring, broken ring) and the word written next to it: colour is never the only sign. */
const dot = state => el('span', { class: 'sdot', 'data-state': state, 'aria-hidden': 'true' });
/** The one word shown beside the dot; the whole sentence is in the row's tooltip. */
const STATE_WORD = { on: 'On', waking: 'Waking up', asleep: 'Asleep', off: 'Off', none: 'Not set up' };
/** A hire's or a PC's activity: green available, yellow busy, red its owner is using the PC, grey offline (a shape each too). */
const ACTIVITY_WORD = { available: 'Available', busy: 'Busy', owner: 'In use by its owner', offline: 'Offline' };
const activityDot = a => el('span', { class: 'sdot', 'data-activity': a, 'aria-hidden': 'true' });

/**
 * A person in the left panel. With `level` (a hire): "Name | Level", the software under it, and a third line only when
 * they are working or muted (how they are otherwise is the dot's shape on their icon, and the tooltip).
 */
function staffRow({ key, name, avatar, sub, level, state, stateText, activity, busy, count, active, title, onClick, onEdit, editTitle, mutable = true }) {
  // Muted (right-click the row, or Mute all): a bell with a line and "Muted until …", a grey dot in place of the number.
  const muted = mutable ? app.mutedBy?.([key]) : null;
  const bits = app.muteBits?.(muted, count) ?? { icon: null, count: count ? el('span', { class: 'rail-count', text: String(count) }) : null };
  const word = activity ? ACTIVITY_WORD[activity] : busy ? 'Working' : STATE_WORD[state] ?? stateText;
  const mark = activity ? activityDot(activity) : dot(state);
  const b = el('button', { class: 'rail-row', type: 'button', 'data-key': key, title: `${title}\n${name}: ${sub}\n${busy ?? stateText}${muted ? `\nMuted ${muted.text}` : mutable ? '\nTo mute: right-click, or the … in the chat' : ''}`, 'aria-current': active ? 'true' : null },
    app.avatar ? app.avatar(key, avatar, mark) : el('span', { class: 'rail-avatar', 'aria-hidden': 'true' }, avatar, mark),
    el('span', { class: 'rail-text' },
      el('span', { class: 'rail-name' }, name, level ? el('span', { class: 'rail-level', text: ` | ${level}` }) : null),
      el('span', { class: 'rail-sub', text: sub }),
      level && !busy && !muted ? null : el('span', { class: `rail-state ${activity ? `a-${activity}` : `s-${busy ? 'on' : state}`}`, text: [busy && level ? 'Working' : word, app.mutedWords?.(muted)].filter(Boolean).join(' · ') })),
    bits.icon, bits.count);
  b.addEventListener('click', onClick);
  if (!onEdit) return el('li', {}, b);
  const edit = el('button', { class: 'rail-edit', type: 'button', title: editTitle ?? `Edit ${name}: role, level, model`, 'aria-label': `Edit ${name}` }, app.pencilIcon?.());
  edit.addEventListener('click', onEdit);
  return el('li', { class: 'rail-staff-item' }, b, edit);
}

function drawRail() {
  const d = homeUi.data;
  const onHome = homeUi.view === 'home';
  for (const b of [$('#rail-home'), $('#rail-home-row')]) {
    if (onHome) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  if (!d) return;
  const n = d.waiting.length;
  // A muted job or person's item still waits on Home, without a number; failed tests still count while "stuck still tells me" is on.
  const loud = d.waiting.filter(x => (x.kind === 'tests' && app.stuckTells?.()) || !app.mutedBy?.([`room:${x.job}`, x.staffId ? `staff:${x.staffId}` : null])).length;
  $('#rail-count').hidden = !n;
  $('#rail-count').classList.toggle('is-muted', !!n && !loud);
  $('#rail-count').textContent = loud ? String(loud) : '';
  $('#rail-home').title = `Home: ${n ? `${n} to review${n > loud ? ` (${n - loud} muted)` : ''}` : d.working ? 'work in progress' : 'nothing waiting'}`;
  $('#rail-count').setAttribute('aria-label', n > loud ? `${n} to review, ${n - loud} muted` : `${n} to review`);
  // The Home row says the same as the logo's number, in words.
  $('#rail-home-count').hidden = !n;
  $('#rail-home-count').classList.toggle('is-muted', !!n && !loud);
  $('#rail-home-count').textContent = loud ? String(loud) : '';
  $('#rail-home-count').setAttribute('aria-label', $('#rail-count').getAttribute('aria-label'));
  // The Waiting for you panel's own number: a folded panel still says something is waiting.
  $('#home-waiting-count').hidden = !n;
  $('#home-waiting-count').classList.toggle('is-muted', !!n && !loud);
  $('#home-waiting-count').textContent = loud ? String(loud) : '';
  $('#home-waiting-count').setAttribute('aria-label', $('#rail-count').getAttribute('aria-label'));
  $('#rail-home-sub').textContent = n ? `${n} waiting for you${n > loud ? ` (${n - loud} muted)` : ''}` : d.working ? 'Work in progress' : 'Nothing waiting';
  const inChat = homeUi.view === 'chat';
  // Marked: the person in the chat on screen in this window (the server's "who" is whichever window chose last).
  const onScreen = String(chatUi.open?.who ?? '');
  const marked = (key, server) => (onScreen ? onScreen === key : server);
  const counts = {};
  for (const x of d.waiting) if (x.staffId) counts[x.staffId] = (counts[x.staffId] ?? 0) + 1;
  const m = d.manager;
  const mp = chatUi.people.find(p => p.who === 'manager');
  // The host is not one of the staff: its own row, above the Staff list (which may be folded). Off for now: no row.
  $('#rail-host').hidden = !m;
  if (m) keepFocus($('#rail-host'), [staffRow({
    key: 'manager', name: mp?.name ?? 'The host', avatar: mp?.avatar ?? 'H', sub: `Host · ${m.modelName || 'no model picked'}${tokSub(m.speed)}`, state: m.state, stateText: m.text,
    active: inChat && marked('manager', m.active), title: `Talk to ${app.inSentence?.(mp?.name ?? 'The host') ?? 'the host'}: this PC's own assistant, not one of the staff`, onClick: () => talkTo('manager'),
    onEdit: () => app.editHost?.(), editTitle: `Edit ${mp?.name ?? 'the host'}: its model and name`,
  })]);
  const rows = [];
  const showing = $('#panes').dataset.show;
  for (const s of d.staff) {
    const li = staffRow({
      key: `staff:${s.id}`, name: s.name, avatar: initials(s.name), level: s.level || 'Default', sub: s.modelName || 'no model given', state: s.state, stateText: s.text, activity: s.activity,
      busy: s.busy ? `Working: ${s.busy}` : null, count: counts[s.id], active: inChat && (s.kind === 'image' ? s.active && showing === 'image' : marked(`staff:${s.id}`, s.active)),
      title: `${s.role}${s.pc ? ` on ${s.pc}` : ''}${tokSub(s.speed)}. Press: a new chat, or one of their recent chats`,
      onClick: () => (app.openPerson ? app.openPerson(s.who ?? `staff:${s.id}`, s.name) : talkTo(s)), onEdit: () => app.editStaff?.(s.id),
    });
    deskDrag(li, s);
    rows.push(li);
  }
  if (!rows.length) rows.push(el('li', { class: 'rail-empty' }, el('span', { class: 'hint', text: 'Nobody hired yet.' }), el('button', { class: 'btn primary rail-hire', type: 'button', text: 'HIRE STAFF', onclick: () => app.openHire() })));
  $('#rail-staff-title').textContent = d.staff.length ? `Staff (${d.staff.length})` : 'Staff';
  keepFocus($('#rail-staff'), rows);
  app.drawChats?.();
  // The hardware: this PC, then each linked PC, each a desk with the staff who work on it sitting on top (their icon,
  // with the same dot). A hire is dragged onto another PC to move them there. Under each PC's name: what it can hold
  // (RAM, and the graphics card's own memory), then what it has loaded; a PC that is off shows the numbers it gave last.
  const hw = app.status?.hardware;
  const desks = [{ id: '', row: staffRow({
    key: 'pc:mine', name: pcName('here', 'My PC'), avatar: 'PC', sub: [hw ? memWords(hw.ram.total, hw.gpu && !hw.gpu.shared ? hw.gpu.total : 0) : 'This PC', pcMake('here')].filter(Boolean).join(' · '), state: 'on', stateText: 'This PC', activity: 'available',
    title: 'My PC: its uptime, total tokens and what its work cost', onClick: () => app.openPc?.('here'), mutable: false,
  }) }];
  for (const p of homeUi.pcs) {
    if (p.ram) homeUi.pcMem[p.id] = { ram: p.ram, vram: p.vram };
    const mem = homeUi.pcMem[p.id];
    // A "Backups only" PC: no staff work there, so its card says what it keeps instead of what it has loaded.
    const sub = p.backupsOnly ? [mem ? memWords(mem.ram, mem.vram) : '', pcMake(p.id), 'Backups only', p.disk ? diskWords(p.disk) : '']
      : [mem ? memWords(mem.ram, mem.vram) : '', pcMake(p.id), p.model, p.speed?.expect ? app.speedWords(p.speed.expect, true) : '', p.picture ? `draws with ${p.picture}` : ''];
    desks.push({ id: p.id, name: pcName(p.id, p.name), activity: p.activity, backupsOnly: p.backupsOnly, row: staffRow({
      key: `pc:${p.id}`, name: pcName(p.id, p.name), avatar: 'PC', sub: sub.filter(Boolean).join(' · ') || p.url, state: p.state, stateText: p.backupsOnly && p.activity !== 'offline' ? 'Backups only: keeps backups, no staff' : p.text, activity: p.activity,
      title: `${p.name} at ${p.url}: its uptime, total tokens and what its work cost`, onClick: () => app.openPc?.(p.id), mutable: false,
    }) });
  }
  const card = x => {
    const on = d.staff.filter(s => (s.pcId ?? '') === x.id);
    const li = el('li', { class: 'pc-card', 'data-pc': x.id, ...(x.backupsOnly ? { 'data-backups': '1' } : {}) },
      on.length ? el('div', { class: 'pc-desk', 'aria-label': `Working on ${x.name ?? 'this PC'}` }, ...on.map(s => {
        const b = el('button', { class: 'desk-face', type: 'button', title: `${s.name} (${s.role}): ${ACTIVITY_WORD[s.activity] ?? ''}. Drag onto another PC to move them`, 'aria-label': `${s.name}, ${ACTIVITY_WORD[s.activity] ?? ''}` },
          app.avatar ? app.avatar(`staff:${s.id}`, initials(s.name), activityDot(s.activity)) : el('span', { class: 'rail-avatar' }, initials(s.name), activityDot(s.activity)));
        b.addEventListener('click', () => talkTo(s));
        deskDrag(b, s);
        return b;
      })) : null,
      ...x.row.childNodes);
    deskDrop(li, x);
    return li;
  };
  $('#rail-pcs-box').hidden = false;
  keepFocus($('#rail-mypc'), [card(desks[0])]);
  $('#rail-pcs-title').hidden = desks.length < 2;
  keepFocus($('#rail-pcs'), desks.slice(1).map(card));
  // The office in Staff overview (office.js): the same desks and staff; in a chat it follows the person talked to.
  app.office?.update({
    staff: d.staff,
    desks: desks.map(x => ({ key: x.id, name: x.name ?? pcName('here', 'My PC'), activity: x.activity ?? 'available' })),
    // The person the chat is with: the open chat's, or (a new chat, no message yet) the one picked. A picture hire is
    // always "active" as the one who draws, so that alone is not followed.
    follow: inChat ? app.chatPersonId() : null,
  });
  drawStaffOverview(counts);
  app.drawMuteBar?.();
}

/** A speech bubble: the chat button on each Staff overview card. */
const CHAT_BUBBLE = 'M5 3h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4.3A2 2 0 0 1 3 15V5a2 2 0 0 1 2-2Z';

/**
 * Staff overview: a tab in Home's right panel and in the chat's. Each hire in two lines: their name, then their PC and
 * its RAM; held under the pointer, the software they run and what they are doing. The chat button opens their chat;
 * pressing the name (or the card) follows them in the office above.
 */
function drawStaffOverview(counts) {
  const d = homeUi.data;
  const hw = app.status?.hardware;
  const sig = JSON.stringify([d.staff, counts, hw?.ram?.total ?? 0, homeUi.pcMem]);
  if (sig === homeUi.drawn.overview) return;
  homeUi.drawn.overview = sig;
  const follow = s => app.office?.select(s.id);
  const ramOf = s => (s.pcId ? homeUi.pcMem[s.pcId]?.ram : hw?.ram?.total) ?? 0;
  const card = s => {
    const doing = s.doingText ?? (s.busy ? `Working: ${s.busy}` : ACTIVITY_WORD[s.activity] ?? s.text ?? '');
    const ram = ramOf(s);
    const where = `${s.pc || pcName('here', 'My PC')}${ram ? ` · ${Math.round(ram / 2 ** 30)} GB RAM` : ''}`;
    const hover = [s.modelName || 'No model given', counts[s.id] ? `${doing} · ${counts[s.id]} waiting for you` : doing].filter(Boolean).join('\n');
    return el('li', { class: 'so-card', title: hover, onclick: e => { if (!e.target.closest('button')) follow(s); } },
      app.avatar ? app.avatar(`staff:${s.id}`, initials(s.name), activityDot(s.activity)) : el('span', { class: 'rail-avatar', 'aria-hidden': 'true' }, initials(s.name), activityDot(s.activity)),
      el('button', { class: 'so-name', type: 'button', title: hover, 'aria-label': `${s.name}, ${where}. ${hover.replace('\n', '. ')}. Show ${s.name} in the office.`, onclick: () => follow(s) },
        el('strong', { text: s.name }), el('span', { class: 'so-where', text: where })),
      el('button', { class: 'icon-btn so-chat', type: 'button', title: `Chat with ${s.name}`, 'aria-label': `Chat with ${s.name}`, onclick: () => talkTo(s) }, svgIcon(CHAT_BUBBLE, 18)));
  };
  const empty = () => el('li', { class: 'home-empty so-empty' }, el('span', { text: 'Nobody hired yet.' }), el('button', { class: 'btn primary', type: 'button', text: 'HIRE STAFF', onclick: () => app.openHire() }));
  for (const list of [$('#home-staff-overview'), $('#side-staff')]) keepFocus(list, d.staff.length ? d.staff.map(card) : [empty()]);
}

// ---- The hot desk: drag a hire onto another PC to move them there (where it has software for them) ----

/** Where a hire could run on one PC ('' = this PC): that PC's models of their kind (chat, or picture). */
function deskModels(s, pc) {
  // A hidden model is left out (unless "Show hidden" is ticked): a hire is moved onto models offered for picking.
  const list = visibleModels(team.data?.hireChoices?.[s.kind === 'image' ? 'image' : 'chat'] ?? []);
  // On a linked PC: the models it lets this PC use. "What it has loaded" counts only when something is loaded there:
  // a PC that shares nothing (its ticks under Nodes and memory) offers nothing to move to.
  return pc ? list.filter(c => c.id.startsWith(`remote:${pc}:`) || (c.id === `remote:${pc}` && c.ok !== false)) : list.filter(c => !c.id.startsWith('remote:'));
}

function deskDrag(node, s) {
  node.draggable = true;
  node.addEventListener('dragstart', e => {
    homeUi.dragging = s;
    e.dataTransfer.setData('text/plain', s.name);
    e.dataTransfer.effectAllowed = 'move';
    // The PCs they could work on light up; the one they are on, or one that is off or in use by its owner, does not.
    for (const c of document.querySelectorAll('.pc-card')) {
      const pc = c.dataset.pc;
      const here = (s.pcId ?? '') === pc;
      const shut = c.querySelector('.sdot')?.dataset.activity === 'offline' || c.querySelector('.sdot')?.dataset.activity === 'owner' || c.dataset.backups === '1';
      c.classList.toggle('drop-ok', !here && !shut);
      c.classList.toggle('drop-no', here || shut);
    }
  });
  node.addEventListener('dragend', () => {
    homeUi.dragging = null;
    for (const c of document.querySelectorAll('.pc-card')) c.classList.remove('drop-ok', 'drop-no', 'drop-over');
  });
}

function deskDrop(li, x) {
  li.addEventListener('dragover', e => {
    if (!homeUi.dragging || !li.classList.contains('drop-ok')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    li.classList.add('drop-over');
  });
  li.addEventListener('dragleave', () => li.classList.remove('drop-over'));
  li.addEventListener('drop', e => {
    const s = homeUi.dragging;
    if (!s || !li.classList.contains('drop-ok')) return;
    e.preventDefault();
    deskMove(s, x.id, x.name ?? 'My PC');
  });
}

/** The hire the chat pane is with (their id), or null: the open chat's person, else the one picked for a new chat. */
app.chatPersonId = () => {
  const who = String(chatUi.open?.who ?? app.models?.settings?.who ?? '');
  return who.startsWith('staff:') ? who.slice(6) : null;
};

// The office (office.js) moves people with the same window, and takes a person dragged from the left panel.
app.deskMove = (s, pc, name) => deskMove(s, pc, name);
app.deskDragging = () => homeUi.dragging;

/** The move window: the software on that PC for them (their own model first when it is there), or why there is none. */
const moveDlg = $('#desk-move');
async function deskMove(s, pc, pcName) {
  try {
    team.data = await api('/api/staff');
  } catch (err) {
    return sayHere($('#home-ask-say'), err.message);
  }
  const models = deskModels(s, pc);
  const short = n => String(n ?? '').replace(/ on ".*$/, '').toLowerCase();
  const same = models.find(c => short(c.name) === short(s.modelName));
  $('#desk-move-title').textContent = `Move ${s.name} to ${pcName}`;
  const sel = $('#desk-move-model');
  sel.replaceChildren(...models.map(c => el('option', { value: c.id, text: c.name.replace(/ on ".*?"/, '') })));
  if (same) sel.value = same.id;
  $('#desk-move-row').hidden = !models.length;
  $('#desk-move-go').hidden = !models.length;
  $('#desk-move-fault').hidden = true;
  const line = $('#desk-move-line');
  const box = $('#desk-move-send');
  box.replaceChildren();
  const own = s.model && !String(s.model).startsWith('remote:') ? s.model : '';
  if (same) line.textContent = `${pcName} has ${s.modelName}: ${s.name} keeps the same software there.`;
  else if (models.length) line.textContent = `${pcName} does not have ${s.modelName || 'their model'}. Pick the software ${s.name} runs on there${pc && own ? ', or send a copy of theirs first' : ''}.`;
  else line.textContent = pc ? "The staff can't log in to this machine, go to the machine, and check its permissions." : `This PC has no ${s.kind === 'image' ? 'picture' : 'chat'} models yet.`;
  // Their model is on this PC and the target is a node: a copy can go there first (the node must allow it).
  if (pc && own && !same) box.append(el('button', { class: 'btn', type: 'button', text: `Send ${s.modelName} to ${pcName}`, onclick: async e => {
    e.target.disabled = true;
    try {
      await api('/api/network/send', { pc, kind: s.kind === 'image' ? 'image' : 'chat', model: own });
      moveDlg.close();
      app.openNet?.();
    } catch (err) {
      $('#desk-move-fault').textContent = err.message;
      $('#desk-move-fault').hidden = false;
      e.target.disabled = false;
    }
  } }));
  if (!pc && !models.length) box.append(el('button', { class: 'btn', type: 'button', text: 'Get models', onclick: () => { moveDlg.close(); app.openModels(); } }));
  moveDlg.dataset.id = s.id;
  moveDlg.showModal();
}
$('#desk-move-cancel').addEventListener('click', () => moveDlg.close());
$('#desk-move-go').addEventListener('click', async () => {
  const go = $('#desk-move-go');
  go.disabled = true;
  try {
    team.data = await api('/api/staff', { action: 'change', id: moveDlg.dataset.id, model: $('#desk-move-model').value });
    moveDlg.close();
    await refresh();
  } catch (err) {
    $('#desk-move-fault').textContent = err.message;
    $('#desk-move-fault').hidden = false;
  } finally {
    go.disabled = false;
  }
});

const timeText = iso => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};
// ---- Nodes and memory: this PC as a node (and the models other PCs may use), the linked PCs as tiles with their
// memory bars, and the models on this PC. Every figure comes from /api/nodes (measured by the memory samplers). ----

const NODE_GB = n => `${(n / 2 ** 30).toFixed(n >= 10 * 2 ** 30 ? 0 : 1)} GB`;

/** A memory bar: each part shaded differently and named in the line under it. */
function memBar(bar, label) {
  const track = el('div', { class: 'mbar', role: 'img', 'aria-label': `${label}: ${bar.text}` });
  for (const s of bar.segments) {
    const part = el('span', { class: `mb mb-${s.kind}`, title: `${s.label}: ${NODE_GB(s.bytes)}` });
    // Set through the style property: the page's security policy ignores a style attribute.
    part.style.width = `${(s.share * 100).toFixed(2)}%`;
    track.append(part);
  }
  return el('div', { class: 'mbar-box' }, el('span', { class: 'mbar-title', text: label }), track, el('span', { class: 'hint', text: bar.text }));
}

function drawNodes(n) {
  homeUi.nodes = n;
  drawNodeSwitch(n);
  // This PC's memory and what is loaded are in the top bar (its rings and the models loaded).
  const msig = JSON.stringify([n.models, homeUi.modelSay]);
  if (msig !== homeUi.drawn.models) {
    homeUi.drawn.models = msig;
    // Tiles three across, in Standard models, Image creation models and Hidden (the names used for the share list).
    const part = (title, list) => (list.length ? [el('h4', { class: 'node-models-sub', text: title }), el('div', { class: 'node-models-grid' }, ...list.map(modelTile))] : []);
    const shown = n.models.filter(x => !x.hidden);
    keepFocus($('#node-models'), n.models.length ? [
      ...part('Standard models', shown.filter(x => x.kind === 'chat')),
      ...part('Image creation models', shown.filter(x => x.kind === 'image')),
      ...part('Hidden', n.models.filter(x => x.hidden)),
    ] : [el('p', { class: 'hint', text: 'No models on this PC yet. Models shows which ones fit.' })]);
  }
}

/** What a model's tile last said (a speed test that failed, a Delete refused), kept across the redraws. */
homeUi.modelSay = {};
function modelSay(id, text) {
  if (text) homeUi.modelSay[id] = text;
  else delete homeUi.modelSay[id];
  homeUi.drawn.models = '';
  refreshNodes();
}

/** A model hidden, shown or deleted: the lists a model is picked from are read again (chat, Hire staff, Edit Staff). */
function modelListsChanged() {
  loadModels().catch(() => undefined);
  teamLoad().catch(() => undefined);
  app.hireRedraw?.();
}

/** One model on this PC: its size, whether it is loaded, its speed; Test speed, Hide (or Unhide) and Delete. */
function modelTile(x) {
  const key = `model:${x.id}`;
  const facts = [`${NODE_GB(x.bytes)} file`, x.loaded ? 'loaded now' : '', x.speed?.expect ? `${app.speedWords(x.speed.expect)} (${x.speed.basis === 'answers' ? `${x.speed.average.n} answers` : 'tested'})` : '', x.ollama ? 'kept by Ollama' : ''].filter(Boolean).join(' · ');
  const hide = el('button', { class: 'link', type: 'button', text: x.hidden ? 'Unhide' : 'Hide', 'data-key': `${key}:hide`, title: x.hidden ? 'Show it again where a model is picked' : 'Keep it (and its speed tests) but leave it out where a model is picked' });
  hide.addEventListener('click', async () => {
    hide.disabled = true;
    try {
      await api('/api/models/hide', { id: x.id, kind: x.kind, hidden: !x.hidden });
      modelSay(x.id, '');
      modelListsChanged();
    } catch (e) {
      modelSay(x.id, e.message);
    }
  });
  // Hidden keeps a model from being deleted; Ollama's own models are removed in Ollama.
  let del = null;
  if (!x.hidden && !x.ollama) {
    del = el('button', { class: 'link danger', type: 'button', text: 'Delete', 'data-key': `${key}:del` });
    del.addEventListener('click', async () => {
      const users = x.usedBy?.length ? ` ${x.usedBy.join(', ')} ${x.usedBy.length > 1 ? 'work' : 'works'} on it and would need another model.` : '';
      if (!(await askHere($('#node-models-ask'), `Delete ${x.name} from this PC? It frees ${NODE_GB(x.bytes)} and cannot be undone.${users}`, `Delete ${x.name}`, 'Keep it'))) return;
      try {
        await api('/api/models/delete', { id: x.id, kind: x.kind });
        modelSay(x.id, '');
        modelListsChanged();
      } catch (e) {
        modelSay(x.id, e.message);
      }
    });
  }
  const say = homeUi.modelSay[x.id];
  return el('div', { class: `node-model${x.hidden ? ' hidden-model' : ''}` },
    el('strong', { class: 'node-model-name', text: x.name }),
    el('span', { class: 'hint', text: facts }),
    el('div', { class: 'node-model-acts' },
      x.kind === 'chat' ? app.speedLink(`model:${x.id}`, msg => modelSay(x.id, msg), ok => {
        if (ok) modelSay(x.id, '');
        else refreshNodes();
      }) : null,
      hide, del),
    say ? el('p', { class: 'hint fault-line', role: 'status', text: say }) : null);
}

/** This PC as a node: one tick, then its setup (name, setup code, optional PIN, port) and the PCs linked to it. */
function drawNodeSwitch(n) {
  const sh = n.share;
  const typing = el => document.activeElement === el;
  // While a change is being saved (and its PIN window is open) the boxes keep what was just clicked; once it is saved, or
  // cancelled, they show what the server has, focused or not (a tick cannot be half typed). Drawn from the 3-second
  // refresh before, a box could show the opposite of the server after the PIN window, and the next click undid the change.
  const saving = homeUi.nodeSaving > 0;
  if (!saving) $('#node-on').checked = sh.on;
  $('#node-on-line').textContent = sh.error ? `Not shared: ${sh.error}`
    : sh.on && sh.listening ? 'Enter the setup code into the other PCs to allow them remote access.'
    : 'Off. Tick to let your main PC use this PC\'s models (home network only).';
  $('#node-setup').hidden = !sh.on;
  if (!typing($('#node-name')) && !saving) $('#node-name').value = sh.name;
  if (!typing($('#node-port')) && !saving) $('#node-port').value = String(sh.port);
  $('#node-code').textContent = sh.code;
  const asig = JSON.stringify(sh.addresses);
  if (asig !== homeUi.drawn.addrs) {
    homeUi.drawn.addrs = asig;
    $('#node-addrs').replaceChildren(...(sh.addresses.length ? sh.addresses.map(a => {
      const copy = el('button', { class: 'link', type: 'button', text: 'Copy' });
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(a.address);
          copy.textContent = 'Copied';
        } catch {
          copy.textContent = 'Select it and copy';
        }
        setTimeout(() => { copy.textContent = 'Copy'; }, 2000);
      });
      return el('div', { class: 'node-code-row' }, el('code', { class: 'node-addr', text: a.address }), el('span', { class: 'hint', text: a.via }), copy);
    }) : [el('p', { class: 'hint', text: 'No home-network address: this PC is not connected to a router (check its Wi-Fi or cable).' })]));
  }
  if (!saving) $('#node-autostart').checked = !!sh.autostart;
  // The PC is asked to step aside on the lock screen only ("Send host": the main PC decides). While it is logged out,
  // this says so, and Start it again here brings it back before the hours are up.
  const away = sh.away ? new Date(sh.away).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null;
  $('#node-away').hidden = !away;
  $('#node-away-line').textContent = away
    ? `Stopped for a while since ${away}. The main PC was told "I need to log off for now" and sends the work elsewhere. It can start this PC again (within the hour it asks first), or press Start it again here.`
    : '';
  if (!saving) $('#node-pin-on').checked = sh.pinOn;
  $('#node-pin-line').hidden = !sh.pinOn;
  // Drawn again only when the PIN changes, so a click on New PIN is never lost to a refresh.
  if (sh.pinOn && $('#node-pin-line').dataset.pin !== sh.pin) {
    $('#node-pin-line').dataset.pin = sh.pin;
    $('#node-pin-line').replaceChildren(`PIN: ${sh.pin} `, el('button', { class: 'link', type: 'button', text: 'New PIN', onclick: () => nodeShare({ newPin: true }) }));
  }
  const psig = JSON.stringify(sh.paired);
  if (psig !== homeUi.drawn.paired) {
    homeUi.drawn.paired = psig;
    $('#node-paired').replaceChildren(...(sh.paired.length ? [el('p', { class: 'hint', text: 'PCs linked to this one:' }), ...sh.paired.map((x, k) => el('div', { class: 'job-remote' }, el('span', { text: x.name }), el('span', { class: 'hint', text: x.old ? 'linked before the link was encrypted: link it again from that PC' : `since ${new Date(x.at).toLocaleDateString()}` }),
      el('button', { class: 'link', type: 'button', text: 'Remove', onclick: async () => { if (await askHere($('#node-paired-ask'), `Stop lending to "${x.name}"? It would need the setup code again.`, `Stop lending to ${x.name}`, 'Keep it linked')) nodeShare({ unpair: k }); } })))] : [el('p', { class: 'hint', text: 'No PC has linked to this one yet.' })]));
  }
  drawNodeShare(sh);
  drawNodeAllow(sh);
}

/**
 * "Sharing permissions": Allow all, Sharing of models, Enable backups, Allow host to push models, Allow host to update
 * TOMLIN remotely. Each tick is saved
 * at once (with the app lock PIN); a refused or cancelled PIN puts the ticks back as saved at the next refresh.
 */
function drawNodeAllow(sh) {
  const a = sh.allow ?? { pull: false, backup: false, push: false };
  if (!homeUi.nodeSaving) {
    for (const t of document.querySelectorAll('#node-setup [data-allow]')) t.checked = a[t.dataset.allow] === true;
    const all = $('#node-allow-all');
    all.checked = a.pull && a.backup && a.push && a.update;
    all.indeterminate = !all.checked && (a.pull || a.backup || a.push || a.update);
  }
  $('#node-restarts').hidden = sh.restarts !== false;
  const up = sh.updated;
  $('#node-updated').hidden = !up;
  $('#node-updated').textContent = up ? `✓ Updated to TOMLIN ${up.version} by "${up.by}" on ${new Date(up.at).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}.` : '';
  const kept = sh.kept ?? [];
  const day = t => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' });
  const size = n => (n >= GB ? gb(n) : n >= 2 ** 20 ? `${Math.round(n / 2 ** 20)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  $('#node-kept').textContent = kept.length
    ? `Restore points kept here: ${kept.map(k => `${k.name} (${k.count}, ${size(k.bytes)}, newest ${day(k.newest)})`).join('; ')}. They are in the TOMLIN folder, "backups from other PCs"; the PC they came from can still bring them back if the tick is taken off.`
    : '';
  // Projects backed up here (a git repository for each PC): Save a copy takes the newest out, even with that PC gone.
  const projects = sh.projects ?? [];
  const psig = JSON.stringify(projects);
  if (psig !== homeUi.drawn.projects) {
    homeUi.drawn.projects = psig;
    $('#node-projects').replaceChildren(...projects.map(k => {
      const said = el('span', { class: 'hint', role: 'status' });
      const save = el('button', { class: 'link', type: 'button', text: 'Save a copy', title: 'Writes the newest backup\'s files into a new folder on this PC' });
      save.addEventListener('click', async () => {
        save.disabled = true;
        said.textContent = 'Saving…';
        try {
          said.textContent = `${(await api('/api/share/projects-out', { key: k.key })).said}.`;
        } catch (e) {
          said.textContent = e.message;
        }
        save.disabled = false;
      });
      return el('p', { class: 'hint' }, `Projects of "${k.name}" kept here: ${k.backups} backup${k.backups === 1 ? '' : 's'}, newest ${new Date(k.at).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })} (${k.files} file${k.files === 1 ? '' : 's'}), a git repository in ${k.folder}. `, save, ' ', said);
    }));
  }
}
function saveAllow(changed) {
  const now = Object.fromEntries([...document.querySelectorAll('#node-setup [data-allow]')].map(t => [t.dataset.allow, t.checked]));
  return nodeShare({ allow: { ...now, ...changed } });
}
for (const t of document.querySelectorAll('#node-setup [data-allow]')) t.addEventListener('change', () => saveAllow({}));
$('#node-allow-all').addEventListener('change', e => saveAllow({ pull: e.target.checked, backup: e.target.checked, push: e.target.checked, update: e.target.checked }));

/**
 * "Models other PCs may use": one tick per chat model on this PC. Ticks changed here stay as they are (the 3-second
 * refresh leaves them) until Save the list, which asks the app lock PIN once for the whole list.
 */
function drawNodeShare(sh) {
  // Who is using this PC's models now: busy (answering or drawing for them) or loaded for them.
  const use = sh.inUse ?? [];
  const pcs = u => (u.pcs.length ? u.pcs.map(p => `"${p}"`).join(' and ') : 'a linked PC');
  // Said only while a linked PC uses this PC (nothing when it is idle).
  $('#node-busy').hidden = !use.length;
  $('#node-busy').textContent = use.length
    ? `Busy for linked PCs now: ${use.map(u => `${u.name} ${u.busy ? (u.kind === 'image' ? 'is drawing for' : 'is answering') : 'is loaded for'} ${pcs(u)}`).join('; ')}.${use.some(u => !u.busy) ? ' A model loaded for a linked PC is dropped by itself after 60 seconds unused.' : ''}`
    : '';
  $('#node-busy').dataset.busy = use.some(u => u.busy) ? 'yes' : use.length ? 'loaded' : 'no';
  const list = sh.shareable ?? [];
  const saved = sh.models ?? [];
  const box = $('#node-share-list');
  const ticks = () => [...box.querySelectorAll('input[type=checkbox]')].filter(x => x.checked).map(x => x.value);
  const same = (a, b) => a.length === b.length && a.every(x => b.includes(x));
  const sig = JSON.stringify([list, saved]);
  if (sig !== homeUi.drawn.share && !homeUi.shareChanged) {
    homeUi.drawn.share = sig;
    const row = m => {
      const tick = el('input', { type: 'checkbox', value: m.id, checked: saved.includes(m.id) });
      tick.addEventListener('change', () => {
        homeUi.shareChanged = !same(ticks(), saved);
        line();
      });
      return el('label', { class: 'check' }, tick, ` ${m.name} · ${(m.bytes / 2 ** 30).toFixed(1)} GB`);
    };
    const chat = list.filter(m => m.kind !== 'image');
    const pics = list.filter(m => m.kind === 'image');
    box.replaceChildren(...(list.length ? [
      ...(chat.length ? [el('p', { class: 'hint', text: 'Standard models:' }), ...chat.map(row)] : []),
      ...(pics.length ? [el('p', { class: 'hint', text: 'Image creation models:' }), ...pics.map(row)] : []),
    ] : [el('p', { class: 'hint', text: 'No models on this PC yet. Get one under Models, then tick it here.' })]));
  }
  const line = () => {
    const n = ticks().length;
    // Select all: ticked when every model is, half when some are.
    const all = $('#node-share-all');
    all.hidden = !list.length;
    all.closest('label').hidden = !list.length;
    all.checked = !!list.length && n === list.length;
    all.indeterminate = n > 0 && n < list.length;
    $('#node-share-save').hidden = !homeUi.shareChanged;
    $('#node-share-line').textContent = homeUi.shareChanged ? 'Not saved yet. Save asks for the app lock PIN.'
      : !list.length ? '' : n ? `${n} of ${list.length} shared: linked PCs can hire staff on ${n > 1 ? 'them' : 'it'}.` : 'None shared: linked PCs cannot use this PC\'s models by name.';
  };
  line();
}
$('#node-share-all').addEventListener('change', e => {
  const saved = homeUi.nodes?.share?.models ?? [];
  const boxes = [...$('#node-share-list').querySelectorAll('input[type=checkbox]')];
  for (const b of boxes) b.checked = e.target.checked;
  const now = boxes.filter(b => b.checked).map(b => b.value);
  homeUi.shareChanged = !(now.length === saved.length && now.every(x => saved.includes(x)));
  drawNodeShare(homeUi.nodes.share);
});
$('#node-share-save').addEventListener('click', async () => {
  const models = [...$('#node-share-list').querySelectorAll('input[type=checkbox]')].filter(x => x.checked).map(x => x.value);
  $('#node-share-save').disabled = true;
  // Saved: the list is drawn again from the server. PIN cancelled or refused: the ticks stay as they were changed.
  if (await nodeShare({ models })) {
    homeUi.shareChanged = false;
    homeUi.drawn.share = null;
    await refreshNodes();
  }
  $('#node-share-save').disabled = false;
});

// Its own line: the refresh after a change redraws the others, and a refusal must stay readable.
function nodeFault(text) {
  const box = $('#node-fault');
  box.textContent = text ?? '';
  box.hidden = !text;
}

/** Closes of the PIN window made by askAppPin itself, whose close events have not come yet. */
let nodePinClosing = 0;

/** The app lock PIN, asked when a change to this node needs it (F7 E3). Null when Cancel is pressed. */
function askAppPin(fault) {
  const dlg = $('#node-pin');
  return new Promise(resolve => {
    let done = false;
    const end = v => {
      if (done) return;
      done = true;
      $('#node-pin-input').value = '';
      // The close event comes later (much later in a hidden tab): it must not end the next ask, the one after a wrong PIN.
      if (dlg.open) {
        nodePinClosing++;
        dlg.close();
      }
      resolve(v);
    };
    // Closed some other way (Escape, the Close button at the top): a cancel.
    dlg.onclose = () => {
      if (nodePinClosing > 0) nodePinClosing--;
      else end(null);
    };
    $('#node-pin-fault').textContent = fault ?? '';
    $('#node-pin-fault').hidden = !fault;
    $('#node-pin-input').value = '';
    $('#node-pin-form').onsubmit = e => {
      e.preventDefault();
      end($('#node-pin-input').value);
    };
    $('#node-pin-cancel').onclick = () => end(null);
    dlg.showModal();
    $('#node-pin-input').focus();
  });
}

/** Saves a change to this node (true when it was saved). */
async function nodeShare(body) {
  // While this PC is a node, a change needs the app lock PIN: asked when the server says so, again after a wrong one.
  let appPin;
  let saved = false;
  homeUi.nodeSaving = (homeUi.nodeSaving ?? 0) + 1;
  try {
    for (;;) {
      try {
        await api('/api/share', appPin === undefined ? body : { ...body, appPin });
        nodeFault('');
        saved = true;
      } catch (e) {
        if (e.data?.needAppPin) {
          appPin = await askAppPin(appPin === undefined ? '' : e.message);
          if (appPin !== null) continue;
          nodeFault('');
        } else {
          nodeFault(e.message);
          // A node must have the app lock: its window opens straight away. Once the PIN is saved (the app locks and the page
          // opens again), this page comes back and the tick is finished: the node turns on without being ticked again.
          if (e.data?.needAppLock) {
            store('node-on-after-lock', body.on === true ? '1' : '');
            openAppLockNew();
          }
        }
      }
      break;
    }
  } finally {
    homeUi.nodeSaving--;
  }
  homeUi.drawn.paired = null;
  await refreshNodes();
  return saved;
}
$('#node-autostart').addEventListener('change', e => nodeShare({ autostart: e.target.checked }));
$('#node-back-btn').addEventListener('click', () => nodeShare({ back: true }));
$('#node-on').addEventListener('change', e => nodeShare({ on: e.target.checked }));
$('#node-name').addEventListener('change', e => nodeShare({ name: e.target.value }));
$('#node-port').addEventListener('change', e => nodeShare({ port: Number(e.target.value) }));
$('#node-pin-on').addEventListener('change', e => nodeShare({ pinOn: e.target.checked }));
$('#node-code-new').addEventListener('click', async () => {
  if (await askHere($('#node-code-ask'), 'Make a new setup code? PCs already linked keep working; the old code stops working for new links.', 'Make a new code', 'Keep this code', false)) nodeShare({ newCode: true });
});

// ---- "Can other PCs reach this one?": reads this PC's network type and firewall, shows the lines that fix it ----
$('#node-fw-check').addEventListener('click', async () => {
  const line = $('#node-fw-line');
  const btn = $('#node-fw-check');
  btn.disabled = true;
  $('#node-fw-fix').hidden = true;
  line.textContent = 'Checking (up to a minute)…';
  try {
    const r = await (await fetch('/api/share/firewall', { cache: 'no-store' })).json();
    const others = r.others?.length ? ` ${r.others.join(', ')} also guards this PC, and Windows rules do not pass it: in it, mark your home network as trusted (in ESET: Setup > Network protection) or allow Node.js.` : '';
    if (r.unknown) line.textContent = `Could not read this PC's firewall. Allow TCP port ${r.port} in for other PCs on your home network.`;
    else if (r.ok) line.textContent = `✓ Windows lets other PCs in on port ${r.port} (${r.networks.map(n => `${n.alias}: ${n.category}`).join(', ') || 'no network'}).${others}`;
    else {
      line.textContent = `✗ ${r.problems.join(' ')}${others}`;
      $('#node-fw-code').textContent = r.fix;
      $('#node-fw-code').dataset.run = r.run;
      $('#node-fw-fix').hidden = false;
    }
  } catch (e) {
    line.textContent = `Could not check: ${e.message}`;
  }
  btn.disabled = false;
});
$('#node-fw-copy').addEventListener('click', async () => {
  const b = $('#node-fw-copy');
  try {
    await navigator.clipboard.writeText($('#node-fw-code').dataset.run || $('#node-fw-code').textContent);
    b.textContent = 'Copied';
  } catch {
    b.textContent = 'Select it and copy';
  }
  setTimeout(() => { b.textContent = 'Copy'; }, 2000);
});

// ---- Linking another PC: find it on the home network, type its setup code ----

/** Links a PC: true when linked; otherwise the fault is shown, and `needPin` says the PC asks for a link PIN. */
async function linkPc(url, code, pin, fault, needPin) {
  fault.textContent = 'Linking…';
  try {
    await api('/api/remotes', { action: 'add', url, code, pin });
    fault.textContent = 'Linked.';
    refreshOthers();
    refreshPcs();
    return true;
  } catch (e) {
    fault.textContent = e.message;
    if (e.data?.needPin || /link PIN, shown/.test(e.message)) needPin?.();
    return false;
  }
}

$('#node-scan').addEventListener('click', async () => {
  const line = $('#node-scan-line');
  const box = $('#node-found');
  $('#node-scan').disabled = true;
  line.textContent = 'Looking for TOMLIN on your home network (a few seconds)…';
  box.replaceChildren();
  try {
    const { found, own = [] } = await api('/api/remotes', { action: 'scan', port: Number($('#node-scan-port').value) || 8741 });
    const ranges = [...new Set(own.map(n => n.address.replace(/\.\d+$/, '.1 to .254')))];
    const looked = ranges.length ? ` Looked at every address ${ranges.join(' and ')} (this PC is ${own.map(n => `${n.address} on ${n.via}`).join(', ')}).` : ' This PC has no home-network address, so there was nothing to search: check its Wi-Fi or cable.';
    line.textContent = found.length ? `Found ${found.length} PC${found.length > 1 ? 's' : ''} with "Enable this PC as a node" on.${looked}`
      : `None found.${looked} Compare with the address on the node's Setup card. Starts differently: type it below. Starts the same: on the node, press Check under "Can other PCs reach this one?" and run what it gives you.`;
    box.replaceChildren(...found.map(f => {
      const code = el('input', { type: 'text', maxlength: '9', autocomplete: 'off', placeholder: 'ABCD-EFGH', required: '', 'aria-label': `Setup code of ${f.name}` });
      // The link PIN box shows when that PC asks for one: at the scan, or when linking says so (turned on since).
      const pin = el('input', { type: 'text', inputmode: 'numeric', maxlength: '6', autocomplete: 'off', placeholder: '6 digits', 'aria-label': `Link PIN of ${f.name}` });
      const pinBox = el('label', { class: 'field', hidden: !f.pin }, el('span', { text: 'Its link PIN (shown on that PC; never its app lock PIN)' }), pin);
      pin.required = !!f.pin;
      const fault = el('span', { class: 'hint', 'aria-live': 'polite' });
      const form = el('form', { class: 'node-link-form' },
        el('label', { class: 'field' }, el('span', { text: 'Its setup code' }), code),
        pinBox,
        el('button', { class: 'btn primary', type: 'submit', text: f.linked ? 'Link again' : 'Link' }));
      form.addEventListener('submit', async e => {
        e.preventDefault();
        const ok = await linkPc(f.url, code.value, pinBox.hidden ? '' : pin.value, fault, () => { pinBox.hidden = false; pin.required = true; pin.focus(); });
        if (ok) form.replaceWith(el('span', { class: 'hint ok', text: '✓ Linked' }));
      });
      // Linked before: the link may have broken since (the other PC removed it, or was set up again), so it can be linked
      // again. A saved link known not to work says so, with the setup code box open.
      if (f.linked && !f.broken) form.hidden = true;
      const again = f.linked && !f.broken ? el('button', { class: 'link', type: 'button', text: 'Not working? Link it again', onclick: e => { form.hidden = false; e.target.remove(); code.focus(); } }) : null;
      return el('article', { class: 'node-card' },
        el('div', { class: 'node-head' }, el('strong', { text: f.name }), el('span', { class: 'hint', text: f.url.replace('http://', '') })),
        f.broken ? el('span', { class: 'hint', text: 'Linked before, but that link no longer works. Type its setup code (shown on that PC under Nodes and memory) and press Link again.' })
          : f.linked ? el('span', { class: 'hint ok', text: '✓ Linked from this PC before' }) : null, again,
        form,
        fault);
    }));
  } catch (e) {
    line.textContent = e.message;
  }
  $('#node-scan').disabled = false;
});
$('#node-addr-form').addEventListener('submit', async e => {
  e.preventDefault();
  await linkPc($('#node-addr').value, $('#node-addr-code').value, $('#node-addr-pin').value, $('#node-scan-line'), () => $('#node-addr-pin').focus());
});

/** Other PCs (the rail, Home's set-up card, the Jobs window) open here. */
app.openPcs = async () => {
  openNodes();
  await new Promise(r => setTimeout(r, 100));
  $('#node-link').scrollIntoView({ block: 'start' });
};

function drawOthers(pcs) {
  keepFocus($('#node-others'), pcs.length ? pcs.map(p => {
    const mem = p.ok && p.memory?.ram?.bar;
    const away = p.ok && p.away ? new Date(p.away).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null;
    const state = away ? `Logged off since ${away}: "I need to log off for now"` : p.ok ? (p.backupsOnly ? 'Keeps backups' : p.model ? `On: ${p.model}` : 'Asleep: no model loaded') : p.relink || p.answered ? `Not linked any more: ${p.error} Find it again above, then Link again.` : 'Off: not answering';
    const back = away ? el('button', { class: 'btn primary', type: 'button', text: 'Start it again', 'data-key': `back:${p.id}` }) : null;
    back?.addEventListener('click', async () => {
      back.disabled = true;
      const go = confirm => api('/api/remotes', { action: 'back', id: p.id, confirm });
      try {
        await go(false);
      } catch (e) {
        // Within the hour of the press it asks first; after the hour it just starts.
        const box = $('#node-others-ask');
        if (e.data?.needConfirm && (await askHere(box, e.message, 'Start it again', 'Leave it for now', false))) await go(true).catch(err => sayHere(box, err.message));
        else if (!e.data?.needConfirm) sayHere(box, e.message);
      }
      refreshOthers();
      refreshPcs();
    });
    // Backups only: a PC kept for backups (a storage box). Ticked, no staff work there and it is first for backups.
    const role = el('label', { class: 'node-role' }, el('input', { type: 'checkbox', checked: p.backupsOnly === true, 'data-key': `backups-only:${p.id}`, onchange: async e => {
      const on = e.target.checked;
      e.target.disabled = true;
      const box = $('#node-others-ask');
      const go = confirm => api('/api/remotes', { action: 'backups-only', id: p.id, on, confirm });
      try {
        await go(false);
        sayHere(box, on ? `"${p.name}" is now Backups only: it keeps backups (first in line for them) and does no other work.` : `"${p.name}" can take staff again: hire on its models, or move someone there.`);
      } catch (err) {
        if (err.data?.needConfirm && (await askHere(box, err.message, 'Make it Backups only', 'Leave it as it is', false))) await go(true).catch(x => sayHere(box, x.message));
        else if (!err.data?.needConfirm) sayHere(box, `Backups only was not changed: ${err.message}`);
      }
      refreshOthers();
      refreshPcs();
    } }), ' Backups only', el('span', { class: 'hint', text: ' No staff, chats, jobs or pictures run here, and no model is copied to it. It is first in line for project backups.' }));
    return el('article', { class: 'node-card' },
      el('div', { class: 'node-head' },
        el('span', { class: 'sdot', 'data-state': p.ok && !away ? (p.model ? 'on' : 'asleep') : 'off', 'aria-hidden': 'true' }),
        el('strong', { text: p.name }),
        el('span', { class: 'hint', text: `${p.url} · ${state}` })),
      mem ? memBar(p.memory.ram.bar, 'Memory (RAM)') : null,
      mem && p.memory.gpu ? memBar(p.memory.gpu.bar, `Graphics memory (${p.memory.gpu.name})`) : null,
      p.ok ? el('span', { class: 'hint', text: p.disk ? `Backup disk: ${diskWords(p.disk)}.` : 'Backup disk: not reported (that PC runs an older TOMLIN: update it to see its free space here).' }) : null,
      role,
      p.ok && !mem ? el('span', { class: 'hint', text: `Its memory is not reported: that PC runs TOMLIN ${p.version || 'older than 2.0.16'}. Update it to see its memory here.` }) : null,
      // Behind this PC (a lower version, or the same one with different files): "Update it" sends this PC's TOMLIN there
      // (it starts the new version by itself), or why not.
      p.ok && p.update ? el('div', { class: 'node-update' },
        el('span', { class: 'hint', text: `${p.update.other ? `Runs ${p.version} but different files from this PC (build ${p.build} there, ${p.update.build} here)` : `Outdated: ${p.version} (this PC ${p.update.mine})`}.${p.update.why ? ` ${p.update.why.charAt(0).toUpperCase()}${p.update.why.slice(1)}.` : ''}` }),
        p.update.why ? null : el('button', { class: 'btn primary', type: 'button', text: 'Update it', 'data-key': `update:${p.id}`, onclick: async e => {
          e.target.disabled = true;
          try {
            const r = await api('/api/network/update', { pc: p.id });
            app.openUpdate(r.transfer);
          } catch (err) {
            sayHere($('#node-others-ask'), err.message);
            e.target.disabled = false;
          }
        } })) : null,
      // The models it lets this PC use by name (hire staff on them here).
      p.ok && !away && !p.backupsOnly ? el('span', { class: 'hint', text: !p.can?.includes('models') ? 'Lets this PC use: only the model it has loaded (its TOMLIN is older: update it there to share models by name).'
        : p.models?.length ? `Lets this PC use: ${p.models.map(m => {
          const bits = [m.kind === 'image' ? 'draws' : '', m.busy ? (m.kind === 'image' ? 'busy: drawing for someone now' : 'busy: answering someone now') : m.loaded ? 'loaded' : ''].filter(Boolean);
          return `${m.name}${bits.length ? ` (${bits.join(', ')})` : ''}`;
        }).join('; ')}. Hire staff on them here: Hire staff, pick that PC, then the model.`
        : 'Lets this PC use: no models yet. On that PC, Nodes and memory, tick the models other PCs may use.' }) : null,
      // How fast its loaded model answers for this PC (its answers here are timed; Test speed runs the example prompt there).
      p.ok && p.model && !away && !p.backupsOnly ? el('span', { class: 'hint' }, p.speed?.expect ? `Speed: ${app.speedWords(p.speed.expect)} (${p.speed.basis === 'answers' ? `the average of ${p.speed.average.n} answers` : 'tested'}) · ` : 'Speed: not measured yet · ', app.speedLink(`remote:${p.id}`, msg => sayHere($('#node-others-ask'), msg), refreshOthers)) : null,
      el('div', { class: 'team-actions' }, back, el('button', { class: 'link', type: 'button', text: 'Remove', onclick: async () => {
        if (!(await askHere($('#node-others-ask'), `Stop using "${p.name}"? To use it again you will need its setup code.`, `Stop using ${p.name}`, 'Keep it linked'))) return;
        await api('/api/remotes', { action: 'remove', id: p.id }).catch(() => undefined);
        refreshOthers();
        refreshPcs();
      } })));
  }) : [el('p', { class: 'hint', text: 'No other PCs linked yet.' })]);
}

async function refreshNodes() {
  if (homeUi.view !== 'nodes') return;
  try {
    drawNodes(await api('/api/nodes'));
  } catch {
    // The top bar says when the server is not answering.
  }
}
async function refreshOthers() {
  if (homeUi.view !== 'nodes') return;
  try {
    drawOthers((await api('/api/nodes/others')).pcs);
  } catch {
    drawOthers([]);
  }
}
/** "Its settings" in a PC's window: this PC's Nodes and memory, or Other PCs for a linked one. */
app.pcMore = id => (id === 'here' ? openNodes() : app.openPcs());

function openNodes() {
  setView('nodes');
  homeUi.drawn.models = homeUi.drawn.team = homeUi.drawn.paired = null;
  refreshNodes();
  refreshOthers();
}
app.openNodes = openNodes;
setInterval(refreshOthers, 30_000);

// The node tick that opened the app lock's window is finished once the PIN is saved and the app is open again: Nodes
// opens and the node turns on, without finding the page and ticking it a second time.
(async () => {
  if (store('node-on-after-lock') !== '1') return;
  const v = await api('/api/applock').catch(() => null);
  if (!v?.on || !v.open) return;
  store('node-on-after-lock', '');
  openNodes();
  await nodeShare({ on: true });
})();

/** Replaces a list's rows, keeping the keyboard on the same row (the list is redrawn every few seconds). */
// A list asked every few seconds is drawn again only when what is on screen would change: a redraw in the middle of a
// click loses the click, and a tooltip being read disappears. Compared with the live list, so anything changed in
// place since (a button disabled while it works) is drawn fresh.
function keepFocus(box, kids) {
  if (kids.length && kids.every(k => k.outerHTML) && box.innerHTML === kids.map(k => k.outerHTML).join('')) return;
  const key = document.activeElement?.closest?.('[data-key]')?.dataset.key;
  const inside = box.contains(document.activeElement);
  box.replaceChildren(...kids);
  if (inside && key) box.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus();
}

// ---- The Home view ----

function itemCard(x, key) {
  // What the queue brought back (Review photos, Review documents, Reply and answer): queue.js draws it.
  if (x.queue && app.queueCard) return app.queueCard(x, key);
  if (x.kind === 'pcask') return pcAskCard(x, key);
  const go = el('button', { class: `btn${x.kind === 'result' ? ' primary' : ''}`, type: 'button', text: x.action, 'data-key': key });
  go.addEventListener('click', () => app.openJob(x.job));
  return el('article', { class: `home-item k-${x.kind}` },
    el('div', { class: 'home-item-text' },
      el('strong', { text: x.text }),
      el('span', { class: 'hint', text: x.detail }),
      el('span', { class: 'hint home-goal', text: `Job: ${x.goal}` })),
    el('div', { class: 'home-item-actions' }, go));
}

/**
 * Someone at a linked PC sent "I need to use the pc, please log out for N hours" from its lock screen. Log out: no new
 * work goes there for those hours (it starts again by itself after); Not now: they are told so on that screen.
 */
function pcAskCard(x, key) {
  const hours = `${x.hours} hour${x.hours === 1 ? '' : 's'}`;
  const sent = new Date(x.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const answer = yes => async e => {
    for (const b of e.target.parentElement.querySelectorAll('button')) b.disabled = true;
    try {
      const r = await api('/api/remotes', { action: 'answer', id: x.pc, at: x.at, yes });
      sayHere($('#home-ask-say'), r.text);
    } catch (err) {
      sayHere($('#home-ask-say'), err.message);
    }
    await refresh();
  };
  return el('article', { class: 'home-item k-pcask' },
    el('div', { class: 'home-item-text' },
      el('strong', { text: x.text }),
      el('span', { class: 'hint', text: `Sent at ${sent} from the lock screen on "${x.name}". Log out: no new work goes there for ${hours}, and its models are unloaded once the work running there finishes; it starts again by itself after that.` })),
    el('div', { class: 'home-item-actions' },
      el('button', { class: 'btn primary', type: 'button', text: `Log out for ${hours}`, 'data-key': `${key}:yes`, onclick: answer(true) }),
      el('button', { class: 'btn quiet', type: 'button', text: 'Not now', 'data-key': `${key}:no`, onclick: answer(false) })));
}

/** One of the recent projects: its name, how far it is, and Open (or Make the plan, for one saved without a plan). */
function recentCard(x, key) {
  const go = el('button', { class: 'btn', type: 'button', text: x.action, 'data-key': key });
  go.addEventListener('click', () => (x.plan ? app.planProject(x.job, x.goal) : app.openJob(x.job)));
  return el('article', { class: 'home-item k-recent' },
    el('div', { class: 'home-item-text' },
      el('strong', { text: x.name }),
      el('span', { class: 'hint', text: x.detail }),
      x.goal && x.goal !== x.name ? el('span', { class: 'hint home-goal', text: x.goal }) : null),
    el('div', { class: 'home-item-actions' }, go));
}

function bar(fraction, label) {
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  // Set through the style property: the page's security policy ignores a style attribute.
  const fill = el('div', { class: 'home-fill' });
  fill.style.width = `${pct}%`;
  return el('div', { class: 'home-track', role: 'progressbar', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct) }, fill);
}

const secsText = n => (n < 60 ? `${n} s` : `${Math.floor(n / 60)} min ${n % 60} s`);

function workingCards() {
  const d = homeUi.data;
  const out = [];
  const w = d.working;
  if (w) {
    const open = el('button', { class: 'btn', type: 'button', text: 'Open the job', 'data-key': 'working-job' });
    open.addEventListener('click', () => (w.job ? app.openJob(w.job) : $('#jobs-open').click()));
    out.push(el('article', { class: 'home-item k-working' },
      el('div', { class: 'home-item-text' },
        el('strong', { text: w.text }),
        w.stage ? el('span', { class: 'hint', text: w.stage }) : null,
        w.total ? bar(w.done / w.total, `${w.done} of ${w.total} steps done`) : null,
        el('span', { class: 'hint', text: `${w.total ? `${w.done} of ${w.total} steps done · ` : ''}${secsText(w.seconds)} on this` }),
        el('span', { class: 'hint home-goal', text: `Job: ${w.goal}` })),
      open));
  }
  // Someone answering in a chat (here or on a linked PC), with the chat it is in.
  for (const a of d.answering ?? []) {
    const doing = a.what === 'picture' ? 'is drawing a picture' : a.what === 'handoff' ? 'is writing a handoff' : a.what === 'continue' ? 'is carrying on an answer' : 'is answering';
    const open = el('button', { class: 'btn', type: 'button', text: 'Open the chat', 'data-key': `working-chat:${a.chat}` });
    open.addEventListener('click', () => app.openChat(a.chat));
    out.push(el('article', { class: 'home-item k-working' },
      el('div', { class: 'home-item-text' },
        el('strong', { text: `${a.name} ${doing}.` }),
        el('span', { class: 'hint', text: [a.role, a.pc ? (a.pc === 'this PC' ? 'on this PC' : `on "${a.pc}"`) : '', `${secsText(a.seconds)} so far`].filter(Boolean).join(' · ') }),
        a.title ? el('span', { class: 'hint home-goal', text: `Chat: ${a.title}` }) : null),
      open));
  }
  // A picture being drawn, and a model waking up, are read from the same status the top bar uses.
  const s = app.status;
  const j = s?.panes.image.job;
  if (j && PICTURE_RUNNING.includes(j.state)) {
    const total = j.count * j.steps;
    const done = (Math.max(1, j.image) - 1) * j.steps + j.step;
    const frac = j.state === 'drawing' ? done / Math.max(1, total) : j.state === 'queued' || j.state === 'starting' ? 0 : 1;
    const see = el('button', { class: 'btn', type: 'button', text: 'See it', 'data-key': 'working-picture' });
    see.addEventListener('click', () => $('#job-chip').click());
    const artist = d.staff.find(x => x.kind === 'image' && x.active);
    out.push(el('article', { class: 'home-item k-working' },
      el('div', { class: 'home-item-text' },
        el('strong', { text: `${artist ? `${artist.name} is drawing` : 'Drawing'} a picture${j.count > 1 ? ` (${j.count} drafts)` : ''}.` }),
        el('span', { class: 'hint', text: j.prompt ?? '' }),
        bar(frac, 'Picture progress'),
        el('span', { class: 'hint', text: `${j.state === 'drawing' ? `Step ${j.step} of ${j.steps}` : j.state === 'queued' ? 'Waiting for the picture before it' : j.state === 'starting' ? 'Starting' : 'Finishing'} · ${secsText(Math.round(j.elapsed ?? 0))} so far` })),
      see));
  }
  // A picture the queue has a linked PC drawing (one drawn here shows above, from the picture pane).
  out.push(...(app.queueWorking?.(d.queue) ?? []));
  for (const [pane, label] of [['chat', 'chat'], ['image', 'picture']]) {
    const v = s?.panes[pane];
    if (v?.state !== 'loading') continue;
    const spent = v.loadStartedAt ? Math.round((Date.now() - v.loadStartedAt) / 1000) : 0;
    out.push(el('article', { class: 'home-item k-working' },
      el('div', { class: 'home-item-text' },
        el('strong', { text: `Waking up the ${label} model: ${(v.modelName ?? '').replace(/\s*[(+].*$/, '')}.` }),
        bar(Math.min(0.95, spent / Math.max(1, v.expectedSeconds)), 'Loading'),
        el('span', { class: 'hint', text: `${secsText(spent)} so far, about ${Math.max(0, Math.round(v.expectedSeconds - spent))} s more (estimated)` }))));
  }
  return out;
}

/** Big set-up cards while the basics are missing; afterwards they live as the rail's Set up links. */
function setupCards() {
  const u = homeUi.data.setup;
  const box = $('#home-setup');
  const sig = JSON.stringify(u);
  if (sig === homeUi.drawn.setup) return;
  homeUi.drawn.setup = sig;
  if (u.chatModels && u.staff) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const steps = [u.chatModels > 0, u.staff > 0, u.pcs > 0, !!u.node];
  const card = (done, title, text, button, onClick) => el('article', { class: `setup-card${done ? ' done' : ''}` },
    el('strong', { text: `${done ? '✓ ' : ''}${title}` }), el('p', { class: 'hint', text }),
    el('button', { class: `btn${done ? '' : ' primary'}`, type: 'button', text: button, onclick: onClick }));
  box.replaceChildren(
    el('h3', { text: `Setup progress ${steps.filter(Boolean).length}/${steps.length} start setup now:` }),
    el('div', { class: 'setup-grid' },
      card(u.chatModels > 0, 'Add a chat model', u.chatModels ? `${u.chatModels} chat model${u.chatModels > 1 ? 's' : ''} found.` : 'TOMLIN needs at least one chat model on this PC. Models shows which ones fit.', 'Models', () => app.openModels()),
      card(u.staff > 0, 'Hire your first staff member', u.staff ? `${u.staff} on the team.` : 'Give a person a name, a role (coder, writer, artist…) and a level. They appear in the list on the left.', 'Team', () => (u.staff ? $('#team-open').click() : app.openHire())),
      card(u.pcs > 0, 'Link another PC (optional)', [u.pcs ? `${u.pcs} PC${u.pcs > 1 ? 's' : ''} linked.` : '', u.pcsBroken?.length ? `${u.pcsBroken.map(n => `"${n}"`).join(', ')} need${u.pcsBroken.length > 1 ? '' : 's'} linking again: its old link no longer works.` : '', !u.pcs && !u.pcsBroken?.length ? 'Use a stronger PC on your home network for some of the work.' : ''].filter(Boolean).join(' '), 'Other PCs', () => app.openPcs()),
      card(u.node, 'Use this PC as a node (optional)', u.node ? 'Shared with your other PCs.' : 'Let another PC send work to this one: the steps, the memory it has, and which models stay loaded.', 'Nodes and memory', () => openNodes())));
}

// The Home title greets by the time of day, with the date under it.
function greet() {
  const now = new Date();
  const h = now.getHours();
  $('#home-title').textContent = h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  $('#home-date').textContent = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function drawHome() {
  const d = homeUi.data;
  if (!d) return;
  setupCards();
  greet();
  // The staff row follows the hires (hired here, in Staff, or fired): drawn with every refresh, not only by the status.
  drawHomeAsk();
  const sig = JSON.stringify([d.waiting, d.paused, d.recent]);
  if (sig !== homeUi.drawn.items) {
    homeUi.drawn.items = sig;
    keepFocus($('#home-waiting'), d.waiting.length ? d.waiting.map((x, i) => itemCard(x, `w:${x.job}:${i}`)) : [el('p', { class: 'home-empty', text: 'Nothing waiting' })]);
    $('#home-paused-box').hidden = !d.paused.length;
    keepFocus($('#home-paused'), d.paused.map((x, i) => itemCard(x, `p:${x.job}:${i}`)));
    const recent = d.recent ?? [];
    $('#home-ready-box').hidden = !recent.length;
    keepFocus($('#home-ready'), recent.map((x, i) => recentCard(x, `r:${x.job}:${i}`)));
  }
  const working = workingCards();
  keepFocus($('#home-working'), working.length ? working : [el('p', { class: 'home-empty', text: 'Nobody working' })]);
  app.drawQueue?.();
  // Folded, the panel still says that someone is working.
  $('#home-working-count').hidden = !working.length;
  $('#home-working-count').textContent = `${working.length} working`;
}

// ---- Keeping it fresh ----

let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    // "front": whether this page is shown and focused; the server raises a Windows notification only when it is not.
    homeUi.data = await api(`/api/home?front=${app.inFront?.() ? 1 : 0}`);
    if (app.models) keepPlain(app.models.settings.who);
    // The message box says who answers (the chat's own name and person are drawn by chats.js).
    // A hire who lives on another PC is not in this PC's staff list: the open chat's own person names them.
    const openChat = chatUi.list.find(c => c.id === chatUi.current);
    // The person in the chat on screen; with no chat open yet, the one chosen (another window may have chosen since).
    const onScreen = String(chatUi.open?.who ?? '');
    const talking = (onScreen ? homeUi.data.staff.find(s => s.kind === 'chat' && `staff:${s.id}` === onScreen) : homeUi.data.staff.find(s => s.kind === 'chat' && s.active))
      ?? (String(openChat?.who ?? '').startsWith('node:') ? { name: openChat.name } : null);
    // The host is off for now (no row) and nobody who chats is hired: the box and the empty chat say to hire someone.
    app.nobodyToTalkTo = !homeUi.data.manager && !homeUi.data.staff.some(s => s.kind === 'chat');
    if (app.nobodyToTalkTo && !chatUi.open) {
      const empty = $('#chat-log .empty');
      if (empty) empty.textContent = app.nobodyYet;
    } else if (!app.nobodyToTalkTo) {
      // Someone was hired since the empty chat was drawn: it no longer says to hire someone first.
      const empty = $('#chat-log .empty');
      if (empty?.textContent === app.nobodyYet) empty.textContent = app.emptyChat;
    }
    // A chat with someone no longer on the team (or a retired node hire) is read, not carried on.
    $('#chat-input').placeholder = chatUi.open && chatUi.open.here === false ? READ_ONLY_BOX
      : app.nobodyToTalkTo ? 'Hire someone first: Settings, Set up, Staff, Hire staff'
      : `Message ${app.inSentence?.(talking ? talking.name : chatUi.people.find(p => p.who === 'manager')?.name ?? 'The host') ?? 'the host'}…`;
    drawRail();
    drawHome();
    app.afterHome?.();
    // A chat opened while its answer was still coming (chats.js): drawn again once it is finished.
    const waited = app.awaitAnswer;
    if (waited && !(homeUi.data.answering ?? []).some(a => a.chat === waited)) {
      app.awaitAnswer = '';
      if (app.chatId === waited) showChat(await app.chatAgain());
    }
    refreshNodes();
  } catch {
    // The top bar already says when TOMLIN is not answering.
  } finally {
    refreshing = false;
  }
}
async function refreshPcs() {
  try {
    homeUi.pcs = (await api('/api/home/pcs')).pcs;
    drawRail();
  } catch {
    homeUi.pcs = [];
  }
}
greet();
refresh();
refreshPcs();
setInterval(refresh, 3000);
// The queue (queue.js) asks for Home to be drawn again at once after a change.
app.refreshHome = refresh;
// Paired PCs are asked again now and then, so a PC that went off (and its staff) shows as off.
setInterval(() => { if (homeUi.pcs.length && !document.hidden) refreshPcs(); }, 20_000);
setInterval(refreshPcs, 30_000);
// The picture and loading lines follow the once-a-second status without asking the server again.
app.onStatus.push(() => {
  if (homeUi.data && homeUi.view === 'home') drawHome();
});

// ---- Set-up links and the job box ----

for (const b of document.querySelectorAll('[data-setup]')) {
  b.addEventListener('click', () => {
    if (b.dataset.setup === 'staff') $('#team-open').click();
    else if (b.dataset.setup === 'models') app.openModels();
    else if (b.dataset.setup === 'nodes') openNodes();
    else if (b.dataset.setup === 'jobs') $('#jobs-open').click();
    else if (b.dataset.setup === 'files') $('#files-open').click();
    else app.openPcs();
  });
}
// Hiring, letting go, pairing a PC or sharing this one changes the lists: redraw when those windows close.
for (const id of ['#team', '#jobs']) $(id)?.addEventListener('close', () => {
  refresh();
  refreshPcs();
  refreshOthers();
});

// ---- "Lets create a project": a name, a mini description, the prompt, and who leads it ----
// The project's folder is the date and time it was made ("2026-10-07-1116"), made by the server.

const homeAsk = { pm: '', drawn: '' };

/** The name a project gets when none is typed: "Project " and the date and time now, as its folder is named. */
function folderNow() {
  const n = new Date();
  const p = x => String(x).padStart(2, '0');
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}-${p(n.getHours())}${p(n.getMinutes())}`;
}

/** The name it gets when none is typed, and the staff to pick from: Name - software - PC (or Hire staff). */
function drawHomeAsk() {
  $('#home-name').placeholder = `Project ${folderNow()}`;
  // A hire on a PC set to Backups only takes no work, so it is not offered.
  const staff = (homeUi.data?.staff ?? []).filter(s => s.kind === 'chat' && !s.backupsOnly)
    .map(s => ({ id: s.id, name: s.name, model: s.modelName || 'no model yet', pc: s.pc || 'This PC' }));
  if (homeAsk.pm && !staff.some(s => s.id === homeAsk.pm)) homeAsk.pm = '';
  const sig = JSON.stringify([staff, homeAsk.pm, team.data?.roles?.length ?? 0]);
  if (sig === homeAsk.drawn) return;
  homeAsk.drawn = sig;
  const pick = $('#home-staff');
  pick.hidden = !staff.length;
  $('.home-staff-label').hidden = !staff.length;
  // Nobody hired yet: the staff icons (one per chat role), each opening a window to hire one.
  const hire = $('#home-hire');
  hire.hidden = !!staff.length;
  if (!staff.length) hire.replaceChildren(...(team.data?.roles ?? []).map(r => el('button', { class: 'staff-chip', type: 'button', title: `Hire a ${r.name.toLowerCase()}: pick their PC and software`, onclick: () => quickHire(r.id) },
    el('span', { class: 'rail-avatar', 'aria-hidden': 'true' }, roleIcon(r.id)), el('span', { text: r.name }))));
  if (staff.length) {
    pick.replaceChildren(el('option', { value: '', text: 'Default - strongest available PC', title: 'The strongest worker that is free when it starts' }),
      ...staff.map(s => el('option', { value: s.id, text: `${s.name} - ${s.model} - ${s.pc}` })));
    pick.value = homeAsk.pm;
  }
  // Said only when nobody is hired yet: the drop-down says the rest.
  $('#home-staff-line').textContent = staff.length ? '' : 'Hire staff (staff connects a LLM model to a PC or node).';
  $('#home-staff-line').hidden = !!staff.length;
}
drawHomeAsk();
$('#home-staff').addEventListener('change', e => {
  homeAsk.pm = e.target.value;
  drawHomeAsk();
});

// ---- Hire staff from Home: an icon per role opens Hire staff (hire.js) with that role picked ----

const quickHire = role => app.openHire({ role });
app.onStatus.push(() => {
  if (homeUi.view === 'home') drawHomeAsk();
});

$('#home-ask').addEventListener('submit', async e => {
  e.preventDefault();
  const say = $('#home-ask-say');
  const prompt = $('#home-goal').value.trim();
  const about = $('#home-about').value.trim();
  if (!prompt && !about) {
    sayHere(say, 'Type the prompt first: what should exist when it is finished?');
    $('#home-goal').focus();
    return;
  }
  if ($('#home-staff').hidden) {
    sayHere(say, 'Set up staff first: press Setup staff, hire at least one person, then press Lets go! again.');
    return;
  }
  const go = $('#home-go');
  go.disabled = true;
  try {
    const r = await api('/api/projects/create', { name: $('#home-name').value, about, prompt, pm: homeAsk.pm });
    for (const id of ['#home-name', '#home-about', '#home-goal']) $(id).value = '';
    drawHomeAsk();
    say.hidden = true;
    await app.planProject(r.id, prompt || about);
  } catch (err) {
    sayHere(say, err.message);
  } finally {
    go.disabled = false;
  }
});

