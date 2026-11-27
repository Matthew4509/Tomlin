// The Style picker's tiles (Images window, Character sets) and the Image styles strips (Hire staff, Edit staff: Move):
// each style's sample picture for a picture model, drawn from one prompt and seed (src/styles.ts), with the line of how
// it was drawn as its record says. A model with no sample for a style says so; another model's sample is shown only
// named as that model's. Uses app.js's helpers ($, el, api).
'use strict';
const stylePick = (() => {
  let data = null;
  let asking = null;
  /** The styles, samples and picture hires (GET /api/stylesamples); asked again when `fresh`. */
  async function load(fresh = false) {
    if (data && !fresh) return data;
    asking ??= api('/api/stylesamples').then(d => (data = d), () => data).finally(() => { asking = null; });
    return asking;
  }
  const now = () => data;
  const enc = encodeURIComponent;
  const fileOf = r => `/api/stylesamples/file?model=${enc(r.model)}&style=${enc(r.style)}&at=${enc(r.at)}`;

  // One larger picture for the page, shown beside the tile or strip picture that is hovered or has the keyboard.
  const pop = el('div', { class: 'style-pop', id: 'style-pop', role: 'tooltip', hidden: true });
  document.body.append(pop);
  function show(anchor, r, words) {
    pop.replaceChildren(...[r ? el('img', { src: fileOf(r), alt: `${r.style} sample by ${r.modelName}` }) : null, el('p', { text: words })].filter(Boolean));
    pop.hidden = false;
    // Inside a dialog, the pop goes into it, so it shows above the dialog's backdrop.
    const host = anchor.closest('dialog[open]') ?? document.body;
    if (pop.parentElement !== host) host.append(pop);
    const a = anchor.getBoundingClientRect();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    pop.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, a.left + a.width / 2 - w / 2))}px`;
    pop.style.top = `${a.bottom + 8 + h > window.innerHeight ? Math.max(8, a.top - h - 8) : a.bottom + 8}px`;
  }
  const hide = () => { pop.hidden = true; };
  /** Hover and keyboard focus show the larger picture and its line. */
  function hoverable(node, r, words) {
    node.setAttribute('aria-describedby', 'style-pop');
    node.addEventListener('mouseenter', () => show(node, r, words));
    node.addEventListener('focus', () => show(node, r, words));
    node.addEventListener('mouseleave', hide);
    node.addEventListener('blur', hide);
  }

  /** This model's sample for a style, else another model's (marked as not this one's), else none. */
  function sampleFor(model, style) {
    const own = model ? data?.samples?.[model]?.[style] : null;
    if (own) return { r: own, own: true };
    const other = Object.values(data?.samples ?? {}).map(s => s[style]).find(Boolean);
    return other ? { r: other, own: false } : null;
  }

  /** A style's line for video with this picture model (src/pairing.ts: Expected, or Seen with clips counted), or null. */
  const videoFit = (model, style) => (data?.video?.[model ?? ''] ?? data?.video?.[''])?.[style] ?? null;

  /**
   * The Style picker: one tile per style (its sample and its name), the one now picked pressed. `model` and
   * `modelName`: the model the artist draws with; `value`: the form value picked now; `pick(style)` when one is pressed.
   */
  function tiles({ model, modelName, value, pick }) {
    const name = modelName || 'this model';
    return (data?.styles ?? []).map(s => {
      const got = s.mode === 'auto' ? null : sampleFor(model, s.id);
      // A style with no sample says so once, above the tiles (missingLine), not under every tile.
      const note = s.mode === 'auto' ? s.about : !got ? '' : got.own ? '' : `Sample from ${got.r.modelName}, not yours`;
      const words = s.mode === 'auto' ? `${s.about}: the style comes from the words you type.` : !got ? `No sample yet for ${name}. ${s.about}.` : got.own ? got.r.line : `Sample from ${got.r.modelName}, not yours. ${got.r.line}`;
      const fit = videoFit(model, s.id);
      // Good start: green (the good colour); changes look: amber (the warn colour); depends: the soft ink.
      const b = el('button', { class: `style-tile${got && !got.own ? ' other' : ''}`, type: 'button', 'aria-pressed': String(s.value === value), 'data-style': s.id, onclick: () => pick(s) },
        got ? el('img', { src: fileOf(got.r), alt: '', loading: 'lazy' }) : el('span', { class: 'style-none', 'aria-hidden': 'true', text: s.mode === 'auto' ? 'A' : '?' }),
        el('strong', { text: s.name }),
        note ? el('small', { text: note }) : null,
        fit ? el('small', { class: `style-video ${fit.fit}`, text: fit.label }) : null);
      hoverable(b, got?.r ?? null, fit ? `${words} For video: ${fit.hover}` : words);
      return b;
    });
  }

  /**
   * The one line above the tiles for the styles with no sample at all for this model: '' when every style has one (its
   * own or another model's). `data`: what GET /api/stylesamples gave.
   */
  function missingLine(data, model, modelName) {
    const styles = (data?.styles ?? []).filter(s => s.mode !== 'auto');
    const own = model ? data?.samples?.[model] ?? {} : {};
    const any = id => !!own[id] || Object.values(data?.samples ?? {}).some(x => x?.[id]);
    const none = styles.filter(s => !any(s.id));
    if (!none.length) return '';
    const name = modelName || 'this model';
    return none.length === styles.length ? `No style samples yet for ${name}: the tiles show a ? until Make the style samples draws them.` : `No sample yet for ${name} in ${none.map(s => s.name).join(', ')} (the tiles with a ?).`;
  }

  /** A model's samples as a small strip, with the seconds each took; null when it has none. */
  function strip(model) {
    const mine = data?.samples?.[model];
    const styles = (data?.styles ?? []).filter(s => mine?.[s.id]);
    if (!styles.length) return null;
    return el('div', { class: 'style-strip' }, ...styles.map(s => {
      const r = mine[s.id];
      const b = el('button', { class: 'style-thumb', type: 'button', 'aria-label': `${s.name}: ${r.line}` },
        el('img', { src: fileOf(r), alt: '', loading: 'lazy' }), el('small', { text: `${s.name} · ${Math.max(1, Math.round(r.seconds))} s` }));
      hoverable(b, r, `${s.name}. ${r.line}`);
      return b;
    }));
  }

  /** How many styles have samples; the picture hires on a model. */
  const count = () => (data?.styles ?? []).filter(s => s.mode !== 'auto').length;
  const artistsOn = model => (data?.artists ?? []).filter(a => a.model === model);

  /** Queues one picture per style for the artist `as`; the words to show. */
  async function make(as) {
    const r = await api('/api/stylesamples/make', { as });
    return r.said;
  }

  return { load, now, tiles, strip, count, artistsOn, make, hide, videoFit, missing: (model, modelName) => missingLine(data, model, modelName) };
})();
