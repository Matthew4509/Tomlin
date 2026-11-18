// Home: the left rail (Home, the chats, the staff with their state, other PCs, set-up links) and the Home view (what is
// waiting for you, what is working now, paused jobs, "Lets create a project" and the recent projects). Every line comes from /api/home, written by code
// from the job files and the model states, never by a model. On a phone the rail is the first screen, like Teams.
// Uses app.js's helpers ($, el, api, store, app, panes, loadModels, drawChat) and team.js's useModelOf.
'use strict';

const homeUi = { data: null, pcs: [], view: 'home', drawn: {}, pcMem: {}, dragging: null };
// "32 GB / 4 GB VRAM", "16 GB / 0 VRAM": the memory, then the graphics card's own (none when the graphics use the RAM).
/** A backup disk in words: "931 GB, 412 GB free" (TB from 1 TB up). */
const diskSize = n => (n >= 2 ** 40 ? `${(n / 2 ** 40).toFixed(1)} TB` : gb(n));
const diskWords = k => `${diskSize(k.total)} disk, ${diskSize(k.free)} free`;
/** "357 / 476 GB" (used / total; "614 GB / 1.8 TB" when the units differ): a linked PC's disk on its card. */
const diskUsed = k => {
  const used = diskSize(Math.max(0, k.total - k.free));
  const total = diskSize(k.total);
  return used.split(' ')[1] === total.split(' ')[1] ? `${used.split(' ')[0]} / ${total}` : `${used} / ${total}`;
};
const memWords = (ram, vram) => `${Math.round(ram / 2 ** 30)} GB / ${vram ? `${Math.round(vram / 2 ** 30)} GB VRAM` : '0 VRAM'}`;
/** A PC's name as you gave it (the PC window), else its make and model, else `fallback`; and its make and model. */
const pcName = (key, fallback) => app.pcProfileOf?.(key)?.name || app.pcProfileOf?.(key)?.model || fallback;
const pcMake = key => (app.pcProfileOf?.(key)?.name ? app.pcProfileOf(key).model : '');
/**
 * For each linked PC whose shown name another linked PC also has (two machines both called "Worker PC"): the words that
 * tell it apart, the computer's own name when the two differ there, else its address (with the port only when two
 * share an address too). A PC with a name of its own is not in the list.
 */
function pcTwinWords(pcs = homeUi.pcs ?? []) {
  const key = n => String(n ?? '').trim().toLowerCase();
  const shown = pcs.map(p => key(pcName(p.id, p.name)));
  const urlOf = url => { try { return new URL(url); } catch { return null; } };
  const ips = pcs.map(p => urlOf(p.url)?.hostname ?? p.url);
  const out = {};
  for (const [i, p] of pcs.entries()) {
    const twins = pcs.filter((x, j) => j !== i && shown[j] === shown[i]);
    if (!twins.length) continue;
    const own = String(p.computer ?? '').trim();
    out[p.id] = own && key(own) !== shown[i] && twins.every(x => key(x.computer) !== key(own)) ? own
      : ips.filter(x => x === ips[i]).length > 1 ? urlOf(p.url)?.host ?? p.url : ips[i];
  }
  return out;
}
/** A PC's name as every list shows it: 'here' or '' for this PC; a linked PC with a twin name gets its telling words. */
app.pcLabel = id => {
  if (!id || id === 'here') return pcName('here', 'My PC');
  const p = (homeUi.pcs ?? []).find(x => x.id === id);
  if (!p) return pcName(id, 'A linked PC');
  const at = pcTwinWords()[id];
  return at ? `${pcName(id, p.name)} (${at})` : pcName(id, p.name);
};
const shell = $('#shell');
const phone = window.matchMedia('(max-width: 760px)');
const PICTURE_RUNNING = ['queued', 'starting', 'drawing', 'decoding', 'finishing'];

// ---- Which view: Home, the chat and image panes, or (phone only) the list ----

/**
 * Each page shown, and each press that opens one, counts one turn. An opener that waits for the server first takes a
 * ticket (app.pageTicket) and, once the answer is in, shows its page only if `late()` is false: a slow answer never
 * replaces a page the person has moved on to since (Hire staff, then Models, then Network stays on Network).
 */
let pageTurn = 0;
function pageTicket() {
  const turn = ++pageTurn;
  return () => turn !== pageTurn;
}
app.pageTicket = pageTicket;

function setView(view) {
  pageTurn++;
  // Leaving a Settings page shown from a window (Staff, Jobs, Files): its window closes with it.
  if (asPage.dlg?.open && asPage.view !== view) asPage.dlg.close();
  // A press on the Settings menu counts for the page it opens, not for the next one.
  asPage.fromMenu = false;
  const was = homeUi.view;
  homeUi.view = view;
  shell.dataset.view = view;
  if (view !== 'rail' && !PAGE_VIEWS.includes(view)) store('view', view);
  if (view === 'home') $('#home').scrollTop = 0;
  // The Settings menu stays in the left panel on every page it opens, with this page marked (style.css).
  for (const b of document.querySelectorAll('[data-setup]')) {
    if (b.dataset.setup === view) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  drawRail();
  // The top bar shows a linked PC only while a chat with someone on it is on screen (chats.js).
  app.onView?.(view);
  if (pageFocus && was !== view) {
    bringUp(view);
    focusPage(view);
  }
}
app.showPanes = () => setView('chat');

/** The page each view shows (the chat: its message box); Staff, Jobs and Files are windows shown as pages (asPage). */
const PAGE_OF = { home: '#home', nodes: '#nodes', thispc: '#thispc', models: '#models-page', settings: '#settings', updates: '#updates-page', cluster: '#cluster-page', data: '#settings-data', perms: '#settings-perms', colours: '#settings-colours', help: '#help' };
/** Off for the first view at start: the page opens where it was, focus left alone. */
let pageFocus = false;
/**
 * A page change moves focus to the new page's heading (or the chat's message box), so a keyboard or screen reader is
 * not left on a button that is no longer on screen. Not while a window is open over it.
 */
function focusPage(view) {
  // A timeout, not a frame: a window in the background draws no frames, and the page has to be shown first.
  setTimeout(() => {
    if ([...document.querySelectorAll('dialog[open]')].some(d => !d.classList.contains('as-page'))) return;
    // The list on a phone ("‹ Chats and staff") has no page of its own: its New chat button takes the focus.
    const page = PAGE_VIEWS.includes(view) ? asPage.dlg : view === 'chat' || !PAGE_OF[view] ? null : $(PAGE_OF[view]);
    const target = view === 'chat' ? $('#chat-input') : view === 'rail' ? $('#rail-new') : page && (page.getAttribute('aria-labelledby') ? document.getElementById(page.getAttribute('aria-labelledby')) : page.querySelector('h1, h2'));
    if (!target || target.offsetParent === null) return;
    if (!target.matches('input, textarea, select, button, a[href]') && !target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  }, 0);
}

/**
 * A narrow window stacks the Settings menu above the page, so a page opened from a tile or the menu opened below it, out
 * of sight, or half way down where the last page was scrolled to (Data and lock looked as if nothing happened). Its top
 * is brought into sight; on a wide window it is already there and nothing moves. Staff, Jobs and Files do it in showAsPage.
 */
function bringUp(view) {
  if (PAGE_VIEWS.includes(view) || !PAGE_OF[view]) return;
  const page = $(PAGE_OF[view]);
  if (!page || page.offsetParent === null) return;
  const top = page.getBoundingClientRect().top;
  if (top < 0 || top > innerHeight / 3) page.scrollIntoView({ block: 'start' });
}

/** A page's name as the left panel says it ("Settings", "Models"), for a Close that says where it goes back to. */
const viewName = view => (view === 'home' ? 'Home' : view === 'chat' ? 'the chat' : document.querySelector(`[data-setup="${view}"]`)?.textContent.split(':')[0].trim() || 'Settings');
/** A page's name in a breadcrumb: "Chat", not "the chat"; the Staff pages (the menu, All staff, Edit staff) as "Staff". */
const crumbName = view => (view === 'chat' ? 'Chat' : view === 'staff' ? 'Staff' : viewName(view));

// ---- Settings' pages: Staff, Jobs and Files open as pages beside the Settings menu, not as windows over it ----

/** The pages the Settings menu stays beside, and the ones a window is shown in. */
const SETUP_VIEWS = ['settings', 'models', 'nodes', 'thispc', 'staff', 'jobs', 'files', 'updates', 'data', 'perms', 'colours'];
const PAGE_VIEWS = ['staff', 'jobs', 'files'];
/** The window shown as a page now, its view, and the page Close goes back to. */
const asPage = { dlg: null, view: '', back: 'settings', fromMenu: false };

/**
 * Shows a window (Staff, Jobs, Files) as the page `view`, in the main part of the screen with the Settings menu on the
 * left. Its Close goes back to the page it was opened from; windows opened from inside it still open over it.
 */
function showAsPage(dlg, view) {
  if (asPage.dlg && asPage.dlg !== dlg && asPage.dlg.open) {
    const was = asPage.dlg;
    asPage.dlg = null;
    was.close();
  }
  // Opened from the Settings menu (its list on the left, or its tiles): Close goes back to Settings. Else back to the
  // page it was opened from (a window page opened from another keeps that one's way back).
  if (asPage.fromMenu) asPage.back = 'settings';
  else if (!PAGE_VIEWS.includes(homeUi.view)) asPage.back = homeUi.view && homeUi.view !== 'rail' ? homeUi.view : 'settings';
  const host = $('#setup-page');
  if (dlg.parentNode !== host) host.append(dlg);
  dlg.classList.add('as-page');
  if (!dlg.dataset.asPage) {
    dlg.dataset.asPage = '1';
    // Closed (its Close button, or the code moving on to something else): back to where it was opened from, unless
    // something else is already on screen.
    dlg.addEventListener('close', () => {
      // Its Close says plain "Close" again (it may open as a window next time).
      for (const b of dlg.querySelectorAll('[data-close-to]')) b.textContent = b.dataset.closeTo;
      if (asPage.dlg !== dlg) return;
      asPage.dlg = null;
      if (homeUi.view === asPage.view) setView(asPage.back);
    });
  }
  // Shown as a page, its Close names the page it goes back to: "Close (back to Settings)".
  for (const b of dlg.querySelectorAll('form[method="dialog"] button, [data-close-to]')) {
    const plain = b.dataset.closeTo ?? b.textContent.trim();
    if (plain !== 'Close') continue;
    b.dataset.closeTo = plain;
    b.textContent = `Close (back to ${viewName(asPage.back)})`;
  }
  // Shown as a page, it has the head every Settings page has: a breadcrumb ("Settings › Jobs") over its title. The first
  // name is the way back, so the window's own Close and title band are not shown (style.css, "Page heads").
  const body = dlg.querySelector('.help-body');
  let crumbs = body.querySelector(':scope > .page-crumbs');
  if (!crumbs) body.prepend((crumbs = el('nav', { class: 'crumbs page-crumbs', 'aria-label': 'Breadcrumb' })));
  crumbs.replaceChildren(el('ol', {},
    el('li', {}, el('button', { class: 'link', type: 'button', text: crumbName(asPage.back), onclick: () => dlg.close() })),
    el('li', { 'aria-current': 'page', text: crumbName(view) })));
  // A modal window still open over the page it leaves (the bell's) would cover it.
  for (const d of document.querySelectorAll('dialog[open]')) if (d !== dlg && !host.contains(d)) d.close();
  asPage.dlg = dlg;
  asPage.view = view;
  if (!dlg.open) dlg.show();
  setView(view);
  host.scrollTop = 0;
  // A narrow window stacks the menu above the page: the page opened below it, out of sight (Staff, Create looked as if
  // nothing happened). Brought up to the top of the window when its top is not in sight.
  const top = dlg.getBoundingClientRect().top;
  if (top < 0 || top > innerHeight / 3) dlg.scrollIntoView({ block: 'start' });
}
app.showAsPage = showAsPage;
for (const b of document.querySelectorAll('[data-back]')) b.addEventListener('click', () => setView('rail'));
$('#rail-home').addEventListener('click', () => setView('home'));
$('#rail-home-row').addEventListener('click', () => setView('home'));
// Under Projects: the Staff menu (Hire staff, Manage staff) as the Staff page, the Settings menu beside it.
$('#rail-staff-row').addEventListener('click', () => app.openStaffMenu());
phone.addEventListener('change', e => {
  if (!e.matches && homeUi.view === 'rail') setView(store('view') === 'chat' ? 'chat' : 'home');
});
// The page starts where it was left. A brand-new install has no chat to come back to: Home, with its setup steps, opens first.
setView(phone.matches ? 'rail' : store('view') === 'chat' ? 'chat' : 'home');
pageFocus = true;
// The staff list under "Staff" starts open; folding it is kept in this browser.
$('#rail-staff-fold').open = store('staff-open') !== '0';
$('#rail-staff-fold').addEventListener('toggle', e => store('staff-open', e.target.open ? '1' : '0'));
// Home's "Waiting for you" panel folds to a strip (it keeps the number); folding it is kept in this browser.
$('#home-side-fold').open = store('home-waiting-open') !== '0';
$('#home-side').classList.toggle('folded', !$('#home-side-fold').open);
$('#home-side-fold').addEventListener('toggle', e => {
  $('#home-side').classList.toggle('folded', !e.target.open);
  store('home-waiting-open', e.target.open ? '1' : '0');
});
// Its three tabs, Waiting for you | Staff overview | To Do (the one picked is kept in this browser). A tab never folds
// the panel: pressed while it is folded to its strip, it opens it on that tab.
const homeTabs = [$('#tab-waiting'), $('#tab-home-staff'), $('#tab-home-todo')];
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
/** Opens Home's right panel on a tab by its id (a drag over the To Do tab opens it: todo.js). */
app.homeTab = id => {
  const t = homeTabs.find(x => x.id === id);
  if (!t) return;
  $('#home-side-fold').open = true;
  homeTab(t);
};
for (const t of homeTabs) {
  t.addEventListener('click', e => {
    e.preventDefault();
    $('#home-side-fold').open = true;
    homeTab(t);
  });
  t.addEventListener('keydown', e => {
    const i = homeTabs.indexOf(t);
    const n = homeTabs.length;
    const to = e.key === 'ArrowRight' ? homeTabs[(i + 1) % n] : e.key === 'ArrowLeft' ? homeTabs[(i + n - 1) % n] : e.key === 'Home' ? homeTabs[0] : e.key === 'End' ? homeTabs[n - 1] : null;
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
      const r = await app.talkTo(plainWho());
      await loadModels();
      // The host's own model (its pencil), as a hire's chat picks theirs.
      await useModelOf({ model: app.models?.settings?.hostModel, kind: 'chat' });
      showChat(r);
    } else if (row.who) {
      // Someone who lives on a paired PC: their latest chat opens (they answer there).
      const r = await app.talkTo(row.who);
      await loadModels();
      showChat(r);
    } else {
      const r = await app.talkTo(`staff:${row.id}`);
      await loadModels();
      showChat(r);
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
const ACTIVITY_WORD = { available: 'Available', asleep: 'Asleep', busy: 'Busy', owner: 'In use by its owner', offline: 'Offline' };
const activityDot = a => el('span', { class: 'sdot', 'data-activity': a, 'aria-hidden': 'true' });
/** A hire free for work but with their model not loaded (dropped, or not woken yet): asleep, a yellow ring with a dot, not green. */
const staffActivity = s => (s.activity === 'available' && s.state === 'asleep' ? 'asleep' : s.activity);

/**
 * A person in the left panel. With `level` (a hire): "Name | Level", the software under it, and a third line only when
 * they are working or muted (how they are otherwise is the dot's shape on their icon, and the tooltip).
 */
function staffRow({ key, name, avatar, sub, level, state, stateText, activity, activityWord, busy, count, active, title, onClick, onEdit, editTitle, mutable = true, flag }) {
  // Muted (right-click the row, or Mute all): a bell with a line and "Muted until …", a grey dot in place of the number.
  const muted = mutable ? app.mutedBy?.([key]) : null;
  const bits = app.muteBits?.(muted, count) ?? { icon: null, count: count ? el('span', { class: 'rail-count', text: String(count) }) : null };
  const word = activity ? activityWord ?? ACTIVITY_WORD[activity] : busy ? 'Working' : STATE_WORD[state] ?? stateText;
  const mark = activity ? activityDot(activity) : dot(state);
  const b = el('button', { class: 'rail-row', type: 'button', 'data-key': key, title: `${title}\n${name}: ${sub}\n${busy ?? stateText}${muted ? `\nMuted ${muted.text}` : mutable ? '\nTo mute: right-click, or the … in the chat' : ''}`, 'aria-current': active ? 'true' : null },
    app.avatar ? app.avatar(key, avatar, mark) : el('span', { class: 'rail-avatar', 'aria-hidden': 'true' }, avatar, mark),
    el('span', { class: 'rail-text' },
      // flag: a yellow (!) at the right of the name line, with its words (a linked PC behind this one).
      flag ? el('span', { class: 'rail-name has-flag' }, el('span', { class: 'rail-name-text', text: name }), el('span', { class: 'rail-flag', role: 'img', 'aria-label': flag, title: flag, text: '!' }))
        : el('span', { class: 'rail-name' }, name, level ? el('span', { class: 'rail-level', text: ` | ${level}` }) : null),
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
      key: `staff:${s.id}`, name: s.name, avatar: initials(s.name), level: s.level || 'Default', sub: s.modelName || 'no model given', state: s.state, stateText: s.text, activity: staffActivity(s),
      busy: s.busy ? `Working: ${s.busy}` : null, count: counts[s.id], active: inChat && (s.kind === 'image' ? s.active && showing === 'image' : marked(`staff:${s.id}`, s.active)),
      title: `${s.role}${s.pc ? ` on ${s.pc}` : ''}${tokSub(s.speed)}. Press: a new chat, or one of their recent chats`,
      onClick: () => (app.openPerson ? app.openPerson(s.who ?? `staff:${s.id}`, s.name) : talkTo(s)), onEdit: () => app.editStaff?.(s.id),
    });
    deskDrag(li, s);
    rows.push(li);
  }
  if (!rows.length) rows.push(el('li', { class: 'rail-empty' }, el('span', { class: 'hint', text: 'Nobody hired yet.' }), el('button', { class: 'btn primary rail-hire', type: 'button', text: 'Hire staff', onclick: () => app.openHire() })));
  $('#rail-staff-title').textContent = d.staff.length ? `Staff (${d.staff.length})` : 'Staff';
  keepFocus($('#rail-staff'), rows);
  app.drawChats?.();
  // The hardware: this PC, then each linked PC, each a desk with the staff who work on it sitting on top (their icon,
  // with the same dot). A hire is dragged onto another PC to move them there. Under each PC's name: what it can hold
  // (RAM, and the graphics card's own memory), then what it has loaded; a PC that is off shows the numbers it gave last.
  const hw = app.status?.hardware;
  // A yellow (!) when a PC's RAM is nearly full now (95% in use or more, src/calc.ts RAM_FULL): a model may not load there.
  const fullWords = (used, total, where) => (used && total && used / total >= 0.95
    ? `Memory nearly full: ${(used / 2 ** 30).toFixed(1)} of ${(total / 2 ** 30).toFixed(1)} GB of RAM in use (${Math.round((used / total) * 100)}%). A model may not load ${where} now: unload one, or close other programs there.`
    : '');
  const mineFull = hw ? fullWords(hw.ram.used, hw.ram.total, 'on this PC') : '';
  const desks = [{ id: '', row: staffRow({
    key: 'pc:mine', name: pcName('here', 'My PC'), avatar: 'PC', sub: [hw ? memWords(hw.ram.total, hw.gpu && !hw.gpu.shared ? hw.gpu.total : 0) : 'This PC', pcMake('here')].filter(Boolean).join(' · '), state: 'on', stateText: 'This PC', activity: 'available',
    title: `${mineFull ? `${mineFull}
` : ''}My PC: its uptime, total tokens and what its work cost`, onClick: () => app.openPc?.('here'), mutable: false, flag: mineFull || undefined,
  }) }];
  // Two linked PCs with one name (two machines both called "Worker PC") read as one PC that is both off and on:
  // those cards start their second line with the computer's own name, else their address (pcTwinWords).
  const twinWords = pcTwinWords();
  for (const p of homeUi.pcs) {
    if (p.ram) homeUi.pcMem[p.id] = { ram: p.ram, vram: p.vram };
    const name = pcName(p.id, p.name);
    const at = twinWords[p.id] ?? '';
    // Answering with nothing loaded: still free for work (the green dot), but the word says it is asleep.
    const asleep = p.activity === 'available' && p.state === 'asleep' && !p.backupsOnly;
    // Behind this PC: the yellow (!) on its card; its window (press the card) has Update it. Ahead of it, and it lets
    // this PC take its TOMLIN: the same mark, and its window has Update this PC from it.
    const old = p.outdated ? (p.outdated.other ? `Runs ${p.outdated.version} but different files from this PC: press to update "${p.name}"` : `This PC runs ${p.outdated.mine}; "${p.name}" runs ${p.outdated.version}: press to update "${p.name}"`)
      : p.newer ? (p.newer.other ? `Runs ${p.newer.version} with different files from this PC: press to update this PC to it` : `This PC runs ${p.newer.mine}; "${p.name}" runs ${p.newer.version}: press to update this PC to ${p.newer.version}`) : '';
    const full = p.activity !== 'offline' ? fullWords(p.ramUsed, p.ram, `on "${p.name}"`) : '';
    const flag = [old, full].filter(Boolean).join('\n');
    const mem = homeUi.pcMem[p.id];
    // A "Backups only" PC: no staff work there, so its card says what it keeps instead of what it has loaded.
    const sub = p.backupsOnly ? [at, mem ? memWords(mem.ram, mem.vram) : '', pcMake(p.id), 'Backups only', p.disk ? diskWords(p.disk) : '']
      : [at, mem ? memWords(mem.ram, mem.vram) : '', pcMake(p.id), p.model, p.speed?.expect ? app.speedWords(p.speed.expect, true) : '', p.picture ? `draws with ${p.picture}` : ''];
    // In the cluster while it is on: held for big models, greyed out, no staff go there (the Cluster card has the switch).
    const held = p.heldByCluster === true;
    desks.push({ id: p.id, name: at ? `${name} (${at})` : name, activity: p.activity, backupsOnly: p.backupsOnly, held, row: staffRow({
      key: `pc:${p.id}`, name, avatar: 'PC', sub: sub.filter(Boolean).join(' · ') || p.url, state: p.state, stateText: held && p.activity !== 'offline' ? 'In the cluster: held for big models, no staff' : p.backupsOnly && p.activity !== 'offline' ? 'Backups only: keeps backups, no staff' : p.text, activity: p.activity, activityWord: held && p.activity !== 'offline' ? 'In the cluster' : p.word ?? (asleep ? 'Asleep' : undefined),
      title: `${flag ? `${flag}
` : ''}${p.name} at ${p.url}: its uptime, total tokens and what its work cost`, onClick: () => app.openPc?.(p.id), mutable: false, flag: flag || undefined,
    }) });
  }
  const card = x => {
    const on = d.staff.filter(s => (s.pcId ?? '') === x.id);
    const li = el('li', { class: `pc-card${x.held ? ' pc-held' : ''}`, 'data-pc': x.id, ...(x.backupsOnly ? { 'data-backups': '1' } : {}), ...(x.held ? { 'data-held': '1' } : {}) },
      on.length ? el('div', { class: 'pc-desk', 'aria-label': `Working on ${x.name ?? 'this PC'}` }, ...on.map(s => {
        const a = staffActivity(s);
        const b = el('button', { class: 'desk-face', type: 'button', title: `${s.name} (${s.role}): ${ACTIVITY_WORD[a] ?? ''}. Drag onto another PC to move them`, 'aria-label': `${s.name}, ${ACTIVITY_WORD[a] ?? ''}` },
          app.avatar ? app.avatar(`staff:${s.id}`, initials(s.name), activityDot(a)) : el('span', { class: 'rail-avatar' }, initials(s.name), activityDot(a)));
        b.addEventListener('click', () => talkTo(s));
        deskDrag(b, s);
        return b;
      })) : null,
      ...x.row.childNodes);
    deskDrop(li, x);
    return li;
  };
  $('#rail-pcs-box').hidden = false;
  const clusterCard = drawClusterCard();
  $('#rail-cluster').hidden = !clusterCard;
  keepFocus($('#rail-cluster'), clusterCard ? [clusterCard] : []);
  keepFocus($('#rail-mypc'), [card(desks[0])]);
  $('#rail-pcs-head').hidden = desks.length < 2;
  // Fast update at the right of the Linked PCs heading, only while a linked PC that answers is behind this one.
  const behind = homeUi.pcs.filter(p => p.outdated && p.activity !== 'offline').length;
  const railFast = $('#rail-fast-update');
  railFast.hidden = !behind;
  railFast.onclick = updateAllLinked;
  if (behind) railFast.replaceChildren(clusterIcon(ICON_BOLT, 14), `Fast update (${behind})`);
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

/**
 * The cluster entry above My PC (2.0.96): a saved set of linked PCs with one on/off switch, so a combination such as two HP 800s
 * and a Z820 is switched on quickly and off again without being built each time. On, its PCs are greyed out in the list below
 * and held for models too big for this PC. Null (no card) with no linked PC and no saved set.
 */
function drawClusterCard() {
  const cl = homeUi.cluster ?? { on: false, members: [] };
  const linked = homeUi.pcs ?? [];
  if (!linked.length && !cl.members.length) return null;
  const members = cl.members.map(id => linked.find(p => p.id === id)).filter(Boolean);
  const ram = members.reduce((n, p) => n + (homeUi.pcMem?.[p.id]?.ram ?? p.ram ?? 0), 0);
  const names = members.map(p => app.pcLabel(p.id));
  const sub = members.length ? `${cl.out ? 'This PC connects to it · ' : ''}${names.join(' + ')}${ram ? ` · ${Math.round(ram / 2 ** 30)} GB RAM` : ''}` : 'No PCs picked yet: press to pick them';
  // A member that cannot lend now is said by name, with why (not answering, no permission there, no Max mode): a load leaves it out.
  const flag = cl.on && cl.gaps?.length ? cl.gaps.join('\n') : '';
  const li = staffRow({
    key: 'cluster', name: cl.on ? 'Cluster is on' : members.length ? 'Cluster is off' : 'Cluster', avatar: 'CL', sub, state: cl.on ? 'on' : 'off', stateText: cl.on ? (cl.out ? `On: "${cl.loaderName ?? 'a node'}" loads the model, this PC sends the chat` : `On: ${members.length} PC${members.length === 1 ? '' : 's'} held for big models`) : members.length ? 'Off: the PCs work as usual' : 'Not set up',
    activity: cl.on ? 'available' : 'offline', activityWord: cl.on ? 'On' : 'Off',
    title: `${flag ? `${flag}\n` : ''}Cluster: PCs saved together to borrow for models too big for this PC. Press to pick the PCs; the switch turns it on or off`, onClick: () => app.openCluster?.(), mutable: false, flag: flag || undefined,
  });
  li.classList.add('rail-staff-item', 'rail-cluster-item');
  const box = el('input', { type: 'checkbox', role: 'switch', checked: cl.on === true, disabled: !members.length, 'data-key': 'cluster-switch', 'aria-label': `Cluster ${cl.on ? 'on' : 'off'}`, title: members.length ? 'Switch the cluster on or off' : 'Pick the PCs for it first', onchange: async e => {
    const on = e.target.checked;
    e.target.disabled = true;
    // Refused or left alone: the switch goes back to what the server holds (the page is not redrawn when nothing changed).
    if (!(await changeCluster({ on }, barBox()))) e.target.checked = !on;
    e.target.disabled = false;
  } });
  li.append(el('label', { class: 'set-sw rail-sw' }, box, el('i', { 'aria-hidden': 'true' })));
  return li;
}

/** Rebuild the cluster's members and/or switch it; asks first when staff work on a PC it would hold. `box`: where the question shows. */
async function changeCluster(change, box) {
  const go = confirm => api('/api/remotes', { action: 'cluster', ...change, ...(confirm ? { confirm: true } : {}) });
  let ok = false;
  let note = '';
  try {
    note = (await go(false)).note ?? '';
    ok = true;
  } catch (err) {
    if (err.data?.needConfirm) {
      if (await askHere(box, err.message, 'Switch it on', 'Leave it as it is', false)) {
        try {
          note = (await go(true)).note ?? '';
          ok = true;
        } catch (x) {
          sayHere(box, x.message);
        }
      }
    } else {
      sayHere(box, `The cluster was not changed: ${err.message}`);
    }
  }
  await Promise.all([refreshPcs(), refreshOthers()]);
  if (note) sayHere(box, note);
  return ok;
}

/** Short names for someone hired from the Cluster page's Start chat: the first one nobody has yet. */
const CLUSTER_NAMES = ['Ada', 'Ben', 'Cleo', 'Dan', 'Eve', 'Finn', 'Gus', 'Hana', 'Ivy', 'Jon', 'Kit', 'Lena', 'Max', 'Nia', 'Otto', 'Pia'];

/** A small drawn mark (stroked paths), for the Cluster page's tiles and its Shutdown button. */
function clusterIcon(d, size = 16) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: String(size), height: String(size), 'aria-hidden': 'true', focusable: 'false', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) svg.setAttribute(k, v);
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', d);
  svg.append(p);
  return svg;
}
const ICON_POWER = 'M12 3v9M6.3 6.8a8 8 0 1 0 11.4 0';
const ICON_PC = 'M4 5h16v10H4zM9 19h6M12 15v4';
const ICON_BOLT = 'M13 2 4 14h7l-1 8 9-12h-7z';

/** GB in plain words for a PC's tile ("64 GB"), '' when not known. */
const clusterGb = n => (n ? `${Math.round(n / 2 ** 30)} GB` : '');

/**
 * The Cluster page, drawn as the PCs it is made of: this PC (the host) on top, the cluster's nodes under it in order of
 * power, and the pool they make together (RAM, card memory, cores). The cluster is on the left; the linked PCs not in it (Available) are on the right. A PC is
 * dragged from one side to the other, or moved with the button on its tile (the same change, for a keyboard or a touch
 * screen). Drawn from the linked PCs just asked.
 */
function drawCluster(pcs, cl) {
  const line = $('#node-cluster-line');
  if (line) line.textContent = cl.members.length ? `${cl.on ? 'On' : 'Off'}: ${cl.members.length} PC${cl.members.length === 1 ? '' : 's'} in the cluster${cl.out ? ', and this PC connects to it' : ''}. Open the page to change it.` : 'Put linked PCs together for models too big for this PC, and switch them on or off as one.';
  const box = $('#cluster-body');
  if (!box) return;
  const ask = $('#cluster-ask');
  const usable = pcs.filter(p => !p.backupsOnly);
  // What each PC has: the linked PC's own figures (its hello), else what the left list last knew of it.
  const memOf = p => {
    const seen = (homeUi.pcs ?? []).find(x => x.id === p.id) ?? p;
    // Its cores as its hello said (null: an older TOMLIN that does not say).
    return { ram: seen.memory?.ram?.total ?? homeUi.pcMem?.[p.id]?.ram ?? p.ram ?? 0, vram: seen.memory?.cards?.total ?? seen.memory?.gpu?.total ?? homeUi.pcMem?.[p.id]?.vram ?? p.vram ?? 0, card: seen.memory?.gpu?.name ?? '', cores: (seen.cpu ?? p.cpu)?.cores ?? null };
  };
  // Strongest first: the most card memory, then the most RAM (the order shown; the saved set keeps its own order).
  const byPower = (a, b) => memOf(b).vram - memOf(a).vram || memOf(b).ram - memOf(a).ram;
  const members = cl.members.map(id => usable.find(p => p.id === id)).filter(Boolean).sort(byPower);
  const others = usable.filter(p => !cl.members.includes(p.id)).sort(byPower);
  /** The set as the server holds it now, with `id` put in (last) or taken out: two quick moves do not lose one. */
  const move = async (id, into) => {
    const have = (homeUi.cluster ?? cl).members;
    if (into === have.includes(id)) return;
    await changeCluster({ members: into ? [...have, id] : have.filter(x => x !== id) }, ask);
  };
  const on = el('label', { class: 'set-sw' }, el('input', { type: 'checkbox', role: 'switch', checked: cl.on === true, disabled: !cl.members.length, 'data-key': 'cluster-on', 'aria-label': 'Cluster on', onchange: async e => {
    const want = e.target.checked;
    e.target.disabled = true;
    if (!(await changeCluster({ on: want }, ask))) e.target.checked = !want;
    e.target.disabled = false;
  } }), el('i', { 'aria-hidden': 'true' }));
  const has = m => [m.ram ? `${clusterGb(m.ram)} RAM` : '', m.vram ? `${clusterGb(m.vram)} card memory${m.card ? ` (${m.card})` : ''}` : 'no card', m.cores === undefined ? '' : m.cores ? `${m.cores} cores` : 'cores not known'].filter(Boolean).join(' · ');
  const tile = (p, inSet, rank) => {
    const m = memOf(p);
    const why = !p.ok ? 'Not answering now' : p.allow?.lend === true ? '' : 'Its owner has not ticked "Allow to be used as part of a cluster" there';
    const li = el('li', { class: `cluster-pc${inSet ? ' cluster-node' : ''}`, draggable: 'true', 'data-pc': p.id, ...(why && !inSet ? { 'data-cannot': '1' } : {}),
      ondragstart: e => {
        e.dataTransfer.setData('text/plain', p.id);
        e.dataTransfer.effectAllowed = 'move';
        homeUi.clusterDrag = { id: p.id, inSet };
        li.classList.add('cluster-dragged');
      },
      ondragend: () => {
        homeUi.clusterDrag = null;
        li.classList.remove('cluster-dragged');
        for (const z of box.querySelectorAll('.cluster-over')) z.classList.remove('cluster-over');
      } },
      el('span', { class: 'cluster-mark' }, clusterIcon(ICON_PC, 20)),
      el('b', {}, app.pcLabel(p.id), inSet && rank === 0 && members.length > 1 ? el('span', { class: 'cluster-tag', text: 'Strongest' }) : null,
        inSet && cl.out && cl.loader === p.id ? el('span', { class: 'cluster-tag cluster-loads', text: 'Loads the model' }) : null),
      el('button', { class: 'btn', type: 'button', 'data-key': `cluster-move:${p.id}`, text: inSet ? 'Remove' : 'Add', 'aria-label': inSet ? `Remove ${p.name} from the cluster` : `Add ${p.name} to the cluster`, onclick: async e => {
        e.currentTarget.disabled = true;
        await move(p.id, !inSet);
      } }),
      el('span', { class: 'hint', text: m.ram || m.vram ? has(m) : 'Its memory is not known yet' }),
      why ? el('span', { class: 'hint', role: inSet ? 'status' : null, text: inSet ? `${why}: a load leaves it out.` : `${why}.` }) : null);
    return li;
  };
  // This PC (the host) is drawn outside the cluster's box and above it, joined to it by a line: it connects TO the cluster.
  // It either takes part (it loads the model and keeps a share of it: the way it has always been) or stays out and only
  // sends the chat, with the member marked "Loads the model" loading it (src/cluster/loader.ts). The switch says which.
  const hw = app.status?.hardware;
  const here = { ram: hw?.ram?.total ?? 0, vram: hw?.gpu && !hw.gpu.shared ? hw.gpu.total ?? 0 : 0, card: hw?.gpu && !hw.gpu.shared ? hw.gpu.name ?? '' : '' };
  // What this PC adds to the pool below: nothing when it stays out.
  const hostMem = cl.out ? { ram: 0, vram: 0, card: '' } : here;
  const loaderName = cl.out ? cl.loaderName ?? 'a node' : '';
  const host = el('div', { class: `cluster-pc cluster-host${cl.out ? ' cluster-host-out' : ''}`, 'data-pc': 'here' },
    el('span', { class: 'cluster-mark' }, clusterIcon(ICON_PC, 20)),
    el('b', {}, app.pcLabel('here'), el('span', { class: 'cluster-tag', text: 'This PC' }), cl.out ? null : el('span', { class: 'cluster-tag cluster-loads', text: 'Loads the model' })),
    el('span', { class: 'hint', text: here.ram ? `${has(here)}${hw?.cpu?.cores ? ` · ${hw.cpu.cores} cores` : ''}` : 'This PC' }));
  const joins = el('div', { class: `cluster-link${cl.out ? ' cluster-link-out' : ''}` }, el('span', { class: 'cluster-link-words', text: cl.out
    ? 'This PC connects to the cluster and sends the chat'
    : 'This PC takes part: the model loads here' }));
  // "This PC takes part": on is the old way; off is refused by the server, with why, when no member can load the model now.
  const part = el('label', { class: 'set-sw' }, el('input', { type: 'checkbox', role: 'switch', checked: !cl.out, disabled: !cl.members.length, 'data-key': 'cluster-part', 'aria-label': 'This PC takes part', onchange: async e => {
    const want = e.target.checked;
    e.target.disabled = true;
    if (!(await changeCluster({ takesPart: want }, ask))) e.target.checked = !want;
    e.target.disabled = false;
  } }), el('i', { 'aria-hidden': 'true' }));
  const partRow = el('div', { class: 'set-card cluster-part' }, el('div', { class: 'set-row' },
    el('span', { class: 'set-tile' }, clusterIcon(ICON_PC, 18)),
    el('span', { class: 'set-txt' }, el('b', { text: 'This PC takes part' }), el('span', { class: 'set-about', text: cl.out
      ? `Off: this PC only connects to the cluster and sends the chat, as text. "${loaderName}" loads the model from its own disk and borrows the other PCs' cards and RAM itself, so this PC's card, processor and network link carry none of the model. Switch it on to load the model here again.`
      : 'On: the model loads on this PC, which keeps a share of it on its own card and RAM and sends each other PC its part over this PC\'s network link. Switch it off to only connect, for example from a laptop on Wi-Fi: the strongest wired PC in the cluster then loads the model, if it can (it needs links of its own to the other PCs, made on it).' })),
    el('span', { class: 'set-side' }, part)));
  /** One side of the page: takes a PC dropped on it when the PC comes from the other side. */
  const zone = (inSet, title, about, kids) => {
    const z = el('section', { class: 'cluster-zone', 'data-zone': inSet ? 'in' : 'out', 'aria-label': title,
      ondragover: e => {
        if (!homeUi.clusterDrag || homeUi.clusterDrag.inSet === inSet) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        z.classList.add('cluster-over');
      },
      ondragleave: e => { if (!z.contains(e.relatedTarget)) z.classList.remove('cluster-over'); },
      ondrop: async e => {
        const d = homeUi.clusterDrag;
        z.classList.remove('cluster-over');
        if (!d || d.inSet === inSet) return;
        e.preventDefault();
        await move(d.id, inSet);
      } },
      el('h3', { text: title }), el('p', { class: 'hint', text: about }), ...kids.filter(Boolean));
    return z;
  };
  // The pool: what the host and the cluster's nodes have together. The cores are this PC's and those of the nodes that
  // say theirs (an older TOMLIN does not): how many do not is said under the figure.
  const ram = hostMem.ram + members.reduce((n, p) => n + memOf(p).ram, 0);
  const cores = (cl.out ? 0 : hw?.cpu?.cores ?? 0) + members.reduce((n, p) => n + (memOf(p).cores ?? 0), 0);
  // Whose cores they are: this PC's only while it takes part.
  const whose = cl.out ? 'on' : 'on this PC and';
  const silent = members.filter(p => !memOf(p).cores).length;
  const vram = hostMem.vram + members.reduce((n, p) => n + memOf(p).vram, 0);
  const cards = (hostMem.vram ? 1 : 0) + members.filter(p => memOf(p).vram).length;
  const fig = (big, small, key) => el('div', { class: 'cluster-fig', 'data-fig': key }, el('b', { text: big }), el('span', { class: 'hint', text: small }));
  const pool = el('div', { class: 'cluster-pool', role: 'status', 'aria-label': 'The pool' },
    cl.out ? fig(`${members.length} PC${members.length === 1 ? '' : 's'}`, 'the nodes in the cluster; this PC only connects', 'pcs') : fig(`${members.length + 1} PC${members.length ? 's' : ''}`, members.length ? 'this PC and the nodes under it' : 'only this PC so far', 'pcs'),
    fig(ram ? clusterGb(ram) : 'not known', 'RAM in the pool', 'ram'),
    fig(vram ? clusterGb(vram) : 'none', `card memory on ${cards} card${cards === 1 ? '' : 's'}`, 'gpu'),
    fig(cores ? `${cores} cores` : 'not known', !members.length ? (cl.out ? 'no node yet' : 'on this PC') : silent ? `${whose} ${members.length - silent} of ${members.length} node${members.length === 1 ? '' : 's'}; ${silent} ${silent === 1 ? 'does' : 'do'} not say ${silent === 1 ? 'its' : 'theirs'} (an older TOMLIN)` : `${whose} the nodes`, 'cpu'));
  // Choose an LLM, confirm the name, start chatting: a chat belongs to a hire, so one is made on the spot with a short
  // name from the list above (any name can be typed over it, and changed later under Staff).
  // With this PC out of the cluster, only the chat models on the loader's own disk can be loaded there (it never takes a
  // model from this PC's link): the chat goes to that PC, as a chat with someone hired on a linked PC does.
  const llms = cl.out ? cl.loaderModels ?? [] : (app.models?.chat ?? []).filter(m => m.installed !== false);
  const taken = new Set((homeUi.data?.staff ?? []).map(x => String(x.name).toLowerCase()));
  const spare = CLUSTER_NAMES.find(n => !taken.has(n.toLowerCase())) ?? `Helper ${taken.size + 1}`;
  const pick = el('select', { id: 'cluster-llm', 'data-key': 'cluster-llm', 'aria-label': 'Choose an LLM' }, ...llms.map(m => el('option', { value: m.id, text: String(m.name).split(' · ')[0] })));
  if (llms.some(m => m.id === homeUi.clusterLlm)) pick.value = homeUi.clusterLlm;
  pick.addEventListener('change', () => { homeUi.clusterLlm = pick.value; });
  const who = el('input', { id: 'cluster-name', 'data-key': 'cluster-name', type: 'text', maxlength: '30', value: homeUi.clusterName ?? spare, 'aria-label': 'Name of the new staff member' });
  who.addEventListener('input', () => { homeUi.clusterName = who.value; });
  const start = el('div', { class: 'set-card cluster-start' }, el('div', { class: 'set-row' },
    el('span', { class: 'set-tile' }, document.querySelector('[data-setup="models"] svg')?.cloneNode(true) ?? ''),
    el('span', { class: 'set-txt' }, el('b', { text: 'Choose an LLM' }), el('span', { class: 'set-about', text: cl.out
      ? (llms.length ? `The models on "${loaderName}", which loads the model for the cluster. Start chat hires someone with that model under the name shown and opens their chat: "${loaderName}" answers, borrowing from the other PCs in the cluster when the model is too big for it alone, and only the chat's words cross this PC's link.` : cl.loaderNoModel || `No chat model is on "${loaderName}" yet.`)
      : llms.length
        ? 'Start chat hires someone with that chat model under the name shown (change it if you like) and opens their chat. A model too big for this PC borrows from the cluster when the cluster is on.'
        : 'No chat model is on this PC yet: add one under Models first.' })),
    el('span', { class: 'set-side' }, ...(llms.length ? [pick, who,
      el('button', { class: 'btn primary', type: 'button', 'data-key': 'cluster-start', text: 'Start chat', onclick: async e => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
          team.data = await api('/api/staff', { action: 'hire', name: who.value.trim() || spare, role: 'default', model: pick.value });
          const hired = team.data.staff.at(-1);
          homeUi.clusterName = undefined;
          await app.afterHire?.(hired);
          await app.talkTo(`staff:${hired.id}`);
        } catch (err) {
          sayHere(ask, `The chat was not started: ${err.message}`);
          btn.disabled = false;
        }
      } })] : [el('button', { class: 'btn primary', type: 'button', 'data-key': 'cluster-models', text: 'Models', onclick: () => app.openModels?.() })]))));
  // Shutdown turns the cluster's nodes off, asking each in turn (each asks its own PIN). Never this PC.
  const offAll = members.length ? el('p', { class: 'hint cluster-off' }, el('button', { class: 'btn', type: 'button', 'data-key': 'cluster-off', title: 'Turns each node of the cluster off, one at a time, asking each one for its app lock PIN. This PC stays on.', onclick: async e => {
    const btn = e.currentTarget;
    if (!confirm(`Turn off ${members.map(p => `"${p.name}"`).join(', ')}?

Each shuts down about 15 seconds after it answers, one after the other, and stays off until someone switches it on again. Each asks for its own app lock PIN. This PC stays on.`)) return;
    btn.disabled = true;
    const said = [];
    for (const p of members) {
      if (!canTurnOff(p)) {
        said.push(`"${p.name}": ${!p.ok ? 'not answering' : p.allow?.off === true ? 'cannot be turned off from here' : 'its owner has not allowed it'}.`);
        continue;
      }
      try {
        const r = await powerOffWithPin(p);
        said.push(r ? `${r.said}` : `"${p.name}": not turned off (no PIN given).`);
      } catch (err) {
        said.push(`"${p.name}": ${err.message}`);
      }
      sayHere(ask, said.join(' '));
    }
    sayHere(ask, said.join(' '));
    btn.disabled = false;
    refreshPcs();
  } }, clusterIcon(ICON_POWER), 'Shutdown'), el('span', { text: ` Turns off the ${members.length} node${members.length > 1 ? 's' : ''} in the cluster, not this PC.` })) : null;
  const gaps = cl.on && cl.gaps?.length ? el('p', { class: 'hint', role: 'status', text: cl.gaps.join(' ') }) : null;
  const three = cl.members.length >= 3 ? el('p', { class: 'hint', text: 'Three PCs or more together are not reliable yet: a long load can fail when one of them stops answering. Two work.' }) : null;
  keepFocus(box, [
    // Every settings row starts with its icon tile (on a narrow page the row is a grid whose first column is the icon's).
    el('div', { class: 'set-card' }, el('div', { class: 'set-row' },
      el('span', { class: 'set-tile' }, document.querySelector('[data-setup="cluster"] svg')?.cloneNode(true) ?? ''),
      el('span', { class: 'set-txt' }, el('b', { text: cl.on ? 'The cluster is on' : 'The cluster is off' }), el('span', { class: 'set-about', text: cl.on && cl.out
        ? `Chats for the cluster go to "${loaderName}", which loads the model and borrows the card, RAM and cores of the other PCs in the cluster. Those PCs are held for it (greyed out in the left list; no staff, chats or pictures go there).`
        : cl.on
        ? 'Models too big for this PC borrow the card, RAM and cores of the PCs in the cluster, and those PCs are held for it (greyed out in the left list; no staff, chats or pictures go there).'
        : cl.members.length ? 'The PCs in the cluster are kept here and work as usual; nothing is borrowed from them. Switch it on to use them for models too big for this PC.'
          : 'Put at least one PC in the cluster, then switch it on. With no cluster, any linked PC that allows it is borrowed from.' })),
      el('span', { class: 'set-side' }, on))),
    partRow,
    pool,
    el('div', { class: 'cluster-cols' },
      // This PC above the cluster's box, joined to it: it connects to the cluster, it is not one of its nodes.
      el('div', { class: 'cluster-side' }, host, joins,
        zone(true, 'The cluster', cl.out ? 'Its nodes, strongest first. The one marked "Loads the model" starts it from its own disk and borrows from the others.' : 'Its nodes, strongest first. They lend their card and RAM to this PC, which loads the model.', [members.length ? el('ul', { class: 'cluster-list' }, ...members.map((p, k) => tile(p, true, k))) : el('p', { class: 'hint cluster-empty', text: 'Drag a PC here, or press Add on its tile.' })])),
      zone(false, 'Available', 'Linked PCs not in the cluster: they work as usual. Strongest first.', [others.length ? el('ul', { class: 'cluster-list' }, ...others.map(p => tile(p, false, -1))) : el('p', { class: 'hint cluster-empty', text: usable.length ? 'Every linked PC is in the cluster.' : 'No linked PC yet: link one under Network first.' })])),
    start,
    gaps || three || offAll ? el('div', { class: 'cluster-under' }, ...[gaps, three, offAll].filter(Boolean)) : null,
  ]);
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
  // On a break is the office's own (a deck chair after 10 minutes with nothing to do): asked of it each time.
  const breaks = app.office?.breaks?.() ?? [];
  const sig = JSON.stringify([d.staff, counts, hw?.ram?.total ?? 0, homeUi.pcMem, breaks]);
  if (sig === homeUi.drawn.overview) return;
  homeUi.drawn.overview = sig;
  const follow = s => app.office?.select(s.id);
  const ramOf = s => (s.pcId ? homeUi.pcMem[s.pcId]?.ram : hw?.ram?.total) ?? 0;
  const card = s => {
    const doing = breaks.includes(s.id) ? 'On a break: in a deck chair on the beach' : s.doingText ?? (s.busy ? `Working: ${s.busy}` : ACTIVITY_WORD[s.activity] ?? s.text ?? '');
    const ram = ramOf(s);
    const where = `${s.pc || pcName('here', 'My PC')}${ram ? ` · ${Math.round(ram / 2 ** 30)} GB RAM` : ''}`;
    const hover = [s.modelName || 'No model given', counts[s.id] ? `${doing} · ${counts[s.id]} waiting for you` : doing].filter(Boolean).join('\n');
    return el('li', { class: 'so-card', title: hover, onclick: e => { if (!e.target.closest('button')) follow(s); } },
      app.avatar ? app.avatar(`staff:${s.id}`, initials(s.name), activityDot(s.activity)) : el('span', { class: 'rail-avatar', 'aria-hidden': 'true' }, initials(s.name), activityDot(s.activity)),
      el('button', { class: 'so-name', type: 'button', title: hover, 'aria-label': `${s.name}, ${where}. ${hover.replace('\n', '. ')}. Show ${s.name} in the office.`, onclick: () => follow(s) },
        el('strong', { text: s.name }), el('span', { class: 'so-where', text: where })),
      el('button', { class: 'icon-btn so-chat', type: 'button', title: `Chat with ${s.name}`, 'aria-label': `Chat with ${s.name}`, onclick: () => talkTo(s) }, svgIcon(CHAT_BUBBLE, 18)));
  };
  const empty = () => el('li', { class: 'home-empty so-empty' }, el('span', { text: 'Nobody hired yet.' }), el('button', { class: 'btn primary', type: 'button', text: 'Hire staff', onclick: () => app.openHire() }));
  for (const list of [$('#home-staff-overview'), $('#side-staff')]) keepFocus(list, d.staff.length ? d.staff.map(card) : [empty()]);
}

// ---- The hot desk: drag a hire onto another PC to move them there (where it has software for them) ----

/** Where a hire could run on one PC ('' = this PC): that PC's models of their kind (chat, or picture). */
function deskModels(s, pc) {
  // A hidden model is left out (unless "Show hidden" is ticked): a hire is moved onto models offered for picking.
  const list = visibleModels(team.data?.hireChoices?.[s.kind === 'image' ? 'image' : 'chat'] ?? []);
  // On a linked PC: the models it lets this PC use. "What it has loaded" counts only when something is loaded there:
  // a PC that shares nothing (its ticks under Network) offers nothing to move to.
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
      const shut = c.querySelector('.sdot')?.dataset.activity === 'offline' || c.querySelector('.sdot')?.dataset.activity === 'owner' || c.dataset.backups === '1' || c.dataset.held === '1';
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
    // A PC just linked, or slow to answer, has no list here yet: it is asked again before anything is said about it.
    if (pc && !deskModels(s, pc).length) {
      $('#desk-move-title').textContent = `Move ${s.name} to ${pcName}`;
      $('#desk-move-line').textContent = `Asking ${pcName} what models it has…`;
      $('#desk-move-row').hidden = true;
      $('#desk-move-go').hidden = true;
      $('#desk-move-big').hidden = true;
      $('#desk-move-fault').hidden = true;
      $('#desk-move-send').replaceChildren();
      moveDlg.dataset.id = s.id;
      if (!moveDlg.open) moveDlg.showModal();
      for (let i = 0; i < 4 && !deskModels(s, pc).length; i++) {
        await new Promise(r => setTimeout(r, 1500));
        if (!moveDlg.open) return;
        team.data = await api('/api/staff');
      }
      if (!moveDlg.open) return;
    }
  } catch (err) {
    if (moveDlg.open) moveDlg.close();
    return sayHere($('#home-ask-say'), err.message);
  }
  const models = deskModels(s, pc);
  const short = n => String(n ?? '').replace(/ on ".*$/, '').toLowerCase();
  // Each model against that PC's memory as a whole (the server sends ramFit; src/calc.ts): one that will not fit is
  // shown but cannot be picked, and says what it needs and what the PC has.
  const mem = pc ? team.data?.pcs?.find(p => p.id === pc) : team.data?.here;
  const gb = n => `${(n / 2 ** 30).toFixed(n >= 10 * 2 ** 30 ? 0 : 1)} GB`;
  const wontFit = c => c.ramFit === 'no';
  const fits = models.filter(c => !wontFit(c));
  const same = models.find(c => short(c.name) === short(s.modelName));
  $('#desk-move-title').textContent = `Move ${s.name} to ${pcName}`;
  const sel = $('#desk-move-model');
  sel.replaceChildren(...models.map(c => el('option', { value: c.id, disabled: wontFit(c),
    text: `${c.name.replace(/ on ".*?"/, '')}${wontFit(c) ? ` (needs about ${gb(c.need)}: more than ${pcName} has)` : c.ramFit === 'tight' ? ' (tight fit)' : ''}` })));
  if (same && !wontFit(same)) sel.value = same.id;
  else if (fits.length) sel.value = fits[0].id;
  $('#desk-move-row').hidden = !models.length;
  $('#desk-move-go').hidden = !fits.length;
  // The ones left out, said in words (a greyed line in a closed list is not seen).
  const big = fits.length ? models.filter(wontFit) : [];
  $('#desk-move-big').hidden = !big.length;
  $('#desk-move-big').textContent = big.length ? `Not offered, too big for ${pcName}${mem?.ram ? ` (${gb(mem.ram)} of RAM, 3 GB of it kept for Windows${mem.vram ? `, and ${gb(mem.vram)} of graphics-card memory` : ''})` : ''}: ${big.map(c => `${c.name.replace(/ on ".*?"/, '').replace(/ \(.*\)$/, '')} needs about ${gb(c.need)}`).join('; ')}.` : '';
  $('#desk-move-fault').hidden = true;
  const line = $('#desk-move-line');
  const box = $('#desk-move-send');
  box.replaceChildren();
  const own = s.model && !String(s.model).startsWith('remote:') ? s.model : '';
  const ram = mem?.ram ? `${pcName} has ${gb(mem.ram)} of RAM${mem.vram ? ` and ${gb(mem.vram)} of graphics-card memory` : ''}` : '';
  if (models.length && !fits.length) line.textContent = `None of the models on ${pcName} fits its memory${ram ? ` (${ram}, 3 GB of it kept for Windows)` : ''}. Send a smaller model there first, or move ${s.name} to a PC with more memory.`;
  else if (same && wontFit(same)) line.textContent = `${pcName} has ${s.modelName}, but it needs about ${gb(same.need)} and ${ram || 'that PC has less'}. Pick a smaller model ${s.name} runs on there.`;
  else if (same) line.textContent = `${pcName} has ${s.modelName}${same.ramFit === 'ok' ? ', and it fits' : same.ramFit === 'tight' ? ', but it is a tight fit' : ''}: ${s.name} keeps the same software there.`;
  else if (models.length) line.textContent = `${pcName} does not have ${s.modelName || 'their model'}. Pick the software ${s.name} runs on there${pc && own ? ', or send a copy of theirs first' : ''}.`;
  else if (!pc) line.textContent = `This PC has no ${s.kind === 'image' ? 'picture' : 'chat'} models yet.`;
  else line.textContent = team.data?.pcs?.find(p => p.id === pc)?.ok ? `${pcName} has no ${s.kind === 'image' ? 'picture' : 'chat'} models yet. Send one there from Models.` : `${pcName} is not answering just now. Check it is on, then try again.`;
  if (pc && !models.length) box.append(el('button', { class: 'btn', type: 'button', text: 'Try again', onclick: () => deskMove(s, pc, pcName) }));
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
  if (!moveDlg.open) moveDlg.showModal();
}
$('#desk-move-cancel').addEventListener('click', () => moveDlg.close());
$('#desk-move-go').addEventListener('click', async () => {
  const go = $('#desk-move-go');
  go.disabled = true;
  try {
    team.data = await api('/api/staff', { action: 'change', id: moveDlg.dataset.id, model: $('#desk-move-model').value, move: true });
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
// ---- Network (this PC as a node, and the models other PCs may use; finding and linking PCs) and This PC:
// models and updates (the models on this PC, Update this install) as tiles with their
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

/**
 * A linked PC's memory on its card, short: the name on the left, "7.1 GB used of 32 GB" on the right, the bar under
 * them. The long words (models loaded, other programs, free) stay in the bar's tooltip and its spoken label.
 */
function memLine(bar, label) {
  const used = bar.segments.filter(s => s.kind !== 'free').reduce((n, s) => n + s.bytes, 0);
  const total = used + (bar.segments.find(s => s.kind === 'free')?.bytes ?? 0);
  const box = memBar(bar, label);
  box.classList.add('mbar-short');
  box.title = bar.text;
  box.querySelector('.mbar-title').after(el('span', { class: 'mbar-sum', text: `${used < 0.05 * 2 ** 30 ? '0 GB' : NODE_GB(used)} used of ${NODE_GB(total)}` }));
  box.querySelector(':scope > .hint').remove();
  return box;
}

function drawNodes(n) {
  homeUi.nodes = n;
  drawNodeSwitch(n);
  // This PC's memory and what is loaded are in the top bar (its rings and the models loaded). The models list on
  // Settings > This PC is the one in this PC's window (pcs.js), drawn when the page opens.
}

/** A model hidden, shown or deleted: the lists a model is picked from are read again (chat, Hire staff, Edit Staff). */
function modelListsChanged() {
  loadModels().catch(() => undefined);
  teamLoad().catch(() => undefined);
  app.hireRedraw?.();
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
    : 'Off. Turn on to let your main PC use this PC\'s models (home network only).';
  $('#node-setup').hidden = !sh.on;
  // "Open sharing permissions" said why the ticks were not showing: gone once they show.
  if (sh.on) $('#node-allow-why').hidden = true;
  if (!typing($('#node-name')) && !saving) $('#node-name').value = sh.name;
  if (!typing($('#node-port')) && !saving) $('#node-port').value = String(sh.port);
  $('#node-code').textContent = sh.code;
  // Each setup code links one PC, then a new one is made (audit X4): who used the last one, and when.
  const ll = sh.lastLinked;
  $('#node-linked').hidden = !ll;
  $('#node-linked').textContent = ll ? `Last linked: "${ll.name}" on ${new Date(ll.at).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}, with the code before this one (each code links one PC). Not you? Remove it under "PCs linked to this one" below.${ll.dropped ? ` The oldest link, "${ll.dropped}", was removed to make room (10 at most).` : ''}` : '';
  // Too many wrong setup codes from the home network in 10 minutes: linking waits (S3).
  $('#node-link-paused').hidden = !sh.linkPaused;
  $('#node-link-paused').textContent = sh.linkPaused ? `(!) Linking to this PC is paused for ${sh.linkPaused} minute${sh.linkPaused > 1 ? 's' : ''}: too many wrong setup codes were typed from your home network. If nobody here typed them, press New code.` : '';
  const asig = JSON.stringify(sh.addresses);
  if (asig !== homeUi.drawn.addrs) {
    homeUi.drawn.addrs = asig;
    // The home connection first; a virtual-machine, hotspot or VPN one is marked as not the one to type (2.0.64).
    const addrs = [...sh.addresses].sort((x, y) => (x.kind === 'home' ? 0 : 1) - (y.kind === 'home' ? 0 : 1));
    $('#node-addrs').replaceChildren(...(addrs.length ? addrs.map(a => {
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
      return el('div', { class: 'node-code-row' }, el('code', { class: 'node-addr', text: a.address }), el('span', { class: 'hint', text: a.kind && a.kind !== 'home' ? `${a.via} (ignore: not your home network)` : a.via }), copy);
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
    $('#node-paired').replaceChildren(...(sh.paired.length ? [el('p', { class: 'hint', text: 'PCs linked to this one:' }), ...sh.paired.map((x, k) => el('div', { class: 'job-remote' }, el('span', { text: x.name }), el('span', { class: 'hint', text: x.old ? 'linked before the link was encrypted: link it again from that PC' : x.guest ? `guest, since ${new Date(x.at).toLocaleDateString()}${x.expires ? `, until ${new Date(x.expires).toLocaleDateString()}` : ''}` : `since ${new Date(x.at).toLocaleDateString()}` }),
      el('button', { class: 'link', type: 'button', text: 'Remove', onclick: async () => { if (await askHere($('#node-paired-ask'), `Stop lending to "${x.name}"? It would need the setup code again.`, `Stop lending to ${x.name}`, 'Keep it linked')) nodeShare({ unpair: k, unpairId: x.id }); } })))] : [el('p', { class: 'hint', text: 'No PC has linked to this one yet.' })]));
  }
  // A4: new PCs asking for backups kept here, each with Allow / Don't allow (owner.js).
  app.drawClaims?.(sh.claims);
  drawNodeShare(sh);
  drawNodeAllow(sh);
  drawGuestPasses(sh);
  drawHostPinsHeld(n.hostPins ?? [], sh);
}

/**
 * The linked hosts that gave this PC a host PIN (one PIN typed on that host for every PC that holds it), under the PCs
 * linked to this one: each named, with Take it away (that host then asks this PC's own PIN again).
 */
function drawHostPinsHeld(list, sh) {
  const sig = JSON.stringify([list, sh.paired.map(x => [x.id, x.name])]);
  if (sig === homeUi.drawn.hostPins) return;
  homeUi.drawn.hostPins = sig;
  const nameOf = x => sh.paired.find(p => p.id === x.id)?.name ?? x.name;
  $('#node-host-pins').replaceChildren(...(list.length ? [el('p', { class: 'hint', text: 'Hosts that hold a host PIN for this PC (one PIN typed there updates it, turns it off or deletes a model, still only with the ticks above):' }),
    ...list.map(x => el('div', { class: 'job-remote' }, el('span', { text: nameOf(x) }), el('span', { class: 'hint', text: x.at ? `since ${new Date(x.at).toLocaleDateString()}` : '' }),
      el('button', { class: 'link', type: 'button', text: 'Take it away', onclick: async () => { if (await askHere($('#node-paired-ask'), `Take the host PIN away from "${nameOf(x)}"? It then asks for this PC's own app lock PIN again to update it, turn it off or delete a model. It stays linked.`, 'Take it away', 'Keep it')) nodeShare({ hostPinDrop: x.id }); } })))] : []));
}

/**
 * Guest passes: one line each (its name, when it ends, last seen, the PCs and models it is for, or the host that gave
 * it; Remove; an ended one greyed, marked expired); a line for each linked node saying whether it holds the latest
 * passes; and "Make a guest pass" (name, length, and the PCs with their models: this PC when it is a node, and each
 * linked node). The code is shown once, from the answer that made it, and kept only on this page until Done.
 */
function drawGuestPasses(sh) {
  const when = t => new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const pcs = (sh.passNodes ?? []).map(p => ({ ...p, models: p.self ? (sh.shareable ?? []) : (p.models ?? []) }));
  const pcName = id => (pcs.find(p => p.id === id)?.name ?? 'a PC no longer linked');
  const modelName = (pc, id) => pcs.find(p => p.id === pc)?.models.find(m => m.id === id)?.name ?? id;
  const sig = JSON.stringify([sh.passes, pcs.map(p => [p.id, p.name, p.models.map(m => [m.id, m.name])])]);
  if (sig !== homeUi.drawn.passes) {
    homeUi.drawn.passes = sig;
    const passes = sh.passes ?? [];
    // A code still on show whose pass was removed goes too.
    const made = $('#node-pass-made');
    if (made.dataset.pass && !passes.some(x => x.id === made.dataset.pass)) {
      made.replaceChildren();
      made.hidden = true;
      delete made.dataset.pass;
    }
    // Where a pass works: each PC with its models (made here), or the host that gave it and this PC's models.
    const where = x => {
      if (x.from) return `from "${x.from}": ${x.models.length ? x.models.map(id => modelName(sh.passNodes?.find(p => p.self)?.id, id)).join(', ') : 'no models'}`;
      return x.nodes.map(id => {
        const ms = x.nodeModels?.[id] ?? x.models;
        return `${pcName(id)} (${ms.length ? ms.map(m => modelName(id, m)).join(', ') : 'no models'})`;
      }).join('; ');
    };
    // Guests whose link was renewed after their request: each one's new end (the pass itself may have ended).
    const renewedWords = x => (x.renewals ?? []).map(r => `"${r.name}"${r.pcName ? ` on ${r.pcName}` : ''} renewed ${r.until ? `until ${when(r.until)}` : 'with no end'}${r.live ? '' : ' (ended)'}`).join('; ');
    $('#node-pass-list').replaceChildren(...(passes.length ? passes.map(x => el('div', { class: `job-remote${x.expired && !(x.renewals ?? []).some(r => r.live) ? ' pass-expired' : ''}` },
      el('span', { text: x.label }),
      el('span', { class: 'hint', text: x.expired ? `expired ${when(x.expires)}` : x.expires ? `until ${when(x.expires)}` : 'no limit' }),
      el('span', { class: 'hint', text: x.lastSeen ? `last seen here ${when(x.lastSeen)}` : 'not used here yet' }),
      el('span', { class: 'hint', text: where(x) }),
      (x.renewals ?? []).length ? el('span', { class: 'hint ok', text: renewedWords(x) }) : null,
      el('button', { class: 'link', type: 'button', text: 'Remove', onclick: async () => { if (await askHere($('#node-pass-ask'), x.from ? `Remove the guest pass "${x.label}" on this PC? A PC linked here with it stops at once. "${x.from}" gave it, and keeps it for its other PCs.` : `Remove the guest pass "${x.label}"? A PC linked with it stops at once on every PC it is for, and its code links nothing more.`, 'Remove the pass', 'Keep it')) nodeShare({ passRemove: x.id }); } })))
      : [el('p', { class: 'hint', text: 'No guest passes yet.' })]));
  }
  // Requests for more time from guests whose pass expired: one line each, answered here (Approve renews the same link).
  const asig = JSON.stringify(sh.passAsks ?? []);
  if (asig !== homeUi.drawn.passAsks) {
    homeUi.drawn.passAsks = asig;
    const ago = t => {
      const m = Math.max(0, Math.round((Date.now() - Date.parse(t)) / 60_000));
      return m < 60 ? `${m} minute${m === 1 ? '' : 's'}` : m < 2880 ? `${Math.round(m / 60)} hour${Math.round(m / 60) === 1 ? '' : 's'}` : `${Math.round(m / 1440)} days`;
    };
    $('#node-pass-asks').replaceChildren(...(sh.passAsks ?? []).map(q => {
      // Renew for: a number of days or Never expires, the last one used first.
      const length = el('select', { 'aria-label': `Renew ${q.name} for` }, ...(sh.renewLengths ?? []).map(x => el('option', { value: x.id, text: x.label, selected: x.id === q.defaultLength })));
      const reason = el('input', { type: 'text', maxlength: '200', placeholder: 'Reason (optional)', 'aria-label': `Reason to give ${q.name}` });
      const send = answer => nodeShare({ passAnswer: { pc: q.pc, id: q.id, answer, length: length.value, reason: reason.value } });
      return el('div', { class: 'pass-ask-line' },
        el('p', { text: `"${q.name}"${q.pc ? ` on "${q.pcName}"` : ''}: guest pass ended ${ago(q.expired)} ago. "${q.text}"` }),
        el('div', { class: 'team-actions' }, el('label', { class: 'pass-renew' }, 'Renew for ', length),
          el('button', { class: 'btn primary', type: 'button', text: 'Approve', onclick: () => send('renew') }),
          reason,
          el('button', { class: 'btn', type: 'button', text: 'Deny', onclick: () => send('deny') }),
          el('button', { class: 'btn danger', type: 'button', text: 'Block', onclick: async () => { if (await askHere($('#node-pass-ask'), `Block "${q.name}"? It cannot ask again; its pass stays ended.`, 'Block it', 'Cancel')) send('block'); } })));
    }));
  }
  // This PC as a node: who is running and who is waiting in its line, "Host goes first", and the guest caps.
  $('#node-line-box').hidden = !sh.on;
  if (sh.on && sh.line) {
    const what = x => `"${x.name}"${x.guest ? ' (guest)' : ''}: ${x.what === 'picture' ? 'a picture' : 'an answer'}${x.model ? ` on ${x.model}` : ''}`;
    const run = (sh.line.running ?? []).map(x => `${what(x)} for ${x.seconds} s`);
    const wait = (sh.line.waiting ?? []).map((x, i) => `${i + 1}. ${what(x)}, waiting ${x.seconds} s`);
    // The models loaded now: how many each writes together, and why fewer than asked.
    const slotLines = (sh.slotsNow ?? []).filter(x => x.slots > 1 || x.note).map(x => `${x.name}: ${x.slots} at once.${x.note ? ` ${x.note}` : ''}`);
    $('#node-slots-now').hidden = !slotLines.length;
    $('#node-slots-now').textContent = slotLines.join(' ');
    $('#node-line').textContent = run.length || wait.length ? `Running: ${run.join('; ') || 'nothing'}. Waiting: ${wait.join('; ') || 'nobody'}.` : "The line for other PCs' work here is empty.";
    if (!homeUi.nodeSaving) {
      $('#node-host-first').checked = sh.hostFirst !== false;
      $('#node-at-once').value = String(sh.atOnce ?? 1);
      if (document.activeElement !== $('#node-cap-answer')) $('#node-cap-answer').value = String(sh.guestCaps?.answer ?? 2000);
      if (document.activeElement !== $('#node-cap-prompt')) $('#node-cap-prompt').value = String(sh.guestCaps?.prompt ?? 32000);
    }
  }
  // Each linked node: whether it holds the latest passes made here (only once there are any).
  const own = sh.passesMade || (sh.passes ?? []).some(x => !x.from) || pcs.some(p => !p.self && p.sync !== 'latest');
  const sync = pcs.filter(p => !p.self);
  const ssig = JSON.stringify([own, sync.map(p => [p.id, p.name, p.sync, p.said])]);
  if (ssig !== homeUi.drawn.passSync) {
    homeUi.drawn.passSync = ssig;
    const words = p => p.sync === 'latest' ? 'has the latest passes'
      : p.sync === 'off' ? `is behind: it ${p.said}`
      : p.sync === 'old' ? `cannot hold passes: it ${p.said}`
      : p.sync === 'refused' ? `is behind: it ${p.said}`
      : `is behind: ${p.said}`;
    $('#node-pass-sync').replaceChildren(...(own && sync.length ? sync.map(p => el('p', { class: `hint${p.sync === 'latest' ? ' ok' : ''}`, text: `${p.name} ${words(p)}.` })) : []));
  }
  // The PCs and their model ticks, drawn again only when the PCs or their models change, so a tick is not lost to the
  // 3-second refresh.
  const fsig = JSON.stringify(pcs.map(p => [p.id, p.name, p.models.map(m => [m.id, m.name])]));
  if (fsig !== homeUi.drawn.passModels) {
    homeUi.drawn.passModels = fsig;
    const ticked = new Set([...document.querySelectorAll('#node-pass-nodes input:checked')].map(t => t.value));
    $('#node-pass-make').disabled = !pcs.length;
    $('#node-pass-nodes').replaceChildren(...(pcs.length ? pcs.map(p => el('div', { class: 'node-pass-pc' },
      el('label', { class: 'check' }, el('input', { type: 'checkbox', value: `pc:${p.id}`, 'data-pc': p.id, checked: ticked.has(`pc:${p.id}`) }), ` ${p.self ? `This PC (${p.name})` : p.name}`),
      el('div', { class: 'node-pass-models' }, ...(p.models.length ? p.models.map(m => el('label', { class: 'check' }, el('input', { type: 'checkbox', value: `m:${p.id}:${m.id}`, 'data-pc-model': p.id, 'data-model': m.id, checked: ticked.has(`m:${p.id}:${m.id}`) }), ` ${m.name}${m.kind === 'image' ? ' (pictures)' : ''}`)) : [el('p', { class: 'hint', text: p.self ? 'No models on this PC yet.' : 'No models there yet, or it has not answered since it was linked.' })]))))
      : [el('p', { class: 'hint', text: 'Turn on "Enable this PC as a node", or link a node under Find other PCs, to make a guest pass for it.' })]));
  }
}

/** A pass just made: its code, shown this once, with Copy and Done. */
function showPassCode(made) {
  const box = $('#node-pass-made');
  const copy = el('button', { class: 'link', type: 'button', text: 'Copy' });
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(made.code);
      copy.textContent = 'Copied';
    } catch {
      copy.textContent = 'Select it and copy';
    }
    setTimeout(() => { copy.textContent = 'Copy'; }, 2000);
  });
  const ends = made.expires ? `It ends ${new Date(made.expires).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}.` : 'It has no end date: remove it when it is no longer needed.';
  box.replaceChildren(
    el('p', { text: `Guest pass for "${made.label}". On that PC: Network, Find other PCs, then type this code as the setup code of any PC the pass is for. It is shown only now: copy it or write it down. ${ends}` }),
    el('div', { class: 'node-code-row' }, el('code', { class: 'node-code', text: made.code }), copy, el('button', { class: 'link', type: 'button', text: 'Done', onclick: () => { box.replaceChildren(); box.hidden = true; delete box.dataset.pass; } })));
  box.dataset.pass = made.id;
  box.hidden = false;
}

$('#node-host-first').addEventListener('change', e => nodeShare({ hostFirst: e.target.checked }));
$('#node-at-once').addEventListener('change', e => nodeShare({ atOnce: Number(e.target.value) }));
for (const id of ['#node-cap-answer', '#node-cap-prompt']) $(id).addEventListener('change', () => nodeShare({ guestCaps: { answer: Number($('#node-cap-answer').value), prompt: Number($('#node-cap-prompt').value) } }));

$('#node-pass-make').addEventListener('click', async () => {
  const said = $('#node-pass-said');
  const label = $('#node-pass-label').value.trim();
  const nodes = [...document.querySelectorAll('#node-pass-nodes input[data-pc]:checked')].map(t => ({
    id: t.dataset.pc,
    models: [...document.querySelectorAll('#node-pass-nodes input[data-pc-model]:checked')].filter(m => m.dataset.pcModel === t.dataset.pc).map(m => m.dataset.model),
  }));
  if (!label) return void (said.textContent = 'Give the pass a name first (whose PC it is for).');
  if (!nodes.length) return void (said.textContent = 'Tick at least one PC the pass is for.');
  if (!nodes.some(n => n.models.length)) return void (said.textContent = 'Tick at least one model the guest may use.');
  said.textContent = '';
  await nodeShare({ passMake: { label, length: $('#node-pass-length').value, nodes } }, r => {
    if (!r?.madePass) return;
    showPassCode(r.madePass);
    $('#node-pass-label').value = '';
    $('#node-pass-new').open = false;
  });
});
// A model ticked ticks its PC too.
$('#node-pass-nodes').addEventListener('change', e => {
  const pc = e.target.dataset?.pcModel;
  if (pc && e.target.checked) {
    const box = document.querySelector(`#node-pass-nodes input[data-pc="${CSS.escape(pc)}"]`);
    if (box) box.checked = true;
  }
});

/**
 * "Sharing permissions": Allow all, Sharing of models, Enable backups, Allow host to update TOMLIN remotely, Allow host
 * to test and change model run settings, Accept models from linked PCs (2.0.61: before, sending a model here needed no tick),
 * Let linked PCs pull TOMLIN updates from here (2.0.61: a linked PC takes this PC's app files to update itself),
 * Allow to be used as part of a cluster (Cluster and a chat's Max mode both borrow with it; on every PC, off until ticked). Each tick is saved
 * at once (with the app lock PIN); a refused or cancelled PIN puts the ticks back as saved at the next refresh.
 */
function drawNodeAllow(sh) {
  const a = sh.allow ?? { pull: false, backup: false, update: false, tune: false, lend: false, receive: false, give: false, off: true };
  if (!homeUi.nodeSaving) {
    for (const t of document.querySelectorAll('#node-setup [data-allow]')) t.checked = a[t.dataset.allow] === true;
    const all = $('#node-allow-all');
    all.checked = a.pull && a.backup && a.update && a.tune && a.receive && a.give && a.lend;
    all.indeterminate = !all.checked && (a.pull || a.backup || a.update || a.tune || a.receive || a.give || a.lend);
    if (sh.lend) $('#node-lend-idle').value = String(sh.lend.idle);
  }
  // Lending (Cluster or Max mode): whom this PC lends its card memory to now, or how the last loan ended.
  const lend = sh.lend;
  const at = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  $('#node-lend-now').hidden = !lend?.to && !lend?.ended;
  $('#node-lend-now').textContent = lend?.to ? `Lending its card memory to "${lend.to}" since ${at(lend.since)}.` : lend?.ended ? `Last lent to "${lend.ended.to}": ended at ${at(lend.ended.at)} (${lend.ended.why}).` : '';
  // Run settings a linked PC changed here since TOMLIN started (newest first).
  const when = t => new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const changes = (sh.runChanges ?? []).slice(0, 3);
  $('#node-run-changes').hidden = !changes.length;
  $('#node-run-changes').textContent = changes.map(c => `Guessing model for ${c.name} set to ${c.draftName || 'none'} by "${c.by}" on ${when(c.at)}.`).join(' ');
  $('#node-restarts').hidden = sh.restarts !== false;
  const up = sh.updated;
  $('#node-updated').hidden = !up;
  $('#node-updated').textContent = up ? `✓ Updated to TOMLIN ${up.version} ${up.pulled ? `from "${up.by}" (taken here)` : `by "${up.by}"`} on ${new Date(up.at).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}.` : '';
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
$('#node-allow-all').addEventListener('change', e => {
  saveAllow({ pull: e.target.checked, backup: e.target.checked, update: e.target.checked, tune: e.target.checked, receive: e.target.checked, give: e.target.checked, lend: e.target.checked });
});
$('#node-lend-idle').addEventListener('change', e => nodeShare({ lendIdle: Number(e.target.value) }));

/** "Models other PCs can use": every model on this PC, in two columns (nothing to tick: linked PCs may use them all). */
function drawNodeShare(sh) {
  // Who is using this PC's models now: busy (answering or drawing for them) or loaded for them.
  const use = sh.inUse ?? [];
  const pcs = u => (u.pcs.length ? u.pcs.map(p => `"${p}"`).join(' and ') : 'a linked PC');
  // Said only while a linked PC uses this PC (nothing when it is idle).
  $('#node-busy').hidden = !use.length;
  $('#node-busy').textContent = use.length
    ? `Busy for linked PCs now: ${use.map(u => `${u.name} ${u.busy ? (u.kind === 'image' ? 'is drawing for' : 'is answering') : 'is loaded for'} ${pcs(u)}`).join('; ')}.${use.some(u => !u.busy) ? ' A model loaded for a linked PC is dropped by itself after 10 minutes unused (a picture model: 10 minutes after its last picture).' : ''}`
    : '';
  $('#node-busy').dataset.busy = use.some(u => u.busy) ? 'yes' : use.length ? 'loaded' : 'no';
  const list = sh.shareable ?? [];
  const sig = JSON.stringify(list);
  if (sig === homeUi.drawn.share) return;
  homeUi.drawn.share = sig;
  const row = m => el('li', {}, el('span', { class: 'share-model-name', text: m.name }), el('span', { class: 'share-model-size', text: `${(m.bytes / 2 ** 30).toFixed(1)} GB` }));
  // Two columns side by side, text LLMs | image LLMs (one under the other on a narrow window). The server lists a model
  // found twice (TOMLIN's folder and the other folder) once.
  const col = (title, ms) => el('div', { class: 'share-col' }, el('h4', { text: title }), ms.length ? el('ul', {}, ...ms.map(row)) : el('p', { class: 'hint', text: 'None on this PC.' }));
  const chat = list.filter(m => m.kind !== 'image');
  const pics = list.filter(m => m.kind === 'image');
  $('#node-share-list').replaceChildren(...(list.length ? [col('Text LLMs', chat), col('Image LLMs', pics)]
    : [el('p', { class: 'hint', text: 'No models on this PC yet. Get one under Models: linked PCs can use it straight away.' })]));
  $('#node-share-line').textContent = list.length ? `${list.length} model${list.length > 1 ? 's' : ''}: linked PCs can hire staff on ${list.length > 1 ? 'any of them' : 'it'}.` : '';
}

// Its own line: the refresh after a change redraws the others, and a refusal must stay readable.
function nodeFault(text) {
  const box = $('#node-fault');
  box.textContent = text ?? '';
  box.hidden = !text;
}

/** Closes of the PIN window made by askAppPin itself, whose close events have not come yet. */
let nodePinClosing = 0;

/**
 * The app lock PIN, asked when a change to this node needs it (F7 E3). `other`: another PC's name, whose own PIN is
 * asked to update it (audit X2); it may be a password there, so the box takes either. Null when Cancel is pressed.
 */
function askAppPin(fault, other, doing) {
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
    // A1: the app lock may be a password: the box and its words follow the kind.
    const kind = doing?.kind ?? (other ? 'password' : app.lockKind?.() ?? 'pin');
    const w = kind === 'password' ? 'password' : 'PIN';
    app.fitSecret?.($('#node-pin-input'), kind);
    $('#node-pin-title').textContent = other ? `Type the app lock PIN of "${other}"` : `Type the app lock ${w}`;
    $('#node-pin-label').textContent = other ? 'PIN (or password)' : kind === 'password' ? 'Password' : 'PIN';
    // The button says what pressing it does: "Change it" read as changing the PIN (3 Nov).
    $('#node-pin-ok').textContent = other ? `Update "${other}"` : 'Apply the change';
    $('#node-pin-about').textContent = other
      ? `Updating another PC needs the PIN (or password) that opens TOMLIN on "${other}", typed here for this update. It is checked there and not kept here, so only someone who knows it can update that PC.`
      : `This PC is a node: every change to it needs the ${w} that opens TOMLIN, so whoever sits at it cannot change it.`;
    // A delete or a removal on another PC names itself (the words above are for an update).
    if (doing?.button) $('#node-pin-ok').textContent = doing.button;
    if (doing?.about) $('#node-pin-about').textContent = doing.about;
    // The host PIN (one for the linked PCs) is asked in the same window, under its own name.
    if (doing?.title) $('#node-pin-title').textContent = doing.title;
    if (doing?.label) $('#node-pin-label').textContent = doing.label;
    // A linked PC that holds this PC's host PIN takes either one in this window (not when it is being given the host PIN).
    const either = $('#node-pin-either');
    either.hidden = true;
    if (other && !doing?.own) api('/api/network/host-pin', { action: 'view' }).then(v => {
      if (!done && dlg.open) {
        either.hidden = !(v.on && v.pcs.some(p => p.has && p.name === other));
        // Either PIN opens it: the title says both (a title another step set, like the host PIN's own, stays).
        if (!either.hidden && !doing?.title) $('#node-pin-title').textContent = `Type the admin PIN, or the "${other}" PIN`;
      }
    }).catch(() => {
      either.hidden = true;
    });
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

/**
 * "Update it" for linked PC `pc` ({ id, name }): a PC that asks its own app lock PIN (audit X2) has it asked here, and
 * again after a wrong one. The update as started, or null when Cancel is pressed.
 */
async function updatePcWithPin(pc, held) {
  // Update all: the host PIN typed once goes first to each PC that holds it (held.hostPin, held.holders). Else the PIN
  // that opened the PC before this one is tried first (never kept past that run), so PCs that share one PIN ask for it
  // once. A PC that refuses either says so and asks for its own.
  let hostPin = held?.hostPin && held.holders?.has(pc.id) ? held.hostPin : undefined;
  let nodePin = hostPin === undefined ? held?.pin : undefined;
  for (;;) {
    try {
      const r = await api('/api/network/update', hostPin !== undefined ? { pc: pc.id, hostPin } : nodePin === undefined ? { pc: pc.id } : { pc: pc.id, nodePin });
      if (held && hostPin === undefined && nodePin !== undefined) held.pin = nodePin;
      return r;
    } catch (e) {
      if (!e.data?.needNodePin) throw e;
      const tried = hostPin !== undefined || nodePin !== undefined;
      hostPin = undefined;
      nodePin = await askAppPin(tried ? e.message : '', pc.name);
      if (nodePin === null) return null;
    }
  }
}

/**
 * The host PIN, asked once for a run over many linked PCs (Update all) and checked on this PC first, so a slip is never
 * sent to every PC as a wrong try. Null on Cancel: each PC is then asked its own PIN, as before.
 */
async function askHostPin(button, about) {
  let fault = '';
  for (;;) {
    const pin = await askAppPin(fault, null, { kind: 'password', title: 'Type the host PIN', label: 'Host PIN (or password)', button, about });
    if (pin === null) return null;
    try {
      await api('/api/network/host-pin', { action: 'check', pin });
      return pin;
    } catch (e) {
      fault = e.message;
    }
  }
}

/**
 * "Turn it off" for linked PC `pc` ({ id, name }): that PC asks its own app lock PIN (as for an update), here and again after
 * a wrong one. The answer, or null when Cancel is pressed. One PC per call: a cluster is turned off by asking each in turn.
 */
async function powerOffWithPin(pc, held) {
  // `held`: a host PIN asked once for several PCs (askHostPin), sent first to each PC that holds it.
  let hostPin = held?.hostPin && held.holders?.has(pc.id) ? held.hostPin : undefined;
  let nodePin;
  for (;;) {
    try {
      return await api('/api/network/power-off', hostPin !== undefined ? { pc: pc.id, hostPin } : nodePin === undefined ? { pc: pc.id } : { pc: pc.id, nodePin });
    } catch (e) {
      if (!e.data?.needNodePin) throw e;
      const tried = hostPin !== undefined || nodePin !== undefined;
      hostPin = undefined;
      nodePin = await askAppPin(tried ? e.message : '', pc.name);
      if (nodePin === null) return null;
    }
  }
}

/** Whether this PC may offer to turn linked PC `p` off: it answers, runs a TOMLIN that can, and its owner's tick is on. */
const canTurnOff = p => p.ok && !p.away && p.can?.includes('power-off') && p.allow?.off === true;

/**
 * The words for a linked PC whose TOMLIN differs from this PC's (p.update when it is behind, p.pull when it is ahead):
 * both versions named, and a button that says which PC changes. `line` has no full stop at the end.
 */
function pcVersionWords(p, behind) {
  const x = behind ? p.update : p.pull;
  const them = `"${p.name}"`;
  const mine = x.other ? `${x.mine}, build ${x.build}` : x.mine;
  const theirs = x.other ? `${p.version}, build ${p.build}` : p.version;
  const line = `This PC runs ${mine}; ${them} runs ${theirs}`;
  const button = behind
    ? (x.other ? `Update ${them} to this PC's files` : `Update ${them} to ${x.mine}`)
    : (x.other ? `Update this PC to ${them}'s files` : `Update this PC to ${p.version}`);
  return { line, button };
}

/**
 * Update this PC from linked PC `pc` ({ id, name, version, build }): said plainly first (the files come from
 * that PC, not from TOMLIN's maker; this PC restarts into them), then started. The pull as started, or null on Cancel.
 */
async function pullWithAsk(pc) {
  const ok = confirm(`Update this PC to TOMLIN ${pc.version}${pc.build ? ` (build ${pc.build})` : ''} from "${pc.name}"?\n\nThe files come from that PC, not from TOMLIN's maker: only the ones that differ are copied, each checked. Then TOMLIN restarts here (about 30 seconds): anything being written or drawn stops. The old version stays beside the new one.`);
  return ok ? api('/api/network/pull', { pc: pc.id }) : null;
}

/** Saves a change to this node (true when it was saved); `onSaved` gets the answer, before the page is drawn again. */
async function nodeShare(body, onSaved) {
  // While this PC is a node, a change needs the app lock PIN: asked when the server says so, again after a wrong one.
  let appPin;
  let saved = false;
  homeUi.nodeSaving = (homeUi.nodeSaving ?? 0) + 1;
  try {
    for (;;) {
      try {
        const reply = await api('/api/share', appPin === undefined ? body : { ...body, appPin });
        nodeFault('');
        saved = true;
        onSaved?.(reply);
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
  homeUi.drawn.paired = homeUi.drawn.passes = homeUi.drawn.passSync = homeUi.drawn.passAsks = null;
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

// ---- The link helper's lines (src/linkhelp.ts): a mark, the words, and the steps under a fault ----
const CHECK_MARK = { ok: '✓', bad: '✗', warn: '!', info: 'i' };
const CHECK_SAID = { ok: 'Fine: ', bad: 'Problem: ', warn: 'Worth a look: ', info: 'Note: ' };
function reachList(lines) {
  return el('ul', { class: 'check-list' }, ...lines.map(l => el('li', { class: `check-${l.state}` },
    el('span', { class: 'check-mark', 'aria-hidden': 'true', text: CHECK_MARK[l.state] ?? '' }),
    el('div', {}, el('span', { class: 'sr-only', text: CHECK_SAID[l.state] ?? '' }), el('span', { text: l.text }),
      l.steps?.length ? el('ol', { class: 'check-steps' }, ...l.steps.map(s => el('li', { text: s }))) : null))));
}

// ---- "Can other PCs reach this one?": this PC's own checklist (2.0.64), and the lines that fix its firewall ----
$('#node-fw-check').addEventListener('click', async () => {
  const line = $('#node-fw-line');
  const btn = $('#node-fw-check');
  btn.disabled = true;
  $('#node-fw-fix').hidden = true;
  $('#node-fw-type').hidden = true;
  $('#node-fw-list').replaceChildren();
  line.textContent = 'Checking (up to a minute)…';
  try {
    const r = await (await fetch('/api/share/reach', { cache: 'no-store' })).json();
    line.textContent = r.ok ? '✓ Nothing on this PC is in the way.' : '✗ Something on this PC is in the way:';
    $('#node-fw-list').replaceChildren(reachList(r.lines));
    if (r.typeThis) {
      $('#node-fw-addr').textContent = r.typeThis;
      $('#node-fw-type').hidden = false;
    }
    if (r.fix) {
      $('#node-fw-code').textContent = r.fix;
      $('#node-fw-code').dataset.run = r.run;
      $('#node-fw-fix').hidden = false;
    }
  } catch (e) {
    line.textContent = `Could not check: ${e.message}`;
  }
  btn.disabled = false;
});
$('#node-fw-addr-copy').addEventListener('click', async e => {
  const b = e.currentTarget;
  try {
    await navigator.clipboard.writeText($('#node-fw-addr').textContent);
    b.textContent = 'Copied';
  } catch {
    b.textContent = 'Select it and copy';
  }
  setTimeout(() => { b.textContent = 'Copy'; }, 2000);
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

/**
 * Just linked: what do you call it? Its own name is offered, or (another linked PC has that name) the computer's own
 * name. Saved as the name this PC shows for it everywhere (its window's Name and photo), so two never share one.
 */
function askPcName(after, pc) {
  after.parentNode?.querySelector('.node-name-ask')?.remove();
  const box = el('input', { type: 'text', maxlength: '40', autocomplete: 'off', value: pc.twin ? pc.computer || '' : pc.name, placeholder: 'for example Study PC, Z820', 'aria-label': 'Name for the PC just linked' });
  const said = el('span', { class: 'hint', 'aria-live': 'polite' });
  const form = el('form', { class: 'node-name-ask' },
    el('label', { class: 'field' }, el('span', { text: pc.twin ? `Another linked PC is called "${pc.twin}". What do you call this one?` : 'What do you call this PC?' }), box),
    el('div', { class: 'team-actions' }, el('button', { class: 'btn primary', type: 'submit', text: 'Save name' }), el('button', { class: 'btn quiet', type: 'button', text: pc.twin ? 'Later' : 'Keep its own name', onclick: () => form.remove() })),
    said);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const name = box.value.trim();
    if (!name) return box.focus();
    try {
      await api('/api/pc/profile', { id: pc.id, name });
      await app.loadFaces?.();
      form.replaceWith(el('span', { class: 'hint ok', text: `✓ Shown as "${name}"` }));
      refreshPcs();
    } catch (err) {
      said.textContent = err.message;
    }
  });
  after.after(form);
  if (pc.twin) box.focus();
}

/** Links a PC: true when linked; otherwise the fault is shown, and `needPin` says the PC asks for a link PIN. */
async function linkPc(url, code, pin, fault, needPin) {
  fault.textContent = 'Linking…';
  try {
    const r = await api('/api/remotes', { action: 'add', url, code, pin });
    // The other PC told which code it was: its setup code links as its admin, a guest pass as a guest.
    const as = r?.linked?.role === 'guest' ? `Linked as a guest${r.linked.expires ? `, until ${new Date(r.linked.expires).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}. You can use the models its host picked for you; its owner can see what runs there.` : 'Linked as its admin.';
    fault.textContent = r?.sameName ? `${as} ${r.sameName}` : as;
    if (r?.linked) askPcName(fault, r.linked);
    if (r?.linked?.pull) void pullFromGuest(r.linked, fault);
    refreshOthers();
    refreshPcs();
    return true;
  } catch (e) {
    fault.textContent = e.message;
    if (e.data?.needPin || /link PIN, shown|A link PIN is 6 digits/.test(e.message)) needPin?.();
    // Nothing answered there: the link helper opens with the address, to test it from here (2.0.64).
    if (e.data?.help) openLinkHelp(String(url).replace(/^http:\/\//, ''));
    return false;
  }
}

/**
 * Just linked as a guest to a PC with a newer TOMLIN: offered at once, said plainly (never an older one). When this PC
 * is also linked to its own PCs as their admin, the question says this is the guest network's version, not theirs.
 */
async function pullFromGuest(pc, fault) {
  const words = `"${pc.name}" runs TOMLIN ${pc.pull.version}, newer than this PC. Update this PC from it now?\n\nYou are a guest there: the files come from that PC, not from TOMLIN's maker or your own PCs.${pc.pull.choose ? ' This PC is also linked to your own PCs as their admin: say yes only if you want this guest network\'s version.' : ''} TOMLIN restarts here (about 30 seconds); the old version stays beside the new one.`;
  if (!confirm(words)) return;
  try {
    await api('/api/network/pull', { pc: pc.id, guestOk: true });
    fault.textContent = `Updating this PC from "${pc.name}"…`;
  } catch (e) {
    fault.textContent = e.message;
  }
}

/**
 * Asking the host for more time on a guest pass that expired there: a few plain words (200 characters at most), one
 * request at a time. What became of the last one: sent and waiting (kept here while that PC is off), denied with the
 * host's reason, or not taken at all.
 */
function passAskBox(f) {
  const said = el('p', { class: 'hint', role: 'status' });
  const ask = f.ask;
  if (ask?.state === 'waiting') said.textContent = ask.held ? 'Sent, waiting: that PC is not answering now, so the request is kept here and sent when it is back.' : 'Sent, waiting for the host to answer.';
  else if (ask?.state === 'denied') said.textContent = `The host said no${ask.reason ? `: "${ask.reason}"` : '.'}`;
  else if (ask?.state === 'blocked' || (!f.canAsk && !ask)) said.textContent = 'The host does not take requests from this PC.';
  if (!f.canAsk) return el('div', { class: 'pass-ask' }, said);
  const text = el('textarea', { rows: '2', maxlength: '200', 'aria-label': `Message to the host of ${f.name}`, placeholder: 'Hi, it is me: may I have a few more days?' });
  const field = el('label', { class: 'field' }, el('span', { text: 'Message to the host (200 characters at most)' }), text);
  const send = el('button', { class: 'btn primary', type: 'button', text: 'Ask the host' });
  send.addEventListener('click', async () => {
    if (!text.value.trim()) return void (said.textContent = 'Write a few words for the host first.');
    send.disabled = true;
    try {
      const r = await api('/api/remotes', { action: 'pass-ask', id: f.id, text: text.value });
      said.textContent = r.held ? 'Sent, waiting: that PC is not answering now, so the request is kept here and sent when it is back.' : 'Sent, waiting for the host to answer.';
      field.remove();
      send.remove();
    } catch (e) {
      said.textContent = e.message;
      send.disabled = false;
    }
  });
  return el('div', { class: 'pass-ask' }, field, el('div', { class: 'team-actions' }, send), said);
}

// ---- The link helper (2.0.64): tests the other PC from here and says what is in the way (src/linkhelp.ts) ----

/** Opens the helper, with the address carried over when one was typed or found. */
function openLinkHelp(address) {
  if (address && !$('#link-help-addr').value) $('#link-help-addr').value = address;
  $('#link-help').open = true;
}
$('#link-help-check').addEventListener('click', async () => {
  const btn = $('#link-help-check');
  const out = $('#link-help-out');
  btn.disabled = true;
  out.replaceChildren(el('p', { class: 'hint', role: 'status', text: 'Testing from here (up to half a minute)…' }));
  const on = document.querySelector('input[name="link-help-on"]:checked')?.value;
  try {
    const r = await api('/api/remotes', { action: 'diagnose', nodeOn: on === 'yes' ? true : on === 'no' ? false : null, address: $('#link-help-addr').value, name: $('#link-help-name').value, port: Number($('#node-scan-port').value) || 8741 });
    out.replaceChildren(
      el('p', { class: r.state === 'ok' ? 'hint ok' : 'fault-line', role: 'status', text: `${r.state === 'ok' ? '✓' : '✗'} ${r.title}` }),
      r.steps.length ? el('ol', { class: 'check-steps' }, ...r.steps.map(s => el('li', { text: s }))) : '',
      r.lines.length ? reachList(r.lines) : '');
    // Found and answering: its address goes to the link form, which only needs the setup code now.
    if (r.state === 'ok' && $('#link-help-addr').value && !$('#node-addr').value) $('#node-addr').value = $('#link-help-addr').value;
  } catch (e) {
    out.replaceChildren(el('p', { class: 'fault-line', role: 'alert', text: e.message }));
  }
  btn.disabled = false;
});

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
      : `None found.${looked} On the other PC, press Check under "Can other PCs reach this one?": it names what is in the way there. The Link helper below tests it from here.`;
    if (!found.length) openLinkHelp();
    box.replaceChildren(...found.map(f => {
      const code = el('input', { type: 'text', maxlength: '9', autocomplete: 'off', placeholder: 'ABCD-EFGH', required: '', 'data-setup-code': '', 'aria-label': `Setup code of ${f.name}, or a guest pass code` });
      // The link PIN box shows when that PC asks for one: at the scan, or when linking says so (turned on since).
      const pin = el('input', { type: 'text', inputmode: 'numeric', maxlength: '6', autocomplete: 'off', placeholder: '6 digits', 'aria-label': `Link PIN of ${f.name}` });
      const pinBox = el('label', { class: 'field', hidden: !f.pin }, el('span', { text: 'Its link PIN, only with its setup code (shown on that PC; never its app lock PIN). A guest pass needs none.' }), pin);
      // A guest pass code needs no PIN: the box is not required, and is left empty for one.
      pin.required = false;
      pin.required = !!f.pin;
      const fault = el('span', { class: 'hint', 'aria-live': 'polite' });
      const form = el('form', { class: 'node-link-form' },
        el('label', { class: 'field' }, el('span', { text: 'Its setup code (to link as its admin) or a guest pass code' }), code),
        pinBox,
        el('button', { class: 'btn primary', type: 'submit', text: f.linked ? 'Link again' : 'Link' }));
      form.addEventListener('submit', async e => {
        e.preventDefault();
        const ok = await linkPc(f.url, code.value, pinBox.hidden ? '' : pin.value, fault, () => { pinBox.hidden = false; pin.required = true; pin.focus(); });
        if (ok) form.replaceWith(el('span', { class: 'hint ok', text: '✓ Linked' }));
      });
      // Linked before: the link may have broken since (the other PC removed it, or was set up again), so it can be linked
      // again. A saved link known not to work says so, with the setup code box open.
      if (f.linked && !f.broken && f.state !== 'new') form.hidden = true;
      const again = f.linked && !f.broken ? el('button', { class: 'link', type: 'button', text: 'Not working? Link it again', onclick: e => { form.hidden = false; e.target.remove(); code.focus(); } }) : null;
      // What this PC is there, in one line: its admin, a guest (until when), a guest whose pass expired, or nothing yet.
      return el('article', { class: 'node-card' },
        el('div', { class: 'node-head' }, el('strong', { text: f.name }), el('span', { class: 'hint', text: f.url.replace('http://', '') })),
        f.broken ? el('span', { class: 'hint', text: 'Linked before, but that link no longer works. Type its setup code (shown on that PC under Network) and press Link again.' })
          : el('span', { class: `hint${f.state === 'admin' || f.state === 'guest' ? ' ok' : ''}`, text: f.stateText ?? (f.linked ? 'You are already connected (admin)' : 'Network found: enter the code') }),
        f.state === 'expired' ? passAskBox(f) : null,
        f.state === 'new' ? null : again,
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
/** The Cluster page (Settings, the Cluster card above My PC, and Network's Cluster part). */
app.openCluster = () => {
  setView('cluster');
  drawCluster(homeUi.others ?? [], homeUi.cluster ?? { on: false, members: [] });
  refreshOthers();
};
for (const b of document.querySelectorAll('[data-cluster-open]')) b.addEventListener('click', () => app.openCluster());
/** Manage updates: a page of its own (Settings, and the My PC window's Update TOMLIN). */
app.openUpdateInstall = () => {
  setView('updates');
  drawInstall();
};

/**
 * Update this install inside Manage PC and updates (the My PC window): the Updates page's own section (Check for updates, Check
 * zip, the download bar, Update now) is moved into `host` while the window is open, so an update never leaves the window
 * and there is no page to lose. `updateInstallBack` puts it where it was (called when the window closes).
 */
let updateHome = null;
app.updateInstallInto = async host => {
  const sec = $('#node-install');
  if (!sec) return;
  if (!updateHome) updateHome = { parent: sec.parentNode, next: sec.nextSibling };
  host.replaceChildren(sec);
  await drawInstall();
};
app.updateInstallBack = () => {
  const sec = $('#node-install');
  if (!updateHome || !sec) return;
  updateHome.parent.insertBefore(sec, updateHome.next && updateHome.next.parentNode === updateHome.parent ? updateHome.next : null);
  updateHome = null;
};

function drawOthers(pcs) {
  homeUi.others = pcs;
  drawUpdateAll(pcs);
  drawCluster(pcs, homeUi.cluster ?? { on: false, members: [] });
  keepFocus($('#node-others'), pcs.length ? pcs.map(p => {
    const mem = p.ok && p.memory?.ram?.bar;
    const away = p.ok && p.away ? new Date(p.away).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null;
    // A PC this one is a guest on says so, and when its pass ended (asked for more under Find PCs on my network).
    const guestEnd = p.role === 'guest' && p.passEnd ? (p.passEnd.state === 'expired' ? 'Guest: the pass ended. Ask the host for more time: press Find PCs on my network above.' : 'Guest: that PC no longer lets this one in.') : null;
    const asGuest = p.role === 'guest' ? ` (guest${p.expires ? `, until ${new Date(p.expires).toLocaleDateString()}` : ''}${p.caps ? `; answers up to ${p.caps.answer} tokens, prompts up to ${p.caps.prompt} characters` : ''})` : '';
    const inLine = p.ok && p.line && (p.line.running || p.line.waiting) ? ` Line there: ${p.line.running} running, ${p.line.waiting} waiting.` : '';
    const state = guestEnd ?? (away ? `Logged off since ${away}: "I need to log off for now"` : p.ok ? `${p.backupsOnly ? 'Keeps backups' : p.model ? `On: ${p.model}` : 'Asleep: no model loaded'}${asGuest}${inLine}` : p.relink || p.answered ? `Not linked any more: ${p.error} Find it again above, then Link again.` : 'Off: not answering');
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
    } }), ' Backups only');
    role.title = 'Ticked: no staff, chats, jobs or pictures run on this PC, and no model is copied to it. It is first in line for project backups.';
    // Cluster and Max mode: that PC's own "Allow to be used as part of a cluster" tick is the permission; this tick only opts out.
    const lends = p.ok && p.allow?.lend === true;
    const borrow = el('label', { class: 'node-role' }, el('input', { type: 'checkbox', checked: p.noBorrow === true, disabled: p.backupsOnly === true, 'data-key': `no-borrow:${p.id}`, onchange: async e => {
      const off = e.target.checked;
      e.target.disabled = true;
      const box = $('#node-others-ask');
      try {
        await api('/api/remotes', { action: 'borrow-max', id: p.id, on: !off });
        sayHere(box, off ? `Models loaded on this PC no longer borrow from "${p.name}", even though it allows it.` : `Models too big for this PC alone borrow the card and RAM of "${p.name}" again, while it allows it.`);
      } catch (err) {
        sayHere(box, `Don't borrow from it was not changed: ${err.message}`);
      }
      refreshOthers();
    } }), " Don't borrow from it");
    borrow.title = 'Ticked: chat models loaded on this PC never use the card and RAM of that PC. Unticked (the usual): a model too big for this PC alone borrows them whenever that PC allows it.';
    const lendLine = !p.ok || p.backupsOnly ? null : el('span', { class: 'hint', text: p.heldByCluster ? 'In the cluster, which is on: held for models too big for this PC. No staff, chats or pictures go to it until the cluster is switched off (Cluster, above).' : lends
      ? (p.noBorrow ? "Cluster: it allows this PC to borrow its card and RAM, but Don't borrow from it is ticked here." : 'Cluster: it allows this PC to borrow its card and RAM for models too big for this PC alone. Nothing to tick here.')
      : 'Cluster: not allowed there. To borrow its card and RAM, tick Allow to be used as part of a cluster on that PC (Network, Sharing and cluster permissions).' });
    const disk = !p.ok ? null : p.disk
      ? el('span', { class: 'node-disk', title: `Backup disk: ${diskWords(p.disk)}`, text: `Disk: ${diskUsed(p.disk)}` })
      : el('span', { class: 'node-disk hint', title: 'That PC runs an older TOMLIN: update it to see its free space here.', text: 'Disk: not reported' });
    return el('article', { class: `node-card${p.heldByCluster ? ' pc-held' : ''}` },
      el('div', { class: 'node-head' },
        el('span', { class: 'sdot', 'data-state': p.ok && !away ? (p.model ? 'on' : 'asleep') : 'off', 'aria-hidden': 'true' }),
        el('strong', { text: p.name }),
        el('span', { class: 'hint', text: `${p.url} · ${state}` })),
      // Behind this PC (a lower version, or the same one with different files): "Update it" sends this PC's TOMLIN there
      // (it starts the new version by itself), or why not.
      p.ok && p.update ? el('div', { class: 'node-update' },
        el('span', { class: 'hint', text: `${pcVersionWords(p, true).line}.${p.update.why ? ` ${p.update.why.charAt(0).toUpperCase()}${p.update.why.slice(1)}.` : ''}` }),
        p.update.why ? null : el('button', { class: 'btn primary', type: 'button', text: pcVersionWords(p, true).button, 'data-key': `update:${p.id}`, onclick: async e => {
          e.target.disabled = true;
          try {
            const r = await updatePcWithPin(p);
            if (!r) {
              e.target.disabled = false;
              return;
            }
            app.openUpdate(r.transfer);
          } catch (err) {
            sayHere($('#node-others-ask'), err.message);
            e.target.disabled = false;
          }
        } })) : null,
      // Ahead of this PC (a newer version, or the same one with different files): "Update this PC from it" takes its
      // TOMLIN here (no PIN there: nothing changes on that PC), or why not.
      p.ok && p.pull ? el('div', { class: 'node-update' },
        el('span', { class: 'hint', text: `${pcVersionWords(p, false).line}.${p.pull.why ? ` ${p.pull.why.charAt(0).toUpperCase()}${p.pull.why.slice(1)}.` : ''}` }),
        p.pull.why ? null : el('button', { class: 'btn primary', type: 'button', text: pcVersionWords(p, false).button, 'data-key': `pull:${p.id}`, onclick: async e => {
          e.target.disabled = true;
          try {
            const r = await pullWithAsk(p);
            if (!r) {
              e.target.disabled = false;
              return;
            }
            app.openUpdate(r.transfer);
          } catch (err) {
            sayHere($('#node-others-ask'), err.message);
            e.target.disabled = false;
          }
        } })) : null,
      // Turn it off: one PC at a time, its owner's tick (on unless unticked) and its app lock PIN asked here.
      p.ok && p.can?.includes('power-off') ? el('div', { class: 'node-update' },
        canTurnOff(p) ? el('button', { class: 'btn', type: 'button', text: `Turn off "${p.name}"`, 'data-key': `poweroff:${p.id}`, title: 'Shuts that PC down. It asks for its app lock PIN, and stays off until someone switches it on again.', onclick: async e => {
          if (!confirm(`Turn off "${p.name}"?

It shuts down about 15 seconds after it answers, and stays off until someone switches it on again. Anything it is doing for you stops.`)) return;
          e.target.disabled = true;
          try {
            const r = await powerOffWithPin(p);
            sayHere($('#node-others-ask'), r ? `${r.said}` : 'Not turned off (no PIN given).');
          } catch (err) {
            sayHere($('#node-others-ask'), err.message);
          }
          e.target.disabled = false;
          refreshPcs();
        } }) : el('span', { class: 'hint', text: p.allow?.off === true ? '' : `Turning it off from here is not allowed there: its owner ticks "Allow host to turn this PC off" (Network, sharing permissions).` })) : null,
      mem ? memLine(p.memory.ram.bar, 'Memory (RAM)') : null,
      mem && p.memory.gpu ? memLine(p.memory.gpu.bar, `Graphics card (${p.memory.gpu.name.replace(/^NVIDIA\s+(GeForce\s+)?/i, '')})`) : null,
      el('div', { class: 'node-role-row' }, role, borrow, disk),
      lendLine,
      p.backupsOnly ? el('span', { class: 'hint', text: 'Keeps backups only: no staff, chats, jobs or pictures run here, and no model is copied to it. First in line for project backups.' }) : null,
      p.ok && !mem ? el('span', { class: 'hint', text: `Its memory is not reported: that PC runs TOMLIN ${p.version || 'older than 2.0.16'}. Update it to see its memory here.` }) : null,
      // The models it lets this PC use by name (hire staff on them here).
      // One model a line, chat models under Standard and picture models under Images.
      p.ok && !away && !p.backupsOnly ? (!p.can?.includes('models') ? el('span', { class: 'hint', text: 'Lets this PC use: only the model it has loaded (its TOMLIN is older: update it there to share models by name).' })
        : p.models?.length ? el('div', { class: 'node-uses' },
          el('span', { class: 'hint', text: 'Lets this PC use:' }),
          ...[['Standard', p.models.filter(m => m.kind !== 'image')], ['Images', p.models.filter(m => m.kind === 'image')]].filter(([, list]) => list.length).map(([head, list]) => el('div', { class: 'node-uses-group' },
            el('h4', { text: head }),
            el('ul', {}, ...list.map(m => {
              const bit = m.busy ? (m.kind === 'image' ? 'busy: drawing for someone now' : 'busy: answering someone now') : m.loaded ? 'loaded' : '';
              return el('li', {}, `${m.name}${bit ? ` (${bit})` : ''}`, m.kind !== 'image' && m.guessers?.length ? guessPick(p, m) : null,
                m.kind !== 'image' && p.can?.includes('tune') ? el('div', { class: 'guess-pick' }, app.finderButton(`remote:${p.id}:${m.id}`, { name: m.name, pcName: p.name, link: true })) : null);
            })))),
          p.models.some(m => m.guessers?.length) && !p.allow?.tune ? el('span', { class: 'hint', text: `To pick a Guessing model from here, "${p.name}" ticks "Allow host to test and change model run settings" there first (Network, Sharing permissions).` }) : null,
          el('div', { class: 'team-actions' }, el('button', { class: 'btn', type: 'button', text: 'Hire staff on it', 'data-key': `hire:${p.id}`, title: `Opens Hire staff with ${p.name} picked: then choose one of its models`, onclick: () => app.openHire?.({ pc: p.id }) })))
        : el('span', { class: 'hint', text: 'Lets this PC use: no models yet, as that PC has none. Send one there from Models.' })) : null,
      // How fast its loaded model answers for this PC (its answers here are timed; Test speed runs the example prompt there).
      p.ok && p.model && !away && !p.backupsOnly ? el('span', { class: 'hint' }, p.speed?.expect ? `Speed: ${app.speedWords(p.speed.expect)} (${p.speed.basis === 'answers' ? `the average of ${p.speed.average.n} answers` : 'tested'}) · ` : 'Speed: not measured yet · ', app.speedLink(`remote:${p.id}`, msg => sayHere($('#node-others-ask'), msg), refreshOthers)) : null,
      // Lets go of the models it loaded for linked PCs now (not after its idle minutes), so another can load there. It never
      // cuts one answering or drawing, nor one its own owner loaded; it needs the owner's tick, and says why not in its words.
      el('div', { class: 'team-actions' }, back, p.ok && !away && !p.backupsOnly && p.can?.includes('tune') && (p.model || p.image?.model || p.models?.some(m => m.loaded)) ? el('button', { class: 'btn', type: 'button', text: 'Free its memory', 'data-key': `free:${p.id}`, title: `Lets "${p.name}" unload the models it loaded for linked PCs, now, so another model can load there. One answering or drawing is left to finish.`, onclick: async e => {
        const box = $('#node-others-ask');
        e.target.disabled = true;
        try {
          sayHere(box, (await api('/api/network/free', { pc: p.id })).said);
        } catch (err) {
          sayHere(box, err.message);
        }
        e.target.disabled = false;
        refreshOthers();
      } }) : null, el('button', { class: 'link', type: 'button', text: 'Remove', onclick: async () => {
        const box = $('#node-others-ask');
        try {
          const { hires } = await api('/api/remotes', { action: 'on-it', id: p.id });
          const again = 'To use it again you will need its setup code.';
          // With hires on it there is something to keep or forget; with none, stopping is all there is.
          const choice = hires.length
            ? await askPick(box, `Stop using "${p.name}"? ${listNames(hires)} ${hires.length > 1 ? 'work' : 'works'} on it, and would move to their second model, or have none until you pick one. Release for now puts them back on it when you link it again; Remove for good does not. ${again}`, [{ label: 'Release for now', value: 'release' }, { label: 'Remove for good', value: 'good', danger: true }], 'Keep it linked')
            : (await askHere(box, `Stop using "${p.name}"? ${again}`, `Stop using ${p.name}`, 'Keep it linked')) && 'good';
          if (!choice) return;
          await api('/api/remotes', { action: 'remove', id: p.id, ...(choice === 'good' ? { forGood: true } : {}) });
        } catch (err) {
          sayHere(box, err.message);
        }
        refreshOthers();
        refreshPcs();
      } })));
  }) : [el('p', { class: 'hint', text: 'No other PCs linked yet.' })]);
}

/**
 * A linked PC's chat model: its Guessing model (a smaller model of the same family on that PC guesses the next few
 * words, the model checks them; the answer is its own). Picked here, kept in that PC's own settings; that PC says why
 * not when its owner has not ticked it.
 */
function guessPick(p, m) {
  const name = id => p.models.find(x => x.id === id)?.name ?? id;
  const sel = el('select', { 'data-key': `guess:${p.id}:${m.id}`, 'aria-label': `Guessing model for ${m.name} on ${p.name}`, title: "A smaller model of the same family on that PC guesses the next few words and this model checks them: the answer is this model's own, only the speed changes. It takes memory of its own there." },
    el('option', { value: '', text: 'None', selected: !m.draft }),
    ...m.guessers.map(id => el('option', { value: id, text: name(id), selected: id === m.draft })));
  sel.addEventListener('change', async () => {
    const box = $('#node-others-ask');
    sel.disabled = true;
    try {
      sayHere(box, (await api('/api/network/run-set', { pc: p.id, model: m.id, draft: sel.value })).said);
    } catch (err) {
      sel.value = m.guessers.includes(m.draft) ? m.draft : '';
      sayHere(box, err.message);
    }
    sel.disabled = false;
    refreshOthers();
  });
  return el('label', { class: 'guess-pick' }, 'Guessing model', sel);
}

async function refreshNodes() {
  // One answer draws both pages: this PC as a node (Network) and the models on this PC (This PC).
  if (homeUi.view !== 'nodes' && homeUi.view !== 'thispc') return;
  try {
    drawNodes(await api('/api/nodes'));
  } catch {
    // The top bar says when the server is not answering.
  }
}
async function refreshOthers() {
  if (homeUi.view !== 'nodes' && homeUi.view !== 'cluster') return;
  try {
    const got = await api('/api/nodes/others');
    homeUi.cluster = got.cluster ?? homeUi.cluster;
    drawOthers(got.pcs);
  } catch {
    drawOthers([]);
  }
}
/** "Its settings" in a PC's window: Network (this PC as a node, or the linked PCs). */
app.pcMore = id => (id === 'here' ? openNodes() : app.openPcs());

function openNodes() {
  setView('nodes');
  homeUi.drawn.models = homeUi.drawn.team = homeUi.drawn.paired = homeUi.drawn.passes = homeUi.drawn.passModels = homeUi.drawn.passSync = homeUi.drawn.passAsks = null;
  refreshNodes();
  refreshOthers();
}
/** This PC: the models on it, the same list as in this PC's window (under Settings). */
function openThisPc() {
  setView('thispc');
  homeUi.drawn.models = homeUi.drawn.team = null;
  refreshNodes();
  app.pcModelsInto?.($('#node-models'), $('#node-models-ask'));
}
app.openThisPc = openThisPc;
/**
 * Sharing and cluster permissions, opened from Network, This PC, and Manage PC and updates: the one set of ticks (under
 * Setup on Network, one set of elements, one handler), opened at their place.
 */
// Its own name: mute.js loads later and gives app.openPermissions to the Permissions page (what a chat's model may do),
// so under that name these three buttons opened that page, not the ticks.
app.openSharePermissions = async () => {
  openNodes();
  // Drawn from the server's answer first, so the ticks are found where they are now (not where the last draw left them).
  await refreshNodes();
  const off = !!$('#node-allow').closest('[hidden]');
  // The ticks sit under Setup, shown only while this PC is a node: said, beside the tick that shows them.
  const why = $('#node-allow-why');
  why.hidden = !off;
  why.textContent = off ? 'The sharing and cluster permissions are under Setup, which shows once "Enable this PC as a node" is turned on. Turn it on to set them.' : '';
  const at = off ? $('#node-on') : $('#node-allow');
  at.scrollIntoView({ block: 'start' });
  (at.querySelector('input') ?? at).focus({ preventScroll: true });
};
for (const b of document.querySelectorAll('[data-perms-open]')) b.addEventListener('click', () => app.openSharePermissions());

// ---- Update this install: Check for updates (the newest signed release on GitHub) or Update via zip (a zip uploaded here) becomes
// this PC's next copy; then the linked PCs from here ----

async function drawInstall() {
  const v = await api('/api/install/zip').catch(() => null);
  if (!v) return;
  // A copy started another way (node src/server.ts) cannot start the new one: said, and neither way is offered.
  $('#node-install-pick').hidden = !v.restarts;
  $('#node-install-git').hidden = !v.restarts || !v.repo;
  // The explanation names the Check for updates and Update via zip buttons: not shown when they are not (a copy started by npm start).
  $('#node-install-help').hidden = !v.restarts;
  $('#node-install-hand-zip').hidden = !v.restarts;
  if (v.repo) $('#node-install-releases').href = `https://github.com/${v.repo}/releases`;
  // A download from git still going (the page was left and opened again): followed again.
  if (v.git && ['downloading', 'checking', 'opening'].includes(v.git.state) && !gitFollowing) followGit();
  $('#node-install-line').textContent = `This PC runs TOMLIN ${v.version}${v.build ? ` (build ${v.build})` : ''}.${v.restarts ? '' : ' It was not started by its installed program or Start TOMLIN.cmd, so it cannot update itself from a zip here: close it, unzip the new version and run Install TOMLIN.cmd there.'}`;
  if (v.ready && $('#node-install-ask').hidden) askInstall(v.ready, v.version);
}

/**
 * A zip that is not signed by TOMLIN's maker: the warning, with Cancel as the default (it has the focus, so Enter
 * presses it) and Install anyway set apart from it. True = Install anyway.
 */
function askUnsigned(box, z, mine, what) {
  return new Promise(done => {
    const end = ok => {
      box.replaceChildren();
      box.hidden = true;
      done(ok);
    };
    const cancel = el('button', { class: 'btn primary', type: 'button', text: 'Cancel', onclick: () => end(false) });
    app.askFor?.(box, () => end(false));
    box.classList.add('page-ask');
    box.setAttribute('role', 'alert');
    box.replaceChildren(
      el('span', {}, el('b', { class: 'fault-line', text: `Warning: this zip is not signed by TOMLIN's maker. ${z.warning}` }), ` It holds TOMLIN ${z.version}; this PC runs ${mine}. Install it only if you trust where it came from, for example a zip you made yourself. ${what}`),
      cancel,
      el('button', { class: 'btn danger install-anyway', type: 'button', text: 'Install anyway', onclick: () => end(true) }),
    );
    box.hidden = false;
    cancel.focus();
  });
}

/**
 * The zip is checked: Update now (it is started once as a test, then this copy ends and the new one starts), or Cancel
 * (the opened copy is removed). Not signed by TOMLIN's maker (a zip picked by hand): a warning, and Install anyway.
 */
async function askInstall(z, mine) {
  const box = $('#node-install-ask');
  const same = z.version === mine;
  const what = button => `${button} tests it, then restarts TOMLIN as ${z.version} (about 30 seconds): anything being written or drawn stops. The old copy stays beside the new one.`;
  const go = z.signed === false
    ? await askUnsigned(box, z, mine, what('Install anyway'))
    : await askHere(box, `TOMLIN ${z.version}${z.build ? ` (build ${z.build})` : ''}${same ? ', the same version with other files' : ''}: signed by TOMLIN and checked. This PC runs ${mine}. ${what('Update now')}`, 'Update now', 'Cancel', false);
  if (!go) {
    await api('/api/install/zip-drop', {}).catch(() => undefined);
    return;
  }
  installSaid(`Starting TOMLIN ${z.version} once as a test (up to a minute and a half)…`, 1);
  try {
    const r = await api('/api/install/zip-go', { version: z.version, anyway: z.signed === false });
    installSaid(`TOMLIN ${r.version} passed its test start and is starting (${r.folder}). This page opens again by itself when it answers.`, 1);
    waitForVersion(r.version);
  } catch (e) {
    installSaid('');
    sayHere(box, `Not updated: ${e.message}`);
  }
}

function installSaid(text, frac) {
  $('#node-install-progress').hidden = !text;
  $('#node-install-said').textContent = text ?? '';
  $('#node-install-fill').style.width = `${Math.round(Math.min(1, frac ?? 0) * 100)}%`;
}

/** Asks every 2 seconds until this PC answers with the new version (or 3 minutes pass), then opens the page again. */
async function waitForVersion(version) {
  for (const t0 = Date.now(); Date.now() - t0 < 180_000;) {
    await new Promise(r => setTimeout(r, 2000));
    const v = await fetch('/api/install/zip', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null), () => null);
    if (v?.version === version) return location.reload();
  }
  installSaid(`TOMLIN ${version} has not answered for 3 minutes. Look at its window by the clock (or the Start TOMLIN window): it says what happened.`, 1);
}

// ---- Check for updates ----

/** A download's size: "180 MB" under a gigabyte, "1.2 GB" over. */
const dlSize = n => (n < 2 ** 30 ? `${Math.max(1, Math.round(n / 2 ** 20))} MB` : gb(n));
const gitBox = () => $('#node-install-git-box');
function gitSay(...kids) {
  gitBox().hidden = !kids.length;
  gitBox().replaceChildren(...kids);
}
/**
 * Check for updates, pressed (`btn`): GitHub's newest TOMLIN, said through `say(...nodes)`, with a Download button when it is
 * newer than this PC (`download(version, button)` takes it). One function for both places it is pressed: Update this
 * install on Manage updates (2.0.63).
 */
async function checkGit(btn, say, download) {
  btn.disabled = true;
  say(el('p', { class: 'hint', role: 'status', text: 'Asking GitHub for the newest TOMLIN…' }));
  try {
    const r = await api('/api/install/git-check', {});
    const when = r.published ? ` (${new Date(r.published).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })})` : '';
    if (!r.newer) say(el('p', { class: 'hint', role: 'status', text: `This PC runs the newest TOMLIN on GitHub: ${r.mine}${r.version !== r.mine ? ` (GitHub's newest is ${r.version})` : ''}.` }));
    else {
      say(el('p', { class: 'hint', role: 'status', text: `TOMLIN ${r.version} is on GitHub${when}${r.bytes ? `, a ${dlSize(r.bytes)} download` : ''}. This PC runs ${r.mine}.${r.notes ? ` ${r.notes}` : ''}` }),
        el('div', { class: 'team-actions' }, el('button', { class: 'btn primary', type: 'button', text: `Download ${r.version}`, onclick: ev => download(r.version, ev.currentTarget) })));
    }
  } catch (err) {
    say(el('p', { class: 'fault-line', role: 'alert', text: err.message }));
  } finally {
    btn.disabled = false;
  }
}
$('#node-install-git').addEventListener('click', e => {
  $('#node-install-ask').hidden = true;
  checkGit(e.currentTarget, gitSay, getGit);
});

async function getGit(version, button) {
  button.disabled = true;
  try {
    await api('/api/install/git-get', { version });
  } catch (err) {
    button.disabled = false;
    return gitSay(el('p', { class: 'fault-line', role: 'alert', text: err.message }));
  }
  gitSay();
  followGit();
}
/** The download from git, asked every second: its progress on the bar, then Update now, or why it stopped. */
let gitFollowing = false;
async function followGit() {
  gitFollowing = true;
  $('#node-install-git').disabled = true;
  $('#node-install-pick').classList.add('is-busy');
  try {
    for (;;) {
      const v = await api('/api/install/zip').catch(() => null);
      const g = v?.git;
      if (!g) return installSaid('');
      if (g.state === 'downloading') installSaid(`Downloading TOMLIN ${g.version} from GitHub${g.bytes ? `: ${Math.round((g.got / g.bytes) * 100)}% of ${dlSize(g.bytes)}` : `: ${dlSize(g.got)}`}`, g.bytes ? g.got / g.bytes : 0);
      else if (g.state === 'checking') installSaid(`Checking TOMLIN ${g.version}'s signature…`, 1);
      else if (g.state === 'opening') installSaid('Opening the zip and checking every part…', 1);
      else if (g.state === 'ready') {
        installSaid('');
        if (v.ready) askInstall(v.ready, v.version);
        return;
      } else {
        installSaid('');
        return gitSay(el('p', { class: 'fault-line', role: 'alert', text: g.error }));
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  } finally {
    gitFollowing = false;
    $('#node-install-git').disabled = false;
    $('#node-install-pick').classList.remove('is-busy');
  }
}

/** The .sig file's text as the header carries it (base64); '!' for one that is not a signature file (it checks as one TOMLIN does not make). */
async function sigHeader(sig) {
  if (sig.size > 64 * 1024) return '!';
  try {
    return btoa(await sig.text());
  } catch {
    return '!';
  }
}

$('#node-install-file').addEventListener('change', async e => {
  // The zip, and its signature (tomlin-<version>.zip.sig) when it was picked with it.
  const files = [...(e.target.files ?? [])];
  e.target.value = '';
  if (!files.length) return;
  const box = $('#node-install-ask');
  box.hidden = true;
  gitSay();
  const file = files.find(f => /\.zip$/i.test(f.name));
  if (!file) return sayHere(box, `${files[0].name} is not a zip. Pick the tomlin-<version>.zip file, with its .sig file beside it (hold Ctrl to pick both).`);
  const sig = files.find(f => f.name.toLowerCase() === `${file.name.toLowerCase()}.sig`) ?? files.find(f => /\.sig$/i.test(f.name));
  const sigText = sig ? await sigHeader(sig) : '';
  // XMLHttpRequest, not fetch: it says how much of the file has gone up.
  const x = new XMLHttpRequest();
  x.open('POST', '/api/install/zip');
  x.setRequestHeader('content-type', 'application/zip');
  if (sigText) x.setRequestHeader('x-tomlin-sig', sigText);
  $('#node-install-pick').classList.add('is-busy');
  installSaid(`Uploading ${file.name}…`, 0);
  x.upload.onprogress = p => p.lengthComputable && installSaid(p.loaded < p.total ? `Uploading ${file.name}: ${Math.round((p.loaded / p.total) * 100)}%` : 'Opening the zip and checking every part…', p.loaded / p.total);
  x.onloadend = () => {
    $('#node-install-pick').classList.remove('is-busy');
    installSaid('');
    let r = null;
    try {
      r = JSON.parse(x.responseText);
    } catch {
      // said below
    }
    if (x.status !== 200 || !r?.version) return sayHere(box, r?.error ?? (x.status ? `The zip was not taken (the server said ${x.status}). Try again.` : 'The upload stopped: TOMLIN is not answering. Start it again, then upload the zip again.'));
    askInstall(r, r.mine);
  };
  x.send(file);
});

/** What the last Update all could not start: stays through every refresh, until the next press. */
let updateAllFaults = '';

/**
 * Update all and Fast update (the Network page, and the heading of Linked PCs in the left panel): every linked PC that is
 * behind this one and can be updated now, read fresh, the host PIN asked once and a PC without it asking its own.
 */
async function updateAllLinked() {
  const buttons = ['#node-update-all', '#node-fast-update', '#rail-fast-update'].map(q => $(q)).filter(Boolean);
  for (const x of buttons) x.disabled = true;
  updateAllFaults = '';
  const failed = [];
  let can = [];
  try {
    can = ((await api('/api/nodes/others')).pcs ?? []).filter(p => p.ok && p.update && !p.update.why);
  } catch (err) {
    failed.push(err.message);
  }
  if (!can.length && !failed.length) {
    // Nothing can be started from here now: Network says why for each PC.
    updateAllFaults = 'No linked PC can be updated from here now.';
    for (const x of buttons) x.disabled = false;
    openNodes();
    return;
  }
  // Each PC asks its own PIN (audit X2); Cancel skips that one. One typed for a PC is tried on the next ones first.
  const held = {};
  // The host PIN: asked once here for every PC that holds it, and held for this run only.
  const hp = await api('/api/network/host-pin', { action: 'view' }).catch(() => null);
  const holders = new Set((hp?.pcs ?? []).filter(x => x.has).map(x => x.id));
  const by = can.filter(p => holders.has(p.id)).length;
  if (hp?.on && by) {
    const who = by < can.length ? `${by} of the ${can.length} PCs to update hold` : by === 1 ? `"${can[0].name}" holds` : `All ${by} PCs to update hold`;
    const pin = await askHostPin(by === 1 ? 'Update it' : 'Update them', `${who} this PC's host PIN, so one PIN updates them. It is checked here and on each PC, and is not kept. ${by < can.length ? 'The others ask for their own PIN next. ' : ''}Cancel to type each PC's own PIN instead.`);
    if (pin !== null) Object.assign(held, { hostPin: pin, holders });
  }
  for (const p of can) {
    const r = await updatePcWithPin(p, held).catch(err => void failed.push(`"${p.name}": ${err.message}`));
    if (r === null) failed.push(`"${p.name}": its PIN was not typed.`);
  }
  updateAllFaults = failed.length ? `Not started on ${failed.join(' ')}` : '';
  const line = $('#node-update-all-line');
  if (line) line.textContent = updateAllFaults;
  // The updates under way show in Models on my other PCs, each with its own line.
  if (failed.length < Math.max(can.length, 1)) app.openNet?.();
  for (const x of buttons) x.disabled = false;
  refreshOthers();
}

/** The linked PCs this one can update now (behind it, and nothing stopping it), on the Update all button. */
function drawUpdateAll(pcs) {
  const can = pcs.filter(p => p.ok && p.update && !p.update.why);
  const stuck = pcs.filter(p => p.ok && p.update?.why);
  const off = pcs.filter(p => !p.ok).length;
  const b = $('#node-update-all');
  // Fast update: at the right of the Linked PCs heading, only while some linked PC can be updated now.
  const fast = $('#node-fast-update');
  b.disabled = !can.length;
  b.textContent = can.length ? `Update all linked PCs (${can.length})` : 'Update all linked PCs';
  if (fast) {
    fast.hidden = !can.length;
    fast.replaceChildren(clusterIcon(ICON_BOLT), `Fast update (${can.length})`);
  }
  b.onclick = updateAllLinked;
  if (fast) fast.onclick = updateAllLinked;
  const state = stuck.length ? `Behind but not updatable from here now: ${stuck.map(p => `"${p.name}"`).join(', ')} (${stuck.length === 1 ? 'its tile says' : 'their tiles say'} why).`
    : can.length ? '' : pcs.length ? `Every linked PC that answers runs this version${off ? ` (${off} not answering now)` : ''}.` : 'No linked PCs yet.';
  $('#node-update-all-line').textContent = [updateAllFaults, state].filter(Boolean).join(' ');
  drawHostPin();
}

// ---- The host PIN: one PIN for the linked PCs (src/hostpin.ts, src/jobrun/hostpins.ts) ----

/** What the last host PIN step said: stays through every refresh, until the next one. */
let hostPinSaid = '';
function hostPinSay(text) {
  hostPinSaid = text;
  $('#host-pin-said').textContent = text;
  $('#host-pin-said').hidden = !text;
}

/** The host PIN's row under Linked PCs: whether one is set here, and which linked PCs hold it (as each last said). */
async function drawHostPin() {
  const v = await api('/api/network/host-pin', { action: 'view' }).catch(() => null);
  if (!v) return;
  const names = list => list.map(p => `"${p.name}"`).join(', ');
  const has = v.pcs.filter(p => p.has);
  const lack = v.pcs.filter(p => p.can && !p.has);
  const old = v.pcs.filter(p => p.heard && !p.can);
  $('#host-pin-set').textContent = v.on ? 'Change the host PIN' : 'Set the host PIN';
  $('#host-pin-line').textContent = v.on
    ? `Set${v.at ? ` on ${new Date(v.at).toLocaleDateString()}` : ''}. ${has.length ? `Held by ${has.length} of ${v.pcs.length} linked PC${v.pcs.length > 1 ? 's' : ''}.` : 'No linked PC holds it yet.'}`
    : 'One PIN typed here updates, turns off or deletes a model on every linked PC that holds it.';
  $('#host-pin-more').hidden = !v.on;
  $('#host-pin-pcs').textContent = [
    has.length ? `Held by ${names(has)}.` : '',
    lack.length ? `Not given yet: ${names(lack)}.` : '',
    old.length ? `Too old to hold one until updated: ${names(old)}.` : '',
  ].filter(Boolean).join(' ');
  $('#host-pin-give').hidden = !lack.length;
  $('#host-pin-said').textContent = hostPinSaid;
  $('#host-pin-said').hidden = !hostPinSaid;
}

/**
 * Gives the host PIN (`pin`, typed on this page for this run only) to each linked PC in `pcs`: proved with the host PIN
 * it holds now (`oldPin`, when the host PIN changes), or else with that PC's own app lock PIN, asked once. Says how it went.
 */
async function giveHostPin(pcs, pin, oldPin) {
  const done = [];
  const notDone = [];
  for (const p of pcs) {
    let proof = oldPin !== undefined && p.has ? { oldPin } : {};
    let tried = false;
    for (;;) {
      // On a busy PC a give took 20 seconds with nothing said here, the row still reading "Not given yet".
      hostPinSay(`Giving the host PIN to "${p.name}"…`);
      try {
        await api('/api/network/host-pin', { action: 'give', pc: p.id, hostPin: pin, ...proof });
        done.push(`"${p.name}"`);
      } catch (e) {
        if (!e.data?.needNodePin) {
          notDone.push(`"${p.name}": ${e.message}`);
          break;
        }
        const nodePin = await askAppPin(tried || proof.oldPin ? e.message : '', p.name, { own: true, button: `Give "${p.name}" the host PIN`, about: `"${p.name}" takes the host PIN once with its own app lock PIN (or password), typed here. It is checked there and not kept here.` });
        if (nodePin === null) {
          notDone.push(`"${p.name}": its own PIN was not typed.`);
          break;
        }
        proof = { nodePin };
        tried = true;
        continue;
      }
      break;
    }
  }
  hostPinSay([done.length ? `Given to ${done.join(', ')}.` : '', notDone.length ? `Not given to ${notDone.join(' ')}` : ''].filter(Boolean).join(' '));
  refreshOthers();
}

$('#host-pin-set').addEventListener('click', async () => {
  const v = await api('/api/network/host-pin', { action: 'view' }).catch(e => (hostPinSay(e.message), null));
  if (!v) return;
  const dlg = $('#host-pin-dlg');
  const fault = text => {
    $('#host-pin-fault').textContent = text;
    $('#host-pin-fault').hidden = !text;
  };
  for (const id of ['#host-pin-now', '#host-pin-new', '#host-pin-new2']) $(id).value = '';
  $('#host-pin-now-row').hidden = !v.on;
  $('#host-pin-title').textContent = v.on ? 'Change the host PIN' : 'Set the host PIN';
  fault('');
  $('#host-pin-cancel').onclick = () => dlg.close();
  $('#host-pin-form').onsubmit = async e => {
    e.preventDefault();
    const pin = $('#host-pin-new').value;
    const current = v.on ? $('#host-pin-now').value : undefined;
    // All digits (up to 12) is a PIN; anything else is a password.
    const kind = /^[\d ]+$/.test(pin) && pin.replace(/\s+/g, '').length <= 12 ? 'pin' : 'password';
    try {
      await api('/api/network/host-pin', { action: 'set', kind, pin, pin2: $('#host-pin-new2').value, ...(v.on ? { current } : {}) });
    } catch (err) {
      return fault(err.message);
    }
    dlg.close();
    // A change: every PC that can is given the new one (those holding the old one take it with that); a new one: all.
    await giveHostPin(v.pcs.filter(p => p.can), pin, current);
  };
  dlg.showModal();
  (v.on ? $('#host-pin-now') : $('#host-pin-new')).focus();
});

$('#host-pin-give').addEventListener('click', async () => {
  const v = await api('/api/network/host-pin', { action: 'view' }).catch(e => (hostPinSay(e.message), null));
  const lack = (v?.pcs ?? []).filter(p => p.can && !p.has);
  if (!lack.length) return void drawHostPin();
  const pin = await askHostPin('Give it to them', `The host PIN set on this PC, typed here for this once, is given to ${lack.map(p => `"${p.name}"`).join(', ')}. Each then asks for its own app lock PIN once.`);
  if (pin !== null) await giveHostPin(lack, pin);
});

$('#host-pin-off').addEventListener('click', async () => {
  if (!confirm('Turn the host PIN off?\n\nIt is taken away here and from every linked PC that answers now. Each linked PC then asks for its own app lock PIN again to be updated, turned off or to delete a model.')) return;
  try {
    const r = await api('/api/network/host-pin', { action: 'off' });
    hostPinSay(r.missed?.length ? `Turned off. Not answering now, so still holding it until their owner takes it away there (Network): ${r.missed.join(', ')}.` : 'Turned off.');
  } catch (e) {
    hostPinSay(e.message);
  }
  drawHostPin();
});
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
  // A part that is not drawn now is null (a note that only shows sometimes): left out, never read.
  kids = kids.filter(Boolean);
  if (kids.length && kids.every(k => k.outerHTML) && box.innerHTML === kids.map(k => k.outerHTML).join('')) return;
  const key = document.activeElement?.closest?.('[data-key]')?.dataset.key;
  const inside = box.contains(document.activeElement);
  box.replaceChildren(...kids);
  if (inside && key) box.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus();
}
