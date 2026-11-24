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
    throw new Error('TOMLIN is not answering: it may be restarting after an update (about half a minute), or it was closed or stopped. If it does not come back, close this window, then open TOMLIN again (Start menu or desktop shortcut; or Start TOMLIN.cmd in its folder if you run it from there), and try again.');
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

/** askHere with more than one way to say yes: `choices` are {label, value, danger}. The value picked, or null for `no`. */
function askPick(box, text, choices, no = 'Cancel') {
  return new Promise(done => {
    const end = value => {
      box.replaceChildren();
      box.hidden = true;
      done(value);
    };
    const buttons = choices.map(c => el('button', { class: `btn ${c.danger ? 'danger' : 'primary'}`, type: 'button', text: c.label, onclick: () => end(c.value) }));
    app.askFor?.(box, () => end(null));
    box.classList.add('page-ask');
    box.setAttribute('role', 'alert');
    box.replaceChildren(el('span', { text }), ...buttons, el('button', { class: 'btn quiet', type: 'button', text: no, onclick: () => end(null) }));
    box.hidden = false;
    buttons[0].focus();
  });
}

/** "Sam", "Sam and Ana", "Sam, Ana and Lee". */
const listNames = names => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] ?? '');

/**
 * A setup code as it is typed, like a Windows key: capitals, and the dash comes by itself, so the fifth character is in
 * the second group. `deleting`: no dash is added back, or Backspace could never get past it.
 */
function shapeCode(text, deleting = false) {
  const c = text.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return c.length > 4 || (c.length === 4 && !deleting) ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}
document.addEventListener('input', e => {
  const box = e.target;
  if (!box.matches?.('[data-setup-code]')) return;
  // The cursor stays after the same character, wherever in the code it was.
  const before = box.value.slice(0, box.selectionStart).replace(/[^A-Za-z0-9]/g, '').length;
  const atEnd = box.selectionStart === box.value.length;
  box.value = shapeCode(box.value, String(e.inputType).startsWith('delete'));
  const at = atEnd ? box.value.length : before + (before > 4 ? 1 : 0);
  box.setSelectionRange(at, at);
});

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

/** The chat's Connect before anyone who chats is hired: what a press says, and its tooltip. */
const HIRE_FIRST = 'Hire someone first: Connect loads the model the person you talk to thinks with, and nobody is hired yet. Press Hire staff on the left.';
const STATE_TEXT = { disconnected: 'Disconnected', loading: 'Loading…', connected: 'Connected', unloading: 'Unloading…', failed: 'Failed' };
const DEVICE_TEXT = { cpu: 'CPU', vulkan: 'graphics chip (Vulkan)', cuda: 'NVIDIA card (CUDA)' };

const app = { status: null, models: null, onStatus: [] };

// ---- "Show hidden": models hidden on This PC (Models on this PC, Hide) are left out where a model is picked ----

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
  m.classList.remove('off');
  const pc = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  $('.val', m).setAttribute('stroke-dasharray', `${pc} 100`);
  $('.ring-v', m).textContent = text;
  m.classList.toggle('high', fraction > 0.85);
  if (title) {
    m.title = title;
    m.setAttribute('aria-label', title);
  }
  m.dataset.v = String(pc);
  busiest(m.parentElement);
}

// ---- The meters folded to the busiest (the top bar shows one ring until opened; kept in this browser) ----

// This PC's row and the linked PC's row open and fold on their own, each kept apart (this PC's keeps the old key).
const METERS_KEY = 'tomlin-meters';
const keyOf = box => (box.closest('#bar-node') ? `${METERS_KEY}-node` : METERS_KEY);
const metersOpen = box => {
  try {
    return localStorage.getItem(keyOf(box)) === 'open';
  } catch {
    return false;
  }
};
/** Marks the ring reading highest in a row of meters (CPU, GPU, RAM, GPU mem): the one shown while they are folded. */
function busiest(box) {
  if (!box?.classList.contains('meters')) return;
  const rings = [...box.querySelectorAll(':scope > .ring')];
  const top = rings.reduce((a, r) => (Number(r.dataset.v ?? -1) > Number(a?.dataset.v ?? -1) ? r : a), rings[0]);
  for (const r of rings) r.classList.toggle('busiest', r === top);
  foldButton(box);
}
/** The small button at the end of a row of meters: open all four, or fold back to the busiest. */
function foldButton(box) {
  let b = box.querySelector(':scope > .meters-fold');
  if (!b) {
    b = el('button', { class: 'meters-fold', type: 'button' });
    b.addEventListener('click', () => {
      try {
        localStorage.setItem(keyOf(box), metersOpen(box) ? 'folded' : 'open');
      } catch {
        // Not kept: it folds or opens for now.
        box.dataset.folded = box.dataset.folded === '1' ? '0' : '1';
      }
      // Only this row: the other keeps its own way.
      drawMetersFold(box);
    });
    box.append(b);
  }
  drawMetersFold(box);
}
function drawMetersFold(box) {
  const b = box.querySelector(':scope > .meters-fold');
  if (!b) return;
  const open = box.dataset.folded === '0' || (box.dataset.folded !== '1' && metersOpen(box));
  box.classList.toggle('folded', !open);
  b.textContent = open ? '‹' : '›';
  b.title = open ? 'Show only the busiest meter' : 'Show all four meters: CPU, GPU, RAM and graphics memory';
  b.setAttribute('aria-label', b.title);
  b.setAttribute('aria-expanded', String(open));
}

const pct = (used, total) => (total ? `${Math.round((used / total) * 100)}%` : '–');

/** A ring with nothing to read: a dashed track and an unplugged plug inside, the reason in its tooltip. */
function meterOff(id, title) {
  meterOf(id, 0, '', title);
  const m = $(`#${id}`);
  m.classList.add('off');
  $('.ring-v', m).replaceChildren(unpluggedIcon());
}
function unpluggedIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: 'ring-off' })) svg.setAttribute(k, String(v));
  // A plug (bottom left) pulled away from its socket (top right), each with its cable.
  for (const d of ['M5 13l6 6-2 2-6-6z', 'M7 15l2-2M9 17l2-2', 'M6 18l-4 4', 'M13 5l6 6 2-2-6-6z', 'M18 6l4-4']) {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}
/** Why the graphics chip cannot be read: its driver gives Windows no readings (`there`: ' on "<PC>"' for a linked PC). */
const NO_CHIP = 'no graphics chip with a driver was found. If this PC has a graphics card, install its maker\'s driver (TOMLIN skips Windows\' basic display driver), then start TOMLIN again';
const unreadWhy = chip => `Windows gives no readings for ${chip} (Task Manager shows no GPU graph for it either): its driver is missing or too old to report them. Install the maker's latest driver for it, then start TOMLIN again`;

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
  const off = (id, title) => meterOff(id.replace(/^m-/, 'n-'), title);
  if (!g) {
    off('m-gpu', `Graphics memory${there}: disconnected: ${NO_CHIP}.`);
    off('m-gpubusy', `GPU${there}: disconnected: ${NO_CHIP}.`);
    return;
  }
  if (g.unread) {
    off('m-gpubusy', `GPU${there}: disconnected: ${unreadWhy(g.name)}.`);
    if (g.unread === 'all') return off('m-gpu', `Graphics memory${there}: disconnected: ${unreadWhy(g.name)}.`);
  }
  meter('m-gpu', g.total ? g.used / g.total : 0, g.total ? pct(g.used, g.total) : gb(g.used), `Graphics memory${there}, ${g.name}: ${g.total ? pair(g.used, g.total) : gb(g.used)} in use${g.shared ? ' (built into the processor: it borrows from RAM)' : ''}`);
  if (!g.unread) meter('m-gpubusy', (g.busy ?? 0) / 100, g.busy == null ? '–' : `${g.busy}%`, g.busy == null ? `How hard ${g.name}${there} is working: not read yet` : `How hard ${g.name}${there} is working: ${g.busy}%`);
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
  const unread = h.gpu?.unread;
  if (unread) meterOff('m-gpubusy', `GPU: disconnected: ${unreadWhy(h.gpu.name.replace(/\(R\)|\(TM\)/gi, ''))}.`);
  if (unread === 'all') meterOff('m-gpu', `Graphics memory: disconnected: ${unreadWhy(h.gpu.name.replace(/\(R\)|\(TM\)/gi, ''))}.`);
  if (h.gpu && unread !== 'all') {
    const total = h.gpu.total;
    const chip = h.gpu.name.replace(/\(R\)|\(TM\)/gi, '');
    meter('m-gpu', total ? h.gpu.used / total : 0, total ? pct(h.gpu.used, total) : gb(h.gpu.used),
      `Graphics memory, ${chip}: ${total ? pair(h.gpu.used, total) : gb(h.gpu.used)} in use${h.gpu.shared ? '. Built into the processor, it borrows from RAM (Windows lets it take up to half), so this is also counted in RAM' : ''}. How hard the chip works is the GPU ring.`);
    const busy = h.gpu.busy;
    if (!unread) meter('m-gpubusy', (busy ?? 0) / 100, busy === null || busy === undefined ? '–' : `${busy}%`,
      busy === null || busy === undefined
        ? `How hard ${chip} is working: not read yet (Windows' counters start a few seconds after TOMLIN).`
        : `How hard ${chip} is working: ${busy}% (its busiest part, as Task Manager counts it). TOMLIN's models: ${h.gpu.models ?? 0}%.${h.gpu.shared ? ' It shares the processor chip\'s power and heat, so a busy GPU can slow the CPU too.' : ''}`);
  } else if (!h.gpu) {
    meterOff('m-gpu', `Graphics memory: disconnected: ${NO_CHIP}.`);
    meterOff('m-gpubusy', `GPU: disconnected: ${NO_CHIP}.`);
  }
  drawActive(s);
}

/** "Models active": a line for the chat models (two or more can be loaded, one runner each) and one for pictures. */
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
  if (llm.length) rows.push(el('div', { class: 'active-row' }, el('span', { class: 'active-k', text: 'Chat' }), ...llm.map(v => chip(v, 'Chat model'))));
  if (pics.length) rows.push(el('div', { class: 'active-row' }, el('span', { class: 'active-k', text: 'Images' }), ...pics.map(v => chip(v, 'Picture model'))));
  // Nothing loaded: nothing said (the top bar shows a model only while one is loaded).
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

/**
 * A line said at the end of `box` (the chat's notes): the same words again straight after are not added under it, the
 * line already there counts them ("(said 3 times)"), so a fault pressed or asked again never piles up line on line.
 * `make` builds the line from its words.
 */
function sayOnce(box, text, make) {
  const last = box.lastElementChild;
  if (last && last.dataset.said === text) {
    const n = (Number(last.dataset.times) || 1) + 1;
    last.dataset.times = String(n);
    last.textContent = `${text} (said ${n} times)`;
    return last;
  }
  const line = make(text);
  line.dataset.said = text;
  box.append(line);
  return line;
}

function showFault(box, text, detail, note) {
  if (!text) {
    box.hidden = true;
    box.dataset.sig = '';
    box.replaceChildren();
    return;
  }
  // Asked every second: drawn again only when it changes, so an opened "What does this mean?" stays open. The note is
  // part of what is drawn, never added after it: added on each poll, it piled up once a second under a failed load.
  const sig = `${text}|${detail ?? ''}|${note ?? ''}`;
  if (!box.hidden && box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.hidden = false;
  box.replaceChildren(el('span', { text }));
  if (detail) box.append(el('details', {}, el('summary', { text: 'What does this mean?' }), el('pre', { text: detail })));
  if (note) box.append(el('div', { text: note }));
}

function drawPane(name, v) {
  const p = panes[name];
  const was = p.state.dataset.state;
  p.state.dataset.state = v.state;
  p.stateText.textContent = STATE_TEXT[v.state];
  if (was !== v.state) drawFit(name);
  const on = v.state === 'connected' || v.state === 'loading';
  p.connect.textContent = v.state === 'loading' ? 'Cancel loading' : on ? 'Disconnect' : v.state === 'unloading' ? 'Unloading…' : 'Connect';
  // Nobody hired yet: the chat's Connect looks greyed and says why when pressed (there is nobody for the model to answer as).
  const nobody = name === 'chat' && !on && !!app.nobodyToTalkTo;
  p.connect.classList.toggle('primary', !on && !nobody);
  p.connect.classList.toggle('looks-off', nobody);
  p.connect.title = nobody ? HIRE_FIRST : '';
  // Someone was hired since the press: what it said no longer holds.
  if (!nobody && p.said?.dataset.sig === `${HIRE_FIRST}|`) showFault(p.said, null);
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
  showFault(p.fault, v.state === 'failed' ? v.error : null, v.detail, v.state === 'failed' ? v.note : null);
}

function threadsHint(name) {
  const h = app.status?.hardware.cpu;
  if (!h) return;
  const p = panes[name];
  p.threads.max = String(h.threads);
  p.threadsHint.textContent = `0 = all ${h.cores} cores (${h.threads} threads).`;
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
    // A hidden model is offered once "Show hidden" is ticked (beside the list), or while it is the one picked.
    const tick = hiddenTick(`show-hidden-${name}`, list.some(m => m.hidden));
    if (!tick.isConnected) (p.model.closest('label') ?? p.model).after(tick);
    for (const m of visibleModels(list, keep)) {
      const extra = m.installed === false ? ' (not downloaded)' : m.fit?.level === 'no' ? ' (too big now)' : m.fit?.level === 'tight' ? ' (tight)' : '';
      p.model.append(el('option', { value: m.id, text: `${m.name} · ${gb(m.bytes)}${extra}`, disabled: m.installed === false }));
    }
    // Never a blank list: nothing on the PC, or only models that are hidden or not downloaded, is said in the list itself.
    if (![...p.model.options].some(o => o.value && !o.disabled)) {
      const text = !list.length ? (name === 'chat' ? 'No chat models found' : 'No image models installed') : name === 'chat' ? 'No chat model downloaded' : 'No picture model downloaded';
      p.model.prepend(el('option', { value: '', text }));
      p.model.value = '';
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
  size.disabled = cache.disabled = $('#fold-wait').disabled = off;
  if (!m) {
    size.replaceChildren();
    hint.textContent = '';
    drawFold(null);
    return;
  }
  $('#fold-wait').value = String(m.foldWait ?? 4);
  drawFold(m);
  const sizes = (app.models.contexts ?? [8192]).filter(n => !m.trained || n <= Math.max(8192, m.trained) || n === m.run.ctx);
  const ps = m.reading?.perSecond;
  size.replaceChildren(...sizes.map(n => el('option', { value: String(n), text: `${tokensText(n)} tokens${n === 8192 ? ' (default)' : ''}${m.trained && n > m.trained ? ' (over its training)' : ''}${ps ? ` · ${readTime(n, ps)} to read` : ''}` })));
  size.value = String(m.run.ctx);
  cache.value = m.run.cache;
  // The context cache in RAM: only where there is a graphics card to free.
  $('#ctx-kvram').checked = m.run.kvRam === true;
  // (cards: from the hardware list, known at once; cardList fills only after the runners are asked.)
  $('#ctx-kvram-row').hidden = !(app.models.cards?.n > 0 || (app.models.cardList ?? []).length);
  // Where it runs (PLAN F8): only where it makes a difference, a card with memory of its own or a mixture-of-experts model.
  const place = $('#ctx-place');
  const ways = [['auto', 'Auto: fill the card, the rest in RAM'], ['card', 'Every layer on the graphics chip'], ...(m.moe ? [['ram', 'The experts (most of this model) in RAM, the rest on the card']] : []), ...(m.run.place === 'layers' ? [['layers', `The experts of the first ${m.run.moeCpu} layers in RAM, the rest on the card`]] : [])];
  place.replaceChildren(...ways.map(([v, t]) => el('option', { value: v, text: t })));
  place.value = ways.some(([v]) => v === m.run.place) ? m.run.place : 'auto';
  $('#ctx-place-row').hidden = !(m.places?.length || m.moe);
  // A guessing model: a much smaller chat model of the same family on this PC (same name start, e.g. Qwen3.5): llama.cpp
  // refuses one whose words list differs.
  const draft = $('#ctx-draft');
  const family = x => String(x.name).toLowerCase().split('-')[0];
  // The server says which models can guess for this one (the same words list); an older answer, by name.
  const smaller = (app.models.chat ?? []).filter(x => (m.guessers ? m.guessers.includes(x.id) : x.id !== m.id && !x.id.startsWith('ollama:') && family(x) === family(m) && x.bytes < m.bytes / 2));
  draft.replaceChildren(el('option', { value: '', text: 'None' }), ...(m.mtp ? [el('option', { value: 'mtp', text: 'Built-in (MTP): the model guesses for itself' })] : []), ...smaller.map(x => el('option', { value: x.id, text: `${x.name} · ${gb(x.bytes)}` })));
  draft.value = m.run.spec === 'mtp' && m.mtp ? 'mtp' : smaller.some(x => x.id === m.run.draft) ? m.run.draft : '';
  $('#ctx-draft-row').hidden = !smaller.length && !m.mtp;
  // Card choice (src/devices.ts): with two cards or more, the model can be held to one; its guessing model can sit on
  // another card, or in RAM.
  const cards = app.models.cardList ?? [];
  const onCard = ids => cards.findIndex(c => c.ids.some(id => (ids ?? []).includes(id)));
  const cardSel = $('#ctx-cards');
  cardSel.replaceChildren(el('option', { value: '', text: 'Every card (Auto)' }), ...cards.map((c, i) => el('option', { value: String(i), text: `Only the ${c.label} · ${gb(c.total)}` })));
  cardSel.value = m.run.cards?.length && onCard(m.run.cards) >= 0 ? String(onCard(m.run.cards)) : '';
  $('#ctx-cards-row').hidden = cards.length < 2;
  const draftCard = $('#ctx-draft-card');
  draftCard.replaceChildren(el('option', { value: '', text: cards.length > 1 ? 'The model\'s own cards' : 'The card, with the model' }), ...(cards.length > 1 ? cards.map((c, i) => el('option', { value: String(i), text: `The ${c.label}` })) : []), el('option', { value: 'ram', text: 'RAM (the CPU guesses; no card room)' }));
  draftCard.value = m.run.draftOn === 'ram' ? 'ram' : m.run.draftCard?.length && onCard(m.run.draftCard) >= 0 && cards.length > 1 ? String(onCard(m.run.draftCard)) : '';
  $('#ctx-draft-card-row').hidden = !cards.length || !draft.value || draft.value === 'mtp';
  $('#ctx-try-row').hidden = !(m.places?.length > 1);
  drawTry();
  drawRunner(m);
  const bytes = m.cost?.[m.run.cache]?.[m.run.ctx];
  const total = bytes != null ? m.bytes + bytes : null;
  hint.textContent = [
    bytes != null ? `${gb(total)} in all (model ${gb(m.bytes)} + context ${gb(bytes)}).` : 'Context memory unknown for this file.',
    m.trained ? `Trained up to ${tokensText(m.trained)}.` : '',
    ps ? `Reads about ${Math.round(ps)} tokens a second here: a full ${tokensText(m.run.ctx)} takes ${readTime(m.run.ctx, ps)} before the first word.` : 'Reading speed: measured from its first answers.',
    ps && m.run.ctx / ps > 600 ? (m.run.ctx >= 16384 ? 'A chat sends only its latest messages word for word, and its log keeps what matters from the older ones (the fold wait, below), so it is not read whole each time.' : 'A smaller context answers sooner; the chat offers a handoff before it fills.') : '',
  ].filter(Boolean).join(' ');
  hint.title = 'A bigger context lets a job step read bigger files, but uses more memory and makes long prompts slower.';
}

async function saveContext() {
  const id = panes.chat.model.value;
  if (!id) return;
  try {
    const cards = app.models.cardList ?? [];
    const idsAt = v => (v !== '' && cards[Number(v)] ? cards[Number(v)].ids : []);
    const where = $('#ctx-draft-card').value;
    // The built-in guesser is not a model: it is kept as the run's own guess (and dropped when another is chosen).
    const guess = $('#ctx-draft').value;
    const was = (app.models.chat ?? []).find(x => x.id === id)?.run;
    await api('/api/settings', { pane: 'chat', runModel: id, run: {
      ctx: Number($('#ctx-size').value), cache: $('#ctx-cache').value, place: $('#ctx-place').value, draft: guess === 'mtp' ? '' : guess,
      ...(guess === 'mtp' ? { spec: 'mtp' } : was?.spec === 'mtp' ? { spec: null } : {}),
      // Only what is shown is sent: a hidden choice keeps what was saved.
      ...(!$('#ctx-kvram-row').hidden ? { kvRam: $('#ctx-kvram').checked } : {}),
      ...(!$('#ctx-cards-row').hidden ? { cards: idsAt($('#ctx-cards').value) } : {}),
      // The Runner (null: Auto). Only when the row is shown: a model held to a runner keeps it otherwise.
      ...(!$('#ctx-runner-row').hidden ? { runner: $('#ctx-runner').value || null } : {}),
      ...(!$('#ctx-draft-card-row').hidden ? { draftOn: where === 'ram' ? 'ram' : null, draftCard: where === 'ram' ? [] : idsAt(where) } : {}),
    } });
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
for (const id of ['#ctx-size', '#ctx-cache', '#ctx-kvram', '#ctx-place', '#ctx-draft', '#ctx-cards', '#ctx-draft-card', '#ctx-runner']) $(id).addEventListener('change', saveContext);

// ---- The Runner a chat model starts on (src/server/faults.ts): Auto, or one card runner this PC pins and has unpacked ----

/** This PC's chat runners (/api/runner-pins), read once and again after a test. */
let runnerPins = null;
async function drawRunner(m) {
  const row = $('#ctx-runner-row');
  const sel = $('#ctx-runner');
  if (!m || String(m.id).startsWith('ollama:')) {
    row.hidden = true;
    return;
  }
  try {
    runnerPins ??= (await api('/api/runner-pins')).pins;
  } catch {
    runnerPins = [];
  }
  const cards = runnerPins.filter(p => p.device !== 'cpu');
  // Only a PC with more than one card runner to choose from.
  row.hidden = cards.filter(p => p.installed && !p.why).length < 2 && !m.run.runner;
  const held = m.run.runner ?? '';
  const short = { cuda: 'llama-cuda', cuda13: 'llama-cuda13', vulkan: 'llama-vulkan' };
  sel.replaceChildren(el('option', { value: '', text: 'Auto (the one that suits this card)' }), ...cards.map(p => el('option', { value: p.pin, disabled: !p.installed || !!p.why, text: `${p.name}${!p.installed ? ' (not installed)' : p.why ? ' (cannot run here)' : ''}` })));
  sel.value = short[held] ?? held;
  if (sel.value !== (short[held] ?? held)) sel.value = '';
}

/** The guided notice under the gear's Test now after a fail (one at a time). */
let runnerNotice = null;
$('#ctx-runner-test').addEventListener('click', async () => {
  const id = panes.chat.model.value;
  const pin = $('#ctx-runner').value;
  const said = $('#ctx-runner-said');
  const p = (runnerPins ?? []).find(x => x.pin === pin);
  if (!id || !p) {
    said.textContent = 'Pick a runner in the list first (Auto is not one runner).';
    return;
  }
  if (!confirm(`Test this model on ${p.name}?\n\nTOMLIN loads it on that runner only, asks a short question, has it write a short answer, then gives it a long prompt (about 3,000 tokens). It passes when every answer comes back and the runner is still running. Chats wait meanwhile; the models that were loaded are loaded again afterwards. Nothing is changed.`)) return;
  const btn = $('#ctx-runner-test');
  btn.disabled = true;
  runnerNotice?.remove();
  let s = null;
  try {
    await api('/api/runner-test', { model: id, runner: pin });
    for (;;) {
      await new Promise(r => setTimeout(r, 2000));
      s = (await api('/api/runner-test')).test;
      if (!s) break;
      said.textContent = s.now || s.said;
      if (s.state !== 'running') break;
    }
  } catch (err) {
    said.textContent = err.message;
  }
  btn.disabled = false;
  // A fail: the crash notice's guided flow suggests the next runner to try (src/server/faults.ts /api/runner-next).
  if (s?.state === 'failed' && app.crashNotice) {
    try {
      const { fault } = await api(`/api/runner-next?model=${encodeURIComponent(id)}`);
      if (fault) said.after((runnerNotice = app.crashNotice(fault)));
    } catch {
      // the words above already say why it failed
    }
  }
  runnerPins = null;
});

// ---- Fold wait (src/layers.ts): how long a fold in a chat of 16k or more may spend reading, kept per model ----
/** What the wait keeps word for word at this model's read speed, as src/layers.ts shortTokens works it out (with a 2,000-token log above). */
function drawFold(m) {
  const minutes = Number($('#fold-wait').value) || 4;
  const ps = m?.reading?.perSecond;
  const keep = ps ? Math.max(2000, Math.floor(ps * minutes * 60 - 2000)) : 0;
  $('#fold-hint').textContent = !m ? '' : ps
    ? `In a chat of 16k or more, when the latest messages pass a size, the oldest stop being sent word for word and the chat log keeps what matters (a fold); that turn reads the rest again. Reading about ${Math.round(ps)} tokens a second here, ${minutes} min keeps about ${keep.toLocaleString('en-GB')} tokens of the latest messages word for word. Longer keeps more, but each fold waits longer.`
    : `In a chat of 16k or more, how long a fold may spend reading the latest messages again. What it keeps word for word shows here once this model has answered on this PC (its reading speed is measured then).`;
}
$('#fold-wait').addEventListener('change', async () => {
  const id = panes.chat.model.value;
  const m = (app.models?.chat ?? []).find(x => x.id === id);
  const minutes = Number($('#fold-wait').value);
  if (!m) return;
  try {
    await api('/api/chat/foldwait', { model: id, minutes });
    m.foldWait = minutes;
    drawFold(m);
    gearSaved('chat', false);
  } catch (err) {
    $('#fold-wait').value = String(m.foldWait ?? 4);
    drawFold(m);
    gearSaid('chat', `Not saved: ${err.message}`);
  }
});

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
        if (name === 'chat' && app.nobodyToTalkTo) {
          showFault(p.said, HIRE_FIRST);
          return;
        }
        if (!p.model.value) {
          const none = ![...p.model.options].some(o => o.value && !o.disabled);
          showFault(p.said, none
            ? `No ${name === 'chat' ? 'chat' : 'picture'} model is on this PC yet, so there is nothing to connect. Get one under Settings, Models; it shows in the list beside Connect once it is downloaded.`
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
    drawMax();
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
    $('#loaded').replaceChildren(el('span', { class: 'chip chip-down' }, 'TOMLIN is not answering (it may be restarting after an update).', el('br'), 'If it does not come back, close this window and open TOMLIN again.'));
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
  // A tool call the model wrote as text (GLM's <tool_call>…</tool_call>, cut off or whole) is not words for the person.
  text = String(text ?? '').replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/g, '').trimEnd();
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
  $('#code-save-where').textContent = `${there ? `${name} is already there: it is kept as ${name}.bak, then replaced. ` : ''}It goes in the Files folder${codeSaving.folder ? `, ${codeSaving.folder}` : ''}. To use another folder: Settings, Files and blog writer.`;
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
    app.chatNote(`Saved ${r.path}${codeSaving.folder ? ` in ${codeSaving.folder}` : ''}.${r.created ? '' : ` The earlier version is kept as ${r.path}.bak.`} Open it under Settings, Files and blog writer.`);
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
  // Words are joined with dots; a fold (the web sources) goes under the line, on its own.
  const folds = rest.filter(x => x && typeof x !== 'string');
  rest = rest.filter(x => x && typeof x === 'string');
  if (!figures.length && !rest.length && !folds.length) return null;
  return el('span', { class: `speed${rest.length ? '' : ' stats-only'}` },
    figures.length ? el('span', { class: 'live-stats', text: `${figures.join(' · ')}${rest.length ? ' · ' : ''}` }) : null,
    rest.length ? rest.join(' · ') : null,
    ...folds);
}

function speedLine(m) {
  return statsLine([m.ran, m.perSecond ? `${m.perSecond.toFixed(1)} tokens a second` : ''], [m.sources ? `Read: ${m.sources}` : '', ...webLine(m.tools), m.note ?? '']);
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
  const head = [r.chat?.title || 'Chat', $('#chat-who-box').dataset.full || $('#chat-with').textContent, saved ? `Saved ${when(new Date().toISOString())}` : ''].filter(Boolean);
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

/** Under a message: Pin (into the notebook), Add to log (chatlog.js) and, under an answer, Send to… (hand it on). Any may be missing. */
function msgActs(text, answer, who) {
  const bits = [answer ? replyCopy(text) : null, app.pinButton?.(text), app.logButton?.(text), answer ? app.sendButton?.(text, who) : null].filter(Boolean);
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

/** Web for the chat on screen (the switch in the chat box): the model may search the web and read pages; kept on the chat by the server. */
const webPick = $('#web-pick');
const webOn = () => webPick.getAttribute('aria-pressed') === 'true';
function setWeb(on) {
  webPick.setAttribute('aria-pressed', String(on));
  webPick.textContent = on ? 'Web: on' : 'Web: off';
}
webPick.addEventListener('click', () => {
  setWeb(!webOn());
  api('/api/chat/web', { chatId: app.chatId ?? '', on: webOn() }).catch(() => undefined);
});

/**
 * Max for the chat on screen (the switch in the chat box, beside Web): for a model that fits this PC alone, linked PCs lend
 * to raise its tokens a second (src/maxmode.ts); kept on the chat by the server, sent with each message. Greyed, with the
 * reason in its tooltip, when it cannot run: the model does not fit one PC (Cluster runs it), or no linked PC can lend now.
 */
const maxPick = $('#max-pick');
const MAX_TIP = maxPick.title;
/** The reason in words under the chat box (not only in the tip): shown while Max is on but cannot run, or after a press on the faded switch. */
const maxWhyLine = $('#max-why');
let maxPressed = false;
const maxOn = () => maxPick.getAttribute('aria-pressed') === 'true';
function setMax(on) {
  maxPick.setAttribute('aria-pressed', String(on));
  maxPick.textContent = on ? 'Max: on' : 'Max: off';
  maxPressed = false;
  drawMax();
}
/** Why Max cannot run now ('' when it can): the model's side first (the one loaded for this chat, else the one picked), then the lenders'. */
function maxWhy() {
  const id = app.status?.panes?.chat?.model || panes.chat.model.value;
  const m = (app.models?.chat ?? []).find(x => x.id === id);
  if (m && m.fitsAlone === false) return 'This model does not fit one PC: Cluster runs it';
  return app.status?.max?.why ?? '';
}
function drawMax() {
  const why = maxWhy();
  maxPick.classList.toggle('greyed', !!why);
  maxPick.setAttribute('aria-disabled', String(!!why));
  maxPick.title = why ? `${MAX_TIP} Not available now: ${why}.` : MAX_TIP;
  const show = !!why && (maxOn() || maxPressed);
  maxWhyLine.hidden = !show;
  maxWhyLine.textContent = show ? `Max mode ${maxOn() ? 'is on but ' : ''}cannot run now: ${why}.` : '';
}
maxPick.addEventListener('click', () => {
  const why = maxWhy();
  // Greyed: it can still be switched off, never on.
  if (why && !maxOn()) {
    // The reason is said once, in the line under the box (#max-why), not again as a note in the chat.
    maxPressed = true;
    return drawMax();
  }
  setMax(!maxOn());
  api('/api/chat/max', { chatId: app.chatId ?? '', on: maxOn() }).catch(() => undefined);
});

/**
 * What an answer looked up on the web (Web on) and the other tools it used, for under the answer: the web as one folded
 * line, "Completed web search: Sources", each search and page inside; the other tools in words. Two items ('' or null when none).
 */
function webLine(uses) {
  if (!Array.isArray(uses) || !uses.length) return ['', ''];
  const one = u => (u.name === 'web_search' ? `Searched “${u.input}” (${u.said})` : u.ok ? `Read ${u.said}` : `Did not read ${u.input} (${u.said})`);
  const web = uses.filter(u => u.name === 'web_search' || u.name === 'open_page');
  // The newer tools (the screen, the laptop helper, git, notes): each step with how it ended and how long it took.
  const step = u => `${TOOL_WORDS[u.name] ?? u.name} ${u.input} (${u.ok ? '' : 'not done: '}${u.said}${Number.isFinite(u.ms) ? `, ${(u.ms / 1000).toFixed(1)} s` : ''})`;
  const other = uses.filter(u => !web.includes(u));
  const read = web.filter(u => u.name === 'open_page' && u.ok).length;
  const searched = web.filter(u => u.name === 'web_search').length;
  const count = [searched ? `${searched} search${searched === 1 ? '' : 'es'}` : '', read ? `${read} page${read === 1 ? '' : 's'} read` : ''].filter(Boolean).join(', ');
  const fold = web.length ? el('details', { class: 'web-used' }, el('summary', { text: `Completed web search: Sources${count ? ` (${count})` : ''}` }), el('ul', {}, ...web.map(u => el('li', { text: one(u) })))) : null;
  return [fold, other.length ? `Tools: ${other.map(step).join('; ')}` : ''];
}
const TOOL_WORDS = { window_list: 'listed windows:', screen_look: 'looked at', window_focus: 'window:', click: 'click:', press_key: 'keys:', cam_menus: 'read the menus on', cam_window_state: 'read the window on', git_read: 'git:', run_command: 'ran', save_note: 'note:', suggest_finding: 'finding:' };

/** The newer kinds (src/permits.ts TIER_KINDS), in the order shown, with the tiers each one may have. */
app.TIER_KINDS = [
  { kind: 'screen', name: 'Screen', what: 'name and read the windows on your list, as text (nothing is clicked)', tiers: ['never', 'look', 'each', 'allowed'] },
  { kind: 'machine', name: 'Laptop helper', what: 'read a linked helper\'s menus and window state, as text', tiers: ['never', 'look', 'each', 'allowed'] },
  { kind: 'focus', name: 'Bring to front', what: 'bring a window on your list to the front (it can take the keyboard from you)', tiers: ['never', 'each'] },
  { kind: 'input', name: 'Click and type', what: 'click and press keys in a window on your list, a card for each action', tiers: ['never', 'each'] },
  { kind: 'git', name: 'Git (read)', what: 'read status, diff and history in a folder on your coding list', tiers: ['never', 'look', 'each', 'allowed'] },
  { kind: 'run', name: 'Run a command', what: 'run test, build, lint or typecheck in a folder on your coding list', tiers: ['never', 'each', 'allowed'] },
  { kind: 'notes', name: 'Notes', what: 'save a research note in the chat\'s folder, and suggest findings for you to save', tiers: ['never', 'look', 'each', 'allowed'] },
  { kind: 'subagent', name: 'Subagent', what: 'have a second model check a draft against its quotes: on an available node, or queued on this PC after the answer', tiers: ['never', 'look', 'each', 'allowed'] },
];
app.TIER_NAMES = { never: 'Never', look: 'Look only', each: 'Ask each time', allowed: 'Allowed' };

/**
 * Settings, Permissions, the newer kinds, as rows in groups: Screen, Coding and Research. Each kind is a row with its
 * tiers side by side; the lists a kind needs (the windows, the coding folders and commands) fold under their group, and
 * the laptop helper's link under Screen. `save(change)` saves and gives back the permissions now (or null).
 */
app.tierRows = save => {
  const now = () => ({ tiers: {}, windows: [], folders: [], commands: [], research: false, coding: false, ...(app.models?.settings?.permissions ?? {}) });
  const kinds = Object.fromEntries(app.TIER_KINDS.map(k => [k.kind, k]));
  const picks = {};
  const icons = { screen: 'screen', machine: 'laptop', focus: 'front', input: 'click', git: 'git', run: 'run', notes: 'note', subagent: 'sub' };
  // "Let the model click and type" is the Click and type row (it was a tick of its own as well, saying the same thing).
  const about = { input: 'Let the model click and type in the listed windows only; it asks before every click and key' };
  const tierRow = kind => {
    const k = kinds[kind];
    const pick = app.setSeg(k.tiers.map(t => [t, app.TIER_NAMES[t]]), now().tiers?.[kind] ?? k.tiers[0], `${k.name}: when to ask`, async v => {
      const p = await save({ tiers: { ...now().tiers, [kind]: v } });
      pick.value = p ? p.tiers[kind] : now().tiers?.[kind] ?? k.tiers[0];
    });
    picks[kind] = pick;
    const what = about[kind] ?? k.what;
    return app.setRow({ icon: icons[kind], name: k.name, about: what[0].toUpperCase() + what.slice(1), side: pick });
  };
  const count = (list, one, none) => (list.length ? `${list.length} ${one}${list.length === 1 ? '' : 's'} listed` : none);
  const lines = (icon, name, key, one, none, hint, placeholder) => {
    const box = el('textarea', { rows: 3, spellcheck: 'false', 'aria-label': name, placeholder });
    box.value = (now()[key] ?? []).join('\n');
    const row = app.setRow({ icon, name, about: count(now()[key] ?? [], one, none), inside: [box, el('p', { class: 'set-note', text: hint })] });
    box.addEventListener('change', async () => {
      const p = await save({ [key]: box.value.split('\n').map(x => x.trim()).filter(Boolean) });
      if (!p) return;
      box.value = p[key].join('\n');
      row.about.textContent = count(p[key], one, none);
    });
    return row;
  };
  const role = (icon, name, key, words) => app.setRow({ icon, name, about: words, side: app.setSwitch(now()[key] === true, name, on => save({ [key]: on })) });

  // The laptop helper: linked with the code its window shows on the laptop; the code is never sent.
  const helpers = el('div', { class: 'set-helpers' });
  const helperRow = app.setRow({ icon: 'laptop', name: 'Link a laptop helper', about: 'No laptop helper is linked', inside: [] });
  const drawHelpers = list => {
    helperRow.about.textContent = list.length ? list.map(h => h.name).join(', ') : 'No laptop helper is linked';
    helpers.replaceChildren(...list.map(h => el('div', { class: 'set-line' },
      el('span', { text: `${h.name} at ${h.url.replace('http://', '')} · ${h.role} · reads ${h.tools.join(', ') || 'nothing'}` }),
      app.setButton('Remove', async () => drawHelpers((await api('/api/helpers', { action: 'remove', id: h.id })).helpers)))));
  };
  api('/api/helpers').then(r => drawHelpers(r.helpers)).catch(() => undefined);
  const address = el('input', { type: 'text', placeholder: '192.168.1.20', 'aria-label': 'The laptop\'s address', size: 16 });
  const code = el('input', { type: 'text', placeholder: 'Setup code', 'aria-label': 'The setup code shown on the laptop', size: 12, autocomplete: 'off' });
  const linkSaid = el('span', { class: 'set-note', role: 'status' });
  const link = app.setButton('Link', async () => {
    linkSaid.textContent = 'Linking…';
    try {
      drawHelpers((await api('/api/helpers', { action: 'link', address: address.value, code: code.value })).helpers);
      code.value = '';
      linkSaid.textContent = 'Linked.';
    } catch (error) {
      linkSaid.textContent = error.message;
    }
  });
  helperRow.querySelector('.set-inside').append(helpers,
    el('div', { class: 'set-line' }, el('label', { class: 'field' }, el('span', { text: 'The laptop\'s address' }), address), el('label', { class: 'field' }, el('span', { text: 'Setup code' }), code), link),
    linkSaid,
    el('p', { class: 'set-note', text: 'Start the helper on the laptop (docs/CAM-HELPER.md), then type its address and the code its window shows. It only reads menus and window text; it cannot click.' }));

  return {
    screen: app.setCard(tierRow('screen'), tierRow('focus'), tierRow('input'), tierRow('machine'),
      lines('list', 'Windows it may look at', 'windows', 'window', 'None listed: no screen tools', 'One a line: the window\'s whole title, with * for any letters, and its program before a | if you wish. A window that is not listed is never named, read or touched.', 'mstsc.exe|192.168.1.20 - *'),
      helperRow),
    coding: app.setCard(role('code', 'Coding role', 'coding', 'In a chat whose folder is listed below: read git, and run a named command when allowed'),
      tierRow('git'), tierRow('run'),
      lines('folder', 'Coding folders', 'folders', 'folder', 'None listed: no coding tools', 'One folder a line (the whole path). Only a chat that works in one of them gets the coding tools.', 'C:\\code\\my-project'),
      lines('run', 'Your named commands', 'commands', 'command', 'None of your own: test, build, lint and typecheck come from package.json', 'One a line, as name=command. It must start with node, npm, npx, python or php, with no pipes, && or redirects.', 'docs=npm run docs')),
    research: app.setCard(role('research', 'Research role', 'research', 'In a chat with Web on: read more pages, save notes with their sources, and suggest findings'),
      tierRow('notes'), tierRow('subagent')),
  };
};

/** What a chat's model may do (src/permits.ts), in the order shown. */
app.PERMISSION_KINDS = [
  { kind: 'files', name: 'Files', what: 'list, read and save files in the chat\'s folder (nothing is run or deleted)' },
  { kind: 'web', name: 'Web', what: 'search the web and read pages (when Web is on in the chat)' },
];

/**
 * The permission switches, Manual or Auto for each kind, and the wait between pages on a site: saved as they change.
 * Used in Settings and on the card a chat shows when it asks. `onChange(perms)` is told after each save.
 */
app.permissionRows = (onChange) => {
  const now = () => ({ files: 'ask', web: 'ask', webDelay: true, ...(app.models?.settings?.permissions ?? {}) });
  const said = el('span', { class: 'hint', role: 'status' });
  const save = async change => {
    try {
      const s = await api('/api/settings', { permissions: { ...now(), ...change } });
      if (app.models?.settings) app.models.settings.permissions = s.permissions;
      said.textContent = 'Saved.';
      onChange?.(s.permissions);
    } catch (error) {
      said.textContent = `Not saved: ${error.message}`;
    }
  };
  const rows = app.PERMISSION_KINDS.map(k => {
    const box = el('input', { type: 'checkbox', role: 'switch', checked: now()[k.kind] === 'auto', 'aria-label': `${k.name}: Auto` });
    const state = el('span', { class: 'perm-state', text: box.checked ? 'Auto' : 'Manual' });
    box.addEventListener('change', () => {
      state.textContent = box.checked ? 'Auto' : 'Manual';
      save({ [k.kind]: box.checked ? 'auto' : 'ask' });
    });
    return el('label', { class: 'perm-row', title: k.what }, el('span', { class: 'perm-name', text: k.name }), el('span', { class: 'perm-switch' }, box, el('span', { class: 'perm-knob' })), state, el('span', { class: 'hint', text: k.what }));
  });
  const delay = el('input', { type: 'checkbox', checked: now().webDelay !== false });
  delay.addEventListener('change', () => save({ webDelay: delay.checked }));
  return el('div', { class: 'perm-rows' }, ...rows, el('label', { class: 'check' }, delay, ' Wait 1-5 seconds (at random) between pages on the same site, so the site does not ban this PC'), said);
};

/**
 * Settings, Permissions (a page of its own): what a chat's model may do on its own, in groups (Files and web, Screen,
 * Coding, Research), then the standing rules. Saved as each is changed; one line at the foot says what was saved.
 */
app.permissionsPage = () => {
  const said = app.setSaid();
  // One save at a time: each sends the whole permissions, so two sent together would undo each other's change.
  let queue = Promise.resolve(null);
  const save = change => (queue = queue.then(() => saveNow(change)));
  const saveNow = async change => {
    try {
      const s = await api('/api/settings', { permissions: { files: 'ask', web: 'ask', webDelay: true, ...(app.models?.settings?.permissions ?? {}), ...change } });
      if (app.models?.settings) app.models.settings.permissions = s.permissions;
      said.textContent = 'Saved.';
      return s.permissions;
    } catch (error) {
      said.textContent = `Not saved: ${error.message}`;
      return null;
    }
  };
  const perms = () => ({ files: 'ask', web: 'ask', webDelay: true, ...(app.models?.settings?.permissions ?? {}) });
  // Files and Web: Ask first (asked in the chat the first time in each answer) or Auto (it goes ahead without asking).
  const askRow = (kind, icon) => {
    const k = app.PERMISSION_KINDS.find(x => x.kind === kind);
    const pick = app.setSeg([['ask', 'Ask first'], ['auto', 'Auto']], perms()[kind] === 'auto' ? 'auto' : 'ask', `${k.name}: ask first or auto`, async v => {
      const p = await save({ [kind]: v });
      pick.value = p?.[kind] === 'auto' ? 'auto' : 'ask';
    });
    return app.setRow({ icon, name: k.name, about: k.what[0].toUpperCase() + k.what.slice(1), side: pick });
  };
  const tiers = app.tierRows(save);
  return [
    el('p', { class: 'set-lead', text: 'What a chat\'s model may do on its own. Ask first: it asks in the chat the first time in each answer. Pages on this PC or your home network are never opened, and files outside the chat\'s folder are never touched, whatever is chosen here.' }),
    app.setPart('Files and web', app.setCard(askRow('files', 'file'), askRow('web', 'web'), ...app.webSearchRows(),
      app.setRow({ icon: 'pause', name: 'Pause between pages', about: '1 to 5 seconds on the same site, so the site does not ban this PC', side: app.setSwitch(perms().webDelay !== false, 'Pause between pages', on => save({ webDelay: on })) }))),
    app.setPart('Screen', tiers.screen),
    app.setPart('Coding', tiers.coding),
    app.setPart('Research', tiers.research),
    app.setPart('Rules', app.rulesBox()),
    said,
  ];
};

/** Settings, Rules: the standing rules added to every request a model gets (data/rules.md). A request, not a lock: the notes say which are also checked in code. */
app.rulesBox = () => {
  const said = el('p', { class: 'set-note', role: 'status' });
  const text = el('textarea', { rows: 12, spellcheck: 'true', 'aria-label': 'Standing rules', maxlength: 4000 });
  const sw = app.setSwitch(false, 'Rules on', on => save({ on }));
  const count = t => {
    const n = t.split('\n').filter(x => x.trim()).length;
    return `${n} rule${n === 1 ? '' : 's'}, sent with every message`;
  };
  const row = app.setRow({ icon: 'rules', name: 'Standing rules', about: 'Reading…', side: sw, inside: [] });
  const fill = r => {
    text.value = r.text;
    sw.box.checked = r.on;
    row.about.textContent = r.on ? count(r.text) : 'Off: no rules are sent';
  };
  api('/api/rules').then(fill).catch(error => { said.textContent = `Could not read the rules: ${error.message}`; });
  const save = async body => {
    try {
      fill(await api('/api/rules', body));
      said.textContent = 'Saved. The rules go with the next message.';
    } catch (error) {
      said.textContent = `Not saved: ${error.message}`;
    }
  };
  row.querySelector('.set-inside').append(
    el('p', { class: 'set-note', text: 'One rule per line, added to every message a model gets and to the Connect Claude prompt. A rule is a request, not a lock. Checked in code as well: files outside the chat folder are never touched, no tool can delete a file, and a save that would empty or gut a file (or hold a password or key) is refused.' }),
    text,
    el('div', { class: 'set-line' },
      app.setButton('Save rules', () => save({ text: text.value, on: sw.box.checked }), { main: true }),
      app.setButton('Reset to the 12 defaults', () => { if (confirm('Replace your rules with the 12 defaults?')) save({ reset: true }); })),
    said);
  return app.setCard(row);
};

/** Settings, Web search: which engine a chat with Web on searches with, and its key or address (rows for Files and web). */
app.webSearchRows = () => {
  const now = app.models?.settings?.webSearch ?? { provider: 'duckduckgo' };
  const said = el('span', { class: 'set-note', role: 'status' });
  const pick = el('select', { 'aria-label': 'Search with' },
    el('option', { value: 'duckduckgo', text: 'DuckDuckGo (no key needed)' }),
    el('option', { value: 'brave', text: 'Brave Search (your own key)' }),
    el('option', { value: 'searxng', text: 'SearXNG of your own' }));
  pick.value = now.provider;
  const key = el('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Brave Search key', placeholder: now.hasKey ? 'A key is saved: paste a new one to change it' : 'Paste your Brave Search key', size: 30 });
  const url = el('input', { type: 'url', spellcheck: 'false', 'aria-label': 'SearXNG address', placeholder: 'http://192.168.0.5:8888', value: now.url ?? '', size: 30 });
  const forget = app.setButton('Remove the saved key', () => save({ key: '' }));
  forget.hidden = !now.hasKey;
  const engine = app.setRow({ icon: 'search', name: 'Search with', about: 'Where a chat with Web on searches. Your search words go to that engine.', side: [said, pick] });
  const keyRow = app.setRow({ name: 'Brave Search key', about: 'From brave.com/search/api', side: [key, forget] });
  const urlRow = app.setRow({ name: 'SearXNG address', about: 'Turn on its JSON format in settings.yml', side: url });
  const show = () => {
    keyRow.hidden = pick.value !== 'brave';
    urlRow.hidden = pick.value !== 'searxng';
  };
  const save = async (extra = {}) => {
    try {
      const s = await api('/api/settings', { webSearch: { provider: pick.value, url: url.value.trim(), ...extra } });
      app.models.settings.webSearch = s.webSearch;
      key.value = '';
      key.placeholder = s.webSearch.hasKey ? 'A key is saved: paste a new one to change it' : 'Paste your Brave Search key';
      said.textContent = s.webSearch.provider !== pick.value ? 'That address cannot be reached: DuckDuckGo is used.' : pick.value === 'brave' && !s.webSearch.hasKey ? 'Saved. It needs its key.' : pick.value === 'searxng' && !s.webSearch.url ? 'Saved. It needs its address.' : 'Saved.';
      forget.hidden = !s.webSearch.hasKey;
    } catch (error) {
      said.textContent = `Not saved: ${error.message}`;
    }
  };
  pick.addEventListener('change', () => { show(); save(); });
  key.addEventListener('change', () => save({ key: key.value.trim() }));
  url.addEventListener('change', () => save());
  show();
  return [engine, keyRow, urlRow];
};

// ---- Settings rows (Data and lock, Permissions): one look for every setting ----
// Each setting is a row in a white card: an icon, its name, one line saying how it is now, and its control on the right.
// A row with more to it folds open from that row. A filled button is the one main action; a tint is where you are.

const SET_ICONS = {
  data: 'M5 6c0 1.7 3.1 3 7 3s7-1.3 7-3-3.1-3-7-3-7 1.3-7 3zM5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6',
  backup: 'M4 12a8 8 0 1 0 2.6-5.9M4 4v4h4M12 8v4l3 2',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v9H5z',
  timer: 'M12 7v5l3 2M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM10 2h4',
  bell: 'M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0',
  sound: 'M4 10v4h4l5 4V6L8 10zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11',
  file: 'M7 3h7l4 4v14H7zM14 3v4h4',
  web: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM3.5 12h17M12 3.5c2.5 2.7 2.5 14.3 0 17M12 3.5c-2.5 2.7-2.5 14.3 0 17',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM16 16l4 4',
  pause: 'M9 6v12M15 6v12',
  screen: 'M3 4h18v12H3zM9 20h6M12 16v4',
  front: 'M8 8h12v12H8zM16 8V4H4v12h4',
  click: 'M9 4v3M4 9h3M5.5 5.5l2 2M10 10l9 3.5-4 1.5-1.5 4z',
  laptop: 'M5 5h14v10H5zM3 19h18',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  git: 'M7 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM17 7a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7 8v8M17 11c0 3-4 3-8 5',
  run: 'M3 4h18v16H3zM7 9l3 3-3 3M13 15h4',
  folder: 'M3 6h6l2 2h10v11H3z',
  note: 'M5 4h14v11l-5 5H5zM14 20v-5h5M8 9h8M8 13h4',
  sub: 'M9 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 5.5a3 3 0 0 1 0 5.5M18 14.5c1.8.9 3 2.9 3 5.5',
  rules: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  code: 'M8 8l-4 4 4 4M16 8l4 4-4 4',
  research: 'M4 19V5h12l4 4v10zM8 10h8M8 14h5',
  chev: 'M9 6l6 6-6 6',
};
/** One of the settings icons, drawn as a line. */
app.setIcon = (name, size = 20) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) s.setAttribute(k, String(v));
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', SET_ICONS[name] ?? '');
  s.append(p);
  return s;
};
/** A heading and the cards under it. */
app.setPart = (title, ...cards) => el('section', { class: 'set-part' }, el('h3', { text: title }), ...cards);
/** A white card of rows. */
app.setCard = (...rows) => el('div', { class: 'set-card' }, ...rows);
/**
 * One setting: `icon`, `name`, `about` (how it is now, one line), `side` (its controls, on the right) and `inside` (more,
 * folded under the row until it is pressed; `open` starts it open). A button or switch on the right does its own job;
 * it does not also fold the row.
 */
app.setRow = ({ icon = '', name, about = '', side = [], inside = null, open = false }) => {
  const aboutLine = el('span', { class: 'set-about', text: about });
  const head = [
    el('span', { class: 'set-tile' }, icon ? app.setIcon(icon) : null),
    el('span', { class: 'set-txt' }, el('b', { text: name }), aboutLine),
  ];
  const sides = [].concat(side).filter(Boolean);
  if (!inside) {
    const row = el('div', { class: 'set-row' }, ...head, el('span', { class: 'set-side' }, ...sides));
    row.about = aboutLine;
    return row;
  }
  const row = el('details', { class: 'set-row', open },
    el('summary', {}, ...head, el('span', { class: 'set-side' }, ...sides, el('span', { class: 'set-chev' }, app.setIcon('chev', 18)))),
    el('div', { class: 'set-inside' }, ...[].concat(inside).filter(Boolean)));
  row.about = aboutLine;
  return row;
};
/** An on/off switch: `onChange(on)` is told when it is pressed. */
app.setSwitch = (on, label, onChange) => {
  const box = el('input', { type: 'checkbox', role: 'switch', 'aria-label': label, checked: !!on });
  box.addEventListener('change', () => onChange(box.checked, box));
  const sw = el('label', { class: 'set-sw' }, box, el('i', { 'aria-hidden': 'true' }));
  sw.box = box;
  return sw;
};
/**
 * A choice of two to four, side by side: the one picked is raised and white, the rest are plain words. `choices` is
 * [[value, words], …]; `onChange(value)` is told when another is pressed. `.value` reads or sets the one picked.
 */
app.setSeg = (choices, value, label, onChange) => {
  const group = el('span', { class: 'set-seg', role: 'radiogroup', 'aria-label': label });
  const mark = v => {
    for (const b of group.children) b.setAttribute('aria-checked', String(b.dataset.value === v));
  };
  for (const [v, words] of choices) {
    group.append(el('button', { type: 'button', role: 'radio', 'data-value': v, 'aria-checked': 'false', text: words, onclick: () => {
      if (group.value === v) return;
      group.value = v;
      mark(v);
      onChange(v);
    } }));
  }
  Object.defineProperty(group, 'value', { get: () => group.dataset.value, set: v => { group.dataset.value = v; mark(v); } });
  group.value = value;
  return group;
};
/** A short line under a card that says what was saved, or why not. */
app.setSaid = () => el('p', { class: 'set-said', role: 'status' });
/** A button: `main` is the one filled button a card has at most. */
app.setButton = (text, onclick, { main = false, danger = false, title = '' } = {}) => el('button', { class: `btn${main ? ' primary' : ''}${danger ? ' danger-text' : ''}`, type: 'button', text, title: title || null, onclick });

/** A chat that carries on from an earlier one: the handoff it opened with, folded at the top. */
function openingNote(text) {
  return el('details', { class: 'msg system opening' }, el('summary', { text: 'Carries on from an earlier chat: the handoff it started with' }), el('div', { class: 'opening-text' }, formatted(text)));
}

/** The message box of a chat kept to read (its person left the team, or was a node's hire): home.js and chats.js. */
const READ_ONLY_BOX = 'This chat is kept to read: press New chat to carry on';
const NOBODY_YET = 'Nobody to talk to yet: press Hire staff (on the left) to hire someone. Pick their PC and model, and their chat opens here.';
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
  for (const l of lines) log.append(el('div', { class: `msg ${l.failed ? 'system' : l.role}${l.refused ? ' refused' : ''}${l.recalled ? ' recalled' : ''}` }, l.role === 'user' && !l.picture && l.content ? copyButton(l.content) : null, l.thought?.text ? thoughtFold(l.thought.text, l.thought.seconds, true) : null, l.picture ? pictureBubble(l.picture, l.content) : l.role === 'assistant' ? formatted(l.content) : l.content, l.picture ? (l.ran ? speedLine({ ran: `drawn ${l.ran}` }) : null) : l.failed ? null : speedLine(l), sentLine(l), l.picture || l.refused || l.failed || l.ran === 'written by the app, no model' ? null : msgActs(l.content, l.role === 'assistant', chat?.who)));
  // An answer a linked PC is still writing (the connection was lost part-way): Reconnect under it.
  lines.forEach((l, i) => { if (l.waiting) log.children[i + (chat?.opening ? 1 : 0)]?.append(reconnectLine(l.waiting)); });
  watchOwed(lines.some(l => l.waiting) ? chat?.id ?? '' : '');
  const last = lines.at(-1);
  if (last?.role === 'assistant' && last.cut) log.lastElementChild.append(continueButton());
  // This chat's answer is still coming (it was opened again from Home, or from the list): it carries on at the end.
  const live = streams.get(streamKey(chat?.id ?? '', chat?.who ?? app.chatWho?.())) ?? (chat?.id ? streamOf(chat.id) : undefined);
  if (live?.out) {
    log.querySelector('.empty')?.remove();
    if (live.inPlace && log.lastElementChild) log.lastElementChild.replaceWith(live.out);
    else log.append(live.out);
  }
  drawLarge(chat?.large ?? null);
  drawDocs(chat?.docs ?? []);
  if (app.chatToEnd) app.chatToEnd();
  else log.scrollTop = log.scrollHeight;
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
      const post = async scanOk => {
        const res = await fetch('/api/chat/doc', { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-name': encodeURIComponent(file.name), 'x-chat': encodeURIComponent(named.chatId), 'x-who': encodeURIComponent(named.who), ...(named.plain ? { 'x-plain': encodeURIComponent(named.plain) } : {}), ...(scanOk ? { 'x-scan-ok': '1' } : {}) }, body: file });
        const got = await res.json().catch(() => ({ error: `TOMLIN answered ${res.status}.` }));
        if (!res.ok) throw new Error(got.error);
        return got;
      };
      let r = await post(false);
      // The file looks like it tries to take a model over (src/promptscan.ts): the flagged parts are shown, and it is
      // added only once he ticks that he understands the risks.
      if (r.scan) {
        if (r.chat && r.chat !== named.chatId) {
          named.chatId = r.chat;
          await app.afterSend?.(r.chat, from);
        }
        const ok = await app.scanWarn(r.scan, r.scan.text, {
          title: `${r.name} looks risky`,
          hint: 'This file holds text that is often used to trick an AI into doing harm: hiding its orders, reading your files or passwords, sending them out, or running commands. The flagged parts are marked, with a little of the text around each (… marks text left out). Add it only if you trust where it came from.',
        });
        if (!ok) {
          note.textContent = `${file.name} was not added.`;
          continue;
        }
        r = await post(true);
      }
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

// ---- Options (bottom left of the chat box): Quick or Think, Web and Max in a menu that opens upward ----
// The switches are the same buttons as before (thinkPick, webPick, maxPick keep their state); the button names what is
// on ("Options · Think · Web"), so nothing is hidden by being in the menu.
const optionsOpen = $('#chat-options-open');
const optionsMenu = $('#chat-options-menu');
function drawOptions() {
  const on = [thinkOn() ? 'Think' : '', webOn() ? 'Web' : '', maxOn() ? 'Max' : ''].filter(Boolean);
  optionsOpen.textContent = ['Options', ...on].join(' · ');
}
function showOptions(open) {
  optionsMenu.hidden = !open;
  optionsOpen.setAttribute('aria-expanded', String(open));
}
optionsOpen.addEventListener('click', () => showOptions(optionsMenu.hidden));
document.addEventListener('click', e => { if (!optionsMenu.hidden && !e.target.closest('#chat-options')) showOptions(false); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !optionsMenu.hidden) {
    showOptions(false);
    optionsOpen.focus();
  }
});
new MutationObserver(drawOptions).observe(optionsMenu, { subtree: true, attributes: true, attributeFilter: ['aria-pressed'], childList: true, characterData: true });
drawOptions();
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
/** The first answer's file could not be saved: the same words, offered once more until they are saved. */
function saveAnswerAgain(chat, prompt, text) {
  const said = el('span', { class: 'hint', role: 'status' });
  const go = el('button', { class: 'btn', type: 'button', text: 'Save the file again', onclick: async () => {
    go.disabled = true;
    try {
      const r = await api('/api/chats/keep-answer', { id: chat, prompt, text });
      said.textContent = `Saved as ${r.path.replace(/\//g, '\\')} in the workspace folder.`;
      go.remove();
    } catch (err) {
      said.textContent = err.message;
      go.disabled = false;
    }
  } });
  return el('div', { class: 'team-actions' }, go, said);
}

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
