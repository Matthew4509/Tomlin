// The pictures pane, which is an artist's chat: what to draw (drawn just as typed), progress, results, the picture
// viewer, the gallery, enhance and alt text (both use the chat model, only when asked) and the Models button. Uses
// app.js's helpers ($, el, api, app).
'use strict';

const form = $('#img-form');
const promptBox = $('#img-prompt');
const goBtn = $('#img-go');
const cancelBtn = $('#img-cancel');
const progress = $('#img-progress');
const jobChip = $('#job-chip');
// The chip in the top bar opens the chat the picture is being drawn for.
jobChip.addEventListener('click', async () => {
  const j = app.status?.panes.image.job;
  if (j?.chat && j.chat !== app.chatId) await app.openChat?.(j.chat);
  else app.showPanes?.();
  progress.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
});
const fault = $('#img-fault');
const results = $('#img-results');
const enhanceBtn = $('#img-enhance');
const detectLine = $('#img-detect');
const fileUrl = rel => `/api/images/file/${rel.split('/').map(encodeURIComponent).join('/')}`;
const MODE_NAME = { icon: 'Icon', blog: 'Blog / photo', cartoon: 'Cartoon', custom: 'Custom' };

function secondsText(s) {
  if (s == null) return '';
  if (s < 60) return `${Math.max(1, Math.round(s))} s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return `${m} min${r ? ` ${r} s` : ''}`;
}

// ---- What the prompt will do (shown as you type) ----

let planTimer = null;
/** A line under the Draw box from elsewhere (a job's picture step): what to draw and what to do after. */
app.imageNote = text => {
  $('#img-note').textContent = text ?? '';
  $('#img-note').hidden = !text;
};

function updatePlan() {
  clearTimeout(planTimer);
  planTimer = setTimeout(async () => {
    const q = new URLSearchParams({ prompt: promptBox.value, width: $('#img-w').value, height: $('#img-h').value, model: panes.image.model.value, mode: $('#img-mode').value });
    try {
      const p = await api(`/api/images/plan?${q}`);
      if (!promptBox.value.trim()) return void (detectLine.textContent = '');
      const chosen = $('#img-mode').value;
      const mode = chosen === 'auto' ? `${MODE_NAME[p.mode]} (${p.why})` : MODE_NAME[chosen];
      const size = p.target ? `${p.target.width}×${p.target.height}, drawn at ${p.generated.width}×${p.generated.height}` : `${p.generated.width}×${p.generated.height}`;
      detectLine.textContent = `${mode} · ${size}${p.portrait && !p.size ? ' · square portrait' : ''}${p.size ? ' · size taken out of the prompt' : ''}`;
      // The model in use is not made for this mode: say which one is (choose it, or download it, in the list above).
      if (p.better) detectLine.append(el('span', { class: 'better', text: ` · ${MODE_NAME[p.mode]} looks best with ${p.better.name}${p.better.installed ? ': choose it in the model list and press Connect' : ': download it from the model list'}` }));
    } catch {
      detectLine.textContent = '';
    }
  }, 250);
}
for (const id of ['#img-prompt', '#img-w', '#img-h', '#img-mode']) $(id).addEventListener('input', updatePlan);
panes.image.model.addEventListener('change', updatePlan);

// ---- Generate / cancel ----

function options() {
  const num = id => ($(id).value === '' ? undefined : Number($(id).value));
  const random = $('#img-random').checked;
  return {
    prompt: promptBox.value, negative: $('#img-negative').value, mode: $('#img-mode').value, width: num('#img-w'), height: num('#img-h'), fit: $('#img-fit').value,
    seed: random ? undefined : num('#img-seed'), steps: num('#img-steps'), cfg: num('#img-cfg'), sampler: $('#img-sampler').value || undefined,
    drafts: num('#img-drafts'), ico: $('#img-ico').checked, as: $('#draw-as').value || undefined,
  };
}

async function start(path, body) {
  showFault(fault, null);
  try {
    await api(path, body);
    shownJob = null;
    await poll();
  } catch (error) {
    // This PC is a node and a linked PC is drawing on it (or has a picture model loaded here): asked first.
    if (error.data?.impact && !body.agree) {
      if (await app.agreeImpact(error.data.impact)) return start(path, { ...body, agree: true });
      return;
    }
    showFault(fault, error.message);
    // The artist's PC is busy drawing: "busy: add to the queue", with the prompt as typed (queue.js).
    if (error.data?.queue) fault.append(' ', el('button', { class: 'btn', type: 'button', text: 'Add to the queue', onclick: () => { showFault(fault, null); $('#img-queue').click(); } }));
  }
}

form.addEventListener('submit', async e => {
  e.preventDefault();
  if (!promptBox.value.trim()) return showFault(fault, 'Type what to draw first: what should the picture show?');
  if (app.status?.panes.image.state !== 'connected' && !app.awayArtist) return showFault(fault, 'The picture model is not loaded yet: press Connect beside it (above), then press Draw again. Nothing loads by itself.');
  // The chat on screen gets the picture ('' = none), named: not whichever chat another window opened last.
  const chat = app.chatId ?? '';
  await start('/api/images/generate', { ...options(), chat });
  // The first thing asked names a new chat, and the chat moves to the top of the list.
  app.afterSend?.(chat);
});
// Like a chat's message box: Enter draws it, Shift+Enter starts a new line.
promptBox.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    form.requestSubmit();
  }
});
cancelBtn.addEventListener('click', () => api('/api/images/cancel', {}).catch(error => showFault(fault, error.message)));
$('#img-random').addEventListener('change', () => {
  $('#img-seed').disabled = $('#img-random').checked;
});
$('#img-seed').disabled = true;

// ---- Progress and results ----

const RUNNING = ['queued', 'starting', 'drawing', 'decoding', 'finishing'];
let shownJob = null;
let galleryDirty = true;

function stateText(j) {
  const pic = j.count > 1 ? `picture ${Math.max(1, j.image)} of ${j.count}` : 'the picture';
  const eta = j.etaSeconds != null ? ` · about ${secondsText(j.etaSeconds)} left` : '';
  switch (j.state) {
    case 'queued': return `Waiting for the picture before it${j.queued ? ` (${j.queued} waiting)` : ''}`;
    case 'starting': return j.note ?? 'Starting';
    case 'drawing': return `Drawing ${pic} · step ${j.step} of ${j.steps}${j.perStep ? ` (${j.perStep.toFixed(1)} s a step)` : ''}${eta}`;
    case 'decoding': return `Turning ${j.count > 1 ? 'the drafts' : 'it'} into pixels${eta}`;
    case 'finishing': return MODE_NAME[j.mode] === 'Icon' ? 'Cutting out the background and centring' : 'Resizing and saving';
    default: return '';
  }
}

function drawJob(j) {
  const running = j && RUNNING.includes(j.state);
  // Draw stays pressable: pressed before Connect, it says what to do instead of doing nothing.
  goBtn.title = app.status?.panes.image.state !== 'connected' && !app.awayArtist ? 'Connect the picture model first (nothing loads by itself)' : 'Enter in the box does the same';
  cancelBtn.hidden = !running;
  const wasHidden = progress.hidden;
  progress.hidden = !running;
  jobChip.hidden = !running;
  if (running) {
    const total = j.count * j.steps;
    const done = (Math.max(1, j.image) - 1) * j.steps + j.step;
    const frac = j.state === 'decoding' || j.state === 'finishing' ? 0.95 : j.state === 'drawing' ? Math.min(0.9, (done / Math.max(1, total)) * 0.9) : 0.02;
    const pct = Math.round(frac * 100);
    $('.p-fill', progress).style.width = `${pct}%`;
    $('.p-track', progress).setAttribute('aria-valuenow', String(pct));
    $('.ip-pct', progress).textContent = `${pct}%`;
    $('.p-text', progress).textContent = `${stateText(j)} · ${secondsText(j.elapsed)} so far`;
    $('.ip-prompt', progress).textContent = j.prompt ?? '';
    // The frame takes the picture's shape (kept between tall and wide so it stays readable).
    const shape = j.target?.width && j.target?.height ? Math.min(2, Math.max(0.6, j.target.width / j.target.height)) : 1;
    $('.ip-frame', progress).style.setProperty('--ar', String(shape));
    jobChip.textContent = `Picture ${pct}%${j.etaSeconds != null ? ` · ${j.etaSeconds >= 90 ? `${Math.round(j.etaSeconds / 60)} min` : `${Math.max(1, Math.round(j.etaSeconds))} s`} left` : ''}`;
    jobChip.title = `${stateText(j)} · ${secondsText(j.elapsed)} so far. Click to see it.`;
    if (wasHidden) progress.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  if (!j) return;
  if (j.state === 'failed' && shownJob !== `${j.id}:failed`) {
    shownJob = `${j.id}:failed`;
    showFault(fault, j.error);
  }
  if (j.state === 'cancelled' && shownJob !== `${j.id}:cancelled`) {
    shownJob = `${j.id}:cancelled`;
    results.replaceChildren(el('p', { class: 'hint', text: j.note ?? 'Cancelled.' }));
  }
  if (j.state === 'done' && shownJob !== `${j.id}:done`) {
    shownJob = `${j.id}:done`;
    // One drawn for another chat waits in that chat.
    if (!j.forPc && (scope === 'all' || (j.chat ?? '') === (app.chatId ?? ''))) drawResults(j);
    galleryDirty = true;
    drawGallery();
    // Each chat's picture count (the Chats tab) takes the new picture in.
    app.loadChats?.();
  }
}

function tile(p, extra) {
  const picked = picking.on && picking.ids.has(p.id);
  const t = el('div', { class: `tile${mainPic?.id === p.id ? ' current' : ''}${picked ? ' picked' : ''}`, 'data-id': p.id },
    el('button', { class: 'open', type: 'button', title: picking.on ? 'Tick or untick this picture' : 'Show this picture above', 'aria-pressed': picking.on ? String(picked) : null, onclick: () => (picking.on ? togglePick(p, t) : showMain(p)) }, el('img', { src: fileUrl(p.output), alt: p.altText ?? p.prompt, loading: 'lazy' })),
    el('div', { class: 'cap' }, el('span', { text: `${p.target.width}×${p.target.height}${p.format === 'webp' ? ' WebP' : ''}` }), el('span', { text: `seed ${p.seed}` })));
  // Edit: a box on each picture says whether it is ticked (a tick, not only a colour), and an × deletes that one.
  if (picking.on) {
    t.append(el('span', { class: 'pick-box', 'aria-hidden': 'true', text: picked ? '✓' : '' }));
    t.append(el('button', { class: 'pick-x', type: 'button', title: 'Delete this picture', 'aria-label': 'Delete this picture', text: '×', onclick: () => askTile(p, t) }));
  }
  if (p.kept === false) t.append(el('span', { class: 'badge', text: 'Draft' }));
  else if (p.finalOf) t.append(el('span', { class: 'badge', text: 'Final' }));
  if (extra) t.append(extra);
  return t;
}

function drawResults(j) {
  results.replaceChildren();
  if (j.results[0]) showMain(j.results[0]);
  const blogDrafts = j.results.length > 1 && j.results.every(p => p.draft);
  if (j.results.length > 1) {
    results.append(el('p', { class: 'hint span-all', text: blogDrafts ? 'Pick one and press Full quality to redraw it with more steps. Drafts wait until you add one to the gallery.' : 'New pictures: they wait in Drafts until you add them to the gallery.' }));
    for (const p of j.results) {
      const actions = p.draft ? el('div', { class: 'cap' }, el('button', { class: 'btn primary', type: 'button', text: 'Full quality', onclick: () => start('/api/images/finalise', { id: p.id }) })) : null;
      results.append(tile(p, actions));
    }
  }
  if (j.note && !blogDrafts) results.append(el('p', { class: 'hint span-all', text: j.note }));
}

// ---- The main photo ----

let mainPic = null;
const mpImg = $('#mp-img');

/** Add to the gallery, or take back out to Drafts. */
async function setKept(p, kept) {
  const np = await api('/api/images/keep', { id: p.id, kept });
  if (mainPic?.id === np.id) mainPic = np;
  galleryDirty = true;
  await drawGallery();
  if (mainPic?.id === np.id) showMain(np);
  return np;
}

function showMain(p) {
  mainPic = p;
  const has = !!p;
  mpImg.hidden = !has;
  $('#mp-empty').hidden = has;
  for (const id of ['#mp-prev', '#mp-next', '#mp-expand']) $(id).hidden = !has;
  $('#mp-badge').hidden = !has || p.kept !== false;
  for (const t of document.querySelectorAll('#gallery .tile')) t.classList.toggle('current', has && t.dataset.id === p.id);
  const actions = $('#mp-actions');
  actions.replaceChildren();
  if (!has) {
    $('#mp-caption').textContent = '';
    mpImg.removeAttribute('src');
    return;
  }
  mpImg.src = fileUrl(p.output);
  mpImg.alt = p.altText ?? p.prompt;
  $('#mp-caption').textContent = `${p.prompt} · ${new Date(p.at).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}`;
  const kept = p.kept !== false;
  actions.append(
    el('button', { class: `btn${kept ? '' : ' primary'}`, type: 'button', text: kept ? 'Move to drafts' : 'Add to gallery', title: kept ? 'Take it out of the gallery; it waits in Drafts' : 'Keep it: it goes into the gallery', onclick: async e => { e.target.disabled = true; try { await setKept(p, !kept); } catch (error) { showFault(fault, error.message); e.target.disabled = false; } } }),
    el('button', { class: 'btn', type: 'button', text: 'Set as profile photo', title: 'Choose whose photo it becomes', onclick: e => app.pickFace(p, e.target) }),
    el('button', { class: 'btn', type: 'button', text: p.draft ? 'Full quality' : 'Draw again, full quality', title: 'Same seed, more steps and the full-quality decoder; the new one waits in Drafts', onclick: () => start('/api/images/finalise', { id: p.id }) }),
    el('a', { class: 'btn quiet', href: `${fileUrl(p.output)}?download`, text: 'Download' }),
    el('button', { class: 'btn quiet', type: 'button', text: 'Delete', title: 'Delete this picture for good (asked first)', onclick: () => deletePictures({ ids: [p.id] }, 'this picture') }),
  );
}

/** The picture before or after the main one, in the gallery list as it is shown. */
function stepMain(by) {
  const list = galleryList;
  if (!list.length) return;
  const i = list.findIndex(x => x.id === mainPic?.id);
  const next = i < 0 ? list[0] : list[(i + by + list.length) % list.length];
  showMain(next);
  document.querySelector(`#gallery .tile[data-id="${CSS.escape(next.id)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
$('#mp-prev').addEventListener('click', () => stepMain(-1));
$('#mp-next').addEventListener('click', () => stepMain(1));
$('#mp-expand').addEventListener('click', () => mainPic && openViewer(mainPic));
mpImg.addEventListener('click', () => mainPic && openViewer(mainPic));
$('#mp-frame').addEventListener('keydown', e => {
  if (e.key === 'ArrowLeft') { e.preventDefault(); stepMain(-1); }
  if (e.key === 'ArrowRight') { e.preventDefault(); stepMain(1); }
  if (e.key === 'Enter' && mainPic) openViewer(mainPic);
});

// ---- Viewer ----

const viewer = $('#viewer');
function openViewer(p) {
  $('#viewer-img').src = fileUrl(p.output);
  $('#viewer-img').alt = p.altText ?? p.prompt;
  const meta = $('#viewer-meta');
  meta.replaceChildren();
  const row = (k, v) => v != null && v !== '' && meta.append(el('dt', { text: k }), el('dd', { text: String(v) }));
  row('Prompt', p.prompt);
  row('Model was given', p.modelPrompt);
  row('Mode', MODE_NAME[p.mode]);
  row('Size', `${p.target.width}×${p.target.height} (drawn at ${p.generated.width}×${p.generated.height}, ${p.fit})`);
  row('Seed', p.seed);
  row('Steps / CFG / sampler', `${p.steps} / ${p.cfg} / ${p.sampler}`);
  row('Model', p.modelName);
  row('Ran on', `${p.device}, ${p.seconds} s`);
  row('File', `${p.format.toUpperCase()}, ${Math.round(p.bytes / 1024)} KB${p.transparent ? ', see-through background' : ''}`);
  row('Alt text', p.altText ? `${p.altText} (written from ${p.altFrom ?? 'the prompt'})` : null);
  row('Made', new Date(p.at).toLocaleString());
  const actions = $('#viewer-actions');
  actions.replaceChildren(
    el('a', { class: 'btn primary', href: `${fileUrl(p.output)}?download`, text: 'Download' }),
    el('a', { class: 'btn', href: `${fileUrl(p.original)}?download`, text: 'Download original' }),
    el('button', { class: 'btn', type: 'button', text: 'Draw again, same seed', onclick: () => { viewer.close(); start('/api/images/again', { id: p.id }); } }),
    el('button', { class: 'btn', type: 'button', text: p.draft ? 'Full quality' : 'Re-run at full quality', onclick: () => { viewer.close(); start('/api/images/finalise', { id: p.id }); } }),
    el('button', { class: 'btn', type: 'button', text: 'Copy prompt', onclick: async e => { try { await navigator.clipboard.writeText(p.prompt); e.target.textContent = 'Copied'; } catch { promptBox.value = p.prompt; e.target.textContent = 'Put in the prompt box'; } } }),
    el('button', { class: 'btn', type: 'button', text: 'Use this prompt', onclick: () => { promptBox.value = p.prompt; viewer.close(); updatePlan(); promptBox.focus(); } }),
    el('button', { class: 'btn', type: 'button', text: 'Set as profile photo', title: 'Choose whose photo it becomes', onclick: e => { viewer.close(); app.pickFace(p, e.target); } }),
    el('button', { class: 'btn', type: 'button', text: p.kept === false ? 'Add to gallery' : 'Move to drafts', onclick: async () => { try { openViewer(await setKept(p, p.kept === false)); } catch (error) { showFault(fault, error.message); } } }),
  );
  const chatOn = app.status?.panes.chat.state === 'connected';
  const alt = el('button', { class: 'btn', type: 'button', text: p.altText ? 'Write alt text again' : 'Write alt text', title: 'The chat model writes it from the prompt', onclick: async e => {
    // Pressable with no chat model: the press says what to do (a greyed button says nothing).
    if (!chatOn) {
      e.target.textContent = "Needs a chat model: press Connect at the top of a chat first";
      return;
    }
    e.target.disabled = true;
    e.target.textContent = 'Writing…';
    try {
      const np = await api('/api/images/alt', { id: p.id });
      openViewer(np);
    } catch (error) {
      e.target.textContent = error.message;
    }
  } });
  actions.append(alt);
  for (const f of p.icoFiles ?? []) actions.append(el('a', { class: 'btn quiet', href: `${fileUrl(f)}?download`, text: f.split('/').pop() }));
  if (!viewer.open) viewer.showModal();
}

// ---- Gallery ----

/** Today, Yesterday, Last 7 days or Older, by this PC's calendar day. */
function dayGroup(at) {
  const day = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(new Date()) - day(new Date(at))) / 86_400_000);
  return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : days < 7 ? 'Last 7 days' : 'Older';
}

// An artist's chat opens on All: every picture they drew in it, drafts too (a new picture waits in Drafts until it is added
// to the gallery, and a Gallery-only view looked empty right after drawing).
let shelf = (() => { try { return localStorage.getItem('app-shelf2') || 'all'; } catch { return 'all'; } })();
/** 'chat': only the pictures of the chat open now (each chat keeps its own); 'all': every picture. */
// Always opens on This chat: a chat shows only its own pictures until All chats is pressed: a new chat starts clean.
let scope = 'chat';
let galleryList = [];
let galleryTotal = 0;
let lastGroup = null;
const PAGE = 60;

function appendTiles(pictures) {
  const box = $('#gallery');
  for (const p of pictures) {
    const group = dayGroup(p.at);
    if (group !== lastGroup) box.append(el('h4', { class: 'g-day', text: group }));
    lastGroup = group;
    box.append(tile(p));
  }
}

// ---- Deleting pictures: Edit puts a box on each picture (tick several, then Delete selected) and an × on each (delete
// that one). Every delete asks on the page first, in words, because the files are removed from this PC for good. ----

const picking = { on: false, ids: new Set() };
function togglePick(p, t) {
  if (picking.ids.has(p.id)) picking.ids.delete(p.id);
  else picking.ids.add(p.id);
  t.classList.toggle('picked', picking.ids.has(p.id));
  t.querySelector('.open')?.setAttribute('aria-pressed', String(picking.ids.has(p.id)));
  const box = t.querySelector('.pick-box');
  if (box) box.textContent = picking.ids.has(p.id) ? '✓' : '';
  drawTools();
}
function drawTools() {
  const inChat = scope === 'chat' && !!app.chatId;
  $('#g-edit').hidden = picking.on;
  $('#g-picked').hidden = !picking.on;
  $('#g-clear-recent').hidden = !inChat;
  $('#g-clear-all').hidden = !inChat;
  $('#g-picked-n').textContent = picking.ids.size ? `${picking.ids.size} ticked` : 'Tick the pictures to delete, or press × on one';
  $('#g-del').disabled = !picking.ids.size;
  $('#g-del').textContent = picking.ids.size ? `Delete ${picking.ids.size} picture${picking.ids.size === 1 ? '' : 's'}` : 'Delete ticked';
  const shown = [...document.querySelectorAll('#gallery .tile')].map(x => x.dataset.id);
  $('#g-all').textContent = shown.length && shown.every(id => picking.ids.has(id)) ? 'Untick all' : 'Tick all';
  $('#gallery-box').classList.toggle('editing', picking.on);
}
function setPicking(on) {
  picking.on = on;
  picking.ids.clear();
  askStrip(null);
  drawTools();
  drawGallery();
}

/** The question above the gallery before a delete: what goes, in words, with Delete and Keep them. */
function askStrip(text, go) {
  const box = $('#g-ask');
  if (!text) return void (box.hidden = true, box.replaceChildren());
  const del = el('button', { class: 'btn danger', type: 'button', text: 'Delete for good' });
  del.addEventListener('click', async () => {
    del.disabled = true;
    await go();
  });
  box.replaceChildren(el('span', { text }), del, el('button', { class: 'btn quiet', type: 'button', text: 'Keep them', onclick: () => askStrip(null) }));
  box.hidden = false;
  del.focus();
}

/** The × on one picture: the picture itself asks "Delete this picture?" until Delete or Keep is pressed. */
function askTile(p, t) {
  t.querySelector('.tile-ask')?.remove();
  const ask = el('div', { class: 'tile-ask', role: 'alert' },
    el('span', { text: 'Delete this picture for good?' }),
    el('button', { class: 'btn danger', type: 'button', text: 'Delete', onclick: () => removePictures({ ids: [p.id] }) }),
    el('button', { class: 'btn quiet', type: 'button', text: 'Keep', onclick: () => ask.remove() }));
  t.append(ask);
  ask.querySelector('.btn.danger').focus();
}

async function removePictures(body) {
  try {
    const r = await api('/api/images/delete', body);
    if (mainPic && (body.ids?.includes(mainPic.id) || body.chat)) showMain(null);
    // The latest-results strip above the gallery drops the deleted pictures too.
    const gone = new Set(r.ids ?? body.ids ?? []);
    for (const t of results.querySelectorAll('.tile')) if (gone.has(t.dataset.id)) t.remove();
    if (!results.querySelector('.tile')) results.replaceChildren();
    for (const id of gone) picking.ids.delete(id);
    askStrip(null);
    await drawGallery();
    app.loadChats?.();
    $('#gallery').prepend(el('p', { class: 'hint g-done-line', text: `${r.deleted} picture${r.deleted === 1 ? '' : 's'} deleted.` }));
  } catch (e) {
    askStrip(null);
    showFault(fault, `Nothing was deleted: ${e.message}`);
  }
}
const deletePictures = (body, what) => askStrip(`Delete ${what} for good? The files are removed from this PC.`, () => removePictures(body));
$('#g-edit').addEventListener('click', () => setPicking(true));
$('#g-done').addEventListener('click', () => setPicking(false));
$('#g-all').addEventListener('click', () => {
  const tiles = [...document.querySelectorAll('#gallery .tile')];
  const all = tiles.length && tiles.every(x => picking.ids.has(x.dataset.id));
  for (const x of tiles) {
    if (all) picking.ids.delete(x.dataset.id);
    else picking.ids.add(x.dataset.id);
    x.classList.toggle('picked', !all);
    x.querySelector('.open')?.setAttribute('aria-pressed', String(!all));
    const box = x.querySelector('.pick-box');
    if (box) box.textContent = all ? '' : '✓';
  }
  drawTools();
});
$('#g-del').addEventListener('click', () => deletePictures({ ids: [...picking.ids] }, `the ${picking.ids.size} ticked picture${picking.ids.size === 1 ? '' : 's'}`));
$('#g-clear-recent').addEventListener('click', () => deletePictures({ chat: app.chatId, which: 'recent' }, "every picture this chat drew today"));
$('#g-clear-all').addEventListener('click', () => deletePictures({ chat: app.chatId, which: 'all' }, 'every picture in this chat'));

// Each draw is numbered: an answer that comes back after a newer draw started (another chat opened meanwhile) is dropped.
let galleryTurn = 0;
async function drawGallery(more = false) {
  const turn = ++galleryTurn;
  const box = $('#gallery');
  const q = $('#g-search').value.trim();
  // Only the gallery's own shelves: the Models page and the chat box (Quick or Think) use the same look.
  for (const b of document.querySelectorAll('.g-shelf[data-shelf]')) b.setAttribute('aria-pressed', String(b.dataset.shelf === shelf));
  for (const b of document.querySelectorAll('.g-scope')) b.setAttribute('aria-pressed', String(b.dataset.scope === scope));
  drawTools();
  const inChat = scope === 'chat' ? `&chat=${encodeURIComponent(app.chatId ?? '')}` : '';
  try {
    const g = await api(`/api/images/gallery?shelf=${shelf}&offset=${more ? galleryList.length : 0}&limit=${PAGE}${q ? `&q=${encodeURIComponent(q)}` : ''}${inChat}`);
    if (turn !== galleryTurn) return;
    if (!more) {
      box.replaceChildren();
      galleryList = [];
      lastGroup = null;
    }
    galleryList = galleryList.concat(g.pictures);
    galleryTotal = g.total;
    $('#g-drafts').textContent = g.drafts ? String(g.drafts) : '';
    appendTiles(g.pictures);
    drawTools();
    if (!galleryList.length) {
      const none = scope === 'chat' ? (app.chatId ? 'No pictures in this chat yet.' : 'No pictures outside a chat.') : 'No pictures yet.';
      box.append(el('p', { class: 'hint', text: q ? `No pictures with "${q}" in the prompt.` : shelf === 'gallery' ? (g.drafts ? 'Nothing in the gallery yet: new pictures wait in Drafts until you add them.' : none) : shelf === 'drafts' ? 'No drafts.' : none }));
    }
    $('#g-more').hidden = galleryList.length >= galleryTotal;
    $('#g-more').textContent = `See more (${galleryTotal - galleryList.length} older)`;
    galleryDirty = false;
    if (!mainPic && !more && galleryList[0]) showMain(galleryList[0]);
  } catch (error) {
    box.replaceChildren(el('p', { class: 'hint', text: error.message }));
  }
}
for (const b of document.querySelectorAll('.g-shelf[data-shelf]')) {
  b.addEventListener('click', () => {
    shelf = b.dataset.shelf;
    try { localStorage.setItem('app-shelf2', shelf); } catch { /* not kept */ }
    drawGallery();
  });
}
for (const b of document.querySelectorAll('.g-scope')) {
  b.addEventListener('click', () => {
    scope = b.dataset.scope === 'all' ? 'all' : 'chat';
    showMain(null);
    drawGallery();
  });
}
/** Another chat opened (chats.js): the pane shows that chat's pictures, and nothing drawn for the one before. */
app.chatChanged = () => {
  app.imageNote(null);
  results.replaceChildren();
  scope = 'chat';
  showMain(null);
  galleryDirty = true;
  drawGallery();
};
let searchTimer = null;
$('#g-search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => drawGallery(), 300);
});
$('#g-more').addEventListener('click', () => drawGallery(true));
drawGallery();

// More options stays as it was left.
const moreBox = $('#more-options');
try { if (localStorage.getItem('app-more-options') === '1') moreBox.open = true; } catch { /* not kept */ }
moreBox.addEventListener('toggle', () => { try { localStorage.setItem('app-more-options', moreBox.open ? '1' : '0'); } catch { /* not kept */ } });

// Old drafts: the person's choice (gear), kept on the server.
const draftDays = $('#draft-days');
api('/api/models').then(m => { draftDays.value = draftDays.dataset.was = String(m.settings?.draftDays ?? 0); }).catch(() => undefined);
draftDays.addEventListener('change', async () => {
  const days = Number(draftDays.value);
  // Asked on the page; "Keep them" puts the choice back as it was (nothing was saved yet).
  if (days > 0 && !(await askHere($('#draft-days-ask'), `Drafts older than ${days} days will be deleted for good, now and every hour from now on. Pictures in the gallery are never touched.`, `Delete drafts after ${days} days`, 'Keep them'))) {
    draftDays.value = draftDays.dataset.was ?? '0';
    return;
  }
  try {
    await api('/api/settings', { pane: 'image', draftDays: days });
    draftDays.dataset.was = String(days);
    app.gearSaved?.('image', false);
    drawGallery();
  } catch (error) {
    showFault(fault, error.message);
  }
});

// ---- Chat help ----

function drawChatHelp(s) {
  const chatOn = s.panes.chat.state === 'connected';
  enhanceBtn.dataset.off = chatOn ? '' : '1';
  enhanceBtn.title = 'The chat model turns a short prompt into a detailed one';
}
enhanceBtn.addEventListener('click', async () => {
  if (enhanceBtn.dataset.off) return showFault(fault, "Enhance prompt asks a chat model to write a longer prompt, and no chat model is connected (nothing loads by itself). Open the host's chat, press Connect there, then come back. Without it, your words are drawn as typed.");
  if (!promptBox.value.trim()) return showFault(fault, 'Type a short prompt first; the chat model makes it longer.');
  enhanceBtn.disabled = true;
  const was = enhanceBtn.textContent;
  enhanceBtn.textContent = 'Enhancing…';
  try {
    const { size } = await api(`/api/images/plan?${new URLSearchParams({ prompt: promptBox.value })}`);
    const r = await api('/api/images/enhance', { prompt: promptBox.value });
    // A size typed in the prompt is kept (the chat model is told to leave sizes out).
    promptBox.value = size ? `${r.prompt} ${size.width}x${size.height}` : r.prompt;
    updatePlan();
  } catch (error) {
    showFault(fault, error.message);
  } finally {
    enhanceBtn.textContent = was;
    enhanceBtn.disabled = false;
  }
});

app.onStatus.push(s => {
  drawJob(s.panes.image.job);
  drawChatHelp(s);
});

// ---- Models (download, licence, fit) ----

// The Models page (public/models.js) opens from Settings' Set up menu (Add a model), not the top bar.

// ---- "Draw as": the picture specialist (a hire with a picture role) whose way of working shapes each picture ----

const drawAs = $('#draw-as');
/** A chat deleted (with or without its pictures): the gallery is drawn again. */
app.redrawGallery = () => {
  galleryDirty = true;
  return drawGallery();
};

// Every picture hire on this PC: the pane draws as the one chosen, here or on the linked PC their first choice names.
app.drawAs = async () => {
  const d = await api('/api/staff').catch(() => null);
  const m = await api('/api/models').catch(() => null);
  if (!d || !m) return;
  const people = d.staff.filter(s => s.kind === 'image');
  $('#draw-as-row').hidden = !people.length;
  drawAs.replaceChildren(el('option', { value: '', text: "No artist: this PC's picture model" }),
    ...people.map(p => el('option', { value: p.id, text: `${p.name} · ${d.roles.find(r => r.id === p.role)?.name ?? 'Artist'} · ${String(p.model ?? '').startsWith('remote:') ? 'draws on a linked PC' : 'this PC'}` })));
  drawAs.value = people.some(p => p.id === m.settings.imageAs) ? m.settings.imageAs : '';
  await drawNodeArtist(d);
};
drawAs.addEventListener('change', async () => {
  await api('/api/settings', { imageAs: drawAs.value }).catch(() => undefined);
  drawNodeArtist();
});
app.drawAs();

// ---- An artist whose first choice is on a linked PC draws there: the pane names that PC's model, not this PC's ----
async function drawNodeArtist(staffData) {
  const box = $('#node-artist');
  const row = document.querySelector('#pane-image .connect-row');
  const d = staffData ?? (await api('/api/staff').catch(() => null));
  const local = d?.staff?.find(s => s.id === drawAs.value && s.kind === 'image' && String(s.model ?? '').startsWith('remote:')) ?? null;
  app.awayArtist = !!local;
  // This PC's own Connected/Disconnected says nothing about an artist on another PC.
  panes.image.root.classList.toggle('away', app.awayArtist);
  box.hidden = !local;
  row.hidden = !!local;
  if (!local) return;
  // One of a linked PC's shared picture models ("DreamShaper 8 on "Worker PC" (loads there when asked)"), or what it has loaded.
  const choice = d.hireChoices?.image?.find(c => c.id === local.model);
  $('#node-artist-label').textContent = `${local.name} draws on a linked PC`;
  $('#node-artist-model').replaceChildren(el('option', { text: choice?.name ?? 'the picture model loaded there' }));
  $('#node-artist-model').disabled = true;
  $('#node-artist-line').textContent = `Pictures are drawn on the PC chosen as ${local.name}'s first choice in Staff, and come back here.${/:[^:]+:/.test(local.model) ? ' The model loads there when asked; while it draws for someone else, yours waits.' : " If it has no picture model loaded, this PC's is used."}`;
}
app.onModels = () => { drawNodeArtist(); };
