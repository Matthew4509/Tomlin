// A PC's window (press a PC in the left panel), for this PC and each linked one. Left: its photo, name, make / model and
// specifications. Right: a strip (TOMLIN, tokens, time worked, power cost), its models (search, All | Chat |
// Pictures | Hidden, sort, pages of 10), the staff on it and its most-used models (last 7 days), and folded away, the
// power figures and what its work cost against the Claude and ChatGPT APIs, per project (src/server/costs.ts, src/meter.ts).
// Everything here sits in one block: page scripts share one global scope, so no name of this file can clash.
'use strict';
{
  const dlg = $('#pc-dlg');
  const body = $('#pc-body');
  let showing = 'here';
  /** The models list as you left it on this PC: the words searched, the kind shown, the order and the page. */
  const list = { q: '', cat: 'all', sort: 'name', page: 0 };
  /** What a model's row last said (a speed test that failed, a Delete refused), kept across the redraws. */
  const rowSay = {};
  const BIN = 'M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Zm4 2v8h2v-8h-2Zm4 0v8h2v-8h-2Z';
  const GBs = n => `${(n / 2 ** 30).toFixed(n >= 10 * 2 ** 30 ? 0 : 1)} GB`;
  /** The Uptime part of the window: hidden for now. */
  const SHOW_UPTIME = false;

  const tokens = n => (n >= 1e6 ? `${(n / 1e6).toLocaleString('en-GB', { maximumFractionDigits: 2 })} M` : n.toLocaleString('en-GB'));
  const money = x => (x === null || x === undefined ? null : x === 0 ? 'US$0' : x >= 0.01 ? `US$${x.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `US$${Number(x.toPrecision(2))}`);
  function span(seconds) {
    const s = Math.max(0, Math.round(seconds));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d) return `${d} day${d === 1 ? '' : 's'} ${h} h`;
    if (h) return `${h} h ${m} min`;
    if (m) return `${m} min`;
    return `${s} s`;
  }
  /** Prompt tokens (new and cached together, as an API counts them), with the cached part, then the written ones. */
  const readWritten = t => `${tokens(t.in + t.cached)}${t.cached ? ` (${tokens(t.cached)} cached)` : ''} / ${tokens(t.out)}`;
  app.readWritten = readWritten;
  app.money = money;
  app.span = span;
  const when = iso => new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

  function say(text, fault = false) {
    const p = $('#pc-said');
    p.textContent = text;
    p.hidden = !text;
    p.classList.toggle('fault-line', fault);
  }

  async function load(id) {
    if (id !== showing) Object.assign(list, { q: '', cat: 'all', sort: 'name', page: 0 });
    showing = id;
    try {
      draw(await api(`/api/pc?id=${encodeURIComponent(id)}`));
    } catch (e) {
      body.replaceChildren(el('p', { class: 'fault', text: e.message }));
      return;
    }
    if (id !== 'here') return;
    installBox.replaceChildren(el('h3', { text: 'Install' }), el('p', { class: 'hint', text: 'Checking the install…' }));
    try {
      install = await api('/api/install');
      drawInstall();
    } catch (e) {
      installBox.replaceChildren(el('h3', { text: 'Install' }), el('p', { class: 'fault', text: e.message }));
    }
  }

  // ---- This PC's install (My PC only): Repair install, Shortcut to desktop, Start on start up (src/server/install.ts) ----
  let install = null;
  const installBox = el('div', { class: 'pc-install' });

  /** "Start when this PC starts", as the tick in Nodes and memory saves it (a node asks for the app lock PIN). */
  async function setStart(on) {
    let appPin;
    for (;;) {
      try {
        await api('/api/share', appPin === undefined ? { autostart: on } : { autostart: on, appPin });
        return true;
      } catch (e) {
        if (!e.data?.needAppPin || typeof askAppPin !== 'function') throw e;
        appPin = await askAppPin(appPin === undefined ? '' : e.message);
        if (appPin === null) return false;
      }
    }
  }

  function drawInstall(result = null) {
    const s = install;
    if (!s?.windows) return installBox.replaceChildren();
    const parts = [el('h3', { text: 'Install' })];
    parts.push(el('p', {
      text: !s.installed ? `Not installed: TOMLIN runs from ${s.here}.`
        : s.outside ? `This TOMLIN runs from a folder (${s.here}), not from the install in ${s.root}${s.current ? `, which has ${s.current.version}` : ''}. Updates from linked PCs reach the copy that runs, so the install stays behind.`
        : `Installed in ${s.root}.`,
    }));
    if (result) {
      if (result.done.length) parts.push(el('p', { text: 'Repaired:' }), el('ul', { class: 'pc-repair' }, ...result.done.map(t => el('li', { text: t }))));
      if (result.failed.length) parts.push(el('p', { class: 'fault-line', text: 'Not repaired:' }), el('ul', { class: 'pc-repair' }, ...result.failed.map(t => el('li', { text: t }))));
      if (!result.done.length && !result.failed.length) parts.push(el('p', { text: 'Nothing needed repairing.' }));
    } else if (s.steps.length) parts.push(el('p', { text: 'Repair install would:' }), el('ul', { class: 'pc-repair' }, ...s.steps.map(t => el('li', { text: t }))));
    else if (s.installed && !s.left.length) parts.push(el('p', { class: 'hint', text: 'Nothing to repair.' }));
    for (const l of (result ?? s).left) parts.push(el('p', { class: 'hint', text: l }));

    const busy = (btn, text) => {
      btn.disabled = true;
      btn.textContent = text;
    };
    const repair = el('button', { class: 'btn primary', type: 'button', text: 'Repair install' });
    repair.addEventListener('click', async () => {
      busy(repair, 'Repairing…');
      say('');
      try {
        const r = await api('/api/install/repair', {});
        install = r.state;
        drawInstall(r.result);
      } catch (e) {
        say(e.message, true);
        drawInstall();
      }
    });
    const desk = el('button', { class: 'btn', type: 'button', text: 'Shortcut to desktop' });
    desk.addEventListener('click', async () => {
      busy(desk, 'Making it…');
      try {
        const r = await api('/api/install/desktop', {});
        install = r.state;
        say('The shortcut is on the desktop.');
      } catch (e) {
        say(e.message, true);
      }
      drawInstall(result);
    });
    const start = el('button', { class: 'btn', type: 'button', text: s.autostart ? 'Cancel start on PC start up' : 'Start on start up' });
    start.addEventListener('click', async () => {
      busy(start, 'Saving…');
      try {
        if (await setStart(!s.autostart)) {
          install = await api('/api/install');
          say(install.autostart ? 'TOMLIN starts when this PC starts.' : 'TOMLIN no longer starts when this PC starts.');
        }
      } catch (e) {
        say(e.message, true);
      }
      drawInstall(result);
    });
    parts.push(el('div', { class: 'team-actions' }, repair, desk, start));
    parts.push(el('p', { class: 'hint', text: `${s.desktop?.there ? 'A TOMLIN shortcut is on the desktop.' : 'No TOMLIN shortcut on the desktop.'} ${s.autostart ? 'TOMLIN starts when this PC starts.' : 'TOMLIN does not start when this PC starts.'}` }));
    if (s.canSwitch) {
      const go = el('button', { class: 'btn', type: 'button', text: 'Start the installed one now' });
      go.addEventListener('click', async () => {
        busy(go, 'Starting it…');
        try {
          await api('/api/install/switch', {});
          say('This TOMLIN is closing, and the installed TOMLIN starts by the clock. Its own window opens when it is ready; close this one.');
        } catch (e) {
          say(e.message, true);
          drawInstall(result);
        }
      });
      parts.push(el('div', { class: 'team-actions' }, go), el('p', { class: 'hint', text: 'This TOMLIN (started from a folder) closes, and the installed one takes over: from then on, updates from linked PCs reach the install.' }));
    }
    installBox.replaceChildren(...parts);
  }

  /** One table row: the project, its tokens and working time, then power and each API, the least of them marked. */
  function costRow(name, t, c, apis, strong = false) {
    const all = [c.power, ...c.apis.map(a => a.cost)].filter(x => x !== null);
    const least = all.length > 1 && (t.in || t.cached || t.out) ? Math.min(...all) : null;
    const cell = x => el('td', { class: 'num' }, x === null ? el('span', { class: 'hint', text: '—' }) : x === least ? el('strong', { text: `${money(x)} (least)` }) : money(x));
    return el('tr', { class: strong ? 'pc-total' : '' },
      el('th', { scope: 'row', text: name }),
      el('td', { class: 'num', text: readWritten(t) }),
      el('td', { class: 'num', text: t.ms ? span(t.ms / 1000) : '—' }),
      cell(c.power),
      ...apis.map(a => cell(c.apis.find(x => x.id === a.id)?.cost ?? null)));
  }

  /** The PC as you know it (src/pcprofile.ts): its photo, what you call it, and its make and model. */
  function profileBlock(v) {
    const p = v.profile;
    const pic = p.photo ? el('img', { class: 'pc-photo-img', src: p.photo, alt: `Photo of ${v.name}` }) : el('span', { class: 'pc-photo-none', 'aria-hidden': 'true', text: 'PC' });
    const file = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true });
    const change = el('button', { class: 'btn quiet', type: 'button', text: p.photo ? 'Change photo' : 'Add a photo' });
    const remove = p.photo ? el('button', { class: 'btn quiet', type: 'button', text: 'Remove photo' }) : null;
    const saved = async (path, body, words) => {
      try {
        draw(await api(path, body));
        await app.loadFaces?.();
        say(words);
      } catch (e) {
        say(e.message, true);
        draw(v);
      }
    };
    change.addEventListener('click', () => file.click());
    file.addEventListener('change', async () => {
      const f = file.files[0];
      if (!f) return;
      if (f.size > 15 * 2 ** 20) return say(`That photo is ${Math.round(f.size / 2 ** 20)} MB; the most it takes is 15 MB. Pick a smaller one, or take it again at a lower size.`, true);
      change.disabled = true;
      change.textContent = 'Saving…';
      let image;
      try {
        image = await new Promise((ok, no) => {
          const r = new FileReader();
          r.onload = () => ok(r.result);
          r.onerror = () => no(new Error('That file could not be read. Try another photo.'));
          r.readAsDataURL(f);
        });
      } catch (e) {
        say(e.message, true);
        return draw(v);
      }
      await saved('/api/pc/photo', { id: v.id, image }, 'Photo saved. It shows beside this PC in the left panel.');
    });
    remove?.addEventListener('click', () => saved('/api/pc/photo', { id: v.id, image: null }, 'Photo removed.'));
    const name = el('input', { type: 'text', maxlength: '40', value: p.name, placeholder: 'for example Study laptop, Gaming PC', autocomplete: 'off' });
    const model = el('input', { type: 'text', maxlength: '60', value: p.model, placeholder: 'for example Dell OptiPlex 9020, HP Z240', autocomplete: 'off' });
    const form = el('form', { class: 'pc-profile-form' },
      el('label', { class: 'field' }, el('span', { text: 'Name' }), name),
      el('label', { class: 'field' }, el('span', { text: 'Make / model' }), model),
      el('div', { class: 'team-actions' }, el('button', { class: 'btn', type: 'submit', text: 'Save' })),
      el('p', { class: 'hint', text: v.here ? 'Shown in the left panel in place of "My PC". Only this PC keeps them.' : `Shown in the left panel in place of "${v.ownName}" (the name it gives itself, which stays as it is there). Only this PC keeps them.` }));
    form.addEventListener('submit', e => {
      e.preventDefault();
      saved('/api/pc/profile', { id: v.id, name: name.value, model: model.value }, 'Saved.');
    });
    return el('div', { class: 'pc-profile' }, el('div', { class: 'pc-photo' }, pic, el('div', { class: 'pc-photo-buttons' }, change, remove), file), form);
  }

  // ---- Its models: search, All | Chat | Pictures | Hidden, sort, pages of 10 ----

  const PAGE = 10;
  const CAT_WORD = { all: 'All', chat: 'Chat', image: 'Pictures', hidden: 'Hidden' };
  /** This PC's models after Hide, Unhide or Delete: the window and every list a model is picked from read them again. */
  async function modelsChanged() {
    if (typeof modelListsChanged === 'function') modelListsChanged();
    else loadModels().catch(() => undefined);
    await load(showing);
  }

  /** One model's row: its name, the memory it needs and its file, its state, and (this PC) Test speed, Hide and Delete. */
  function modelRow(v, x) {
    const state = x.busy ? (x.kind === 'image' ? 'Drawing now' : 'Answering now') : x.loaded ? (v.here ? 'In use' : 'Loaded there') : x.ollama ? 'Kept by Ollama' : x.hidden ? 'Hidden' : v.here ? 'Installed' : 'Loads when asked';
    const facts = [x.need ? `Needs about ${GBs(x.need)}` : '', x.bytes ? `file ${GBs(x.bytes)}` : '', x.kind === 'image' ? 'pictures' : '', x.speed?.expect ? app.speedWords(x.speed.expect) : ''].filter(Boolean).join(' · ');
    const said = rowSay[x.id];
    const acts = [];
    if (v.here) {
      if (x.kind === 'chat') acts.push(app.speedLink(`model:${x.id}`, msg => { rowSay[x.id] = msg; drawList(v); }, ok => {
        if (ok) delete rowSay[x.id];
        load(showing);
      }));
      const hide = el('button', { class: 'link', type: 'button', text: x.hidden ? 'Unhide' : 'Hide', title: x.hidden ? 'Show it again where a model is picked' : 'Keep it (and its speed tests) but leave it out where a model is picked' });
      hide.addEventListener('click', async () => {
        hide.disabled = true;
        try {
          await api('/api/models/hide', { id: x.id, kind: x.kind, hidden: !x.hidden });
          delete rowSay[x.id];
        } catch (e) {
          rowSay[x.id] = e.message;
        }
        await modelsChanged();
      });
      // Kept pressable whatever its state: pressed, it says why it cannot go now (loaded, hidden, kept by Ollama).
      const del = el('button', { class: 'icon-btn pc-bin', type: 'button', title: `Delete ${x.name} from this PC`, 'aria-label': `Delete ${x.name} from this PC` }, svgIcon(BIN, 18));
      del.addEventListener('click', async () => {
        if (x.hidden) {
          rowSay[x.id] = `${x.name} is hidden, which keeps it from Delete. Unhide it first, then Delete.`;
          return drawList(v);
        }
        const users = x.usedBy?.length ? ` ${x.usedBy.join(', ')} ${x.usedBy.length > 1 ? 'work' : 'works'} on it and would need another model.` : '';
        if (!(await askHere($('#pc-ask'), `Delete ${x.name} from this PC? It frees ${GBs(x.bytes)} and cannot be undone.${users}`, `Delete ${x.name}`, 'Keep it'))) return;
        try {
          await api('/api/models/delete', { id: x.id, kind: x.kind });
          delete rowSay[x.id];
        } catch (e) {
          rowSay[x.id] = e.message;
        }
        await modelsChanged();
      });
      acts.push(hide, del);
    }
    return el('li', { class: `pc-model${x.hidden ? ' hidden-model' : ''}` },
      el('span', { class: 'pc-model-text' },
        el('strong', { text: x.name }),
        el('span', { class: 'hint', text: facts || 'Size not known' })),
      el('span', { class: `pc-model-state${x.loaded || x.busy ? ' on' : ''}`, text: state }),
      acts.length ? el('span', { class: 'pc-model-acts' }, ...acts) : null,
      said ? el('p', { class: 'hint fault-line pc-model-said', role: 'status', text: said }) : null);
  }

  const listBox = el('div', { class: 'pc-models-list' });
  /** The list and its pages, drawn again on each search, filter, sort or page (the boxes above it keep the keyboard). */
  function drawList(v) {
    const q = list.q.trim().toLowerCase();
    const shown = v.models.filter(x => (list.cat === 'hidden' ? x.hidden : (!x.hidden || !v.here) && (list.cat === 'all' || x.kind === list.cat)) && (!q || x.name.toLowerCase().includes(q)));
    const by = { name: (a, b) => a.name.localeCompare(b.name), size: (a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name), loaded: (a, b) => Number(b.loaded || b.busy) - Number(a.loaded || a.busy) || a.name.localeCompare(b.name) };
    shown.sort(by[list.sort]);
    const pages = Math.max(1, Math.ceil(shown.length / PAGE));
    list.page = Math.min(list.page, pages - 1);
    const from = list.page * PAGE;
    const rows = shown.slice(from, from + PAGE);
    const go = n => el('button', { class: `btn pc-page${n === list.page ? ' on' : ''}`, type: 'button', text: String(n + 1), 'aria-current': n === list.page ? 'page' : null, 'aria-label': `Page ${n + 1}`, onclick: () => { list.page = n; drawList(v); } });
    // Up to 7 page buttons: the first, the last and those around this one.
    const nums = [...Array(pages).keys()].filter(n => pages <= 7 || n === 0 || n === pages - 1 || Math.abs(n - list.page) <= 2);
    const pager = pages > 1 ? el('div', { class: 'pc-pager' },
      el('button', { class: 'btn quiet', type: 'button', text: 'Previous', disabled: list.page === 0, onclick: () => { list.page--; drawList(v); } }),
      ...nums.flatMap((n, i) => (i && n - nums[i - 1] > 1 ? [el('span', { class: 'hint', text: '…' }), go(n)] : [go(n)])),
      el('button', { class: 'btn quiet', type: 'button', text: 'Next', disabled: list.page >= pages - 1, onclick: () => { list.page++; drawList(v); } })) : null;
    const none = !v.models.length ? (v.here ? 'No models on this PC yet. Models shows which ones fit.' : v.online ? `${v.name} lets this PC use none of its models yet. On that PC, Nodes and memory, tick the models other PCs may use.` : `${v.name} has not said which models it shares: it is off or not answering.`)
      : q ? `No ${list.cat === 'all' ? '' : `${CAT_WORD[list.cat].toLowerCase()} `}models match "${list.q.trim()}".` : `No ${CAT_WORD[list.cat].toLowerCase()} models.`;
    listBox.replaceChildren(
      rows.length ? el('ul', { class: 'pc-models' }, ...rows.map(x => modelRow(v, x))) : el('p', { class: 'hint', text: none }),
      el('div', { class: 'pc-list-foot' }, shown.length > PAGE ? el('span', { class: 'hint', text: `Showing ${from + 1} to ${from + rows.length} of ${shown.length}` }) : null, pager));
  }

  function modelsPart(v) {
    const count = k => v.models.filter(x => (k === 'hidden' ? x.hidden : (!x.hidden || !v.here) && (k === 'all' || x.kind === k))).length;
    const cats = ['all', 'chat', 'image', ...(v.here && v.models.some(x => x.hidden) ? ['hidden'] : [])];
    if (!cats.includes(list.cat)) list.cat = 'all';
    const search = el('input', { type: 'search', class: 'pc-search', placeholder: 'Search models', 'aria-label': 'Search models', autocomplete: 'off', value: list.q });
    search.addEventListener('input', () => {
      list.q = search.value;
      list.page = 0;
      drawList(v);
    });
    const shelf = el('div', { class: 'g-shelves pc-cats', role: 'group', 'aria-label': 'Show' }, ...cats.map(k => el('button', { class: 'g-shelf', type: 'button', 'aria-pressed': String(list.cat === k), text: `${CAT_WORD[k]} (${count(k)})`, onclick: e => {
      list.cat = k;
      list.page = 0;
      for (const b of shelf.children) b.setAttribute('aria-pressed', String(b === e.currentTarget));
      drawList(v);
    } })));
    const sort = el('select', { 'aria-label': 'Sort the models' }, el('option', { value: 'name', text: 'Name' }), el('option', { value: 'size', text: 'Size, largest first' }), el('option', { value: 'loaded', text: 'In use first' }));
    sort.value = list.sort;
    sort.addEventListener('change', () => {
      list.sort = sort.value;
      drawList(v);
    });
    drawList(v);
    const shown = v.here ? v.models.filter(x => !x.hidden).length : v.models.length;
    return el('section', { class: 'pc-part' },
      el('div', { class: 'pc-part-head' }, el('h3', { text: `${v.here ? 'Installed models' : 'Models it lets this PC use'} (${shown})` }), search),
      el('div', { class: 'pc-tools' }, shelf, el('label', { class: 'pc-sort' }, 'Sort ', sort)),
      el('p', { class: 'hint', text: `Memory needed is an estimate (a chat model with an 8K context).${v.here ? '' : ' Hide and Delete are on that PC itself.'}` }),
      listBox);
  }

  // ---- Who works on it, and its most-used models (last 7 days) ----

  function peoplePart(v) {
    const rows = v.staff.map(s => el('li', { class: 'pc-person' },
      app.avatar ? app.avatar(`staff:${s.id}`, initials(s.name)) : el('span', { class: 'rail-avatar', 'aria-hidden': 'true', text: initials(s.name) }),
      el('strong', { text: s.name }),
      el('span', { class: 'hint', text: s.role }),
      el('span', { class: 'pc-num', text: s.ms ? span(s.ms / 1000) : '—' })));
    const hire = el('button', { class: 'btn', type: 'button', text: 'Hire staff on this PC', onclick: () => {
      dlg.close();
      app.openHire?.({ pc: v.id });
    } });
    return el('section', { class: 'pc-part' },
      el('div', { class: 'pc-part-head' }, el('h3', { text: 'Staff using this PC' }), el('span', { class: 'hint', text: 'Time worked, last 7 days' })),
      rows.length ? el('ul', { class: 'pc-people' }, ...rows) : el('p', { class: 'hint', text: 'Nobody works on this PC yet.' }),
      el('div', { class: 'team-actions' }, hire));
  }

  function topPart(v) {
    const most = Math.max(1, ...v.top.map(x => x.ms));
    const rows = v.top.map(x => {
      const bar = el('span', { class: 'pc-bar-fill' });
      // Set through the style property: the page's security policy ignores a style attribute.
      bar.style.width = `${Math.max(2, (x.ms / most) * 100).toFixed(1)}%`;
      return el('li', { class: 'pc-top' },
        el('span', { class: 'pc-top-name', text: x.name }),
        el('span', { class: 'pc-bar', role: 'img', 'aria-label': `${x.name}: ${span(x.ms / 1000)} in ${x.answers} answer${x.answers === 1 ? '' : 's'}` }, bar),
        el('span', { class: 'pc-num', text: x.ms ? span(x.ms / 1000) : `${x.answers} ans.`, title: `${x.answers} answer${x.answers === 1 ? '' : 's'}` }));
    });
    return el('section', { class: 'pc-part' },
      el('div', { class: 'pc-part-head' }, el('h3', { text: 'Most-used models' }), el('span', { class: 'hint', text: 'Last 7 days' })),
      rows.length ? el('ul', { class: 'pc-tops' }, ...rows) : el('p', { class: 'hint', text: 'Nothing counted yet. Each answer from now on is counted here, for whoever it was for. Pictures are not counted.' }));
  }

  /** Its processor, memory and drive, as known: this PC reads them; a linked PC says its memory when it answers. */
  function specsPart(v) {
    const m = v.memory;
    const rows = [];
    if (v.cpu) rows.push(['Processor', `${v.cpu.name} (${v.cpu.cores} cores, ${v.cpu.threads} threads)`]);
    rows.push(['RAM', m?.ram?.total ? GBs(m.ram.total) : 'Not known yet']);
    rows.push(['Graphics memory', m?.gpu && !m.gpu.shared && m.gpu.total ? `${GBs(m.gpu.total)}${m.gpu.name ? ` (${m.gpu.name})` : ''}` : m?.ram?.total ? 'None of its own' : 'Not known yet']);
    if (v.disk) rows.push(['Disk free', `${GBs(v.disk.free)} of ${GBs(v.disk.total)} (the drive TOMLIN keeps its data on)`]);
    return el('section', { class: 'pc-specs' }, el('h3', { text: 'Specifications' }),
      el('dl', {}, ...rows.flatMap(([k, x]) => [el('dt', { text: k }), el('dd', { text: x })])));
  }

  function draw(v) {
    $('#pc-title').textContent = v.name;
    // ---- Behind this PC: Update it sends this PC's TOMLIN there (it starts the new version by itself), or why not ----
    // Behind: a lower version, or the same version with different files (its build id differs from this PC's).
    const older = !v.here && v.update;
    const built = b => (b ? `, build ${b}` : '');
    const version = v.here ? `TOMLIN ${v.version}${built(v.build)}`
      : v.fault ? `Did not answer just now: ${v.fault.replace(/\.$/, '')}. Its version is not known until it answers.`
      : older ? `${v.update.other ? `"${v.name}" runs ${v.version} but different files from this PC (build ${v.build} there, ${v.update.build} here)` : `Outdated: ${v.version} (this PC ${v.update.mine})`}${v.update.why ? `. ${v.update.why.charAt(0).toUpperCase()}${v.update.why.slice(1)}` : ''}`
      : v.version === v.ours ? `TOMLIN ${v.version}${built(v.build)}: Up to date${v.installed ? `: Last updated ${new Date(v.installed).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}`
      : `TOMLIN ${v.version ?? '(it did not say)'}: this PC runs ${v.ours}`;
    let go = null;
    if (older && !v.update.why) {
      go = el('button', { class: 'btn primary', type: 'button', text: 'Update it' });
      go.addEventListener('click', async () => {
        go.disabled = true;
        try {
          const r = await api('/api/network/update', { pc: v.id });
          // The update's own screen: its steps, and "Keep this window open".
          dlg.close();
          app.openUpdate(r.transfer);
        } catch (e) {
          say(e.message, true);
          go.disabled = false;
        }
      });
    }
    const on = v.here || (v.online && !v.fault);
    // This PC only: Repair install, Shortcut to desktop, Start on start up, under Manage PC.
    let manage = null;
    if (v.here) {
      manage = el('button', { class: 'btn quiet', type: 'button', text: 'Manage PC', 'aria-expanded': String(!installBox.hidden), 'aria-controls': 'pc-manage' });
      manage.addEventListener('click', () => {
        installBox.hidden = !installBox.hidden;
        manage.setAttribute('aria-expanded', String(!installBox.hidden));
      });
      installBox.id = 'pc-manage';
    }
    const head = el('div', { class: 'pc-head' },
      el('span', { class: 'pc-head-dot' }, el('span', { class: 'sdot', 'data-state': on ? 'on' : 'off', 'aria-hidden': 'true' })),
      el('span', { class: 'pc-head-name' }, el('strong', { text: on ? 'On' : 'Off or not answering' }), v.profile.model ? ` · ${v.profile.model}` : '', el('span', { class: 'sr-only', text: on ? ' (connected)' : ' (not connected)' })),
      el('span', { class: `pc-head-ver${v.fault ? ' fault-line' : ''}`, text: version }),
      go, manage);

    // ---- The strip: TOMLIN, tokens, time worked, power cost ----
    const updateWords = older && !v.update.why ? 'Update it with the button above' : older ? 'Update it there (see above)' : 'Update it there';
    const t = v.meter?.total ?? null;
    const powerCost = v.meter?.costs.power ?? v.mine.costs.power;
    const stat = (label, value, sub) => el('div', { class: 'pc-stat' }, el('span', { class: 'pc-stat-label', text: label }), el('strong', { class: 'pc-stat-value', text: value }), sub ? el('span', { class: 'hint', text: sub }) : null);
    const strip = el('div', { class: 'pc-strip' },
      stat('TOMLIN', v.version ?? '—', v.here ? 'This PC' : v.fault ? 'Not answering' : older ? (v.update.other ? 'Different files' : 'Outdated') : v.version === v.ours ? 'Up to date' : ''),
      stat('Tokens processed', t ? tokens(t.in + t.cached + t.out) : '—', t ? `since ${when(v.meter.since)}` : 'Not counted there'),
      stat('Time worked', t?.ms ? span(t.ms / 1000) : '—', t ? `${t.answers.toLocaleString('en-GB')} answer${t.answers === 1 ? '' : 's'}` : ''),
      stat('Est. power cost', powerCost === null ? '—' : money(powerCost), powerCost === null ? 'Set the watts and price below' : 'While working, your watts and price'));
    const tokenLine = v.meter
      ? el('p', { class: 'hint', text: `Since ${when(v.meter.since)}: ${tokens(t.in + t.cached + t.out)} tokens (${tokens(t.in + t.cached)} read, ${tokens(t.cached)} of them from the cache; ${tokens(t.out)} written) in ${t.answers.toLocaleString('en-GB')} answer${t.answers === 1 ? '' : 's'}, ${t.ms ? span(t.ms / 1000) : 'no time'} of work. ${v.here ? 'Everything the chat models on this PC did: chats, job steps, work for linked PCs, programs through /v1. Pictures are not counted.' : 'Everything that PC\'s chat models did, for anyone: its owner, this PC and other PCs. Pictures are not counted.'}` })
      : el('p', { class: 'hint', text: `That PC runs an older TOMLIN that does not count its work. ${updateWords}: it counts from then on.` });

    // ---- Uptime: hidden for now; the figures are still kept and sent ----
    const up = [];
    if (SHOW_UPTIME) {
      if (!v.here) up.push(el('p', {}, v.online ? 'On now.' : el('strong', { text: `Off or not answering now${v.saidAt ? ` (these figures are from ${when(v.saidAt)})` : ''}.` })));
      if (v.up) {
        up.push(el('p', { text: `TOMLIN running for ${span((Date.parse(v.saidAt) - Date.parse(v.up.since)) / 1000)} (since ${when(v.up.since)}).` }));
        up.push(el('p', { text: `The PC has been on for ${span(v.up.pc)}.` }));
      } else if (!v.here) up.push(el('p', { class: 'hint', text: `That PC runs an older TOMLIN that does not say how long it has been up. ${updateWords}.` }));
      if (v.checks) up.push(el('p', { class: 'hint', text: v.checks.asked ? `Answered ${v.checks.ok.toLocaleString('en-GB')} of ${v.checks.asked.toLocaleString('en-GB')} checks in the last 7 days (${Math.round((v.checks.ok / v.checks.asked) * 100)}%). This PC asks once a minute while it is on.` : 'No checks yet: this PC asks once a minute while it is on.' }));
      up.unshift(el('h3', { text: 'Uptime' }));
    }

    // ---- Power costs & settings (folded) ----
    const fold = el('details', { class: 'pc-fold' }, el('summary', {}, el('span', { text: 'Power costs & settings' }), el('span', { class: 'hint', text: powerCost === null ? 'No watts or price set' : `${money(powerCost)} estimated so far` })));
    const watts = el('input', { id: 'pc-watts', type: 'number', min: '1', max: '5000', step: '1', inputmode: 'decimal', value: v.power.watts ?? '', placeholder: 'for example 120' });
    const kwh = el('input', { id: 'pc-kwh', type: 'number', min: '0.001', max: '10', step: '0.001', inputmode: 'decimal', value: v.power.kwh ?? '', placeholder: 'for example 0.30' });
    const save = el('button', { class: 'btn', type: 'button', text: 'Save power' });
    save.addEventListener('click', async () => {
      try {
        draw(await api('/api/pc/power', { id: v.id, watts: watts.value, kwh: kwh.value }));
        say('Saved. The power column uses them now.');
      } catch (e) {
        say(e.message, true);
      }
    });
    fold.append(el('h3', { text: 'Power (optional)' }),
      el('div', { class: 'pc-power' },
        el('label', { class: 'field' }, el('span', { text: 'Power draw while a model works (watts)' }), watts),
        el('label', { class: 'field' }, el('span', { text: 'Power price (US$ per kWh)' }), kwh),
        save),
      el('p', { class: 'hint', text: 'This tool only estimates power costs from when the node is actively working. Idle times are excluded.' }));

    // ---- Cost per project ----
    const apis = v.apis;
    const table = el('table', { class: 'pc-costs' },
      el('thead', {}, el('tr', {}, el('th', { scope: 'col', text: 'Project' }), el('th', { scope: 'col', class: 'num', text: 'Tokens read (cached) / written' }), el('th', { scope: 'col', class: 'num', text: 'Working time' }), el('th', { scope: 'col', class: 'num', text: 'Power' }), ...apis.map(a => el('th', { scope: 'col', class: 'num', text: a.name })))),
      el('tbody', {}, ...v.rows.map(r => costRow(r.name, r.tally, r.costs, apis)),
        ...(v.rows.length > 1 ? [costRow('All your work on this PC', v.mine.tally, v.mine.costs, apis, true)] : []),
        ...(v.meter && !v.here ? [costRow('Total', v.meter.total, v.meter.costs, apis, true)] : [])));
    fold.append(el('h3', { text: 'Estimated cost per project' }),
      v.here ? '' : el('p', { class: 'hint', text: v.synced ? 'Nodes token logs:' : v.online && !v.meter ? `${v.name} runs an older TOMLIN that keeps no log of its own, so these are as counted here from its answers.` : `${v.name} did not answer, so these are as counted here from its answers (and its log as last read).` }),
      v.rows.length || (v.meter && !v.here && v.meter.total.in + v.meter.total.out > 0) ? el('div', { class: 'pc-table-wrap' }, table) : el('p', { class: 'hint', text: 'Nothing counted yet. Every answer from now on is.' }),
      el('p', { class: 'hint', text: 'Power = watts × working hours ÷ 1,000 × price per kWh. The API column estimates the equivalent price if this was via an API key.' }),
      el('p', { class: 'hint', text: 'From the cache: the start of a chat the model had read on the turn before. It is not read again (no work, no power), but an API still bills it, at its lower cached price.' }));

    // ---- Price per million tokens ----
    const pm = v.mine.costs.powerPerMillion ?? v.meter?.costs.powerPerMillion ?? null;
    fold.append(el('h3', { text: 'Price per million tokens' }),
      el('ul', { class: 'pc-prices' },
        pm === null ? '' : el('li', { text: `This PC: about ${money(pm)} per million tokens (power while working, over every token read, cached and written, as an API counts them).` }),
        ...apis.map(a => el('li', { text: `${a.name}: US$${a.in} per million read, US$${a.cached} per million from its cache, US$${a.out} per million written.` }))));
    const prices = el('details', { class: 'pc-edit-prices' }, el('summary', { text: `Prices checked ${v.checked}. Change them` }));
    const inputs = apis.map(a => {
      const name = el('input', { type: 'text', maxlength: '60', value: a.name, 'aria-label': `Name of the API compared (now ${a.name})` });
      const inp = el('input', { type: 'number', min: '0', step: '0.01', value: a.in, 'aria-label': `${a.name}: US$ per million tokens read` });
      const cached = el('input', { type: 'number', min: '0', step: '0.01', value: a.cached, 'aria-label': `${a.name}: US$ per million tokens read from its cache` });
      const out = el('input', { type: 'number', min: '0', step: '0.01', value: a.out, 'aria-label': `${a.name}: US$ per million tokens written` });
      prices.append(el('div', { class: 'pc-price-row' }, name, el('span', { class: 'hint', text: 'read' }), inp, el('span', { class: 'hint', text: 'cached' }), cached, el('span', { class: 'hint', text: 'written' }), out, el('span', { class: 'hint', text: 'US$ per million' })));
      return { id: a.id, name, inp, cached, out };
    });
    const savePrices = el('button', { class: 'btn', type: 'button', text: 'Save prices' });
    savePrices.addEventListener('click', async () => {
      try {
        draw(await api('/api/pc/prices', { id: v.id, apis: inputs.map(x => ({ id: x.id, name: x.name.value, in: x.inp.value, cached: x.cached.value, out: x.out.value })) }));
        say('Saved: every PC\'s window uses these prices now.');
      } catch (e) {
        say(e.message, true);
      }
    });
    const reset = el('button', { class: 'btn quiet', type: 'button', text: `Put back the prices checked ${v.checked}` });
    reset.addEventListener('click', async () => {
      try {
        draw(await api('/api/pc/prices', { id: v.id, reset: true }));
        say('The checked prices are back.');
      } catch (e) {
        say(e.message, true);
      }
    });
    prices.append(el('div', { class: 'team-actions' }, savePrices, reset));
    fold.append(prices);
    // Opened before (a price saved, the window drawn again): it stays open.
    fold.open = foldOpen;
    fold.addEventListener('toggle', () => { foldOpen = fold.open; });

    body.replaceChildren(head, v.here ? installBox : '', el('div', { class: 'pcw' },
      el('div', { class: 'pcw-left' }, profileBlock(v), specsPart(v)),
      el('div', { class: 'pcw-right' }, strip, tokenLine, ...up, modelsPart(v),
        el('div', { class: 'pc-two' }, peoplePart(v), topPart(v)),
        fold)));
  }
  let foldOpen = false;
  installBox.hidden = true;

  /** Opens a PC's window: 'here' for this PC, else a linked PC's id. */
  app.openPc = id => {
    say('');
    body.replaceChildren(el('p', { class: 'hint', text: 'Reading…' }));
    if (!dlg.open) dlg.showModal();
    // "Its settings" only in this PC's own window for now (dropped from a linked PC's).
    $('#pc-more').hidden = !!id && id !== 'here';
    load(id || 'here');
  };
  $('#pc-more').addEventListener('click', () => {
    dlg.close();
    app.pcMore?.(showing);
  });
}
