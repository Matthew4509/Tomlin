// Help's search, and the old section names. Plain script, no libraries; works from the app's own files.
// Search reads each topic page once (the first time something is typed), then looks in titles, summaries and text.
// An old link to a section of the single-page Help (index.html?go=help-xxx) is sent on to where that section lives now.
'use strict';

(() => {
  const map = globalThis.TOMLIN_HELP;
  if (!map) return;
  const params = new URLSearchParams(location.search);
  const here = (location.pathname.split('/').pop() || 'index.html').toLowerCase();

  const go = params.get('go');
  if (go && map.aliases[go] && (here === 'index.html' || here === '')) {
    location.replace(map.aliases[go]);
    return;
  }

  // A table on a narrow screen shows each cell under its column's name.
  for (const table of document.querySelectorAll('.help-table')) {
    const heads = [...table.querySelectorAll('thead th')].map(h => h.textContent.trim());
    for (const row of table.querySelectorAll('tbody tr')) [...row.children].forEach((cell, i) => { if (cell.tagName === 'TD' && heads[i]) cell.dataset.label = heads[i]; });
  }

  const input = document.getElementById('q');
  const box = document.getElementById('results');
  const found = document.getElementById('found');
  const groupsEl = document.getElementById('groups');
  if (!input) return;

  const groupTitle = id => map.groups.find(g => g.id === id)?.title ?? '';
  let corpus = null;
  let loading = null;

  /** Every topic with its page's text; a page that cannot be read (opened from a folder, not the app) counts by title and summary. */
  function load() {
    loading ??= Promise.all(map.topics.map(async t => {
      let text = '';
      try {
        const r = await fetch(`${t.id}.html`);
        if (r.ok) {
          const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
          text = (doc.querySelector('article')?.textContent ?? '').replace(/\s+/g, ' ').trim();
        }
      } catch {}
      return { t, text, low: `${t.title} ${t.blurb} ${text}`.toLowerCase() };
    })).then(list => (corpus = list));
    return loading;
  }

  const words = q => q.toLowerCase().split(/\s+/).filter(w => w.length > 1 || /\d/.test(w));

  function rank(q) {
    const w = words(q);
    if (!w.length) return [];
    const out = [];
    for (const c of corpus) {
      if (!w.every(x => c.low.includes(x))) continue;
      let score = 0;
      for (const x of w) {
        if (c.t.title.toLowerCase().includes(x)) score += 50;
        if (c.t.blurb.toLowerCase().includes(x)) score += 15;
        score += Math.min(20, c.low.split(x).length - 1);
      }
      out.push({ c, score });
    }
    return out.sort((a, b) => b.score - a.score).map(x => x.c);
  }

  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  function mark(s, w) {
    let h = esc(s);
    for (const x of w) h = h.replace(new RegExp(`(${x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>');
    return h;
  }
  /** About 150 characters of the page's text round the first word found in it. */
  function snippet(c, w) {
    const at = w.map(x => c.text.toLowerCase().indexOf(x)).filter(i => i >= 0).sort((a, b) => a - b)[0];
    if (at === undefined) return c.t.blurb;
    const from = Math.max(0, at - 60);
    return `${from ? '…' : ''}${c.text.slice(from, from + 170)}…`;
  }

  async function show(q) {
    const w = words(q);
    if (!w.length) {
      box.hidden = true;
      box.replaceChildren();
      if (found) { found.hidden = true; groupsEl.hidden = false; }
      return;
    }
    await load();
    if (input.value.trim() !== q.trim()) return;
    const list = rank(q);
    if (found) {
      groupsEl.hidden = true;
      found.hidden = false;
      found.innerHTML = `<p class="where">${list.length ? `${list.length} topic${list.length === 1 ? '' : 's'} for "${esc(q)}"` : `Nothing found for "${esc(q)}". Try fewer or different words, or look through the groups.`}</p>`
        + list.map(c => `<a href="${c.t.id}.html"><b>${mark(c.t.title, w)}</b><span class="where">${esc(groupTitle(c.t.group))}</span><small>${mark(snippet(c, w), w)}</small></a>`).join('');
      return;
    }
    box.hidden = false;
    box.innerHTML = list.length
      ? list.slice(0, 8).map(c => `<a href="${c.t.id}.html"><b>${mark(c.t.title, w)}</b><small>${esc(groupTitle(c.t.group))}: ${mark(snippet(c, w), w)}</small></a>`).join('')
      : `<p>Nothing found for "${esc(q)}".</p>`;
  }

  input.addEventListener('input', () => { show(input.value); });
  input.addEventListener('focus', () => { load(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { input.value = ''; show(''); }
    if (e.key === 'ArrowDown') box.querySelector('a')?.focus();
  });
  box.addEventListener('keydown', e => {
    const links = [...box.querySelectorAll('a')];
    const i = links.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { links[Math.min(i + 1, links.length - 1)]?.focus(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { (i > 0 ? links[i - 1] : input).focus(); e.preventDefault(); }
    if (e.key === 'Escape') input.focus();
  });
  document.addEventListener('click', e => { if (!e.target.closest?.('.search')) box.hidden = true; });
  // Enter with the results showing goes to the first; with no script, the form goes to the index with ?q=.
  input.form?.addEventListener('submit', async e => {
    if (found) { e.preventDefault(); return show(input.value); }
    const q = input.value.trim();
    if (!q) return;
    e.preventDefault();
    await load();
    const first = rank(q)[0];
    location.href = first ? `${first.t.id}.html` : `index.html?q=${encodeURIComponent(q)}`;
  });

  const q = params.get('q');
  if (q) { input.value = q; show(q); }
})();
