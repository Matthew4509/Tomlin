// Chats: "+ New chat" in the left panel (who with?); the previous chats in the Chats tab on the right of the chat,
// under the project each belongs to (open one and carry on, rename, delete); the chat pane's title. Each chat is its own file on the server (/api/chats); pictures drawn in a chat belong to it,
// and the Images pane shows "This chat" or "All chats" (images.js). Uses app.js's helpers (el, api, showChat,
// loadModels) and home.js's (setView, plainWho, refresh, keepFocus, timeText, homeUi, phone).
'use strict';

/**
 * `recent`: "Recent chats" in the left panel, from the server (src/chats.ts recentEntries); `openProjects`: the projects
 * unfolded there; `previews`: each project's picture time, icon and short description (src/previews.ts).
 */
const chatUi = { list: [], people: [], current: '', all: false, open: null, projects: [], recent: [], openProjects: new Set(), previews: {} };
const kindOf = who => (String(who).startsWith('staff:') || String(who).startsWith('node:') ? who : 'manager');

async function loadChats() {
  try {
    const d = await api('/api/chats');
    chatUi.list = d.chats;
    chatUi.recent = d.recent ?? [];
    chatUi.previews = d.previews ?? {};
    chatUi.people = d.people;
    // The chat on this window's screen; before one is drawn, the one the server reopens (another window may open others).
    chatUi.current = app.chatId ?? d.current;
    // The projects a chat can belong to (the jobs in the workspace that are not hidden), by name.
    // and the ones saved on Home that are not planned yet.
    const j = await api('/api/jobs').catch(() => null);
    const planned = (j?.jobs ?? []).filter(x => !x.hidden).map(x => ({ id: x.id, name: x.name || x.goal, folder: x.folder || '' }));
    chatUi.projects = [...planned, ...(j?.unplanned ?? []).filter(x => !planned.some(p => p.id === x.id)).map(x => ({ id: x.id, name: x.name || x.goal, folder: '' }))];
  } catch {
    // The top bar says when the server is not answering; the list keeps what it had.
  }
  drawChats();
  // The head may have been drawn before the people were known.
  drawHead();
}
app.loadChats = loadChats;

/** The project a chat is under in the Chats tab: its own, or Default (none, or one no longer in the workspace). */
const chatGroup = c => chatUi.projects.find(p => p.id === c.project) ?? null;

// ---- Chats with people who left the team: "Name (left the team)" with their picture; they can be hidden (kept in this
// browser) or cleared together, which asks first. ----
const HIDE_LEFT_KEY = 'tomlin.hideLeftChats';
chatUi.hideLeft = (() => { try { return localStorage.getItem(HIDE_LEFT_KEY) === '1'; } catch { return false; } })();
/** Whether a chat shows in the lists now (a leaver's is hidden while the switch is on; the open one always shows). */
const chatShown = c => !(chatUi.hideLeft && c.left && c.id !== chatUi.current);
/** Their round picture, a little faded when they left the team. */
function chatAvatar(c) {
  const a = app.avatar(c.who, c.avatar);
  if (c.left) a.classList.add('left-team');
  return a;
}

/** Above the Chats tab's list when any chat is with someone who left: the Hide switch and Clear them. */
function leftChatsBar() {
  const n = chatUi.list.filter(c => c.left).length;
  if (!n) return null;
  const tick = el('input', { type: 'checkbox', checked: chatUi.hideLeft });
  tick.addEventListener('change', () => {
    chatUi.hideLeft = tick.checked;
    try { localStorage.setItem(HIDE_LEFT_KEY, tick.checked ? '1' : '0'); } catch { /* a private window: not kept */ }
    drawChats();
  });
  const clear = el('button', { class: 'link', type: 'button', text: `Clear them (${n})`, title: 'Delete every chat with someone who left the team: it asks first' });
  clear.addEventListener('click', () => clearLeftChats(n));
  return el('li', { class: 'side-left-bar', 'data-key': 'left-bar' },
    el('label', { class: 'check' }, tick, ` Hide chats from people who left (${n})`), ' ', clear);
}

async function clearLeftChats(n) {
  const ask = typeof askPopup === 'function' ? askPopup : (t, x) => Promise.resolve(confirm(`${t}\n\n${x}`));
  const yes = await ask(`Clear ${n} chat${n === 1 ? '' : 's'} from people who left?`,
    `Every chat with someone no longer on the team is deleted for good, with their photos. Pictures drawn in those chats stay in the gallery.`,
    'Clear them', 'Keep them');
  if (!yes) return;
  try {
    const d = await api('/api/chats/delete-left', {});
    chatUi.list = d.chats;
    chatUi.recent = d.recent ?? [];
    chatUi.people = d.people;
    if (chatUi.open && !d.chats.some(c => c.id === chatUi.open.id)) showChat(await app.chatAgain());
    await app.loadFaces?.();
    drawChats();
    app.chatNote?.(`${d.removed} chat${d.removed === 1 ? '' : 's'} from people who left ${d.removed === 1 ? 'was' : 'were'} cleared.`);
  } catch (e) {
    app.chatNote?.(`Nothing was cleared: ${e.message}`);
  }
}

function drawChats() {
  // faces.js (which draws the photos) may still be loading when the first list arrives: draw once the page has loaded.
  if (!app.avatar) { window.addEventListener('load', drawChats, { once: true }); return; }
  // Every chat is in the left panel's Recent chats (See all lists them all); the right-hand Chats tab is gone.
  drawSubjects();
  drawRecent();
}
app.drawChats = drawChats;

// ---- The left panel's "Recent chats": a project is one entry (its newest chat shown; one press shows all its chats,
// pinned first, then newest), a chat in no project is its own; latest use first, pinned on top (src/chats.ts
// recentEntries). Five besides the pinned ones; See all lists every chat. ----

const RAIL_RECENT_SHOWN = 5;
/** The most rows the list shows in all, pinned ones counted: many pinned chats once pushed it to 13 and more. */
const RAIL_RECENT_MOST = 8;
const MORE_RAIL_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';
/** A small pin beside a pinned entry (not colour alone). */
const pinMark = () => el('span', { class: 'rail-pin', title: 'Pinned to the top', 'aria-label': 'Pinned' }, app.lineIcon(...app.PIN_ICON));
function drawRecent() {
  const inChat = homeUi.view === 'chat';
  const byId = new Map(chatUi.list.map(c => [c.id, c]));
  const row = (c, inProject = false) => {
    const b = el('button', { class: `rail-row rail-recent-row${inProject ? ' rail-in-project' : ''}`, type: 'button', 'data-key': `recent:${c.id}`, 'aria-current': inChat && c.id === chatUi.current ? 'true' : null, title: `${c.title}\nWith ${c.name}\n${timeText(c.updated)}` },
      chatAvatar(c),
      el('span', { class: 'rail-text' }, el('span', { class: 'rail-name', text: c.title }), el('span', { class: 'rail-sub', text: c.name })),
      c.pinned ? pinMark() : null);
    // The picture: their window (New chat, Edit staff, Resume chat, their recent chats); the rest of the row opens the chat.
    const person = () => app.openPerson(c.who, c.name, { resume: c.id });
    b.title += `\nPress the picture: new chat, edit staff, resume chat`;
    b.addEventListener('click', e => (e.target.closest('.rail-avatar') ? person() : openChat(c.id)));
    // The … beside a chat: Pin or Unpin, Delete (the same window as the chat's own menu), and the person's window.
    const more = el('button', { class: 'rail-edit rail-more', type: 'button', title: `"${c.title}": pin, unpin or delete`, 'aria-label': `More for the chat ${c.title}`, 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
    more.innerHTML = MORE_RAIL_ICON;
    more.addEventListener('click', () => railMenu(more, [
      [`${c.name}: new chat, edit staff…`, person],
      [c.pinned ? 'Unpin' : inProject ? 'Pin to the top of its project' : 'Pin to the top', () => pinChat(c, !c.pinned)],
      ['Delete…', () => askDelete(c), true],
    ]));
    return el('li', { class: 'rail-staff-item' }, b, more);
  };
  // A project: its name and its newest chat; one press shows (or folds) all its chats under it.
  const projectRows = e => {
    const name = chatUi.projects.find(p => p.id === e.project)?.name || 'A project';
    const newest = byId.get(e.newest);
    const open = chatUi.openProjects.has(e.project);
    const here = inChat && e.chats.includes(chatUi.current);
    const n = e.chats.length;
    const b = el('button', { class: 'rail-row rail-project-row', type: 'button', 'data-key': `project:${e.project}`, 'aria-expanded': String(open), 'aria-current': here && !open ? 'true' : null, title: `${name}: ${n} chat${n === 1 ? '' : 's'}. Press to ${open ? 'fold them away' : 'show them all'}.` },
      el('span', { class: 'rail-fold-mark', 'aria-hidden': 'true', text: open ? '▾' : '▸' }),
      el('span', { class: 'rail-text' }, el('span', { class: 'rail-name', text: `${name} (${n})` }), el('span', { class: 'rail-sub', text: newest ? `${newest.title} · ${newest.name}` : '' })),
      e.pinned ? pinMark() : null);
    b.addEventListener('click', () => {
      if (open) chatUi.openProjects.delete(e.project);
      else chatUi.openProjects.add(e.project);
      drawRecent();
    });
    const more = el('button', { class: 'rail-edit rail-more', type: 'button', title: `"${name}": a new chat in it, open most recent, pin or unpin`, 'aria-label': `More for the project ${name}`, 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
    more.innerHTML = MORE_RAIL_ICON;
    more.addEventListener('click', () => railMenu(more, [
      ...(newest ? [['New chat', () => newInProject(e.project, newest.who)], ['Open most recent', () => openChat(newest.id)]] : []),
      [e.pinned ? 'Unpin' : 'Pin to the top', () => pinProject(e.project, !e.pinned)],
    ]));
    return [el('li', { class: 'rail-staff-item' }, b, more), ...(open ? e.chats.map(id => byId.get(id)).filter(Boolean).map(c => row(c, true)) : [])];
  };
  // A leaver's chat is left out while Hide is on (a project keeps the chats still shown, and goes when none are).
  const entries = (chatUi.recent ?? []).flatMap(e => {
    if (e.kind !== 'project') return !byId.has(e.id) || chatShown(byId.get(e.id)) ? [e] : [];
    const kept = e.chats.filter(id => !byId.has(id) || chatShown(byId.get(id)));
    return kept.length ? [{ ...e, chats: kept, newest: kept.includes(e.newest) ? e.newest : kept[0] }] : [];
  });
  const most = Math.min(RAIL_RECENT_MOST, entries.filter(e => e.pinned).length + RAIL_RECENT_SHOWN);
  const shown = entries.slice(0, most);
  const rows = shown.flatMap(e => (e.kind === 'project' ? projectRows(e) : byId.has(e.id) ? [row(byId.get(e.id))] : []));
  keepFocus($('#rail-recent'), rows.length ? rows : [themeWords.put(el('li', { class: 'rail-empty hint' }), 'no-chats', 'No chats yet.')]);
  // See all: the All chats page (every chat, with search and filters); shown whenever there is a chat to list.
  $('#rail-recent-all').hidden = !chatUi.list.length;
  if (homeUi.view === 'allchats') drawAllChats();
}

/** New chat, from a project's menu in Recent chats: a new chat in that project, with whoever its most recent chat is with. */
async function newInProject(project, who) {
  try {
    await showOpened(await api('/api/chats/new', { who, plain: plainWho(), project }));
  } catch (e) {
    app.chatNote?.(e.message);
  }
}
async function pinProject(project, on) {
  try {
    const d = await api('/api/chats/pin-project', { project, on });
    chatUi.list = d.chats;
    chatUi.recent = d.recent ?? [];
    drawChats();
  } catch (e) {
    app.chatNote?.(e.message);
  }
}
/** A small menu under a … button: [words, what it does, danger] rows; Escape or a press elsewhere closes it. */
let railMenuOpen = null;
function railMenu(button, rows) {
  const was = railMenuOpen;
  railMenuOpen?.close();
  if (was?.button === button) return;
  const menu = el('div', { class: 'rail-menu', role: 'menu' }, ...rows.map(([text, go, danger]) => el('button', { class: `rail-menu-item${danger ? ' danger' : ''}`, type: 'button', role: 'menuitem', text, onclick: () => {
    close();
    go();
  } })));
  const r = button.getBoundingClientRect();
  menu.style.top = `${Math.round(r.bottom + 4)}px`;
  menu.style.left = `${Math.round(Math.max(8, r.right - 180))}px`;
  const away = e => {
    if (!menu.contains(e.target) && e.target !== button && !button.contains(e.target)) close();
  };
  const key = e => {
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    const at = items.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      close();
      button.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
    } else if (e.key === 'Tab') close();
  };
  function close() {
    menu.remove();
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', away, true);
    document.removeEventListener('keydown', key, true);
    if (railMenuOpen?.menu === menu) railMenuOpen = null;
  }
  document.body.append(menu);
  // Kept inside the window at the foot of the screen.
  const h = menu.getBoundingClientRect().height;
  if (r.bottom + 4 + h > innerHeight - 8) menu.style.top = `${Math.round(Math.max(8, r.top - h - 4))}px`;
  button.setAttribute('aria-expanded', 'true');
  document.addEventListener('pointerdown', away, true);
  document.addEventListener('keydown', key, true);
  railMenuOpen = { menu, button, close };
  menu.querySelector('[role="menuitem"]')?.focus();
}

async function pinChat(c, on) {
  try {
    const d = await api('/api/chats/pin', { id: c.id, on });
    chatUi.list = d.chats;
    chatUi.recent = d.recent ?? [];
    drawChats();
  } catch (e) {
    app.chatNote?.(e.message);
  }
}
// "Recent chats" starts open; folding it is kept in this browser.
$('#rail-recent-fold').open = store('recent-open') !== '0';
$('#rail-recent-fold').addEventListener('toggle', e => store('recent-open', e.target.open ? '1' : '0'));
// See all: the All chats page.
$('#rail-recent-all').addEventListener('click', () => app.openAllChats());

// ---- All chats (a page): search, Project and Staff filters, then a tile for each chat ----
// A tile: the subject, the staff member and their model, the project (or Default) and when; hovering shows the chat's
// first message, its first 100 characters (src/chats.ts previewOf). Pressing it opens the chat.
// `shown`: tiles drawn so far. Thousands at once took seconds to draw (and again on each left-panel redraw), so 60 are
// drawn, then 60 more each time the end of the list scrolls into view (or Show more is pressed).
const ALL_PAGE = 60;
const allUi = { q: '', project: '*', who: '*', shown: ALL_PAGE };
function fillPick(sel, options, now) {
  const want = options.some(o => o[0] === now) ? now : '*';
  sel.replaceChildren(...options.map(([value, text]) => el('option', { value, text })));
  sel.value = want;
  return want;
}
function drawAllChats() {
  const visible = chatUi.list.filter(chatShown);
  const projects = [...new Map(visible.map(c => { const g = chatGroup(c); return [g?.id ?? '', g?.name ?? 'Default']; })).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  allUi.project = fillPick($('#allchats-project'), [['*', 'All projects'], ...projects], allUi.project);
  const people = [...new Map(visible.map(c => [c.who, c.name])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  allUi.who = fillPick($('#allchats-staff'), [['*', 'All staff'], ...people], allUi.who);
  const words = allUi.q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = visible.filter(c => {
    const g = chatGroup(c);
    if (allUi.project !== '*' && (g?.id ?? '') !== allUi.project) return false;
    if (allUi.who !== '*' && c.who !== allUi.who) return false;
    const hay = `${c.title} ${c.name} ${g?.name ?? 'Default'} ${c.preview ?? ''}`.toLowerCase();
    return words.every(w => hay.includes(w));
  });
  const tile = c => {
    const person = chatUi.people.find(p => p.who === c.who);
    const model = person ? modelWords(person) : '';
    const g = chatGroup(c);
    const b = el('button', { class: 'allchats-tile', type: 'button', 'data-key': `all:${c.id}`, title: c.preview ? `${c.preview}${c.preview.length >= 100 ? '…' : ''}` : 'No message yet' },
      el('span', { class: 'allchats-who' }, chatAvatar(c), el('span', { class: 'allchats-name', text: model ? `${c.name} · ${model}` : c.name })),
      el('b', { class: 'allchats-subject', text: c.title }),
      el('span', { class: 'allchats-mini', text: c.preview || 'No message yet' }),
      el('span', { class: 'allchats-where', text: `${g?.name ?? 'Default'} · ${timeText(c.updated)}` }));
    b.addEventListener('click', () => openChat(c.id));
    return el('li', {}, b);
  };
  $('#allchats-left').replaceChildren(...[leftChatsBar()].filter(Boolean));
  $('#allchats-count').textContent = hits.length === visible.length ? `${visible.length} chat${visible.length === 1 ? '' : 's'}` : `${hits.length} of ${visible.length} chats`;
  const left = hits.length - allUi.shown;
  const more = left > 0 ? el('li', { class: 'allchats-more' }, el('button', { class: 'btn', type: 'button', 'data-key': 'all:more', text: `Show more (${left} left)`, onclick: showMoreChats })) : null;
  keepFocus($('#allchats-tiles'), hits.length ? [...hits.slice(0, allUi.shown).map(tile), more] : [el('li', { class: 'home-empty', text: visible.length ? 'No chat matches. Try fewer words, or All projects and All staff.' : 'No chats yet. Press "New chat" to start one.' })]);
  // The row on the page (an unchanged list is not drawn again, so it may be the earlier one).
  moreSeen.disconnect();
  const live = $('#allchats-tiles .allchats-more');
  if (live) moreSeen.observe(live);
}
function showMoreChats() {
  allUi.shown += ALL_PAGE;
  drawAllChats();
}
// The Show more row scrolling into view draws the next 60 by itself.
const moreSeen = new IntersectionObserver(seen => {
  if (homeUi.view === 'allchats' && seen.some(x => x.isIntersecting)) showMoreChats();
}, { rootMargin: '200px' });
app.openAllChats = () => {
  allUi.shown = ALL_PAGE;
  setView('allchats');
  drawAllChats();
};
// A new search or filter starts again from the top 60.
$('#allchats-search').addEventListener('input', e => { allUi.q = e.target.value; allUi.shown = ALL_PAGE; drawAllChats(); });
$('#allchats-project').addEventListener('change', e => { allUi.project = e.target.value; allUi.shown = ALL_PAGE; drawAllChats(); });
$('#allchats-staff').addEventListener('change', e => { allUi.who = e.target.value; allUi.shown = ALL_PAGE; drawAllChats(); });

// ---- Which project a chat's work belongs to: Default (the chats by date) or one of the projects ----

function drawChatProject(chat) {
  const row = $('#chat-project-row');
  row.hidden = !chat || chat.here === false;
  if (row.hidden) return;
  const sel = $('#chat-project');
  const known = chatUi.projects.some(p => p.id === chat.project);
  sel.replaceChildren(el('option', { value: '', text: 'Default' }), ...chatUi.projects.map(p => el('option', { value: p.id, text: p.name.length > 50 ? `${p.name.slice(0, 50)}…` : p.name })), el('option', { value: NEW_PROJECT, text: '+ New project…' }));
  sel.value = known ? chat.project : '';
}
/** The last choice in a chat's project list: a window asks the name, the project is made and the chat put in it. */
const NEW_PROJECT = '+new';
const newProjectDlg = $('#project-new');
$('#project-new-form').addEventListener('submit', async e => {
  e.preventDefault();
  const chat = chatUi.open;
  const say = $('#project-new-fault');
  say.hidden = true;
  if (!chat) return newProjectDlg.close();
  try {
    const made = await api('/api/projects/create', { name: $('#project-new-name').value, fromChat: true });
    await loadChats();
    newProjectDlg.close();
    await putInProject(chat, made.id);
  } catch (err) {
    say.textContent = err.message;
    say.hidden = false;
  }
});
$('#project-new-cancel').addEventListener('click', () => newProjectDlg.close());
// Closed without a project made (Cancel, Escape): the list shows the chat's own project again.
newProjectDlg.addEventListener('close', () => {
  if (chatUi.open) drawChatProject(chatUi.open);
});
$('#chat-project').addEventListener('change', async () => {
  const chat = chatUi.open;
  if (!chat) return;
  if ($('#chat-project').value === NEW_PROJECT) {
    $('#project-new-name').value = '';
    $('#project-new-fault').hidden = true;
    newProjectDlg.showModal();
    $('#project-new-name').focus();
    return;
  }
  await putInProject(chat, $('#chat-project').value);
});
/** The chat into a project ('' = Default): its files move with it (the server says so), and the lists are drawn again. */
async function putInProject(chat, project) {
  try {
    const r = await api('/api/chats/project', { id: chat.id, project });
    chatUi.open = { ...chat, project: r.chat.project, saveTo: r.chat.saveTo };
    chatUi.list = r.chats;
    chatUi.recent = r.recent ?? [];
    // Its project opens in Recent chats, so the chat is seen where it went.
    if (project) chatUi.openProjects.add(project);
    drawChats();
    drawChatProject(chatUi.open);
    if (r.said) app.chatNote?.(r.said);
  } catch (e) {
    app.chatNote?.(e.message);
    drawChatProject(chat);
  }
}
/**
 * Where Save on a code block in the open chat puts the file (src/folders.ts): a chat in Default its own chats folder, a
 * chat in a project that project's folder, a writer's or artist's chat its specialists folder, named with the date and time.
 */
app.chatSaveTo = () => chatUi.open?.saveTo ?? null;

/**
 * A chat kept to read (`chat` given: its person left the team, or was a linked PC's hire) or not (null). Send, Connect,
 * Quick/Think, Web, Add a document and Memory are hidden (style.css #pane-chat.read-only), the box cannot be typed in,
 * and one line above the buttons says why.
 */
function readOnly(chat) {
  const on = !!chat;
  $('#pane-chat').classList.toggle('read-only', on);
  $('#chat-input').readOnly = on;
  $('#chat-send').disabled = on;
  let line = $('#read-only-line');
  if (!line && on) {
    line = el('p', { class: 'hint read-only-line', id: 'read-only-line', role: 'status' });
    $('#chat-form .chat-actions').before(line);
  }
  if (!line) return;
  line.hidden = !on;
  if (!on) return;
  const who = String(chat.name ?? '').replace(/ \(left the team\)$/, '');
  line.textContent = String(chat.who ?? '').startsWith('node:')
    ? 'Kept to read: this hire worked on a linked PC, which no longer lends staff, so nothing can be sent here. Press New chat to talk to someone.'
    : chat.who === 'manager' ? 'Kept to read: the host is off for now, so nothing can be sent here. Press New chat to talk to someone.'
    : `Kept to read: ${who && who !== 'Someone who left the team' ? who : 'this person'} left the team, so nothing can be sent here. Press New chat to talk to someone.`;
}

/** The chat whose name is being changed in the head now (titleEdit, below), or ''. */
let titleEditing = '';
/** The head's words: the chat's name, who it is with and where their last answer ran ("Rowan · Coder · on laptop 9B"). */
function drawHead() {
  const chat = chatUi.open;
  const who = chat ? chat.who : kindOf(app.models?.settings?.who ?? 'standard');
  const person = chatUi.people.find(p => p.who === who);
  // Who the open chat is with (Save and Copy the whole chat name their answers with it).
  app.chatPerson = person ?? null;
  $('#chat-title').textContent = chat?.title ?? 'New chat';
  $('#chat-title').title = chat?.title ?? 'A new chat: the first message names it';
  // A rename under way stays open while the same chat is redrawn; another chat on screen ends it.
  if (!titleEditing || titleEditing !== chat?.id) titleEdit(false);
  // Like a Staff overview card: name · software, the PC under it; the speed, then the chat's name, in the next column.
  const gone = chat && !chat.here;
  const software = !person || gone ? '' : modelWords(person);
  const pc = !person || gone ? '' : person.pc === 'this PC' ? 'This PC' : person.pc;
  // Kept to read: their name as it was ("Cy Holt (left the team)"), and nothing that sends, loads or answers (readOnly).
  const listed = gone ? chatUi.list.find(c => c.id === chat.id) : null;
  $('#chat-name').textContent = gone ? listed?.name ?? 'Someone who left the team' : person ? person.name : '';
  readOnly(gone ? listed ?? chat : null);
  // Their model was deleted (or is no longer lent): said plainly, with Fix, which opens Edit staff at their model.
  const deleted = !gone && person?.use?.state === 'missing' && String(person.who).startsWith('staff:');
  // The name, and the model under it cut to its first 10 characters; hovering shows the name, the whole model and the PC.
  $('#chat-software').textContent = deleted ? ' · model was deleted ' : '';
  $('#chat-fix')?.remove();
  if (deleted) $('#chat-software').after(el('button', { class: 'btn pick-model', type: 'button', id: 'chat-fix', text: 'Fix', title: `Give ${person.name} a model: it loads when you send the first message`, onclick: () => app.editStaff?.(person.who.slice('staff:'.length), { pick: true }) }));
  $('#chat-pc').textContent = deleted ? '' : software.length > 10 ? `${software.slice(0, 10)}…` : software;
  // Whole, for the top of a saved chat (app.js chatText).
  $('#chat-who-box').dataset.full = software && !deleted ? `${person.name} · ${software} on ${pc}` : $('#chat-with').textContent;
  $('#chat-who-box').title = software ? `${person.name} · ${software}\n${pc}${app.lastRan ? `\nThe last answer ran on ${app.lastRan}.` : ''}` : $('#chat-name').textContent;
  drawChatProject(chat);
  if (chat && !chat.here) $('#chat-input').placeholder = READ_ONLY_BOX;
  // A hire who lives on another PC answers there: this PC's own model controls have nothing to do with this chat. So
  // does a hire here given one of a linked PC's models (it loads there when needed).
  const away = String(who).startsWith('node:') && !!person;
  const pcId = away ? String(who).split(':')[1] : (chat?.here !== false && person?.pcId) || '';
  $('#pane-chat').classList.toggle('away-chat', !!pcId);
  nodeMeters(pcId, String(who ?? ''));
  $('#chat-menu-open').hidden = !chat;
  // One pane at a time: an artist's chat is the pictures pane (what you type there is drawn as typed); anyone else's is
  // the chat. The pictures pane's head says whose chat it is, like the chat's.
  const artist = person?.kind === 'image';
  $('#panes').dataset.show = artist ? 'image' : 'chat';
  $('#image-title').textContent = chat?.title ?? (artist ? 'New chat' : 'Pictures');
  $('#image-with').textContent = artist ? `With ${person.name} · ${person.role.replace(/ · draws what you ask$/, '')} · ${person.model} on ${person.pc} · draws your words just as you type them` : '';
  $('#image-with').title = $('#image-with').textContent;
  $('#image-menu-open').hidden = !chat;
  $('#img-prompt-label').textContent = artist ? `What should ${person.name.split(/\s+/)[0]} draw?` : 'What to draw';
  $('#draw-as-row').classList.toggle('in-chat', artist);
  drawSubjects();
}

// ---- A chat with someone on a linked PC: the top bar shows that PC (its name, the model loaded there, its meters) ----

/**
 * A snapshot every 3 s while the chat is on screen (none while the tab is hidden, and never two at once). That PC
 * measures itself every second anyway for its own top bar; asking only reads the last figure, so it costs it nothing
 * to speak of. A PC whose TOMLIN is too old to share them is asked once (the bar says so while the chat is open).
 */
const meters = { pc: '', who: '', timer: 0, asking: false };
const chatOnScreen = () => !document.hidden && !!$('#pane-chat').getClientRects().length;
async function askMeters() {
  const pc = meters.pc;
  // Only while the chat is on screen: Home, Jobs or Nodes in front (or a hidden tab) asks nothing, so a node can drop
  // a model loaded for this PC once nobody here has the chat open (it waits 60 s). The bar shows this PC meanwhile.
  if (!pc || !chatOnScreen()) return app.showBarPc?.(null);
  if (meters.asking) return;
  meters.asking = true;
  try {
    // Who the chat is with: that PC keeps only their model loaded while the chat is open, not every model it loaded here.
    const r = await api(`/api/node/stats?pc=${encodeURIComponent(pc)}&who=${encodeURIComponent(meters.who)}`);
    if (pc !== meters.pc || !chatOnScreen()) return;
    app.showBarPc?.(r.state === 'gone' ? null : r);
    // Too old to share them: asked once, not every 3 s (the bar keeps saying so).
    if (r.state === 'old' || r.state === 'gone') {
      clearInterval(meters.timer);
      meters.timer = 0;
    }
  } catch {
    // The page is locked or TOMLIN stopped: the next tick tries again.
  } finally {
    meters.asking = false;
  }
}
function nodeMeters(pc, who = '') {
  meters.who = who;
  if (pc === meters.pc) return;
  clearInterval(meters.timer);
  meters.pc = pc;
  meters.timer = 0;
  // A chat on this PC: the bar is this PC's again at once.
  app.showBarPc?.(null);
  if (!pc) return;
  askMeters();
  meters.timer = setInterval(askMeters, 3000);
}
// Back on screen, or back to the chat from Home: a fresh snapshot at once, not up to 3 s later; away from the chat, this
// PC's bar at once.
document.addEventListener('visibilitychange', askMeters);
app.onView = view => (view === 'chat' ? askMeters() : app.showBarPc?.(null));

// ---- Subjects (the panel on the right): the chats with the person open now, each named for what it is about ----

/** Who the chat pane is with now: the open chat's person, or the one picked when no chat is open yet. */
const subjectWho = () => chatUi.open?.who ?? kindOf(app.models?.settings?.who ?? 'standard');
app.chatWho = subjectWho;

/** In the host's chat, the model picked or connected there becomes the host's own (its pencil shows the same). */
app.chatModelPicked = async id => {
  if (!id || subjectWho() !== 'manager') return;
  await api('/api/settings', { hostModel: id }).catch(() => undefined);
  if (app.models?.settings) app.models.settings.hostModel = id;
};

// The "!" beside Subject name: what a subject is, shown and hidden in place.
$('#subject-info').addEventListener('click', () => {
  const text = $('#subject-info-text');
  text.hidden = !text.hidden;
  $('#subject-info').setAttribute('aria-expanded', String(!text.hidden));
});

/** Create new subject's project: the chat it was drawn for, and the project picked by hand (null: none picked). */
let subjectChat = null;
let subjectPick = null;
$('#subject-project').addEventListener('change', e => {
  subjectPick = e.target.value;
});

function drawSubjects() {
  const who = subjectWho();
  const person = chatUi.people.find(p => p.who === who);
  // Before the people are known (the page is still loading) nothing is said about who this is.
  const known = chatUi.people.length > 0;
  $('#subjects-with').textContent = person ? `A new subject with ${app.inSentence(person.name)}.` : known ? 'They are no longer on the team: no new subject can be made with them.' : '';
  $('#subjects-with').hidden = !$('#subjects-with').textContent;
  $('#subjects-now').textContent = chatUi.open?.title ?? '';
  $('#subjects-new').hidden = !person;
  // The project a new subject goes in: the open chat's, so the writer's and the artist's chats for one project stay together.
  const sel = $('#subject-project');
  const before = sel.value;
  sel.replaceChildren(el('option', { value: '', text: 'Default' }), ...chatUi.projects.map(p => el('option', { value: p.id, text: p.name.length > 40 ? `${p.name.slice(0, 40)}…` : p.name })));
  const openId = chatUi.open?.id ?? null;
  const own = chatGroup(chatUi.open ?? {})?.id ?? '';
  // A project picked by hand is kept while the same chat is open, and into an empty chat in no project (a new chat
  // with the next person): the writer's and then the artist's subject for one project need it picked once.
  const listed = chatUi.list.find(c => c.id === openId);
  const blank = !own && !listed?.messages;
  // Another chat opened: an empty one in no project carries on in the project shown before (picked or not).
  if (subjectChat !== openId) subjectPick = blank && before ? before : null;
  subjectChat = openId;
  sel.value = subjectPick !== null && [...sel.options].some(o => o.value === subjectPick) ? subjectPick : own;
}

function subjectsSay(text, fault = false) {
  const note = $('#subjects-note');
  note.textContent = text;
  note.classList.toggle('fault', fault);
  note.hidden = !text;
}

$('#subjects-new').addEventListener('submit', async e => {
  e.preventDefault();
  subjectsSay('');
  const box = $('#subject-name');
  try {
    const project = $('#subject-project').value;
    // chatId: the chat on screen, which takes the name when it is still empty (not the one another window opened).
    const r = await api('/api/chats/new', { who: subjectWho(), plain: plainWho(), title: box.value, project, chatId: app.chatId ?? '' });
    box.value = '';
    await showOpened(r);
    const where = chatUi.projects.find(p => p.id === project)?.name ?? 'Default';
    subjectsSay(r.existed ? `"${r.chat.title}" was already a subject in ${where}: it is open now.` : `"${r.chat.title}" is made, in ${where}. It is in the Chats tab.`);
  } catch (err) {
    subjectsSay(err.message, true);
  }
});

// ---- Tools | Staff overview: tabs on the right of the chat (the one picked is kept in this browser) ----

const sideTabs = [$('#tab-tools'), $('#tab-staff')];
function sideTab(tab, focus = false) {
  for (const t of sideTabs) {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    $(`#${t.getAttribute('aria-controls')}`).hidden = !on;
  }
  if (focus) tab.focus();
  try {
    localStorage.setItem('sm-side-tab', tab.id);
  } catch {
    // not kept: Tools opens first next time
  }
}
for (const t of sideTabs) {
  t.addEventListener('click', () => sideTab(t));
  t.addEventListener('keydown', e => {
    const i = sideTabs.indexOf(t);
    const n = sideTabs.length;
    const to = e.key === 'ArrowRight' ? sideTabs[(i + 1) % n] : e.key === 'ArrowLeft' ? sideTabs[(i + n - 1) % n] : e.key === 'Home' ? sideTabs[0] : e.key === 'End' ? sideTabs[n - 1] : null;
    if (!to) return;
    e.preventDefault();
    sideTab(to, true);
  });
}
try {
  const kept = sideTabs.find(t => t.id === localStorage.getItem('sm-side-tab'));
  if (kept) sideTab(kept);
} catch {
  // Tools first
}

// A wide screen starts with the panel hidden, a thin strip at the right with one arrow, and the chat takes its room;
// opened with the arrow, it stays open in this browser until hidden again. A narrow one folds it to one line above the chat.
const subjectsWide = window.matchMedia('(min-width: 901px)');
const SIDE_OPEN_KEY = 'tomlin-chat-side-open';
function sideKeptOpen() {
  try {
    return localStorage.getItem(SIDE_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}
function subjectsFit() {
  $('#subjects-fold').open = subjectsWide.matches && sideKeptOpen();
  $('#subjects').classList.toggle('folded', subjectsWide.matches && !$('#subjects-fold').open);
}
subjectsWide.addEventListener('change', subjectsFit);
$('#subjects-fold').addEventListener('toggle', e => {
  if (!subjectsWide.matches) return;
  $('#subjects').classList.toggle('folded', !e.target.open);
  try {
    localStorage.setItem(SIDE_OPEN_KEY, e.target.open ? '1' : '0');
  } catch {
    // kept for this visit only
  }
});
$('#subjects-hide').addEventListener('click', () => { $('#subjects-fold').open = false; });
subjectsFit();

/** "The host" mid-sentence is "the host" (a name given to it stays as typed). */
app.inSentence = name => (name === 'The host' ? 'the host' : name);

/** Said when a picture is asked for outside an artist's chat: who draws, and where to find them. */
app.artistPointer = () => {
  const names = chatUi.people.filter(p => p.kind === 'image').map(p => p.name.split(/\s+/)[0]);
  if (!names.length) return 'Pictures are drawn by an artist. Hire one in Settings, Hire staff, New (pick the role Artist), then open their chat and type what to draw: the words go to the picture model just as you type them.';
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : `your artist, ${names[0]}`;
  return `Pictures are drawn by ${list}. Open ${names[0]} in the left panel (or New chat, then ${names[0]}) and type what to draw: the words go to the picture model just as you type them.`;
};

/** An artist's chat: their latest one opens (or a new one when there is none), in the pictures pane. */
app.openArtist = async who => {
  await loadChats();
  const last = chatUi.list.find(c => c.who === who);
  await showOpened(last ? await api('/api/chats/open', { id: last.id, plain: plainWho() }) : await api('/api/chats/new', { who, plain: plainWho() }));
};
$('#image-menu-open').addEventListener('click', () => $('#chat-menu-open').click());

/** The chat pane's head: the chat's name and who it is with ("New chat" until the first message names it). */
app.onChat = chat => {
  chatUi.open = chat;
  const changed = (chat?.id ?? '') !== (app.chatId ?? '');
  app.chatId = chat?.id ?? '';
  drawHead();
  app.drawAvatar?.();
  if (changed) app.chatChanged?.();
  // The office in Staff overview follows the person this chat is with, at once.
  const person = app.chatPersonId?.();
  if (changed && person) app.office?.follow(person);
  if (chatUi.current !== app.chatId) {
    chatUi.current = app.chatId;
    drawChats();
  }
};
// A new answer says where it ran: the head shows it at once.
app.onBrain = ran => {
  app.lastRan = ran ?? '';
  app.onChat(chatUi.open);
};
// After a message: the chat may have just been made (and named), and it moves to the top of the list.
// `id`: the chat sent to, read by its id; `from`: the chat on screen when it was sent ('' = not made yet), and `who`: the
// person it was with. Shown only while this window is still there: a chat opened meanwhile (or in another window) is not
// taken away, and that includes another person's chat not made yet.
app.afterSend = async (id = app.chatId ?? '', from = id, who = '') => {
  await loadChats();
  if (!id) return;
  const r = await api(`/api/chat?id=${encodeURIComponent(id)}`).catch(() => null);
  const now = app.chatId ?? '';
  if (r?.chat && (now === id || (now === from && (from || !who || who === app.chatWho?.())))) app.onChat(r.chat);
};

/**
 * Shows a chat the server just opened (or made): its lines, its person's model in the list, its pictures. Each opening
 * is numbered: one pressed after it wins, so a slow one finishing late never shows the chat before over it.
 */
let openTurn = 0;
async function showOpened(r, turn = ++openTurn) {
  await loadModels();
  if (turn !== openTurn) return;
  if (r.model) await useModelOf({ model: r.model, kind: 'chat' });
  // An artist's chat: their picture model is picked in the pictures pane (Connect is still pressed by hand), and they draw.
  if (r.imageModel && app.status?.panes.image.state === 'disconnected' && [...panes.image.model.options].some(o => o.value === r.imageModel && !o.disabled)) {
    panes.image.model.value = r.imageModel;
    await api('/api/settings', { pane: 'image', model: r.imageModel }).catch(() => undefined);
  }
  if (turn !== openTurn) return;
  showChat(r);
  // Then the lists that are slow to come (Draw as asks every linked PC about its staff): they follow, not hold it up.
  app.drawAs?.();
  loadChats();
  // Its answer is still coming, started from another window (or before a reload): it is shown once it is finished
  // (home.js watches Home's working list). One streaming in this window carries on in the chat by itself (app.js).
  // A chat answer still being written is followed live (showChat, app.js); a picture still being drawn shows when done.
  app.awaitAnswer = r.answering && !r.chat.live && !app.liveChat?.(r.chat.id) ? r.chat.id : '';
  if (app.awaitAnswer) app.chatNote(`${app.inSentence(chatUi.people.find(p => p.who === r.chat.who)?.name ?? 'They')} is still answering here: the answer shows when it is finished.`);
  setView('chat');
  if (!phone.matches) ($('#panes').dataset.show === 'image' ? $('#img-prompt') : $('#chat-input')).focus();
  refresh();
}

async function openChat(id) {
  // Numbered when pressed, not when the answer comes: a slow chat pressed first never shows over one pressed after it.
  const turn = ++openTurn;
  try {
    const r = await api('/api/chats/open', { id, plain: plainWho() });
    if (turn !== openTurn) return;
    await showOpened(r, turn);
  } catch (e) {
    if (e.status === 404) await loadChats();
    app.chatNote?.(e.message);
    setView('chat');
  }
}
app.openChat = openChat;
app.showOpened = showOpened;

// ---- New chat: who with? ----

/** A hire's model in words, as the server decides it for every screen (src/hiremodel.ts); the host's as before. */
function modelWords(p) {
  // A model on a linked PC: its name alone (the card's own "Runs on" line names the PC).
  if (p.use?.state === 'pc' && p.use.name) return p.use.name;
  return p.use ? (p.use.state === 'none' ? 'No model is loaded here' : p.use.text) : p.model === 'no model given' ? 'the model loaded here' : p.model;
}

function drawPeople() {
  // The search box only when there are more than 6 to pick from.
  $('.new-chat-find').hidden = chatUi.people.length <= 6;
  const words = ($('.new-chat-find').hidden ? '' : $('#new-chat-search').value).toLowerCase().split(/\s+/).filter(Boolean);
  const matches = p => words.every(w => `${p.name} ${p.role} ${modelWords(p)} ${p.pc}`.toLowerCase().includes(w));
  const list = chatUi.people.filter(matches).map(p => {
    // A profile card: photo, name, role, model, node.
    const b = el('button', { class: 'person-card', type: 'button', 'data-key': `who:${p.who}`, title: p.hint },
      app.avatar(p.who, p.avatar),
      el('span', { class: 'person-name', text: p.name }),
      el('span', { class: 'person-role', text: p.role }),
      el('span', { class: 'person-line' }, el('span', { class: 'person-label', text: 'Model' }), el('span', { class: p.use?.pick ? 'model-gone' : '', text: p.use?.state === 'missing' ? 'Model deleted or missing' : modelWords(p) })),
      el('span', { class: 'person-line' }, el('span', { class: 'person-label', text: 'Runs on' }), el('span', { text: p.pc })),
      el('span', { class: 'person-go', text: p.kind === 'image' ? 'Draw' : 'Chat' }));
    const li = el('li', {}, b);
    // The manager answers to the name given to it.
    if (p.who === 'manager') {
      const input = el('input', { type: 'text', maxlength: '30', autocomplete: 'off', 'aria-label': 'Its name', placeholder: 'The host' });
      if (p.named) input.value = p.name;
      const form = el('form', { class: 'pick-name' },
        el('label', { class: 'field grow' }, el('span', { text: 'The name it answers to' }), input),
        el('button', { class: 'btn', type: 'submit', text: 'Save the name' }));
      form.hidden = true;
      form.addEventListener('submit', async e => {
        e.preventDefault();
        const fault = $('#new-chat-fault');
        fault.hidden = true;
        try {
          const d = await api('/api/names', { who: p.who, name: input.value });
          chatUi.people = d.people;
          chatUi.list = d.chats;
          chatUi.recent = d.recent ?? chatUi.recent;
          drawChats();
          drawHead();
          refresh();
          drawPeople();
        } catch (err) {
          fault.textContent = err.message;
          fault.hidden = false;
        }
      });
      li.append(el('button', { class: 'link pick-rename', type: 'button', text: 'Change name', onclick: e => { form.hidden = false; e.target.hidden = true; input.focus(); input.select(); } }));
      li.append(form);
    }
    b.addEventListener('click', () => startChat(p.who, b));
    // They cannot answer as they are (no model loaded and none of their own, or theirs is gone): say so, and offer the fix.
    return li;
  });
  if (!list.length && words.length && chatUi.people.length) list.push(el('li', { class: 'hint', text: 'Nobody matches. Try fewer words.' }));
  else if (!list.length && chatUi.nobody) {
    list.push(el('li', { class: 'person-none', id: 'new-chat-none' },
      el('p', { class: 'hint', text: chatUi.nobody }),
      el('button', { class: 'btn primary', type: 'button', text: 'Hire staff', onclick: () => $('#new-chat-team').click() })));
  }
  $('#new-chat-people').replaceChildren(...list);
}

async function startChat(who, button) {
  const fault = $('#new-chat-fault');
  fault.hidden = true;
  button.disabled = true;
  try {
    const r = await api('/api/chats/new', { who, plain: plainWho() });
    $('#new-chat').close();
    await showOpened(r);
  } catch (e) {
    fault.textContent = e.message;
    fault.hidden = false;
  } finally {
    button.disabled = false;
  }
}

// ---- A person pressed in the left panel: New chat on the left, their recent chats on the right ----

/** How many of their chats the window lists at first, newest first; Load more shows as many again. */
const RECENT_SHOWN = 12;
let personWho = '';
/** The chat Resume chat opens (the one whose picture was pressed in Recent chats), or ''. */
let personResume = '';
/** An artist's chats show no preview until Show preview is pressed; it stays on until the window closes (nothing saved). */
let personShowPreview = false;
const previewDay = at => new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const initialsOf = name => String(name).split(/\s+/).map(w => w[0] ?? '').join('').slice(0, 2).toUpperCase() || '?';
/**
 * A chat's preview in its row: the day's picture of its project's site (press = bigger), else the site's icon, else the
 * project's initials. Nothing at all (no space kept) for a chat in no project, or an artist's before Show preview.
 */
function chatPreview(c, artist) {
  if (!c.project || (artist && !personShowPreview)) return null;
  const p = chatGroup(c);
  if (!p) return null;
  const v = chatUi.previews[c.project] ?? {};
  const q = `project=${encodeURIComponent(c.project)}`;
  if (v.at) {
    const when = `picture from ${previewDay(v.at)}`;
    const b = el('button', { class: 'person-chat-pic', type: 'button', title: `${p.name}: ${when}. Press to see it bigger.`, 'aria-label': `See the picture of ${p.name} bigger (${when})` },
      el('img', { src: `/api/previews/picture?${q}&at=${v.at}`, alt: '', loading: 'lazy' }),
      el('span', { text: previewDay(v.at) }));
    b.addEventListener('click', () => {
      $('#preview-big-title').textContent = p.name;
      $('#preview-big-img').src = `/api/previews/picture?${q}&at=${v.at}`;
      $('#preview-big-img').alt = `${p.name}, its site as it was then`;
      $('#preview-big-when').textContent = `This is the ${when}. A new one is taken in the background with the first message of the day in one of its chats, when its site is running.`;
      $('#preview-big').showModal();
    });
    return b;
  }
  const no = 'No picture yet: one is taken with the first message of the day in one of its chats, when its site is running.';
  if (v.icon) return el('span', { class: 'person-chat-pic', title: `${p.name}. ${no}` }, el('img', { class: 'pic-icon', src: `/api/previews/icon?${q}`, alt: '' }));
  return el('span', { class: 'person-chat-pic', title: `${p.name}. ${no}` }, el('span', { class: 'person-chat-initials', 'aria-hidden': 'true', text: initialsOf(p.name) }));
}
/**
 * A person's window: New chat, Edit staff (a hire), Resume chat (opened from one of their chats in Recent chats), then
 * their recent chats, each with its own Resume chat, and Load more.
 */
app.openPerson = async (who, name, opts = {}) => {
  personWho = who;
  personResume = opts.resume ?? '';
  // Off every time the window opens.
  if (!$('#person-chats').open) personShowPreview = false;
  await loadChats();
  if (personWho !== who) return;
  $('#person-chats-title').textContent = name;
  $('#person-chats-fault').hidden = true;
  $('#person-chats-face').replaceChildren(app.avatar ? app.avatar(who, name.slice(0, 2).toUpperCase()) : '');
  $('#person-chats-start').textContent = chatUi.people.find(p => p.who === who)?.kind === 'image' ? 'New chat (draw)' : 'New chat';
  $('#person-chats-edit').hidden = !(who.startsWith('staff:') && app.editStaff);
  $('#person-chats-resume').hidden = !personResume;
  const theirs = chatUi.list.filter(c => c.who === who).sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  const artist = chatUi.people.find(p => p.who === who)?.kind === 'image';
  $('#person-chats-show').hidden = !artist || personShowPreview || !theirs.some(c => chatGroup(c));
  const open = async id => {
    $('#person-chats').close();
    await openChat(id);
  };
  const row = c => {
    // Project name - subject - date; the whole row opens it, and so does its Resume chat button.
    const b = el('button', { class: 'person-chat', type: 'button', title: `${c.title}: ${c.messages} message${c.messages === 1 ? '' : 's'}` },
      el('span', { class: 'person-chat-project', text: chatGroup(c)?.name ?? 'Default' }),
      el('span', { class: 'person-chat-sep', text: ' - ', 'aria-hidden': 'true' }),
      el('span', { class: 'person-chat-title', text: c.title }),
      el('span', { class: 'person-chat-sep', text: ' - ', 'aria-hidden': 'true' }),
      el('span', { class: 'person-chat-date', text: timeText(c.updated) }),
      // The project's short description: "Project 2026-10-12-1422" alone says nothing.
      chatUi.previews[c.project]?.about ? el('span', { class: 'person-chat-about', text: chatUi.previews[c.project].about }) : null);
    b.addEventListener('click', () => open(c.id));
    return el('li', { class: 'person-chat-item' }, chatPreview(c, artist), b,
      el('button', { class: 'btn primary person-chat-resume', type: 'button', text: 'Resume chat', 'aria-label': `Resume chat: ${c.title}`, onclick: () => open(c.id) }));
  };
  const list = $('#person-chats-list');
  const draw = shown => {
    const rows = theirs.slice(0, shown).map(row);
    if (!rows.length) rows.push(el('li', { class: 'hint', text: `No chats with ${name} yet.` }));
    else if (theirs.length > shown) {
      rows.push(el('li', { class: 'person-chat-more' }, el('button', { class: 'link', type: 'button', text: `Load more (${theirs.length - shown} older)`, onclick: () => {
        draw(shown + RECENT_SHOWN);
        list.querySelectorAll('.person-chat')[shown]?.focus();
      } })));
    }
    list.replaceChildren(...rows);
  };
  draw(RECENT_SHOWN);
  personDraw = draw;
  if (!$('#person-chats').open) $('#person-chats').showModal();
  (personResume ? $('#person-chats-resume') : $('#person-chats-start')).focus();
};
/** Redraws the person window's list (Show preview). */
let personDraw = null;
$('#person-chats-show').addEventListener('click', () => {
  personShowPreview = true;
  $('#person-chats-show').hidden = true;
  personDraw?.($('#person-chats-list').querySelectorAll('.person-chat').length || RECENT_SHOWN);
  $('#person-chats-list').querySelector('.person-chat-pic, .person-chat')?.focus();
});
// Closing the window hides an artist's previews again.
$('#person-chats').addEventListener('close', () => { personShowPreview = false; });
$('#person-chats-edit').addEventListener('click', () => {
  $('#person-chats').close();
  app.editStaff(personWho.slice('staff:'.length));
});
$('#person-chats-resume').addEventListener('click', async () => {
  $('#person-chats').close();
  await openChat(personResume);
});
$('#person-chats-start').addEventListener('click', async e => {
  const b = e.currentTarget;
  $('#person-chats-fault').hidden = true;
  b.disabled = true;
  try {
    const r = await api('/api/chats/new', { who: personWho, plain: plainWho() });
    $('#person-chats').close();
    await showOpened(r);
  } catch (err) {
    $('#person-chats-fault').textContent = `No new chat was started: ${err.message}`;
    $('#person-chats-fault').hidden = false;
  } finally {
    b.disabled = false;
  }
});

// The window opens at once with the people already known, then is drawn again once the lists are read fresh (that took
// a second with many chats). Only the first time, with nobody known yet, does it wait.
$('#rail-new').addEventListener('click', async () => {
  $('#new-chat-fault').hidden = true;
  $('#new-chat-search').value = '';
  if (!chatUi.people.length) await loadChats();
  drawPeople();
  if (!$('#new-chat').open) $('#new-chat').showModal();
  ($('.new-chat-find').hidden ? $('#new-chat-people button') : $('#new-chat-search'))?.focus();
  await loadChats();
  if ($('#new-chat').open) drawPeople();
});
// Search: by name, role or model; the cards that do not match are hidden.
$('#new-chat-search').addEventListener('input', () => drawPeople());
$('#new-chat-team').addEventListener('click', () => {
  $('#new-chat').close();
  $('#team-open').click();
});

// ---- The chat's name in its head: the pencil (or a press on the name) turns it into a box; Enter or leaving it
// saves, Esc puts it back ----

function titleEdit(on) {
  const chat = chatUi.open;
  const can = !!chat && chat.here !== false;
  on = on && can;
  titleEditing = on ? chat.id : '';
  $('#chat-title').hidden = on;
  $('#chat-title-edit').hidden = on || !can;
  $('#chat-title-form').hidden = !on;
  if (!on) return;
  $('#chat-title-input').value = chat.title;
  $('#chat-title-input').focus();
  $('#chat-title-input').select();
}
$('#chat-title-edit').addEventListener('click', () => titleEdit(true));
$('#chat-title').addEventListener('click', () => titleEdit(true));
$('#chat-title-input').addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  titleEdit(false);
  $('#chat-title-edit').focus();
});
$('#chat-title-input').addEventListener('blur', () => {
  if (titleEditing) $('#chat-title-form').requestSubmit();
});
$('#chat-title-form').addEventListener('submit', async e => {
  e.preventDefault();
  const chat = chatUi.open;
  const title = $('#chat-title-input').value.replace(/\s+/g, ' ').trim();
  titleEdit(false);
  // Left empty or unchanged: nothing to save.
  if (!chat || !title || title === chat.title) return;
  try {
    const r = await api('/api/chats/rename', { id: chat.id, title });
    await loadChats();
    app.onChat({ ...chatUi.open, ...r.chat });
  } catch (err) {
    app.chatNote?.(`The chat's name was not changed: ${err.message}`);
  }
});

// ---- This chat: rename or delete ----

function chatMenu() {
  const c = chatUi.list.find(x => x.id === app.chatId);
  if (!c) return;
  $('#chat-menu-title').textContent = c.title;
  $('#chat-menu-about').textContent = `With ${c.name}. Started ${timeText(c.created)}, ${c.messages} message${c.messages === 1 ? '' : 's'}${c.pictures ? `, ${c.pictures} picture${c.pictures > 1 ? 's' : ''}` : ''}.`;
  $('#chat-menu-fault').hidden = true;
  app.resetClear?.();
  $('#chat-rename-text').value = c.title;
  $('#chat-delete-about').textContent = c.pictures
    ? `Erase this entire chat. Its ${c.pictures} picture${c.pictures > 1 ? 's' : ''} can go with it, or stay under "All chats" in an artist's chat.`
    : 'Erase this entire chat';
  const go = (text, pictures, primary) => el('button', { class: `btn${primary ? ' danger' : ''}`, type: 'button', text, onclick: () => deleteChat(c, pictures) });
  $('#chat-delete-actions').replaceChildren(...(c.pictures
    ? [go(`Delete the chat and its ${c.pictures} picture${c.pictures > 1 ? 's' : ''}`, 'delete', true), go('Delete the chat, keep the pictures', 'keep')]
    : [go('Delete the chat', 'keep', true)]));
  // No mute here: the mute at the top of the page, and right-click on a chat in the list, do that.
  $('#chat-menu').showModal();
}
$('#chat-menu-open').addEventListener('click', async () => {
  await loadChats();
  chatMenu();
});

$('#chat-rename').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const r = await api('/api/chats/rename', { id: app.chatId, title: $('#chat-rename-text').value });
    $('#chat-menu').close();
    await loadChats();
    app.onChat({ ...chatUi.open, ...r.chat });
  } catch (err) {
    $('#chat-menu-fault').textContent = err.message;
    $('#chat-menu-fault').hidden = false;
  }
});

const TRASH = 'M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Zm4 2v8h2v-8h-2Zm4 0v8h2v-8h-2Z';
function trashIcon() {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', '16');
  s.setAttribute('height', '16');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('fill', 'currentColor');
  p.setAttribute('d', TRASH);
  s.append(p);
  return s;
}

/** "Delete this chat?" with the choice for its pictures: delete them too, or keep them (they stay under All chats). */
const delDlg = el('dialog', { class: 'small-dlg', 'aria-labelledby': 'del-title' });
document.body.append(delDlg);
function askDelete(c) {
  const n = c.pictures ?? 0;
  const fault = el('p', { class: 'fault', hidden: true });
  const go = async pictures => {
    try {
      await api('/api/chats/delete', { id: c.id, pictures });
      delDlg.close();
      await loadChats();
      // This window's chat stays on screen, unless it was the one deleted.
      showChat(c.id === app.chatId ? app.noChat() : await app.chatAgain());
      app.redrawGallery?.();
    } catch (err) {
      fault.textContent = err.message;
      fault.hidden = false;
    }
  };
  delDlg.replaceChildren(el('div', { class: 'help-body' },
    el('h2', { id: 'del-title', text: 'Delete this chat?' }),
    el('p', { text: `"${c.title}" with ${c.name}: all ${c.messages} message${c.messages === 1 ? '' : 's'} are deleted for good.` }),
    fault,
    el('div', { class: 'team-actions' },
      n ? el('button', { class: 'btn danger', type: 'button', text: `Delete it and its ${n} picture${n > 1 ? 's' : ''}`, onclick: () => go('delete') }) : el('button', { class: 'btn danger', type: 'button', text: 'Delete it', onclick: () => go('keep') }),
      n ? el('button', { class: 'btn', type: 'button', text: 'Delete it, keep the pictures', onclick: () => go('keep') }) : null,
      el('button', { class: 'btn quiet', type: 'button', text: 'Cancel', onclick: () => delDlg.close() }))));
  delDlg.showModal();
}

async function deleteChat(c, pictures) {
  try {
    await api('/api/chats/delete', { id: c.id, pictures });
    $('#chat-menu').close();
    await loadChats();
    showChat(c.id === app.chatId ? app.noChat() : await app.chatAgain());
    app.redrawGallery?.();
  } catch (err) {
    $('#chat-menu-fault').textContent = err.message;
    $('#chat-menu-fault').hidden = false;
  }
}

// app.js asks for the open chat before this file is read: when its answer came first, the head and the subject open now
// are drawn here.
loadChats().then(() => (chatUi.open ? null : api('/api/chat'))).then(r => {
  if (r?.chat && !chatUi.open) app.onChat(r.chat);
}).catch(() => undefined);
