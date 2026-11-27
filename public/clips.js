// A Videographer's chat: the length, size and quality under the box, Make clip, a progress line with the time left and
// Stop while it is made, then the clip with a player in the chat. The Videos shelf (in a window from the chat, and as
// a shelf of the pictures pane's gallery) lists every clip. Uses app.js's helpers ($, el, api, app) and chatview.js's
// showChat; the server side is src/server/clips.ts.
'use strict';

const clipRow = $('#clip-row');
const clipSeconds = $('#clip-seconds');
const clipSize = $('#clip-size');
const clipQuality = $('#clip-quality');
const clipLow = $('#clip-lowdisk');
const clipKeep = (k, v) => {
  try {
    if (v === undefined) return localStorage.getItem(`app-clip-${k}`);
    localStorage.setItem(`app-clip-${k}`, v);
  } catch {
    // Not kept in this browser.
  }
  return null;
};
const clipSecs = n => (n < 60 ? `${Math.max(1, Math.round(n))} s` : `${Math.floor(n / 60)} min${Math.round(n % 60) ? ` ${Math.round(n % 60)} s` : ''}`);

/** Lengths, sizes and qualities from the server, once; the low-disk line each time a Videographer's chat opens. */
let clipOptions = null;
async function loadClipOptions() {
  const o = await api('/api/clips/options').catch(() => null);
  if (!o) return;
  if (!clipOptions) {
    clipOptions = o;
    clipSeconds.replaceChildren(...Array.from({ length: o.maxSeconds }, (_, i) => el('option', { value: String(i + 1), text: `${i + 1} s` })));
    clipSeconds.value = clipKeep('seconds') ?? String(Math.min(3, o.maxSeconds));
    if (!clipSeconds.value) clipSeconds.value = '1';
    if (o.maxSteps) clipSteps.max = String(o.maxSteps);
    const q0 = clipKeep('quality') ?? 'normal';
    clipQuality.replaceChildren(...o.qualities.map(q => el('label', { title: q.hint }, el('input', { type: 'radio', name: 'clip-quality', value: q.id, checked: q.id === q0 }), el('span', { text: q.name }))));
    if (!clipQuality.querySelector('input:checked')) clipQuality.querySelector('input').checked = true;
  }
  drawClipSizes();
  clipLow.textContent = o.lowDisk ?? '';
  clipLow.hidden = !o.lowDisk;
}

/** The sizes this hire's model takes: the 720p ones only for a model made for 720p (each chat may differ). */
const clipSizesHere = () => (clipOptions?.sizes ?? []).filter(s => !s.hd || app.chatPerson?.hd);
app.clipSizesHere = clipSizesHere;
/**
 * The size kept for a model made for 720p is kept apart from the others, and it starts at 720p: Wan 2.2 5B at 832×480
 * drifted faces within seconds, and at its own 1280×704 the first shot held (27 Nov).
 */
const sizeKey = () => (app.chatPerson?.hd ? 'size720' : 'size');
function drawClipSizes() {
  const sizes = clipSizesHere();
  if (!sizes.length) return;
  clipSize.replaceChildren(...sizes.map(s => el('option', { value: s.id, text: `${s.name} ${s.width}×${s.height}` })));
  const first = (app.chatPerson?.hd && sizes.find(s => s.hd)) || sizes[0];
  clipSize.value = clipKeep(sizeKey()) ?? first.id;
  if (!clipSize.value) clipSize.value = first.id;
}
clipSeconds.addEventListener('change', () => clipKeep('seconds', clipSeconds.value));
clipSize.addEventListener('change', () => clipKeep(sizeKey(), clipSize.value));
clipQuality.addEventListener('change', () => clipKeep('quality', clipQuality.querySelector('input:checked')?.value ?? 'normal'));

// More options: the words to leave out, the seed (empty: a new random one each clip, kept with the clip) and the steps
// (empty: the quality's own). The leave-out words are kept in this browser, as the length and size are.
const clipNegative = $('#clip-negative');
const clipSeed = $('#clip-seed');
const clipSteps = $('#clip-steps');
clipNegative.value = clipKeep('negative') ?? '';
clipNegative.addEventListener('change', () => clipKeep('negative', clipNegative.value.trim()));
$('#clip-dice').addEventListener('click', () => {
  clipSeed.value = String(Math.floor(Math.random() * 2 ** 31));
});
const clipMore = () => ({ negative: clipNegative.value.trim(), seed: clipSeed.value.trim(), steps: clipSteps.value.trim() });

const isClipChat = () => !!app.chatPerson?.video;
app.isClipChat = isClipChat;

/** The open chat changed (chats.js drawHead): the clip choices show for a Videographer, and a clip on its way is followed. */
let clipShown = '';
app.clipsFollow = () => {
  const on = isClipChat();
  clipRow.hidden = !on;
  drawStart();
  $('#chat-send').textContent = on ? 'Make clip' : 'Send';
  $('#chat-send').title = on ? 'Makes a clip of what you typed, on this PC (Enter does the same)' : '';
  $('#chat-form').classList.toggle('clip-chat', on);
  // Connect, its state and the model settings are a chat model's: a clip loads its video model by itself.
  $('#pane-chat').classList.toggle('clip-chat', on);
  if (on) $('#chat-input').placeholder = 'What should the clip show? e.g. waves rolling onto a beach at sunset';
  const key = `${app.chatId ?? ''}|${on}`;
  if (key === clipShown) return;
  clipShown = key;
  if (!on) return;
  void loadClipOptions();
  if (app.chatId) void followClipIn(app.chatId);
};

// ---- Making a clip ----

/** The bubble that follows one clip until it ends: the line, a bar and Stop. One per clip id. */
const clipWaits = new Map();
function waitBubble(id) {
  const fill = el('div', { class: 'p-fill' });
  const bar = el('div', { class: 'p-track', role: 'progressbar', 'aria-label': 'Clip progress', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, fill);
  const line = el('span', { class: 'p-text', text: 'Starting the clip…' });
  const stop = el('button', { class: 'btn', type: 'button', text: 'Stop', title: 'Stop this clip: nothing is kept', onclick: async () => {
    stop.disabled = true;
    await api('/api/clips/stop', { id }).catch(error => app.chatNote(error.message));
  } });
  const box = el('div', { class: 'msg assistant clip-wait', 'data-clip': id, role: 'status' }, el('b', { text: 'Clip in progress' }), bar, el('div', { class: 'ip-row' }, line, stop));
  return { box, fill, bar, line, stop };
}

function drawWait(w, j) {
  const frac = j.state === 'queued' ? 0 : j.state === 'loading' ? 0.03 : j.state === 'joining' ? 0.97 : j.total ? Math.min(0.95, 0.05 + (j.done / j.total) * 0.9) : 0.05;
  const pct = Math.round(frac * 100);
  w.fill.style.width = `${pct}%`;
  w.bar.setAttribute('aria-valuenow', String(pct));
  w.line.textContent = j.line || 'Starting the clip…';
}

/** Follows a clip until it is done, stopped or failed, then shows the chat again (with the clip, or its plain line). */
async function followClip(chatId, j) {
  if (clipWaits.has(j.id)) return;
  const log = $('#chat-log');
  const w = waitBubble(j.id);
  clipWaits.set(j.id, w);
  log.querySelector('.empty')?.remove();
  log.append(w.box);
  log.scrollTop = log.scrollHeight;
  try {
    for (;;) {
      drawWait(w, j);
      if (!['queued', 'loading', 'making', 'joining'].includes(j.state)) break;
      await new Promise(r => setTimeout(r, 1000));
      const r = await api(`/api/clips/job?id=${encodeURIComponent(j.id)}`).catch(() => null);
      if (!r?.job) break;
      j = r.job;
      // Another chat opened meanwhile: the clip carries on; this chat shows it again when it is opened.
      if ((app.chatId ?? '') !== chatId) return;
      if (!w.box.isConnected) log.append(w.box);
    }
  } finally {
    clipWaits.delete(j.id);
    w.box.remove();
  }
  if ((app.chatId ?? '') === chatId) {
    const r = await api(`/api/chat?id=${encodeURIComponent(chatId)}`).catch(() => null);
    if (r && (app.chatId ?? '') === chatId) showChat(r);
  }
  app.redrawClipShelves();
}

async function followClipIn(chatId) {
  const r = await api(`/api/clips/job?chat=${encodeURIComponent(chatId)}`).catch(() => null);
  if (r?.job && ['queued', 'loading', 'making', 'joining'].includes(r.job.state) && (app.chatId ?? '') === chatId) void followClip(chatId, r.job);
}

/** Make clip pressed in a Videographer's chat (chatview.js sends here instead of to a model). */
app.makeClip = async message => {
  const chatId = app.chatId ?? '';
  const who = String(app.chatWho?.() ?? '');
  const input = $('#chat-input');
  input.value = '';
  const log = $('#chat-log');
  log.querySelector('.empty')?.remove();
  const mine = el('div', { class: 'msg user' }, message);
  log.append(mine);
  log.scrollTop = log.scrollHeight;
  try {
    const sent = clipStart;
    const start = sent ? { ...(sent.png ? { start: sent.png } : { startFrom: sent.from }), ...(sent.name ? { startName: sent.name } : {}) } : {};
    const r = await api('/api/clips/make', { chatId, who, prompt: message, seconds: Number(clipSeconds.value) || 3, size: clipSize.value, quality: clipQuality.querySelector('input:checked')?.value ?? 'normal', ...clipMore(), ...start });
    // The picture went with that clip: the slot is empty for the next one.
    if (sent && clipStart === sent) setClipStart(null);
    // The chat is named by its first message and moves to the top of the list (a new one, or one opened empty).
    await app.afterSend?.(r.chat, chatId, who);
    if ((app.chatId ?? '') === r.chat) {
      const c = await api(`/api/chat?id=${encodeURIComponent(r.chat)}`).catch(() => null);
      if (c) showChat(c);
      void followClip(r.chat, r.job);
    }
  } catch (error) {
    if (error.data?.chat) {
      // Said in the chat (too many waiting): shown as the chat has it.
      await app.afterSend?.(error.data.chat, chatId, who);
      const c = await api(`/api/chat?id=${encodeURIComponent(error.data.chat)}`).catch(() => null);
      if (c) return void showChat(c);
    }
    // Nothing was saved (no prompt, too long): the words go back in the box.
    mine.remove();
    input.value = message;
    app.chatNote(error.message);
  }
};

// ---- The start picture: a clip can start from a picture (Wan 2.2 5B), or carry on from a clip's last frame ----

/** The picture the next clip in this chat starts from: { png (a data URL), chat, who }, or null. */
let clipStart = null;
const startSlot = el('div', { class: 'clip-start', id: 'clip-start', hidden: '' });
$('#chat-input').before(startSlot);
const startFile = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: '' });
startSlot.after(startFile);
/** The longest side a start picture is sent at: the server crops it to the clip's size (1280 at most) anyway. */
const START_SIDE = 1600;

/** A picture (a Blob) or a <video> on its current frame as a PNG data URL, no larger than START_SIDE on a side. */
async function pngOf(src) {
  const isVideo = src instanceof HTMLVideoElement;
  const pic = isVideo ? src : await createImageBitmap(src);
  const w0 = isVideo ? src.videoWidth : pic.width;
  const h0 = isVideo ? src.videoHeight : pic.height;
  if (!w0 || !h0) throw new Error('That picture could not be read.');
  const k = Math.min(1, START_SIDE / Math.max(w0, h0));
  const c = el('canvas', { width: String(Math.round(w0 * k)), height: String(Math.round(h0 * k)) });
  c.getContext('2d').drawImage(pic, 0, 0, c.width, c.height);
  pic.close?.();
  return c.toDataURL('image/png');
}
const pngOfUrl = async url => {
  const r = await fetch(url);
  if (!r.ok) throw new Error('That picture is not on this PC any more.');
  return pngOf(await r.blob());
};

const waitFor = (target, event, ms = 10000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('The clip did not load in time.')), ms);
  target.addEventListener(event, () => { clearTimeout(t); resolve(); }, { once: true });
  target.addEventListener('error', () => { clearTimeout(t); reject(new Error('The clip could not be read.')); }, { once: true });
});

/** The last frame of the clip at `url`, read here in the browser: a hidden player seeks to its end and draws it. */
async function lastFrameOf(url) {
  const v = el('video', { preload: 'auto', playsinline: '' });
  v.muted = true;
  const meta = waitFor(v, 'loadedmetadata');
  v.src = url;
  await meta;
  // A clip that does not say its length: a seek far past the end makes the player find it.
  if (!Number.isFinite(v.duration)) {
    const found = waitFor(v, 'seeked');
    v.currentTime = 1e9;
    await found;
  }
  // The end itself: a clip's last frame sits at its full length (121 frames at 24 a second end at 5.000 s), so a seek
  // 0.05 s short showed frame 118 of 120 and every shot carried on two frames back in time, a jump at each join.
  const seeked = waitFor(v, 'seeked');
  v.currentTime = v.duration;
  await seeked;
  if (v.readyState < 2) await waitFor(v, 'loadeddata');
  const png = await pngOf(v);
  v.removeAttribute('src');
  v.load();
  return png;
}
app.lastFrameOf = lastFrameOf;

/**
 * Sets (or with null, clears) the start picture of the next clip in the open chat. `pick`: { png } for a new picture (a
 * file, a clip's frame: a PNG data URL), or { from, src } for one already on this PC (from: {gallery: <id or file>} or
 * {project: <workspace path>}; src: its preview); `name`: words for its file name. A bare data URL is taken as { png }.
 */
function setClipStart(pick, name = '') {
  const p = typeof pick === 'string' ? { png: pick } : pick;
  clipStart = p ? { ...p, src: p.png ?? p.src, name: name || p.name || '', chat: app.chatId ?? '', who: String(app.chatWho?.() ?? '') } : null;
  drawStart();
  // A picture on this PC that says its style: one that drifts in video gets a plain warning under it (never a block).
  const from = clipStart?.from;
  const q = from?.gallery ? `gallery=${encodeURIComponent(from.gallery)}` : from?.project ? `project=${encodeURIComponent(from.project)}` : '';
  if (!q) return;
  const mine = clipStart;
  void api(`/api/pairing/start?${q}`).then(r => {
    if (clipStart !== mine || !r?.warning) return;
    mine.warn = r.warning;
    drawStart();
  }, () => undefined);
}
app.setClipStart = setClipStart;
app.clipStartNow = () => clipStart?.src ?? null;

function drawStart() {
  const on = isClipChat();
  startSlot.hidden = !on;
  // The picture belongs to the chat it was added in (and to its Videographer, while a new chat has no id yet).
  if (clipStart && ((clipStart.chat && clipStart.chat !== (app.chatId ?? '')) || clipStart.who !== String(app.chatWho?.() ?? ''))) clipStart = null;
  if (!on) return;
  const person = app.chatPerson;
  if (clipStart) {
    const cant = person?.startPicture === false;
    startSlot.replaceChildren(
      el('img', { class: 'clip-start-pic', src: clipStart.src, alt: 'The picture the clip starts from' }),
      el('span', { class: cant ? 'hint clip-start-warn' : 'hint', text: cant ? person.wordsOnly : 'The clip starts from this picture.' }),
      el('button', { class: 'btn quiet', type: 'button', text: 'Remove', title: 'Make the clip from the words only', onclick: () => setClipStart(null) }),
      !cant && clipStart.warn ? el('p', { class: 'hint clip-start-warn clip-start-drift', text: clipStart.warn }) : '');
    return;
  }
  startSlot.replaceChildren(el('button', { class: 'btn quiet', type: 'button', text: 'Add a picture', title: 'Start the clip from a picture (Wan 2.2 5B): this project, the gallery or a file', onclick: () => pickStart() }));
}

startFile.addEventListener('change', async () => {
  const f = startFile.files?.[0];
  startFile.value = '';
  if (!f) return;
  try {
    pickInto({ png: await pngOf(f) }, f.name.replace(/\.[^.]+$/, ''));
    if (pickDlg.open) pickDlg.close();
  } catch {
    app.chatNote('That file could not be read as a picture: pick a PNG, JPEG or WebP.');
  }
});

/** Where a picture picked in the window goes: the next clip's start (setClipStart), or a shot's (shots.js). */
let pickInto = setClipStart;
/** The picker for another start than the next clip's: `onPick(pick, name)` gets what setClipStart would. */
app.pickStartPicture = onPick => pickStart(onPick);
/** The start picture set for the next clip, as picked (or null). */
app.clipStartPick = () => (clipStart ? { png: clipStart.png, from: clipStart.from, src: clipStart.src, name: clipStart.name } : null);

/** A small window of choices (made once): a title, a line, and buttons or tiles. */
const pickDlg = el('dialog', { class: 'clip-picker', 'aria-labelledby': 'clip-picker-title' });
document.body.append(pickDlg);
function openPick(title, line, ...body) {
  pickDlg.replaceChildren(el('h3', { id: 'clip-picker-title', text: title }), line ? el('p', { class: 'hint', text: line }) : '', ...body,
    el('form', { method: 'dialog' }, el('button', { class: 'btn', type: 'submit', text: 'Close' })));
  if (!pickDlg.open) pickDlg.showModal();
}

const galleryUrl = rel => `/api/images/file/${rel.split('/').map(encodeURIComponent).join('/')}`;
const projectUrl = path => `/api/files/picture?path=${encodeURIComponent(path)}`;
/** One picture to pick: a tile that sets it as the start picture and closes the window. */
const pickTile = (src, title, pick, name) => el('button', { class: 'tile clip-picker-tile', type: 'button', title, onclick: () => { pickInto(pick, name); pickDlg.close(); } },
  el('img', { src, alt: title, loading: 'lazy' }));

/**
 * Add a picture: a window with five tabs. This project (the pictures this chat's project's Artists handed in, newest
 * first; it opens here when the chat belongs to a project), Characters and Locations (each card's pictures, under its
 * name), Gallery (the picture shelves) and A file.
 */
async function pickStart(onPick = setClipStart) {
  pickInto = onPick;
  const tabs = el('div', { class: 'g-shelves clip-picker-tabs', role: 'tablist', 'aria-label': 'Where the picture comes from' });
  const box = el('div', { class: 'clip-picker-body' });
  openPick('Start from a picture', 'The clip starts from the picture you pick. It is cropped to the clip’s size.', tabs, box);
  const proj = await api(`/api/clips/project-pictures?chat=${encodeURIComponent(app.chatId ?? '')}`).catch(() => ({ project: null, pictures: [] }));
  const show = async tab => {
    for (const b of tabs.children) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    for (const b of tabs.children) b.setAttribute('aria-pressed', String(b.dataset.tab === tab));
    if (tab === 'file') {
      return box.replaceChildren(el('p', { class: 'hint', text: 'A PNG, JPEG or WebP picture from this PC.' }),
        el('button', { class: 'btn', type: 'button', text: 'Choose a file…', onclick: () => startFile.click() }));
    }
    if (tab === 'project') {
      if (!proj.project) return box.replaceChildren(el('p', { class: 'hint', text: 'This chat is not in a project. Put it in one (Project, at the top of the chat) to pick from its Artists’ pictures.' }));
      const tiles = proj.pictures.map(p => pickTile(projectUrl(p.path), p.name, { from: { project: p.path }, src: projectUrl(p.path) }, p.name.replace(/\.[^.]+$/, '')));
      return box.replaceChildren(el('div', { class: 'gallery clip-picker-tiles' }, ...tiles),
        tiles.length ? '' : el('p', { class: 'hint', text: `No pictures in ${proj.folder.replace(/\//g, '\\')} yet: an Artist's pictures kept in this project go there.` }));
    }
    if (tab === 'character' || tab === 'location') {
      const kind = tab === 'character' ? 'characters' : 'locations';
      if (!proj.project) return box.replaceChildren(el('p', { class: 'hint', text: `This chat is not in a project. Put it in one (Project, at the top of the chat) to pick from its ${kind}' pictures.` }));
      const cards = (proj.cards ?? []).filter(k => k.kind === tab && k.pictures.length);
      if (!cards.length) return box.replaceChildren(el('p', { class: 'hint', text: `No ${kind} with pictures in this project yet: add them in Character sets, in the Images window.` }));
      // Each card's pictures under its name, newest first.
      return box.replaceChildren(...cards.flatMap(k => [
        el('p', {}, el('strong', { text: k.name })),
        el('div', { class: 'gallery clip-picker-tiles' }, ...k.pictures.map(p => pickTile(projectUrl(p), `${k.name}: ${p.split('/').pop()}`, { from: { project: p }, src: projectUrl(p) }, k.name))),
      ]));
    }
    // Gallery: its shelves, as the pictures pane has them.
    const shelves = el('div', { class: 'g-shelves', role: 'group', 'aria-label': 'Shelf' });
    const tilesBox = el('div', { class: 'gallery clip-picker-tiles' }, el('p', { class: 'hint', text: 'Loading the gallery…' }));
    const shelf = async s => {
      for (const b of shelves.children) b.setAttribute('aria-pressed', String(b.dataset.shelf === s));
      try {
        const g = await api(`/api/images/gallery?shelf=${s}&offset=0&limit=60`);
        tilesBox.replaceChildren(...g.pictures.map(p => pickTile(galleryUrl(p.output), p.prompt, { from: { gallery: p.id }, src: galleryUrl(p.output) }, p.prompt)));
        if (!g.pictures.length) tilesBox.append(el('p', { class: 'hint', text: s === 'drafts' ? 'No drafts.' : 'No pictures yet: an Artist draws them, or add one from a file.' }));
      } catch (error) {
        tilesBox.replaceChildren(el('p', { class: 'hint', text: error.message }));
      }
    };
    for (const [id, name] of [['gallery', 'Gallery'], ['drafts', 'Drafts'], ['all', 'All']]) shelves.append(el('button', { class: 'g-shelf', type: 'button', 'data-shelf': id, text: name, onclick: () => shelf(id) }));
    box.replaceChildren(shelves, tilesBox);
    await shelf('gallery');
  };
  for (const [id, name] of [['project', 'This project'], ['character', 'Characters'], ['location', 'Locations'], ['gallery', 'Gallery'], ['file', 'A file']]) tabs.append(el('button', { class: 'g-shelf', type: 'button', role: 'tab', 'data-tab': id, text: name, onclick: () => show(id) }));
  await show(proj.project ? 'project' : 'gallery');
}

/** Opens a Videographer's chat with `pick` as the start picture and `prompt` (if any) ready in the box. */
async function intoVideographer(who, pick, name = '', prompt = '', project = '') {
  await app.openVideographer(who, project);
  setClipStart(pick, name);
  const input = $('#chat-input');
  if (prompt) input.value = prompt;
  input.focus();
}

/**
 * "Make a clip from this picture" (the picture viewer, an Artist's chat): a Videographer's chat opens with the picture
 * as the start. `from`: the picture on this PC ({gallery: <id or file>}); `name`: its prompt. With several Videographers
 * it asks which one; with none, it says so and offers Hire staff.
 */
app.clipFromPicture = async (url, from = null, name = '') => {
  const team = app.videographers?.() ?? [];
  if (!team.length) {
    return openPick('Nobody makes clips yet', 'Clips are made by a Videographer. Hire one, give them Wan 2.2 5B to start from a picture, then press this again.',
      el('div', { class: 'clip-picker-who' }, el('button', { class: 'btn primary', type: 'button', text: 'Hire staff', onclick: () => { pickDlg.close(); app.openHire?.({ role: 'videographer' }); } })));
  }
  // Pressed in a project's chat (an Artist's), the Videographer's chat opens in that same project.
  const project = app.chatProject?.() ?? '';
  let pick;
  try {
    pick = from ? { from, src: url } : { png: await pngOfUrl(url) };
  } catch (error) {
    return openPick('Make a clip from this picture', error.message);
  }
  if (team.length === 1) return intoVideographer(team[0].who, pick, name, '', project);
  openPick('Make a clip from this picture', 'Which Videographer makes it?', el('div', { class: 'clip-picker-who' }, ...team.map(p => el('button', {
    class: 'btn', type: 'button', text: p.name, title: p.startPicture === false ? p.wordsOnly : `${p.name} starts the clip from this picture`,
    onclick: () => { pickDlg.close(); void intoVideographer(p.who, pick, name, '', project); },
  }))));
};

/** Puts a picture taken from a clip into the chat it was made in (opened first when another chat is open), with its prompt. */
async function carryOn(clip, png, chat, name) {
  if (chat && chat !== (app.chatId ?? '')) {
    try {
      await app.openChat(chat);
    } catch {
      if (clip.who) return intoVideographer(clip.who, { png }, name, clip.prompt ?? '');
      throw new Error('The chat this clip was made in is not there any more.');
    }
  }
  setClipStart({ png }, name);
  const input = $('#chat-input');
  input.value = clip.prompt ?? '';
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

/** "Started from": the picture a clip started from, small, with Open (a clip from before this has none). */
function startedFrom(clip) {
  if (!clip.start) return null;
  const url = `/api/clips/start?id=${encodeURIComponent(clip.id)}`;
  const name = clip.start.name ?? String(clip.start.project ?? clip.start.path ?? '').split(/[\\/]/).pop();
  const img = el('img', { class: 'clip-from-pic', src: url, alt: `Started from ${name}`, loading: 'lazy' });
  const row = el('span', { class: 'clip-from' }, el('span', { class: 'hint', text: 'Started from' }), img,
    el('a', { class: 'btn quiet', href: url, target: '_blank', rel: 'noopener', text: 'Open', title: name }));
  img.addEventListener('error', () => row.replaceChildren(el('span', { class: 'hint', text: `Started from ${name} (not on this PC any more)` })), { once: true });
  return row;
}

/**
 * Under a finished clip (in its chat and on the Videos shelf): Carry on from here (its last frame starts the next clip)
 * and Use this frame (the frame the player is paused on). `chat`: the chat it was made in ('' = the open one).
 */
app.clipActs = (clip, video, chat = '') => {
  const said = el('span', { class: 'hint', role: 'status' });
  return el('span', { class: 'clip-carry' }, startedFrom(clip), ...carryButtons(clip, video, chat, text => (said.textContent = text)), said);
};

/** Carry on from here and Use this frame for `clip` shown in `video`; `say` shows why one did nothing. */
function carryButtons(clip, video, chat, say) {
  const busy = async (b, work) => {
    b.disabled = true;
    say('');
    try {
      await work();
      // From the Videos window or the clip viewer: the chat it goes to is behind them.
      for (const d of ['#clip-viewer', '#clips-dlg']) if ($(d)?.open) $(d).close();
    } catch (error) {
      say(error.message);
    } finally {
      b.disabled = false;
    }
  };
  const carry = el('button', { class: 'btn quiet', type: 'button', text: 'Carry on from here', title: 'A new clip starts from this one’s last frame, with the same prompt to edit' });
  carry.addEventListener('click', () => busy(carry, async () => carryOn(clip, await lastFrameOf(app.clipUrl(clip.file)), chat, `${clip.prompt ?? 'clip'} last frame`)));
  const frame = el('button', { class: 'btn quiet', type: 'button', text: 'Use this frame', title: 'A new clip starts from the frame the player shows now (pause it where you want)' });
  frame.addEventListener('click', () => busy(frame, async () => {
    if (video.readyState < 2) throw new Error('Play the clip and pause it on the frame you want first.');
    video.pause();
    await carryOn(clip, await pngOf(video), chat, `${clip.prompt ?? 'clip'} frame`);
  }));
  return [carry, frame];
}

// ---- The Videos shelf ----

/** "25 Nov, 18:40". */
const clipWhen = at => new Date(at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const CLIP_PAGE = 24;
const clipPlural = (n, one = 'clip') => `${n} ${one}${n === 1 ? '' : 's'}`;

/** Every shelf drawn (the window's and the pictures pane's): after a delete or a new clip each one still shown is drawn again. */
const clipShelves = new Set();
app.redrawClipShelves = () => {
  for (const box of [...clipShelves]) {
    // A box that shows something else now (the pictures pane's gallery on another shelf) is left alone.
    if (!box.isConnected) clipShelves.delete(box);
    else if (box.clipShelf?.redraw && box.querySelector(':scope > .clip-tools')) void box.clipShelf.redraw();
  }
};

function clipTile(c, st) {
  const picked = st.picking && st.ids.has(c.id);
  const video = el('video', { src: app.clipUrl(c.file), preload: 'metadata', playsinline: '', loop: '', title: c.prompt });
  if (!st.picking) video.setAttribute('controls', '');
  video.style.aspectRatio = `${c.width} / ${c.height}`;
  const open = el('button', { class: 'btn quiet', type: 'button', text: 'Open', title: 'Open it large, with how it was made', onclick: () => app.openClip(c.id) });
  const del = el('button', { class: 'btn quiet', type: 'button', text: 'Delete', title: 'Delete this clip from this PC (asked first)' });
  const cap = el('div', { class: 'cap' }, el('span', { text: `${c.seconds} s · ${c.width}×${c.height}` }), el('span', { class: 'clip-acts' }, open, del));
  const tile = el('div', { class: `tile clip-tile${picked ? ' picked' : ''}`, 'data-id': c.id }, video, el('p', { class: 'hint clip-prompt', text: c.prompt, title: `${c.prompt}\n${clipWhen(c.at)} · ${c.model}` }), cap, st.picking ? null : app.clipActs(c, video, c.chat));
  del.addEventListener('click', () => {
    cap.replaceChildren(el('span', { text: 'Delete for good?' }),
      el('button', { class: 'btn danger', type: 'button', text: 'Delete', onclick: () => removeClips(st, [c.id]) }),
      el('button', { class: 'btn quiet', type: 'button', text: 'Keep', onclick: () => st.redraw() }));
  });
  if (st.picking) {
    // Edit: the whole clip ticks or unticks, and a box says whether it is ticked (a tick, not only a colour).
    tile.append(el('span', { class: 'pick-box', 'aria-hidden': 'true', text: picked ? '✓' : '' }),
      el('button', { class: 'clip-pick', type: 'button', title: 'Tick or untick this clip', 'aria-label': `Tick: ${c.prompt}`, 'aria-pressed': String(picked), onclick: () => {
        if (st.ids.has(c.id)) st.ids.delete(c.id);
        else st.ids.add(c.id);
        st.redraw(true);
      } }));
  }
  return tile;
}

/** Deletes clips from the shelf and this PC (the question was asked before), then every shelf is drawn again. */
async function removeClips(st, ids) {
  try {
    const r = await api('/api/clips/delete', { ids });
    for (const id of ids) st.ids.delete(id);
    st.said = `${clipPlural(r.deleted ?? ids.length)} deleted.`;
  } catch (error) {
    st.said = `Nothing was deleted: ${error.message}`;
  }
  st.asking = false;
  app.redrawClipShelves();
}

/** The row above the clips: This chat only, Edit (tick several to delete), and the question before a delete. */
function clipTools(st) {
  const only = el('input', { type: 'checkbox', checked: st.chatOnly });
  only.addEventListener('change', () => {
    st.chatOnly = only.checked;
    st.ids.clear();
    st.list = [];
    st.said = '';
    void st.redraw();
  });
  const row = el('div', { class: 'g-tools clip-tools span-all' }, el('label', { class: 'check', title: 'Only the clips made in the chat open now' }, only, el('span', { text: 'This chat only' })));
  if (!st.picking) {
    row.append(el('button', { class: 'btn', type: 'button', text: 'Edit', title: 'Pick clips to delete: tick several, then delete them', onclick: () => { st.picking = true; st.ids.clear(); st.said = ''; void st.redraw(true); } }));
  } else {
    const all = st.list.length > 0 && st.list.every(c => st.ids.has(c.id));
    const n = st.ids.size;
    row.append(el('span', { class: 'g-picked' },
      el('button', { class: 'btn quiet', type: 'button', text: all ? 'Untick all' : 'Tick all', onclick: () => {
        for (const c of st.list) if (all) st.ids.delete(c.id); else st.ids.add(c.id);
        st.redraw(true);
      } }),
      el('span', { class: 'g-picked-n', 'aria-live': 'polite', text: n ? `${n} ticked` : 'Tick the clips to delete' }),
      // Pressable with nothing ticked: it says why instead (a greyed button says nothing).
      el('button', { class: 'btn danger', type: 'button', text: n ? `Delete ${clipPlural(n)}` : 'Delete ticked', onclick: () => {
        if (!n) return void (st.said = 'Nothing is ticked yet: tick the clips to delete first.', st.redraw(true));
        st.asking = true;
        st.redraw(true);
      } }),
      el('button', { class: 'btn primary', type: 'button', text: 'Done', onclick: () => { st.picking = false; st.asking = false; st.ids.clear(); st.redraw(true); } })));
  }
  if (st.asking && st.ids.size) {
    const ids = [...st.ids];
    const del = el('button', { class: 'btn danger', type: 'button', text: 'Delete for good', onclick: () => { del.disabled = true; void removeClips(st, ids); } });
    row.append(el('div', { class: 'g-ask', role: 'alert' }, el('span', { text: ids.length === 1 ? 'Delete the ticked clip for good? The file is removed from this PC.' : `Delete the ${ids.length} ticked clips for good? The files are removed from this PC.` }), del,
      el('button', { class: 'btn quiet', type: 'button', text: 'Keep them', onclick: () => { st.asking = false; st.redraw(true); } })));
    queueMicrotask(() => del.focus());
  }
  return row;
}

/** Draws what is kept of a shelf's list again, without asking the server (ticking, Edit, Done). */
function drawClipBox(box, st) {
  const shown = st.list;
  const kids = [clipTools(st)];
  if (st.said) kids.push(el('p', { class: 'hint span-all g-done-line', text: st.said }));
  kids.push(...shown.map(c => clipTile(c, st)));
  if (!shown.length) kids.push(el('p', { class: 'hint span-all', text: st.q ? `No clips with "${st.q}" in the prompt.` : st.chatOnly ? 'No clips in this chat yet.' : 'No clips yet: a Videographer makes them in their chat.' }));
  if (st.total > shown.length) kids.push(el('button', { class: 'btn quiet g-more span-all', type: 'button', text: `See more (${st.total - shown.length} older)`, onclick: () => st.load(true) }));
  box.replaceChildren(...kids);
}

/**
 * Draws the Videos shelf into `box`: every clip, newest first, a page at a time, with a search on the prompts (`q`),
 * This chat only, and Edit to tick several and delete them. `low`: the line saying when under 2 GB is free.
 */
app.drawClipShelf = async (box, { q = '', low } = {}) => {
  const st = box.clipShelf ??= { chatOnly: false, picking: false, asking: false, ids: new Set(), list: [], total: 0, turn: 0, said: '', q: '' };
  if (st.q !== q) {
    st.said = '';
    st.list = [];
  }
  st.q = q;
  clipShelves.add(box);
  st.load = async (more = false) => {
    const turn = ++st.turn;
    // Drawn again: as many as were shown before (a delete or a new clip keeps the page where it was).
    const qs = new URLSearchParams({ limit: String(more ? CLIP_PAGE : Math.min(200, Math.max(CLIP_PAGE, st.list.length))), offset: String(more ? st.list.length : 0) });
    if (st.q) qs.set('q', st.q);
    if (st.chatOnly) qs.set('chat', app.chatId ?? '');
    try {
      const r = await api(`/api/clips/shelf?${qs}`);
      if (turn !== st.turn) return;
      const keep = more ? st.list : [];
      st.list = keep.concat(r.clips.filter(c => !keep.some(k => k.id === c.id)));
      st.total = r.total;
      for (const id of [...st.ids]) if (!st.list.some(c => c.id === id)) st.ids.delete(id);
      drawClipBox(box, st);
      if (low) {
        low.textContent = r.lowDisk ?? '';
        low.hidden = !r.lowDisk;
      }
    } catch (error) {
      box.replaceChildren(el('p', { class: 'hint', text: error.message }));
    }
  };
  st.redraw = (local = false) => {
    if (local) return drawClipBox(box, st);
    return st.load();
  };
  await st.load();
};

const clipsDlg = $('#clips-dlg');
let clipsSearchTimer = 0;
const drawClipsDlg = () => app.drawClipShelf($('#clips-list'), { q: $('#clips-search').value.trim(), low: $('#clips-dlg-lowdisk') });
$('#clip-shelf-open').addEventListener('click', () => {
  drawClipsDlg();
  clipsDlg.showModal();
});
$('#clips-search').addEventListener('input', () => {
  clearTimeout(clipsSearchTimer);
  clipsSearchTimer = setTimeout(drawClipsDlg, 300);
});
// A player left playing in a closed window stops.
clipsDlg.addEventListener('close', () => { for (const v of clipsDlg.querySelectorAll('video')) v.pause(); });

// ---- The clip viewer: the player large, how it was made, and what can be done with it ----

const clipViewer = $('#clip-viewer');
const clipViewerVideo = $('#clip-viewer-video');
clipViewer.addEventListener('close', () => clipViewerVideo.pause());
const clipFault = text => {
  const f = $('#clip-viewer-fault');
  f.textContent = text ?? '';
  f.hidden = !text;
};
const QUALITY_NAME = { draft: 'Draft', normal: 'Normal', best: 'Best' };
/** "a waves beach" as a file name: what Save a copy offers. */
const clipFileName = c => `${(c.prompt.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50).trim() || 'clip')}.${c.mime === 'video/mp4' ? 'mp4' : 'webm'}`;

/** A clip made again (same seed or new) in the chat it was made in: that chat opens and follows it. */
async function clipAgain(c, seed, button) {
  button.disabled = true;
  clipFault(null);
  try {
    const r = await api('/api/clips/again', { id: c.id, seed });
    clipViewer.close();
    if ((app.chatId ?? '') !== r.chat) return void (await app.openChat(r.chat));
    const chat = await api(`/api/chat?id=${encodeURIComponent(r.chat)}`).catch(() => null);
    if (chat) showChat(chat);
    void followClip(r.chat, r.job);
    app.redrawClipShelves();
  } catch (error) {
    button.disabled = false;
    clipFault(error.message);
  }
}

/** Use this prompt: its words, length, size, quality, leave-out and steps go into a Videographer's clip row (a new seed). */
async function useClipPrompt(c) {
  clipFault(null);
  if (!isClipChat()) {
    try {
      await app.openChat(c.chat);
    } catch {
      // The chat is gone: said below.
    }
    if (!isClipChat()) return clipFault("Open a Videographer's chat first: the chat this clip was made in is gone.");
  }
  clipViewer.close();
  await loadClipOptions();
  $('#chat-input').value = c.prompt;
  clipSeconds.value = String(c.seconds);
  const size = clipSizesHere().find(s => s.width === c.width && s.height === c.height);
  if (size) clipSize.value = size.id;
  const q = clipQuality.querySelector(`input[value="${CSS.escape(c.quality)}"]`);
  if (q) q.checked = true;
  clipNegative.value = c.negative ?? '';
  clipSteps.value = c.steps ? String(c.steps) : '';
  clipSeed.value = '';
  if (c.negative || c.steps) $('#clip-more').open = true;
  $('#chat-input').focus();
}

/** 3, "1 and 2", "1, 2 and 4". */
const joinedWords = ns => (ns.length < 2 ? ns.join('') : `${ns.slice(0, -1).join(', ')} and ${ns.at(-1)}`);

/** Opens one clip of the shelf in the viewer (from the chat or the Videos shelf). */
app.openClip = async id => {
  let c;
  let about;
  try {
    about = await api(`/api/clips/one?id=${encodeURIComponent(id)}`);
    c = about.clip;
  } catch (error) {
    return app.chatNote?.(error.message);
  }
  clipFault(null);
  clipViewerVideo.src = app.clipUrl(c.file);
  clipViewerVideo.style.aspectRatio = `${c.width} / ${c.height}`;
  clipViewerVideo.title = c.prompt;
  const meta = $('#clip-viewer-meta');
  meta.replaceChildren();
  const row = (k, v) => v != null && v !== '' && meta.append(el('dt', { text: k }), el('dd', { text: String(v) }));
  // A video joined from a shot list is made from its shots, not from one prompt: no seed, no Make again.
  const joined = Array.isArray(about.joined) ? about.joined : null;
  if (joined) row('Joined', joined.length ? `Shot${joined.length > 1 ? 's' : ''} ${joinedWords(joined)} of the shot list, in order` : 'Shots of the shot list, in order');
  else row('Prompt', c.prompt);
  row('Leave out', c.negative);
  row('Length', `${c.seconds} s`);
  row('Size', `${c.width}×${c.height}`);
  if (!joined) row('Quality', `${QUALITY_NAME[c.quality] ?? c.quality}${c.steps ? `, ${c.steps} steps` : ''}`);
  if (!joined) row('Seed', typeof c.seed === 'number' ? c.seed : 'not kept (made before seeds were kept)');
  row('Model', about.modelName || c.model);
  row('Made on', c.pc ?? 'this PC');
  row('Took', clipSecs(c.tookMs / 1000));
  row('File', `${c.mime === 'video/mp4' ? 'MP4' : 'WebM'}, ${c.bytes < 2 ** 20 ? `${Math.max(1, Math.round(c.bytes / 1024))} KB` : `${(c.bytes / 2 ** 20).toFixed(1)} MB`}`);
  row('Made', new Date(c.at).toLocaleString());
  // The picture it started from, small, with Open (none for a clip made from words only).
  const from = startedFrom(c);
  if (from) meta.append(el('dt', { text: 'Started from' }), el('dd', {}, from));
  const actions = $('#clip-viewer-actions');
  const noSeed = typeof c.seed !== 'number';
  const del = el('button', { class: 'btn quiet', type: 'button', text: 'Delete', title: 'Delete this clip for good (asked first)' });
  del.addEventListener('click', () => {
    const ask = el('div', { class: 'g-ask', role: 'alert' }, el('span', { text: 'Delete this clip for good? The file is removed from this PC.' }),
      el('button', { class: 'btn danger', type: 'button', text: 'Delete for good', onclick: async e => {
        e.target.disabled = true;
        try {
          await api('/api/clips/delete', { id: c.id });
        } catch (error) {
          e.target.disabled = false;
          return clipFault(`Nothing was deleted: ${error.message}`);
        }
        clipViewer.close();
        app.redrawClipShelves();
      } }),
      el('button', { class: 'btn quiet', type: 'button', text: 'Keep', onclick: () => ask.remove() }));
    actions.after(ask);
    ask.querySelector('.btn.danger').focus();
  });
  actions.replaceChildren(...[
    joined ? null : el('button', { class: 'btn primary', type: 'button', text: 'Make again, same seed', disabled: noSeed, title: noSeed ? 'The seed of this clip is not known: it was made before seeds were kept' : 'The same words, length, size, quality and seed, in the chat it was made in', onclick: e => clipAgain(c, 'same', e.target) }),
    joined ? null : el('button', { class: 'btn', type: 'button', text: 'Make again, new seed', title: 'The same words, length, size and quality, a different clip', onclick: e => clipAgain(c, 'new', e.target) }),
    joined ? null : el('button', { class: 'btn', type: 'button', text: 'Use this prompt', title: "Its words and settings go into a Videographer's clip row, with a new seed", onclick: () => useClipPrompt(c) }),
    joined ? null : el('button', { class: 'btn', type: 'button', text: 'Copy prompt', onclick: async e => { try { await navigator.clipboard.writeText(c.prompt); e.target.textContent = 'Copied'; } catch { e.target.textContent = 'Not copied: this browser refused'; } } }),
    ...carryButtons(c, clipViewerVideo, c.chat, text => clipFault(text || null)).map(b => (b.classList.remove('quiet'), b)),
    el('a', { class: 'btn', href: app.clipUrl(c.file), download: clipFileName(c), text: 'Save a copy', title: 'Download the clip file' }),
    del,
  ].filter(Boolean));
  actions.parentElement.querySelector('.g-ask')?.remove();
  if (!clipViewer.open) clipViewer.showModal();
};

app.clipsFollow();
