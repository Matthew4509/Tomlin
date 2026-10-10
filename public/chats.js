// Chats: "+ New chat" in the left panel (who with?); the previous chats in the Chats tab on the right of the chat,
// under the project each belongs to (open one and carry on, rename, delete); the chat pane's title. Each chat is its own file on the server (/api/chats); pictures drawn in a chat belong to it,
// and the Images pane shows "This chat" or "All chats" (images.js). Uses app.js's helpers (el, api, showChat,
// loadModels) and home.js's (setView, plainWho, refresh, keepFocus, timeText, homeUi, phone).
'use strict';

const chatUi = { list: [], people: [], current: '', all: false, open: null, projects: [] };
const CHATS_SHOWN = 12;
const kindOf = who => (String(who).startsWith('staff:') || String(who).startsWith('node:') ? who : 'manager');

async function loadChats() {
  try {
    const d = await api('/api/chats');
    chatUi.list = d.chats;
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

function drawChats() {
  // faces.js (which draws the photos) may still be loading when the first list arrives: draw once the page has loaded.
  if (!app.avatar) { window.addEventListener('load', drawChats, { once: true }); return; }
  const inChat = homeUi.view === 'chat';
  const shown = chatUi.all ? chatUi.list : chatUi.list.slice(0, CHATS_SHOWN);
  const row = c => {
    const pics = c.pictures ? `${c.pictures} picture${c.pictures > 1 ? 's' : ''}` : '';
    // Muted: the chat itself, the person it is with, or everything (mute.js).
    const muted = app.mutedBy?.([`chat:${c.id}`, app.personKey?.(c.who)]);
    const state = [pics, app.mutedWords?.(muted)].filter(Boolean).join(' · ');
    const b = el('button', {
      class: 'rail-row', type: 'button', 'data-key': `chat:${c.id}`, 'aria-current': inChat && c.id === chatUi.current ? 'true' : null,
      title: `${c.title}\nWith ${c.name}${c.role ? ` (${c.role})` : ''}\n${c.messages} message${c.messages === 1 ? '' : 's'}${pics ? ` · ${pics}` : ''}\n${muted ? `Muted ${muted.text}` : 'Right-click to mute'}`,
    },
    app.avatar(c.who, c.avatar),
    el('span', { class: 'rail-text' },
      // [staff] subject
      el('span', { class: 'rail-name' }, el('span', { class: 'side-who', text: c.name }), ` ${c.title}`),
      el('span', { class: 'rail-sub', text: timeText(c.updated) }),
      state ? el('span', { class: 'rail-state', text: state }) : null),
    app.muteBits?.(muted, 0).icon);
    b.addEventListener('click', () => openChat(c.id));
    // Delete, right on the row: it asks first, and whether the chat's pictures go too.
    const del = el('button', { class: 'rail-edit rail-del', type: 'button', title: `Delete "${c.title}"`, 'aria-label': `Delete the chat ${c.title}` }, trashIcon());
    del.addEventListener('click', () => askDelete(c));
    return el('li', { class: 'rail-staff-item' }, b, del);
  };
  // Under each project's name (the project with the newest chat first), then Default: the chats in no project.
  const groups = new Map();
  for (const c of shown) {
    const p = chatGroup(c);
    const key = p?.id ?? '';
    if (!groups.has(key)) groups.set(key, { name: p?.name ?? 'Default', chats: [] });
    groups.get(key).chats.push(c);
  }
  const order = [...groups.keys()].sort((x, y) => Number(x === '') - Number(y === ''));
  const rows = order.flatMap(k => [el('li', { class: 'side-group', 'data-key': `group:${k}` }, el('h3', { text: groups.get(k).name })), ...groups.get(k).chats.map(row)]);
  if (!rows.length) rows.push(el('li', { class: 'rail-empty hint', text: 'No chats yet. Press "New chat" to start one.' }));
  keepFocus($('#rail-chats'), rows);
  const more = $('#rail-chats-more');
  more.hidden = chatUi.list.length <= CHATS_SHOWN;
  more.textContent = chatUi.all ? 'Show fewer' : `Show all chats (${chatUi.list.length})`;
  drawSubjects();
  drawRecent();
}
app.drawChats = drawChats;

// ---- The left panel, under Projects: pinned chats (they stay), then the 5 newest others in "Recent chats" ----

const RAIL_RECENT_SHOWN = 5;
const MORE_RAIL_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';
function drawRecent() {
  const inChat = homeUi.view === 'chat';
  const row = c => {
    const b = el('button', { class: 'rail-row rail-recent-row', type: 'button', 'data-key': `recent:${c.id}`, 'aria-current': inChat && c.id === chatUi.current ? 'true' : null, title: `${c.title}\nWith ${c.name}\n${timeText(c.updated)}` },
      app.avatar(c.who, c.avatar),
      el('span', { class: 'rail-text' }, el('span', { class: 'rail-name', text: c.title }), el('span', { class: 'rail-sub', text: c.name })));
    b.addEventListener('click', () => openChat(c.id));
    // The … beside a chat: Pin or Unpin, and Delete (the same window as the chat's own menu).
    const more = el('button', { class: 'rail-edit rail-more', type: 'button', title: `"${c.title}": pin, unpin or delete`, 'aria-label': `More for the chat ${c.title}`, 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
    more.innerHTML = MORE_RAIL_ICON;
    more.addEventListener('click', () => railMenu(more, [
      [c.pinned ? 'Unpin' : 'Pin under Projects', () => pinChat(c, !c.pinned)],
      ['Delete…', () => askDelete(c), true],
    ]));
    return el('li', { class: 'rail-staff-item' }, b, more);
  };
  const pinned = chatUi.list.filter(c => c.pinned);
  const recent = chatUi.list.filter(c => !c.pinned).slice(0, RAIL_RECENT_SHOWN);
  $('#rail-pinned').hidden = !pinned.length;
  keepFocus($('#rail-pinned'), pinned.map(row));
  keepFocus($('#rail-recent'), recent.length ? recent.map(row) : [el('li', { class: 'rail-empty hint', text: pinned.length ? 'Every chat is pinned above.' : 'No chats yet.' })]);
  $('#rail-recent-all').hidden = chatUi.list.length <= pinned.length + recent.length;
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
    drawChats();
  } catch (e) {
    app.chatNote?.(e.message);
  }
}
// "Recent chats" starts open; folding it is kept in this browser.
$('#rail-recent-fold').open = store('recent-open') !== '0';
$('#rail-recent-fold').addEventListener('toggle', e => store('recent-open', e.target.open ? '1' : '0'));
// See all: the Chats tab beside the chat, with every chat listed (the panel opens if it was hidden).
$('#rail-recent-all').addEventListener('click', () => {
  app.showPanes();
  $('#subjects-fold').open = true;
  sideTab($('#tab-chats'));
  chatUi.all = true;
  drawChats();
});

// ---- Which project a chat's work belongs to: Default (the chats by date) or one of the projects ----

function drawChatProject(chat) {
  const row = $('#chat-project-row');
  row.hidden = !chat || chat.here === false;
  if (row.hidden) return;
  const sel = $('#chat-project');
  const known = chatUi.projects.some(p => p.id === chat.project);
  sel.replaceChildren(el('option', { value: '', text: 'Default' }), ...chatUi.projects.map(p => el('option', { value: p.id, text: p.name.length > 50 ? `${p.name.slice(0, 50)}…` : p.name })));
  sel.value = known ? chat.project : '';
}
$('#chat-project').addEventListener('change', async () => {
  const chat = chatUi.open;
  if (!chat) return;
  try {
    const r = await api('/api/chats/project', { id: chat.id, project: $('#chat-project').value });
    chatUi.open = { ...chat, project: r.chat.project, saveTo: r.chat.saveTo };
    chatUi.list = r.chats;
    drawChats();
    if (r.said) app.chatNote?.(r.said);
  } catch (e) {
    app.chatNote?.(e.message);
    drawChatProject(chat);
  }
});
/**
 * Where Save on a code block in the open chat puts the file (src/folders.ts): a chat in Default its own chats folder, a
 * chat in a project that project's folder, a writer's or artist's chat its specialists folder, named with the date and time.
 */
app.chatSaveTo = () => chatUi.open?.saveTo ?? null;
$('#rail-chats-more').addEventListener('click', () => {
  chatUi.all = !chatUi.all;
  drawChats();
});

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
  const software = !person || gone ? '' : person.model === 'no model given' ? 'The model connected here' : person.model;
  const pc = !person || gone ? '' : person.pc === 'this PC' ? 'This PC' : person.pc;
  $('#chat-name').textContent = gone ? 'They are no longer on the team: this chat can be read, not carried on.' : person ? person.name : '';
  $('#chat-software').textContent = software ? ` · ${software}` : '';
  $('#chat-pc').textContent = pc;
  $('#chat-who-box').title = software ? `${person.name} · ${person.role}: ${software} on ${pc}${app.lastRan ? `. The last answer ran on ${app.lastRan}.` : ''}` : $('#chat-name').textContent;
  drawChatProject(chat);
  if (chat && !chat.here) $('#chat-input').placeholder = READ_ONLY_BOX;
  // A hire who lives on another PC answers there: this PC's own model controls have nothing to do with this chat. So
  // does a hire here given one of a linked PC's models (it loads there when needed).
  const away = String(who).startsWith('node:') && !!person;
  const pcId = away ? String(who).split(':')[1] : (chat?.here !== false && person?.pcId) || '';
  $('#pane-chat').classList.toggle('away-chat', !!pcId);
  nodeMeters(pcId);
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
const meters = { pc: '', timer: 0, asking: false };
const chatOnScreen = () => !document.hidden && !!$('#pane-chat').getClientRects().length;
async function askMeters() {
  const pc = meters.pc;
  // Only while the chat is on screen: Home, Jobs or Nodes in front (or a hidden tab) asks nothing, so a node can drop
  // a model loaded for this PC once nobody here has the chat open (it waits 60 s). The bar shows this PC meanwhile.
  if (!pc || !chatOnScreen()) return app.showBarPc?.(null);
  if (meters.asking) return;
  meters.asking = true;
  try {
    const r = await api(`/api/node/stats?pc=${encodeURIComponent(pc)}`);
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
function nodeMeters(pc) {
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

// ---- Chats | Tools | Staff overview: tabs on the right of the chat (the one picked is kept in this browser) ----

const sideTabs = [$('#tab-chats'), $('#tab-tools'), $('#tab-staff')];
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
    // not kept: Chats opens first next time
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
  // Chats first
}

// A wide screen shows the panel unless Hide was pressed (kept in this browser; open to start with): hidden, it is a thin
// strip at the right with Show, and the chat takes its room. A narrow one folds it to one line above the chat.
const subjectsWide = window.matchMedia('(min-width: 901px)');
const SIDE_OPEN_KEY = 'tomlin-chat-side-open';
function sideKeptOpen() {
  try {
    return localStorage.getItem(SIDE_OPEN_KEY) !== '0';
  } catch {
    return true;
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
  if (!names.length) return 'Pictures are drawn by an artist. Hire one under Staff: hire and edit (pick the role Artist), then open their chat and type what to draw: the words go to the picture model just as you type them.';
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
// `id`: the chat sent to, read by its id; `from`: the chat on screen when it was sent ('' = not made yet). Shown only
// while this window is still there: a chat opened meanwhile (or in another window) is not taken away.
app.afterSend = async (id = app.chatId ?? '', from = id) => {
  await loadChats();
  if (!id) return;
  const r = await api(`/api/chat?id=${encodeURIComponent(id)}`).catch(() => null);
  if (r?.chat && [from, id].includes(app.chatId ?? '')) app.onChat(r.chat);
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

function drawPeople() {
  const list = chatUi.people.map(p => {
    // A profile card: photo, name, role, model, node.
    const b = el('button', { class: 'person-card', type: 'button', 'data-key': `who:${p.who}`, title: p.hint },
      app.avatar(p.who, p.avatar),
      el('span', { class: 'person-name', text: p.name }),
      el('span', { class: 'person-role', text: p.role }),
      el('span', { class: 'person-line' }, el('span', { class: 'person-label', text: 'Model' }), el('span', { text: p.model === 'no model given' ? 'the model connected here' : p.model })),
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
    return li;
  });
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

/** How many of their chats the window lists, newest first (all of them are in the Chats list on the right). */
const RECENT_SHOWN = 12;
let personWho = '';
app.openPerson = async (who, name) => {
  personWho = who;
  await loadChats();
  if (personWho !== who) return;
  $('#person-chats-title').textContent = name;
  $('#person-chats-fault').hidden = true;
  $('#person-chats-face').replaceChildren(app.avatar ? app.avatar(who, name.slice(0, 2).toUpperCase()) : '');
  $('#person-chats-start').textContent = chatUi.people.find(p => p.who === who)?.kind === 'image' ? 'New chat (draw)' : 'New chat';
  const theirs = chatUi.list.filter(c => c.who === who).sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  const rows = theirs.slice(0, RECENT_SHOWN).map(c => {
    // Project name - subject - date.
    const b = el('button', { class: 'person-chat', type: 'button', title: `${c.title}: ${c.messages} message${c.messages === 1 ? '' : 's'}` },
      el('span', { class: 'person-chat-project', text: chatGroup(c)?.name ?? 'Default' }),
      el('span', { class: 'person-chat-sep', text: ' - ', 'aria-hidden': 'true' }),
      el('span', { class: 'person-chat-title', text: c.title }),
      el('span', { class: 'person-chat-sep', text: ' - ', 'aria-hidden': 'true' }),
      el('span', { class: 'person-chat-date', text: timeText(c.updated) }));
    b.addEventListener('click', async () => {
      $('#person-chats').close();
      await openChat(c.id);
    });
    return el('li', {}, b);
  });
  if (!rows.length) rows.push(el('li', { class: 'hint', text: `No chats with ${name} yet.` }));
  else if (theirs.length > RECENT_SHOWN) rows.push(el('li', { class: 'hint', text: `${theirs.length - RECENT_SHOWN} older: in the Chats list on the right.` }));
  $('#person-chats-list').replaceChildren(...rows);
  if (!$('#person-chats').open) $('#person-chats').showModal();
  $('#person-chats-start').focus();
};
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

$('#rail-new').addEventListener('click', async () => {
  await loadChats();
  drawPeople();
  $('#new-chat-fault').hidden = true;
  $('#new-chat').showModal();
  $('#new-chat-people button')?.focus();
});
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
    ? `The chat's messages are deleted for good. Its ${c.pictures} picture${c.pictures > 1 ? 's' : ''} can go with it, or stay under "All chats" in an artist's chat.`
    : 'The chat\'s messages are deleted for good.';
  const go = (text, pictures, primary) => el('button', { class: `btn${primary ? ' danger' : ''}`, type: 'button', text, onclick: () => deleteChat(c, pictures) });
  $('#chat-delete-actions').replaceChildren(...(c.pictures
    ? [go(`Delete the chat and its ${c.pictures} picture${c.pictures > 1 ? 's' : ''}`, 'delete', true), go('Delete the chat, keep the pictures', 'keep')]
    : [go('Delete the chat', 'keep', true)]));
  // Mute: this chat, or the person (all their chats and job steps). Quiet, not stopped.
  const person = app.personKey?.(c.who);
  const mutedChat = app.mutedBy?.([`chat:${c.id}`]);
  const mutedPerson = person ? app.mutedBy?.([person]) : null;
  const mute = (key, label) => () => { $('#chat-menu').close(); app.openMute?.(key, label); };
  $('#chat-mute-about').textContent = mutedChat ? `Muted ${mutedChat.text}.` : 'Quiet, not stopped: answers still arrive in the chat.';
  $('#chat-mute-actions').replaceChildren(
    el('button', { class: 'btn', type: 'button', onclick: mute(`chat:${c.id}`, `"${c.title}"`) }, app.bellIcon?.(!!mutedChat) ?? '', mutedChat ? ' Change the mute of this chat' : ' Mute this chat'),
    person ? el('button', { class: 'btn', type: 'button', onclick: mute(person, c.name) }, app.bellIcon?.(!!mutedPerson) ?? '', mutedPerson ? ` ${c.name}: muted ${mutedPerson.text}` : ` Mute ${c.name} (every chat and job step)`) : null);
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
