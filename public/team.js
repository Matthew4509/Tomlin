// The team: hire a person for a role at a level, see which of your models suit them, and audition the connected model.
// Levels only suggest models; any model can be given to anyone. Uses app.js's helpers ($, el, api, app, panes, loadModels, drawChat).
'use strict';

const team = { data: null, open: new Set() };
/** The Audition section of a profile is hidden for now; true brings it back as it was. */
const SHOW_AUDITION = false;
const dlg = $('#team');
const FIT = { ok: '', tight: ' (tight on memory)', no: ' (too big now)' };
const AGAINST = { match: 'matches the level', above: 'bigger than the level', below: 'smaller than the level', any: '' };

// One plain icon per role (a person for any role not listed).
const ROLE_ICONS = {
  coder: 'M8.7 16.6 4.1 12l4.6-4.6L7.3 6l-6 6 6 6 1.4-1.4Zm6.6 0 4.6-4.6-4.6-4.6L16.7 6l6 6-6 6-1.4-1.4Z',
  default: 'M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm3 6v2h2V9H7Zm4 0v2h2V9h-2Zm4 0v2h2V9h-2Z',
  writer: 'M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25Zm17.7-10.2a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83Z',
  pm: 'M9 2h6v2h3a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3V2Zm1 7v2h7V9h-7Zm0 4v2h7v-2h-7Zm-3-4v2h2V9H7Zm0 4v2h2v-2H7Z',
  designer: 'M4 4h7v7H4V4Zm9 0h7v7h-7V4Zm-9 9h7v7H4v-7Zm12.5 0a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7Z',
  artist: 'M12 3a9 9 0 0 0 0 18c1 0 1.5-.7 1.5-1.4 0-.4-.2-.7-.4-1-.2-.3-.4-.6-.4-1 0-.8.7-1.5 1.5-1.5H16a5 5 0 0 0 5-5c0-4.4-4-8-9-8Zm-5.5 9a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm3-4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm3 4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z',
};
const PERSON = 'M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Zm0 2c-4.4 0-8 2.3-8 5.2V21h16v-1.8c0-2.9-3.6-5.2-8-5.2Z';
const PENCIL = 'M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25Zm17.7-10.2a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83Z';
function svgIcon(d, size = 20) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', String(size));
  s.setAttribute('height', String(size));
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('focusable', 'false');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('fill', 'currentColor');
  p.setAttribute('d', d);
  s.append(p);
  return s;
}
const roleIcon = id => svgIcon(ROLE_ICONS[id] ?? PERSON);
const pencil = () => svgIcon(PENCIL, 16);
app.pencilIcon = pencil;

function teamFault(message) {
  const f = $('#team-fault');
  f.textContent = message ?? '';
  f.hidden = !message;
}

async function teamLoad() {
  team.data = await api('/api/staff');
  teamDraw();
}

function pick(items, value, onChange) {
  const s = el('select', {}, ...items.map(i => el('option', { value: i.id, text: i.name })));
  s.value = value;
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

async function teamAct(body) {
  teamFault(null);
  try {
    team.data = await api('/api/staff', body);
    // A hire who chats is someone to talk to from now: the chat drawn below must not still say to hire someone first.
    if (team.data.staff.some(s => s.kind === 'chat')) app.nobodyToTalkTo = false;
    // The chat list's people too: a new hire's chat head and Tools otherwise said they were not on the team.
    await app.loadChats?.();
    // Their pictures too: a new hire's look, a renamed or fired hire's initials.
    await app.loadFaces?.();
    await loadModels();
    // This window's chat, read again by its id (a fired hire's chat stays, to read).
    showChat(await app.chatAgain());
    teamDraw();
    if (dlg.open) drawEdit();
    if (profileDlg.open) drawProfile();
  } catch (e) {
    teamFault(e.message);
  }
}

/** Every brain a hire can be given: the models on this PC (best suggestions first), then each paired PC's loaded model. */
function brainChoices(m) {
  const image = m.kind === 'image';
  return [
    // A Default level says nothing about size, so "matches the level" is left off.
    ...m.models.map(x => ({ id: x.id, name: [x.name, `about ${x.sizeB}${x.unit}`, x.moe ? 'MoE' : '', image && !x.installed ? 'not downloaded' : '', x.against === 'any' ? (FIT[x.fit] ?? '').trim().replace(/^\(|\)$/g, '') : `${AGAINST[x.against] ?? ''}${FIT[x.fit] ?? ''}`, x.audition ? `audition ${x.audition.score}/${x.audition.of}` : ''].filter(Boolean).join(' · '), audition: x.audition, hidden: x.hidden })),
    ...(m.pcBrains ?? []).map(x => ({ id: x.id, name: `${x.name}${x.audition ? ` · audition ${x.audition.score}/${x.audition.of}` : ''}`, audition: x.audition, hidden: x.hidden })),
  ];
}
const brainName = (m, ref) => (ref ? brainChoices(m).find(c => c.id === ref)?.name.split(' · ')[0] ?? 'a model no longer here' : m.kind === 'image' ? 'the picture model connected here' : 'the model connected here');

/**
 * One of a hire's model lists ('model' = first choice, 'fallback'): changing it saves at once. A hidden model is offered
 * once "Show hidden" is ticked, or while it is this person's pick.
 */
function modelPick(m, key, label, none) {
  const sel = el('select', { 'aria-label': `${label} for ${m.name}` }, el('option', { value: '', text: none }), ...visibleModels(brainChoices(m), m[key]).map(c => el('option', { value: c.id, text: c.name })));
  sel.value = m[key] ?? '';
  sel.addEventListener('change', () => teamAct({ action: 'change', id: m.id, [key]: sel.value || null }));
  return el('label', { class: 'field' }, el('span', { text: label }), sel);
}

function modelOptions(m) {
  const box = el('div', { class: 'team-models' });
  const choices = brainChoices(m);
  if (!choices.length) {
    box.append(el('p', { class: 'hint', text: 'No models are installed yet. Any model you add later, or a linked PC, can be given to this person.' }));
    return box;
  }
  const image = m.kind === 'image';
  const select = (key, label, none) => modelPick(m, key, label, none);
  // The fallback is kept out of sight; one already set still answers when the first choice cannot, so it shows (to be
  // seen and cleared) until it is set to No fallback.
  box.append(el('div', { class: 'team-pick' },
    select('model', 'First choice', image ? 'No model picked' : 'None: the model connected here'),
    m.fallback ? select('fallback', 'Fallback', 'No fallback') : null), hiddenTick('show-hidden-edit', choices.some(c => c.hidden)));
  if (image) {
    const st = el('select', { 'aria-label': `Preferred style for ${m.name}` }, el('option', { value: '', text: 'Any: as the words ask' }), ...(m.styles ?? []).map(s => el('option', { value: s.id, text: s.name })));
    st.value = m.style ?? '';
    st.addEventListener('change', () => teamAct({ action: 'change', id: m.id, style: st.value || null }));
    box.append(el('label', { class: 'field' }, el('span', { text: 'Preferred style (used when the words name none; a linked PC picks its own model for it)' }), st));
  }
  const group = groupOptions(m);
  if (group) box.append(group);
  return box;
}

/**
 * Related models on this PC this person may also use, the first choice being the default (Wake up can load one of
 * them). Only for a first choice on this PC: otherwise there is nothing to tick, and nothing is shown.
 */
function groupOptions(m) {
  if (!m.model || String(m.model).startsWith('remote:')) return null;
  const image = m.kind === 'image';
  const here = visibleModels(m.models, ...(m.group ?? [])).filter(x => (!image || x.installed) && x.id !== m.model);
  const box = el('fieldset', { class: 'pick-set team-group' }, el('legend', { text: `Other models ${m.name} may use` }));
  box.append(el('p', { class: 'hint', text: `Their default is the first choice above. Wake up can load one of the models ticked here instead.` }));
  if (!here.length) box.append(el('p', { class: 'hint' }, image ? 'No other picture model is downloaded here. ' : 'No other chat model is on this PC. ',
    el('button', { class: 'link', type: 'button', text: 'Get models', onclick: () => { dlg.close(); app.openModels?.(); } }), '.'));
  const list = new Set(m.group ?? []);
  for (const x of here) {
    const tick = el('input', { type: 'checkbox', checked: list.has(x.id) });
    tick.addEventListener('change', () => {
      if (tick.checked) list.add(x.id);
      else list.delete(x.id);
      teamAct({ action: 'change', id: m.id, group: [...list] });
    });
    box.append(el('label', { class: 'check' }, tick, ` ${x.name.split(' · ')[0]} · about ${x.sizeB}${x.unit}`));
  }
  if (m.active && m.active !== m.model) {
    const name = m.models.find(x => x.id === m.active)?.name ?? 'another of their models';
    box.append(el('p', { class: 'hint' }, `A linked PC switched ${m.name} to ${name}. `,
      el('button', { class: 'link', type: 'button', text: 'Back to the default', onclick: () => teamAct({ action: 'change', id: m.id, active: null }) })));
  }
  return box;
}

/** Whether PCs paired with this one see this person and may chat with them (on this PC's models). */
function auditionView(a) {
  const out = el('div', { class: 'team-audition' });
  out.append(el('p', { text: `Audition on ${a.model}: ${a.score} of ${a.of} checks passed, ${a.seconds} s in all.` }));
  if (a.results.some(r => r.picture)) out.append(el('p', { class: 'hint', text: 'The program can only mark whether each picture finished, was cut out and has detail. Open each one and judge it yourself.' }));
  for (const r of a.results) {
    const missed = r.checks.filter(c => !c.pass).map(c => c.label);
    const ask = r.ask.length > 60 ? `${r.ask.slice(0, 60)}…` : r.ask;
    out.append(el('details', {},
      el('summary', { text: `${missed.length ? `Missed: ${missed.join(', ')}` : 'Passed'} · "${ask}" (${r.seconds} s)` }),
      el('p', { class: 'hint', text: r.checks.map(c => `${c.pass ? '✓' : '✗'} ${c.label}`).join('   ') }),
      r.picture ? el('img', { class: 'team-pic', src: `/api/images/file/${r.picture.split('/').map(encodeURIComponent).join('/')}`, alt: r.ask, loading: 'lazy' }) : el('pre', { class: 'team-answer', text: r.answer || '(no answer)' })));
  }
  return out;
}

/** The PC a hire works on, by the name it has on Home ('This PC' for this one). */
function staffPc(m) {
  const row = (typeof homeUi !== 'undefined' ? homeUi.data?.staff : null)?.find(x => x.id === m.id);
  return row?.pc || (String(m.model ?? '').startsWith('remote:') ? 'Another PC' : 'This PC');
}

/** See all staff: everyone, under the PC they work on; each linked PC shows even with nobody on it. */
function teamDraw() {
  const d = team.data;
  const list = $('#team-list');
  list.replaceChildren();
  if (!d.staff.length) list.append(el('p', { class: 'hint', text: 'Nobody hired yet. Press Hire staff: pick a role, their PC and model, and give them a name.' }));
  if (teamMode === 'all') $('#team-title').textContent = d.staff.length ? `All staff (${d.staff.length})` : 'All staff';
  const linked = typeof homeUi !== 'undefined' ? homeUi.pcs ?? [] : [];
  const groups = new Map([['This PC', []], ...linked.map(p => [p.name, []])]);
  for (const m of d.staff) {
    const pc = staffPc(m);
    if (!groups.has(pc)) groups.set(pc, []);
    groups.get(pc).push(m);
  }
  for (const [pc, people] of groups) {
    const info = linked.find(p => p.name === pc);
    if (!people.length && pc === 'This PC' && !d.staff.length) continue;
    list.append(el('section', { class: 'staff-pc' },
      el('h3', { class: 'staff-pc-name' }, el('span', { text: pc }), info?.backupsOnly ? el('span', { class: 'hint', text: ' · Backups only' }) : null),
      ...(people.length ? people.map(staffCard) : [el('p', { class: 'hint', text: info?.backupsOnly ? 'Keeps backups and takes no staff.' : 'Nobody works on this PC yet.' })])));
  }
}

function staffCard(m) {
  const d = team.data;
  const level = d.levels.find(l => l.id === m.level);
  const role = d.roles.find(r => r.id === m.role);
  const imageRole = m.kind === 'image';
  const use = el('button', { class: 'btn primary', type: 'button', text: imageRole ? `Draw with ${m.name}` : `Talk to ${m.name}` });
  use.addEventListener('click', async () => {
    if (imageRole) {
      // Their own chat, in the pictures pane: what is typed there is drawn just as typed.
      dlg.close();
      await app.openArtist(`staff:${m.id}`).catch(e => app.chatNote?.(e.message));
      return;
    }
    await api('/api/settings', { who: `staff:${m.id}` });
    await loadModels();
    showChat(await api('/api/chat'));
    await useModelOf(m);
    dlg.close();
    app.showPanes?.();
  });
  const edit = el('button', { class: 'btn quiet', type: 'button', title: `See and manage ${m.name}: role, level, models${SHOW_AUDITION ? ', audition' : ''}` });
  edit.append(pencil(), ' Edit');
  edit.addEventListener('click', () => openProfile(m.id));
  return el('article', { class: 'team-card', 'data-id': m.id },
    el('div', { class: 'team-row' },
      el('span', { class: 'role-icon', 'aria-hidden': 'true' }, roleIcon(m.role)),
      el('span', { class: 'rail-text' },
        el('span', { class: 'rail-name', text: m.name }),
        el('span', { class: 'rail-sub', text: `${role?.name ?? m.role} · ${level?.name ?? m.level} · ${brainName(m, m.model)}` })),
      use, edit));
}

// The model a person was given is picked in the chat's model list (nothing loads until Connect).
async function useModelOf(m) {
  if (!m?.model || m.kind === 'image') return;
  if (![...panes.chat.model.options].some(o => o.value === m.model && !o.disabled)) return;
  panes.chat.model.value = m.model;
  await api('/api/settings', { pane: 'chat', model: m.model }).catch(() => undefined);
}

$('#team-open').addEventListener('click', async () => {
  teamFault(null);
  try {
    await teamLoad();
  } catch (e) {
    teamFault(e.message);
  }
  // The right side shows the person last edited (else the first); nobody yet: a line and Hire staff.
  const staff = team.data?.staff ?? [];
  const id = staff.some(s => s.id === editId) ? editId : staff[0]?.id;
  if (id) return openProfile(id);
  editId = '';
  emptyEdit();
  if (!dlg.open) dlg.showModal();
});

// ---- The right side: one person's Edit Staff (picked with Edit on the left). Hiring is its own window (hire.js) ----

let editId = '';
// 'one': one person on the screen (them on the left, their settings on the right); 'all': See all staff.
let teamMode = 'one';
// The tab on the right of one person's page: 'look' (Look), 'staff' (Staff settings) or 'pc' (PC settings).
let settingsTab = 'look';
// The hire last opened with openProfile: opening someone else (or the window again) starts on their Look.
let shownId = '';
function showMode(mode) {
  teamMode = mode;
  $('#staff-all').hidden = mode !== 'all';
  $('#staff-one').hidden = mode !== 'one';
  $('#team-all').hidden = mode === 'all';
  $('#team-title').textContent = mode === 'all' ? `All staff (${team.data?.staff.length ?? 0})` : 'Staff';
}
function staffMode() {
  showMode('one');
  $('#staff-edit').scrollTop = 0;
}
function emptyEdit() {
  $('#staff-person').replaceChildren();
  $('#staff-edit-body').replaceChildren(el('p', { class: 'hint', text: 'Nobody hired yet.' }),
    el('div', { class: 'team-actions' }, el('button', { class: 'btn primary', type: 'button', text: 'Hire staff', onclick: () => app.openHire() })));
  staffMode();
}
$('#team-hire').addEventListener('click', () => app.openHire());
$('#team-all').addEventListener('click', () => {
  teamDraw();
  showMode('all');
});
$('#team-get-models').addEventListener('click', () => {
  dlg.close();
  app.openModels?.();
});

/** After Hire staff (hire.js): the rest of the page catches up, and a hire with no model opens their profile. */
app.afterHire = async hired => {
  if (team.data.staff.some(s => s.kind === 'chat')) app.nobodyToTalkTo = false;
  // The chat turns to a new hire who chats: asked by this window (the server no longer turns every window's chat to them).
  if (hired?.kind === 'chat') await api('/api/settings', { who: `staff:${hired.id}` }).catch(() => undefined);
  // A new artist draws in this window's Images pane (Draw as), asked by this window: the server no longer picks them.
  if (hired?.kind === 'image') await api('/api/settings', { imageAs: hired.id }).catch(() => undefined);
  await app.loadChats?.();
  await app.loadFaces?.();
  await loadModels().catch(() => undefined);
  showChat(await (hired?.kind === 'chat' ? api('/api/chat') : app.chatAgain()));
  if (dlg.open) teamDraw();
  await useModelOf(hired);
  app.drawAs?.();
  if (typeof homeAsk !== 'undefined') homeAsk.drawn = '';
  if (typeof refresh === 'function') await refresh().catch(() => undefined);
  if (hired && !hired.model) openProfile(hired.id);
};

api('/api/staff').then(d => {
  team.data = d;
}).catch(() => undefined);

hiddenRedraws.push(() => {
  if (profileDlg.open) drawProfile();
});

/** Opens the staff window with one person on its Edit Staff side (the pencil beside them in the left panel). */
app.editStaff = id => openProfile(id);

// Choosing a person in "Who TOMLIN is" also picks the model they were given.
$('#who').addEventListener('change', async e => {
  if (!String(e.target.value).startsWith('staff:')) return;
  const d = await api('/api/staff').catch(() => null);
  await useModelOf(d?.staff.find(s => `staff:${s.id}` === e.target.value));
});

// ---- The host's and a remote hire's profile window; a hire of this PC is edited on the Staff window's right side ----

const profileDlg = $('#profile');
const profileRuns = {};
function profileFault(message) {
  $('#profile-fault').textContent = message ?? '';
  $('#profile-fault').hidden = !message;
}

/** Mute, without a right-click (a touch screen has none): the same window as the left panel's. */
function muteButton(m) {
  const key = `staff:${m.id}`;
  const muted = app.mutedBy?.([key]);
  return el('button', { class: 'btn quiet', type: 'button', onclick: () => app.openMute?.(key, m.name) },
    app.bellIcon?.(!!muted) ?? '', muted ? ` Muted ${muted.text}` : ' Mute');
}

/** Rename: their chats, notebook and photo stay theirs (they are kept by id, not by name). */
function renameForm(m) {
  const box = el('input', { type: 'text', maxlength: '30', value: m.name, autocomplete: 'off', required: true });
  const form = el('form', { class: 'team-hire profile-rename' },
    el('label', { class: 'field' }, el('span', { text: 'Name' }), box),
    el('button', { class: 'btn', type: 'submit', text: 'Rename' }));
  form.addEventListener('submit', e => {
    e.preventDefault();
    const name = box.value.trim().replace(/\s+/g, ' ');
    if (name && name !== m.name) teamAct({ action: 'change', id: m.id, name });
  });
  return form;
}

async function openProfile(id) {
  editId = id;
  teamFault(null);
  try {
    team.data = await api('/api/staff');
  } catch (e) {
    teamFault(e.message);
  }
  if (!team.data?.staff.some(s => s.id === id)) return;
  // Another person (or the window opened again): the right side opens on the Look tab (setting their character).
  if (!dlg.open || id !== shownId) {
    shownId = id;
    settingsTab = 'look';
  }
  drawEdit();
  staffMode();
  teamDraw();
  if (!dlg.open) dlg.showModal();
  // On a phone the two sides stack: the edit side is below the list.
  if (matchMedia('(max-width: 760px)').matches) $('#staff-edit').scrollIntoView({ block: 'start' });
}
app.openProfile = openProfile;

// ---- The host's profile: this PC's own assistant, not one of the staff. Its pencil picks its model and its name ----

let hostOpen = false;
async function openHost() {
  hostOpen = true;
  profileFault(null);
  await loadModels().catch(e => profileFault(e.message));
  drawHost();
  if (!profileDlg.open) profileDlg.showModal();
  $('#profile-body').scrollTop = 0;
}
app.editHost = openHost;
profileDlg.addEventListener('close', () => { hostOpen = false; });

function drawHost(said0 = '') {
  const person = chatUi.people.find(p => p.who === 'manager');
  const name = person?.name ?? 'The host';
  const said = app.inSentence(name);
  const mine = app.models?.settings?.hostModel ?? '';
  const list = visibleModels((app.models?.chat ?? []).filter(m => m.installed !== false), mine);
  const row = homeUi.data?.manager;
  $('#profile-top').textContent = name;
  const use = el('button', { class: 'btn primary', type: 'button', text: `Talk to ${said}` });
  use.addEventListener('click', () => {
    profileDlg.close();
    $('#rail-host .rail-row')?.click();
  });
  const sel = el('select', { 'aria-label': `Model for ${said}` },
    el('option', { value: '', text: list.length ? 'Pick a model' : 'No chat model on this PC yet' }),
    ...list.map(m => el('option', { value: m.id, text: `${m.name}${m.fit?.level === 'no' ? ' (may not fit in memory)' : ''}` })));
  sel.value = list.some(m => m.id === mine) ? mine : '';
  const note = el('p', { class: 'hint', role: 'status', text: said0 || `${name} answers on this model. Nothing loads by itself: Connect in its chat loads it.` });
  const save = el('button', { class: 'btn', type: 'button', text: 'Use this model' });
  save.addEventListener('click', async () => {
    if (!sel.value) {
      note.textContent = list.length ? 'Pick a model in the list first.' : 'Get a chat model first: Settings, Set up, Add a model.';
      return;
    }
    try {
      await api('/api/settings', { hostModel: sel.value });
      await loadModels();
      // The host's chat open now shows the new model at once.
      if (app.chatWho?.() === 'manager') await useModelOf({ model: sel.value, kind: 'chat' });
      await refresh();
      if (profileDlg.open && hostOpen) drawHost(`Saved: ${said} answers on ${list.find(m => m.id === sel.value)?.name ?? 'it'} from now on.`);
    } catch (e) {
      note.textContent = e.message;
    }
  });
  const box = el('input', { type: 'text', maxlength: '30', value: person?.named ? name : '', placeholder: 'The host', autocomplete: 'off' });
  const rename = el('form', { class: 'team-hire profile-rename' },
    el('label', { class: 'field' }, el('span', { text: 'Name' }), box),
    el('button', { class: 'btn', type: 'submit', text: 'Rename' }));
  rename.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api('/api/names', { who: 'manager', name: box.value });
      await loadChats();
      refresh();
      drawHost();
    } catch (err) {
      profileFault(err.message);
    }
  });
  const section = (title, ...kids) => el('section', { class: 'profile-section' }, el('h3', { text: title }), ...kids);
  $('#profile-body').replaceChildren(
    el('header', { class: 'profile-head' },
      el('div', { class: 'profile-banner', 'aria-hidden': 'true' }),
      el('div', { class: 'profile-id' },
        app.avatar ? app.avatar('manager', person?.avatar ?? 'H') : null,
        el('div', { class: 'profile-names' },
          el('h2', { id: 'profile-name', text: name }),
          el('p', { class: 'profile-headline', text: 'The host · this PC\'s own assistant, not one of the staff' }),
          el('p', { class: 'hint', text: `Model: ${row?.modelName || 'none picked yet'} · ${row?.text ?? ''}` })),
        el('div', { class: 'profile-actions' }, use))),
    section('Model', el('div', { class: 'team-hire' }, el('label', { class: 'field' }, el('span', { text: 'Default model' }), sel), save), note),
    section('What the host is for', el('p', { text: `The one you talk to when you are not talking to someone you hired: it is here from the first start, before anyone is hired. It has no role or level, runs no job steps and keeps no notebook of its own (it reads the team notebook). How it talks (Standard, Professional, Friend) is in the chat's settings (the gear). Staff are the people you hire: a role, a level, their own model and a fallback, a notebook, and job steps in their role.` })),
    section('Name', rename));
}

function drawProfile() {
  if (hostOpen) return drawHost();
}

/** Edit Staff: one hire of this PC, like a profile page on a jobs site, on the right of the Staff window. */
/** A chat hire's own tone for a letter, article or post (until one is picked, the host's, from the chat's gear). */
function writingSection(m, section) {
  const tones = app.models?.tones ?? [];
  if (!tones.length) return null;
  const first = m.name.split(/\s+/)[0];
  // Software (their first choice, the same list as PC settings > Models) and the tone, side by side.
  return section('Software and tone',
    el('div', { class: 'profile-line' },
      brainChoices(m).length ? modelPick(m, 'model', 'Software', 'None: the model connected here') : null,
      el('label', { class: 'field' }, el('span', { text: 'Tone for writing' }), pick(tones, m.tone ?? app.models.settings?.tone ?? tones[0].id, v => teamAct({ action: 'change', id: m.id, tone: v })))),
    el('p', { class: 'hint', text: m.role === 'default' ? `${first} has the Default role, so is sent no instructions and the tone is not used. It is kept for when you give ${first} a role.` : `Used when you ask ${first} for a letter, article, post or message in a chat.` }));
}

/**
 * Their look (src/look.ts, public/look.js): the person drawn for them, as their round picture when they have no photo,
 * and in the office game. Kept when Save look is pressed; the editor stays as it is (no redraw under the pointer).
 */
let lookSaving = Promise.resolve();
function lookSection(m, section) {
  if (!app.look?.ready()) return null;
  const who = `staff:${m.id}`;
  const first = m.name.split(/\s+/)[0];
  const note = el('p', { class: 'hint' });
  const fault = el('p', { class: 'fault', hidden: true });
  // True once saved (Save look reads it: false keeps "not saved yet" showing).
  const save = look => {
    lookSaving = lookSaving.then(async () => {
      try {
        team.data = await api('/api/staff', { action: 'change', id: m.id, look });
        fault.hidden = true;
        await app.loadFaces?.();
        const fresh = team.data?.staff.find(s => s.id === m.id);
        if (fresh && editId === m.id) drawPerson(fresh);
        says(!!look);
        return true;
      } catch (e) {
        fault.textContent = `${first}'s look was not saved: ${e.message}`;
        fault.hidden = false;
        return false;
      }
    });
    return lookSaving;
  };
  const drop = el('button', { class: 'btn quiet', type: 'button', text: 'Show initials instead', title: `Forget the saved look: ${first}'s round picture shows the initials again (the office game still draws a made-up person)` });
  const takePhoto = el('button', { class: 'btn quiet', type: 'button', text: 'Take the photo off', title: 'The picture stays in the gallery' });
  const shown = m.look ?? app.look.fromId(m.id, m.role);
  function says(saved) {
    drop.hidden = !saved;
    takePhoto.hidden = !app.faceOf?.(who);
    note.textContent = app.faceOf?.(who)
      ? `${first} has a profile photo, so lists and chats show the photo. The office game shows the saved look.`
      : saved ? ''
        : `Nothing saved yet: ${first}'s round picture shows the initials until you press Save look.`;
    note.hidden = !note.textContent;
  }
  drop.addEventListener('click', async () => {
    if (await save(null)) drawEdit();
  });
  takePhoto.addEventListener('click', async () => {
    try {
      await api('/api/faces', { who, picture: null });
      await app.loadFaces?.();
      if (editId === m.id) drawEdit();
    } catch (e) {
      fault.textContent = e.message;
      fault.hidden = false;
    }
  });
  says(!!m.look);
  const editor = app.look.editor({ look: shown, role: m.role, saved: !!m.look, onSave: save, extra: el('span', { class: 'look-save' }, drop, takePhoto) });
  return section('Look', editor, note, fault);
}

/** What a chat hire's answers have used so far, on any PC, and the same tokens on each API (src/meter.ts ByStaff). */
function usageSection(m, section) {
  const u = m.usage;
  if (!u) return null;
  const t = u.tally;
  const n = x => (x >= 1e6 ? `${(x / 1e6).toLocaleString('en-GB', { maximumFractionDigits: 2 })} M` : x.toLocaleString('en-GB'));
  const first = m.name.split(/\s+/)[0];
  if (!t.answers) return section('Tokens', el('p', { class: 'hint', text: `Nothing counted for ${first} yet. Each answer ${first} writes from now on is counted here, in chats and job steps, on this PC or a linked one.` }));
  const money = app.money ?? (x => `US$${x.toFixed(2)}`);
  return section('Tokens',
    el('p', { text: `${n(t.in + t.cached + t.out)} tokens in ${t.answers.toLocaleString('en-GB')} answer${t.answers === 1 ? '' : 's'}: ${n(t.in + t.cached)} read${t.cached ? ` (${n(t.cached)} of them from the cache)` : ''}, ${n(t.out)} written${t.ms && app.span ? `, ${app.span(t.ms / 1000)} of work` : ''}.` }),
    el('p', { class: 'hint', text: `The same tokens would cost ${u.apis.map(a => `${money(a.cost)} on ${a.name}`).join(' and ')}.${u.last ? ` Last answer ${new Date(u.last).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}.` : ''}` }));
}

/**
 * The left of one person's page: their picture, name, role and level (a pencil at its top right opens the Look tab),
 * the PC they work on, then Talk, Mute and Fire.
 */
function drawPerson(m) {
  const d = team.data;
  const role = d.roles.find(r => r.id === m.role);
  const level = d.levels.find(l => l.id === m.level);
  const image = m.kind === 'image';
  const first = m.name.split(/\s+/)[0];
  const lent = String(m.model ?? '').startsWith('remote:');
  const now = m.active && m.active !== m.model ? m.models.find(x => x.id === m.active)?.name.split(' · ')[0] : brainName(m, m.model);
  const use = el('button', { class: 'btn primary', type: 'button', text: image ? `Draw with ${first}` : `Talk to ${first}` });
  use.addEventListener('click', () => {
    const card = [...document.querySelectorAll('#team-list .team-card')].find(c => c.dataset.id === m.id);
    if (card) card.querySelector('.btn.primary')?.click();
    else talkTo?.({ ...m, kind: m.kind });
  });
  const initials = m.name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  // The pencil at the top right of their photo and name: the Look tab on the right.
  const pencilBtn = el('button', { class: 'person-look-edit', type: 'button', title: `Change how ${first} looks (the Look tab)`, 'aria-label': `Change how ${first} looks`, 'aria-pressed': String(settingsTab === 'look') }, pencil());
  pencilBtn.addEventListener('click', () => {
    settingsTab = 'look';
    drawEdit();
    $('#staff-edit').scrollTop = 0;
  });
  $('#staff-person').replaceChildren(
    el('div', { class: 'person-head' },
      el('div', { class: 'person-pic' }, app.avatar ? app.avatar(`staff:${m.id}`, initials) : el('span', { class: 'rail-avatar', text: initials })),
      el('h3', { class: 'person-name', text: m.name }),
      el('p', { class: 'person-role', text: `${role?.name ?? m.role} · ${level?.name ?? m.level}` }),
      personFigures(m),
      pencilBtn),
    pcCard(m, now),
    el('div', { class: 'person-actions' }, use, muteButton(m)),
    fireSection(m));
}

/** Under their role: the tokens their answers have used in all, and how fast they answer (a picture hire: neither). */
function personFigures(m) {
  if (m.kind === 'image') return null;
  const t = m.usage?.tally;
  const total = t ? t.in + t.cached + t.out : 0;
  const tokens = total >= 1e6 ? `${(total / 1e6).toLocaleString('en-GB', { maximumFractionDigits: 2 })} M` : total.toLocaleString('en-GB');
  const speed = typeof m.speed === 'number' ? m.speed : m.speed?.expect;
  return el('p', { class: 'person-figures', title: 'Tokens: read and written in all their answers, on any PC (Staff settings > Tokens). Speed: what their model is expected to write (PC settings > Speed).' },
    el('span', { text: `${tokens} tokens` }), ' · ', el('span', { text: speed ? app.speedWords(speed, true) : 'speed not measured yet' }));
}

/** A question in a pop-up over the window: true for `yes`; `no`, Esc or closing it is false. `no` has the focus. */
function askPopup(title, text, yes, no) {
  return new Promise(done => {
    let answer = false;
    const go = el('button', { class: 'btn danger', type: 'button', text: yes });
    const keep = el('button', { class: 'btn', type: 'button', text: no });
    const box = el('dialog', { class: 'small-dlg ask-pop', 'aria-label': title },
      el('h2', { text: title }), el('p', { text }), el('div', { class: 'team-actions' }, go, keep));
    go.addEventListener('click', () => {
      answer = true;
      box.close();
    });
    keep.addEventListener('click', () => box.close());
    box.addEventListener('close', () => {
      box.remove();
      done(answer);
    });
    document.body.append(box);
    box.showModal();
    keep.focus();
  });
}

/** Fire, at the foot of the left side: a large red button; a pop-up asks first. */
function fireSection(m) {
  const b = el('button', { class: 'btn danger fire-btn', type: 'button', text: `Fire ${m.name}` });
  b.addEventListener('click', async () => {
    if (!(await askPopup(`Fire ${m.name}?`, 'Their chats stay in the list to read, but cannot be carried on. Someone hired later with the same name starts fresh.', `Fire ${m.name}`, `Keep ${m.name}`))) return;
    await teamAct({ action: 'fire', id: m.id });
    // Seen in the office (Staff overview): the boss comes in, and they leave with a box.
    if ($('#team-fault').hidden) app.office?.fire(m.id);
  });
  return el('div', { class: 'profile-fire' }, b);
}

/** A hire's row in the left panel (home.js): which PC they sit on (pcId, '' = this PC) and what it runs for them. */
const homeRowOf = m => (typeof homeUi !== 'undefined' ? homeUi.data?.staff : null)?.find(x => x.id === m.id) ?? null;

/** Every PC a hire could sit on: this PC, then each linked PC, with its memory and how it is now (home.js's lists). */
function pcChoices() {
  const hw = app.status?.hardware;
  const vram = hw?.gpu && !hw.gpu.shared ? hw.gpu.total ?? 0 : 0;
  const here = { id: '', name: pcName('here', 'My PC'), ram: hw?.ram.total ?? 0, vram, mem: hw ? memWords(hw.ram.total, vram) : '', make: pcMake('here'), loaded: '', activity: 'available', backupsOnly: false, text: 'This PC' };
  const linked = (typeof homeUi !== 'undefined' ? homeUi.pcs : []).map(p => {
    const mem = homeUi.pcMem[p.id];
    return { id: p.id, name: pcName(p.id, p.name), ram: mem?.ram ?? 0, vram: mem?.vram ?? 0, mem: mem ? memWords(mem.ram, mem.vram) : '', make: pcMake(p.id), loaded: p.model ?? '', activity: p.activity, backupsOnly: !!p.backupsOnly, text: p.text };
  });
  return [here, ...linked];
}
/**
 * Whether a model needing `need` bytes fits a PC, as Hire staff judges it (src/server/team.ts fitThere): on its graphics
 * card, else in its RAM with 3 GB kept for Windows ('ok'); in RAM only by using all of it ('tight'); 'no'; null = not known.
 */
const fitOn = (need, ram, vram) => (!need || !ram ? null : need <= vram || need <= ram - 3 * 2 ** 30 ? 'ok' : need <= ram ? 'tight' : 'no');
const FIT_TAG = { tight: ' · tight', no: ' · too big' };
const pcState = x => (x.backupsOnly ? 'Backups only' : ACTIVITY_WORD[x.activity] ?? '');

/**
 * Under a hire's name: "Uses <model> on", then the PC card as the left panel draws it (pressed: that PC's window).
 * Moving them to another PC is on the PC settings tab.
 */
function pcCard(m, now) {
  const row = homeRowOf(m);
  const at = row?.pcId ?? (String(m.model ?? '').startsWith('remote:') ? String(m.model).split(':')[1] : '');
  const x = pcChoices().find(p => p.id === at) ?? { id: at, name: staffPc(m), mem: '', make: '', loaded: '', activity: 'offline', text: 'Not answering' };
  const view = () => app.openPc?.(x.id || 'here');
  const card = staffRow({
    key: x.id ? `pc:${x.id}` : 'pc:mine', name: x.name, avatar: 'PC', sub: (x.backupsOnly ? [x.mem, x.make, 'Backups only'] : [x.mem, x.make, x.loaded]).filter(Boolean).join(' · '),
    state: 'on', stateText: x.text, activity: x.activity, title: `${x.name}: its uptime, total tokens and what its work cost`, onClick: view, mutable: false,
  });
  return el('div', { class: 'person-pc' },
    el('p', { class: 'person-uses', text: `Uses ${String(now ?? '').replace(/ on ".*$/, '') || 'no model yet'} on` }),
    el('ul', { class: 'rail-list person-pc-card' }, card));
}

/**
 * The top of PC settings: each PC, with the software it has for this hire. Moving them is giving them one of that PC's
 * models (as dragging them onto a PC in the left panel does).
 */
function pcPicker(m, section) {
  const row = homeRowOf(m);
  const at = row?.pcId ?? '';
  const first = m.name.split(/\s+/)[0];
  const s = row ?? { ...m, pcId: at };
  const fault = el('p', { class: 'fault', hidden: true });
  // Their model now, and the memory it needs (the same figure Hire staff uses).
  const mine = (team.data?.hireChoices?.[m.kind === 'image' ? 'image' : 'chat'] ?? []).find(c => c.id === m.model);
  const mineName = String(mine?.label ?? row?.modelName ?? '').replace(/ on ".*$/, '');
  const cards = pcChoices().map(x => {
    const here = x.id === at;
    const shut = x.backupsOnly || x.activity === 'offline' || x.activity === 'owner';
    const models = here || shut ? [] : deskModels(s, x.id);
    const head = el('div', { class: 'pc-pick-head' },
      el('strong', { text: x.name }),
      el('span', { class: 'hint', text: [x.mem, pcState(x)].filter(Boolean).join(' · ') }));
    // Would the model they use now fit this PC? Said before anything else: a 35B model does not go on an 8 GB PC.
    const fits = here || shut ? null : fitOn(mine?.need, x.ram, x.vram);
    const fitLine = !fits || fits === 'ok' || !mineName ? null : el('p', { class: `pc-pick-fit fit-${fits}` },
      el('span', { class: 'pc-pick-fit-mark', 'aria-hidden': 'true', text: fits === 'no' ? '✕' : '!' }),
      fits === 'no' ? ` ${mineName} would not fit here: it needs about ${gb(mine.need)}, and ${x.name} has ${x.mem}.`
        : ` ${mineName} would be tight here: it needs about ${gb(mine.need)}, and ${x.name} has ${x.mem}. It may load slowly or fail.`);
    let body;
    if (here) body = el('p', { class: 'hint', text: `${first} works here now.` });
    else if (x.backupsOnly) body = el('p', { class: 'hint', text: 'Set to Backups only: it takes no staff.' });
    else if (shut) body = el('p', { class: 'hint', text: x.activity === 'owner' ? 'Its owner is using it just now: try again later.' : 'It is not answering just now: switch it on, then try again.' });
    else if (!models.length) body = el('p', { class: 'hint', text: x.id ? `It shares no ${m.kind === 'image' ? 'picture' : 'chat'} models with this PC: tick them on that PC (Nodes and memory), or send one there from Models.` : `This PC has no ${m.kind === 'image' ? 'picture' : 'chat'} models yet.` });
    else {
      const short = n => String(n ?? '').replace(/ on ".*$/, '').toLowerCase();
      // Each model there says whether it fits there; one too big for that PC cannot be picked.
      const fitOf = c => (typeof c.fit === 'string' ? c.fit : c.fit?.level) ?? null;
      const sel = el('select', { 'aria-label': `The software ${first} runs on ${x.name}` }, ...models.map(c => el('option', { value: c.id, disabled: fitOf(c) === 'no', text: `${c.name.replace(/ on ".*?"/, '')}${FIT_TAG[fitOf(c)] ?? ''}` })));
      const same = models.find(c => short(c.name) === short(row?.modelName) && fitOf(c) !== 'no');
      const usable = models.find(c => fitOf(c) !== 'no');
      if (same || usable) sel.value = (same ?? usable).id;
      const go = el('button', { class: 'btn primary', type: 'button', text: `Move ${first} here`, disabled: !usable });
      go.addEventListener('click', async () => {
        go.disabled = true;
        fault.hidden = true;
        try {
          team.data = await api('/api/staff', { action: 'change', id: m.id, model: sel.value });
          await refresh();
          if (dlg.open && editId === m.id) drawEdit();
        } catch (e) {
          fault.textContent = `${first} was not moved: ${e.message}`;
          fault.hidden = false;
          go.disabled = false;
        }
      });
      body = el('div', { class: 'pc-pick-move' }, el('label', { class: 'field' }, el('span', { text: 'Software there' }), sel), go,
        usable ? null : el('p', { class: 'hint', text: `None of the models there fits ${x.name}'s memory.` }));
    }
    return el('li', { class: `pc-pick${here ? ' is-here' : ''}` }, head, fitLine, body);
  });
  return section(`Which PC ${first} works on`, el('p', { class: 'hint', text: `Pick a PC and the software ${first} runs there. Their chats and memory stay as they are.` }), fault, el('ul', { class: 'pc-pick-list' }, ...cards));
}

function drawEdit() {
  const d = team.data;
  const m = d?.staff.find(s => s.id === editId);
  if (!m) {
    // Fired, or gone: the right side says so, with Hire staff.
    editId = '';
    if (!d?.staff.length) return emptyEdit();
    editId = d.staff[0].id;
    return drawEdit();
  }
  const role = d.roles.find(r => r.id === m.role);
  const level = d.levels.find(l => l.id === m.level);
  const image = m.kind === 'image';
  drawPerson(m);
  const run = profileRuns[m.id];
  // A chat hire is auditioned on their own model (it loads if it is not loaded), not on whatever happens to be connected.
  const own = !image && m.model ? brainName(m, m.model) : '';
  const audition = el('button', { class: 'btn', type: 'button', text: run?.busy ? 'Auditioning…' : image ? 'Audition: draw three test pictures' : own ? `Audition ${m.name.split(/\s+/)[0]} on ${own}` : 'Audition the connected model (no model of their own yet)', title: own ? 'Stops any answer in progress, and loads their model first if it is not loaded' : '', disabled: !!run?.busy });
  audition.addEventListener('click', async () => {
    profileRuns[m.id] = { busy: true };
    drawEdit();
    try {
      profileRuns[m.id] = { result: await api('/api/staff/audition', own ? { id: m.id, ref: m.model } : { id: m.id }) };
      team.data = await api('/api/staff');
    } catch (e) {
      profileRuns[m.id] = { error: e.message };
    }
    if (dlg.open && editId === m.id) drawEdit();
  });
  const section = (title, ...kids) => el('section', { class: 'profile-section' }, el('h3', { text: title }), ...kids);
  // A chat role and a picture role cannot share models: changing across asks first, and names what comes off.
  const roleAsk = el('div', { hidden: true });
  const roleSel = pick(d.roles, m.role, async v => {
    const to = d.roles.find(r => r.id === v);
    const had = [m.model, m.fallback].filter(Boolean).map(ref => brainName(m, ref));
    if (!!to?.kind !== image && had.length) {
      const first = m.name.split(/\s+/)[0];
      const ok = await askHere(roleAsk, `${to.name} is a ${to.kind ? 'picture' : 'chat'} role: ${first}'s ${image ? 'picture' : 'chat'} ${had.length > 1 ? 'models' : 'model'} (${had.join(', ')}) cannot ${to.kind ? 'draw' : 'chat'}, so ${had.length > 1 ? 'they come' : 'it comes'} off ${first}. You then give ${first} a ${to.kind ? 'picture' : 'chat'} model under Models.`, `Make ${first} ${/^[aeiou]/i.test(to.name) ? 'an' : 'a'} ${to.name}`, `Keep ${first} as ${role?.name ?? m.role}`, false);
      if (!ok) {
        roleSel.value = m.role;
        return;
      }
    }
    await teamAct({ action: 'change', id: m.id, role: v });
  });
  // Name, role and level on one line: the name with Rename, then the two lists (they wrap when narrow).
  const levelPick = el('label', { class: 'field' }, el('span', { text: 'Level' }), pick(d.levels, m.level, v => teamAct({ action: 'change', id: m.id, level: v })));
  levelPick.title = image ? `${level?.name}: ${level?.imageSuggest}` : `${level?.name} means ${level?.size}. ${level?.suggest}`;
  const rolePick = el('label', { class: 'field' }, el('span', { text: 'Role' }), roleSel);
  rolePick.title = role?.hint ?? '';
  // Three tabs: Look (how they look: the first one shown, and the pencil on their photo), Staff settings (who they are,
  // their software and tone, what they used, what they remember) and PC settings (the PC they work on, their models,
  // how fast they answer).
  const tab = (id, text) => el('button', { class: 'profile-tab', type: 'button', 'aria-pressed': String(settingsTab === id), text, onclick: () => { settingsTab = id; drawEdit(); } });
  const tabs = el('div', { class: 'profile-tabs', role: 'group', 'aria-label': `${m.name}'s settings` }, tab('look', 'Look'), tab('staff', 'Staff settings'), tab('pc', 'PC settings'));
  const body = settingsTab === 'look'
    ? [lookSection(m, section) ?? el('p', { class: 'hint', text: 'The looks are still loading. Press the Look tab again in a moment.' })]
    : settingsTab === 'pc'
    ? [
      // How fast their model answers, first: the figures on the left; the chart and Test speed on the right.
      image ? null : el('section', { class: 'profile-section profile-speed' }, el('h3', { text: 'Speed' }), app.speedBox(`staff:${m.id}`, m.speed, () => api('/api/staff').then(d => { team.data = d; }).catch(() => undefined), { split: true })),
      pcPicker(m, section),
      section('Models', modelOptions(m)),
      SHOW_AUDITION ? section('Audition', el('p', { class: 'hint', text: image ? 'Draws three set pictures on the connected picture model for you to judge.' : own ? `Asks ${m.name.split(/\s+/)[0]}'s own model three set jobs for this role and marks the answers.` : 'Asks the connected model three set jobs for this role and marks the answers.' }), el('div', { class: 'team-actions' }, audition),
        run?.error ? el('p', { class: 'fault', text: run.error }) : run?.result ? auditionView(run.result) : null) : null,
    ]
    : [
      section('Name, role and level', el('div', { class: 'profile-line' }, renameForm(m), rolePick, levelPick), roleAsk),
      image ? null : writingSection(m, section),
      image ? null : usageSection(m, section),
    ];
  // Left out parts are skipped (replaceChildren would write a null as the word "null").
  $('#staff-edit-body').replaceChildren(tabs, ...body.filter(Boolean));
  if (settingsTab !== 'staff') return;
  // The hire's notebook, last on Staff settings (it loads after the rest is drawn).
  const head = $('#staff-edit-body').firstElementChild;
  // A Default hire reads no notebooks: the lines stay here for when they are given a role.
  const nbHint = `Set a line that you want this staff to remember.${m.role === 'default' ? ` (Read once ${m.name} has a role: the Default role reads no memory.)` : ''}`;
  app.notebookList?.(`staff:${m.id}`, 'Memory', nbHint).then(nb => {
    if (dlg.open && editId === m.id && settingsTab === 'staff' && head.isConnected) $('#staff-edit-body').append(nb);
  });
}
