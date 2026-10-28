// The Models page: a whole page on the right (the left panel stays). Its own side has the search filters (chat model
// size: Smallest / Largest size (billions) and download (GB)), Model categories as tick boxes (kinds, Abliterated, Uncensored, Mixture-of-experts), and
// Import models (two tiles: Download, Connect); on top, the search box, Search, and All | Not installed | Installed, then
// Models on my other PCs. Right of the list's heading, Size and A to Z order the list (pressed again, the other way round).
// Every model shows two short lines; "See more" opens the rest. Hugging Face's answer comes a page at a time, from the
// file list (shipped with TOMLIN, or this PC's own after Rescan Hugging Face) or, with none, Hugging Face's own search.
// Chat models come from Hugging Face (a PC downloads only to itself): each row shows its size before anything is pressed,
// Download takes the recommended size in one press, and the button turns into the download's progress. Picture models,
// helpers and runners come from the registry.
// Uses app.js's helpers ($, el, api, app, loadModels) and home.js's setView.
'use strict';

const mp = {
  q: '', data: null,
  /** Ticked categories (none = all models), and Import models open (the folder part instead of a list). */
  cats: new Set(), importing: false,
  /** Hugging Face's list kept on this PC (/api/hflist): scannedAt, count, scanning, error; listTimer asks while it scans. */
  list: null, listTimer: 0,
  /** Ticked terms (abliterated, uncensored): either one in the name. */
  terms: new Set(),
  /** Mixture-of-experts ticked: mixtures of experts only (as well as any term). */
  moe: false,
  /** Fits my card ticked: only chat models with a size that sits wholly on the graphics cards; cards = {n, total} (/api/models). */
  card: false, cards: null,
  /** Fits (the drop-down): '' = all sizes, 'here' = fits this PC, or a linked PC's id = fits that PC (its memory). */
  fitOn: '',
  /** Download's To list: the linked PCs (/api/network: name, and fetchCode, '' when one can download a model itself now),
   *  and the PC picked for each Download (by row; none = This PC, or the PC picked under Fits). */
  net: null, to: new Map(),
  /** The runners on this PC (/api/runtimes: here, kept files, why not, a download running), and the PC picked for each Send to. */
  runners: null, runnerTo: new Map(),
  /** The list's order: '' (as it comes: Hugging Face's most downloaded first), size-asc / size-desc, name-asc / name-desc. */
  order: '',
  /** Every list: 'all', 'hide' (only what is not on this PC yet) or 'only' (only what is), from the two ticks. */
  show: 'all', open: new Set(), timer: 0, hfTimer: 0,
  /** Hugging Face's answer: page (0 = first), cursors[i] = how page i is asked for (null for the first), next = more after. */
  hf: { key: '', busy: false, found: [], error: '', page: 0, cursors: [null], next: false, seen: [] },
  /** Each Hugging Face repo's sizes, read once: {busy} | {error} | {rev, licence, params, usual, models}. */
  sizes: {},
  /** Repos whose other sizes are open. */
  more: new Set(),
  /** Size filters: billions of parameters and download size in GB (null = any). */
  f: { minB: null, maxB: null, minGB: null, maxGB: null },
  /** The chat-model download now (from /api/chatmodels/get). */
  job: null,
};
// Under 0.1 GB in MB: a Vulkan runner (about 30 MB) read "0.0 GB".
const MP_GB = n => (n > 0 && n < 0.1 * 2 ** 30 ? `${Math.max(1, Math.round(n / 2 ** 20))} MB` : `${(n / 2 ** 30).toFixed(n >= 100 * 2 ** 30 ? 0 : 1)} GB`);

// Chat models people often start with. Each was checked on Hugging Face (public, not gated) on 4 Oct 2026; the sizes and
// files are read from Hugging Face when the page opens, never written here.
const POPULAR = [
  { repo: 'unsloth/Qwen3.5-0.8B-GGUF', name: 'Qwen3.5 0.8B', about: 'The smallest Qwen3.5. Very fast on any PC; fine for short replies, weak at facts.' },
  { repo: 'unsloth/Qwen3.5-2B-GGUF', name: 'Qwen3.5 2B', about: 'A good Junior: quick on a laptop, clearer answers than the 0.8B.' },
  { repo: 'unsloth/Qwen3.5-4B-GGUF', name: 'Qwen3.5 4B', about: 'A step up in sense and writing; wants about 4 GB free.' },
  { repo: 'unsloth/Qwen3.5-9B-GGUF', name: 'Qwen3.5 9B', about: 'Experienced level: solid writing and code; wants 8 GB free or a graphics card.' },
  { repo: 'unsloth/Qwen3.5-35B-A3B-GGUF', name: 'Qwen3.5 35B-A3B (MoE)', about: 'Expert level. A mixture of experts: big knowledge, fast for its size; wants about 24 GB.' },
  { repo: 'unsloth/gemma-3-1b-it-GGUF', name: 'Gemma 3 1B', about: 'Google\'s smallest Gemma 3. Fast and friendly; short answers.' },
  { repo: 'unsloth/gemma-3-4b-it-GGUF', name: 'Gemma 3 4B', about: 'Warm, natural chat; a good writer for its size.' },
  { repo: 'unsloth/gemma-3-12b-it-GGUF', name: 'Gemma 3 12B', about: 'Experienced level; strong writing. Wants about 9 GB free.' },
  { repo: 'unsloth/Llama-3.2-3B-Instruct-GGUF', name: 'Llama 3.2 3B', about: 'Meta\'s small Llama; plain and steady. Check its licence for business use.' },
  { repo: 'unsloth/Phi-4-mini-instruct-GGUF', name: 'Phi-4 mini', about: 'Microsoft\'s small model; good at reasoning and code for its size.' },
];

// Model categories as tick boxes: any ticked kind shows; Abliterated / Uncensored (either word in the name) narrow it;
// none ticked (All models) shows every one.
const CATS = [['all', 'All models'], ['chat', 'Chat models'], ['image', 'Picture models'], ['helper', 'Helpers'], ['runner', 'Model runners']];
const CAT_NAME = Object.fromEntries(CATS);
const TERM_NAME = { abliterated: 'Abliterated', uncensored: 'Uncensored' };
const TERM_TIP = { abliterated: 'Only models with abliterated in the name: their built-in refusals were taken out', uncensored: 'Only models with uncensored in the name' };
/**
 * A mixture of experts, known by its name (the same pattern as src/hflist.ts isMoe): the active part ("30B-A3B"),
 * "8x7B", MoE, Mixtral, gpt-oss, DeepSeek V2 and V3. A model on this PC is also known by its file.
 */
const MOE = /(?:^|[^a-z0-9])(?:\d+x\d+(?:\.\d+)?b|a\d+(?:\.\d+)?[bm]|[a-z]*moe|mixtral|gpt-oss|deepseek-v[23])(?![a-z])/i;
const MOE_TIP = 'Only mixture-of-experts models (MoE): known by the name (A3B, 8x7B, MoE, Mixtral, gpt-oss…) or, on this PC, by the file. Fast for their size, but they need the memory of the whole model';
const isMoeItem = x => (x.kind === 'chat' || x.kind === 'popular') && (!!x.moe || MOE.test(`${x.name} ${x.repo ?? ''}`));

/** The categories as tick boxes, built once (a box kept between draws keeps its focus), then Import models. */
function mpNav() {
  const nav = $('#mp-side');
  if (!nav.childElementCount) {
    const tick = (data, name, title, onchange) => el('li', {}, el('label', { class: 'mp-tick', title }, el('input', { type: 'checkbox', ...data, onchange }), el('span', { text: name })));
    nav.replaceChildren(
      el('h3', { text: 'Model categories' }),
      el('ul', { class: 'mp-ticks' },
        ...CATS.map(([id, name]) => tick({ 'data-cat': id }, name, null, e => {
          if (id === 'all') {
            mp.cats.clear();
            mp.terms.clear();
            mp.moe = false;
            mp.card = false;
            mp.fitOn = '';
          } else if (e.target.checked) mp.cats.add(id);
          else mp.cats.delete(id);
          mp.importing = false;
          mpDraw();
          if (id === 'all') mpHfSearch();
        })),
        ...Object.entries(TERM_NAME).map(([id, name]) => tick({ 'data-term': id }, name, TERM_TIP[id], e => {
          if (e.target.checked) mp.terms.add(id);
          else mp.terms.delete(id);
          mp.importing = false;
          mpDraw();
          mpHfSearch(true);
        })),
        tick({ 'data-moe': '' }, "Mixture-of-experts", MOE_TIP, e => {
          mp.moe = e.target.checked;
          mp.importing = false;
          mpDraw();
          mpHfSearch(true);
        }),
        tick({ 'data-card': '' }, 'Fits my card', null, e => {
          mp.card = e.target.checked;
          mp.importing = false;
          mpDraw();
          mpHfSearch(true);
        }),
        el('li', {}, el('label', { class: 'field mp-fits', title: 'Only chat models with a size that could run on that PC: an estimate from its memory (RAM and graphics card), the same as the marks beside each size' },
          el('span', { text: 'Fits' }),
          el('select', { id: 'mp-fit-on', onchange: e => {
            mp.fitOn = e.target.value;
            mp.importing = false;
            mpDraw();
            mpHfSearch(true);
          } })))),
      el('ul', { class: 'mp-own' }, el('li', {}, el('button', { class: 'mp-cat mp-cat-own', type: 'button', id: 'mp-import', text: 'Import models', onclick: () => { mp.importing = !mp.importing; mpDraw(); } }))));
  }
  for (const box of nav.querySelectorAll('[data-cat]')) box.checked = box.dataset.cat === 'all' ? !mp.cats.size && !mp.terms.size && !mp.moe && !mp.card && !mp.fitOn : mp.cats.has(box.dataset.cat);
  drawFitOn();
  // Fits my card: only on a PC whose chat can use a graphics card with memory of its own.
  const cardBox = nav.querySelector('[data-card]');
  cardBox.checked = mp.card;
  cardBox.closest('li').hidden = !mp.cards?.n;
  if (mp.cards?.n) {
    cardBox.nextElementSibling.textContent = `${mp.cards.n === 1 ? 'Fits my card' : 'Fits my cards'} (${Math.round(mp.cards.total / 2 ** 30)} GB)`;
    cardBox.parentElement.title = `Only chat models with a size that sits wholly on the graphics card (${cardWord()}, about ${MP_GB(mp.cards.total - mp.cards.n * 2 ** 29)} of it usable). An estimate: the file and room for an 8K chat. A model that does not fit still runs, part on the card and part on the processor, slower.`;
  }
  for (const box of nav.querySelectorAll('[data-term]')) box.checked = mp.terms.has(box.dataset.term);
  for (const box of nav.querySelectorAll('[data-moe]')) box.checked = mp.moe;
}

// ---- Sizes: parameters ("9B") and what fits ----

/** Parameters from a name ("Qwen3.5-9B", "35B-A3B" = 35B, "270M"), for when Hugging Face does not say. */
function paramsFromName(name) {
  const m = /(?:^|[^\w.])(\d+(?:\.\d+)?)\s*([BM])(?![a-z])/i.exec(String(name).replace(/[-_]A\d+(?:\.\d+)?B/i, ''));
  return m ? Number(m[1]) * (m[2].toUpperCase() === 'B' ? 1e9 : 1e6) : null;
}
/** 8953803264 -> "9B" (well, "9B" from 8.95), 752000000 -> "0.75B", 270000000 -> "0.27B": the B people search by. */
function paramsText(n) {
  const b = n / 1e9;
  return `${String(Number(b.toFixed(b < 1 ? 2 : b < 100 ? 1 : 0)))}B`;
}
const MP_FITS = {
  ok: { mark: '✓', text: 'fits this PC' },
  tight: { mark: '▲', text: 'tight on this PC' },
  no: { mark: '✕', text: 'too big for this PC' },
};
const fitsText = f => (MP_FITS[f] ? `${MP_FITS[f].mark} ${MP_FITS[f].text}` : '');
/** "6 GB card", or "2 cards, 12 GB": this PC's graphics cards that chat can use. */
const cardWord = () => (mp.cards.n === 1 ? `${Math.round(mp.cards.total / 2 ** 30)} GB card` : `${mp.cards.n} cards, ${Math.round(mp.cards.total / 2 ** 30)} GB`);
/** A size's card mark beside "fits this PC" (none when the PC itself is too small, or there is no card). */
const cardText = m => (!mp.cards?.n || !m.card || m.fits === 'no' ? '' : m.card === 'ok' ? `✓ fits the ${cardWord()}` : `▲ more than the ${cardWord()} holds: part runs on the processor`);

// ---- Fits: All, This PC, or a linked PC (by the memory it last reported) ----

/** The linked PCs Home knows (name, address, RAM and card memory; none while one is off). */
const linkedPcs = () => (typeof homeUi !== 'undefined' ? homeUi.pcs ?? [] : []);
/** A linked PC's name, with its address when two share the name (two "Worker PC"s). */
function pcLabel(p, all) {
  const twin = all.filter(x => x.name === p.name).length > 1;
  return twin ? `${p.name} (${String(p.url ?? '').replace(/^https?:\/\//, '').replace(/:\d+$/, '')})` : p.name;
}
/** The linked PC picked under Fits, while its memory is known (else null: Fits shows all). */
const fitPc = () => (mp.fitOn && mp.fitOn !== 'here' ? linkedPcs().find(p => p.id === mp.fitOn && p.ram > 0) ?? null : null);
/** src/calc.ts fitsRoom, the same sum: RAM less 2 GB, plus the card's own memory less 1 GB; the file x 1.1 + 0.8 GB. */
function fitsThere(bytes, p) {
  const room = Math.max(0, p.ram - 2 * 2 ** 30) + Math.max(0, (p.vram ?? 0) - 2 ** 30);
  const need = bytes * 1.1 + 0.8 * 2 ** 30;
  return need <= room * 0.85 ? 'ok' : need <= room ? 'tight' : 'no';
}
/** A size inside Fits: this PC's own mark, or the linked PC's sum. */
function fitsOn(m) {
  if (mp.fitOn === 'here') return m.fits !== 'no';
  const p = fitPc();
  return !p || fitsThere(m.bytes, p) !== 'no';
}
/** A size's mark for the linked PC picked under Fits ("✓ fits Worker PC"). */
function thereText(m) {
  const p = fitPc();
  if (!p || !m.bytes) return '';
  const f = fitsThere(m.bytes, p);
  const name = pcLabel(p, linkedPcs());
  return f === 'ok' ? `✓ fits ${name}` : f === 'tight' ? `▲ tight on ${name}` : `✕ too big for ${name}`;
}
/** The Fits drop-down: All, This PC, then each linked PC (one that is off is listed, not pickable: its memory is not known). */
function drawFitOn() {
  const box = $('#mp-fit-on');
  const all = linkedPcs();
  const opts = [['', 'All', false], ['here', 'This PC', false], ...all.map(p => [p.id, `${pcLabel(p, all)}${p.ram > 0 ? p.backupsOnly ? ' (backups only)' : '' : ' (off: its memory is not known)'}`, !(p.ram > 0)])];
  const sig = JSON.stringify(opts);
  if (box.dataset.sig !== sig) {
    box.dataset.sig = sig;
    box.replaceChildren(...opts.map(([value, text, off]) => el('option', { value, text, disabled: off })));
  }
  // A PC that went off (or was removed) since it was picked: Fits shows all again.
  if (mp.fitOn && mp.fitOn !== 'here' && !fitPc()) mp.fitOn = '';
  box.value = mp.fitOn;
}

/** True when no size filter is set (Fits my card and Fits count as one). */
const noFilter = () => !mp.f.minB && !mp.f.maxB && !mp.f.minGB && !mp.f.maxGB && !mp.card && !mp.fitOn;
const inB = p => (!mp.f.minB || p >= mp.f.minB * 0.95e9) && (!mp.f.maxB || p <= mp.f.maxB * 1.05e9);
const inGB = bytes => (!mp.f.minGB || bytes >= mp.f.minGB * 2 ** 30) && (!mp.f.maxGB || bytes <= mp.f.maxGB * 2 ** 30);
/** A size filter on an item whose figures are known: false only when a known figure is outside it. Unknown = hidden while a filter is set. */
function passes(params, sizes) {
  if (noFilter()) return true;
  if ((mp.f.minB || mp.f.maxB) && (params == null || !inB(params))) return false;
  if ((mp.f.minGB || mp.f.maxGB || mp.card || mp.fitOn) && !(sizes ?? []).some(sizeOk)) return false;
  return true;
}
/** A size ({bytes, card, fits}) inside the GB filter, with Fits my card ticked wholly on the card, and inside Fits. */
function sizeOk(m) {
  return inGB(m.bytes) && (!mp.card || m.card === 'ok') && fitsOn(m);
}
/** The size a row shows and downloads: the recommended one, or, with a filter set and the recommended one outside it, the biggest size inside it. */
function shownSize(s) {
  const u = s.models.find(m => m.name === s.usual) ?? s.models[0];
  if (noFilter() || sizeOk(u)) return u;
  return s.models.filter(sizeOk).sort((a, b) => b.bytes - a.bytes)[0] ?? u;
}
function filterText() {
  const r = (a, b, unit) => (a && b ? `${a} to ${b}${unit}` : a ? `${a}${unit} or more` : b ? `up to ${b}${unit}` : '');
  const p = fitPc();
  return [r(mp.f.minB, mp.f.maxB, 'B'), r(mp.f.minGB, mp.f.maxGB, ' GB download'), mp.card && mp.cards?.n ? `fits the ${cardWord()}` : '', mp.fitOn === 'here' ? 'fits this PC' : p ? `fits ${pcLabel(p, linkedPcs())}` : ''].filter(Boolean).join(', ');
}

// ---- The download in progress: the button that started it turns into its progress ----

const jobFor = (repo, name) => (mp.job && mp.job.repo === repo && mp.job.name === name ? mp.job : null);
const busyNow = () => mp.job?.state === 'downloading';

/** What sits where a size's Download button was: the button, its progress (with Stop), or "On this PC". */
function sizeAction(repo, rev, m, primary) {
  return withTo(`hf|${repo}|${m.name}`, sizeHere(repo, rev, m, primary), { kind: 'chat', repo, rev, name: m.name, what: `${repo.split('/')[1]} ${shortQuant(m.name)}` }, m.bytes, primary);
}
/** Download to This PC (Hugging Face): the button, or the download's progress once it runs. */
function sizeHere(repo, rev, m, primary) {
  const j = jobFor(repo, m.name);
  if (m.have || j?.state === 'done') return el('span', { class: 'hint ok mp-have', text: j?.state === 'done' ? '✓ Downloaded and checked' : '✓ On this PC' });
  if (j?.state === 'downloading') {
    const pc = j.bytes ? Math.floor((j.got / j.bytes) * 100) : 0;
    return el('div', { class: 'dl-now', 'data-dl': `${repo}|${m.name}` },
      el('div', { class: 'dl-track', role: 'progressbar', 'aria-label': `Downloading ${m.name}`, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pc) }, el('span', { class: 'dl-fill', style: null })),
      el('span', { class: 'dl-text', text: `Downloading ${pc}% of ${MP_GB(j.bytes)}` }),
      el('button', { class: 'btn quiet', type: 'button', text: 'Stop', onclick: mpStop }));
  }
  const failed = j && (j.state === 'failed' || j.state === 'stopped');
  const btn = el('button', {
    class: `btn${primary && m.fits !== 'no' ? ' primary' : ''}`, type: 'button',
    text: failed ? `Download again · ${MP_GB(m.bytes)}` : `Download ${MP_GB(m.bytes)}`,
    title: busyNow() ? `Wait for ${mp.job.name} to finish downloading, or stop it.` : `Downloads ${m.name} (${MP_GB(m.bytes)}) from Hugging Face into TOMLIN's models folder. Each file is checked before it is kept.`,
    disabled: busyNow(),
    onclick: e => mpGet(repo, rev, m.name, e.currentTarget),
  });
  return failed ? el('div', { class: 'dl-now' }, btn, el('span', { class: j.state === 'failed' ? 'fault-line' : 'hint', text: j.state === 'failed' ? `It failed: ${j.error}` : 'Stopped. Download it again to carry on from where it stopped.' })) : btn;
}

// ---- Download's To list: This PC, or a linked PC that downloads the model itself ----

const TO_WHY = { off: ' (off)', backups: ' (backups only)', old: ' (update it first)' };
/** The PC a row downloads to: picked on it, else the PC picked under Fits; '' (This PC) unless that PC can take it now. */
function toOf(key) {
  const v = mp.to.get(key) ?? (fitPc() ? mp.fitOn : '');
  return v && (mp.net ?? []).some(p => p.id === v && !p.fetchCode) ? v : '';
}
/** A linked PC's name in the To list (with its address when two share a name). */
function toName(id) {
  const all = (mp.net ?? []).map(p => ({ ...p, url: linkedPcs().find(x => x.id === p.id)?.url }));
  const p = all.find(x => x.id === id);
  return p ? pcLabel(p, all) : 'that PC';
}
/** The To list under a Download: This PC, then each linked PC (one that cannot take a download now is listed, not pickable, with why). */
function toPick(key) {
  const pcs = mp.net ?? [];
  if (!pcs.length) return null;
  const sel = el('select', { 'aria-label': 'Download to', onchange: e => { mp.to.set(key, e.target.value); mpDraw(); } },
    el('option', { value: '', text: 'This PC' }),
    ...pcs.map(p => el('option', { value: p.id, disabled: !!p.fetchCode, text: `${toName(p.id)}${TO_WHY[p.fetchCode] ?? ''}`, title: p.fetch || '' })));
  sel.value = toOf(key);
  return el('label', { class: 'mp-to' }, el('span', { text: 'To' }), sel);
}
/** A Download with its To list: on This PC the button it had; on a linked PC, one that asks that PC to download it itself. */
function withTo(key, here, ask, bytes, primary) {
  const pick = toPick(key);
  if (!pick) return here;
  const to = toOf(key);
  if (!to) return el('div', { class: 'mp-get' }, here, pick);
  const name = toName(to);
  const btn = el('button', {
    class: `btn${primary ? ' primary' : ''}`, type: 'button', text: `Download ${MP_GB(bytes)} to ${name}`,
    title: `${name} downloads it itself, from the internet, into its own models folder: nothing passes through this PC. Models on my other PCs shows how far it is, with Stop.`,
    onclick: async e => {
      const b = e.currentTarget;
      b.disabled = true;
      b.textContent = 'Starting…';
      try {
        await api('/api/network/fetch', { pc: to, ...ask });
        b.textContent = `Downloading on ${name}`;
        app.openNet?.();
      } catch (error) {
        b.replaceWith(el('span', { class: 'fault-line', text: error.message }));
      }
    },
  });
  return el('div', { class: 'mp-get' }, btn, pick);
}

// ---- Model runners: the NVIDIA (CUDA) one downloaded here, or sent to a linked PC with an NVIDIA card ----

/** A linked PC's reason it cannot take the runner now, in a word or two for the list. */
function runnerWord(why) {
  if (!why) return '';
  if (/already has it/.test(why)) return ' (has it)';
  if (/no NVIDIA card/.test(why)) return ' (no NVIDIA card)';
  if (/has no code for/.test(why)) return ' (card too old for it)';
  if (/driver/.test(why)) return ' (driver too old)';
  if (/older TOMLIN/.test(why)) return ' (update it first)';
  if (/Backups only/.test(why)) return ' (backups only)';
  if (/being used/.test(why)) return ' (in use)';
  return ' (off)';
}

/** Send to a linked PC: the PCs listed (those that cannot take it now with why), and Send, or Remove where it is already. */
function runnerPick(r) {
  const pcs = mp.net ?? [];
  if (!pcs.length) return null;
  // Each linked PC says how each CUDA build is there; an older TOMLIN says only how its CUDA 12.4 one is.
  const there = p => (p.runner?.pins ? p.runner.pins[r.id] : r.id === 'llama-cuda' ? { state: p.runner?.cuda } : null);
  const whyOf = p => p.runnerWhys?.[r.id] ?? p.runnerWhy;
  const has = p => there(p)?.state === 'installed';
  const usable = p => !whyOf(p) || has(p);
  const chosen = pcs.find(p => p.id === mp.runnerTo.get(r.id) && usable(p)) ?? pcs.find(p => !whyOf(p)) ?? pcs.find(has);
  const sel = el('select', { 'aria-label': `Send ${r.name} to`, onchange: e => { mp.runnerTo.set(r.id, e.target.value); mpDraw(); } },
    ...pcs.map(p => el('option', { value: p.id, disabled: !usable(p), text: `${toName(p.id)}${runnerWord(whyOf(p))}${p.runner?.best === r.id && !has(p) ? ' (suits its card)' : ''}`, title: whyOf(p) || '' })));
  if (chosen) sel.value = chosen.id;
  const said = el('span', { class: 'hint', role: 'status' });
  // No linked PC can take it now: the list says so, and the line beside it says why (one PC) or where to look (several).
  if (!chosen) {
    sel.prepend(el('option', { value: '', text: 'No linked PC can take it now' }));
    sel.value = '';
    said.textContent = pcs.length === 1 ? whyOf(pcs[0]) : 'Open the list to see why for each PC.';
  }
  let btn = null;
  if (chosen && has(chosen)) {
    btn = el('button', {
      class: 'btn quiet', type: 'button', text: `Remove from ${toName(chosen.id)}`,
      title: 'Takes the NVIDIA runner away from that PC: its models run on the graphics chip (Vulkan) again from their next load. You can send it again.',
      onclick: async e => {
        e.currentTarget.disabled = true;
        try {
          said.textContent = (await api('/api/network/runner-remove', { pc: chosen.id, id: r.id })).said;
          mpLoad();
        } catch (error) {
          said.textContent = error.message;
          said.className = 'fault-line';
        }
      },
    });
  } else if (chosen) {
    const name = toName(chosen.id);
    btn = el('button', {
      class: 'btn primary', type: 'button', text: r.zips ? `Send to ${name}` : `Download ${MP_GB(r.bytes)} here, then send to ${name}`,
      title: `${r.zips ? 'Sends' : 'Downloads it to this PC (checked), then sends'} it to ${name} over your home network. ${name} checks every file against the build its own TOMLIN names before it unpacks it. Network shows how far it is, with Stop.`,
      onclick: async e => {
        const b = e.currentTarget;
        b.disabled = true;
        b.textContent = 'Starting…';
        try {
          await api('/api/network/runner', { pc: chosen.id, id: r.id });
          b.textContent = `Sending to ${name}`;
          app.openNet?.();
        } catch (error) {
          b.replaceWith(el('span', { class: 'fault-line', text: error.message }));
        }
      },
    });
  }
  return el('div', { class: 'mp-get' }, el('label', { class: 'mp-to' }, el('span', { text: 'Send to' }), sel), btn, said);
}

/**
 * A runner row's buttons: Download (a CUDA one only with an NVIDIA card here; a Vulkan one for any card) or Remove (CUDA
 * only: Vulkan may have come with TOMLIN) on this PC, and Send to a linked PC (CUDA only).
 */
function runnerButtons(r) {
  if (r.device !== 'cuda' && r.device !== 'vulkan') return null;
  const parts = [];
  const g = r.getting;
  if (g && !g.done && !g.error) {
    const pc = g.bytes ? Math.floor((g.got / g.bytes) * 100) : 0;
    parts.push(el('div', { class: 'dl-now' },
      el('div', { class: 'dl-track', role: 'progressbar', 'aria-label': `Downloading ${r.name}`, 'aria-valuenow': String(pc) }, el('span', { class: 'dl-fill', 'data-w': String(pc) })),
      el('span', { class: 'dl-text', text: `${g.checking ? 'Checking' : 'Downloading'} ${pc}% of ${MP_GB(g.bytes)}` }),
      el('button', { class: 'btn quiet', type: 'button', text: 'Stop', onclick: async () => { await api('/api/runtimes/stop', { id: r.id }); mpLoad(); } })));
  } else if (r.device === 'cuda' && (r.installed || r.zips)) {
    parts.push(el('button', {
      class: 'btn quiet', type: 'button', text: r.installed ? 'Remove from this PC' : 'Remove its files from this PC',
      title: r.installed ? 'Takes the NVIDIA runner off this PC (and its kept files): models run on the graphics chip (Vulkan) again from their next load.' : `Deletes the ${MP_GB(r.bytes)} of files kept here for sending to another PC.`,
      onclick: async e => {
        e.currentTarget.disabled = true;
        try {
          await api('/api/runtimes/remove', { id: r.id });
        } catch (error) {
          e.target.replaceWith(el('span', { class: 'fault-line', text: error.message }));
          return;
        }
        mpLoad();
      },
    }));
  }
  if (!r.installed && !r.why && !(g && !g.done && !g.error)) {
    parts.push(el('button', {
      class: 'btn primary', type: 'button', text: `Download ${MP_GB(r.bytes)}`,
      title: `Downloads it from the ${r.engine === 'sd' ? 'stable-diffusion.cpp' : 'llama.cpp'} release on GitHub, checks each file by SHA-256 and unpacks it for this PC. The next model loaded uses it.`,
      onclick: async e => {
        e.currentTarget.disabled = true;
        e.currentTarget.textContent = 'Starting…';
        try {
          await api('/api/runtimes/get', { id: r.id });
        } catch (error) {
          e.target.replaceWith(el('span', { class: 'fault-line', text: error.message }));
          return;
        }
        mpLoad();
      },
    }));
  }
  // Sending between PCs: the chat runner only (a node says how its chat runner is, not its picture one).
  const pick = r.engine === 'llama' && r.device === 'cuda' ? runnerPick(r) : null;
  if (pick) parts.push(pick);
  return parts.length ? el('div', { class: 'mp-get' }, ...parts) : null;
}

/** What a runner row says under its name. */
function runnerMore(r) {
  if (r.device === 'vulkan') return r.installed ? [] : [`For any graphics card (AMD, Intel or NVIDIA): ${r.engine === 'sd' ? 'pictures' : 'chat'} on the card instead of the CPU.`, ...(r.getting?.error ? [`✕ ${r.getting.error}`] : []), `Licence: ${r.licence}.`];
  if (r.device !== 'cuda') return r.installed ? [] : [`To install it, close TOMLIN and run: npm run fetch -- ${r.id}`];
  const more = [
    r.engine !== 'llama' ? 'For NVIDIA cards from the GTX 10 series (Pascal) on, with code made for each up to the RTX 50 series: usually faster than the graphics chip (Vulkan) runner. Auto uses it once it is here.'
      : r.cuda === '13.4' ? 'For NVIDIA cards from the RTX 20 and GTX 16 series on, with code made for RTX 30, 40 and 50 cards. Not for GTX 10 series (Pascal) cards or older.'
        : 'For NVIDIA cards, older ones too (GTX 750 and newer): RTX 30 and 40 cards have code made for them, other cards have it compiled at their first start.',
  ];
  if (r.engine === 'llama' && r.best) more.push(r.installed ? '★ The one that suits this PC\'s card: Auto starts models on it.' : '★ The one that suits this PC\'s card.');
  else if (r.engine === 'llama' && r.installed && !r.why) more.push('Auto uses the CUDA build that suits the card first; the speed finder tries this one too, and recommends it for a model it runs faster.');
  if (r.why) more.push(r.why);
  if (r.getting?.error) more.push(`✕ ${r.getting.error}`);
  if (r.zips) more.push(`Its files (${MP_GB(r.bytes)}) are kept here for sending to another PC.`);
  more.push(`Licence: ${r.licence}.`);
  return more;
}

/** The progress bars and percentages on the page, moved on without drawing the list again (a click is never lost). */
function mpPaintJob() {
  const j = mp.job;
  if (!j || j.state !== 'downloading') return;
  const pc = j.bytes ? Math.floor((j.got / j.bytes) * 100) : 0;
  for (const box of document.querySelectorAll(`[data-dl="${CSS.escape(`${j.repo}|${j.name}`)}"]`)) {
    box.querySelector('.dl-fill').style.width = `${pc}%`;
    box.querySelector('.dl-track').setAttribute('aria-valuenow', String(pc));
    box.querySelector('.dl-text').textContent = `Downloading ${pc}% of ${MP_GB(j.bytes)}`;
  }
  const top = $('#mp-job .dl-fill');
  if (top) top.style.width = `${pc}%`;
  const line = $('#mp-job .dl-text');
  if (line) line.textContent = `Downloading ${j.name}: ${pc}% of ${MP_GB(j.bytes)}`;
}

/** The download card at the top of the page: stays in view while the list scrolls. */
function mpJobCard() {
  const box = $('#mp-job');
  const j = mp.job;
  $('#mp-stop').hidden = true;
  if (!j) return void box.replaceChildren();
  box.className = `mp-job${j.state === 'downloading' ? ' on' : j.state === 'done' ? ' done' : ''}`;
  const pc = j.bytes ? Math.floor((j.got / j.bytes) * 100) : 0;
  if (j.state === 'downloading') {
    box.replaceChildren(
      el('span', { class: 'dl-text', text: `Downloading ${j.name}: ${pc}% of ${MP_GB(j.bytes)}` }),
      el('div', { class: 'dl-track', 'aria-hidden': 'true' }, el('span', { class: 'dl-fill' })),
      el('button', { class: 'btn quiet', type: 'button', text: 'Stop', onclick: mpStop }));
    box.querySelector('.dl-fill').style.width = `${pc}%`;
  } else if (j.state === 'done') {
    // Done: it stands out (a green box), with a button straight to the staff to give it to.
    box.replaceChildren(el('span', { class: 'mp-done-text', text: `✓ ${j.name} is downloaded and checked. Assign this to a staff, or pick it in a chat.` }),
      app.seeAllStaff ? el('button', { class: 'btn primary', type: 'button', text: 'Edit staff', title: 'Opens All staff: press Edit beside someone, then Works on, to give them this model', onclick: () => app.seeAllStaff() }) : null);
  } else {
    box.replaceChildren(el('span', { class: j.state === 'failed' ? 'fault-line' : 'hint', text: j.state === 'stopped' ? `${j.name}: stopped. Download it again to carry on from where it stopped.` : `${j.name}: the download failed. ${j.error}` }));
  }
}

async function mpGet(repo, rev, name, btn) {
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Starting…';
  }
  try {
    mpSetJob(await api('/api/chatmodels/get', { repo, rev, name }));
  } catch (e) {
    if (btn) btn.replaceWith(el('span', { class: 'fault-line', text: e.message }));
    else $('#mp-job').replaceChildren(el('span', { class: 'fault-line', text: e.message }));
  }
}
async function mpStop() {
  mpSetJob(await api('/api/chatmodels/stop', {}).catch(() => mp.job));
}

/** A new view of the download: the list is drawn again only when its state changes; while it runs, only the bars move. */
function mpSetJob(j) {
  const was = mp.job ? `${mp.job.repo}|${mp.job.name}|${mp.job.state}` : '';
  mp.job = j;
  clearTimeout(mp.timer);
  const now = j ? `${j.repo}|${j.name}|${j.state}` : '';
  if (now !== was) {
    // A finished download is on this PC now: its sizes are read again so every row says so.
    if (j?.state === 'done' && j.repo) {
      delete mp.sizes[j.repo];
      mpLoad().then(() => loadModels()).catch(() => undefined);
    }
    mpJobCard();
    mpDraw();
  } else {
    mpPaintJob();
  }
  if (j?.state === 'downloading') mp.timer = setTimeout(async () => mpSetJob(await api('/api/chatmodels/get').catch(() => mp.job)), 1000);
}

// ---- Every model as one item ----

/** Every model as one item: what it is, two short lines, the rest under "See more", its state and its button. */
function mpItems() {
  const d = mp.data;
  if (!d) return [];
  const items = [];
  const downloadBtn = x => {
    const dl = x.download;
    const moving = dl && !dl.done && !dl.error;
    if (x.installed) return null;
    if (moving) {
      const pc = Math.floor((dl.got / dl.bytes) * 100);
      return el('div', { class: 'dl-now' },
        el('div', { class: 'dl-track', role: 'progressbar', 'aria-label': `Downloading ${x.name}`, 'aria-valuenow': String(pc) }, el('span', { class: 'dl-fill', 'data-w': String(pc) })),
        el('span', { class: 'dl-text', text: `${dl.checking ? 'Checking' : 'Downloading'} ${pc}% of ${MP_GB(dl.bytes)}` }),
        el('button', { class: 'btn quiet', type: 'button', text: 'Stop', onclick: async () => { await api('/api/downloads/stop', { id: x.id }); mpLoad(); } }));
    }
    return el('button', { class: 'btn primary', type: 'button', text: `Download ${MP_GB(x.bytes)}`, onclick: async e => { e.currentTarget.disabled = true; e.currentTarget.textContent = 'Starting…'; try { await api('/api/downloads/start', { id: x.id }); } catch (error) { e.target.replaceWith(el('span', { class: 'fault-line', text: error.message })); return; } mpLoad(); } });
  };
  const regState = x => {
    const dl = x.download;
    if (x.installed) return '✓ On this PC';
    if (dl?.error) return `✕ ${dl.error}`;
    return '';
  };
  for (const x of d.image) {
    const more = [`Licence: ${x.licence}`];
    if (x.nonCommercial) more.push('▲ Non-commercial licence: not for a business website or blog.');
    if (x.hardwareFit) more.push(`${x.hardwareFit.level === 'ok' ? '✓' : x.hardwareFit.level === 'slow' ? '▲' : '✕'} ${x.hardwareFit.text}`);
    items.push({ id: `image:${x.id}`, kind: 'image', modes: x.modes ?? [], name: x.name.replace(/\s*\(.*\)$/, ''), tag: (/\((.*)\)$/.exec(x.name) ?? [])[1] ?? '', about: x.about ?? '', more, warn: x.nonCommercial || x.hardwareFit?.level === 'no', state: regState(x), button: withTo(`img|${x.id}`, downloadBtn(x), { kind: 'image', id: x.id, what: x.name.replace(/\s*\(.*\)$/, '') }, x.bytes, true), bytes: x.bytes });
  }
  for (const x of d.helpers) items.push({ id: `helper:${x.id}`, kind: 'helper', name: x.name, tag: '', about: x.about ?? '', more: [`Licence: ${x.licence}`], state: regState(x), button: downloadBtn(x), bytes: x.bytes });
  for (const c of d.chat) items.push({ id: `chat:${c.id}`, kind: 'chat', name: c.name, tag: MP_GB(c.bytes), about: c.where === 'ollama' ? 'From Ollama\'s models (the file stays where Ollama keeps it).' : c.where === 'other' ? 'From your other models folder (models-folder.txt); the file stays there.' : 'In TOMLIN\'s models folder.', more: [`File: ${c.id}`, cardText(c)].filter(Boolean), state: '✓ On this PC', button: null, params: paramsFromName(c.name), bytes: c.bytes, card: c.card ?? null, moe: !!c.moe });
  for (const r of mp.runners ?? d.runtimes) items.push({ id: `runner:${r.id}`, kind: 'runner', name: r.name, tag: '', about: r.installed ? 'Installed: it runs the models.' : `Not on this PC (${MP_GB(r.bytes)}).`, more: runnerMore(r), state: r.installed ? '✓ Installed' : 'Not installed', button: runnerButtons(r) });
  for (const p of POPULAR) items.push({ id: `popular:${p.repo}`, kind: 'popular', name: p.name, tag: 'Suggested', about: p.about, more: [`From huggingface.co/${p.repo}.`], repo: p.repo });
  return items;
}

/** On this PC now (Installed / Not installed): a model found here (its own folder or another), or a suggestion one of whose sizes is downloaded. */
const onThisPc = x => (x.kind === 'popular' ? !!mp.sizes[x.repo]?.models?.some(m => m.have) : /^✓/.test(x.state ?? ''));

const inCat = (x, cat) => (cat === 'chat' ? x.kind === 'chat' || x.kind === 'popular' : x.kind === cat);
/** In any ticked category (none ticked: every model). */
const inCats = x => !mp.cats.size || [...mp.cats].some(c => inCat(x, c));
/** Hugging Face's chat models belong in the list: no category ticked, or Chat models. */
const hfInCats = () => !mp.cats.size || mp.cats.has('chat');

/** A Hugging Face model's line under its name: "9B · Q4_K_M 5.6 GB · ✓ fits this PC", read before anything is pressed. */
function hfLine(x) {
  const s = mp.sizes[x.repo];
  const params = s?.params ?? x.params ?? paramsFromName(x.repo.split('/')[1]) ?? paramsFromName(x.name);
  if (!s || s.busy) return `${params ? `${paramsText(params)} · ` : ''}Reading its sizes on Hugging Face…`;
  if (s.error) return `${params ? `${paramsText(params)} · ` : ''}Its sizes could not be read: ${s.error}`;
  const u = shownSize(s);
  return [params ? paramsText(params) : '', `${shortQuant(u.name)} ${MP_GB(u.bytes)}${u.name === s.usual && s.models.length > 1 ? ' - recommended' : ''}`, fitsText(u.fits), cardText(u), thereText(u)].filter(Boolean).join(' · ');
}
/** "Qwen3.5-9B-Q4_K_M" -> "Q4_K_M": the size's own name, when the file names one. */
const shortQuant = name => ([...name.matchAll(/(?:^|[-_.])((?:UD-)?(?:I?Q\d(?:_[A-Z0-9]+)*|F16|BF16|F32|MXFP4\w*|NVFP4\w*))(?=$|[-_.])/gi)].at(-1)?.[1].toUpperCase() ?? name);

/** A Hugging Face model row: its sizes, Download (the recommended size, one press), and every size folded away. */
function hfRow(x) {
  const s = mp.sizes[x.repo];
  const ready = s && !s.busy && !s.error;
  const u = ready ? shownSize(s) : null;
  const open = mp.open.has(x.id);
  const others = ready && s.models.length > 1;
  const side = el('div', { class: 'model-side' });
  if (u) side.append(sizeAction(x.repo, s.rev, u, true));
  const row = el('article', { class: `model-row mp-row${u?.fits === 'no' ? ' wont-fit' : ''}` },
    el('div', { class: 'mp-text' },
      el('div', { class: 'mp-name' }, el('b', { text: x.name }), x.tag ? el('span', { class: 'mp-tag', text: x.tag }) : null),
      el('p', { class: 'mp-size', text: hfLine(x) }),
      el('p', { class: `mp-about${open ? ' open' : ''}`, text: x.about }),
      el('div', { class: 'mp-links' },
        others ? el('button', { class: 'link', type: 'button', 'aria-expanded': String(mp.more.has(x.repo)), text: mp.more.has(x.repo) ? 'Hide the sizes' : `Available in (${s.models.length}) sizes.`, onclick: () => { if (mp.more.has(x.repo)) mp.more.delete(x.repo); else mp.more.add(x.repo); mpDraw(); } }) : null,
        el('button', { class: 'link mp-more-btn', type: 'button', 'aria-expanded': String(open), onclick: () => { if (open) mp.open.delete(x.id); else mp.open.add(x.id); mpDraw(); } }, el('span', { class: 'mp-i', 'aria-hidden': 'true', text: 'i' }), open ? ' See less' : ' See more')),
      open ? el('div', { class: 'mp-more' },
        el('p', { class: 'hint mp-src' }, `${ready ? `Licence: ${s.licence}. ` : ''}From huggingface.co/${x.repo}. `,
          el('a', { class: 'btn mp-hf-link', href: `https://huggingface.co/${x.repo}`, target: '_blank', rel: 'noopener noreferrer', text: 'Open on Hugging Face' })),
        el('p', { class: 'hint', text: 'Q4_K_M is recommended: about a quarter of the full size, little loss.' })) : null),
    side);
  if (others && mp.more.has(x.repo)) return [row, mpSizes(x.repo, x.name)];
  return [row];
}

/** All of a repo's sizes, smallest first ("Qwen3.5 0.8B Q4_K_M 0.5 GB - recommended"): each with whether it fits and its own Download. */
function mpSizes(repo, name) {
  const s = mp.sizes[repo];
  const box = el('div', { class: 'mp-files' }, el('p', { class: 'hint', text: 'Smaller sizes lose more; bigger ones need more memory.' }));
  for (const m of s.models) {
    box.append(el('div', { class: `job-remote${m.name === s.usual ? ' mp-pick' : ''}` },
      el('span', { text: `${name} ${shortQuant(m.name)} ${MP_GB(m.bytes)}${m.name === s.usual ? ' - recommended' : ''}` }),
      el('span', { class: 'hint', text: [fitsText(m.fits), cardText(m), thereText(m)].filter(Boolean).join(' · ') }),
      sizeAction(repo, s.rev, m, false)));
  }
  return box;
}

function mpRow(x) {
  if (x.repo) return hfRow(x);
  const open = mp.open.has(x.id);
  const moreId = `mp-more-${x.id.replace(/[^a-z0-9]/gi, '-')}`;
  const full = [x.about, ...x.more].filter(Boolean).join('\n');
  const toggle = x.more.length || x.about.length > 140
    ? el('button', { class: 'link mp-more-btn', type: 'button', 'aria-expanded': String(open), 'aria-controls': moreId, title: full, onclick: () => { if (open) mp.open.delete(x.id); else mp.open.add(x.id); mpDraw(); } }, el('span', { class: 'mp-i', 'aria-hidden': 'true', text: 'i' }), open ? ' See less' : ' See more')
    : null;
  const row = el('article', { class: `model-row mp-row${x.warn ? ' wont-fit' : ''}` },
    el('div', { class: 'mp-text' },
      el('div', { class: 'mp-name' }, el('b', { text: x.name }), x.tag ? el('span', { class: 'mp-tag', text: x.tag }) : null),
      el('p', { class: `mp-about${open ? ' open' : ''}`, text: x.about, title: open ? '' : full }),
      open ? el('div', { class: 'mp-more', id: moreId }, ...x.more.map(t => el('p', { class: t.startsWith('▲') || t.startsWith('✕') ? 'warn-line' : 'hint', text: t }))) : null,
      toggle),
    el('div', { class: 'model-side' }, x.state ? el('span', { class: 'hint', text: x.state }) : null, x.button));
  return [row];
}

/**
 * Every typed word at the start of a word in the row, in any order: "all" does not find "small" or "Installed", and
 * "llama 3b" finds Llama 3.2 3B. A number may start a word straight after letters ("3.5" finds Qwen3.5).
 */
function mpMatches(x, q) {
  const text = `${x.name} ${x.tag} ${x.about} ${x.more.join(' ')}`.toLowerCase();
  return q.split(/\s+/).every(w => new RegExp(`(?:^|[^a-z0-9]|(?<=[a-z])(?=\\d))${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text));
}

/** The list's heading: the words or the ticked categories, then each other filter ("Chat models, up to 2B, Abliterated"). */
function mpTitle(q, filtering) {
  const cats = [...mp.cats].map(c => CAT_NAME[c]).join(' + ');
  return [
    q ? `Search: "${mp.q.trim()}"` : cats || (filtering ? 'Chat models' : 'All models'),
    q ? cats : '',
    filtering ? filterText() : '',
    [...mp.terms].map(t => TERM_NAME[t]).join(' or '),
    mp.moe ? "Mixture-of-experts" : '',
    { only: 'installed only', hide: 'not installed yet' }[mp.show] ?? '',
  ].filter(Boolean).join(', ');
}

/** What Size orders by: the download (a suggestion: its recommended size, once read); unknown goes last. */
const sizeOf = x => (x.kind === 'popular' ? (s => (s?.models?.length ? shownSize(s).bytes : null))(mp.sizes[x.repo]) : x.bytes) ?? null;
/** The list in the order picked (as it comes when none is). */
function mpOrdered(items) {
  const [by, dir] = mp.order.split('-');
  if (!by) return items;
  const k = dir === 'desc' ? -1 : 1;
  return [...items].sort((a, b) => {
    if (by === 'name') return k * a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    const x = sizeOf(a);
    const y = sizeOf(b);
    return (x == null) - (y == null) || k * ((x ?? 0) - (y ?? 0));
  });
}
const ORDER_WORDS = { 'size-asc': 'smallest first', 'size-desc': 'largest first', 'name-asc': 'A to Z', 'name-desc': 'Z to A' };
/** The two order buttons: pressed shows which way it runs now; pressed again, the other way. */
function mpOrderButtons(importing) {
  $('#mp-order').hidden = importing;
  const [by, dir] = mp.order.split('-');
  for (const b of document.querySelectorAll('#mp-order [data-order]')) {
    const on = b.dataset.order === by;
    b.setAttribute('aria-pressed', String(on));
    b.textContent = b.dataset.order === 'size' ? (on ? (dir === 'desc' ? 'Size: largest first' : 'Size: smallest first') : 'Size') : on && dir === 'desc' ? 'Z to A' : 'A to Z';
    b.title = b.dataset.order === 'size'
      ? `Order by size${on ? `: ${dir === 'desc' ? 'largest' : 'smallest'} first now. Press again for ${dir === 'desc' ? 'smallest' : 'largest'} first` : ', smallest first (press again for largest first)'}`
      : `Order by name${on ? `: ${dir === 'desc' ? 'Z to A' : 'A to Z'} now. Press again for ${dir === 'desc' ? 'A to Z' : 'Z to A'}` : ', A to Z (press again for Z to A)'}`;
  }
}

function mpDraw() {
  mpNav();
  const q = mp.q.trim().toLowerCase();
  // "all": every model here, whatever the category, and every chat model on Hugging Face below them.
  const every = q === 'all';
  const filtering = !noFilter();
  // A size filter is about chat models: picture models, helpers and runners have no "B".
  const items = mpOrdered(mpItems().filter(x => {
    if (filtering && x.kind !== 'chat' && x.kind !== 'popular') return false;
    if (mp.moe && !isMoeItem(x)) return false;
    if (q && !every && !mpMatches(x, q)) return false;
    if (!inCats(x)) return false;
    if (mp.terms.size && ![...mp.terms].some(t => mpMatches(x, t))) return false;
    if (mp.show !== 'all' && (mp.show === 'only') !== onThisPc(x)) return false;
    if (!filtering) return true;
    if (x.kind === 'popular') {
      const s = mp.sizes[x.repo];
      return passes(s?.params ?? paramsFromName(x.name), s?.models);
    }
    return passes(x.params, [x]);
  }));
  // Import models: the page is the two tiles (Download, Connect), not a list.
  const importing = mp.importing && !q && !filtering && !mp.terms.size && !mp.moe;
  mpOrderButtons(importing);
  $('#mp-import').setAttribute('aria-current', String(importing));
  for (const b of document.querySelectorAll('#mp-show [data-show]')) b.setAttribute('aria-pressed', String(b.dataset.show === mp.show));
  $('#mp-heading').textContent = importing ? 'Import from another folder' : mpTitle(q, filtering);
  $('#mp-filter-clear').hidden = !filtering;
  $('#mp-folder-box').hidden = !importing;
  const list = $('#mp-list');
  list.hidden = importing;
  const parts = [];
  if (!items.length && !importing) parts.push(el('p', { class: 'hint', text: q || filtering || mp.terms.size || mp.moe || mp.cats.size ? 'Nothing on this PC or in the suggestions matches.' : mp.show === 'only' ? 'None of these is on this PC.' : mp.show === 'hide' ? 'Every one of these is on this PC already.' : 'Nothing here yet.' }));
  for (const x of items) parts.push(...mpRow(x));
  if ((q || filtering || mp.terms.size || mp.moe) && hfInCats()) parts.push(...mpHfRows(items));
  list.replaceChildren(...parts);
  for (const f of list.querySelectorAll('.dl-fill[data-w]')) f.style.width = `${f.dataset.w}%`;
  mpPaintJob();
}

// ---- Hugging Face: every GGUF chat model matching the words and sizes, a page at a time ----

const hfKey = () => JSON.stringify([mp.q.trim(), mp.f, [...mp.terms].sort(), mp.moe, mp.card, fitAsk(), mp.order, mp.list?.scannedAt ?? null]);
/** Fits as the search asks it: 'here', or the linked PC's memory (the server judges each size with the same sum). */
const fitAsk = () => (mp.fitOn === 'here' ? 'here' : (p => (p ? { ram: p.ram, vram: p.vram ?? 0 } : undefined))(fitPc()));

const MP_DAY = iso => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const MP_WHEN = iso => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** The line under the search: "File list from 5 Oct 2026." with Rescan Hugging Face (or the scan's progress and Stop). */
function mpListLine() {
  const l = mp.list;
  const line = $('#mp-hf-list');
  if (!l) return line.replaceChildren();
  const btn = (text, path) => el('button', { class: 'link', type: 'button', text, onclick: async () => { mp.list = await api(path, {}).catch(e => ({ ...mp.list, error: e.message })); mpListLine(); mpListWatch(); } });
  if (l.scanning) {
    return line.replaceChildren(`Scanning Hugging Face: ${l.scanning.read.toLocaleString()} models read, ${l.scanning.kept.toLocaleString()} chat models kept so far… `, btn('Stop', '/api/hflist/stop'));
  }
  line.title = l.scannedAt ? `${l.count.toLocaleString()} chat models on Hugging Face, scanned ${MP_WHEN(l.scannedAt)}` : '';
  if (l.scannedAt) line.replaceChildren(`File list from ${MP_DAY(l.scannedAt)}. `, btn('Rescan Hugging Face', '/api/hflist/scan'));
  else line.replaceChildren('No Hugging Face list on this PC yet: each search asks Hugging Face. ', btn('Scan Hugging Face', '/api/hflist/scan'), ' (about 70 MB, a minute or two).');
  if (l.error) line.append(el('span', { class: 'fault-line mp-list-fault', text: ` ${l.error}` }));
}

/** While a scan runs, its progress is asked for each second; when it ends, the search is asked again on the new list. */
function mpListWatch() {
  clearTimeout(mp.listTimer);
  if (!mp.list?.scanning) return;
  mp.listTimer = setTimeout(async () => {
    const was = mp.list.scannedAt;
    mp.list = await api('/api/hflist').catch(() => mp.list);
    mpListLine();
    if (mp.list.scanning) return mpListWatch();
    if (mp.list.scannedAt !== was) {
      mpDraw();
      mpHfSearch(true);
    }
  }, 1000);
}

/** A search also asks Hugging Face: GGUF chat models matching the words and sizes, not only the suggestions. */
function mpHfRows(shown) {
  const hf = mp.hf;
  const every = /^all$/i.test(mp.q.trim());
  const total = hf.key === hfKey() && hf.total != null ? `: ${hf.total.toLocaleString()} chat model${hf.total === 1 ? '' : 's'} on the list match` : '';
  const out = [el('h3', { class: 'mp-hf-head', id: 'mp-hf-head', tabindex: '-1', text: `On Hugging Face${total || ` (${every ? 'every chat model' : 'chat models'})`}, ${mp.order ? `${hf.pageOrder ? 'each page ' : ''}${ORDER_WORDS[mp.order]}` : 'most downloaded first'}${hf.key === hfKey() && hf.page ? `, page ${hf.page + 1}` : ''}` })];
  if (hf.key !== hfKey() || hf.busy) return [...out, el('p', { class: 'hint', text: 'Searching Hugging Face and reading each model\'s sizes…' })];
  if (hf.error) return [...out, el('p', { class: 'fault-line', text: hf.error }), mpPager()].filter(Boolean);
  const have = new Set(shown.map(x => x.repo).filter(Boolean));
  const found = hf.found.filter(f => !have.has(f.repo) && (mp.show === 'all' || (mp.show === 'only') === onThisPc({ kind: 'popular', repo: f.repo })));
  const tips = `${mp.q.trim() && !every ? ' Try fewer or other words (for example llama 3b, or mistral)' : ''}${!noFilter() ? `${mp.q.trim() && !every ? ', or' : ' Try'} a wider size` : ''}${(mp.q.trim() && !every) || !noFilter() ? '.' : ''}`;
  if (!found.length && !hf.note) out.push(el('p', { class: 'hint', text: hf.next ? 'Nothing to show on this page. Next has more.' : hf.page ? `No more on Hugging Face.${tips}` : `Nothing on Hugging Face matches.${tips}` }));
  for (const f of found) {
    out.push(...hfRow({ id: `hf:${f.repo}`, name: f.repo.split('/')[1].replace(/-GGUF$/i, ''), tag: f.repo.split('/')[0], about: `${f.downloads.toLocaleString()} downloads on Hugging Face. Not checked by TOMLIN: read the licence before using it for work.`, more: [`From huggingface.co/${f.repo}.`], repo: f.repo, params: f.params }));
  }
  // Hugging Face turned this PC away part-way (429): the page says so, and Next carries on from there.
  if (hf.note) out.push(el('p', { class: 'fault-line', text: hf.note }));
  return [...out, mpPager()].filter(Boolean);
}

/**
 * Previous, the page numbers reached so far, Next. Hugging Face hands out the next page only from the one before it,
 * so a page is reached by walking to it; the numbers already walked go straight back.
 */
function mpPager() {
  const hf = mp.hf;
  if (!hf.page && !hf.next) return null;
  const go = i => () => mpHfAsk(hf.key, i, true);
  return el('nav', { class: 'g-shelves mp-pager', 'aria-label': 'Hugging Face pages' },
    hf.page ? el('button', { class: 'g-shelf', type: 'button', text: '‹ Previous', onclick: go(hf.page - 1) }) : null,
    ...hf.cursors.map((_, i) => el('button', { class: 'g-shelf', type: 'button', text: String(i + 1), 'aria-current': i === hf.page ? 'page' : null, 'aria-label': `Page ${i + 1}`, onclick: go(i) })),
    hf.next ? el('button', { class: 'g-shelf', type: 'button', text: 'Next ›', onclick: go(hf.page + 1) }) : hf.error ? null : el('span', { class: 'hint mp-pager-end', text: 'Last page' }));
}

/** Asks Hugging Face for page `i` of the answer to `key`; `paged` (a pager button) brings the page's heading into view. */
async function mpHfAsk(key, i, paged = false) {
  const cursors = mp.hf.key === key ? mp.hf.cursors : [null];
  // seen[i]: the repos page i showed. Two ticked terms are two searches, so a model named with both can come again later.
  const seen = mp.hf.key === key ? mp.hf.seen : [];
  if (i < 0 || i >= cursors.length) return;
  mp.hf = { key, busy: true, found: [], error: '', page: i, cursors, next: false, seen };
  mpDraw();
  if (paged) $('#mp-hf-head')?.focus();
  try {
    const r = await api('/api/chatmodels/search', { q: mp.q.trim(), ...mp.f, terms: [...mp.terms], moe: mp.moe, card: mp.card, fitOn: fitAsk(), order: mp.order, cursor: cursors[i] });
    for (const f of r.found) mp.sizes[f.repo] = f;
    const before = new Set(seen.slice(0, i).flat());
    // Hugging Face's own search (no list on this PC) comes most downloaded first: Size and A to Z order each page here.
    const pageItem = f => ({ kind: 'hf', name: f.repo.split('/')[1], bytes: f.models?.length ? shownSize(f).bytes : null });
    const found = r.pageOrder ? mpOrdered(r.found.filter(f => !before.has(f.repo)).map(f => ({ ...pageItem(f), f }))).map(x => x.f) : r.found.filter(f => !before.has(f.repo));
    const shown = [...seen];
    shown[i] = found.map(f => f.repo);
    // The page after this one is now known; a walk that went further keeps its numbers when it is the same page.
    const kept = cursors.slice(0, i + 1);
    if (r.next != null) kept.push(r.next, ...(JSON.stringify(cursors[i + 1]) === JSON.stringify(r.next) ? cursors.slice(i + 2) : []));
    if (hfKey() === key) mp.hf = { key, busy: false, found, error: '', page: i, cursors: kept, next: r.next != null, seen: shown, total: r.total ?? null, note: r.note ?? '', pageOrder: !!r.pageOrder };
  } catch (e) {
    if (hfKey() === key) mp.hf = { key, busy: false, found: [], error: e.message, page: i, cursors, next: false, seen };
  }
  if (hfKey() === key) {
    mpDraw();
    if (paged) $('#mp-hf-head')?.focus();
  }
}

function mpHfSearch(now = false) {
  clearTimeout(mp.hfTimer);
  const q = mp.q.trim();
  if (q.length < 2 && noFilter() && !mp.terms.size && !mp.moe) return;
  const key = hfKey();
  // Asked again with the same words and sizes (Search pressed after typing): the answer already here or coming stands,
  // unless it was a fault.
  if (now && mp.hf.key === key && !mp.hf.error) return;
  mp.hfTimer = setTimeout(() => mpHfAsk(key, 0), now ? 0 : 700);
}

/** The suggested chat models' sizes, read from Hugging Face once while the page is open. */
async function mpPopularSizes() {
  const want = POPULAR.map(p => p.repo).filter(r => !mp.sizes[r] || mp.sizes[r].error);
  if (!want.length) return;
  for (const r of want) mp.sizes[r] = { busy: true };
  try {
    const { sizes } = await api('/api/chatmodels/sizes', { repos: want });
    for (const s of sizes) mp.sizes[s.repo] = s.error ? { error: s.error } : s;
  } catch (e) {
    for (const r of want) mp.sizes[r] = { error: e.message };
  }
  mpDraw();
}

async function mpLoad() {
  const [d, m, j, l, rt] = await Promise.all([api('/api/downloads').catch(() => null), api('/api/models').catch(() => null), api('/api/chatmodels/get').catch(() => null), api('/api/hflist').catch(() => null), api('/api/runtimes').catch(() => null)]);
  if (d && m) mp.data = { image: d.image, helpers: d.helpers, chat: m.chat, runtimes: m.runtimes };
  if (rt) mp.runners = rt.runtimes;
  if (m) mp.cards = m.cards ?? null;
  if (m) mpFolderLine(m.folder, m.copies ?? [], m.ownFolder);
  if (l) {
    mp.list = l;
    mpListLine();
    mpListWatch();
  }
  // The list on this PC can be newer than the open search's answer (a scan finished while the page was away).
  mpHfSearch(true);
  mpSetJob(j);
  mpDraw();
  mpPopularSizes();
  // The To list asks each linked PC how it is (a PC that is off takes a few seconds): drawn again once it answers.
  api('/api/network').then(v => {
    mp.net = v.pcs ?? [];
    mpDraw();
  }).catch(() => undefined);
  // A picture-model download running: asked again each second while the page is open.
  const runnerGetting = (rt?.runtimes ?? []).some(r => r.getting && !r.getting.done && !r.getting.error);
  if (d && ([...d.image, ...d.helpers].some(x => x.download && !x.download.done && !x.download.error) || runnerGetting) && homeUi.view === 'models') setTimeout(mpLoad, 1000);
}

/** Which folders besides this copy's own are used: the chosen one, and older copies of TOMLIN beside this one. */
function mpFolderLine(folder, copies, own) {
  const parts = [];
  if (folder) parts.push(`Using models from ${folder}.`);
  if (copies.length) parts.push(`Also using models already in ${copies.length === 1 ? 'an older copy' : `${copies.length} older copies`} of TOMLIN beside this one (${copies.join(', ')}), so they are not downloaded again.`);
  $('#mp-folder-line').textContent = parts.join(' ');
  if (own) $('#mp-own-folder').textContent = own;
  $('#mp-folder-stop').hidden = !folder;
  if (folder && document.activeElement !== $('#mp-folder')) $('#mp-folder').value = folder;
}
$('#mp-folder-form').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const r = await api('/api/models/folder', { dir: $('#mp-folder').value });
    $('#mp-folder-line').textContent = `Using models from ${r.folder}: ${r.chat} chat model${r.chat === 1 ? '' : 's'} found there.`;
    await mpLoad();
    loadModels();
  } catch (error) {
    $('#mp-folder-line').textContent = error.message;
  }
});
$('#mp-folder-stop').addEventListener('click', async () => {
  await api('/api/models/folder', { dir: null }).catch(() => undefined);
  $('#mp-folder').value = '';
  await mpLoad();
  loadModels();
});

app.openModels = (cat = null) => {
  if (cat) {
    mp.cats = new Set(cat === 'all' ? [] : [cat]);
    mp.importing = false;
  }
  setView('models');
  $('#models-page').scrollTop = 0;
  mpLoad();
};
$('#mp-search').addEventListener('input', e => {
  mp.q = e.target.value;
  mpDraw();
  mpHfSearch();
});
// Search (or Enter in the box): the list as typed, and Hugging Face asked now rather than after the pause in typing.
$('#mp-search-form').addEventListener('submit', e => {
  e.preventDefault();
  mp.q = $('#mp-search').value;
  mpDraw();
  mpHfSearch(true);
});

// Size filters: from / to, in billions of parameters and in GB. Empty = any.
const filterBoxes = { minB: '#mp-min-b', maxB: '#mp-max-b', minGB: '#mp-min-gb', maxGB: '#mp-max-gb' };
for (const [k, sel] of Object.entries(filterBoxes)) {
  $(sel).addEventListener('input', e => {
    const v = Number(e.target.value);
    mp.f[k] = e.target.value.trim() && v > 0 ? v : null;
    mpDraw();
    mpHfSearch();
  });
}
function mpClearFilter() {
  for (const [k, sel] of Object.entries(filterBoxes)) {
    mp.f[k] = null;
    $(sel).value = '';
  }
  // Fits my card and Fits are filters too (they count in the list's heading): cleared with the sizes.
  mp.card = false;
  mp.fitOn = '';
  mpDraw();
}
$('#mp-filter-clear').addEventListener('click', () => {
  mpClearFilter();
  mpHfSearch();
});

$('#mp-stop').addEventListener('click', mpStop);
$('#mp-order').addEventListener('click', e => {
  const b = e.target.closest('[data-order]');
  if (!b) return;
  // Pressed once: smallest first (A to Z); pressed again: the other way round.
  const by = b.dataset.order;
  mp.order = mp.order === `${by}-asc` ? `${by}-desc` : `${by}-asc`;
  mpDraw();
  mpHfSearch(true);
});
$('#mp-show').addEventListener('click', e => {
  const b = e.target.closest('[data-show]');
  if (!b) return;
  mp.show = b.dataset.show;
  mpDraw();
});
