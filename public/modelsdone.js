// This PC's "Models on this PC": what the models have done in the last 7 days (W2-23), from /api/models/done
// (src/modelsdone.ts): a line for today, then chat models (answers, seconds each), picture models (pictures, seconds by
// size) and video models (clips, minutes for 5 s). Read when the block comes on screen, and again at most every 30 s.
'use strict';

(() => {
  const box = $('#models-done');
  if (!box) return;
  let readAt = 0;
  const mins = ms => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${Math.floor(ms / 3_600_000)} h ${Math.round((ms % 3_600_000) / 60_000)} min`);
  const many = (n, one, more) => `${n} ${n === 1 ? one : more}`;

  function part(title, rows) {
    if (!rows.length) return null;
    return el('div', { class: 'done-part' }, el('h4', { text: title }), el('ul', { class: 'done-list' }, ...rows.map(r => el('li', {}, el('b', { text: r[0] }), el('span', { class: 'hint', text: ` ${r[1]}` })))));
  }

  function draw(d) {
    const t = d.today;
    const today = t.pictures || t.clips
      ? `Today: ${[t.pictures ? many(t.pictures, 'picture', 'pictures') : '', t.clips ? many(t.clips, 'clip', 'clips') : ''].filter(Boolean).join(', ')}, ${mins(t.drawMs)} of drawing.`
      : 'Nothing drawn today yet.';
    const chat = d.chat.map(c => [c.name, `on ${c.pc}: ${many(c.answers, 'answer', 'answers')}, about ${c.secondsEach} s each`]);
    const pics = d.pictures.map(p => [p.name, `${many(p.count, 'picture', 'pictures')}: ${p.sizes.map(s => `${s.px ? `${s.px} px` : 'size not kept'} ${s.seconds} s${s.count > 1 ? ` (${s.count})` : ''}`).join(' · ')}`]);
    const clips = d.clips.map(c => [c.name, `on ${c.pc}, ${c.quality}: ${many(c.count, 'clip', 'clips')}, about ${c.minutesFor5s} min for 5 s`]);
    const parts = [part('Chat models', chat), part('Picture models', pics), part('Video models', clips)].filter(Boolean);
    box.replaceChildren(
      el('h4', { text: `What they have done (last ${d.days} days)` }),
      el('p', { class: 'hint', text: today }),
      ...(parts.length ? parts : [el('p', { class: 'hint', text: 'Nothing yet: what a model does shows here, and a model not used yet has its speed test.' })]));
  }

  async function read() {
    if (Date.now() - readAt < 30_000) return;
    readAt = Date.now();
    try {
      draw(await api('/api/models/done'));
    } catch (e) {
      box.replaceChildren(el('p', { class: 'hint', text: `What the models have done could not be read: ${e.message}` }));
    }
  }

  // Read when This PC shows it, not on every page: the block is empty until then.
  new IntersectionObserver(seen => { if (seen.some(x => x.isIntersecting)) read(); }).observe(box);
})();
