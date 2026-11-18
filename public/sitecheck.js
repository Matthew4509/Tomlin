// Check a website (Tools, left panel): the address, how many pages at most, and who reads them. The server walks the
// site page by page at a person's pace (src/sitecheck.ts, src/server/sitecheck.ts) and this fold follows it every
// second and a half, then shows the report. Uses app.js's helpers ($, el, api).
'use strict';

(() => {
  const fold = $('#sitecheck-fold');
  if (!fold) return;
  const form = $('#sitecheck-form');
  const url = $('#sitecheck-url');
  const pages = $('#sitecheck-pages');
  const who = $('#sitecheck-who');
  const go = $('#sitecheck-go');
  const stop = $('#sitecheck-stop');
  const copy = $('#sitecheck-copy');
  const words = $('#sitecheck-words');
  const state = $('#sitecheck-state');
  const out = $('#sitecheck-report');
  let id = '';
  let timer = 0;

  function show(j) {
    const running = j.state === 'starting' || j.state === 'running';
    go.disabled = running;
    stop.hidden = !running;
    const p = j.progress;
    const lines = [j.words || ''];
    if (j.ran && running) lines.unshift(`Model: ${j.ran}.`);
    if (p && running) lines.push(`${p.done} of at most ${p.max} pages done.`);
    if (j.error) lines.push(j.error);
    words.textContent = lines.filter(Boolean).join(' ');
    state.textContent = running ? 'Running' : j.state === 'done' ? 'Done' : j.state === 'stopped' ? 'Stopped' : j.state === 'failed' ? 'Failed' : '';
    const text = [j.notes?.length ? `Getting the model ready:\n- ${j.notes.join('\n- ')}\n` : '', j.text || ''].filter(Boolean).join('\n');
    out.hidden = !text;
    out.textContent = text;
    copy.hidden = !j.text;
  }

  async function follow() {
    clearTimeout(timer);
    if (!id) return;
    try {
      const j = await api(`/api/sitecheck?id=${encodeURIComponent(id)}`);
      show(j);
      if (j.state === 'starting' || j.state === 'running') timer = setTimeout(follow, 1500);
    } catch (e) {
      words.textContent = e.message;
    }
  }

  async function staffNames() {
    try {
      const s = await api('/api/staff');
      for (const m of s.staff ?? []) {
        if (who.querySelector(`option[value="staff:${m.id}"]`)) continue;
        who.append(el('option', { value: `staff:${m.id}`, text: m.name }));
      }
    } catch {
      // The list stays as it is; the connected model is always there.
    }
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    words.textContent = 'Starting…';
    try {
      const j = await api('/api/sitecheck', { url: url.value.trim(), pages: Number(pages.value) || 15, who: who.value });
      id = j.id;
      show(j);
      follow();
    } catch (err) {
      words.textContent = err.message;
    }
  });
  stop.addEventListener('click', async () => {
    try {
      show(await api('/api/sitecheck/stop', { id }));
      follow();
    } catch (err) {
      words.textContent = err.message;
    }
  });
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(out.textContent);
      words.textContent = 'The report is copied.';
    } catch {
      const r = document.createRange();
      r.selectNodeContents(out);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      words.textContent = 'Select the report and copy it (Ctrl+C).';
    }
  });
  fold.addEventListener('toggle', async () => {
    if (!fold.open) return;
    staffNames();
    if (id) return;
    try {
      const now = await api('/api/sitecheck');
      id = now.running || now.last || '';
      if (id) follow();
    } catch {
      // Nothing to resume.
    }
  });
})();
