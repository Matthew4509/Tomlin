// TOMLIN's page: the top bar (polled once a second), the two panes' Connect / Disconnect, and chat. One pane shows at a
// time: the chat, or (in an artist's chat) the pictures (chats.js picks).
// The image pane's own controls are in images.js. Only TOMLIN's own endpoints are used.
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const GB = 2 ** 30;
const gb = n => `${(n / GB).toFixed(n >= 10 * GB ? 0 : 1)} GB`;
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids) if (k != null) e.append(k);
  return e;
};

async function api(path, body) {
  // While the app lock's screen is up, nothing but the lock's own door is asked (the server would refuse it anyway).
  if (app.lockShown && path !== '/api/applock') throw Object.assign(new Error('TOMLIN is locked.'), { status: 423 });
  let res;
  try {
    res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    // The browser could not reach TOMLIN at all ("Failed to fetch"): the server is not running.
    throw new Error('TOMLIN is not answering: its window was closed or it stopped. Start it again (Start TOMLIN.cmd in its folder), then try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 423 && path !== '/api/applock') app.appLocked?.();
  if (!res.ok) throw Object.assign(new Error(data.error?.message ?? data.error ?? `TOMLIN answered ${res.status}.`), { status: res.status, data });
  return data;
}

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    return null;
  }
  return null;
}

/**
 * Asks a question on the page in place of a browser pop-up (confirm() can be blocked, and says nothing about where it
 * came from): `box` shows the words and two buttons until one is pressed, then empties. True = the first button.
 */
function askHere(box, text, yes, no = 'Cancel', danger = true) {
  return new Promise(done => {
    const end = ok => {
      box.replaceChildren();
      box.hidden = true;
      done(ok);
    };
    const go = el('button', { class: `btn ${danger ? 'danger' : 'primary'}`, type: 'button', text: yes, onclick: () => end(true) });
    app.askFor?.(box, () => end(false));
    box.classList.add('page-ask');
    box.setAttribute('role', 'alert');
    box.replaceChildren(el('span', { text }), go, el('button', { class: 'btn quiet', type: 'button', text: no, onclick: () => end(false) }));
    box.hidden = false;
    go.focus();
  });
}

/** A message on the page with a Close button, in place of alert(). */
function sayHere(box, text) {
  box.classList.add('page-ask');
  box.setAttribute('role', 'alert');
  const close = el('button', { class: 'btn quiet', type: 'button', text: 'Close', onclick: () => {
    box.hidden = true;
    box.replaceChildren();
  } });
  box.replaceChildren(el('span', { text }), close);
  box.hidden = false;
  close.focus();
}

/** The box under the top bar for its questions and messages (it floats, so the page below does not move). */
function barBox() {
  const box = $('#bar-ask');
  box.style.top = `${Math.round($('header.bar').getBoundingClientRect().bottom + 6)}px`;
  return box;
}

const STATE_TEXT = { disconnected: 'Disconnected', loading: 'Loading…', connected: 'Connected', unloading: 'Unloading…', failed: 'Failed' };
const DEVICE_TEXT = { cpu: 'CPU', vulkan: 'graphics chip (Vulkan)', cuda: 'NVIDIA card (CUDA)' };

const app = { status: null, models: null, onStatus: [] };

// ---- "Show hidden": models hidden on Nodes and memory (Models on this PC, Hide) are left out where a model is picked ----

app.showHidden = store('show-hidden') === '1';
/** The models of a pick list to offer: a hidden one only once "Show hidden" is ticked, or when it is the pick now. */
function visibleModels(list, ...keep) {
  return app.showHidden ? list : list.filter(m => !m.hidden || keep.includes(m.id));
}
/** What draws a pick list again when "Show hidden" changes (each part of the page adds its own). */
const hiddenRedraws = [() => loadModels().catch(() => undefined)];
/**
 * The "Show hidden" tick of one pick list (`id` names it: the same element is given back each time, to be put beside
 * the list once). Every tick says the same; it shows only while its list has a hidden model.
 */
function hiddenTick(id, any) {
  let box = document.getElementById(id);
  if (!box) {
    const t = el('input', { type: 'checkbox' });
    t.addEventListener('change', () => {
      app.showHidden = t.checked;
      store('show-hidden', t.checked ? '1' : '');
      for (const x of document.querySelectorAll('.show-hidden input')) x.checked = t.checked;
      for (const fn of hiddenRedraws) fn();
    });
    box = el('label', { class: 'check show-hidden', id }, t, ' Show hidden');
  }
  box.querySelector('input').checked = app.showHidden;
  box.hidden = !any;
  return box;
}
window.app = app;

// ---- Top bar ----

/** "11 / 16 GB": one unit for the pair. */
const pair = (used, total) => `${(used / GB).toFixed(used >= 10 * GB ? 0 : 1)} / ${(total / GB).toFixed(total >= 10 * GB ? 0 : 1)} GB`;

/** A ring in the top bar: filled to `fraction`, a short value inside, the whole story in its tooltip. */
function meter(id, fraction, text, title) {
  meterOf(id, fraction, text, title);
}
function meterOf(id, fraction, text, title) {
  const m = $(`#${id}`);
  const pc = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  $('.val', m).setAttribute('stroke-dasharray', `${pc} 100`);
  $('.ring-v', m).textContent = text;
  m.classList.toggle('high', fraction > 0.85);
  if (title) {
    m.title = title;
    m.setAttribute('aria-label', title);
  }
}

const pct = (used, total) => (total ? `${Math.round((used / total) * 100)}%` : '–');

/**
 * The linked PC the top bar shows while a chat with someone on it is on screen (chats.js asks it every 3 s): the answer
 * of /api/node/stats ({state, name, model, stats}), or null for this PC.
 */
app.barPc = null;
app.showBarPc = r => {
  if (!r && !app.barPc) return;
  app.barPc = r;
  if (app.status) drawBar(app.status);
};
/** A model file's name without its file tags (Q4_K_M, .gguf): the full name is in the tooltip. */
const shortModel = name => String(name ?? '').replace(/\.gguf$/i, '').replace(/[-_.](?:i?q\d\w*|f16|bf16)$/i, '');

/** A linked PC beside this one on the bar: its name with the model loaded there under it, then its own four rings. */
function drawPcBar(r) {
  const there = ` on "${r.name}"`;
  const meter = (id, ...rest) => meterOf(id.replace(/^m-/, 'n-'), ...rest);
  $('#bar-pc-name').textContent = r.name;
  $('#bar-pc-model').textContent = r.state === 'old' ? 'Update TOMLIN there to see its meters'
    : r.state === 'off' ? 'Not answering just now'
      : r.model ? shortModel(r.model) : 'No model loaded';
  $('#bar-pc').title = `The top bar shows "${r.name}" while this chat is open: the answers are written there.${r.model ? ` Loaded there: ${r.model}.` : ''} Home, or a chat on this PC, shows this PC again.`;
  const st = r.state === 'on' ? r.stats : null;
  if (!st) {
    const why = r.state === 'old' ? `Its TOMLIN is too old to share its meters: update it.` : `It is not answering just now.`;
    for (const [id, k] of [['m-cpu', 'CPU'], ['m-gpubusy', 'GPU'], ['m-ram', 'RAM'], ['m-gpu', 'Graphics memory']]) meter(id, 0, '–', `${k}${there}: ${why}`);
    return;
  }
  meter('m-cpu', st.cpu / 100, `${st.cpu}%`, `CPU${there}: ${st.cpu}%`);
  meter('m-ram', st.ram.total ? st.ram.used / st.ram.total : 0, pct(st.ram.used, st.ram.total), `RAM${there}: ${st.ram.total ? pair(st.ram.used, st.ram.total) : gb(st.ram.used)} in use`);
  const g = st.gpu;
  if (!g) {
    meter('m-gpu', 0, '–', `Graphics memory${there}: no graphics chip found`);
    meter('m-gpubusy', 0, '–', `GPU${there}: no graphics chip found`);
    return;
  }
  meter('m-gpu', g.total ? g.used / g.total : 0, g.total ? pct(g.used, g.total) : gb(g.used), `Graphics memory${there}, ${g.name}: ${g.total ? pair(g.used, g.total) : gb(g.used)} in use${g.shared ? ' (built into the processor: it borrows from RAM)' : ''}`);
  meter('m-gpubusy', (g.busy ?? 0) / 100, g.busy == null ? '–' : `${g.busy}%`, g.busy == null ? `How hard ${g.name}${there} is working: not read yet` : `How hard ${g.name}${there} is working: ${g.busy}%`);
}

function drawBar(s) {
  // This PC always, on the left; a linked PC beside it while a chat with someone on it is open (each named then).
  const pcBar = app.barPc;
  $('#bar-node').hidden = !pcBar;
  $('#bar-mine').hidden = !pcBar;
  $('#bar-mine-name').textContent = app.pcProfileOf?.('here')?.name || 'My PC';
  $('header.bar').setAttribute('aria-label', pcBar ? `This PC, and "${pcBar.name}" (a linked PC)` : 'This PC');
  if (pcBar) drawPcBar(pcBar);
  const h = s.hardware;
  meter('m-cpu', h.cpu.percent / 100, `${h.cpu.percent}%`, `CPU ${h.cpu.percent}%. ${h.cpu.name}: ${h.cpu.cores} cores, ${h.cpu.threads} threads`);
  meter('m-ram', h.ram.used / h.ram.total, pct(h.ram.used, h.ram.total), `RAM: ${pair(h.ram.used, h.ram.total)} in use`);
  if (h.gpu) {
    const total = h.gpu.total;
    const chip = h.gpu.name.replace(/\(R\)|\(TM\)/gi, '');
    meter('m-gpu', total ? h.gpu.used / total : 0, total ? pct(h.gpu.used, total) : gb(h.gpu.used),
      `Graphics memory, ${chip}: ${total ? pair(h.gpu.used, total) : gb(h.gpu.used)} in use${h.gpu.shared ? '. Built into the processor, it borrows from RAM (Windows lets it take up to half), so this is also counted in RAM' : ''}. How hard the chip works is the GPU ring.`);
    const busy = h.gpu.busy;
    meter('m-gpubusy', (busy ?? 0) / 100, busy === null || busy === undefined ? '–' : `${busy}%`,
      busy === null || busy === undefined
        ? `How hard ${chip} is working: not read yet (Windows' counters start a few seconds after TOMLIN).`
        : `How hard ${chip} is working: ${busy}% (its busiest part, as Task Manager counts it). TOMLIN's models: ${h.gpu.models ?? 0}%.${h.gpu.shared ? ' It shares the processor chip\'s power and heat, so a busy GPU can slow the CPU too.' : ''}`);
  } else {
    meter('m-gpu', 0, '–', 'Graphics memory: no graphics chip found');
    meter('m-gpubusy', 0, '–', 'GPU: no graphics chip found');
  }
  drawActive(s);
}

/** "Models active": a line for the chat models (LLM; two or more can be loaded, one runner each) and one for pictures. */
function drawActive(s) {
  const chip = (v, kind) => {
    // Short on the bar: no file tags (Q4_K_M, -it); the full name is in the tooltip.
    const name = (v.modelName ?? v.model ?? '').replace(/\s*[(+].*$/, '').replace(/[-_.](?:i?q\d[\w]*|f16|bf16|gguf)$/i, '').replace(/-(?:it|instruct|chat)$/i, '');
    const on = v.state === 'connected';
    // What the model takes now (RAM, plus a graphics card's own memory once it holds more than a trace), not its file
    // size: the chat pane's list shows the file, so the tooltip says why the two differ. A chip with no memory of its own
    // works from RAM the model already counts (memory.borrowed): it is said, never added again.
    const card = v.memory && v.memory.gpu > 64 * 2 ** 20 ? v.memory.gpu : 0;
    const lent = v.memory && v.memory.borrowed > 64 * 2 ** 20 ? v.memory.borrowed : 0;
    const size = on && v.memory ? `${gb(v.memory.ram + card)} in use` : '';
    const file = (kind === 'Chat model' ? app.models?.chat : app.models?.image)?.find(m => m.id === v.model)?.bytes;
    const why = size ? ` In memory now: ${gb(v.memory.ram + card)}${card ? ` (${gb(v.memory.ram)} RAM + ${gb(card)} on the graphics card)` : ''}.${lent ? ` ${gb(lent)} of the RAM is what the graphics chip works from: it has no memory of its own, so it borrows RAM.` : ''}${file ? ` The model file is ${gb(file)}: the rest is its working memory (room for what it reads).` : ''}` : '';
    const where = on ? (v.device === 'cpu' ? 'CPU' : v.device ? 'GPU' : '') : STATE_TEXT[v.state].toLowerCase();
    const full = `${kind}: ${v.modelName ?? ''}, ${STATE_TEXT[v.state].replace('…', '')}${v.device && on ? ` on the ${DEVICE_TEXT[v.device]}` : ''}${v.working ? ', working now' : ''}.${why}`;
    const drop = v.state === 'connected' || v.state === 'loading'
      ? el('button', { class: 'chip-drop', type: 'button', text: 'Drop', 'data-model': v.model ?? '', 'data-working': v.working ? '1' : '', 'data-name': name, title: `Drop ${name}: unload it and free its memory`, 'aria-label': `Drop ${name}` })
      : null;
    return el('span', { class: `chip state-${v.state}${v.working ? ' working' : ''}`, title: full },
      el('span', { class: 'dot', 'aria-hidden': 'true' }), el('span', { class: 'chip-model', text: name }), size || !on ? el('span', { class: 'chip-size', text: ` · ${on ? size : where}` }) : null, drop);
  };
  const live = v => v && v.state !== 'disconnected';
  const llm = [s.panes.chat, ...(s.panes.chatAlso ?? [])].filter(live);
  const pics = [s.panes.image].filter(live);
  const rows = [];
  if (llm.length) rows.push(el('div', { class: 'active-row' }, el('span', { class: 'active-k', text: 'LLM' }), ...llm.map(v => chip(v, 'Chat model'))));
  if (pics.length) rows.push(el('div', { class: 'active-row' }, el('span', { class: 'active-k', text: 'Images' }), ...pics.map(v => chip(v, 'Picture model'))));
  if (!rows.length) rows.push(el('span', { class: 'hint', text: 'No models loaded' }));
  const box = $('#loaded');
  // Asked every second: drawn again only when it changes, so a press on Drop is never lost to a redraw.
  if (box.innerHTML !== rows.map(r => r.outerHTML).join('')) box.replaceChildren(...rows);
  box.dataset.count = String(llm.length + pics.length);
}

// Drop: one model, from the top bar. In use right now, it asks first.
$('#loaded').addEventListener('click', async e => {
  const b = e.target.closest?.('.chip-drop');
  if (!b) return;
  const { name, model } = b.dataset;
  if (b.dataset.working && !(await askHere(barBox(), `Are you sure? ${name} is in progress right now. Dropping it mid-task could cause issues.`, `Drop ${name}`, 'Keep it loaded'))) return;
  b.disabled = true;
  try {
    await api(`/api/models/${encodeURIComponent(model)}/unload`, {});
  } catch (err) {
    sayHere(barBox(), `${name} was not dropped: ${err.message}`);
  }
  poll();
});

// ---- Panes: Connect / Disconnect ----

function paneEls(name) {
  const root = $(`#pane-${name}`);
  return {
    root,
    state: $('.state', root),
    stateText: $('.state-text', root),
    model: $('.model', root),
    device: $('.device', root),
    connect: $('.connect', root),
    threads: $('.threads', root),
    threadsHint: $('.threads-hint', root),
    idle: $('.idle', root),
    fitNote: $('.fit-note', root),
    progress: $('.progress', root),
    info: $('.conn-info', root),
    fault: $('.fault', root),
  };
}
const panes = { chat: paneEls('chat'), image: paneEls('image') };

function showFault(box, text, detail) {
  if (!text) {
    box.hidden = true;
    box.dataset.sig = '';
    box.replaceChildren();
    return;
  }
  // Asked every second: drawn again only when it changes, so an opened "What does this mean?" stays open.
  const sig = `${text}|${detail ?? ''}`;
  if (!box.hidden && box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.hidden = false;
  box.replaceChildren(el('span', { text }));
  if (detail) box.append(el('details', {}, el('summary', { text: 'What does this mean?' }), el('pre', { text: detail })));
}

function drawPane(name, v) {
  const p = panes[name];
  const was = p.state.dataset.state;
  p.state.dataset.state = v.state;
  p.stateText.textContent = STATE_TEXT[v.state];
  if (was !== v.state) drawFit(name);
  const on = v.state === 'connected' || v.state === 'loading';
  p.connect.textContent = v.state === 'loading' ? 'Cancel loading' : on ? 'Disconnect' : v.state === 'unloading' ? 'Unloading…' : 'Connect';
  p.connect.classList.toggle('primary', !on);
  // Pressable with no model picked: the press says why (a greyed button explains nothing in Firefox or on a phone).
  p.connect.disabled = v.state === 'unloading';
  // While loaded, the list shows what is loaded (it may have been loaded by another program through the API).
  if (on && v.model && p.model.value !== v.model && [...p.model.options].some(o => o.value === v.model)) p.model.value = v.model;
  p.model.disabled = on || v.state === 'unloading';
  p.device.disabled = on || v.state === 'unloading';

  // Loading bar: the runner's own stage words, and a time estimate (the last load of this model, or its size).
  if (v.state === 'loading' || v.state === 'unloading') {
    p.progress.hidden = false;
    const spent = v.loadStartedAt ? (Date.now() - v.loadStartedAt) / 1000 : 0;
    const frac = v.state === 'unloading' ? 0.5 : Math.min(0.95, spent / Math.max(1, v.expectedSeconds));
    $('.p-fill', p.progress).style.width = `${Math.round(frac * 100)}%`;
    const left = Math.max(0, Math.round(v.expectedSeconds - spent));
    $('.p-text', p.progress).textContent = v.state === 'unloading' ? (v.stage ?? 'Unloading') : `${v.stage ?? 'Loading'}${v.device ? ` on ${DEVICE_TEXT[v.device]}` : ''} · ${Math.round(spent)} s${left > 0 ? ` (about ${left} s more, estimated)` : ' (taking longer than last time)'}`;
  } else {
    p.progress.hidden = true;
  }

  p.info.replaceChildren();
  if (v.state === 'connected') {
    const mem = v.memory ? `Using ${gb(v.memory.ram)} of RAM${v.memory.borrowed > 64 * 2 ** 20 ? ` (${gb(v.memory.borrowed)} of it for the graphics chip)` : ''}${v.memory.gpu > 64 * 2 ** 20 ? ` and ${gb(v.memory.gpu)} on the graphics card` : ''}` : 'Measuring memory…';
    const line = `${mem} · on the ${DEVICE_TEXT[v.device] ?? v.device} · ${v.threads ? `${v.threads} CPU cores` : 'all CPU cores'} · loaded in ${v.loadSeconds} s`;
    // The chat pane keeps its head short: the memory line sits in the Connected chip's tooltip.
    if (name === 'chat') p.state.title = line;
    else p.info.append(el('span', { class: 'ok', text: line }));
    if (v.note) p.info.append(el('div', { text: v.note }));
  } else if (name === 'chat') {
    p.state.removeAttribute('title');
  }
  // After Disconnect nothing is said, unless the model's program did not end (its memory may still be in use).
  if (v.state === 'disconnected' && v.lastUnload && !v.lastUnload.gone) p.info.append(el('span', { text: 'The model may still be running after Disconnect: its memory may not be free yet.' }));
  showFault(p.fault, v.state === 'failed' ? v.error : null, v.detail);
  if (v.state === 'failed' && v.note) p.fault.append(el('div', { text: v.note }));
}

function threadsHint(name) {
  const h = app.status?.hardware.cpu;
  if (!h) return;
  const p = panes[name];
  p.threads.max = String(h.threads);
  p.threadsHint.textContent = `0 = all ${h.cores} cores (${h.threads} threads). Fewer keeps the PC responsive.`;
}

function drawFit(name) {
  const p = panes[name];
  const list = app.models?.[name] ?? [];
  const m = list.find(x => x.id === p.model.value);
  p.fitNote.hidden = true;
  p.fitNote.className = 'fit-note hint';
  // Once it is loaded the question "will it fit?" is answered: the line only takes room.
  const st = p.state.dataset.state;
  if (!m || !m.fit || st === 'connected' || st === 'loading') return;
  const f = m.fit;
  const other = name === 'chat' ? 'image' : 'chat';
  if (f.level === 'ok' && !f.otherOn) return;
  p.fitNote.hidden = false;
  p.fitNote.classList.add(f.level);
  const otherText = f.otherOn ? ` Disconnecting the ${other} pane frees more.` : '';
  p.fitNote.textContent = f.level === 'ok'
    ? `Fits: about ${gb(f.need)} needed, ${gb(f.free)} free.${otherText}`
    : f.level === 'tight'
      ? `Tight: about ${gb(f.need)} needed, ${gb(f.free)} free. May load slowly or fail.${otherText}`
      : `Too big right now: about ${gb(f.need)} needed, ${gb(f.free)} free.${otherText}`;
}

async function loadModels() {
  app.models = await api('/api/models');
  for (const name of ['chat', 'image']) {
    const p = panes[name];
    const list = app.models[name];
    const keep = p.model.value || app.models.settings[name].model;
    p.model.replaceChildren();
    if (!list.length) p.model.append(el('option', { value: '', text: name === 'chat' ? 'No chat models found' : 'No image models installed' }));
    // A hidden model is offered once "Show hidden" is ticked (beside the list), or while it is the one picked.
    const tick = hiddenTick(`show-hidden-${name}`, list.some(m => m.hidden));
    if (!tick.isConnected) (p.model.closest('label') ?? p.model).after(tick);
    for (const m of visibleModels(list, keep)) {
      const extra = m.installed === false ? ' (not downloaded)' : m.fit?.level === 'no' ? ' (too big now)' : m.fit?.level === 'tight' ? ' (tight)' : '';
      p.model.append(el('option', { value: m.id, text: `${m.name} · ${gb(m.bytes)}${extra}`, disabled: m.installed === false }));
    }
    if (keep && list.some(m => m.id === keep && m.installed !== false)) p.model.value = keep;
    const st = app.models.settings[name];
    p.device.value = st.asked;
    p.threads.value = String(st.threads);
    p.idle.value = String(st.idleMinutes);
    drawFit(name);
  }
  drawContext();
  const who = $('#who');
  const tone = $('#tone');
  // How the host talks: only the host's own ways (people are picked in the left panel, not here), and only in a chat
  // with the host.
  const styles = app.models.who.filter(w => !w.staff);
  who.replaceChildren(...styles.map(w => el('option', { value: w.id, text: w.name })));
  tone.replaceChildren(...app.models.tones.map(t => el('option', { value: t.id, text: t.name })));
  const hostChat = styles.some(w => w.id === app.models.settings.who);
  $('#who-row').hidden = !hostChat;
  $('#who-hint').hidden = !hostChat;
  who.value = hostChat ? app.models.settings.who : styles[0]?.id ?? '';
  // The tone here is the host's; a hire's is in their profile.
  const hireChat = String(app.models.settings.who ?? '').startsWith('staff:');
  $('#tone-row').hidden = hireChat;
  $('#tone-hint').hidden = hireChat;
  tone.value = app.models.settings.tone;
  $('#who-hint').textContent = app.models.who.find(w => w.id === who.value)?.hint ?? '';
  app.onModels?.();
}
// ---- Context size per chat model (used from its next Connect) ----

const tokensText = n => (n >= 1024 ? `${Math.round(n / 1024)}k` : String(n));
/** How long reading `n` word-pieces takes at `perSecond`, in plain words (PLAN F10 G1b). */
function readTime(n, perSecond) {
  const s = n / perSecond;
  if (s < 50) return 'under a minute';
  if (s < 5400) return `about ${Math.max(1, Math.round(s / 60))} min`;
  return `about ${Math.round(s / 360) / 10} hours`;
}

/** The context controls for the model picked in the chat pane, with what each size costs in memory. */
function drawContext() {
  const m = (app.models?.chat ?? []).find(x => x.id === panes.chat.model.value);
  const size = $('#ctx-size');
  const cache = $('#ctx-cache');
  const hint = $('#ctx-hint');
  const off = !m;
  size.disabled = cache.disabled = off;
  if (!m) {
    size.replaceChildren();
    hint.textContent = '';
    return;
  }
  const sizes = (app.models.contexts ?? [8192]).filter(n => !m.trained || n <= Math.max(8192, m.trained) || n === m.run.ctx);
  const ps = m.reading?.perSecond;
  size.replaceChildren(...sizes.map(n => el('option', { value: String(n), text: `${tokensText(n)} tokens${n === 8192 ? ' (default)' : ''}${m.trained && n > m.trained ? ' (over its training)' : ''}${ps ? ` · ${readTime(n, ps)} to read` : ''}` })));
  size.value = String(m.run.ctx);
  cache.value = m.run.cache;
  // Where it runs (PLAN F8): only where it makes a difference, a card with memory of its own or a mixture-of-experts model.
  const place = $('#ctx-place');
  const ways = [['auto', 'Auto: fill the card, the rest in RAM'], ['card', 'Every layer on the graphics chip'], ...(m.moe ? [['ram', 'The experts (most of this model) in RAM, the rest on the card']] : [])];
  place.replaceChildren(...ways.map(([v, t]) => el('option', { value: v, text: t })));
  place.value = ways.some(([v]) => v === m.run.place) ? m.run.place : 'auto';
  $('#ctx-place-row').hidden = !(m.places?.length || m.moe);
  $('#ctx-try-row').hidden = !(m.places?.length > 1);
  drawTry();
  const bytes = m.cost?.[m.run.cache]?.[m.run.ctx];
  const total = bytes != null ? m.bytes + bytes : null;
  hint.textContent = [
    bytes != null ? `${gb(total)} in all (model ${gb(m.bytes)} + context ${gb(bytes)}).` : 'Context memory unknown for this file.',
    m.trained ? `Trained up to ${tokensText(m.trained)}.` : '',
    ps ? `Reads about ${Math.round(ps)} tokens a second here: a full ${tokensText(m.run.ctx)} takes ${readTime(m.run.ctx, ps)} before the first word.` : 'Reading speed: measured from its first answers.',
    ps && m.run.ctx / ps > 600 ? 'A smaller context answers sooner; the chat offers a handoff before it fills.' : '',
  ].filter(Boolean).join(' ');
  hint.title = 'A bigger context lets a job step read bigger files, but uses more memory and makes long prompts slower.';
}

async function saveContext() {
  const id = panes.chat.model.value;
  if (!id) return;
  try {
    await api('/api/settings', { pane: 'chat', runModel: id, run: { ctx: Number($('#ctx-size').value), cache: $('#ctx-cache').value, place: $('#ctx-place').value } });
    app.models = await api('/api/models');
    drawContext();
    drawFit('chat');
    gearSaved('chat', true);
  } catch (err) {
    gearSaid('chat', `Not saved: ${err.message}`);
  }
}

// ---- The gear says what it saved; a setting used when a model loads offers Reconnect while one is loaded ----
function gearSaid(name, text) {
  const box = panes[name].gearSaid;
  clearTimeout(box.timer);
  box.replaceChildren(text);
}
function gearSaved(name, onConnect) {
  const loaded = app.status?.panes[name]?.state === 'connected';
  gearSaid(name, onConnect && loaded ? 'Saved. The loaded model uses it from its next Connect: ' : 'Saved.');
  const box = panes[name].gearSaid;
  if (onConnect && loaded) box.append(el('button', { class: 'link', type: 'button', text: 'Reconnect now', onclick: () => reconnect(name) }));
  else box.timer = setTimeout(() => box.replaceChildren(), 5000);
}
app.gearSaved = gearSaved;
/**
 * Loads a model (Connect). On a node, when that would push out a model a linked PC is using, "Using this can impact
 * connected users" is asked first; Cancel leaves everything as it was.
 */
async function loadModel(id, body) {
  const url = `/api/models/${encodeURIComponent(id)}/load`;
  try {
    return await api(url, body);
  } catch (e) {
    if (!e.data?.impact) throw e;
    if (await app.agreeImpact(e.data.impact)) return api(url, { ...body, agree: true });
    throw new Error('Not loaded: left as it was, so the linked PC keeps its model.');
  }
}

/** Disconnect, then Connect the same model with the settings as they are now. */
async function reconnect(name) {
  const p = panes[name];
  const id = p.model.value;
  gearSaid(name, 'Reconnecting: unloading first…');
  try {
    await api(`/api/panes/${name}/unload`, {});
    for (let i = 0; i < 240 && app.status?.panes[name]?.state !== 'disconnected'; i++) {
      await new Promise(r => setTimeout(r, 500));
      await poll();
    }
    await loadModel(id, { device: p.device.value, threads: Number(p.threads.value) || 0 });
    gearSaid(name, 'Loading again with the new settings (the bar above shows how far).');
  } catch (err) {
    gearSaid(name, `Reconnect stopped: ${err.message}`);
  }
  poll();
}
for (const id of ['#ctx-size', '#ctx-cache', '#ctx-place']) $(id).addEventListener('change', saveContext);

// ---- Try each way (PLAN F8): load the model each way, measure, keep the fastest ----
function drawTry() {
  const line = $('#ctx-try-line');
  const btn = $('#ctx-try');
  const j = app.tryNow;
  const mine = j && j.id === panes.chat.model.value;
  btn.textContent = j?.state === 'running' ? 'Stop trying' : 'Try each way';
  if (!mine) {
    line.textContent = j?.state === 'running' ? `Trying ${j.name} now.` : 'Loads it each way, asks for about 80 words each time, and keeps the fastest. A big model takes minutes per way.';
    return;
  }
  const rows = j.rows.map(r => `${r.words}: ${r.perSecond ? `${r.perSecond} words a second` : 'no figure'}${r.note ? ` (${r.note})` : ''}.`);
  const end = j.state === 'done' ? (j.best ? `Kept: ${j.rows.find(r => r.place === j.best).words}${j.best === j.was ? ' (as before: the others were not clearly faster)' : ' (the fastest)'}.` : 'Nothing could be measured; the way chosen before is kept.') : j.state === 'stopped' ? 'Stopped; the way chosen before is kept.' : j.now;
  line.textContent = [...rows, end].filter(Boolean).join(' ');
}
// One chain of asks at a time: each press of Try or Stop starts it again instead of adding another.
let tryTimer = null;
function pollTryIn(ms) {
  clearTimeout(tryTimer);
  tryTimer = setTimeout(pollTry, ms);
}
async function pollTry() {
  tryTimer = null;
  try {
    app.tryNow = (await api('/api/place/try')).job;
  } catch {
    return;
  }
  drawTry();
  if (app.tryNow?.state === 'running') pollTryIn(2000);
  else if (app.tryNow) {
    app.models = await api('/api/models').catch(() => app.models);
    drawContext();
  }
}
$('#ctx-try').addEventListener('click', async () => {
  try {
    if (app.tryNow?.state === 'running') await api('/api/place/try', { stop: true });
    else {
      app.tryNow = (await api('/api/place/try', { id: panes.chat.model.value })).job;
      drawTry();
    }
    pollTryIn(500);
  } catch (err) {
    $('#ctx-try-line').textContent = err.message;
  }
});
pollTry();
panes.chat.model.addEventListener('change', drawContext);

$('#who').addEventListener('change', e => {
  $('#who-hint').textContent = app.models.who.find(w => w.id === e.target.value)?.hint ?? '';
  app.talkTo(e.target.value).then(r => {
    gearSaved('chat', false);
    showChat(r);
  }).catch(err => gearSaid('chat', `Not saved: ${err.message}`));
});
$('#tone').addEventListener('change', e => api('/api/settings', { tone: e.target.value }).then(() => {
  app.models.settings.tone = e.target.value;
  gearSaved('chat', false);
}).catch(err => gearSaid('chat', `Not saved: ${err.message}`)));

for (const name of ['chat', 'image']) {
  const p = panes[name];
  // Under Connect: a question it asks, and what a press found (the fault box below is the runner's own, redrawn each second).
  p.ask = el('div', { hidden: true });
  p.said = el('div', { class: 'fault', role: 'alert', hidden: true });
  // Under the Connect row; the chat's row is in its head, so there they open the pane's body.
  const row = $('.pane-body > .connect-row', p.root);
  if (row) row.after(p.ask, p.said);
  else $('.pane-body', p.root).prepend(p.ask, p.said);
  p.connect.addEventListener('click', async () => {
    const v = app.status?.panes[name];
    showFault(p.fault, null);
    showFault(p.said, null);
    try {
      if (v && (v.state === 'connected' || v.state === 'loading')) {
        p.connect.disabled = true;
        await api(`/api/panes/${name}/unload`, {});
      } else {
        if (!p.model.value) {
          const none = ![...p.model.options].some(o => o.value && !o.disabled);
          showFault(p.said, none
            ? `No ${name === 'chat' ? 'chat' : 'picture'} model is on this PC yet, so there is nothing to connect. Get one under Settings, Set up, Add a model; it shows in the list beside Connect once it is downloaded.`
            : 'Pick a model in the list beside Connect first, then press Connect.');
          return;
        }
        const m = (app.models?.[name] ?? []).find(x => x.id === p.model.value);
        if (m?.fit?.level === 'no') {
          const other = name === 'chat' ? 'picture' : 'chat';
          const ask = `${m.name} needs about ${gb(m.fit.need)} and only ${gb(m.fit.free)} is free${m.fit.otherOn ? `. Disconnecting the ${other} model would free its memory` : ''}. Loading it anyway may make the PC very slow, or fail.`;
          if (!(await askHere(p.ask, ask, 'Connect anyway', 'Not now', false))) return;
        }
        // In the host's chat, the model connected there becomes the host's own (chats.js).
        if (name === 'chat') await app.chatModelPicked?.(p.model.value);
        await loadModel(p.model.value, { device: p.device.value, threads: Number(p.threads.value) || 0 });
      }
    } catch (error) {
      showFault(p.said, error.message);
    }
    await poll();
  });
  p.model.addEventListener('change', async () => {
    showFault(p.said, null);
    drawFit(name);
    if (name === 'chat') await app.chatModelPicked?.(p.model.value);
    await api('/api/settings', { pane: name, model: p.model.value }).catch(() => undefined);
    poll();
  });
  p.gearSaid = el('p', { class: 'hint gear-said', role: 'status' });
  $('.settings-box', p.root).append(p.gearSaid);
  // The gear's box opens to the left of the gear, or to the right when that would put it past the pane's left edge
  // (where the gear sits near the pane's left edge, its box went under the left panel).
  const gear = $('.pane-settings', p.root);
  gear.addEventListener('toggle', () => {
    if (!gear.open) return;
    const box = $('.settings-box', gear);
    box.classList.remove('opens-right');
    if (box.getBoundingClientRect().left < p.root.getBoundingClientRect().left + 4) box.classList.add('opens-right');
  });
  // It closes on a press anywhere outside it, and on Escape, as a menu does (before, only the gear itself closed it).
  document.addEventListener('pointerdown', e => {
    if (gear.open && !gear.contains(e.target)) gear.open = false;
  });
  gear.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !gear.open) return;
    gear.open = false;
    $('summary', gear).focus();
  });
  const save = (change, onConnect) => api('/api/settings', { pane: name, ...change }).then(() => gearSaved(name, onConnect), err => gearSaid(name, `Not saved: ${err.message}`));
  p.device.addEventListener('change', () => save({ asked: p.device.value }, true));
  p.threads.addEventListener('change', () => save({ threads: Number(p.threads.value) || 0 }, true));
  p.idle.addEventListener('change', () => save({ idleMinutes: Number(p.idle.value) || 0 }, false));
  // One pane at a time (a chat, or an artist's pictures): nothing sits beside it, so nothing folds. Older code still
  // asks a pane to open; a pane left folded by an older version opens again.
  p.root.classList.remove('folded');
  store(`fold-${name}`, '0');
  p.fold = () => undefined;
}

// ---- Polling ----

let lastStates = {};
let polling = false;
/** Set while the server is not answering: when it answers again (it was restarted), the open chat is fetched again. */
let serverLost = false;
async function poll() {
  // A slow answer (while a model loads) must not start a second one on top.
  if (polling) return;
  polling = true;
  try {
    const s = await api('/api/status');
    app.status = s;
    if (serverLost) {
      serverLost = false;
      app.chatAgain().then(showChat).catch(() => undefined);
      app.loadChats?.();
    }
    drawBar(s);
    for (const name of ['chat', 'image']) {
      drawPane(name, s.panes[name]);
      threadsHint(name);
    }
    // A pane that just connected or disconnected changes what fits: refresh the lists.
    const states = { chat: s.panes.chat.state, image: s.panes.image.state };
    if (states.chat !== lastStates.chat || states.image !== lastStates.image) {
      lastStates = states;
      await loadModels().catch(() => undefined);
    }
    // Each part drawn from the status on its own: one that fails is written to the console, and is not taken for the
    // server being lost (that fetched the open chat again every second: it jumped to the end while being scrolled).
    for (const f of app.onStatus) {
      try {
        f(s);
      } catch (e) {
        console.error('A part of the page could not follow the status:', e);
      }
    }
  } catch {
    serverLost = true;
    $('#loaded').replaceChildren(el('span', { class: 'chip', text: 'TOMLIN is not answering: is its window still open?' }));
  } finally {
    polling = false;
  }
}
setInterval(poll, 1000);
poll();

// ---- Chat ----

/** Light formatting for answers: **bold**, *italic*, `code`, code blocks, headings and list lines. Built as elements:
 * nothing the model writes is ever read as HTML. */
function formatted(text) {
  const frag = document.createDocumentFragment();
  const inline = (line, into) => {
    let at = 0;
    for (const m of line.matchAll(/(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`)/g)) {
      into.append(line.slice(at, m.index));
      const t = m[0];
      into.append(t.startsWith('**') ? el('strong', { text: t.slice(2, -2) }) : t.startsWith('`') ? el('code', { text: t.slice(1, -1) }) : el('em', { text: t.slice(1, -1) }));
      at = m.index + t.length;
    }
    into.append(line.slice(at));
  };
  // Text, then each code block as [its language, its code, the text after]: a finished block (one whose closing fence
  // has come) gets a Save button, which guesses the file name from the line above it and the language.
  const bits = text.split(/```([^\n]*)\n?/);
  const drawCode = (code, lang, before, done) => {
    const pre = el('pre', { class: 'code', text: code.replace(/\n$/, '') });
    frag.append(done && code.trim() ? el('div', { class: 'code-wrap' }, pre, codeSaveButton(code.replace(/\n$/, ''), lang, before)) : pre);
  };
  bits.forEach((part, i) => {
    if (i % 3 === 1) return;
    if (i % 3 === 2) return void drawCode(part, bits[i - 1], bits[i - 2], i + 1 < bits.length);
    let list = null;
    for (const line of part.split('\n')) {
      const item = /^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/.exec(line);
      if (item) {
        const tag = item[1] ? 'OL' : 'UL';
        if (!list || list.tagName !== tag) {
          list = el(tag.toLowerCase());
          if (item[1] && item[1] !== '1') list.start = Number(item[1]);
          frag.append(list);
        }
        const li = el('li');
        inline(item[2], li);
        list.append(li);
        continue;
      }
      list = null;
      const heading = /^#{1,4}\s+(.*)$/.exec(line);
      const span = el(heading ? 'strong' : 'span', { class: heading ? 'md-h' : 'md-line' });
      inline(heading ? heading[1] : line, span);
      frag.append(span);
    }
  });
  return frag;
}

// ---- Save a code block from an answer to the drive: into the Files folder, under a name guessed from the answer ----

/** A code block's language as a file ending ("python" -> py). */
const LANG_EXT = { js: 'js', javascript: 'js', node: 'js', mjs: 'mjs', jsx: 'jsx', ts: 'ts', typescript: 'ts', tsx: 'tsx', py: 'py', python: 'py', html: 'html', htm: 'html', css: 'css', scss: 'scss', json: 'json', php: 'php', sql: 'sql', md: 'md', markdown: 'md', sh: 'sh', bash: 'sh', shell: 'sh', ps1: 'ps1', powershell: 'ps1', java: 'java', c: 'c', h: 'h', cpp: 'cpp', 'c++': 'cpp', cs: 'cs', csharp: 'cs', 'c#': 'cs', go: 'go', golang: 'go', rust: 'rs', rs: 'rs', ruby: 'rb', rb: 'rb', yaml: 'yml', yml: 'yml', xml: 'xml', toml: 'toml', kotlin: 'kt', kt: 'kt', swift: 'swift', vue: 'vue', ini: 'ini', csv: 'csv', txt: 'txt', text: 'txt' };
const CODE_EXTS = new Set([...Object.values(LANG_EXT), 'htm', 'yaml']);
/**
 * The name for a code block: a file name on the line just above it ("index.html", **src/app.js**, `main.py`; the hires
 * are asked to put one there), else "code" with the language's ending.
 */
function codeName(before, lang) {
  const line = String(before ?? '').trimEnd().split('\n').at(-1) ?? '';
  const found = [...line.matchAll(/[A-Za-z0-9_][\w./-]*\.([A-Za-z0-9]{1,5})\b/g)].filter(m => CODE_EXTS.has(m[1].toLowerCase())).map(m => m[0]).at(-1);
  if (found) return found.replace(/^\.?\/+/, '');
  return `code.${LANG_EXT[String(lang ?? '').trim().toLowerCase()] ?? 'txt'}`;
}
/** A plain save icon (an arrow into a tray), drawn with lines like the copy icon. */
function saveIcon(size = 14) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: String(size), height: String(size), fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) s.setAttribute(k, v);
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'M12 3v12M7 10l5 5 5-5M5 21h14');
  s.append(p);
  return s;
}
function codeSaveButton(code, lang, before) {
  const b = el('button', { class: 'code-save', type: 'button', title: 'Save this code to a file on your drive', 'aria-label': 'Save this code to a file on your drive' });
  b.append(saveIcon(), ' Save');
  // A chat in Default saves into its own chats folder; one in a project into the project (a writer's work, stamped,
  // into its specialists folder).
  b.addEventListener('click', () => {
    const to = app.chatSaveTo?.() ?? null;
    const name = to?.stamped ? `${timeStamp()} ${codeName(before, lang)}` : codeName(before, lang);
    openCodeSave(code, `${to?.dir ? `${to.dir}/` : ''}${name}`);
  });
  return b;
}
/** The date and time as files are named with it, "2026-10-07-1530" (src/folders.ts stamp). */
function timeStamp(now = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}
const codeDlg = $('#code-save');
const codeSaving = { code: '', files: new Set(), folder: '' };
function codeSaveFault(text) {
  $('#code-save-fault').textContent = text ?? '';
  $('#code-save-fault').hidden = !text;
}
/** The button says what will happen: Save a new file, or Replace one that is there (the old one kept as .bak). */
function codeSaveLabel() {
  const name = $('#code-save-name').value.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  const there = codeSaving.files.has(name);
  $('#code-save-go').textContent = there ? `Replace ${name.split('/').pop()}` : 'Save';
  $('#code-save-where').textContent = `${there ? `${name} is already there: it is kept as ${name}.bak, then replaced. ` : ''}It goes in the Files folder${codeSaving.folder ? `, ${codeSaving.folder}` : ''}. To use another folder: Settings, Set up, Files and blog writer.`;
}
async function openCodeSave(code, name) {
  codeSaving.code = code;
  codeSaveFault(null);
  $('#code-save-name').value = name;
  try {
    const r = await api('/api/files');
    codeSaving.files = new Set(r.files.map(f => f.path));
    codeSaving.folder = r.folder;
  } catch {
    codeSaving.files = new Set();
    codeSaving.folder = '';
  }
  codeSaveLabel();
  if (!codeDlg.open) codeDlg.showModal();
  // The name without its ending is selected, ready to type over.
  const box = $('#code-save-name');
  box.focus();
  box.setSelectionRange(name.lastIndexOf('/') + 1, name.includes('.') ? name.lastIndexOf('.') : name.length);
}
$('#code-save-name').addEventListener('input', codeSaveLabel);
$('#code-save-cancel').addEventListener('click', () => codeDlg.close());
$('#code-save-form').addEventListener('submit', async e => {
  e.preventDefault();
  codeSaveFault(null);
  try {
    const r = await api('/api/files/save', { path: $('#code-save-name').value.trim(), text: codeSaving.code, create: true });
    codeDlg.close();
    app.chatNote(`Saved ${r.path}${codeSaving.folder ? ` in ${codeSaving.folder}` : ''}.${r.created ? '' : ` The earlier version is kept as ${r.path}.bak.`} Open it under Settings, Set up, Files and blog writer.`);
  } catch (err) {
    codeSaveFault(err.message);
  }
});

const log = $('#chat-log');
const input = $('#chat-input');
const sendBtn = $('#chat-send');
const stopBtn = $('#chat-stop');

// The message box's height: drag the grip on its top edge (or the corner) to make it taller or shorter; a double-click
// on the grip puts it back. Kept in this browser only.
{
  const grip = $('#chat-grip');
  const KEY = 'chat-box-height';
  const maxH = () => Math.max(120, Math.round((input.closest('.pane-body')?.clientHeight ?? 600) * 0.7));
  const setH = h => {
    input.style.height = `${Math.min(maxH(), Math.max(52, Math.round(h)))}px`;
  };
  const save = () => {
    try { localStorage.setItem(KEY, String(input.offsetHeight)); } catch { /* private window: not kept */ }
  };
  try {
    const kept = Number(localStorage.getItem(KEY));
    if (kept > 52) setH(kept);
  } catch { /* nothing kept */ }
  let start = null;
  grip?.addEventListener('pointerdown', e => {
    start = { y: e.clientY, h: input.offsetHeight };
    grip.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  grip?.addEventListener('pointermove', e => {
    if (start) setH(start.h + (start.y - e.clientY));
  });
  const end = () => {
    if (!start) return;
    start = null;
    save();
  };
  grip?.addEventListener('pointerup', end);
  grip?.addEventListener('pointercancel', end);
  grip?.addEventListener('dblclick', () => {
    input.style.height = '';
    try { localStorage.removeItem(KEY); } catch { /* nothing kept */ }
  });
  grip?.addEventListener('keydown', e => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    setH(input.offsetHeight + (e.key === 'ArrowUp' ? 24 : -24));
    save();
  });
  // The corner (the browser's own resize handle) is kept too.
  input.addEventListener('pointerup', () => { if (input.style.height) save(); });
}

/** This chat's replies' speeds, for the average in the chat's head. */
let chatSpeeds = [];
function drawAverage() {
  const box = $('#chat-speed');
  if (!box) return;
  box.hidden = !chatSpeeds.length;
  if (!chatSpeeds.length) return;
  const avg = chatSpeeds.reduce((a, b) => a + b, 0) / chatSpeeds.length;
  const n = chatSpeeds.length;
  box.textContent = `avg ${avg.toFixed(1)} tok/s`;
  box.title = `This chat's replies average ${avg.toFixed(1)} tokens a second (${n} repl${n === 1 ? 'y' : 'ies'} timed).`;
}

// ---- "Enable live stats" (the chat's gear): the figures under each answer. Kept in this browser; off until ticked ----
const LIVE_STATS_KEY = 'tomlin-live-stats';
function liveStatsOn() {
  try {
    return localStorage.getItem(LIVE_STATS_KEY) === 'on';
  } catch {
    return false;
  }
}
function drawLiveStats() {
  document.documentElement.toggleAttribute('data-live-stats', liveStatsOn());
  $('#live-stats').checked = liveStatsOn();
}
$('#live-stats').addEventListener('change', e => {
  try {
    if (e.target.checked) localStorage.setItem(LIVE_STATS_KEY, 'on');
    else localStorage.removeItem(LIVE_STATS_KEY);
  } catch {}
  drawLiveStats();
});
// Another tab ticked or unticked it.
window.addEventListener('storage', e => {
  if (e.key === LIVE_STATS_KEY || e.key === null) drawLiveStats();
});
drawLiveStats();

/**
 * The line under an answer: its figures (how long, the PC and model, tokens a second) show only with live stats on
 * (style.css); what it read and any note show either way.
 */
function statsLine(figures, rest) {
  figures = figures.filter(Boolean);
  rest = rest.filter(Boolean);
  if (!figures.length && !rest.length) return null;
  return el('span', { class: `speed${rest.length ? '' : ' stats-only'}` },
    figures.length ? el('span', { class: 'live-stats', text: `${figures.join(' · ')}${rest.length ? ' · ' : ''}` }) : null,
    rest.length ? rest.join(' · ') : null);
}

function speedLine(m) {
  return statsLine([m.ran, m.perSecond ? `${m.perSecond.toFixed(1)} tokens a second` : ''], [m.sources ? `Read: ${m.sources}` : '', m.note ?? '']);
}

/** "Sent from …" on a message that came with Send to…, "Sent to …" under an answer that was handed on (sendto.js). */
function sentLine(l) {
  const text = [l.from ? `Sent from ${l.from}` : '', l.sent?.length ? `Sent to ${l.sent.join(', ')}` : ''].filter(Boolean).join(' · ');
  return text ? el('span', { class: 'sent-line', text }) : null;
}
// ---- Copy: a sent message's words onto the clipboard from its top right corner (the snippet library uses it too) ----

/** A plain copy icon (two sheets), or a tick once copied. Drawn with lines: no icon set is shipped for it. */
function copyIcon(done = false) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) s.setAttribute(k, v);
  const shapes = done ? [['path', { d: 'M5 12.5l4.5 4.5L19 7.5' }]] : [['rect', { x: '8', y: '8', width: '12', height: '13', rx: '2' }], ['path', { d: 'M16 8V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2' }]];
  for (const [tag, attrs] of shapes) {
    const x = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) x.setAttribute(k, v);
    s.append(x);
  }
  return s;
}
app.copyIcon = copyIcon;

/** A small line icon (16 px, drawn in the text colour) from SVG path data: Pin and Send to under a message. */
app.lineIcon = (...paths) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) s.setAttribute(k, v);
  for (const d of paths) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    s.append(p);
  }
  return s;
};
/** A pushpin, and a paper plane. */
app.PIN_ICON = ['M9 4h6', 'M10 4v5l-3 4h10l-3-4V4', 'M12 13v7'];
app.SEND_ICON = ['M21 3 10 14', 'M21 3l-7 18-4-7-7-4 18-7Z'];

/** True once the words are on the clipboard. A browser that refuses the clipboard to a page gets the older way. */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const box = el('textarea', { 'aria-hidden': 'true', tabindex: '-1' });
    // Set through .style: the page's security policy refuses a style attribute.
    Object.assign(box.style, { position: 'fixed', top: '0', left: '0', width: '1px', height: '1px', opacity: '0' });
    box.value = text;
    // Inside an open window (Jobs, Start project) the page behind it takes no selection: the box goes in the window.
    (document.querySelector('dialog[open]') ?? document.body).append(box);
    box.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    box.remove();
    return ok;
  }
}
app.copyText = copyText;

/** The copy button: the icon turns to a tick for two seconds, or says how to copy by hand if the browser refused. */
function copyButton(text, label = 'Copy this message', cls = 'msg-copy') {
  const b = el('button', { class: cls, type: 'button', title: label, 'aria-label': label }, copyIcon());
  let timer = 0;
  b.addEventListener('click', async () => {
    const ok = await copyText(text);
    const said = ok ? 'Copied' : 'Could not copy here: select the words and press Ctrl+C';
    b.replaceChildren(copyIcon(ok));
    b.title = said;
    b.setAttribute('aria-label', said);
    b.classList.toggle('copied', ok);
    clearTimeout(timer);
    timer = setTimeout(() => {
      b.replaceChildren(copyIcon());
      b.title = label;
      b.setAttribute('aria-label', label);
      b.classList.remove('copied');
    }, ok ? 2000 : 5000);
  });
  return b;
}
app.copyButton = copyButton;

/** The copy icon under a reply, beside Pin and Send to: the whole reply as it was written (the tick shows it copied). */
function replyCopy(text) {
  return text?.trim() ? copyButton(text, 'Copy this reply', 'link pin reply-copy icon-act') : null;
}

/** While the reply is coming: "<name> is writing" with three moving dots, clear on both light and dark. */
function typingNote(text = '') {
  const name = app.chatPerson?.name;
  return el('span', { class: 'typing', role: 'status' },
    el('span', { class: 'typing-dots', 'aria-hidden': 'true' }, el('i'), el('i'), el('i')),
    el('span', { text: text || (name ? `${name} is writing a reply` : 'Writing a reply') }));
}

// ---- The whole chat: Save (a text file) and Copy, at the end of the chat's top row ----

/** The open chat as plain text: its name and who it is with, then each message with who wrote it and when. */
function chatText(r, saved) {
  const name = app.chatPerson?.name ?? 'They';
  const when = at => (at ? new Date(at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
  const byApp = l => l.ran === 'written by the app, no model';
  const head = [r.chat?.title || 'Chat', `${$('#chat-with').textContent}${$('#chat-pc').textContent ? ` on ${$('#chat-pc').textContent}` : ''}`, saved ? `Saved ${when(new Date().toISOString())}` : ''].filter(Boolean);
  const opening = r.chat?.opening ? [`This chat carries on from an earlier one. The handoff it started with:\n${r.chat.opening}`] : [];
  const body = r.lines.filter(l => l.content || l.picture).map(l => {
    const who = l.role === 'user' ? 'You' : byApp(l) ? 'TOMLIN' : name;
    const meta = [who, when(l.at), l.role === 'assistant' && l.ran && !byApp(l) ? l.ran : ''].filter(Boolean).join(' · ');
    return `${meta}\n${l.picture ? `[A picture: ${l.picture.prompt || l.content}]` : l.content}`;
  });
  return `${[head.join('\n'), ...opening, ...body].join('\n\n')}\n`;
}
/**
 * The chat on screen as it is on disk now (an answer still being written is in it up to its last saved line), read by
 * its id: Copy and Save never take the chat another window opened last.
 */
async function wholeChat(saved) {
  const r = await api(chatUrl(app.chatId ?? ''));
  if (!r.lines.length) throw new Error('This chat has no messages yet.');
  return { text: chatText(r, saved), title: r.chat?.title || 'Chat' };
}
const chatCopy = $('#chat-copy');
chatCopy.append(copyIcon());
chatCopy.addEventListener('click', async () => {
  let ok = false;
  try {
    ok = await copyText((await wholeChat(false)).text);
  } catch (e) {
    return app.chatNote(e.message);
  }
  const said = ok ? 'Copied the whole chat' : 'Could not copy here: press Save instead';
  chatCopy.replaceChildren(copyIcon(ok));
  chatCopy.title = said;
  chatCopy.setAttribute('aria-label', said);
  setTimeout(() => {
    chatCopy.replaceChildren(copyIcon());
    chatCopy.title = 'Copy this whole chat';
    chatCopy.setAttribute('aria-label', 'Copy this whole chat');
  }, ok ? 2000 : 5000);
});
$('#chat-save').addEventListener('click', async () => {
  try {
    const { text, title } = await wholeChat(true);
    // "Plan the shop page 2026-10-05.txt": the chat's name (no characters Windows refuses in a file name) and today.
    const file = `${title.replace(/[\\/:*?"<>|\u0000-\u001f…]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Chat'} ${new Date().toISOString().slice(0, 10)}.txt`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = el('a', { href: url, download: file, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    app.chatNote(`Saved as "${file}" in your Downloads folder.`);
  } catch (e) {
    app.chatNote(e.message);
  }
});

/** A message he sent, with Copy in its top right corner. */
const userBubble = text => el('div', { class: 'msg user' }, copyButton(text), text);

/** Under a message: Pin (into the notebook) and, under an answer, Send to… (hand it on). Either may be missing. */
function msgActs(text, answer, who) {
  const bits = [answer ? replyCopy(text) : null, app.pinButton?.(text), answer ? app.sendButton?.(text, who) : null].filter(Boolean);
  return bits.length ? el('span', { class: 'msg-acts' }, ...bits) : null;
}

const pictureUrl = rel => `/api/images/file/${rel.split('/').map(encodeURIComponent).join('/')}`;
/** A picture drawn in the chat: shown in the bubble, a click opens it full size in a new tab. */
function pictureBubble(pic, caption) {
  const img = el('img', { src: pictureUrl(pic.output), alt: pic.alt ?? pic.prompt, loading: 'lazy' });
  const link = el('a', { href: pictureUrl(pic.output), target: '_blank', rel: 'noopener', title: 'Open full size' }, img);
  // A picture deleted in the Images pane leaves a plain note here, not a broken image.
  img.addEventListener('error', () => link.replaceWith(el('p', { class: 'hint', text: 'Picture deleted.' })), { once: true });
  return el('figure', { class: 'chat-pic' }, link, caption ? el('figcaption', { class: 'hint', text: caption }) : null);
}
const secs = n => (n < 60 ? `${Math.max(1, Math.round(n))} s` : `${Math.floor(n / 60)} min ${Math.round(n % 60)} s`);
function progressText(p) {
  if (p.state === 'queued') return `Waiting for the picture before it${p.queued ? ` (${p.queued} waiting)` : ''}…`;
  if (p.state === 'drawing') return `Drawing the picture · step ${p.step} of ${p.steps}${p.etaSeconds != null ? ` · about ${secs(p.etaSeconds)} left` : ''} · ${secs(p.elapsed)} so far`;
  if (p.state === 'decoding') return `Turning it into pixels · ${secs(p.elapsed)} so far`;
  if (p.state === 'finishing') return 'Saving the picture…';
  return `Starting the picture model · ${secs(p.elapsed)} so far`;
}

/**
 * How far the model has read the chat before its first word (a long chat takes minutes on a slow PC): "Reading the
 * chat: 45% (112,000 of 250,000 word-pieces; 3,000 already read) · about 12 min left". Null for a short read.
 */
function readingText(r) {
  const todo = r.total - r.cached;
  if (!(todo >= 4096)) return null;
  const done = Math.max(0, r.done - r.cached);
  const n = x => x.toLocaleString('en-GB');
  // The time left from the speed so far (reading slows a little as the chat gets longer, so it is "about").
  const left = done > 0 && r.ms > 0 ? (todo - done) / (done / r.ms) / 1000 : 0;
  const time = !left ? '' : left < 60 ? ' · under a minute left' : left < 5400 ? ` · about ${Math.round(left / 60)} min left` : ` · about ${(Math.round(left / 1800) / 2).toLocaleString('en-GB')} hours left`;
  return `Reading the chat: ${Math.min(99, Math.floor((done / todo) * 100))}% (${n(done)} of ${n(todo)} word-pieces${r.cached ? `; ${n(r.cached)} already read, not read again` : ''})${time}`;
}

/**
 * What the model worked out before its answer (Think), folded above the answer: "Thinking first… 12 s" while it works,
 * "Thought for 34 s" once it is done. `into`: the fold already on screen, kept so an opened fold stays open.
 */
function thoughtFold(text, seconds, done, into = null) {
  const fold = into ?? el('details', { class: 'thought' }, el('summary'), el('div', { class: 'thought-text' }));
  fold.querySelector('summary').textContent = done ? `Thought for ${secs(seconds)}` : `Thinking first… ${secs(seconds)}`;
  fold.querySelector('.thought-text').textContent = text;
  return fold;
}

/** Quick or Think for the chat on screen (the pick in the chat box); kept on the chat by the server. */
const thinkPick = $('#think-pick');
const thinkOn = () => thinkPick.querySelector('[data-think="think"]').getAttribute('aria-pressed') === 'true';
function setThink(on) {
  for (const b of thinkPick.querySelectorAll('[data-think]')) b.setAttribute('aria-pressed', String((b.dataset.think === 'think') === on));
}
thinkPick.addEventListener('click', e => {
  const b = e.target.closest('[data-think]');
  if (!b) return;
  setThink(b.dataset.think === 'think');
  api('/api/chat/think', { chatId: app.chatId ?? '', on: thinkOn() }).catch(() => undefined);
});

/** A chat that carries on from an earlier one: the handoff it opened with, folded at the top. */
function openingNote(text) {
  return el('details', { class: 'msg system opening' }, el('summary', { text: 'Carries on from an earlier chat: the handoff it started with' }), el('div', { class: 'opening-text' }, formatted(text)));
}

/** The message box of a chat kept to read (its person left the team, or was a node's hire): home.js and chats.js. */
const READ_ONLY_BOX = 'This chat is kept to read: press New chat to carry on';
const NOBODY_YET = 'Nobody to talk to yet: hire someone first (Settings, Set up, Staff, Hire staff). Pick their PC and model, and their chat opens here.';
app.nobodyYet = NOBODY_YET;
const EMPTY_CHAT = 'No messages yet.';
app.emptyChat = EMPTY_CHAT;

function drawChat(lines, chat) {
  log.replaceChildren();
  chatSpeeds = lines.filter(l => l.role === 'assistant' && !l.picture && l.perSecond > 0).map(l => l.perSecond);
  drawAverage();
  if (chat?.opening) log.append(openingNote(chat.opening));
  // Nobody to talk to (the host is off for now and nobody who chats is hired yet): says where to hire someone (home.js).
  if (!lines.length) log.append(el('p', { class: 'empty', text: !chat && app.nobodyToTalkTo ? NOBODY_YET : EMPTY_CHAT }));
  for (const l of lines) log.append(el('div', { class: `msg ${l.failed ? 'system' : l.role}${l.refused ? ' refused' : ''}` }, l.role === 'user' && !l.picture && l.content ? copyButton(l.content) : null, l.thought?.text ? thoughtFold(l.thought.text, l.thought.seconds, true) : null, l.picture ? pictureBubble(l.picture, l.content) : l.role === 'assistant' ? formatted(l.content) : l.content, l.picture ? (l.ran ? speedLine({ ran: `drawn ${l.ran}` }) : null) : l.failed ? null : speedLine(l), sentLine(l), l.picture || l.refused || l.failed || l.ran === 'written by the app, no model' ? null : msgActs(l.content, l.role === 'assistant', chat?.who)));
  // An answer a linked PC is still writing (the connection was lost part-way): Reconnect under it.
  lines.forEach((l, i) => { if (l.waiting) log.children[i + (chat?.opening ? 1 : 0)]?.append(reconnectLine(l.waiting)); });
  watchOwed(lines.some(l => l.waiting) ? chat?.id ?? '' : '');
  const last = lines.at(-1);
  if (last?.role === 'assistant' && last.cut) log.lastElementChild.append(continueButton());
  // This chat's answer is still coming (it was opened again from Home, or from the list): it carries on at the end.
  const live = streams.get(chat?.id ?? '');
  if (live?.out) {
    log.querySelector('.empty')?.remove();
    if (live.inPlace && log.lastElementChild) log.lastElementChild.replaceWith(live.out);
    else log.append(live.out);
  }
  drawLarge(chat?.large ?? null);
  drawDocs(chat?.docs ?? []);
  log.scrollTop = log.scrollHeight;
}

// ---- Documents in a chat (PLAN F10 G6): add (button or drop), the list above the chat, remove ----
const docsBar = $('#chat-docs');
function drawDocs(docs) {
  docsBar.hidden = !docs.length;
  docsBar.replaceChildren(...docs.map(d => {
    const x = el('button', { class: 'link', type: 'button', text: '×', title: `Take ${d.name} out of this chat`, 'aria-label': `Take ${d.name} out of this chat` });
    x.addEventListener('click', async () => {
      try {
        drawDocs((await api('/api/chat/doc/remove', { chatId: app.chatId ?? '', id: d.id })).docs);
      } catch (err) {
        app.chatNote(err.message);
      }
    });
    const size = d.kind === 'pdf' ? `${d.pages} page${d.pages === 1 ? '' : 's'}` : `${d.pages.toLocaleString()} lines`;
    return el('span', { class: 'doc-chip', title: d.empty ? `${d.empty} page${d.empty === 1 ? ' has' : 's have'} no text (pictures only) and cannot be read.` : '' }, el('span', { text: `${d.name} · ${size}${d.empty ? ` · ${d.empty} without text` : ''}` }), x);
  }));
}
async function addDocs(files) {
  // The person in the chat on screen (the server's chosen "who" is whichever window chose last).
  const who = String(app.chatWho?.() ?? app.models?.settings?.who ?? '');
  if (who.startsWith('node:')) return app.chatNote('Documents go into a chat with TOMLIN or a hire on this PC. Open one of those chats, then add the file.');
  // The chat they go into, named (the file is the body): a chat with no messages yet is made by the first file, and
  // the files after it go into that one.
  const from = app.chatId ?? '';
  const named = chatNamed();
  for (const file of files) {
    app.chatNote(`Reading ${file.name}…`);
    const note = log.lastElementChild;
    try {
      const res = await fetch('/api/chat/doc', { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-name': encodeURIComponent(file.name), 'x-chat': encodeURIComponent(named.chatId), 'x-who': encodeURIComponent(named.who), ...(named.plain ? { 'x-plain': encodeURIComponent(named.plain) } : {}) }, body: file });
      const r = await res.json().catch(() => ({ error: `TOMLIN answered ${res.status}.` }));
      if (!res.ok) throw new Error(r.error);
      note.textContent = r.said;
      if ((app.chatId ?? '') === named.chatId || (!named.chatId && (app.chatId ?? '') === '')) drawDocs(r.docs);
      if (r.chat && r.chat !== named.chatId) {
        named.chatId = r.chat;
        await app.afterSend?.(r.chat, from);
      }
    } catch (err) {
      note.textContent = err.message;
    }
  }
}
$('#doc-add').addEventListener('click', () => $('#doc-file').click());
$('#doc-file').addEventListener('change', e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) addDocs(files);
});
// A file dropped anywhere on the chat goes in the same way.
const chatDrop = log.closest('.pane') ?? log;
chatDrop.addEventListener('dragover', e => {
  if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
  e.preventDefault();
  chatDrop.classList.add('dropping');
});
chatDrop.addEventListener('dragleave', e => {
  if (!chatDrop.contains(e.relatedTarget)) chatDrop.classList.remove('dropping');
});
chatDrop.addEventListener('drop', e => {
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  chatDrop.classList.remove('dropping');
  addDocs([...e.dataTransfer.files]);
});

// ---- Long answers (PLAN F10 G1): Continue on an answer its length limit cut ----
function continueButton() {
  const b = el('button', { class: 'btn quiet continue', type: 'button', text: 'Continue', title: 'The answer reached its length limit before it was finished: carry it on from where it stopped' });
  b.addEventListener('click', () => {
    if (streamingHere()) return;
    const bubble = b.closest('.msg');
    b.remove();
    talk('/api/chat/continue', chatNamed(), bubble, '');
  });
  return el('div', { class: 'cut-line' }, el('span', { class: 'hint', text: 'Cut off at its length limit. ' }), b);
}

// ---- Reconnect: a linked PC lost part-way through an answer is still writing it (src/outbox.ts) ----
/** Under the words so far: who is still writing it, and Reconnect, which asks for it now. */
function reconnectLine(w) {
  const b = el('button', { class: 'btn quiet', type: 'button', text: 'Reconnect', title: `Ask ${w.name} for this answer now (it is also asked for by itself once a minute)` });
  let asking = false;
  b.addEventListener('click', async () => {
    if (asking) return;
    asking = true;
    b.textContent = 'Asking…';
    const chatId = app.chatId ?? '';
    try {
      const r = await api('/api/chat/reconnect', { chatId });
      const now = await api(chatUrl(chatId)).catch(() => null);
      if (now?.chat?.id === chatId) showChat(now);
      app.chatNote(r.said);
    } catch (err) {
      app.chatNote(err.message);
    } finally {
      asking = false;
      b.textContent = 'Reconnect';
    }
  });
  return el('div', { class: 'cut-line' }, el('span', { class: 'hint', text: `Lost the connection: ${w.name} is still working on it. ` }), b);
}
/** A chat read by its id (not whichever chat another window opened last). */
const chatUrl = id => `/api/chat?id=${encodeURIComponent(id)}`;
/** No chat on screen: the next message starts one. */
app.noChat = () => ({ lines: [], chat: null });
/**
 * This window's chat read again by its id, after something that may have changed it (a staff change, a chat deleted
 * elsewhere). A window still on a new chat stays on it; only one that has drawn no chat yet reads the one to reopen.
 */
app.chatAgain = () => (app.chatId ? api(chatUrl(app.chatId)) : app.chatId === '' ? Promise.resolve(app.noChat()) : api('/api/chat'));
/**
 * Chooses who this window talks to and reads the chat that opened for them (their latest, or none yet) by its id: not
 * whichever chat another window opened in between.
 */
app.talkTo = async who => {
  const s = await api('/api/settings', { who });
  return s.opened ? api(chatUrl(s.opened)) : app.noChat();
};
/** While an owed answer is on screen, the chat is read again every 30 s, so the answer shows once it is collected. */
let owedTimer = 0;
function watchOwed(chatId) {
  clearInterval(owedTimer);
  if (!chatId) return;
  owedTimer = setInterval(async () => {
    if (app.chatId !== chatId || streamingHere()) return;
    const now = await api(chatUrl(chatId)).catch(() => null);
    if (now?.chat?.id === chatId && !now.lines.some(l => l.waiting)) showChat(now);
  }, 30_000);
}
