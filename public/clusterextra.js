// The Cluster page's extras (public/home.js draws the page): the "Choose an LLM" list that offers any chat model from anywhere
// (this PC, the linked PCs, Hugging Face) and brings it here when it is picked, and the "See real examples from clusters" fold,
// which shows only runs that were really measured (public/cluster-examples.json).

(() => {
  const GB = n => (n ? `${(n / 1e9).toFixed(1)} GB` : '');
  const keyOf = id => String(id).replace(/\\/g, '/').split('/').pop().toLowerCase();
  const flat = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const wait = ms => new Promise(r => setTimeout(r, ms));

  /** What the list is made from: the linked PCs' models (asked of the server) and the progress of a pull in hand. */
  const st = { net: null, asking: false, busy: false, said: '', open: new Set() };

  /** The linked PCs' shared chat models, asked now and then; `then` runs when the answer is in. */
  async function ask(then) {
    if (st.asking) return;
    st.asking = true;
    const before = JSON.stringify(st.net?.rows ?? null);
    try {
      st.net = await api('/api/network?known=1');
    } catch {
      st.net = st.net ?? { rows: [], mine: [], pcs: [] };
    }
    st.at = Date.now();
    st.asking = false;
    // The page is drawn again only when the answer changed the list.
    if (JSON.stringify(st.net.rows) !== before) then?.();
  }

  /** Every chat model from anywhere as one list: where it is, and how it would come here when it is not here. */
  function items(installedHere) {
    const out = new Map();
    const add = (k, f) => { const r = out.get(k) ?? { key: k, name: '', where: [], here: null, remotes: [], hf: null, bytes: 0 }; f(r); out.set(k, r); };
    for (const m of installedHere) add(`chat:${keyOf(m.id)}`, r => { r.name = String(m.name).split(' · ')[0]; r.here = m.id; r.bytes = m.bytes ?? r.bytes; });
    for (const row of (st.net?.rows ?? []).filter(x => x.kind === 'chat')) {
      add(row.key, r => {
        r.name = r.name || row.name;
        r.bytes = r.bytes || row.bytes || 0;
        for (const o of row.on) r.remotes.push({ pc: o.pc, name: o.pcName, model: o.model, copy: o.copy, why: o.why });
      });
    }
    const list = [...out.values()];
    if (typeof POPULAR !== 'undefined') {
      for (const p of POPULAR) {
        if (list.some(x => flat(x.name).includes(flat(p.name)))) continue;
        list.push({ key: `hf:${p.repo}`, name: p.name, where: [], here: null, remotes: [], hf: p, bytes: 0, about: p.about });
      }
    }
    for (const r of list) r.where = [r.here ? 'this PC' : '', ...r.remotes.map(o => o.name)].filter(Boolean);
    // On this PC first, then on a linked PC, then to download; each by name.
    const rank = r => (r.here ? 0 : r.remotes.length ? 1 : 2);
    return list.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }

  /** The words under a model's name: where it is, or that it is not installed. */
  const noteOf = r => (r.here ? 'on this PC' : r.remotes.length ? `on ${r.remotes.map(o => o.name).join(', ')}: copied here when picked` : 'not installed: downloaded from Hugging Face when picked');
  /** What the (!) says about one row: the size, where it is, how it comes, and why it might not. */
  const detailOf = r => [
    r.bytes ? `File size ${GB(r.bytes)}.` : '',
    r.here ? 'It is on this PC: the chat starts at once.' : '',
    !r.here && r.remotes.length ? (r.remotes.some(o => o.copy) ? `It is copied from "${r.remotes.find(o => o.copy).name}" to this PC first (the progress shows here), then the chat starts.` : `No PC that has it can send it now: ${r.remotes.map(o => `"${o.name}": ${o.why || 'cannot send'}`).join('; ')}.`) : '',
    r.hf ? `${r.hf.about} It is downloaded from huggingface.co/${r.hf.repo} in its recommended size into this PC's models folder; each file is checked before it is kept.` : '',
  ].filter(Boolean).join(' ');

  const say = text => {
    st.said = text;
    for (const p of document.querySelectorAll('.cluster-llm-said')) { p.textContent = text; p.hidden = !text; }
  };

  /** Follows a copy that is running until it ends, saying how far it is. */
  async function followCopy(id, who) {
    for (;;) {
      const t = (await api('/api/network/transfers').catch(() => null))?.transfers?.find(x => x.id === id);
      if (!t) throw new Error('the copy is no longer listed: look in Models on my other PCs (Network)');
      if (t.state === 'done') return;
      if (t.state !== 'working') throw new Error(t.said || 'it stopped');
      say(`Copying from ${who}: ${t.bytes ? `${Math.round((t.done / t.bytes) * 100)}%` : '…'}`);
      await wait(1000);
    }
  }

  /** The id of a chat model on this PC with this file name, or null. */
  async function localIdOf(file) {
    app.models = await api('/api/models').catch(() => app.models);
    return (app.models?.chat ?? []).find(m => m.installed !== false && keyOf(m.id) === file)?.id ?? null;
  }

  /**
   * Makes the picked model available on this PC and returns its id here: at once when it is here, else copied from the
   * linked PC that has it (/api/network/copy), else downloaded (/api/chatmodels/get). Throws with the reason.
   */
  async function bringHere(r) {
    if (r.here) return r.here;
    if (r.remotes.length) {
      const o = r.remotes.find(x => x.copy);
      if (!o) throw new Error(`no PC that has it can send it now (${r.remotes.map(x => `"${x.name}": ${x.why || 'cannot send'}`).join('; ')})`);
      const t = await api('/api/network/copy', { pc: o.pc, model: o.model, kind: 'chat' });
      await followCopy(t.transfer.id, `"${o.name}"`);
      const id = await localIdOf(keyOf(o.model));
      if (!id) throw new Error('it came to this PC but is not listed yet: look in Models');
      return id;
    }
    const { sizes } = await api('/api/chatmodels/sizes', { repos: [r.hf.repo] });
    const s = sizes?.[0];
    if (!s || s.error || !s.models?.length) throw new Error(s?.error || 'its sizes could not be read on Hugging Face');
    const u = s.models.find(m => m.name === s.usual) ?? s.models[0];
    let job = await api('/api/chatmodels/get', { repo: r.hf.repo, rev: s.rev, name: u.name });
    while (job?.state === 'downloading') {
      say(`Downloading ${u.name}: ${job.bytes ? `${Math.floor((job.got / job.bytes) * 100)}% of ${GB(job.bytes)}` : '…'}`);
      await wait(1000);
      job = await api('/api/chatmodels/get');
    }
    if (job?.state !== 'done') throw new Error(job?.error || 'the download did not finish');
    app.models = await api('/api/models').catch(() => app.models);
    const id = (app.models?.chat ?? []).find(m => m.installed !== false && flat(keyOf(m.id)).includes(flat(u.name)))?.id;
    if (!id) throw new Error('it downloaded but is not listed yet: look in Models');
    return id;
  }

  /**
   * The picker: one list of every chat model, a search box, a small note on each row and the details behind a (!).
   * `installedHere`: this PC's chat models. Returns { node, current() } where current() is the picked row (or null).
   */
  function picker(installedHere, chosen, onChange) {
    const all = items(installedHere);
    let q = st.q ?? '';
    let pick = all.find(r => r.key === chosen) ?? all[0] ?? null;
    const list = el('ul', { class: 'cluster-llm-list', role: 'listbox', 'aria-label': 'Choose an LLM' });
    const draw = () => {
      const shown = all.filter(r => !q || flat(r.name).includes(flat(q)));
      list.replaceChildren(...(shown.length ? shown.map(r => {
        const on = pick?.key === r.key;
        return el('li', { class: `cluster-llm-row${on ? ' on' : ''}`, role: 'option', 'aria-selected': String(on) },
          el('button', { class: 'cluster-llm-pick', type: 'button', 'data-key': `cluster-llm:${r.key}`, onclick: () => { pick = r; onChange(r); draw(); } },
            el('b', { text: r.name }), el('span', { class: 'hint', text: ` ${noteOf(r)}` })),
          el('button', { class: 'cluster-llm-i', type: 'button', 'aria-label': `About ${r.name}`, 'aria-expanded': String(st.open.has(r.key)), title: detailOf(r), text: '(!)', onclick: () => { if (st.open.has(r.key)) st.open.delete(r.key); else st.open.add(r.key); draw(); } }),
          st.open.has(r.key) ? el('p', { class: 'hint cluster-llm-detail', text: detailOf(r) }) : null);
      }) : [el('li', { class: 'hint', text: all.length ? 'No model matches.' : 'No chat model anywhere yet: add one under Models.' })]));
    };
    const search = el('input', { type: 'search', class: 'cluster-llm-search', 'data-key': 'cluster-llm-search', placeholder: 'Search models', 'aria-label': 'Search models', value: q });
    search.addEventListener('input', () => { q = search.value; st.q = q; draw(); });
    draw();
    return { node: el('div', { class: 'cluster-llm' }, search, list, el('p', { class: 'hint cluster-llm-said', role: 'status', hidden: !st.said, text: st.said })), current: () => pick };
  }

  /** The Specs fold: closed unless the owner opened it; `summary` is its one line. */
  function fold(key, summary, ...kids) {
    return el('details', { class: 'cluster-fold', 'data-fold': key, ...(st.open.has(`fold:${key}`) ? { open: '' } : {}), ontoggle: e => { if (e.currentTarget.open) st.open.add(`fold:${key}`); else st.open.delete(`fold:${key}`); } },
      el('summary', { text: summary }), ...kids);
  }

  /** One measured run: hardware of every PC, the model and its quantisation, the settings, the result, the date, and the caveat. */
  function exampleCard(x) {
    const line = (label, text) => el('p', { class: 'cluster-ex-line' }, el('b', { text: `${label}: ` }), text);
    const r = x.result ?? {};
    const res = r.failed ? `Failed. ${r.what}` : `${r.tokensPerSecond} tokens a second${r.loadSeconds != null ? `, load ${r.loadSeconds} s` : ', load time not recorded'}. ${r.what}`;
    return el('article', { class: 'cluster-ex' },
      el('h4', { text: x.title }),
      el('p', { class: 'hint', text: `${x.date} · ${x.verified ? 'measured, copied from the record' : 'not verified'}` }),
      el('ul', { class: 'cluster-ex-pcs' }, ...x.hardware.map(h => el('li', { text: `${h.pc}: ${h.cpu ?? 'CPU not recorded'}, ${h.ram} RAM, ${h.card} with ${h.cardMemory}` }))),
      line('Model', `${x.model.name}, ${x.model.quantisation}, ${x.model.size}`),
      line('Settings', `cluster: ${x.settings.cluster}; loaded by: ${x.settings.loadedBy}; Max mode: ${x.settings.maxMode}; ${x.settings.layout}`),
      line('Result', res),
      line('Caveat', x.caveat || 'none recorded'),
      el('p', { class: 'hint', text: `Record: ${x.source}` }));
  }

  /** "See real examples from clusters": loads the data file the first time it is opened. */
  function examples() {
    const body = el('div', { class: 'cluster-ex-body' }, el('p', { class: 'hint', text: 'Reading the examples…' }));
    const d = fold('examples', 'See real examples from clusters', body);
    const load = async () => {
      try {
        const got = await (await fetch('cluster-examples.json')).json();
        body.replaceChildren(el('p', { class: 'hint', text: 'Only runs that were really measured, with the numbers copied from the test records. Your own PCs may give different figures.' }),
          ...got.examples.map(exampleCard), ...got.missing.map(t => el('p', { class: 'hint', text: t })));
      } catch (e) {
        body.replaceChildren(el('p', { class: 'hint', text: `The examples could not be read: ${e.message}` }));
      }
    };
    let loaded = false;
    d.addEventListener('toggle', () => { if (d.open && !loaded) { loaded = true; load(); } });
    if (d.open) { loaded = true; load(); }
    return d;
  }

  app.clusterExtra = { picker, ask, bringHere, say, fold, examples, busy: () => st.busy, setBusy: b => { st.busy = b; }, hasNet: () => !!st.net && Date.now() - st.at < 30_000 };
})();
