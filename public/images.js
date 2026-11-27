// The pictures pane, which is an artist's chat: what to draw (drawn just as typed), progress, results, the picture
// viewer, the gallery, enhance and alt text (both use the chat model, only when asked) and the Models button. Uses
// app.js's helpers ($, el, api, app).
'use strict';

const form = $('#img-form');
const promptBox = $('#img-prompt');
// A prompt typed and not drawn yet stays through the app lock (lock.js).
app.workHere.push(() => !!promptBox.value.trim());
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
    const q = new URLSearchParams({ prompt: promptBox.value, width: $('#img-w').value, height: $('#img-h').value, model: panes.image.model.value, mode: $('#img-mode').value, style: styleNow() ?? '', quality: qualityNow(), as: $('#draw-as').value });
    try {
      const p = await api(`/api/images/plan?${q}`);
      drawQualities(p.qualities);
      hiddenParts = Array.isArray(p.negative) ? p.negative : [];
      drawChips();
      // An artist whose way of working sets the style: theirs is drawn, whatever Style says (shown faded).
      const theirs = p.why === 'their way of working';
      for (const r of document.querySelectorAll('input[name="img-style"]')) r.closest('label').classList.toggle('off', theirs || $('#img-custom').checked);
      $('#img-style-tiles').classList.toggle('off', theirs || $('#img-custom').checked);
      $('#img-style-line').textContent = theirs ? 'Their way of working sets the style.' : $('#img-custom').checked ? 'Custom style is ticked under Advanced: no style words are added.' : '';
      // The model's own size changed (another model chosen): a Shape is worked out again from it.
      const mid = p.qualities?.mid?.generated;
      const side = mid ? Math.round(Math.sqrt(mid.width * mid.height) / 64) * 64 : modelSide;
      if (side !== modelSide) {
        modelSide = side;
        const was = `${$('#img-w').value}x${$('#img-h').value}`;
        syncForm();
        if (`${$('#img-w').value}x${$('#img-h').value}` !== was) return void updatePlan();
      }
      if (!promptBox.value.trim()) return void (detectLine.textContent = '');
      const chosen = $('#img-mode').value;
      const mode = chosen === 'auto' || theirs ? `${MODE_NAME[p.mode]} (${p.why})` : p.styleName ?? MODE_NAME[chosen];
      const size = p.target ? `${p.target.width}×${p.target.height}, drawn at ${p.generated.width}×${p.generated.height}` : `${p.generated.width}×${p.generated.height}`;
      detectLine.textContent = `${mode} · ${size}${p.drafts > 1 ? ` · ${p.drafts} drafts to pick from` : ''}${p.portrait && !p.size ? ' · square portrait' : ''}${p.group ? ' · wide, for the people asked for' : ''}${p.size ? ' · size taken out of the prompt' : ''}`;
      // The model in use is not made for this mode: say which one is (choose it, or download it, in the list above).
      if (p.better) detectLine.append(el('span', { class: 'better', text: ` · ${MODE_NAME[p.mode]} looks best with ${p.better.name}${p.better.installed ? ': choose it in the model list and press Connect' : ': download it from the model list'}` }));
    } catch {
      detectLine.textContent = '';
    }
  }, 250);
}
promptBox.addEventListener('input', updatePlan);

// ---- Draft / Mid / High (2.0.65): small and several, the model's own size, its largest. Kept in this browser. ----
const qualityNow = () => $('input[name="img-quality"]:checked')?.value ?? 'mid';
{
  const kept = store('img-quality');
  const box = kept && document.querySelector(`input[name="img-quality"][value="${kept}"]`);
  if (box) box.checked = true;
}
for (const r of document.querySelectorAll('input[name="img-quality"]')) r.addEventListener('change', () => { store('img-quality', qualityNow()); updatePlan(); });
/** Each button's size (and a Draft's count) for the model in use. */
function drawQualities(qs) {
  for (const s of document.querySelectorAll('[data-quality]')) {
    const g = qs?.[s.dataset.quality];
    const out = g?.output ?? g?.generated;
    s.textContent = g ? `${out.width}×${out.height}${g.count > 1 ? ` · ${g.count}` : ''}${g.output ? ' · sharp' : ''}` : '';
  }
}
panes.image.model.addEventListener('change', updatePlan);

// ---- The draw form: Leave out chips, Shape, Style and one closed Advanced, kept per artist in this browser ----

const SHAPES = { '1:1': [1, 1], '4:3': [4, 3], '16:9': [16, 9], '9:16': [9, 16] };
/** Where a hidden "leave out" word comes from, in words (the recipe's is the artist's role, from Draw as). */
const SOURCE_NAME = { mode: 'style', portrait: 'portrait', model: 'model' };
const chipList = $('#img-chip-list');
const chipBox = $('#img-negative');
const advBox = $('#img-advanced');
let typedChips = [];
let droppedWords = [];
let hiddenParts = [];
// The side of a square at the model's own size (Mid), from the plan: a Shape keeps that many pixels.
let modelSide = 512;
const radioNow = name => document.querySelector(`input[name="${name}"]:checked`)?.value ?? 'auto';
/** The Style row's values that are modes themselves; every other style rides on Custom with its own words (src/styles.ts). */
const FORM_MODES = ['auto', 'blog', 'icon', 'cartoon'];
const modeOfStyle = v => (FORM_MODES.includes(v) ? v : 'custom');
/** The style sent with a picture: none while Custom style is ticked (no style words at all). */
const styleNow = () => ($('#img-custom').checked ? undefined : radioNow('img-style'));
function setRadio(name, value) {
  const r = document.querySelector(`input[name="${name}"][value="${CSS.escape(String(value))}"]`) ?? document.querySelector(`input[name="${name}"][value="auto"]`);
  r.checked = true;
}
const splitWords = text => String(text ?? '').split(',').map(w => w.trim()).filter(Boolean);

/** What Draw asks for (the hidden fields queue.js reads too): Advanced's exact size, else the Shape at the model's own size. */
function syncForm() {
  const w = $('#img-exact-w').value;
  const h = $('#img-exact-h').value;
  let size = ['', ''];
  if (w && h) size = [w, h];
  else if (SHAPES[radioNow('img-shape')]) {
    const [a, b] = SHAPES[radioNow('img-shape')];
    const k = modelSide / Math.sqrt(a * b);
    size = [String(Math.round((a * k) / 8) * 8), String(Math.round((b * k) / 8) * 8)];
  }
  [$('#img-w').value, $('#img-h').value] = size;
  $('#img-mode').value = $('#img-custom').checked ? 'custom' : modeOfStyle(radioNow('img-style'));
  $('#img-seed').disabled = $('#img-random').checked;
  drawAdvSummary();
}

/** Closed with something set: the summary says what, in a few words ("Advanced: seed 1234, 30 steps"). */
function drawAdvSummary() {
  const said = [];
  const w = $('#img-exact-w').value;
  const h = $('#img-exact-h').value;
  if (w && h) said.push(`${w}×${h}`);
  if ($('#img-fit').value !== 'crop') said.push($('#img-fit').value);
  if (!$('#img-random').checked && $('#img-seed').value !== '') said.push(`seed ${$('#img-seed').value}`);
  if ($('#img-steps').value) said.push(`${$('#img-steps').value} steps`);
  if ($('#img-cfg').value) said.push(`strength ${$('#img-cfg').value}`);
  if ($('#img-sampler').value) said.push($('#img-sampler').selectedOptions[0].textContent.replace(/^.*\((.*)\)$/, '$1'));
  if ($('#img-custom').checked) said.push('custom style');
  if ($('#img-ico').checked) said.push('icon sizes');
  $('#img-adv-summary').textContent = !advBox.open && said.length ? `Advanced: ${said.join(', ')}` : 'Advanced';
}

function chip(word, source, onRemove) {
  return el('span', { class: `chip img-chip${source ? ' img-chip-hidden' : ''}`, role: 'listitem' },
    el('span', { text: word }),
    source ? el('small', { text: ` · ${source}` }) : null,
    el('button', { class: 'chip-drop', type: 'button', text: '×', title: source ? `Stop leaving out "${word}" (added by the ${source})` : `Stop leaving out "${word}"`, 'aria-label': `Stop leaving out ${word}`, onclick: onRemove }));
}

/** The typed words, then the hidden ones by source (each word once, with every source that adds it). */
function drawChips() {
  const role = $('#draw-as').selectedOptions[0]?.dataset.role || 'artist';
  const seen = new Map();
  for (const part of hiddenParts) {
    for (const word of part.words) {
      const key = word.toLowerCase();
      if (droppedWords.some(d => d.toLowerCase() === key) || typedChips.some(t => t.toLowerCase() === key)) continue;
      const name = part.source === 'recipe' ? role : SOURCE_NAME[part.source] ?? part.source;
      const had = seen.get(key);
      if (had) { if (!had.names.includes(name)) had.names.push(name); } else seen.set(key, { word, names: [name] });
    }
  }
  chipList.replaceChildren(
    ...typedChips.map(w => chip(w, '', () => { typedChips = typedChips.filter(x => x !== w); saveForm(); drawChips(); })),
    ...[...seen.values()].map(h => chip(h.word, h.names.join(', '), () => { droppedWords.push(h.word); saveForm(); drawChips(); })));
  const back = $('#img-chips-back');
  back.hidden = !droppedWords.length;
  back.textContent = `Put back the ${droppedWords.length === 1 ? 'word' : `${droppedWords.length} words`} taken out (${droppedWords.join(', ')})`;
}

function addChips() {
  for (const w of splitWords(chipBox.value)) if (!typedChips.some(t => t.toLowerCase() === w.toLowerCase())) typedChips.push(w.slice(0, 80));
  chipBox.value = '';
  saveForm();
  drawChips();
}
chipBox.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addChips(); }
  else if (e.key === 'Backspace' && !chipBox.value && typedChips.length) { typedChips.pop(); saveForm(); drawChips(); }
});
$('#img-chip-add').addEventListener('click', () => { addChips(); chipBox.focus(); });
$('#img-chips-back').addEventListener('click', () => { droppedWords = []; saveForm(); drawChips(); });

// Kept per staff member (the artist in Draw as, or this PC's own pane), in this browser only.
const ADV_FIELDS = { w: '#img-exact-w', h: '#img-exact-h', fit: '#img-fit', seed: '#img-seed', steps: '#img-steps', cfg: '#img-cfg', sampler: '#img-sampler' };
const ADV_CHECKS = { random: '#img-random', custom: '#img-custom', ico: '#img-ico' };
const ADV_DEFAULT = { w: '', h: '', fit: 'crop', seed: '', steps: '', cfg: '', sampler: '', random: true, custom: false, ico: false };
const formKey = () => `img-form:${$('#draw-as').value || 'pc'}`;
let formLoading = false;
function saveForm() {
  if (formLoading) return;
  const kept = { open: advBox.open, chips: typedChips, dropped: droppedWords, shape: radioNow('img-shape'), style: radioNow('img-style') };
  for (const [k, id] of Object.entries(ADV_FIELDS)) kept[k] = $(id).value;
  for (const [k, id] of Object.entries(ADV_CHECKS)) kept[k] = $(id).checked;
  try { localStorage.setItem(formKey(), JSON.stringify(kept)); } catch { /* not kept */ }
}
function setAdvanced(v) {
  for (const [k, id] of Object.entries(ADV_FIELDS)) {
    const box = $(id);
    box.value = v[k] ?? ADV_DEFAULT[k];
    // A value this list does not have (a sampler from an older copy): back to the default.
    if (box.tagName === 'SELECT' && box.selectedIndex < 0) box.value = ADV_DEFAULT[k];
  }
  for (const [k, id] of Object.entries(ADV_CHECKS)) $(id).checked = typeof v[k] === 'boolean' ? v[k] : ADV_DEFAULT[k];
}
function loadForm() {
  let v = {};
  try { v = JSON.parse(localStorage.getItem(formKey()) ?? '{}') ?? {}; } catch { v = {}; }
  formLoading = true;
  setAdvanced(v);
  typedChips = Array.isArray(v.chips) ? v.chips.filter(w => typeof w === 'string').slice(0, 60) : [];
  droppedWords = Array.isArray(v.dropped) ? v.dropped.filter(w => typeof w === 'string').slice(0, 100) : [];
  setRadio('img-shape', v.shape ?? 'auto');
  setRadio('img-style', v.style ?? 'auto');
  advBox.open = v.open === true;
  formLoading = false;
  syncForm();
  drawChips();
  updatePlan();
  drawStyleTiles();
}

// ---- The Style picker: a tile per style with its sample for the artist's model (stylepick.js) ----

/** The model the artist in Draw as draws with (this PC's picture model with no artist), and its name. */
function artistModel() {
  const a = stylePick.now()?.artists?.find(x => x.id === drawAs.value);
  if (a) return { model: a.model, modelName: a.modelName || (a.model ? a.model : 'the model loaded on their PC'), artist: a };
  const opt = panes.image.model.selectedOptions?.[0];
  return { model: panes.image.model.value || null, modelName: String(opt?.textContent ?? '').replace(/\s*\(.*$/, '').trim() || "this PC's picture model", artist: null };
}
function drawStyleTiles() {
  if (!stylePick.now()) return;
  const m = artistModel();
  $('#img-style-tiles').replaceChildren(...stylePick.tiles({ model: m.model, modelName: m.modelName, value: radioNow('img-style'), pick: s => {
    setRadio('img-style', s.value);
    // Its shape too, which can still be changed in the Shape row.
    if (s.shape !== 'auto') setRadio('img-shape', s.shape);
    syncForm();
    saveForm();
    updatePlan();
    drawStyleTiles();
  } }));
  // The styles with no sample yet, said once above the tiles.
  const none = stylePick.missing(m.model, m.modelName);
  $('#img-style-none').textContent = none;
  $('#img-style-none').hidden = !none;
  const btn = $('#img-style-make');
  btn.disabled = !m.artist;
  btn.title = m.artist ? `Queues ${stylePick.count()} pictures for ${m.artist.name}: the same fox, seed ${stylePick.now().seed}, Mid, one per style. Each is kept as that style's sample for their model.` : 'Pick an artist in Draw as first: their model draws the samples, through the queue.';
}
$('#img-style-make').addEventListener('click', async () => {
  const m = artistModel();
  if (!m.artist) return;
  try {
    $('#img-style-said').textContent = await stylePick.make(m.artist.id);
    watchSamples();
  } catch (e) {
    $('#img-style-said').textContent = e.message;
  }
});
/** While style samples are in the queue: the tiles are read again every 20 s, until none is left to draw. */
let sampleWatch = 0;
function watchSamples() {
  clearInterval(sampleWatch);
  sampleWatch = setInterval(async () => {
    const q = await api('/api/queue').catch(() => null);
    await stylePick.load(true);
    drawStyleTiles();
    if (!(q?.items ?? []).some(i => i.sample && (i.state === 'waiting' || i.state === 'running'))) clearInterval(sampleWatch);
  }, 20000);
}
app.styleSamplesChanged = () => { drawStyleTiles(); };
panes.image.model.addEventListener('change', drawStyleTiles);
$('#img-adv-reset').addEventListener('click', () => {
  setAdvanced({});
  syncForm();
  saveForm();
  updatePlan();
});
advBox.addEventListener('toggle', () => { drawAdvSummary(); saveForm(); });
for (const id of [...Object.values(ADV_FIELDS), ...Object.values(ADV_CHECKS), '#img-shape', '#img-style']) {
  for (const box of id === '#img-shape' || id === '#img-style' ? document.querySelectorAll(`input[name="${id.slice(1)}"]`) : [$(id)]) {
    box.addEventListener(box.type === 'number' ? 'input' : 'change', () => { syncForm(); saveForm(); updatePlan(); });
  }
}

// ---- Generate / cancel ----

function options() {
  const num = id => ($(id).value === '' ? undefined : Number($(id).value));
  const random = $('#img-random').checked;
  return {
    // The chips, and words typed in the box but not added yet; hidden words taken out are sent one by one.
    prompt: promptBox.value, negative: [...typedChips, ...splitWords(chipBox.value)].join(', '), negativeDrop: droppedWords.length ? droppedWords : undefined,
    mode: $('#img-mode').value, style: styleNow(), width: num('#img-w'), height: num('#img-h'), fit: $('#img-fit').value,
    seed: random ? undefined : num('#img-seed'), steps: num('#img-steps'), cfg: num('#img-cfg'), sampler: $('#img-sampler').value || undefined,
    ico: $('#img-ico').checked, as: $('#draw-as').value || undefined,
    quality: $('input[name="img-quality"]:checked')?.value ?? 'mid',
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
  // The chat on screen gets the picture ('' = none), named: not whichever chat another window opened last.
  const chat = app.chatId ?? '';
  if (app.status?.panes.image.state !== 'connected' && !app.awayArtist && !(await loadThenDraw())) return;
  if ((app.chatId ?? '') !== chat) return showFault(fault, 'The picture model is loaded, but another chat was opened meanwhile, so nothing was drawn. Press Draw again.');
  await start('/api/images/generate', { ...options(), chat });
  // The first thing asked names a new chat, and the chat moves to the top of the list.
  app.afterSend?.(chat);
});
/**
 * Draw with no picture model loaded: asks "Load X and draw?" under Connect, as a chat asks before it sends (nothing loads
 * by itself), loads it and waits for it. True once it is loaded; false when not (said in the fault box).
 */
async function loadThenDraw() {
  const p = panes.image;
  const state = app.status?.panes.image.state;
  if (state === 'loading' || state === 'unloading') {
    showFault(fault, `The picture model is ${state === 'loading' ? 'still loading' : 'unloading'}: press Draw again once it says Connected.`);
    return false;
  }
  const m = (app.models?.image ?? []).find(x => x.id === p.model.value && x.installed !== false);
  if (!m) {
    // The Connect row's own message (an earlier Connect with nothing to load) no longer holds: the one below is the answer.
    showFault(p.said, null);
    showFault(fault, 'No picture model is picked, so nothing can draw. Pick one in the list beside Connect (above), or get one under Settings, Models.');
    fault.scrollIntoView({ block: 'nearest' });
    return false;
  }
  const tight = m.fit?.level === 'no' ? ` It needs about ${gb(m.fit.need)} and only ${gb(m.fit.free)} is free, so it may make the PC very slow, or fail.` : '';
  if (!(await askHere(p.ask, `No picture model is loaded yet (nothing loads by itself).${tight} Load ${m.name} and draw?`, `Load ${m.name} and draw`, 'Not now', !!tight))) return false;
  showFault(fault, null);
  try {
    await loadModel(m.id, { device: p.device.value, threads: Number(p.threads.value) || 0 });
  } catch (err) {
    showFault(fault, `${m.name} did not load: ${err.message}`);
    return false;
  }
  for (let i = 0; i < 1800; i++) {
    await new Promise(r => setTimeout(r, 500));
    await poll();
    const v = app.status?.panes.image;
    if (v?.state === 'connected') return true;
    if (v?.state === 'failed' || (v?.state === 'disconnected' && i > 6)) {
      showFault(fault, `${m.name} did not load${v.error ? `: ${v.error}` : ''}. Press Draw to try again.`);
      return false;
    }
  }
  showFault(fault, `${m.name} is taking a long time to load. Press Draw again once it says Connected.`);
  return false;
}

// Like a chat's message box: Enter draws it, Shift+Enter starts a new line.
promptBox.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    form.requestSubmit();
  }
});
cancelBtn.addEventListener('click', () => api('/api/images/cancel', {}).catch(error => showFault(fault, error.message)));

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

/**
 * Whether the picture being drawn shows as "Picture in progress" in the chat open now: in the chat it was asked from,
 * else (a queued one, asked from no chat) in its own artist's chats, never in another artist's. This PC's own pictures
 * pane (no chat open) and a picture drawn for a linked PC show it everywhere. The top bar's chip shows it either way.
 */
function progressHere(j, chatId, who) {
  if (!chatId || j.forPc) return true;
  if (j.chat) return j.chat === chatId;
  return !!j.as && who === `staff:${j.as}`;
}

function drawJob(j) {
  const running = j && RUNNING.includes(j.state);
  // Draw stays pressable: pressed before Connect, it asks to load the picture model first.
  goBtn.title = app.status?.panes.image.state !== 'connected' && !app.awayArtist ? 'Draw asks to load the picture model first (nothing loads by itself)' : 'Enter in the box does the same';
  const here = running && progressHere(j, app.chatId ?? '', typeof chatUi === 'undefined' ? '' : chatUi.open?.who ?? '');
  cancelBtn.hidden = !here;
  const wasHidden = progress.hidden;
  progress.hidden = !here;
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
    if (wasHidden && here) progress.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
  // Said plainly (2.0.65): Icon mode cuts the background away; another Mode keeps it.
  if (j.results.some(p => p.transparent && p.mode === 'icon')) results.append(el('p', { class: 'hint span-all', text: 'Background cut away (Icon mode). To keep it, choose another Mode under More options and draw again.' }));
}

// ---- The main photo ----

let mainPic = null;
const mpImg = $('#mp-img');

/** Add to the gallery, or take back out to Drafts. */
async function setKept(p, kept) {
  const { saved, ...np } = await api('/api/images/keep', { id: p.id, kept });
  // A picture kept in a project's chat is handed in to that project: where it went, or why not, is said under it.
  if (saved) savedSay = { id: np.id, saved };
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
  const save = saveToProject(p, true, async np => { mainPic = np; await drawGallery().catch(() => undefined); showMain(np); });
  // Less used, in the … menu: it closes when one is pressed.
  // Escape, or a press anywhere else, closes it too.
  const more = el('details', { class: 'mp-more', onkeydown: e => { if (e.key === 'Escape' && more.open) { more.open = false; more.querySelector('summary').focus(); } } }, el('summary', { 'aria-label': 'More for this picture', title: 'Set as profile photo, Make a clip, Delete', text: '…' }));
  const away = e => { if (!more.isConnected) document.removeEventListener('pointerdown', away); else if (more.open && !more.contains(e.target)) more.open = false; };
  document.addEventListener('pointerdown', away);
  const item = (text, title, go) => el('button', { class: 'btn quiet', type: 'button', text, title, onclick: e => { more.open = false; go(e); } });
  more.append(el('span', { class: 'mp-more-list' },
    item('Set as profile photo', 'Choose whose photo it becomes', e => app.pickFace(p, e.target)),
    item('Ask about this picture', 'A chat opens with this picture on your next message, for a model that can look at pictures', () => app.askAboutPicture?.(fileUrl(p.output), p.prompt)),
    item('Make a clip from this picture', 'A Videographer\'s chat opens with this picture as the start of the clip', () => app.clipFromPicture?.(fileUrl(p.output), { gallery: p.id }, p.prompt)),
    item('Delete', 'Delete this picture for good (asked first)', () => deletePictures({ ids: [p.id] }, 'this picture'))));
  actions.append(
    save.buttons,
    el('button', { class: 'btn', type: 'button', text: kept ? 'Move to drafts' : 'Add to gallery', title: kept ? 'Take it out of the gallery; it waits in Drafts' : 'Keep it: it goes into the gallery', onclick: async e => { e.target.disabled = true; try { await setKept(p, !kept); } catch (error) { showFault(fault, error.message); e.target.disabled = false; } } }),
    el('button', { class: 'btn', type: 'button', text: p.draft ? 'Full quality' : 'Draw again, full quality', title: 'Same seed, more steps and the full-quality decoder; the new one waits in Drafts', onclick: () => start('/api/images/finalise', { id: p.id }) }),
    el('a', { class: 'btn quiet', href: `${fileUrl(p.output)}?download`, text: 'Download' }),
    more,
    save.pick,
  );
  const line = savedLine(p);
  if (line) actions.append(line);
}

// ---- Save to project: a copy in a project's specialists\images folder (src/server/places.ts) ----

/** What the last save of a picture said ({id, saved}), shown under that picture. */
let savedSay = null;
/** The same cut as the New chat window's project tiles. */
const projectCut = name => (name.length > 20 ? `${name.slice(0, 20).trimEnd()}…` : name);
const pageProjects = () => (typeof chatUi === 'undefined' ? [] : chatUi.projects);
/** The project of the chat a picture was drawn in ('' for Default, or a chat or project that is gone). */
function chatProjectOf(p) {
  if (typeof chatUi === 'undefined' || !p.chat) return '';
  const id = chatUi.list.find(c => c.id === p.chat)?.project ?? '';
  return pageProjects().some(x => x.id === id) ? id : '';
}

/**
 * Save to project for picture `p`: straight into its chat's project, or a picker of projects when the chat has none;
 * ▾ always picks. Which project is read at the press (the chat list may arrive after the picture is drawn).
 * `after(picture)` draws the picture again with the line saying where it went.
 */
function saveToProject(p, primary, after) {
  const pick = el('div', { class: 'save-pick', role: 'group', 'aria-label': 'Save to which project', hidden: true });
  const go = async (project, btn) => {
    pick.hidden = true;
    btn.disabled = true;
    try {
      const r = await api('/api/images/to-project', { id: p.id, project });
      savedSay = { id: p.id, saved: r.saved };
      galleryDirty = true;
      after(r.picture);
    } catch (e) {
      btn.disabled = false;
      savedSay = { id: p.id, saved: e.data?.saved ?? { error: e.message } };
      after(e.data?.picture ?? p);
    }
  };
  const openPick = btn => {
    const all = pageProjects();
    const own = chatProjectOf(p);
    pick.replaceChildren(
      el('span', { class: 'hint', text: all.length ? 'Save to:' : 'No projects yet: make one on Home, or with New chat.' }),
      ...all.map(x => el('button', { class: 'btn quiet', type: 'button', text: projectCut(x.name), title: x.name, 'aria-pressed': String(x.id === own), onclick: e => go(x.id, e.target) })));
    pick.hidden = !pick.hidden;
    btn.setAttribute('aria-expanded', String(!pick.hidden));
  };
  const cls = `btn${primary ? ' primary' : ''}`;
  const main = el('button', { class: cls, type: 'button', text: 'Save to project', title: 'A copy goes into the specialists\\images folder of this chat\'s project, or of the project you pick', onclick: e => {
    const own = chatProjectOf(p);
    return own ? go(own, e.target) : openPick(e.target);
  } });
  const other = el('button', { class: `${cls} save-other`, type: 'button', text: '▾', title: 'Save to another project', 'aria-label': 'Save to another project', 'aria-expanded': 'false', onclick: e => openPick(e.target) });
  return { buttons: el('span', { class: 'save-to' }, main, other), pick };
}

/** The line under a picture after a save: where it went with Open folder, or why not. */
function savedLine(p) {
  const s = savedSay?.id === p.id ? savedSay.saved : null;
  if (!s) return null;
  if (s.error) return el('p', { class: 'save-line fault-line', text: s.name ? `Not saved to ${s.name}: ${s.error}. It is in the gallery.` : s.error });
  const file = s.path.split('/').pop();
  const open = el('button', { class: 'btn quiet', type: 'button', text: 'Open folder', title: 'Opens the folder in Windows Explorer', onclick: async e => {
    try {
      await api('/api/images/open-folder', { project: s.project });
    } catch (error) {
      e.target.replaceWith(el('span', { class: 'fault-line', text: error.message }));
    }
  } });
  return el('p', { class: 'save-line', title: s.path.replace(/\//g, '\\') }, el('span', { text: `${s.already ? 'Already in' : 'Saved to'} ${s.name}\\specialists\\images\\${file}` }), open);
}

/** The picture before or after the main one, in the gallery list as it is shown. */
function stepMain(by) {
  const list = galleryList;
  if (!list.length) return;
  const i = list.findIndex(x => x.id === mainPic?.id);
  const next = i < 0 ? list[0] : list[(i + by + list.length) % list.length];
  showMain(next);
  // Only the gallery's own scroll box moves to show the tile: never the page, and focus stays where it was.
  const box = $('#gallery');
  const t = box.querySelector(`.tile[data-id="${CSS.escape(next.id)}"]`);
  if (!t) return;
  const b = box.getBoundingClientRect();
  const r = t.getBoundingClientRect();
  if (r.top < b.top) box.scrollTop -= b.top - r.top;
  else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom;
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
  // A picture from a linked PC on an older TOMLIN came back with no settings: said, not shown as noughts.
  row('Seed', p.settingsUnknown ? 'settings unknown (drawn on a linked PC running an older TOMLIN)' : p.seed);
  if (!p.settingsUnknown) row('Steps / CFG / sampler', `${p.steps} / ${p.cfg} / ${p.sampler}`);
  row('Model', p.modelName);
  row('Ran on', `${p.device}, ${p.seconds} s`);
  row('File', `${p.format.toUpperCase()}, ${Math.round(p.bytes / 1024)} KB${p.transparent ? ', see-through background' : ''}`);
  row('Left out', p.negative);
  row('Alt text', p.altText ? `${p.altText} (written from ${p.altFrom ?? 'the prompt'})` : null);
  row('Made', new Date(p.at).toLocaleString());
  row('Saved to', (p.savedTo ?? []).map(s => s.name).join(', '));
  const actions = $('#viewer-actions');
  const save = saveToProject(p, false, async np => {
    openViewer(np);
    await drawGallery().catch(() => undefined);
    if (mainPic?.id === np.id) showMain(np);
  });
  actions.replaceChildren(
    el('a', { class: 'btn primary', href: `${fileUrl(p.output)}?download`, text: 'Download' }),
    save.buttons,
    el('a', { class: 'btn', href: `${fileUrl(p.original)}?download`, text: 'Download original' }),
    el('button', { class: 'btn', type: 'button', text: 'Draw again, same seed', disabled: !!p.settingsUnknown, title: p.settingsUnknown ? 'The seed is not known: it was drawn on a linked PC running an older TOMLIN' : '', onclick: () => { viewer.close(); start('/api/images/again', { id: p.id }); } }),
    el('button', { class: 'btn', type: 'button', text: p.draft ? 'Full quality' : 'Re-run at full quality', disabled: !!p.settingsUnknown, onclick: () => { viewer.close(); start('/api/images/finalise', { id: p.id }); } }),
    el('button', { class: 'btn', type: 'button', text: 'Copy prompt', onclick: async e => { try { await navigator.clipboard.writeText(p.prompt); e.target.textContent = 'Copied'; } catch { promptBox.value = p.prompt; e.target.textContent = 'Put in the prompt box'; } } }),
    el('button', { class: 'btn', type: 'button', text: 'Use this prompt', onclick: () => { promptBox.value = p.prompt; viewer.close(); updatePlan(); promptBox.focus(); } }),
    el('button', { class: 'btn', type: 'button', text: 'Ask about this picture', title: 'A chat opens with this picture on your next message, for a model that can look at pictures', onclick: () => { viewer.close(); app.askAboutPicture?.(fileUrl(p.output), p.prompt); } }),
    el('button', { class: 'btn', type: 'button', text: 'Make a clip from this picture', title: 'A Videographer\'s chat opens with this picture as the start of the clip', onclick: () => { viewer.close(); app.clipFromPicture?.(fileUrl(p.output), { gallery: p.id }, p.prompt); } }),
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
  actions.append(save.pick);
  const line = savedLine(p);
  if (line) actions.append(line);
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
  // Pressable with nothing ticked (a greyed button says nothing in Firefox): it says why instead.
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
$('#g-del').addEventListener('click', () => {
  if (!picking.ids.size) return void ($('#g-picked-n').textContent = 'Nothing is ticked yet: tick the pictures to delete first, or press × on one.');
  deletePictures({ ids: [...picking.ids] }, `the ${picking.ids.size} ticked picture${picking.ids.size === 1 ? '' : 's'}`);
});
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
  // The Videos shelf: clips a Videographer made (clips.js), every chat's (an artist's chat has none of its own), so
  // This chat and All chats are not offered there.
  $('.g-scope').parentElement.hidden = shelf === 'videos' || shelf === 'voice';
  if (shelf === 'videos') {
    $('#g-more').hidden = true;
    $('#g-tools').hidden = true;
    return app.drawClipShelf?.(box, { q });
  }
  // The Voice shelf: voice-overs read aloud (voice.js), every chat's, with Speak a line to make another.
  if (shelf === 'voice') {
    $('#g-more').hidden = true;
    $('#g-tools').hidden = true;
    return app.drawVoiceShelf?.(box, { q, speak: true });
  }
  $('#g-tools').hidden = false;
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
    // Under 2 GB free where pictures are kept: a reminder only, pictures still save.
    $('#img-lowdisk').textContent = g.lowDisk ?? '';
    $('#img-lowdisk').hidden = !g.lowDisk;
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

/**
 * The other pictures being drawn on linked PCs while the window follows the newest one (T1): one line each, with its
 * artist, PC, step and its own Cancel, so a picture here or on one PC never hides one going on another.
 */
let alsoSig = '';
function drawAlso(list) {
  const box = $('#img-also');
  if (!box) return;
  const rows = Array.isArray(list) ? list : [];
  // The time so far is in it by 5 s, so a row starting (its model loading, which can take minutes) does not stand still.
  const sig = JSON.stringify(rows.map(j => [j.id, j.state, j.step, j.steps, Math.floor((j.elapsed ?? 0) / 5)]));
  if (sig === alsoSig) return;
  alsoSig = sig;
  box.hidden = !rows.length;
  box.replaceChildren(...rows.map(j => {
    const pc = app.pcShown?.(j.pc, j.pcName) ?? j.pcName;
    const where = j.state === 'drawing' && j.steps ? `step ${j.step} of ${j.steps}` : j.state === 'decoding' || j.state === 'finishing' ? 'finishing' : 'starting';
    return el('div', { class: 'net-row' },
      el('span', { class: 'net-name' }, el('strong', { text: `Also drawing: ${j.who} on "${pc}"` }), el('br'), el('span', { class: 'hint', text: `${where} · ${secondsText(j.elapsed)} so far · ${j.prompt}` })),
      el('button', { class: 'btn quiet', type: 'button', text: 'Cancel', onclick: e => {
        const b = e.currentTarget;
        b.disabled = true;
        // A cancel that failed can be pressed again.
        api('/api/images/cancel', { id: j.id }).catch(error => { b.disabled = false; showFault(fault, error.message); });
      } }));
  }));
}

app.onStatus.push(s => {
  drawJob(s.panes.image.job);
  drawAlso(s.panes.image.also);
  drawChatHelp(s);
});

// ---- Models (download, licence, fit) ----

// The Models page (public/models.js) opens from the Settings menu (Models), not the top bar.

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
    ...people.map(p => el('option', { value: p.id, 'data-role': (d.roles.find(r => r.id === p.role)?.name ?? 'Artist').toLowerCase(), text: `${p.name} · ${d.roles.find(r => r.id === p.role)?.name ?? 'Artist'} · ${String(p.model ?? '').startsWith('remote:') ? 'draws on a linked PC' : 'this PC'}` })));
  drawAs.value = people.some(p => p.id === m.settings.imageAs) ? m.settings.imageAs : '';
  await stylePick.load(true);
  drawStyleTiles();
  // The form as this artist (or this PC's pane) last had it.
  if (formKey() !== shownForm) { shownForm = formKey(); loadForm(); }
  await drawNodeArtist(d);
};
let shownForm = formKey();
loadForm();
drawAs.addEventListener('change', async () => {
  shownForm = formKey();
  loadForm();
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

// ---- Load previously made images: the image sources in a workspace folder (src/sources.ts) ----

const sourcesBox = $('#sources');

/** A source's words and settings into the form, for Draw (which goes wherever the artist chosen draws, a linked PC too). */
function sourceToForm(s) {
  promptBox.value = s.prompt;
  const style = ['auto', 'blog', 'icon', 'cartoon'].includes(s.mode) ? s.mode : 'auto';
  setRadio('img-style', style);
  $('#img-custom').checked = s.mode === 'custom';
  $('#img-exact-w').value = s.target.width;
  $('#img-exact-h').value = s.target.height;
  $('#img-fit').value = ['crop', 'pad', 'stretch'].includes(s.fit) ? s.fit : 'crop';
  const known = s.settings === 'known';
  $('#img-random').checked = !known;
  $('#img-seed').value = known ? s.seed : '';
  $('#img-steps').value = known ? s.steps : '';
  $('#img-cfg').value = known ? s.cfg : '';
  if (known && [...$('#img-sampler').options].some(o => o.value === s.sampler)) $('#img-sampler').value = s.sampler;
  advBox.open = true;
  syncForm();
  saveForm();
  sourcesBox.close();
  updatePlan();
  promptBox.focus();
}

function sourceRow(s) {
  const known = s.settings === 'known';
  const draw = seed => async e => {
    e.target.disabled = true;
    showFault($('#sources-fault'), null);
    try {
      await api('/api/images/from-source', { path: s.path, seed, chat: app.chatId ?? '' });
      sourcesBox.close();
      shownJob = null;
      await poll();
    } catch (error) {
      showFault($('#sources-fault'), error.message);
      e.target.disabled = false;
    }
  };
  return el('div', { class: 'source-row' },
    el('p', { class: 'source-prompt', text: s.prompt }),
    el('p', { class: 'hint', text: [
      s.path,
      s.pictureThere ? '' : 'the picture file is gone',
      `${s.target.width}×${s.target.height}`,
      known ? `seed ${s.seed}, ${s.steps} steps, CFG ${s.cfg}, ${s.sampler}` : 'settings unknown',
      s.modelName || s.model,
      s.licence ? `licence: ${s.licence}` : '',
      s.at ? new Date(s.at).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '',
    ].filter(Boolean).join(' · ') }),
    el('div', { class: 'source-acts' },
      el('button', { class: 'btn', type: 'button', text: 'Draw again, same seed', disabled: !known, title: known ? 'On this PC, with the same words, size and settings' : 'The seed is not known: it was drawn on a linked PC running an older TOMLIN', onclick: draw('same') }),
      el('button', { class: 'btn', type: 'button', text: 'Draw again, new seed', title: 'On this PC: the same words, size and settings, a different picture', onclick: draw('new') }),
      el('button', { class: 'btn', type: 'button', text: 'Put in the form', title: 'Its words, size, seed and steps go into the form; Draw then sends it to the artist chosen, on this PC or a linked one', onclick: () => sourceToForm(s) })));
}

async function lookSources() {
  const line = $('#sources-line');
  showFault($('#sources-fault'), null);
  line.textContent = 'Looking…';
  try {
    const r = await api(`/api/images/sources?folder=${encodeURIComponent($('#sources-folder').value.trim())}`);
    $('#sources-list').replaceChildren(...r.sources.map(sourceRow));
    const n = r.sources.length;
    line.textContent = [
      n ? `${n} image source${n === 1 ? '' : 's'}${r.more ? ' (there are more: name a folder to see the rest)' : ''}, newest first.` : 'No image sources in that folder. Pictures drawn before TOMLIN wrote them have none.',
      r.damaged ? `${r.damaged} could not be read and ${r.damaged === 1 ? 'is' : 'are'} left out.` : '',
    ].filter(Boolean).join(' ');
  } catch (error) {
    line.textContent = '';
    $('#sources-list').replaceChildren();
    showFault($('#sources-fault'), error.message);
  }
}

$('#g-load').addEventListener('click', () => {
  if (!sourcesBox.open) sourcesBox.showModal();
  void lookSources();
});
$('#sources-look').addEventListener('click', lookSources);
$('#sources-folder').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); void lookSources(); }
});
