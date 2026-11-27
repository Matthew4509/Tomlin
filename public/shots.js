// A Videographer's shot list, in the right panel of their chat (in place of the tools): shots in order as small cards
// (start, prompt, length, state with the progress line or a small player), Add to the shot list beside Make clip, edit
// a waiting shot, drag or Move up / Move down, Skip, Redo, Delete, Make 3 and Keep this one; on top, the shots, the
// seconds of video and the time it takes on the hire's PC, with Start, Pause, Stop, Start at, the Draft pass and the
// kept ones at Normal. Uses app.js's helpers ($, el, api, app) and clips.js's choices; the server side is src/server/shots.ts.
'use strict';

const shotPanel = $('#shot-list');
const shotCards = $('#shot-cards');
const shotAddBtn = $('#shot-add');
const shotStates = { waiting: 'Waiting', making: 'Making', done: 'Done', failed: 'Failed', skipped: 'Skipped' };
const shotSizes = { wide: 'Wide', tall: 'Tall', square: 'Square', wide720: 'Wide 720p', tall720: 'Tall 720p' };
/** The sizes this hire's model takes (clips.js): the 720p ones only for a model made for 720p; `now` stays offered. */
const shotSizesHere = now => Object.entries(shotSizes).filter(([id]) => id === now || !id.endsWith('720') || app.chatPerson?.hd);
const shotQualities = { draft: 'Draft', normal: 'Normal', best: 'Best' };
const shotStartWords = { none: 'Starts from nothing', last: 'Starts from the last frame of the shot before', picture: 'Starts from a picture' };
const shotPicUrl = f => `/api/shots/picture?f=${encodeURIComponent(f)}`;

let shotChat = '';
let shotList = null;
let shotTimer = 0;
/** Cards being edited (their forms stay while the list is drawn again). */
const shotEditing = new Set();
let shotStopAsk = false;

const shotOn = () => !!app.isClipChat?.();
/** The open Videographer chat's shot list as last read ({ chat, list }), for the Project tab's state words. */
app.shotListNow = () => ({ chat: shotChat, list: shotList });

/** The chat changed (clips.js's follow, from chats.js's drawHead): the shot list shows for a Videographer. */
const shotsFollowBefore = app.clipsFollow;
app.clipsFollow = () => {
  shotsFollowBefore?.();
  const on = shotOn();
  shotAddBtn.hidden = !on;
  shotPanel.hidden = !on;
  $('#subjects').classList.toggle('shots-on', on);
  $('#subjects-title').textContent = on ? 'Shot list' : 'Project | Tools | Office';
  $('#subjects-sum').title = on ? 'Show the shot list' : 'Show the project, tools and office';
  // The project's chats under the shot list's bar (projecttab.js): the tabs are hidden here.
  app.drawProjectTab?.();
  const chat = on ? app.chatId ?? '' : '';
  if (chat === shotChat && (on || !shotList)) return;
  shotChat = chat;
  shotList = null;
  shotTakesSeen = -1;
  shotEditing.clear();
  shotStopAsk = false;
  shotCards.replaceChildren();
  clearTimeout(shotTimer);
  if (on) void shotLoad();
};

$('#shot-hide').addEventListener('click', () => { $('#subjects-fold').open = false; });

async function shotLoad() {
  clearTimeout(shotTimer);
  const chat = shotChat;
  if (!chat) return shotDraw(null);
  const r = await api(`/api/shots?chat=${encodeURIComponent(chat)}`).catch(() => null);
  if (chat !== shotChat) return;
  if (r) shotDraw(r.list);
  // Once a second while a shot is made or the list waits for a time; else now and then (another window may change it).
  const busy = r?.list && ['running', 'pausing', 'scheduled', 'held'].includes(r.list.run);
  shotTimer = setTimeout(shotLoad, busy ? 1000 : 5000);
}

/** A change to the list: the server's answer is drawn; a refusal is said in the chat's note line. */
async function shotDo(path, body) {
  try {
    const r = await api(path, { chatId: shotChat, ...body });
    if (r.list !== undefined) shotDraw(r.list);
    return r;
  } catch (error) {
    if (error.data?.list !== undefined) shotDraw(error.data.list);
    app.chatNote(error.message);
    return null;
  }
}

// ---- Adding from the prompt box ----

/**
 * A picked start picture (clips.js's picker: { png } for a new one, { from, src } for one already here) as a shot's
 * start: a new PNG is kept for the shot list first. Null: the shot starts from nothing.
 */
async function shotStartOf(pick, name = '') {
  if (!pick) return { kind: 'none' };
  const words = name || pick.name || '';
  if (pick.png) {
    const r = await api('/api/shots/picture', { data: pick.png });
    return { kind: 'picture', file: r.file, name: words, src: shotPicUrl(r.file) };
  }
  return { kind: 'picture', from: pick.from, name: words, src: pick.src };
}

const shotChoices = () => ({
  seconds: Number($('#clip-seconds').value) || 3,
  size: $('#clip-size').value || 'wide',
  quality: $('#clip-quality').querySelector('input:checked')?.value ?? 'normal',
});

shotAddBtn.addEventListener('click', async () => {
  const input = $('#chat-input');
  const prompt = input.value.trim();
  if (!prompt) return app.chatNote('Type what the shot should show first, then press "Add to the shot list".');
  const from = app.chatId ?? '';
  const who = String(app.chatWho?.() ?? '');
  shotAddBtn.disabled = true;
  try {
    const start = await shotStartOf(app.clipStartPick?.() ?? null);
    const r = await api('/api/shots/add', { chatId: from, who, prompt, ...shotChoices(), start });
    input.value = '';
    if (start.kind === 'picture') app.setClipStart?.(null);
    if (r.chat !== from) {
      // The first shot of a new chat: the chat is made and opened.
      await app.afterSend?.(r.chat, from, who);
    }
    if ((app.chatId ?? '') === r.chat) {
      shotChat = r.chat;
      shotDraw(r.list);
      shotCards.querySelector(`[data-shot="${r.shot}"]`)?.scrollIntoView({ block: 'nearest' });
    }
  } catch (error) {
    app.chatNote(error.message);
  } finally {
    shotAddBtn.disabled = false;
  }
});

// ---- The top line and the run buttons ----

/** "3:00 tomorrow" for a start time. */
const shotWhen = iso => {
  const d = new Date(iso);
  const t = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  return d.toDateString() === today.toDateString() ? `${t} today` : d.toDateString() === tomorrow.toDateString() ? `${t} tomorrow` : `${t} on ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
};

/** The next time the clock shows `hhmm` (today, else tomorrow), as an ISO time. */
function shotNextAt(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const d = new Date();
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.toISOString();
}

const shotRunWords = {
  idle: '', running: 'Making the shots.', pausing: 'Pausing: the shot being made finishes first.', paused: 'Paused.', held: '', scheduled: '',
};

function shotRunBar(l) {
  const run = l?.run ?? 'idle';
  const has = !!l?.shots.some(s => s.state === 'waiting' || s.state === 'making');
  const going = ['running', 'pausing', 'held'].includes(run);
  const b = (text, title, onclick, o = {}) => el('button', { class: `btn ${o.primary ? 'primary' : 'quiet'} shot-btn`, type: 'button', text, title, onclick, disabled: o.off ? true : false });
  const kids = [];
  if (shotStopAsk) {
    kids.push(el('span', { class: 'shot-ask', text: 'Stop the shot being made? Nothing of it is kept.' }),
      b('Stop', 'Stops the shot being made; it waits again', async () => { shotStopAsk = false; await shotDo('/api/shots/run', { do: 'stop' }); }, { primary: true }),
      b('Keep going', '', () => { shotStopAsk = false; shotDraw(shotList); }));
    return $('#shot-run').replaceChildren(...kids);
  }
  kids.push(
    b(run === 'paused' || run === 'pausing' ? 'Carry on' : 'Start', 'Makes the shots in order on the hire\'s PC, one at a time', () => shotDo('/api/shots/run', { do: 'start' }), { primary: true, off: !has || run === 'running' || run === 'held' }),
    b('Pause', 'The shot being made finishes, then the list waits', () => shotDo('/api/shots/run', { do: 'pause' }), { off: !(going || run === 'scheduled') || run === 'pausing' }),
    b('Stop', 'Stops the shot being made (asked first)', () => {
      if (!l?.shots.some(s => s.state === 'making')) return shotDo('/api/shots/run', { do: 'stop' });
      shotStopAsk = true;
      shotDraw(shotList);
    }, { off: !(going || run === 'scheduled' || run === 'paused') }));
  const at = el('input', { type: 'time', id: 'shot-at', 'aria-label': 'Start at (time)', title: 'The time to start: today, or tomorrow when it has passed', value: store('app-shot-at') ?? '23:00' });
  at.addEventListener('change', () => store('app-shot-at', at.value));
  kids.push(el('span', { class: 'shot-at' },
    b('Start at', 'Starts the list at this time (for overnight)', () => {
      const when = shotNextAt(at.value);
      if (!when) return app.chatNote('Pick the time to start first.');
      return shotDo('/api/shots/run', { do: 'start', at: when });
    }, { off: !has || going }), at));
  const more = [];
  more.push(b('Make all as Draft first', 'Makes every waiting shot at Draft (quick, rougher), to see the whole video before the long run', () => shotDo('/api/shots/run', { do: 'draft' }), { off: !has || going }));
  // On unless turned off: each last frame a shot carries on from is matched to the first shot's colours (src/colourmatch.ts).
  const colour = el('input', { type: 'checkbox', checked: l ? l.colour !== false : true, disabled: !l });
  colour.addEventListener('change', () => shotDo('/api/shots/colour', { on: colour.checked }));
  more.push(el('label', { class: 'shot-colour', title: 'A shot that carries on from the shot before starts from its last frame with the colours of the first shot, so they do not drift along the list' }, colour, el('span', { text: 'Keep the colours of the first shot' })));
  // The kept take of every shot made so far, in order, as one video on the Videos shelf, to watch it whole (also while
  // the rest are still being made: those are left out and named). Skipped shots are left out.
  const made = l ? l.shots.filter(s => s.state === 'done').length : 0;
  const open = l ? l.shots.filter(s => s.state !== 'done' && s.state !== 'skipped').length : 0;
  more.push(b('Join the shots into one video', open ? `Joins the ${made} shots made so far, to watch them whole; the ${open} not made yet are left out` : 'Puts the kept take of every shot, in order, into one video on the Videos shelf', async () => {
    app.chatNote(`Joining ${made} shots…`);
    const r = await shotDo('/api/shots/join', {});
    if (!r?.clip) return;
    app.chatNote(`Joined: ${r.shots} shots, ${r.seconds} s, on the Videos shelf.${r.left?.length ? ` Not made yet, so left out: shot${r.left.length > 1 ? 's' : ''} ${r.left.join(', ')}.` : ''}`);
    app.openClip?.(r.clip.id);
  }, { off: made < 2 }));
  if (l?.upgradable) more.push(b('Make the kept ones at Normal', 'Each shot made at Draft is made again at Normal (or the quality it asked) from the same seed, so it looks the same, better', () => shotDo('/api/shots/run', { do: 'upgrade' }), { off: going }));
  kids.push(el('span', { class: 'shot-draft' }, ...more));
  $('#shot-run').replaceChildren(...kids);
}

function shotTopLine(l) {
  const top = $('#shot-top');
  top.textContent = l ? l.top : '0 shots · 0 s of video';
  const said = $('#shot-said');
  const words = !l ? '' : l.run === 'scheduled' && l.startAt ? `Starts at ${shotWhen(l.startAt)}${l.draft ? ', at Draft' : ''}.` : l.said || (l.run === 'running' && l.draft ? 'Making the shots at Draft.' : shotRunWords[l.run] ?? '');
  said.textContent = words;
  said.hidden = !words;
}

// ---- The cards ----

/** Takes finished in the list drawn last: one more means a clip's line was written in the chat, so it is shown. */
let shotTakesSeen = -1;
async function shotChatAgain(l) {
  const n = l ? l.shots.reduce((a, s) => a + s.takes.length, 0) : 0;
  const more = shotTakesSeen >= 0 && n > shotTakesSeen;
  shotTakesSeen = n;
  if (!more || !shotChat || (app.chatId ?? '') !== shotChat) return;
  const r = await api(`/api/chat?id=${encodeURIComponent(shotChat)}`).catch(() => null);
  if (r && (app.chatId ?? '') === shotChat) showChat(r);
}

function shotDraw(l) {
  void shotChatAgain(l);
  const runSig = x => `${x?.run ?? ''}:${x?.shots?.find(s => s.state === 'making')?.n ?? 0}:${x?.shots?.length ?? 0}`;
  const was = runSig(shotList);
  shotList = l;
  // A shot started or finished, or the run paused: the Project tab's word for this chat ("making shot 3 of 12") follows.
  if (runSig(l) !== was) app.drawProjectTab?.();
  shotTopLine(l);
  shotRunBar(l);
  const shots = l?.shots ?? [];
  $('#shot-empty').hidden = shots.length > 0;
  // Each card is drawn again only when it changed, so a player keeps playing while the list is followed.
  const have = new Map([...shotCards.children].map(c => [c.dataset.shot, c]));
  const want = shots.map(s => {
    const sig = JSON.stringify([s, shots.length, shotEditing.has(s.id)]);
    let card = have.get(s.id);
    if (card && card.dataset.sig === sig) return card;
    if (card && s.state === 'making' && card.dataset.state === 'making' && !shotEditing.has(s.id)) {
      // Only the progress moved.
      const fill = card.querySelector('.p-fill');
      if (fill) fill.style.width = `${Math.round(s.frac * 100)}%`;
      card.querySelector('.p-track')?.setAttribute('aria-valuenow', String(Math.round(s.frac * 100)));
      const line = card.querySelector('.shot-line');
      if (line) line.textContent = s.line || 'Starting the clip…';
      card.querySelector('.shot-n').textContent = String(s.n);
      return card;
    }
    card = shotCard(s, shots.length);
    card.dataset.sig = sig;
    return card;
  });
  const focusId = document.activeElement?.closest?.('[data-shot]')?.dataset.shot;
  const focusAct = document.activeElement?.dataset?.act;
  shotCards.replaceChildren(...want);
  // A card drawn again keeps the keyboard where it was (Move up and Move down pressed again and again).
  if (focusId && focusAct) shotCards.querySelector(`[data-shot="${focusId}"] [data-act="${focusAct}"]:not([disabled])`)?.focus();
}

function shotPlayer(t) {
  const v = el('video', { src: app.clipUrl(t.file), controls: '', preload: 'metadata', playsinline: '', loop: '', title: `${t.seconds} s · ${t.width}×${t.height} · ${shotQualities[t.quality] ?? t.quality}` });
  v.style.aspectRatio = `${t.width} / ${t.height}`;
  return v;
}

function shotCard(s, count) {
  const busy = s.state === 'making';
  const li = el('li', { class: `shot-card shot-${s.state}`, 'data-shot': s.id, 'data-state': s.state, draggable: shotEditing.has(s.id) ? 'false' : 'true', 'aria-label': `Shot ${s.n}: ${shotStates[s.state]}` });
  const meta = `${s.seconds} s · ${shotSizes[s.size] ?? s.size} · ${shotQualities[s.quality] ?? s.quality}`;
  li.append(el('div', { class: 'shot-card-head' },
    el('span', { class: 'shot-n', text: String(s.n), title: 'Drag the card to move it' }),
    el('span', { class: `shot-state shot-state-${s.state}`, text: shotStates[s.state] + (s.state === 'waiting' && s.want > 1 ? ` · ${s.want} takes` : '') }),
    el('span', { class: 'hint shot-meta', text: meta })));
  if (shotEditing.has(s.id)) return li.append(shotEditForm(s)), li;
  const start = el('p', { class: 'hint shot-start', text: shotStartWords[s.start.kind] });
  if (s.start.kind === 'picture' && s.start.src) start.prepend(el('img', { src: s.start.src, alt: '', class: 'shot-pic' }));
  li.append(start, el('p', { class: 'shot-prompt', text: s.prompt, title: s.prompt }));
  if (busy) {
    const pct = Math.round(s.frac * 100);
    const fill = el('div', { class: 'p-fill' });
    fill.style.width = `${pct}%`;
    li.append(el('div', { class: 'p-track', role: 'progressbar', 'aria-label': `Shot ${s.n} progress`, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct) }, fill),
      el('p', { class: 'hint shot-line', text: s.line || 'Starting the clip…' }));
  }
  if (s.takes.length) {
    const kept = s.takes.find(t => t.clip === s.kept);
    const show = kept ? [kept] : s.takes.length === 1 ? s.takes : s.takes;
    const choose = !kept && s.takes.length > 1;
    const box = el('div', { class: `shot-takes${choose ? ' shot-choose' : ''}` });
    for (const t of show) {
      const take = el('div', { class: 'shot-take' }, shotPlayer(t));
      const cap = el('div', { class: 'shot-take-cap' }, el('span', { class: 'hint', text: shotQualities[t.quality] ?? t.quality }));
      if (choose) cap.append(el('button', { class: 'btn quiet shot-btn', type: 'button', text: 'Keep this one', title: 'This take is the shot; the others stay on the Videos shelf', onclick: () => shotDo('/api/shots/keep', { id: s.id, clip: t.clip }) }));
      take.append(cap);
      if (t.note) take.append(el('p', { class: 'hint', text: t.note }));
      box.append(take);
    }
    if (kept && s.takes.length > 1) box.append(el('p', { class: 'hint', text: `${s.takes.length - 1} other take${s.takes.length > 2 ? 's' : ''} on the Videos shelf.` }));
    li.append(box);
  }
  if (s.error && (s.state === 'failed' || s.state === 'waiting')) li.append(el('p', { class: 'hint fault-line shot-fault', role: s.state === 'failed' ? 'alert' : null, text: s.state === 'waiting' ? `Tried once: ${s.error} It is tried once more.` : s.error }));
  const b = (text, act, title, onclick, off = false) => el('button', { class: 'btn quiet shot-btn', type: 'button', text, title, 'data-act': act, onclick, disabled: off ? true : false });
  const canEdit = ['waiting', 'failed', 'skipped'].includes(s.state);
  li.append(el('div', { class: 'shot-btns' },
    b('Move up', 'up', 'Moves this shot one place earlier', () => shotDo('/api/shots/move', { id: s.id, to: s.n - 2 }), s.n === 1),
    b('Move down', 'down', 'Moves this shot one place later', () => shotDo('/api/shots/move', { id: s.id, to: s.n }), s.n === count),
    b('Edit', 'edit', 'Change the words, length, size, quality or start', () => { shotEditing.add(s.id); shotDraw(shotList); shotCards.querySelector(`[data-shot="${s.id}"] textarea`)?.focus(); }, !canEdit),
    b('Make 3', 'three', 'Makes three takes with new seeds: then press "Keep this one" on the best', () => shotDo('/api/shots/redo', { id: s.id, takes: 3 }), busy),
    b(s.state === 'skipped' ? 'Put back' : 'Skip', 'skip', s.state === 'skipped' ? 'Puts this shot back in the list' : 'Leaves this shot out when the list is made', () => shotDo('/api/shots/skip', { id: s.id }), busy),
    b('Redo', 'redo', 'Makes this shot again with a new seed (its clips stay on the Videos shelf)', () => shotDo('/api/shots/redo', { id: s.id }), busy || s.state === 'waiting'),
    b('Delete', 'delete', busy ? 'Stops this shot and takes it off the list (its clips stay on the Videos shelf)' : 'Takes this shot off the list (its clips stay on the Videos shelf)', () => shotDo('/api/shots/delete', { id: s.id }))));
  return li;
}

function shotEditForm(s) {
  const prompt = el('textarea', { rows: '3', maxlength: '1000', spellcheck: 'true', 'aria-label': 'What the shot shows' });
  prompt.value = s.prompt;
  const opt = (sel, list, now) => {
    for (const [v, t] of list) sel.append(el('option', { value: v, text: t }));
    sel.value = String(now);
    return sel;
  };
  const seconds = opt(el('select', { 'aria-label': 'Length' }), [1, 2, 3, 4, 5].map(n => [String(n), `${n} s`]), s.seconds);
  const size = opt(el('select', { 'aria-label': 'Size' }), shotSizesHere(s.size), s.size);
  const quality = opt(el('select', { 'aria-label': 'Quality' }), Object.entries(shotQualities), s.quality);
  const start = opt(el('select', { 'aria-label': 'Start' }), [['none', 'Nothing'], ['last', 'The last frame of the shot before'], ['picture', 'A picture']], s.start.kind);
  let picture = s.start.kind === 'picture' ? s.start : null;
  const pic = el('img', { class: 'shot-pic', alt: '', hidden: !picture?.src, ...(picture?.src ? { src: picture.src } : {}) });
  const pickBtn = el('button', { class: 'btn quiet shot-btn', type: 'button', text: picture ? 'Pick another…' : 'Pick a picture…', title: 'This project, the gallery or a file' });
  pickBtn.addEventListener('click', () => app.pickStartPicture?.(async (pick, name) => {
    try {
      picture = await shotStartOf(pick, name);
      pic.src = picture.src ?? '';
      pic.hidden = !picture.src;
      pickBtn.textContent = 'Pick another…';
    } catch (error) {
      app.chatNote(error.message);
    }
  }));
  const picRow = el('div', { class: 'shot-pic-row', hidden: start.value !== 'picture' }, pic, pickBtn);
  start.addEventListener('change', () => { picRow.hidden = start.value !== 'picture'; });
  const field = (label, ctl) => el('label', { class: 'field' }, el('span', { text: label }), ctl);
  const done = () => { shotEditing.delete(s.id); shotDraw(shotList); };
  const form = el('form', { class: 'shot-edit' }, prompt,
    el('div', { class: 'shot-edit-row' }, field('Length', seconds), field('Size', size), field('Quality', quality)),
    field('Starts from', start), picRow,
    el('div', { class: 'shot-btns' },
      el('button', { class: 'btn primary shot-btn', type: 'submit', text: 'Save' }),
      el('button', { class: 'btn quiet shot-btn', type: 'button', text: 'Cancel', onclick: done })));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (start.value === 'picture' && !picture) return app.chatNote('Pick the picture this shot starts from first.');
    const r = await shotDo('/api/shots/edit', { id: s.id, prompt: prompt.value, seconds: Number(seconds.value), size: size.value, quality: quality.value, start: start.value === 'picture' ? picture : { kind: start.value } });
    if (r) done();
  });
  form.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); done(); } });
  return form;
}

// ---- Drag to reorder ----

let shotDragged = '';
shotCards.addEventListener('dragstart', e => {
  const card = e.target.closest?.('[data-shot]');
  if (!card || card.getAttribute('draggable') !== 'true') return;
  shotDragged = card.dataset.shot;
  card.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', shotDragged);
});
shotCards.addEventListener('dragend', () => {
  shotDragged = '';
  for (const c of shotCards.querySelectorAll('.dragging, .drop-before, .drop-after')) c.classList.remove('dragging', 'drop-before', 'drop-after');
});
const shotDropAt = e => {
  const card = e.target.closest?.('[data-shot]');
  if (!card) return null;
  const r = card.getBoundingClientRect();
  return { card, after: e.clientY > r.top + r.height / 2 };
};
shotCards.addEventListener('dragover', e => {
  if (!shotDragged) return;
  e.preventDefault();
  for (const c of shotCards.querySelectorAll('.drop-before, .drop-after')) c.classList.remove('drop-before', 'drop-after');
  const at = shotDropAt(e);
  if (at && at.card.dataset.shot !== shotDragged) at.card.classList.add(at.after ? 'drop-after' : 'drop-before');
});
shotCards.addEventListener('drop', e => {
  if (!shotDragged || !shotList) return;
  e.preventDefault();
  const at = shotDropAt(e);
  const id = shotDragged;
  if (!at || at.card.dataset.shot === id) return;
  const ids = shotList.shots.map(s => s.id);
  const from = ids.indexOf(id);
  let to = ids.indexOf(at.card.dataset.shot) + (at.after ? 1 : 0);
  if (from < to) to--;
  if (to !== from) void shotDo('/api/shots/move', { id, to });
});

// ---- The last frame of the shot before ----

/**
 * A shot that carries on from the shot before needs that clip's last frame. TOMLIN reads it itself (src/server/shots.ts
 * framesHere); this page reads one only when that could not be done (a player and a canvas, clips.js's lastFrameOf).
 * Never while the page is hidden: a hidden page's player draws black, and a black frame was carried on from (27 Nov).
 */
const shotFramesBusy = new Set();
async function shotFrames() {
  try {
    if (app.lockShown || !app.lastFrameOf || document.hidden) return;
    const r = await api('/api/shots/frames');
    for (const f of r.frames ?? []) {
      const key = `${f.shot}|${f.clip}`;
      if (shotFramesBusy.has(key)) continue;
      shotFramesBusy.add(key);
      try {
        const data = await app.lastFrameOf(app.clipUrl(f.file));
        await api('/api/shots/frame', { chat: f.chat, id: f.shot, clip: f.clip, data });
        if (f.chat === shotChat) void shotLoad();
      } catch {
        // Tried again on the next look (the clip may still be being written, or the list moved on).
      } finally {
        shotFramesBusy.delete(key);
      }
    }
  } catch {
    // TOMLIN is not answering or is locked: looked again later.
  } finally {
    setTimeout(shotFrames, 4000);
  }
}
setTimeout(shotFrames, 2000);

app.clipsFollow();
