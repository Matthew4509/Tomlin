// Day or night colours: kept in this browser as 'day' or
// 'night'; nothing kept = follow the Windows light/dark setting. Loaded in <head>, before the page is drawn, so it
// never flashes the other colours. The colours are in style.css (:root, and [data-theme="night"]).
// Answers [data-colours-toggle] (one button: Day <-> Night) and [data-colours-pick] (radios: Follow Windows '', day,
// night); a picker drawn later calls window.tomlinColours.draw() to show the one picked.
'use strict';

(() => {
  const KEY = 'tomlin-colours';
  const root = document.documentElement;
  const dark = matchMedia('(prefers-color-scheme: dark)');

  /** 'day', 'night', or '' (follow Windows). Private windows and blocked storage read as ''. */
  function picked() {
    try {
      const v = localStorage.getItem(KEY);
      return v === 'day' || v === 'night' ? v : '';
    } catch {
      return '';
    }
  }
  /** The colours on screen now: what was picked, else what Windows says. */
  const shown = () => picked() || (dark.matches ? 'night' : 'day');

  function apply() {
    const v = picked();
    if (v) root.dataset.theme = v;
    else delete root.dataset.theme;
    draw();
  }

  function pick(v) {
    try {
      if (v) localStorage.setItem(KEY, v);
      else localStorage.removeItem(KEY);
    } catch {}
    if (v) root.dataset.theme = v;
    else delete root.dataset.theme;
    draw();
  }

  const SUN = 'M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z';
  const MOON = 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z';

  function draw() {
    const now = shown();
    for (const b of document.querySelectorAll('[data-colours-toggle]')) {
      const other = now === 'day' ? 'Night' : 'Day';
      b.title = `Colours: ${now === 'day' ? 'Day' : 'Night'}${picked() ? '' : ' (as Windows is set)'}. Press for ${other}. Follow Windows again: Settings.`;
      b.setAttribute('aria-label', `Colours: ${now === 'day' ? 'Day' : 'Night'}. Press for ${other}.`);
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('width', '18');
      svg.setAttribute('height', '18');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', now === 'day' ? SUN : MOON);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '2');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      svg.append(path);
      const word = document.createElement('span');
      word.textContent = now === 'day' ? 'Day' : 'Night';
      b.replaceChildren(svg, word);
    }
    for (const box of document.querySelectorAll('[data-colours-pick]')) {
      for (const r of box.querySelectorAll('input[type="radio"]')) r.checked = r.value === picked();
    }
  }

  // Listened for on the whole page, so a picker drawn later works too.
  document.addEventListener('click', e => {
    if (e.target instanceof Element && e.target.closest('[data-colours-toggle]')) pick(shown() === 'day' ? 'night' : 'day');
  });
  document.addEventListener('change', e => {
    if (e.target instanceof HTMLInputElement && e.target.type === 'radio' && e.target.closest('[data-colours-pick]')) pick(e.target.value);
  });
  window.tomlinColours = { picked, shown, draw };

  apply();
  dark.addEventListener('change', draw);
  // Another tab of either look changed it.
  window.addEventListener('storage', e => {
    if (e.key === KEY || e.key === null) apply();
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', draw);
  else draw();
})();
