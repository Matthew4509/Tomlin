// How fast a model answers (src/speed.ts): the expected speed of a person, a linked PC or a model on this PC, the last
// speed test (the baseline), the average of real answers, and a small chart of the recent ones. Test speed runs one
// fixed example prompt (about 150 words) and times it. Uses app.js's helpers ($, el, api, app).
'use strict';

/** Which tests are running now, by who (a redraw every few seconds must not lose "Testing…"). */
const speedRuns = new Set();

/** Locks (or unlocks) every Test speed button on the page: one test runs at a time, on the whole server. */
function speedLock() {
  for (const b of document.querySelectorAll('[data-speed-go]')) b.disabled = speedRuns.size > 0;
}

const speedSecs = n => (n >= 60 ? `${Math.floor(n / 60)} min ${Math.round(n % 60)} s` : `${Math.round(n * 10) / 10} s`);
const speedTok = n => (n >= 10 ? String(Math.round(n)) : String(Math.round(n * 10) / 10));

/** The change of a figure against the run before it, in words ("up 12%"); '' when there is nothing to compare. */
function speedChange(now, before, higherIsBetter = true) {
  if (!(now > 0) || !(before > 0)) return '';
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return ' (same as the last run)';
  const good = higherIsBetter ? pct > 0 : pct < 0;
  return ` (${pct > 0 ? 'up' : 'down'} ${Math.abs(pct)}% on the last run${good ? '' : ', slower'})`;
}

/** The hardware and model a kept test ran on, as lines of words. */
function speedDetails(t) {
  const sn = t.snap ?? {};
  const md = t.model ?? {};
  const rows = [
    ['Date and time', new Date(t.at).toLocaleString()],
    ['Node', sn.node], ['Graphics card', sn.gpu], ['Card memory', sn.vram], ['Driver', sn.driver], ['Processor', sn.cpu], ['RAM', sn.ram],
    ['Model', md.name], ['Quantisation', md.quant], ['Context size', md.ctx ? `${md.ctx} tokens` : ''], ['Backend', md.backend],
  ].filter(r => r[1]);
  return el('dl', { class: 'speed-detail' }, ...rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]));
}

/**
 * Runs one speed test with its own screens: "Testing in progress" (model, node, time so far, live tokens a second,
 * a guess from the streamed words), then the results (prompt and writing speed, first word, total time, pass or fail,
 * and the change against the last run of this model on this PC). Resolves with the server's answer; throws its fault.
 */
async function speedRun(who) {
  if (speedRuns.size) throw new Error('A speed test is running already. Wait for it to finish.');
  speedRuns.add(who);
  speedLock();
  const dlg = el('dialog', { class: 'small-dlg ask-pop speed-dlg', 'aria-labelledby': 'speed-dlg-title' });
  dlg.addEventListener('cancel', e => { if (speedRuns.has(who)) e.preventDefault(); });
  const title = el('h2', { id: 'speed-dlg-title', text: 'Testing in progress' });
  const body = el('div', { role: 'status', 'aria-live': 'polite' });
  dlg.append(el('div', { class: 'help-body' }, title, body));
  document.body.append(dlg);
  dlg.showModal();
  const began = Date.now();
  const paint = live => {
    const secs = live ? live.seconds : Math.round((Date.now() - began) / 1000);
    body.replaceChildren(
      el('p', { class: 'hint', text: live?.loaded ? 'Writing about 150 words. The speed below is a live guess; the kept figures come from the model.' : 'Loading the model first if it is not loaded. A big model takes minutes.' }),
      el('dl', { class: 'speed-detail' },
        el('dt', { text: 'Model' }), el('dd', { text: live?.model || 'working out which…' }),
        el('dt', { text: 'Node' }), el('dd', { text: live?.node || '…' }),
        el('dt', { text: 'Time' }), el('dd', { text: speedSecs(secs) }),
        el('dt', { text: 'Speed now' }), el('dd', { text: live?.tps > 0 ? `about ${speedTok(live.tps)} tok/s` : 'waiting for the first word' })));
  };
  paint(null);
  const timer = setInterval(async () => {
    try { paint((await api('/api/speed/live')).live); } catch { /* the next tick tries again */ }
  }, 1000);
  try {
    const r = await api('/api/speed/test', { who });
    clearInterval(timer);
    speedRuns.delete(who);
    speedLock();
    const t = r.result;
    if (!t) { dlg.close(); dlg.remove(); return r; }
    const b = r.before;
    title.textContent = t.ok === false ? 'Test failed' : 'Test passed';
    body.replaceChildren(
      el('dl', { class: 'speed-detail' },
        el('dt', { text: 'Prompt speed' }), el('dd', { text: t.read ? `${speedTok(t.read)} tok/s${speedChange(t.read, b?.read)}` : 'not reported' }),
        el('dt', { text: 'Writing speed' }), el('dd', { text: `${speedTok(t.write)} tok/s${speedChange(t.write, b?.write)}` }),
        el('dt', { text: 'Time to first word' }), el('dd', { text: t.first != null ? `${speedSecs(t.first)}${speedChange(t.first, b?.first, false)}` : 'not timed' }),
        el('dt', { text: 'Total time' }), el('dd', { text: t.total ? speedSecs(t.total) : 'not timed' }),
        el('dt', { text: 'Result' }), el('dd', { text: t.ok === false ? 'Fail' : 'Pass' })),
      el('p', { class: 'hint', text: `${t.model?.name ?? ''} on ${t.snap?.node ?? 'this PC'}. Kept with the hardware it ran on: press the ! beside it in the test history.${r.unloaded ? ` ${r.unloaded}` : ''}` }),
      el('form', { method: 'dialog', class: 'team-actions' }, el('button', { class: 'btn primary', type: 'submit', text: 'Close' })));
    dlg.addEventListener('close', () => dlg.remove());
    return r;
  } catch (e) {
    clearInterval(timer);
    speedRuns.delete(who);
    speedLock();
    dlg.close();
    dlg.remove();
    throw e;
  }
}

/** The kept tests, newest first, each with a ! that opens the date, the hardware it ran on and the model's details. */
function speedHistory(s) {
  const list = s?.history ?? [];
  if (!list.length) return null;
  return el('details', { class: 'sub speed-history' }, el('summary', { text: `Test history (${list.length})` }),
    el('ul', { class: 'speed-list' }, ...list.map((t, i) => {
      const more = el('div', { class: 'speed-more', hidden: true }, speedDetails(t));
      const bang = el('button', { class: 'link', type: 'button', text: '!', title: 'The date, the hardware and the model this test ran on', 'aria-expanded': 'false', 'aria-label': 'Details of this test' });
      bang.addEventListener('click', () => { more.hidden = !more.hidden; bang.setAttribute('aria-expanded', String(!more.hidden)); });
      const prev = list[i + 1];
      const change = prev && prev.model?.name === t.model?.name && prev.snap?.node === t.snap?.node ? speedChange(t.write, prev.write) : '';
      return el('li', {}, `${speedWhen(t.at)}: writes ${t.write} tok/s${t.read ? `, reads ${Math.round(t.read)}` : ''}${change} `, bang, more);
    })));
}

/** "about 12 tokens a second", or the short "12 tok/s" for a tight row. */
function speedWords(n, short = false) {
  if (!(n > 0)) return '';
  const v = n >= 10 ? Math.round(n) : Math.round(n * 10) / 10;
  return short ? `${v} tok/s` : `about ${v} tokens a second`;
}
app.speedWords = speedWords;

/** The shortest form, for a tile: "5.8 tk/s". */
app.speedTk = n => (n > 0 ? `${n >= 10 ? Math.round(n) : Math.round(n * 10) / 10} tk/s` : '');

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
    speedHistory(s),
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
    const go = el('button', { class: 'btn', type: 'button', text: speedRuns.has(who) ? 'Testing…' : 'Test speed', disabled: speedRuns.size > 0, 'data-speed-go': '',
      title: 'Runs one example prompt (about 150 words) and times it. A model here that is not loaded is loaded first (a big one takes minutes).' });
    go.addEventListener('click', async () => {
      go.textContent = 'Testing…';
      say.textContent = '';
      try {
        const r = await speedRun(who);
        say.textContent = `Kept: ${speedWords(r.summary?.test?.write)} in this test.`;
        draw(r.summary);
        after?.();
      } catch (e) {
        go.textContent = 'Test speed';
        say.textContent = e.message;
        speedLock();
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
function speedLink(who, onFault, after, label = 'Test speed') {
  const b = el('button', { class: 'link', type: 'button', text: speedRuns.has(who) ? 'Testing…' : label, disabled: speedRuns.size > 0, 'data-speed-go': '', title: 'Runs one example prompt (about 150 words) and times it' });
  b.addEventListener('click', async () => {
    b.textContent = 'Testing…';
    let ok = false;
    try {
      await speedRun(who);
      ok = true;
    } catch (e) {
      onFault?.(e.message);
    } finally {
      b.textContent = ok ? 'Re-test speed' : label;
      after?.(ok);
    }
  });
  return b;
}
app.speedLink = speedLink;
