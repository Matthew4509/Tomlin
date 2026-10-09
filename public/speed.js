// How fast a model answers (src/speed.ts): the expected speed of a person, a linked PC or a model on this PC, the last
// speed test (the baseline), the average of real answers, and a small chart of the recent ones. Test speed runs one
// fixed example prompt (about 150 words) and times it. Uses app.js's helpers ($, el, api, app).
'use strict';

/** Which tests are running now, by who (a redraw every few seconds must not lose "Testing…"). */
const speedRuns = new Set();

/** "about 12 tokens a second", or the short "12 tok/s" for a tight row. */
function speedWords(n, short = false) {
  if (!(n > 0)) return '';
  const v = n >= 10 ? Math.round(n) : Math.round(n * 10) / 10;
  return short ? `${v} tok/s` : `about ${v} tokens a second`;
}
app.speedWords = speedWords;

const speedWhen = iso => new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

/**
 * The recent real answers as bars, oldest on the left, on one scale from zero; the speed test as a dashed line across,
 * named at its end. Each bar names its own figure on hover; the figures are also listed under it.
 */
function speedChart(s) {
  const W = 260;
  const H = 70;
  const pad = 4;
  const xs = s.recent;
  const top = Math.max(...xs.map(a => a.write), s.test?.write ?? 0) * 1.15 || 1;
  const y = v => H - pad - ((H - 2 * pad) * v) / top;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'speed-chart');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `The last ${xs.length} answers, ${Math.min(...xs.map(a => a.write))} to ${Math.max(...xs.map(a => a.write))} tokens a second${s.test ? `; the speed test, ${s.test.write}, is the dashed line` : ''}.`);
  const node = (tag, attrs, text) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    if (text) e.textContent = text;
    svg.append(e);
    return e;
  };
  node('line', { x1: 0, x2: W, y1: H - pad, y2: H - pad, class: 'speed-axis' });
  const gap = 2;
  const bw = Math.min(10, (W - 64 - gap * (xs.length - 1)) / Math.max(1, xs.length));
  xs.forEach((a, i) => {
    const x = i * (bw + gap);
    const h = Math.max(1, H - pad - y(a.write));
    const bar = node('rect', { x, y: H - pad - h, width: bw, height: h, rx: Math.min(2, bw / 2), class: 'speed-bar' });
    const tip = document.createElementNS(NS, 'title');
    tip.textContent = `${speedWhen(a.at)}: ${a.write} tokens a second (${a.tokens} written${a.read ? `, read ${a.read} a second` : ''})`;
    bar.append(tip);
  });
  if (s.test) {
    const ty = y(s.test.write);
    node('line', { x1: 0, x2: W - 58, y1: ty, y2: ty, class: 'speed-base' });
    node('text', { x: W - 56, y: ty + 4, class: 'speed-base-label' }, `test ${s.test.write}`);
  }
  return el('figure', { class: 'speed-figure' }, svg,
    el('details', { class: 'sub' }, el('summary', { text: 'The figures' }),
      el('ul', { class: 'speed-list' }, ...[...xs].reverse().map(a => el('li', { text: `${speedWhen(a.at)}: ${a.write} tokens a second, ${a.tokens} written${a.read ? `, read ${a.read} a second` : ''}` })))));
}

/** The words for a summary: the expected speed, where the figure comes from, the test and the average. */
function speedLines(s) {
  if (!s || s.expect == null) return [el('p', { class: 'hint', text: 'Not measured yet. Test speed runs one example prompt (about 150 words) and times it; every real answer is timed too from now on.' })];
  const t = s.test;
  const a = s.average;
  return [
    el('p', { class: 'speed-expect' }, el('strong', { text: `Expected: ${speedWords(s.expect)}` }), ` (${s.basis === 'answers' ? `the average of the last ${a.n} answers` : 'from the speed test'}; ${s.name} on ${s.where}).`),
    el('p', { class: 'hint', text: [
      t ? `Speed test, ${speedWhen(t.at)}: writes ${t.write} tokens a second${t.read ? `, reads the prompt at ${Math.round(t.read)}` : ''}${t.first != null ? `, first word after ${t.first} s` : ''}.` : 'No speed test yet.',
      a ? `Real answers: ${a.write} tokens a second on average over ${a.n}${a.read ? `, reading at ${a.read}` : ''}.` : 'No real answers timed yet.',
    ].join(' ') }),
    s.recent.length > 1 ? speedChart(s) : null,
  ];
}

/**
 * The Speed part of a profile or a card: the figures, the chart, and Test speed. `who`: 'staff:<id>', 'node:<pc>:<hire>',
 * 'remote:<pc>', 'model:<id>' or 'manager'. `after` runs once a test has been kept (to redraw the lists). `split`: two
 * halves, the figures on the left, the chart and Test speed on the right (a hire's profile).
 */
function speedBox(who, s, after, { split = false } = {}) {
  const box = el('div', { class: `speed-box${split ? ' speed-split' : ''}` });
  const say = el('p', { class: 'hint', role: 'status' });
  const draw = sum => {
    const go = el('button', { class: 'btn', type: 'button', text: speedRuns.has(who) ? 'Testing…' : 'Test speed', disabled: speedRuns.has(who),
      title: 'Runs one example prompt (about 150 words) and times it. A model here that is not loaded is loaded first (a big one takes minutes).' });
    go.addEventListener('click', async () => {
      speedRuns.add(who);
      go.disabled = true;
      go.textContent = 'Testing…';
      say.textContent = 'Loading the model first if it is not loaded, then about 150 words. A big model on a CPU takes a minute or more.';
      try {
        const r = await api('/api/speed/test', { who });
        speedRuns.delete(who);
        say.textContent = `Kept: ${speedWords(r.summary?.test?.write)} in this test.`;
        draw(r.summary);
        after?.();
      } catch (e) {
        speedRuns.delete(who);
        go.disabled = false;
        go.textContent = 'Test speed';
        say.textContent = e.message;
      }
    });
    const lines = speedLines(sum).filter(Boolean);
    const actions = el('div', { class: 'team-actions' }, go);
    if (!split) return box.replaceChildren(...lines, actions, say);
    const chart = lines.find(x => x.classList.contains('speed-figure'));
    box.replaceChildren(
      el('div', { class: 'speed-half' }, ...lines.filter(x => x !== chart)),
      el('div', { class: 'speed-half' }, chart ?? null, actions, say));
  };
  draw(s);
  return box;
}
app.speedBox = speedBox;

/** A Test speed link for a tight row (the Nodes page): the row redraws from the server once the test is kept (`after` is told whether it was). */
function speedLink(who, onFault, after) {
  const b = el('button', { class: 'link', type: 'button', text: speedRuns.has(who) ? 'Testing…' : 'Test speed', disabled: speedRuns.has(who), title: 'Runs one example prompt (about 150 words) and times it' });
  b.addEventListener('click', async () => {
    speedRuns.add(who);
    b.disabled = true;
    b.textContent = 'Testing…';
    let ok = false;
    try {
      await api('/api/speed/test', { who });
      ok = true;
    } catch (e) {
      onFault?.(e.message);
    } finally {
      speedRuns.delete(who);
      after?.(ok);
    }
  });
  return b;
}
app.speedLink = speedLink;
