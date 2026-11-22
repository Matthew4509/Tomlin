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
const PAGE_OF = { home: '#home', nodes: '#nodes', thispc: '#thispc', models: '#models-page', settings: '#settings', updates: '#updates-page', cluster: '#cluster-page', data: '#settings-data', perms: '#settings-perms', colours: '#settings-colours', storage: '#storage-page', help: '#help' };
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
const SETUP_VIEWS = ['settings', 'models', 'storage', 'nodes', 'thispc', 'staff', 'jobs', 'files', 'updates', 'data', 'perms', 'colours'];
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
function staffRow({ key, name, avatar, sub, level, state, stateText, activity, activityWord, busy, count, active, title, onClick, onEdit, editTitle, mutable = true, flag, updating }) {
  // Muted (right-click the row, or Mute all): a bell with a line and "Muted until …", a grey dot in place of the number.
  const muted = mutable ? app.mutedBy?.([key]) : null;
  const bits = app.muteBits?.(muted, count) ?? { icon: null, count: count ? el('span', { class: 'rail-count', text: String(count) }) : null };
  const word = activity ? activityWord ?? ACTIVITY_WORD[activity] : busy ? 'Working' : STATE_WORD[state] ?? stateText;
  const mark = activity ? activityDot(activity) : dot(state);
  const b = el('button', { class: 'rail-row', type: 'button', 'data-key': key, title: `${title}\n${name}: ${sub}\n${busy ?? stateText}${muted ? `\nMuted ${muted.text}` : mutable ? '\nTo mute: right-click, or the … in the chat' : ''}`, 'aria-current': active ? 'true' : null },
    app.avatar ? app.avatar(key, avatar, mark) : el('span', { class: 'rail-avatar', 'aria-hidden': 'true' }, avatar, mark),
    el('span', { class: 'rail-text' },
      // flag: a yellow (!) at the right of the name line, with its words (a linked PC behind this one).
      // updating: in its place a turning wheel while an update goes there (or comes here from it), with its words.
      updating ? el('span', { class: 'rail-name has-flag' }, el('span', { class: 'rail-name-text', text: name }), el('span', { class: 'net-spin rail-spin', role: 'img', 'aria-label': updating, title: updating }))
      : flag ? el('span', { class: 'rail-name has-flag' }, el('span', { class: 'rail-name-text', text: name }), el('span', { class: 'rail-flag', role: 'img', 'aria-label': flag, title: flag, text: '!' }))
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
  app.drawNetMap?.();
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
    // An update going there now (or this PC taking one from it): a turning wheel, not the yellow (!), and pressing the
    // card opens the update's steps again (they run on the server, so its window may have been closed).
    const upd = p.updating ? (p.updating.kind === 'pull' ? `Updating this PC to ${p.updating.what} from "${p.name}": press to see how it goes` : `Updating "${p.name}" to ${p.updating.what}: press to see how it goes`) : '';
    const flag = [upd ? '' : old, full].filter(Boolean).join('\n');
    const mem = homeUi.pcMem[p.id];
    // A "Backups only" PC: no staff work there, so its card says what it keeps instead of what it has loaded.
    const sub = p.backupsOnly ? [at, mem ? memWords(mem.ram, mem.vram) : '', pcMake(p.id), 'Backups only', p.disk ? diskWords(p.disk) : '']
      : [at, mem ? memWords(mem.ram, mem.vram) : '', pcMake(p.id), p.model, p.speed?.expect ? app.speedWords(p.speed.expect, true) : '', p.picture ? `draws with ${p.picture}` : ''];
    // In the cluster while it is on: held for big models, greyed out, no staff go there (the Cluster card has the switch).
    const held = p.heldByCluster === true;
    desks.push({ id: p.id, name: at ? `${name} (${at})` : name, activity: p.activity, backupsOnly: p.backupsOnly, held, row: staffRow({
      key: `pc:${p.id}`, name, avatar: 'PC', sub: sub.filter(Boolean).join(' · ') || p.url, state: p.state, stateText: held && p.activity !== 'offline' ? 'In the cluster: held for big models, no staff' : p.backupsOnly && p.activity !== 'offline' ? 'Backups only: keeps backups, no staff' : p.text, activity: p.activity, activityWord: held && p.activity !== 'offline' ? 'In the cluster' : p.word ?? (asleep ? 'Asleep' : undefined),
      title: upd ? `${[upd, full].filter(Boolean).join('\n')}
${p.name} at ${p.url}` : `${flag ? `${flag}
` : ''}${p.name} at ${p.url}: its uptime, total tokens and what its work cost`, onClick: () => (p.updating ? app.showUpdate?.(p.updating.id) : app.openPc?.(p.id)), mutable: false, flag: flag || undefined, updating: upd || undefined,
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
  const behind = homeUi.pcs.filter(p => p.outdated && !p.updating && p.activity !== 'offline').length;
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
  // Why a PC cannot be added now ('' when it can): off, asleep or not answering says when it was last seen.
  const offReason = p => (!p.ok ? `Off: ${p.seenAt ? `last seen ${new Date(p.seenAt).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}` : 'not seen since this PC started'}` : p.away ? 'Logged off for now: its owner pressed "I need to use the pc"' : '');
  /** The set as the server holds it now, with `id` put in (last) or taken out: two quick moves do not lose one. */
  const move = async (id, into) => {
    const have = (homeUi.cluster ?? cl).members;
    if (into === have.includes(id)) return;
    // A PC that is off, asleep or not answering cannot be added (the server refuses it too).
    const asked = into ? usable.find(x => x.id === id) : null;
    if (asked && offReason(asked)) {
      sayHere(ask, `"${asked.name}" was not added: ${offReason(asked)}.`);
      return;
    }
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
    const off = inSet ? '' : offReason(p);
    const why = off || (!p.ok ? 'Not answering now' : p.allow?.lend === true ? '' : 'Its owner has not ticked "Allow to be used as part of a cluster" there');
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
      el('button', { class: 'btn', type: 'button', 'data-key': `cluster-move:${p.id}`, text: inSet ? 'Remove' : 'Add', disabled: !!off, title: off || null, 'aria-label': inSet ? `Remove ${p.name} from the cluster` : `Add ${p.name} to the cluster`, onclick: async e => {
        e.currentTarget.disabled = true;
        await move(p.id, !inSet);
      } }),
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
    el('b', {}, app.pcLabel('here'), el('span', { class: 'cluster-tag', text: 'This PC' }), cl.out || !cl.members.length ? null : el('span', { class: 'cluster-tag cluster-loads', text: 'Loads the model' })),
    here.ram ? el('span', { class: 'hint', text: memWords(here.ram, here.vram) }) : null);
  const joins = el('div', { class: `cluster-link${cl.out ? ' cluster-link-out' : ''}` }, el('span', { class: 'cluster-link-words', text: cl.out
    ? 'This PC connects to the cluster and sends the chat'
    : cl.part === true ? 'This PC takes part: the model loads here' : cl.members.length ? 'Not chosen yet: the model loads on this PC as it always has' : 'No cluster yet' }));
  // "This PC takes part": on is the old way; off is refused by the server, with why, when no member can load the model now.
  // Never on by itself: nothing chosen shows Off (the server keeps the old way running until they choose). It can be chosen
  // before any PC is in the cluster: read top to bottom, this switch comes first, and the choice waits for the PCs.
  const chosenPart = cl.part === true && !cl.out;
  const part = el('label', { class: 'set-sw' }, el('input', { type: 'checkbox', role: 'switch', checked: chosenPart, 'data-key': 'cluster-part', 'aria-label': 'This PC takes part', onchange: async e => {
    const want = e.target.checked;
    e.target.disabled = true;
    if (!(await changeCluster({ takesPart: want }, ask))) e.target.checked = !want;
    e.target.disabled = false;
  } }), el('i', { 'aria-hidden': 'true' }));
  const partRow = el('div', { class: 'set-card cluster-part' }, el('div', { class: 'set-row' },
    el('span', { class: 'set-tile' }, clusterIcon(ICON_PC, 18)),
    el('span', { class: 'set-txt' }, el('b', { text: 'This PC takes part' }), el('span', { class: 'set-about', text: cl.out
      ? `Off: this PC only connects to the cluster and sends the chat, as text. "${loaderName}" loads the model from its own disk and borrows the other PCs' cards and RAM itself, so this PC's card, processor and network link carry none of the model. Switch it on to load the model here again.`
      : !cl.members.length ? (chosenPart ? 'On: when you put PCs in the cluster, the model loads on this PC, which keeps a share of it on its own card and RAM and sends each other PC its part.' : 'Off: you have not chosen yet, and there is no cluster yet. Switch it on now to choose that this PC loads the model once you put PCs in the cluster below.')
      : cl.part !== true ? 'Off: you have not chosen yet. Until you do, the model loads on this PC as it always has, and nothing here changes by itself. Switch it on to choose that this PC takes part; switch it on and then off to choose that another PC loads the model.'
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
  // Specs: the pool's figures and each PC's hardware line, in one fold closed by default. Every figure is read from the PCs now
  // (this PC's own hardware, each linked PC's last hello), never stored.
  const specLine = (label, text) => el('li', {}, el('b', { text: `${label}: ` }), text);
  const poolPcs = cl.out ? members.length : members.length + 1;
  const specs = app.clusterExtra ? app.clusterExtra.fold('specs',
    `${poolPcs} PC${poolPcs === 1 ? '' : 's'} · ${ram ? `${clusterGb(ram)} RAM` : 'RAM not known'} · ${vram ? `${clusterGb(vram)} card memory` : 'no card memory'}`,
    pool,
    el('ul', { class: 'cluster-specs' },
      specLine(`${app.pcLabel('here')} (this PC)`, here.ram ? `${has(here)}${hw?.cpu?.cores ? ` · ${hw.cpu.cores} cores` : ''}` : 'its memory is not known yet'),
      ...[...members, ...others].map(p => specLine(`${app.pcLabel(p.id)}${members.includes(p) ? '' : ' (not in the cluster)'}`, memOf(p).ram || memOf(p).vram ? has(memOf(p)) : 'its memory is not known yet')))) : pool;
  // Choose an LLM, confirm the name, start chatting: a chat belongs to a hire, so one is made on the spot with a short
  // name from the list above (any name can be typed over it, and changed later under Staff).
  // With this PC out of the cluster, only the chat models on the loader's own disk can be loaded there (it never takes a
  // model from this PC's link): the chat goes to that PC, as a chat with someone hired on a linked PC does.
  const llms = cl.out ? cl.loaderModels ?? [] : (app.models?.chat ?? []).filter(m => m.installed !== false);
  const taken = new Set((homeUi.data?.staff ?? []).map(x => String(x.name).toLowerCase()));
  const spare = CLUSTER_NAMES.find(n => !taken.has(n.toLowerCase())) ?? `Helper ${taken.size + 1}`;
  const ex = app.clusterExtra;
  // Any chat model from anywhere (this PC, the linked PCs, Hugging Face) while this PC loads the model; with this PC out, only
  // the models on the loader's own disk (it never takes a model over this PC's link).
  const many = !cl.out && !!ex;
  if (many && !ex.hasNet()) ex.ask(() => { if (homeUi.view === 'cluster') drawCluster(homeUi.others ?? [], homeUi.cluster ?? cl); });
  const pickedLine = el('p', { class: 'cluster-picked', 'data-key': 'cluster-picked' });
  const showPicked = r => pickedLine.replaceChildren(el('span', { class: 'hint', text: 'Model: ' }), el('b', { text: r?.name ?? 'none picked yet' }));
  const picker = many ? ex.picker((app.models?.chat ?? []).filter(m => m.installed !== false), homeUi.clusterLlm, r => { homeUi.clusterLlm = r.key; showPicked(r); }) : null;
  showPicked(picker?.current());
  const pick = many ? null : el('select', { id: 'cluster-llm', 'data-key': 'cluster-llm', 'aria-label': 'Choose an LLM' }, ...llms.map(m => el('option', { value: m.id, text: String(m.name).split(' · ')[0] })));
  if (pick && llms.some(m => m.id === homeUi.clusterLlm)) pick.value = homeUi.clusterLlm;
  pick?.addEventListener('change', () => { homeUi.clusterLlm = pick.value; });
  const who = el('input', { id: 'cluster-name', 'data-key': 'cluster-name', type: 'text', maxlength: '30', value: homeUi.clusterName ?? spare, 'aria-label': 'Name of the new staff member' });
  who.addEventListener('input', () => { homeUi.clusterName = who.value; });
  // Staff: one already hired on this PC for chat (not a picture role, not working on a linked PC), or Add staff.
  const chatStaff = (team.data?.staff ?? homeUi.data?.staff ?? []).filter(x => !['designer', 'artist'].includes(x.role) && !String(x.model ?? '').startsWith('remote:'));
  const whoPick = el('select', { id: 'cluster-who', 'data-key': 'cluster-who', 'aria-label': 'Who chats with this model', title: 'Someone you have hired takes the model picked above as theirs; Add staff hires someone new with it.' },
    el('option', { value: '', text: 'Add staff' }), ...chatStaff.map(x => el('option', { value: x.id, text: x.name })));
  if (chatStaff.some(x => x.id === homeUi.clusterWho)) whoPick.value = homeUi.clusterWho;
  const whoNew = () => { who.hidden = !!whoPick.value; };
  whoPick.addEventListener('change', () => { homeUi.clusterWho = whoPick.value; whoNew(); });
  whoNew();
  const hireAndTalk = async model => {
    if (whoPick.value) {
      team.data = await api('/api/staff', { action: 'change', id: whoPick.value, model });
      await app.talkTo(`staff:${whoPick.value}`);
      return;
    }
    team.data = await api('/api/staff', { action: 'hire', name: who.value.trim() || spare, role: 'default', model });
    const hired = team.data.staff.at(-1);
    homeUi.clusterName = undefined;
    await app.afterHire?.(hired);
    await app.talkTo(`staff:${hired.id}`);
  };
  const startBtn = el('button', { class: 'btn primary', type: 'button', 'data-key': 'cluster-start', text: 'Start chat', disabled: many && ex.busy(), onclick: async e => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      if (many) {
        const r = picker.current();
        if (!r) throw new Error('pick a model first');
        // Picked from another PC or Hugging Face: it is brought here first, with its progress under the list.
        ex.setBusy(true);
        const id = await ex.bringHere(r);
        ex.say('');
        await hireAndTalk(id);
      } else {
        await hireAndTalk(pick.value);
      }
    } catch (err) {
      ex?.say('');
      sayHere(ask, `The chat was not started: ${err.message}`);
      btn.disabled = false;
    } finally {
      ex?.setBusy(false);
    }
  } });
  const start = el('div', { class: 'set-card cluster-start' }, el('div', { class: 'set-row' },
    el('span', { class: 'set-tile' }, document.querySelector('[data-setup="models"] svg')?.cloneNode(true) ?? ''),
    el('span', { class: 'set-txt' }, el('b', { text: 'Choose an LLM' }), el('span', { class: 'set-about', text: cl.out
      ? (llms.length ? `The models on "${loaderName}", which loads the model for the cluster. Start chat hires someone with that model under the name shown and opens their chat: "${loaderName}" answers, borrowing from the other PCs in the cluster when the model is too big for it alone, and only the chat's words cross this PC's link.` : cl.loaderNoModel || `No chat model is on "${loaderName}" yet.`)
      : many
        ? 'Choose a model from your network.'
        : llms.length
          ? 'Start chat hires someone with that chat model under the name shown (change it if you like) and opens their chat. A model too big for this PC borrows from the cluster when the cluster is on.'
          : 'No chat model is on this PC yet: add one under Models first.' }),
      many ? picker.node : null,
      many ? el('div', { class: 'cluster-go' }, pickedLine, el('div', { class: 'cluster-go-row' }, el('label', { class: 'cluster-go-who' }, el('span', { class: 'hint', text: 'Staff' }), whoPick), who, startBtn)) : null),
    el('span', { class: 'set-side' }, ...(many ? [] : llms.length ? [pick, whoPick, who, startBtn].filter(Boolean) : [el('button', { class: 'btn primary', type: 'button', 'data-key': 'cluster-models', text: 'Models', onclick: () => app.openModels?.() })]))));
  // Shutdown turns the cluster's nodes off, asking each in turn (each asks its own PIN). Never this PC.
  const offAll = members.length ? el('p', { class: 'hint cluster-off' }, el('button', { class: 'btn', type: 'button', 'data-key': 'cluster-off', title: 'Turns each node of the cluster off, one at a time, asking each one for its app lock PIN. This PC stays on.', onclick: async e => {
    const btn = e.currentTarget;
    if (!(await askHere(ask, `Turn off ${members.map(p => `"${p.name}"`).join(', ')}? Each shuts down about 15 seconds after it answers, one after the other, and stays off until someone switches it on again. Each asks for its own app lock PIN. This PC stays on.`, 'Turn them off', 'Keep them on'))) return;
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
    clusterPlainRow(members, ask),
    specs,
    el('div', { class: 'cluster-cols' },
      // This PC above the cluster's box, joined to it: it connects to the cluster, it is not one of its nodes.
      el('div', { class: 'cluster-side' }, host, joins,
        zone(true, 'The cluster', cl.out ? 'Its nodes, strongest first. The one marked "Loads the model" starts it from its own disk and borrows from the others.' : 'Its nodes, strongest first. They lend their card and RAM to this PC, which loads the model.', [members.length ? el('ul', { class: 'cluster-list' }, ...members.map((p, k) => tile(p, true, k))) : el('p', { class: 'hint cluster-empty', text: 'Drag a PC here, or press Add on its tile.' })])),
      zone(false, 'Available', 'Linked PCs not in the cluster: they work as usual. Strongest first.', [others.length ? el('ul', { class: 'cluster-list' }, ...others.map(p => tile(p, false, -1))) : el('p', { class: 'hint cluster-empty', text: usable.length ? 'Every linked PC is in the cluster.' : 'No linked PC yet: link one under Network first.' })])),
    start,
    gaps || three || offAll ? el('div', { class: 'cluster-under' }, ...[gaps, three, offAll].filter(Boolean)) : null,
  ]);
}

/**
 * The Cluster page's "Encrypted links": one switch for every PC in the cluster. Off asks for an unencrypted link to each
 * (this PC's side, /api/remotes plain-link) and allows it on that PC too (its "Allow unencrypted cluster links", set from
 * here with its owner's "Allow host to test and change model run settings" tick and its PIN or this PC's key, as the
 * permissions fold does); a PC that cannot be set from here says what its owner ticks there. On seals them all again.
 * Only the borrowing of cards and RAM goes unencrypted; every other link (chats, updates, PINs, copies) stays sealed.
 */
function clusterPlainRow(members, ask) {
  if (!members.length) return null;
  const plainAll = members.every(p => p.plainLink === true);
  const stateOf = p => (p.plainLink !== true ? 'encrypted' : p.plainNow ? 'NOT encrypted now' : p.plainOk ? 'not encrypted from the next load' : `still encrypted: "${p.name}" has not allowed it there`);
  const sw = el('label', { class: 'set-sw' }, el('input', { type: 'checkbox', role: 'switch', checked: !plainAll, 'data-key': 'cluster-encrypt', 'aria-label': 'Encrypted links', onchange: async e => {
    const encrypt = e.target.checked;
    if (!encrypt && !confirm('Turn off encryption for the cluster?\n\nFaster (about 18% in our test), but anything on your home network could read the model\'s traffic between these PCs, or change it. Only on a wired network you trust. Chats, updates and PINs stay encrypted.')) {
      e.target.checked = true;
      return;
    }
    e.target.disabled = true;
    const notes = [];
    for (const p of members) {
      try {
        await api('/api/remotes', { action: 'plain-link', id: p.id, on: !encrypt });
        if (encrypt || p.plainOk === true) continue;
        // The other half, on that PC: its own "Allow unencrypted cluster links", set from here when its owner allows it.
        if (!p.ok || !p.can?.includes('perm-set') || p.allow?.tune !== true) {
          notes.push(`"${p.name}": tick "Allow unencrypted cluster links" on it (Network, Sharing permissions), or tick "Allow host to test and change model run settings" there so it can be set from here.`);
          continue;
        }
        const r = await permSetWithPin(p, { plainLinks: true });
        if (r === null) notes.push(`"${p.name}": its PIN was not typed, so it stays encrypted.`);
      } catch (err) {
        notes.push(`"${p.name}": ${err.message}`);
      }
    }
    sayHere(ask, encrypt ? 'The cluster\'s links are encrypted again from the next load.' : `Encryption off from the next load (unload and load the model).${notes.length ? ` ${notes.join(' ')}` : ''}`);
    e.target.disabled = false;
    refreshOthers();
  } }), el('i', { 'aria-hidden': 'true' }));
  return el('div', { class: 'set-card cluster-plain' }, el('div', { class: 'set-row' },
    el('span', { class: 'set-tile' }, clusterIcon(ICON_PC, 18)),
    el('span', { class: 'set-txt' }, el('b', { text: 'Encrypted links' }),
      el('span', { class: 'set-about', text: plainAll ? 'Off: the model\'s traffic between the PCs is not encrypted (faster; only on a network you trust). Switch it on to seal it again.' : 'On: the model\'s traffic between the PCs is encrypted. Switch it off for speed on a wired network you trust (both PCs are set from here).' }),
      el('span', { class: 'set-about', text: members.map(p => `"${p.name}": ${stateOf(p)}`).join(' · ') })),
    el('span', { class: 'set-side' }, sw)));
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
// Counts the windows closed: a copy being followed stops when its window is closed (they are then not moved).
const moveRun = { n: 0 };
moveDlg.addEventListener('close', () => { moveRun.n++; });
/** src/calc.ts ramFit and chatNeed, so the window need not offer what the server would refuse (it checks again at the move). */
const moveFit = (need, mem) => (!mem?.ram || !need ? null : need <= (mem.vram ?? 0) + Math.max(0, mem.ram - 3 * GB) ? 'ok' : need <= ((mem.vram ?? 0) + mem.ram) * 1.05 ? 'tight' : 'no');
const moveNeed = bytes => (bytes + Math.min(bytes * 0.2, 1.5 * GB)) * 1.1 + 0.8 * GB;
/** A model's name for matching: no case, no .gguf, no punctuation. */
const moveNorm = x => String(x ?? '').toLowerCase().replace(/\.gguf$/, '').replace(/[^a-z0-9]/g, '');
const moveCap = x => `${x.charAt(0).toUpperCase()}${x.slice(1)}${/[.!?]$/.test(x) ? '' : '.'}`;

/** The suggested-list model (models.js POPULAR) whose file is named like this, with what Download on a linked PC needs; null if it is not there. */
async function moveCatalog(stem) {
  if (typeof POPULAR === 'undefined' || !stem) return null;
  const { sizes } = await api('/api/chatmodels/sizes', { repos: POPULAR.map(p => p.repo) });
  for (const z of sizes) {
    const m = z.error ? null : z.models?.find(x => moveNorm(x.name) === moveNorm(stem));
    if (m) return { repo: z.repo, rev: z.rev, name: m.name, bytes: m.bytes, what: m.name.replace(/\.gguf$/i, '') };
  }
  return null;
}

async function deskMove(s, pc, pcName) {
  let net = null;
  let cat = null;
  try {
    // The window opens at once (the answer from the PC can take a moment), and is filled when it comes.
    const waiting = () => {
      $('#desk-move-title').textContent = `Move ${s.name} to ${pcName}`;
      $('#desk-move-line').textContent = `Asking ${pcName} what models it has…`;
      $('#desk-move-row').hidden = true;
      $('#desk-move-go').hidden = true;
      $('#desk-move-go').disabled = false;
      $('#desk-move-how').hidden = true;
      $('#desk-move-more').hidden = true;
      $('#desk-move-progress').hidden = true;
      $('#desk-move-fault').hidden = true;
      $('#desk-move-send').replaceChildren();
      moveDlg.dataset.id = s.id;
      if (!moveDlg.open) moveDlg.showModal();
    };
    if (pc) waiting();
    team.data = await api('/api/staff');
    // A PC just linked, or slow to answer, has no list here yet: it is asked again before anything is said about it.
    if (pc && !deskModels(s, pc).length) {
      for (let i = 0; i < 4 && !deskModels(s, pc).length; i++) {
        await new Promise(r => setTimeout(r, 1500));
        if (!moveDlg.open) return;
        team.data = await api('/api/staff');
      }
      if (!moveDlg.open) return;
    }
    // What that PC lets this one do (Network's own words), and, for a model deleted here, its place in the suggested list.
    if (pc) {
      net = (await api('/api/network?known=1').catch(() => null))?.pcs?.find(p => p.id === pc) ?? null;
      if (s.modelGone && s.kind !== 'image' && !net?.fetch) cat = await moveCatalog(s.modelWas).catch(() => null);
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
  const wontFit = c => c.ramFit === 'no';
  const fits = models.filter(c => !wontFit(c));
  const same = models.find(c => short(c.name) === short(s.modelName));
  $('#desk-move-title').textContent = `Move ${s.name} to ${pcName}`;
  const sel = $('#desk-move-model');
  sel.replaceChildren(...models.map(c => el('option', { value: c.id, disabled: wontFit(c),
    text: `${c.name.replace(/ on ".*?"/, '').replace(/ \((loads there when asked|loaded there)\)/, '')}${wontFit(c) ? ` (needs about ${gb(c.need)}: more than ${pcName} has)` : c.ramFit === 'tight' ? ' (tight fit)' : ''}` })));
  if (same && !wontFit(same)) sel.value = same.id;
  else if (fits.length) sel.value = fits[0].id;
  $('#desk-move-fault').hidden = true;
  $('#desk-move-progress').hidden = true;
  $('#desk-move-go').disabled = false;
  const line = $('#desk-move-line');
  const box = $('#desk-move-send');
  box.replaceChildren();
  const own = s.model && !String(s.model).startsWith('remote:') ? s.model : '';
  // Their model's file may be gone from this PC (the name then reads as a fault): the plain name is used.
  const uses = s.modelGone ? (s.modelWas || '') : (s.modelName || '');
  const ram = mem?.ram ? `${pcName} has ${gb(mem.ram)} of RAM${mem.vram ? ` and ${gb(mem.vram)} of graphics-card memory` : ''}, 3 GB of it kept for Windows` : '';
  const ownC = pc && own && !s.modelGone && !same ? (team.data?.hireChoices?.[s.kind === 'image' ? 'image' : 'chat'] ?? []).find(c => c.id === own) ?? null : null;
  // The choices that can work, the likeliest first; the others are told in More, with why.
  const opts = [];
  const notes = [];
  if (ownC && net?.send) notes.push(`Copying ${uses} to ${pcName} is not offered: ${moveCap(net.send)}`);
  else if (ownC && moveFit(ownC.need, mem) === 'no') notes.push(`Copying ${uses} to ${pcName} is not offered: it needs about ${gb(ownC.need)} and ${ram || 'that PC has less'}.`);
  else if (ownC) opts.push({ v: 'send', text: `Copy ${uses} to ${pcName}, then move ${s.name}`, note: `${uses} is ${gb(ownC.bytes)}. It is sent over your network, stays on this PC too, and ${s.name} moves when it has arrived.` });
  if (pc && cat && !same) {
    if (net?.fetch) notes.push(`Downloading ${uses} on ${pcName} is not offered: ${moveCap(net.fetch)}`);
    else if (moveFit(moveNeed(cat.bytes), mem) === 'no') notes.push(`Downloading ${uses} on ${pcName} is not offered: it needs about ${gb(moveNeed(cat.bytes))} and ${ram || 'that PC has less'}.`);
    else opts.push({ v: 'fetch', text: `Download ${uses} on ${pcName}, then move ${s.name}`, note: `${pcName} downloads ${uses} (${gb(cat.bytes)}) from Hugging Face itself; nothing passes through this PC. ${s.name} moves when it has arrived.` });
  }
  if (fits.length) opts.push({ v: 'pick', text: pc ? `Use another model already on ${pcName}` : 'Pick other software' });
  const big = fits.length ? models.filter(wontFit) : [];
  if (big.length) notes.push(`Not offered, too big for ${pcName}${mem?.ram ? ` (${gb(mem.ram)} of RAM, 3 GB of it kept for Windows${mem.vram ? `, and ${gb(mem.vram)} of graphics-card memory` : ''})` : ''}: ${big.map(c => `${c.name.replace(/ on ".*?"/, '').replace(/ \(.*\)$/, '')} needs about ${gb(c.need)}`).join('; ')}.`);
  const extra = opts.some(o => o.v !== 'pick');
  if (models.length && !fits.length && !extra) line.textContent = `None of the models on ${pcName} fits its memory${ram ? ` (${ram})` : ''}. Send a smaller model there first, or move ${s.name} to a PC with more memory.`;
  else if (same && wontFit(same)) line.textContent = `${pcName} has ${s.modelName}, but it needs about ${gb(same.need)} and ${ram || 'that PC has less'}. Pick a smaller model ${s.name} runs on there.`;
  else if (same) line.textContent = `${pcName} has ${s.modelName}${same.ramFit === 'ok' ? ', and it fits' : same.ramFit === 'tight' ? ', but it is a tight fit' : ''}: ${s.name} keeps the same software there.`;
  else if (opts.length) {
    // Two lines: what is wrong, then what to do.
    const what = s.modelGone && uses ? `${uses}, ${s.name}'s model, was deleted from this PC, and ${pcName} does not have it.` : uses ? `${s.name} uses ${uses}, which ${pcName} does not have.` : `${pcName} does not have ${s.name}'s software.`;
    line.replaceChildren(what, el('br'), extra ? 'Would you like to:' : `Pick the software ${s.name} runs on there.`);
  }
  else if (!pc) line.textContent = `This PC has no ${s.kind === 'image' ? 'picture' : 'chat'} models yet.`;
  else line.textContent = team.data?.pcs?.find(p => p.id === pc)?.ok ? `${pcName} has no ${s.kind === 'image' ? 'picture' : 'chat'} models yet. Send one there from Models.` : `${pcName} is not answering just now. Check it is on, then try again.`;
  if (pc && !models.length && !extra) box.append(el('button', { class: 'btn', type: 'button', text: 'Try again', onclick: () => deskMove(s, pc, pcName) }));
  // The choices as radios (only the ones that apply; the first is ticked). A lone "pick" is the select itself.
  const how = $('#desk-move-how');
  const radios = extra;
  const more = $('#desk-move-more');
  const sync = () => {
    const v = radios ? how.querySelector('input:checked')?.value : opts[0]?.v;
    $('#desk-move-row').hidden = v !== 'pick';
    const note = opts.find(o => o.v === v)?.note;
    const lines = [...(radios && note ? [note] : []), ...notes];
    $('#desk-move-more-body').replaceChildren(...lines.map(t => el('p', { class: 'hint', text: t })));
    more.hidden = !lines.length;
  };
  how.hidden = !radios;
  how.replaceChildren(...(radios ? opts.map((o, i) => el('label', { class: 'check' }, el('input', { type: 'radio', name: 'desk-move-how', value: o.v, checked: i === 0, onchange: sync }), ' ', el('span', { text: o.text }))) : []));
  more.open = false;
  sync();
  moveDlg.dataset.send = ownC ? own : '';
  moveDlg.dataset.kind = s.kind === 'image' ? 'image' : 'chat';
  moveDlg.dataset.pc = pc || '';
  moveDlg.dataset.pcName = pcName;
  moveDlg.dataset.uses = uses;
  moveDlg.dataset.cat = cat ? JSON.stringify(cat) : '';
  $('#desk-move-go').hidden = !opts.length;
  if (!pc && !models.length) box.append(el('button', { class: 'btn', type: 'button', text: 'Get models', onclick: () => { moveDlg.close(); app.openModels(); } }));
  moveDlg.dataset.id = s.id;
  if (!moveDlg.open) moveDlg.showModal();
}
$('#desk-move-cancel').addEventListener('click', () => moveDlg.close());

/** Starts the copy or download, shows how far it is, and moves them when the model is listed on that PC. Closing the window ends it with them where they were. */
async function moveAfter(run, start, who, pcName, uses, matches) {
  const say = text => { const p = $('#desk-move-progress'); p.textContent = text; p.hidden = false; };
  const stage = t => {
    const pct = t.bytes ? ` ${Math.min(99, Math.floor((t.done / t.bytes) * 100))}%` : '';
    if (t.queued) return `${uses}: waiting for its turn…`;
    return `${t.kind === 'fetch' ? `${pcName} is downloading` : `Copying to ${pcName}:`} ${uses}${pct}…`;
  };
  say('Starting…');
  const started = (await api(start.path, start.body)).transfer;
  if (run !== moveRun.n) return;
  say(stage(started));
  let t = started;
  while (t.state === 'working') {
    await new Promise(r => setTimeout(r, 2000));
    if (run !== moveRun.n) return;
    try {
      t = (await api('/api/network/transfers')).transfers.find(x => x.id === started.id) ?? { ...started, state: 'failed', said: 'TOMLIN was restarted while it worked.' };
    } catch {
      // TOMLIN did not answer just now: asked again.
    }
    if (t.state === 'working') say(stage(t));
  }
  if (t.state !== 'done') throw new Error(`${t.said || 'The copy did not finish.'} ${who} stays where they are.`);
  // The model is on that PC; it is listed here when that PC next says what it has (asked again until it does).
  say(`${uses} has arrived. Waiting for ${pcName} to list it…`);
  for (let i = 0; i < 30; i++) {
    team.data = await api('/api/staff');
    if (run !== moveRun.n) return;
    const hit = deskModels({ kind: moveDlg.dataset.kind }, moveDlg.dataset.pc).find(matches);
    if (hit) {
      say(`Moving ${who}…`);
      team.data = await api('/api/staff', { action: 'change', id: moveDlg.dataset.id, model: hit.id, move: true });
      return;
    }
    await new Promise(r => setTimeout(r, 2000));
    if (run !== moveRun.n) return;
  }
  throw new Error(`${uses} has arrived on ${pcName}, but it is not listed there yet. ${who} stays where they are: try Move again in a moment.`);
}

$('#desk-move-go').addEventListener('click', async () => {
  const go = $('#desk-move-go');
  go.disabled = true;
  const run = moveRun.n;
  try {
    const how = $('#desk-move-how').hidden ? 'pick' : $('#desk-move-how').querySelector('input:checked')?.value;
    if (how === 'pick') {
      team.data = await api('/api/staff', { action: 'change', id: moveDlg.dataset.id, model: $('#desk-move-model').value, move: true });
    } else {
      const { pcName, uses, pc } = moveDlg.dataset;
      const who = team.data?.staff?.find(x => x.id === moveDlg.dataset.id)?.name ?? 'They';
      if (how === 'send') {
        const file = moveNorm(moveDlg.dataset.send);
        await moveAfter(run, { path: '/api/network/send', body: { pc, kind: moveDlg.dataset.kind, model: moveDlg.dataset.send } }, who, pcName, uses, c => c.id === `remote:${pc}:${moveDlg.dataset.send}` || moveNorm(c.id).endsWith(file));
      } else {
        const c = JSON.parse(moveDlg.dataset.cat);
        await moveAfter(run, { path: '/api/network/fetch', body: { pc, kind: 'chat', repo: c.repo, rev: c.rev, name: c.name, what: c.what } }, who, pcName, uses, m => moveNorm(m.id).endsWith(moveNorm(c.name)) || moveNorm(m.name).includes(moveNorm(c.name)));
      }
    }
    if (run !== moveRun.n) return;
    moveDlg.close();
    await refresh();
  } catch (err) {
    if (run !== moveRun.n) return;
    $('#desk-move-progress').hidden = true;
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
  app.drawNetMap?.();
  // This PC's memory and what is loaded are in the top bar (its rings and the models loaded). The models list on
  // Settings > This PC is the one in this PC's window (pcs.js), drawn when the page opens.
}

/** A model hidden, shown or deleted: the lists a model is picked from are read again (chat, Hire staff, Edit Staff). */
function modelListsChanged() {
  loadModels().catch(() => undefined);
  teamLoad().catch(() => undefined);
  app.hireRedraw?.();
}

/**
 * Network starts with what this PC is: an admin PC (it connects to nodes), a node, or backup and model storage. Only the
 * parts that apply show; the role is remembered in this browser. Everything stays in the page, so the code that draws it
 * does not depend on which role is open. A part from another role is reached by name (netSection), which switches the role.
 */
const NET_ROLES = {
  admin: ['linked', 'guests', 'advanced'],
  node: ['pc', 'sharing'],
  storage: ['pc', 'sharing'],
};
function netRole(role) {
  const at = NET_ROLES[role] ? role : 'admin';
  for (const s of document.querySelectorAll('#nodes .net-sec')) s.hidden = !NET_ROLES[at].includes(s.dataset.sec);
  for (const b of document.querySelectorAll('#net-menu .net-tab')) {
    const on = b.dataset.role === at;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  store('net-role', at);
}
/** Shows the part named (pc, linked, sharing, guests, advanced), changing the role when the part is not in this one. */
function netSection(name) {
  const now = store('net-role');
  if (NET_ROLES[now]?.includes(name)) return netRole(now);
  netRole(['admin', 'node'].find(r => NET_ROLES[r].includes(name)));
}
app.netSection = netSection;
for (const b of document.querySelectorAll('#net-menu .net-tab')) b.addEventListener('click', () => netRole(b.dataset.role));
netRole(store('net-role'));

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
  // Everything that only exists while this PC is a node (its setup, the permissions, the PIN and port) is hidden together;
  // the Sharing page says why it is empty.
  for (const g of document.querySelectorAll('.node-gated')) g.hidden = !sh.on;
  $('#net-sharing-off').hidden = sh.on;
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
      el('button', { class: 'link', type: 'button', text: 'Remove', onclick: async () => { if (await askHere($('#node-paired-ask'), `Stop lending to "${x.name}"? It would need the setup code again.`, `Stop lending to ${x.name}`, 'Keep it linked')) nodeShare({ unpair: k, unpairId: x.id }); } })))] : []));
  }
  // A4: new PCs asking for backups kept here, each with Allow / Don't allow (owner.js).
  app.drawClaims?.(sh.claims);
  drawNodeShare(sh);
  drawNodeAllow(sh);
  drawGuestPasses(sh);
  drawDirectLinks(sh);
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
  $('#node-host-pins').replaceChildren(...(list.length ? [el('p', { class: 'hint', text: 'Hosts that hold a host key or host PIN for this PC (unlocking that host updates this PC, turns it off or deletes a model, still only with the ticks above):' }),
    ...list.map(x => el('div', { class: 'job-remote' }, el('span', { text: nameOf(x) }), el('span', { class: 'hint', text: x.at ? `since ${new Date(x.at).toLocaleDateString()}` : '' }),
      el('button', { class: 'link', type: 'button', text: 'Take it away', onclick: async () => { if (await askHere($('#node-paired-ask'), `Take the host ${x.key ? 'key' : 'PIN'} away from "${nameOf(x)}"? It then asks for this PC's own app lock PIN again to update it, turn it off or delete a model. It stays linked.`, 'Take it away', 'Keep it')) nodeShare({ hostPinDrop: x.id }); } })))] : []));
}

/** A direct copy being followed on the page: the pair, the model's name, and the timer that asks how it goes. */
const peerFollow = { timer: 0 };

/**
 * Direct links between PCs (src/jobrun/peersync.ts on a host, src/peerlink.ts on a node): the links on this PC, each with
 * Remove; the pairs this PC introduced, each with Check, Copy a model and End; and Introduce two linked PCs. The part is
 * shown only when there is something to show or do (a node with links, or a host with two PCs that can talk directly).
 */
function drawDirectLinks(sh) {
  const view = sh.peerLinks ?? { pairs: [], pcs: [] };
  const here = sh.peersHere ?? [];
  const pcs = view.pcs ?? [];
  const able = pcs.filter(p => p.can !== false);
  $('#direct-links').hidden = !here.length && !(view.pairs ?? []).length && able.length < 2;
  const sig = JSON.stringify([view, here]);
  if (sig === homeUi.drawn.peers) return;
  homeUi.drawn.peers = sig;
  const said = $('#node-peer-said');
  const ask = $('#node-peer-ask');
  const when = t => new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const scopeWords = s => (s ?? []).map(x => ({ copy: 'copies models', runner: 'sends runners', cluster: 'cluster' })[x] ?? x).join(', ');
  $('#node-peers-here').replaceChildren(...(here.length ? [el('p', { class: 'hint', text: 'Linked directly to this PC:' }),
    ...here.map(p => el('div', { class: 'job-remote' },
      el('span', { text: p.name }),
      el('span', { class: 'hint', text: `introduced by "${p.host}" · ${scopeWords(p.scopes)}` }),
      el('span', { class: 'hint', text: p.lastUsed ? `last used ${when(p.lastUsed)}` : 'not used yet' }),
      el('button', { class: 'link', type: 'button', text: 'Remove', onclick: async () => { if (await askHere(ask, `Remove the direct link with "${p.name}"? It stops at once on this PC, and "${p.host}" cannot put it back.`, 'Remove the link', 'Keep it')) nodeShare({ peerRemoveHere: p.id }); } })))] : []));
  // The pairs this PC introduced: each with how it stands, Check, Copy a model and End.
  const syncWords = s => (s.sync === 'latest' ? '' : ` · "${s.name}" ${s.said || 'has not been told yet'}`);
  const modelsOf = id => (pcs.find(x => x.id === id)?.models ?? []);
  const copyPick = p => {
    const choices = [[p.a, p.b], [p.b, p.a]].flatMap(([from, to]) => modelsOf(from.id).map(m => ({ from, to, m })));
    if (!choices.length) return el('span', { class: 'hint', text: 'Neither PC shares a model to copy.' });
    const sel = el('select', { 'aria-label': `The model to copy between "${p.a.name}" and "${p.b.name}"` }, ...choices.map((c, i) => el('option', { value: String(i), text: `${c.m.name}: from ${c.from.name} to ${c.to.name}` })));
    const go = el('button', { class: 'btn', type: 'button', text: 'Copy it', onclick: async () => {
      const c = choices[Number(sel.value)];
      said.textContent = `Asking "${c.to.name}" to copy ${c.m.name} from "${c.from.name}"…`;
      await nodeShare({ peerCopy: { from: c.from.id, to: c.to.id, kind: c.m.kind, model: c.m.id } }, () => followCopy(c));
    } });
    return el('span', { class: 'node-peer-copy' }, sel, go);
  };
  $('#node-peer-pairs').replaceChildren(...((view.pairs ?? []).length ? [el('p', { class: 'hint', text: 'PCs this one introduced to each other:' }),
    ...view.pairs.map(p => el('div', { class: 'job-remote node-peer-pair' },
      el('span', { text: `${p.a.name} and ${p.b.name}` }),
      el('span', { class: 'hint', text: `${scopeWords(p.scopes)}${syncWords(p.a)}${syncWords(p.b)}` }),
      el('button', { class: 'link', type: 'button', text: 'Check', title: 'Each PC tries to reach the other directly now', onclick: () => {
        said.textContent = `Asking "${p.a.name}" and "${p.b.name}" to reach each other…`;
        nodeShare({ peerCheck: { a: p.a.id, b: p.b.id } }, r => { said.textContent = (r.peerCheck ?? []).map(l => `${l.from} to ${l.to}: ${l.ok ? `reached${l.address ? ` at ${l.address}` : ''}${l.ms ? ` in ${l.ms} ms` : ''}` : l.said || 'not reached'}`).join('. '); });
      } }),
      el('button', { class: 'link', type: 'button', text: 'End', onclick: async () => { if (await askHere(ask, `End the direct link between "${p.a.name}" and "${p.b.name}"? Each is told now, or when it is next on.`, 'End it', 'Keep it')) nodeShare({ peerRemove: { a: p.a.id, b: p.b.id } }); } }),
      copyPick(p)))] : []));
  // Introduce: two different linked PCs (one that runs an older TOMLIN is named as such, and refused by the host).
  // A PC that cannot be chosen is greyed, and one line says why (the reason was repeated in both lists, for each PC).
  const choosable = p => p.can !== false && p.allowed;
  const opts = () => pcs.map(p => el('option', { value: p.id, text: p.name, disabled: !choosable(p) }));
  const a = $('#node-peer-a');
  const b = $('#node-peer-b');
  a.replaceChildren(...opts());
  b.replaceChildren(...opts());
  const open = [...a.options].map((o, i) => (o.disabled ? -1 : i)).filter(i => i >= 0);
  a.selectedIndex = open[0] ?? -1;
  b.selectedIndex = open[1] ?? open[0] ?? -1;
  const stuck = pcs.filter(p => !choosable(p));
  const why = $('#node-peer-why');
  why.hidden = !stuck.length;
  why.textContent = stuck.length ? `Greyed PCs cannot be chosen: ${stuck.map(p => `${p.name} (${p.can === false ? 'older TOMLIN' : 'its owner has not ticked it'})`).join(', ')}.` : '';
  $('#node-peer-make').onclick = async () => {
    if (a.value === b.value) return void (said.textContent = 'Pick two different PCs.');
    said.textContent = '';
    await nodeShare({ peerIntroduce: { a: a.value, b: b.value, scopes: ['copy'] } }, () => { said.textContent = 'Introduced: each is told now, or when it is next on.'; });
  };
}

/** Follows a direct copy on the page until it ends: how much has come, then what it said. */
function followCopy(c) {
  clearTimeout(peerFollow.timer);
  const said = $('#node-peer-said');
  const tick = async () => {
    try {
      const r = await api('/api/share', { peerCopy: { from: c.from.id, to: c.to.id, action: 'state' } });
      const t = r.peerCopy?.transfer;
      if (!t) return void (said.textContent = `"${c.to.name}" has no copy under way from "${c.from.name}".`);
      if (t.state === 'working') {
        said.textContent = `"${c.to.name}" is copying ${t.what} from "${c.from.name}": ${gb(t.done)} of ${gb(t.bytes)}.`;
        peerFollow.timer = setTimeout(tick, 3000);
      } else said.textContent = t.said || `The copy ${t.state}.`;
    } catch (e) {
      said.textContent = e.message;
    }
  };
  tick();
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
    // A row shows how many models on each PC; the names are one press away (a PC's whole list was repeated on every row).
    const count = n => (n ? `${n} model${n === 1 ? '' : 's'}` : 'no models');
    const whereShort = x => {
      if (x.from) return `from "${x.from}": ${count(x.models.length)}`;
      return x.nodes.map(id => `${pcName(id)} (${count((x.nodeModels?.[id] ?? x.models).length)})`).join('; ');
    };
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
      el('span', { class: 'hint', text: whereShort(x) }),
      x.from || x.nodes.length ? el('details', { class: 'net-more pass-models' }, el('summary', { text: 'Which models' }), el('span', { class: 'hint', text: where(x) })) : null,
      (x.renewals ?? []).length ? el('span', { class: 'hint ok', text: renewedWords(x) }) : null,
      el('button', { class: 'link', type: 'button', text: 'Remove', onclick: async () => { if (await askHere($('#node-pass-ask'), x.from ? `Remove the guest pass "${x.label}" on this PC? A PC linked here with it stops at once. "${x.from}" gave it, and keeps it for its other PCs.` : `Remove the guest pass "${x.label}"? A PC linked with it stops at once on every PC it is for, and its code links nothing more.`, 'Remove the pass', 'Keep it')) nodeShare({ passRemove: x.id }); } })))
      : []));
    $('#node-pass-none').hidden = passes.length > 0;
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
    // An empty line says nothing (a line that is empty is not news).
    $('#node-line').textContent = run.length || wait.length ? `Running: ${run.join('; ') || 'nothing'}. Waiting: ${wait.join('; ') || 'nobody'}.` : '';
    $('#node-line').hidden = !run.length && !wait.length;
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
    $('#node-pass-sync').replaceChildren(...(own && sync.length ? sync.map(p => el('p', { class: `hint${p.sync === 'latest' ? ' ok' : ''}`, text: `${app.pcLabel(p.id)} ${words(p)}.` })) : []));
  }
  // The PCs and their model ticks, drawn again only when the PCs or their models change, so a tick is not lost to the
  // 3-second refresh.
  const fsig = JSON.stringify(pcs.map(p => [p.id, p.name, passPcSpecs(p), p.models.map(m => [m.id, m.name])]));
  if (fsig !== homeUi.drawn.passModels) {
    homeUi.drawn.passModels = fsig;
    const ticked = new Set([...document.querySelectorAll('#node-pass-nodes input:checked')].map(t => t.value));
    const openPcs = new Set([...document.querySelectorAll('#node-pass-nodes details[open]')].map(d => d.dataset.pc));
    $('#node-pass-make').disabled = !pcs.length;
    $('#node-pass-nodes').replaceChildren(...(pcs.length ? pcs.map(p => el('div', { class: 'node-pass-pc' },
      el('label', { class: 'check node-pass-pcname' }, el('input', { type: 'checkbox', value: `pc:${p.id}`, 'data-pc': p.id, checked: ticked.has(`pc:${p.id}`) }), ' ', el('b', { text: p.self ? `This PC (${app.pcLabel('here')})` : app.pcLabel?.(p.id) || p.name }), el('span', { class: 'hint', text: passPcSpecs(p) })),
      // The models are one press away: a PC with many would otherwise list them all, again, for every pass.
      el('details', { class: 'net-more node-pass-models', 'data-pc': p.id, open: openPcs.has(p.id) || p.models.some(m => ticked.has(`m:${p.id}:${m.id}`)) }, el('summary', { text: `Models (${p.models.length})` }), ...passModelCols(p, ticked))))
      : [el('p', { class: 'hint', text: 'Turn on "Enable this PC as a node", or link a node under Find other PCs, to make a guest pass for it.' })]));
  }
}

/**
 * What tells a PC on the guest pass form apart, as the left panel says it: its computer name or address when two share
 * a name, its RAM and card memory, and its make and model ("256 GB / 12 GB VRAM · HP Z820").
 */
function passPcSpecs(p) {
  const hw = app.status?.hardware;
  const mem = p.self ? (hw?.ram?.total ? { ram: hw.ram.total, vram: hw.gpu && !hw.gpu.shared ? hw.gpu.total : 0 } : null) : homeUi.pcMem?.[p.id];
  const bits = [p.self ? '' : pcTwinWords()[p.id] ?? '', mem?.ram ? memWords(mem.ram, mem.vram) : '', pcMake(p.self ? 'here' : p.id)].filter(Boolean);
  return bits.length ? ` · ${bits.join(' · ')}` : '';
}

/**
 * One PC's models on the guest pass form: chat models in the left column, picture models in the right, each a tick, with
 * the advice for a shared network above them (each model loaded takes its own memory on that PC).
 */
function passModelCols(p, ticked) {
  if (!p.models.length) return [el('p', { class: 'hint', text: p.self ? 'No models on this PC yet.' : 'No models there yet, or it has not answered since it was linked.' })];
  const tick = m => el('label', { class: 'check' }, el('input', { type: 'checkbox', value: `m:${p.id}:${m.id}`, 'data-pc-model': p.id, 'data-model': m.id, checked: ticked.has(`m:${p.id}:${m.id}`) }), ` ${m.name}`);
  const col = (title, list) => el('div', { class: 'node-pass-col' }, el('b', { text: title }), ...(list.length ? list.map(tick) : [el('span', { class: 'hint', text: 'None' })]));
  return [
    el('p', { class: 'hint node-pass-warn', text: '(!) With several people on the network, share one model per PC: each model in use takes its own memory there, so two at once can slow or stop both.' }),
    el('div', { class: 'node-pass-cols' }, col('Chat', p.models.filter(m => m.kind !== 'image')), col('Pictures', p.models.filter(m => m.kind === 'image'))),
  ];
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

/**
 * Test network: one line for each linked PC (does it answer, is its TOMLIN the same, which of its ticks stop something here)
 * and one for each pair this PC introduced (can they reach each other now). It only asks: nothing is changed on any PC.
 */
$('#node-test-net').addEventListener('click', async () => {
  const btn = $('#node-test-net');
  const out = $('#node-test-out');
  btn.disabled = true;
  out.hidden = false;
  out.replaceChildren(el('p', { class: 'hint', text: 'Testing every linked PC…' }));
  const row = (ok, name, text) => el('div', { class: 'pc-test-row' }, el('span', { class: 'sdot', 'data-state': ok ? 'on' : 'off', 'aria-hidden': 'true' }), el('strong', { text: name }), el('span', { class: 'hint', text }));
  try {
    const [{ pcs }, nodes] = await Promise.all([api('/api/nodes/others'), api('/api/nodes')]);
    const blocks = [['pull', 'Sharing of models'], ['receive', 'Accept models from linked PCs'], ['lend', 'Allow to be used as part of a cluster'], ['peer', 'Let PCs my host introduces connect directly']];
    const rows = pcs.map(p => {
      if (!p.ok) return row(false, p.name, `does not answer${p.error ? `: ${p.error}` : ''}`);
      const version = p.update ? `behind this PC (${p.version})` : p.pull ? `ahead of this PC (${p.version})` : p.version ? `same TOMLIN (${p.version})` : 'TOMLIN version not reported';
      const off = p.allow ? blocks.filter(([k]) => p.allow[k] === false).map(([, w]) => w) : [];
      return row(!p.update && !p.pull && !off.length, p.name, `answers · ${version}${off.length ? ` · off there: ${off.join(', ')}` : ''}`);
    });
    const byId = Object.fromEntries(pcs.map(p => [p.id, p]));
    const pairs = nodes.share?.peerLinks?.pairs ?? [];
    for (const pr of pairs) {
      const a = byId[pr.a.id];
      const b = byId[pr.b.id];
      const name = `${pr.a.name} and ${pr.b.name}`;
      if (!a?.ok || !b?.ok) { rows.push(row(false, name, 'cannot be tested while one of them is off')); continue; }
      try {
        const r = await api('/api/share', { peerCheck: { a: pr.a.id, b: pr.b.id } });
        const lines = r.peerCheck ?? [];
        rows.push(row(lines.length > 0 && lines.every(l => l.ok), name, lines.length ? lines.map(l => `${l.from} to ${l.to}: ${l.ok ? 'reached' : l.said || 'not reached'}`).join(' · ') : 'no answer'));
      } catch (e) {
        rows.push(row(false, name, e.message));
      }
    }
    const answering = pcs.filter(p => p.ok).length;
    const unpaired = answering > 1 && !pairs.length ? el('p', { class: 'hint', text: 'No two of these PCs are linked to each other directly yet.' }) : null;
    out.replaceChildren(...[...(pcs.length ? rows : [el('p', { class: 'hint', text: 'No other PCs linked yet.' })]), unpaired].filter(Boolean));
    drawOthers(pcs);
  } catch (e) {
    out.replaceChildren(el('p', { class: 'fault-line', role: 'alert', text: e.message }));
  }
  btn.disabled = false;
});

// "+ Add a node" on the Network map: Linked PCs, with the Add another PC fold open (it was a button under Guest passes,
// where it did not belong).
app.addNode = () => {
  netSection('linked');
  $('#net-add').open = true;
  $('#net-add').scrollIntoView({ block: 'start' });
};
// Linked PCs, Guest: connect to someone else's network with the guest pass they gave you: Add another PC, its address
// and code boxes open (the same link as a node's, with the guest pass code in the code box).
$('#net-join-guest').addEventListener('click', () => {
  app.addNode();
  $('#node-addr-box').open = true;
  $('#node-addr-box').scrollIntoView({ block: 'nearest' });
  $('#node-addr').focus();
});
// Guest passes: Create a guest pass opens its form.
$('#node-pass-create').addEventListener('click', e => {
  const form = $('#node-pass-new');
  form.hidden = !form.hidden;
  e.currentTarget.setAttribute('aria-expanded', String(!form.hidden));
  if (!form.hidden) $('#node-pass-label').focus();
});
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
  if (!label) return void (said.textContent = 'Give the pass the name of the person it is for first.');
  if (!nodes.length) return void (said.textContent = 'Tick at least one PC the pass is for.');
  if (!nodes.some(n => n.models.length)) return void (said.textContent = 'Tick at least one model the guest may use.');
  said.textContent = '';
  await nodeShare({ passMake: { label, length: $('#node-pass-length').value, nodes } }, r => {
    if (!r?.madePass) return;
    showPassCode(r.madePass);
    $('#node-pass-label').value = '';
    $('#node-pass-new').hidden = true;
    $('#node-pass-create').setAttribute('aria-expanded', 'false');
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
    for (const t of document.querySelectorAll('#node-allow [data-allow]')) t.checked = a[t.dataset.allow] === true;
    const all = $('#node-allow-all');
    all.checked = a.pull && a.backup && a.update && a.tune && a.receive && a.give && a.lend;
    all.indeterminate = !all.checked && (a.pull || a.backup || a.update || a.tune || a.receive || a.give || a.lend);
    if (sh.lend) lendIdleShown(sh.lend.idle);
    $('#node-plain-links').checked = sh.plainLinks === true;
  }
  // Lending (Cluster or Max mode): whom this PC lends its card memory to now, or how the last loan ended.
  const lend = sh.lend;
  const at = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  $('#node-lend-now').hidden = !lend?.to && !lend?.ended;
  $('#node-lend-now').textContent = lend?.to ? `Lending its card memory to "${lend.to}" since ${at(lend.since)}.` : lend?.ended ? `Last lent to "${lend.ended.to}": ended at ${at(lend.ended.at)} (${lend.ended.why}).` : '';
  // Run settings a linked PC changed here since TOMLIN started (newest first).
  const when = t => new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const changes = (sh.runChanges ?? []).slice(0, 3);
  // And the permissions a linked host changed here (src/permset.ts), so this PC's owner sees what was changed and by whom.
  const perms = (sh.permChanges ?? []).slice(0, 3);
  $('#node-run-changes').hidden = !changes.length && !perms.length;
  $('#node-run-changes').textContent = [...perms.map(c => `${c.said.replace(/\.$/, '')} on ${when(c.at)}.`), ...changes.map(c => `Guessing model for ${c.name} set to ${c.draftName || 'none'} by "${c.by}" on ${when(c.at)}.`)].join(' ');
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
  const now = Object.fromEntries([...document.querySelectorAll('#node-allow [data-allow]')].map(t => [t.dataset.allow, t.checked]));
  return nodeShare({ allow: { ...now, ...changed } });
}
for (const t of document.querySelectorAll('#node-allow [data-allow]')) t.addEventListener('change', () => saveAllow({}));
$('#node-allow-all').addEventListener('change', e => {
  saveAllow({ pull: e.target.checked, backup: e.target.checked, update: e.target.checked, tune: e.target.checked, receive: e.target.checked, give: e.target.checked, lend: e.target.checked });
});
/** The idle minutes: the control shows the chosen one, and a plain-text reading of the line gets it too (not all six choices run together). */
function lendIdleShown(minutes) {
  $('#node-lend-idle').value = String(minutes);
  $('#node-lend-idle-text').textContent = String($('#node-lend-idle').value);
}
$('#node-lend-idle').addEventListener('change', e => {
  lendIdleShown(e.target.value);
  nodeShare({ lendIdle: Number(e.target.value) });
});
// Allow unencrypted cluster links: asked once more before it goes on, as it opens this PC's model runner to the home network.
$('#node-plain-links').addEventListener('change', e => {
  if (e.target.checked && !confirm('Allow unencrypted cluster links?\n\nA linked PC that asks for it borrows this PC\'s card and RAM over a link that is not encrypted. Anything on your home network could then read it, or send this PC\'s model runner commands of its own.\n\nOnly on a wired home network you trust.')) {
    e.target.checked = false;
    return;
  }
  nodeShare({ plainLinks: e.target.checked });
});

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
    $('#node-pin-title').textContent = other ? `Enter pin for ${other}:` : `Type the app lock ${w}`;
    $('#node-pin-label').textContent = other ? 'PIN (or password)' : kind === 'password' ? 'Password' : 'PIN';
    // The button says what pressing it does: "Change it" read as changing the PIN (3 Nov).
    $('#node-pin-ok').textContent = other ? `Update "${other}"` : 'Apply the change';
    $('#node-pin-about').textContent = other
      ? 'To update, enter either your admin pin, or the individual pin for the node.'
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
        either.hidden = !(v.on && v.pcs.some(p => p.has && !p.holdsKey && p.name === other));
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
      nodePin = await askAppPin(tried ? e.message : '', pc.name, { button: `Shut down "${pc.name}"`, about: 'To shut down, enter either your admin pin, or the individual pin for the node.' });
      if (nodePin === null) return null;
    }
  }
}

// ---- That PC's permissions, changed from here (src/permset.ts): its owner's tick "Allow host to test and change model run
// settings" there, and its PIN (or the host PIN) typed here for each change. Never that tick itself. ----

/** The switches, in the order and words of that PC's own Network page (src/permset.ts PERM_KEYS, PERM_WORDS). */
const PERM_TICKS = [
  ['lend', 'Allow to be used as part of a cluster'],
  ['plainLinks', 'Allow unencrypted cluster links'],
  ['update', 'Allow host to update TOMLIN remotely'],
  ['off', 'Allow host to turn this PC off'],
  ['backup', 'Enable backups'],
  ['receive', 'Accept models from linked PCs'],
  ['give', 'Let linked PCs pull TOMLIN updates from here'],
  ['pull', 'Sharing of models'],
];
/** The PCs whose permissions fold is open: it stays open while Network draws the cards again. */
const permOpen = new Set();

/** One change to linked PC `pc`'s permissions, its PIN asked here (and again after a wrong one). Null on Cancel. */
async function permSetWithPin(pc, set) {
  let nodePin;
  for (;;) {
    try {
      return await api('/api/network/perm-set', nodePin === undefined ? { pc: pc.id, set } : { pc: pc.id, set, nodePin });
    } catch (e) {
      if (!e.data?.needNodePin) throw e;
      nodePin = await askAppPin(nodePin !== undefined ? e.message : '', pc.name, { button: 'Change it', about: `To change "${pc.name}"'s permissions, enter either your host PIN, or the PIN of that PC.` });
      if (nodePin === null) return null;
    }
  }
}

/** "Permissions on <PC>": its switches, as it said last, each changed there with a PIN; or why they cannot be. */
function permsPart(p) {
  if (!p.ok || !p.can?.includes('perm-set')) return null;
  const fold = el('details', { class: 'net-more node-perms' }, el('summary', { text: `Permissions on "${p.name}"` }));
  fold.open = permOpen.has(p.id);
  fold.addEventListener('toggle', () => (fold.open ? permOpen.add(p.id) : permOpen.delete(p.id)));
  if (p.allow?.tune !== true) {
    fold.append(el('p', { class: 'hint', text: `To change these from here, "${p.name}" ticks "Allow host to test and change model run settings" there first (Network, Sharing permissions). That one switch is only ever changed at that PC.` }));
    return fold;
  }
  const said = el('p', { class: 'hint', role: 'status' });
  const now = k => (k === 'plainLinks' ? p.plainOk === true : p.allow?.[k] === true);
  fold.append(el('p', { class: 'hint', text: 'Each change needs the host PIN or that PC\'s own PIN (none is asked when that PC holds this PC\'s host key), and is said on that PC\'s screen and in its log.' }),
    ...PERM_TICKS.map(([k, words]) => el('label', { class: 'node-role' }, el('input', { type: 'checkbox', checked: now(k), 'data-key': `perm:${p.id}:${k}`, onchange: async e => {
      const on = e.target.checked;
      if (k === 'plainLinks' && on && !confirm(`Allow unencrypted cluster links on "${p.name}"?\n\nA PC that asks for it borrows "${p.name}"'s card and RAM over a link that is not encrypted. Anything on your home network could then read it, or send its model runner commands of its own.\n\nOnly on a wired home network you trust.`)) {
        e.target.checked = false;
        return;
      }
      e.target.disabled = true;
      try {
        const r = await permSetWithPin(p, { [k]: on });
        if (!r) e.target.checked = !on;
        said.textContent = r ? r.said : 'Not changed (no PIN given).';
      } catch (err) {
        e.target.checked = !on;
        said.textContent = err.message;
      }
      e.target.disabled = false;
      refreshOthers();
    } }), ` ${words}`)), said);
  return fold;
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
  homeUi.drawn.paired = homeUi.drawn.passes = homeUi.drawn.passSync = homeUi.drawn.passAsks = homeUi.drawn.peers = null;
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
  $('#net-add').open = true;
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
  netSection('linked');
  $('#net-add').open = true;
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

/**
 * "Find it on my network", for a linked PC that is not answering: the home network is scanned and the PC is asked over
 * its own link at each TOMLIN found, so only that PC can be taken; its new address is saved (src/findagain.ts). `say`
 * shows the outcome; `done` redraws. Also on the PC window (pcs.js).
 */
function findAgainButton(p, say, done) {
  const b = el('button', { class: 'btn primary', type: 'button', text: 'Find it on my network', 'data-key': `find-again:${p.id}`, title: `Looks for "${p.name}" on your home network, in case the router gave it another address, and connects to it again there. No setup code is needed: only that PC can answer on its link.` });
  b.addEventListener('click', async () => {
    b.disabled = true;
    b.textContent = 'Looking…';
    say(`Looking for "${p.name}" on your home network. This takes a few seconds.`, false);
    try {
      const r = await api('/api/remotes', { action: 'find-again', id: p.id });
      say(r.note ?? `"${p.name}" was found.`, false);
    } catch (err) {
      say(err.message, true);
    }
    b.disabled = false;
    b.textContent = 'Find it on my network';
    done?.();
  });
  return b;
}
app.findAgainButton = findAgainButton;

/** What a linked PC is, from what it last reported: shown on hover of the (!) beside its name. */
function pcSpecs(p) {
  const total = bar => bar.segments.reduce((n, s) => n + s.bytes, 0);
  const lines = [
    p.memory?.ram?.bar ? `${NODE_GB(total(p.memory.ram.bar))} of RAM` : null,
    p.memory?.gpu ? `${p.memory.gpu.name}${p.memory.gpu.bar ? ` with ${NODE_GB(total(p.memory.gpu.bar))}` : ''}` : null,
    p.version ? `TOMLIN ${p.version}` : null,
  ].filter(Boolean);
  return lines.length ? lines : ['Nothing is known about this PC yet: it has not told this PC what it is.'];
}

function drawOthers(pcs) {
  homeUi.others = pcs;
  drawUpdateAll(pcs);
  app.drawNetMap?.();
  drawCluster(pcs, homeUi.cluster ?? { on: false, members: [] });
  // Each linked PC is a small tile; its whole card (memory, models, Hire staff, Remove...) opens above the tiles on request.
  const pcCard = p => {
    const mem = p.ok && p.memory?.ram?.bar;
    const away = p.ok && p.away ? new Date(p.away).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null;
    // A PC this one is a guest on says so, and when its pass ended (asked for more under Find PCs on my network).
    const guestEnd = p.role === 'guest' && p.passEnd ? (p.passEnd.state === 'expired' ? 'Guest: the pass ended. Ask the host for more time: press Find PCs on my network above.' : 'Guest: that PC no longer lets this one in.') : null;
    const asGuest = p.role === 'guest' ? ` (guest${p.expires ? `, until ${new Date(p.expires).toLocaleDateString()}` : ''}${p.caps ? `; answers up to ${p.caps.answer} tokens, prompts up to ${p.caps.prompt} characters` : ''})` : '';
    const inLine = p.ok && p.line && (p.line.running || p.line.waiting) ? ` Line there: ${p.line.running} running, ${p.line.waiting} waiting.` : '';
    const state = guestEnd ?? (away ? `Logged off since ${away}: "I need to log off for now"` : p.ok ? `${p.backupsOnly ? 'Keeps backups' : p.model ? `On: ${p.model}` : 'Asleep: no model loaded'}${asGuest}${inLine}` : p.relink || p.answered ? `Not linked any more: ${p.error} Find it again above, then Link again.` : 'Off: not answering');
    const back = away ? el('button', { class: 'btn primary', type: 'button', text: 'Start it again', 'data-key': `back:${p.id}` }) : null;
    // Off: perhaps the router gave it another address. Found on the home network over its own link (src/findagain.ts).
    const findAgain = !p.ok && !p.relink && !p.answered && !guestEnd ? findAgainButton(p, msg => sayHere($('#node-others-ask'), msg), () => {
      refreshOthers();
      refreshPcs();
    }) : null;
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
    // Unencrypted cluster link: asked for here, and only used when that PC's owner allows it there too.
    const plain = el('label', { class: 'node-role' }, el('input', { type: 'checkbox', checked: p.plainLink === true, disabled: p.backupsOnly === true || p.noBorrow === true, 'data-key': `plain-link:${p.id}`, onchange: async e => {
      const on = e.target.checked;
      if (on && !confirm(`Use an unencrypted cluster link with "${p.name}"?\n\nFaster: each step on the network took about half the time when measured (1.3 against 2.8 ms). But anything on your home network could read what goes between the PCs, or send "${p.name}"'s model runner commands of its own.\n\nOnly on a wired home network you trust. "${p.name}" must allow it too, and it applies from the next load.`)) {
        e.target.checked = false;
        return;
      }
      e.target.disabled = true;
      const box = $('#node-others-ask');
      try {
        await api('/api/remotes', { action: 'plain-link', id: p.id, on });
        sayHere(box, on ? `From the next load, the link to "${p.name}" is not encrypted${p.plainOk ? '' : ` once its owner ticks Allow unencrypted cluster links there; until then it stays sealed`}.` : `The link to "${p.name}" is encrypted again from the next load.`);
      } catch (err) {
        sayHere(box, `Unencrypted cluster link was not changed: ${err.message}`);
      }
      refreshOthers();
    } }), ' Unencrypted cluster link');
    plain.title = 'Ticked, and allowed on that PC too: Max mode and the cluster borrow over a link that is not encrypted. Faster on the network; anything on the home network could read or change it.';
    const plainLine = !p.ok || p.plainLink !== true ? null : el('span', { class: 'hint', role: 'status', text: p.plainNow ? 'Link: NOT encrypted now (both PCs chose it).' : p.plainOk ? 'Link: unencrypted from the next load (both PCs chose it).' : `Link: sealed. "${p.name}" has not ticked Allow unencrypted cluster links.` });
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
        // What tells two PCs of the same name apart: its address, and on hover of the (!) what it is (as on Models on my other PCs).
        el('span', { class: 'net-spec', tabindex: '0', role: 'img', 'aria-label': `About ${p.name}: ${pcSpecs(p).join(', ')}`, title: pcSpecs(p).join('\n'), text: '(!)' }),
        el('span', { class: 'hint', text: `· ${p.url.replace(/^https?:\/\//, '')}` })),
      el('span', { class: 'hint node-state', text: state }),
      // Behind this PC (a lower version, or the same one with different files): "Update it" sends this PC's TOMLIN there
      // (it starts the new version by itself), or why not.
      // An update going there now (or coming here from it): said, with its steps screen, in place of Update it.
      p.updating ? el('div', { class: 'node-update' },
        el('span', { class: 'hint', role: 'status' }, el('span', { class: 'net-spin', 'aria-hidden': 'true' }), p.updating.kind === 'pull' ? `Updating this PC to ${p.updating.what} from it now.` : `Updating to ${p.updating.what} now.`),
        el('button', { class: 'btn', type: 'button', text: 'See progress', 'data-key': `updating:${p.id}`, onclick: () => app.showUpdate?.(p.updating.id) })) : null,
      p.ok && p.update && !p.updating ? el('div', { class: 'node-update' },
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
      p.ok && p.pull && !p.updating ? el('div', { class: 'node-update' },
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
      el('div', { class: 'node-role-row' }, role, borrow, plain, disk),
      lendLine,
      plainLine,
      permsPart(p),
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
                m.kind !== 'image' && m.cache && p.can?.includes('cache-set') && p.allow?.tune ? cachePick(p, m) : null,
                m.kind !== 'image' && p.can?.includes('tune') ? el('div', { class: 'guess-pick' }, app.finderButton(`remote:${p.id}:${m.id}`, { name: m.name, pcName: p.name, link: true })) : null);
            })))),
          p.models.some(m => m.guessers?.length) && !p.allow?.tune ? el('span', { class: 'hint', text: `To pick a Guessing model from here, "${p.name}" ticks "Allow host to test and change model run settings" there first (Network, Sharing permissions).` }) : null,
          el('div', { class: 'team-actions' }, el('button', { class: 'btn', type: 'button', text: 'Hire staff on it', 'data-key': `hire:${p.id}`, title: `Opens Hire staff with ${p.name} picked: then choose one of its models`, onclick: () => app.openHire?.({ pc: p.id }) })))
        : el('span', { class: 'hint', text: 'Lets this PC use: no models yet, as that PC has none. Send one there from Models.' })) : null,
      // How fast its loaded model answers for this PC (its answers here are timed; Test speed runs the example prompt there).
      p.ok && p.model && !away && !p.backupsOnly ? el('span', { class: 'hint' }, p.speed?.expect ? `Speed: ${app.speedWords(p.speed.expect)} (${p.speed.basis === 'answers' ? `the average of ${p.speed.average.n} answers` : 'tested'}) · ` : 'Speed: not measured yet · ', app.speedLink(`remote:${p.id}`, msg => sayHere($('#node-others-ask'), msg), refreshOthers)) : null,
      // Lets go of the models it loaded for linked PCs now (not after its idle minutes), so another can load there. It never
      // cuts one answering or drawing, nor one its own owner loaded; it needs the owner's tick, and says why not in its words.
      el('div', { class: 'team-actions' }, back, findAgain, p.ok && !away && !p.backupsOnly && p.can?.includes('tune') && (p.model || p.image?.model || p.models?.some(m => m.loaded)) ? el('button', { class: 'btn', type: 'button', text: 'Free its memory', 'data-key': `free:${p.id}`, title: `Lets "${p.name}" unload the models it loaded for linked PCs, now, so another model can load there. One answering or drawing is left to finish.`, onclick: async e => {
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
  };
  homeUi.pcCard = pcCard;
  const stateOf = p => (p.ok && !p.away ? (p.model ? 'on' : 'asleep') : 'off');
  const wordOf = p => (!p.ok ? (p.seenAt ? `Off, last seen ${new Date(p.seenAt).toLocaleDateString([], { day: 'numeric', month: 'short' })}` : 'Off') : p.away ? 'Logged off' : p.backupsOnly ? 'On: backups' : p.model ? 'On' : 'Asleep');
  const tiny = p => {
    const ram = p.memory?.ram?.bar ? NODE_GB(p.memory.ram.bar.segments.reduce((n, x) => n + x.bytes, 0)) : null;
    const gpu = p.memory?.gpu?.name ? p.memory.gpu.name.replace(/^NVIDIA\s+(GeForce\s+)?/i, '') : null;
    return [ram, gpu].filter(Boolean).join(' · ');
  };
  const find = $('#pc-find');
  find.hidden = pcs.length < 6;
  const q = find.hidden ? '' : $('#node-pc-find').value.trim().toLowerCase();
  const want = find.hidden ? '' : $('#node-pc-status').value;
  const shown = pcs.filter(p => (!q || `${p.name} ${p.url}`.toLowerCase().includes(q)) && (!want || stateOf(p) === want));
  keepFocus($('#node-others'), pcs.length ? (shown.length ? shown.map(p => el('button', { class: 'pc-tile', type: 'button', 'data-key': `tile:${p.id}`, title: `Open ${p.name}: memory, models, Hire staff, Remove`, onclick: () => openPcDetail(p.id) },
    el('span', { class: 'sdot', 'data-state': stateOf(p), 'aria-hidden': 'true' }),
    el('span', { class: 'pc-tile-name' }, el('strong', { text: p.name }), ' ', el('span', { class: 'hint', text: p.url.replace(/^https?:\/\//, '') })),
    el('span', { class: 'hint pc-tile-state', text: wordOf(p) }),
    tiny(p) ? el('span', { class: 'hint pc-tile-tiny', text: tiny(p) }) : null)) : [el('p', { class: 'hint', text: 'No linked PC matches.' })]) : [el('p', { class: 'hint', text: 'No other PCs linked yet.' })]);
  // An open card is drawn again from the newest answer (and closed when its PC is gone).
  const open = homeUi.pcOpen && pcs.find(p => p.id === homeUi.pcOpen);
  if (homeUi.pcOpen && !open) closePcDetail();
  else if (open) {
    $('#pc-detail-title').textContent = open.name;
    keepFocus($('#pc-detail-body'), [pcCard(open)]);
  }
}
function openPcDetail(id) {
  homeUi.pcOpen = id;
  $('#pc-detail').hidden = false;
  drawOthers(homeUi.others ?? []);
  $('#pc-detail').scrollIntoView({ block: 'nearest' });
}
function closePcDetail() {
  homeUi.pcOpen = null;
  $('#pc-detail').hidden = true;
  $('#pc-detail-body').replaceChildren();
}
$('#pc-detail-close').addEventListener('click', closePcDetail);
$('#node-pc-find').addEventListener('input', () => drawOthers(homeUi.others ?? []));
$('#node-pc-status').addEventListener('change', () => drawOthers(homeUi.others ?? []));

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

/**
 * A linked PC's chat model: how it keeps its context there, the cache type and RAM or the card (kept in that PC's own
 * settings, behind its owner's tick). A long context on a small card can push the model's weights off the card: the
 * cache in RAM, or a smaller one, gives them back.
 */
function cachePick(p, m) {
  const box = $('#node-others-ask');
  const send = async (body, undo) => {
    sel.disabled = ram.disabled = true;
    try {
      sayHere(box, (await api('/api/network/run-set', { pc: p.id, model: m.id, ...body })).said);
    } catch (err) {
      undo();
      sayHere(box, err.message);
    }
    sel.disabled = ram.disabled = false;
    refreshOthers();
  };
  const sel = el('select', { 'data-key': `cache:${p.id}:${m.id}`, 'aria-label': `Memory for the context of ${m.name} on ${p.name}` },
    ...[['f16', 'Full size (f16)'], ['q8_0', 'Half (q8_0, almost no loss)'], ['q4_0', 'Quarter (q4_0, some loss)']].map(([v, t]) => el('option', { value: v, text: t, selected: v === m.cache })));
  sel.addEventListener('change', () => send({ cache: sel.value }, () => (sel.value = m.cache)));
  const ram = el('input', { type: 'checkbox', 'data-key': `kvram:${p.id}:${m.id}`, checked: m.kvRam === true });
  ram.addEventListener('change', () => send({ kvRam: ram.checked }, () => (ram.checked = m.kvRam === true)));
  return el('div', { class: 'guess-pick' },
    el('label', {}, 'Memory for the context', sel),
    el('label', { class: 'check', title: 'The context cache is kept in RAM there, not on its graphics card, so the card keeps its room for the model. Reading a long prompt can be slower.' }, ram, ' Keep the context in RAM'));
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
  app.pcModelsInto?.($('#node-models'), $('#node-models-ask'), $('#thispc-roles'));
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
  // The ticks are on the Sharing page; shown first so "hidden" below means "this PC is not a node".
  netSection('sharing');
  // Drawn from the server's answer first, so the ticks are found where they are now (not where the last draw left them).
  await refreshNodes();
  const off = !!$('#node-allow').closest('[hidden]');
  // Not a node: the switch and the reason are on This PC.
  if (off) netSection('pc');
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
    // An unsigned zip on a PC with the app lock: the PIN (or password) is asked, and asked again after a wrong one.
    let appPin;
    let r;
    for (;;) {
      try {
        r = await api('/api/install/zip-go', { version: z.version, anyway: z.signed === false, ...(appPin === undefined ? {} : { appPin }) });
        break;
      } catch (e) {
        if (!e.data?.needPin) throw e;
        appPin = await askAppPin(appPin === undefined ? '' : e.message, undefined, { about: 'A zip that is not signed by TOMLIN\'s maker is installed only with the app lock PIN (or password).', button: 'Install anyway' });
        if (appPin === null) {
          installSaid('');
          sayHere(box, 'Not updated: no PIN was typed.');
          return;
        }
      }
    }
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
  const buttons = ['#node-update-all', '#node-fast-update', '#rail-fast-update', '#net-push-updates'].map(q => $(q)).filter(Boolean);
  for (const x of buttons) x.disabled = true;
  updateAllFaults = '';
  const failed = [];
  let can = [];
  try {
    can = ((await api('/api/nodes/others')).pcs ?? []).filter(p => p.ok && p.update && !p.update.why && !p.updating);
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
  const holders = new Set((hp?.pcs ?? []).filter(x => x.has && !x.holdsKey).map(x => x.id));
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
  // On Manage updates too, under Push updates to network: what could not start, or nothing when all did.
  if (updateAllFaults && $('#net-push-line')) $('#net-push-line').textContent = updateAllFaults;
  // The updates under way show in Models on my other PCs, each with its own line.
  if (failed.length < Math.max(can.length, 1)) app.openNet?.();
  for (const x of buttons) x.disabled = false;
  refreshOthers();
}

// The top of the Network page: Scan for hardware changes (this PC and every linked PC read their hardware again,
// src/jobrun/hwscan.ts). Manage updates: Push updates to network (the same run as Update all linked PCs).
$('#net-hw-scan').addEventListener('click', async e => {
  const b = e.currentTarget;
  const said = $('#net-head-said');
  b.disabled = true;
  said.hidden = false;
  said.textContent = 'Reading the hardware of this PC and each linked PC…';
  try {
    const r = await api('/api/network/hardware-scan', {});
    said.textContent = r.said;
    // This PC's new figures come with the next status (every second); the linked PCs' are read again now.
    refreshOthers();
  } catch (err) {
    said.textContent = err.message;
  }
  b.disabled = false;
});
$('#net-push-updates').addEventListener('click', () => updateAllLinked());

/** The linked PCs this one can update now (behind it, and nothing stopping it), on the Update all button. */
function drawUpdateAll(pcs) {
  // One already being updated is not counted: it shows "Updating" on its card, with See progress.
  const can = pcs.filter(p => p.ok && p.update && !p.update.why && !p.updating);
  const stuck = pcs.filter(p => p.ok && p.update?.why);
  const off = pcs.filter(p => !p.ok).length;
  const b = $('#node-update-all');
  // Fast update: at the right of the Linked PCs heading, only while some linked PC can be updated now.
  const fast = $('#node-fast-update');
  b.disabled = !can.length;
  b.textContent = can.length ? `Update all linked PCs (${can.length})` : 'Update all linked PCs';
  const push = $('#net-push-updates');
  if (push) push.textContent = can.length ? `Push updates to network (${can.length})` : 'Push updates to network';
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

/** What the last admin-access step said. */
let hostKeySaid = '';
async function hostKeyDo(action, ask) {
  if (ask && !confirm(ask)) return;
  try {
    const r = await api('/api/network/host-pin', { action });
    hostKeySaid = r.missed?.length ? `Not answering now, so still holding the key until their owner takes it away there (Network): ${r.missed.join(', ')}.` : action === 'key-off' ? 'Turned off.' : action === 'key-on' ? 'Turned on.' : 'Made a new key. Each PC takes it the next time its own app lock PIN is typed here.';
  } catch (e) {
    hostKeySaid = e.message;
  }
  drawHostPin();
}
$('#host-key-new').addEventListener('click', () => hostKeyDo('key-reset', 'Make a new key?\n\nThe linked PCs that hold the old one ask for their own app lock PIN once more, and then take the new one.'));
$('#host-key-off').addEventListener('click', () => hostKeyDo('key-off', 'Turn admin access off?\n\nThe key is taken away here and from every linked PC that answers now. Each then asks for its own app lock PIN again to be updated, turned off or to delete a model.'));
$('#host-key-on').addEventListener('click', () => hostKeyDo('key-on'));

/** The host PIN's row under Linked PCs: whether one is set here, and which linked PCs hold it (as each last said). */
async function drawHostPin() {
  const v = await api('/api/network/host-pin', { action: 'view' }).catch(() => null);
  if (!v) return;
  const names = list => list.map(p => `"${p.name}"`).join(', ');
  const has = v.pcs.filter(p => p.has && !p.holdsKey);
  const lack = v.pcs.filter(p => p.can && !p.has);
  const old = v.pcs.filter(p => p.heard && !p.can);
  // Admin access: the host key (no PIN typed), used only while this PC is unlocked.
  if (v.key) {
    const keyed = v.pcs.filter(p => p.keyHeld);
    const waiting = v.pcs.filter(p => p.can && !p.keyHeld && !(v.on && p.has && !p.holdsKey));
    $('#host-key-line').textContent = v.key.on
      ? `Unlocking TOMLIN here lets this PC update, turn off or delete models on the linked PCs, with no PIN typed.${keyed.length ? ` ${keyed.length} of ${v.pcs.length} linked PC${v.pcs.length > 1 ? 's' : ''} hold${keyed.length > 1 ? '' : 's'} this PC's key.` : ''}`
      : 'Off: each linked PC asks for its own app lock PIN to be updated, turned off or to delete a model.';
    $('#host-key-pcs').textContent = v.key.on ? [
      keyed.length ? `Holding the key: ${names(keyed)}.` : '',
      waiting.length ? `Not yet: ${names(waiting)}. Each takes it the first time its own app lock PIN is typed here for an update, a delete or a turn-off.` : '',
    ].filter(Boolean).join(' ') : '';
    $('#host-key-new').hidden = !(v.key.on && v.key.made);
    $('#host-key-off').hidden = !v.key.on;
    $('#host-key-on').hidden = v.key.on;
    $('#host-key-said').textContent = hostKeySaid;
    $('#host-key-said').hidden = !hostKeySaid;
  }
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
