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
  /** Settings > This PC: the box the models list is drawn into there (the same list as in this PC's window), and its confirm box. */
  let page = null;
  let pageAsk = null;
  let pageTop = null;
  const askBox = () => (!dlg.open && pageAsk ? pageAsk : $('#pc-ask'));
  // The Updates page's section is lent to this window (Manage PC and updates): given back when the window closes.
  dlg.addEventListener('close', () => {
    app.updateInstallBack?.();
    // A question left open (Move, Delete) is called off with the window: it must not be waiting when the window opens again.
    const ask = $('#pc-ask');
    if (ask && !ask.hidden && ask.cancelAsk) {
      const cancel = ask.cancelAsk;
      ask.cancelAsk = null;
      cancel();
    }
  });
  /** The models list as you left it on this PC: the words searched, the kind shown, the order and the page. */
  const list = { q: '', cat: 'all', sort: 'name', page: 0 };
  /** What a model's row last said (a speed test that failed, a Delete refused), kept across the redraws. */
  const rowSay = {};
  const BIN = 'M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Zm4 2v8h2v-8h-2Zm4 0v8h2v-8h-2Z';
  const PC_PICTURE = 'M3 4h18a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM2 14h20M12 17v4M7 21h10';
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
    // It sits below the window's fold: a Save with nothing to see looks dead.
    if (text) p.scrollIntoView({ block: 'nearest' });
  }

  /** Each load's turn: an answer for a PC no longer shown (another opened, or this one opened again) is not drawn. */
  let turn = 0;
  /** `fresh`: the window was just opened. A linked PC's is drawn at once from what it said last, then from its answer now. */
  async function load(id, fresh = false) {
    if (id !== showing) Object.assign(list, { q: '', cat: 'all', sort: 'name', page: 0 });
    showing = id;
    const onPage = !dlg.open && page;
    const mine = ++turn;
    const quick = fresh && id !== 'here' && !onPage;
    let drawn = false;
    try {
      // A PC that is off took over 10 s to say so, with the window stuck on "Reading…": now what it said last shows at once.
      if (quick) {
        const was = await api(`/api/pc?id=${encodeURIComponent(id)}&quick=1`);
        if (mine !== turn) return;
        draw(was);
        drawn = true;
      }
      const v = await api(`/api/pc?id=${encodeURIComponent(id)}`);
      if (mine !== turn) return;
      draw(v);
    } catch (e) {
      if (mine !== turn) return;
      // Drawn already from what it said last: that stays, and the line under it says why it was not read again.
      if (drawn) return say(e.message, true);
      (onPage ? page : body).replaceChildren(el('p', { class: 'fault', text: e.message }));
      return;
    }
    if (id !== 'here' || onPage) return;
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
  let thisPc = null; // this PC's window data (version, build, tokens), for the Updates and Install tiles
  const installBox = el('div', { class: 'pc-install' });

  /** "Start when this PC starts", as the tick in Network saves it (a node asks for the app lock PIN). */
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
    const dateOf = iso => (iso ? new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
    if (!s.installed || s.outside) {
      parts.push(el('p', {
        text: !s.installed ? `Not installed: TOMLIN runs from ${s.here}.`
          : `This TOMLIN runs from a folder (${s.here}), not from the install in ${s.root}${s.current ? `, which has ${s.current.version}` : ''}. Updates from linked PCs reach the copy that runs, so the install stays behind.`,
      }));
    }
    if (result) {
      if (result.done.length) parts.push(el('p', { text: 'Repaired:' }), el('ul', { class: 'pc-repair' }, ...result.done.map(t => el('li', { text: t }))));
      if (result.failed.length) parts.push(el('p', { class: 'fault-line', text: 'Not repaired:' }), el('ul', { class: 'pc-repair' }, ...result.failed.map(t => el('li', { text: t }))));
      if (!result.done.length && !result.failed.length) parts.push(el('p', { text: 'Nothing needed repairing.' }));
    } else if (s.steps.length) parts.push(el('p', { text: 'Repair install would:' }), el('ul', { class: 'pc-repair' }, ...s.steps.map(t => el('li', { text: t }))));
    for (const l of (result ?? s).left) parts.push(el('p', { class: 'hint', text: l }));
    const nothingToRepair = !result && s.installed && !s.steps.length && !s.left.length;

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
    const deskThere = !!s.desktop?.there;
    const desk = el('button', { class: 'btn', type: 'button', text: 'Install desktop shortcut', disabled: deskThere });
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
    // Each button with its state beside it: "✓ Already installed" instead of a sentence about what is not done.
    const done = (on, text) => (on ? el('span', { class: 'pc-done', text: `✓ ${text}` }) : null);
    parts.push(
      el('div', { class: 'pc-install-row' }, repair, nothingToRepair ? el('span', { class: 'hint', text: 'Nothing to repair' }) : null),
      el('div', { class: 'pc-install-row' }, desk, done(deskThere, 'Already installed')),
      el('div', { class: 'pc-install-row' }, start, done(s.autostart, 'Already on')),
      // The one place for what linked PCs may do here (cluster use too), on Network: opened from here as well.
      el('div', { class: 'pc-install-row' }, el('button', { class: 'btn', type: 'button', text: 'Sharing and cluster permissions', onclick: () => { dlg.close(); app.openSharePermissions?.(); } }), el('span', { class: 'hint', text: 'What linked PCs may do on this PC' })));
    // Under the buttons: where, when, and the work it has done.
    const out = thisPc?.meter?.total?.out;
    const facts = [['Install location', s.installed ? s.root : s.here], ['Installed', dateOf(s.installedOn)], ['Tokens generated', out != null ? tokens(out) : '']].filter(f => f[1]);
    parts.push(el('dl', { class: 'pc-install-facts' }, ...facts.flatMap(([k, x]) => [el('dt', { text: k }), el('dd', { text: x })])));
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
    // The left half: updates (the button, then the version and when it was last updated); the right half: the install.
    // Updates are done right here: the Updates page's own section (Check for updates, Update via zip, Update now) sits in this tile.
    const updHost = el('div', { class: 'pc-update-host' });
    const upFacts = [['Version', thisPc ? `TOMLIN ${thisPc.version}${thisPc.build ? `, build ${thisPc.build}` : ''}` : s.version], ['Last updated', dateOf(s.updatedOn)]].filter(f => f[1]);
    const updates = el('div', { class: 'pc-tile' }, el('h3', { text: 'Updates' }),
      updHost,
      el('dl', { class: 'pc-install-facts' }, ...upFacts.flatMap(([k, x]) => [el('dt', { text: k }), el('dd', { text: x })])));
    installBox.replaceChildren(el('div', { class: 'pc-tiles' }, updates, el('div', { class: 'pc-tile' }, ...parts)));
    app.updateInstallInto?.(updHost);
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
    const state = x.busy ? (x.kind === 'image' ? 'Drawing now' : 'Answering now') : x.loaded ? (v.here ? 'In use' : 'Loaded there') : x.ollama ? 'Kept by Ollama' : x.hidden ? 'Hidden' : '';
    const facts = [x.kind === 'image' ? 'Pictures' : 'Chat', !v.here && x.speed?.expect ? app.speedTk(x.speed.expect) : '', x.need ? `needs about ${GBs(x.need)}` : ''].filter(Boolean).join(' · ');
    const said = rowSay[x.id];
    // On show: Test speed. Behind the "…": everything done less often.
    const acts = [];
    const more = [];
    if (v.here) {
      // The speed tile: the button on top (Re-test once it has been tested), a line, then the speed in green.
      if (x.kind === 'chat') {
        const test = app.speedLink(`model:${x.id}`, msg => { rowSay[x.id] = msg; drawList(v); }, ok => {
          if (ok) delete rowSay[x.id];
          load(showing);
        }, x.speed?.test ? 'Re-test speed' : 'Test speed');
        acts.push(el('span', { class: 'pc-speed' }, test, x.speed?.expect > 0 ? el('span', { class: 'pc-speed-fig', text: app.speedTk(x.speed.expect) }) : null));
      }
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
      const del = el('button', { class: 'icon-btn pc-bin', type: 'button', title: `Delete ${x.name} from this PC`, 'aria-label': `Delete ${x.name} from this PC` }, svgIcon(BIN, 18), el('span', { text: 'Delete' }));
      // A Move in progress: the row says so, then what became of it (the model list is read again when it ends).
      const moving = r => {
        if (r.said) rowSay[x.id] = r.said;
        else {
          rowSay[x.id] = r.copy ? `Copying ${x.name} to "${r.to}". It stays on this PC; the progress is under Network, Models on my other PCs.`
            : `Moving ${x.name} to "${r.to}". It stays on this PC until the copy there is checked; the progress is under Network, Models on my other PCs.`;
          app.followMove(r.transfer, async t => {
            rowSay[x.id] = t.state === 'done' ? t.said : `${t.state === 'stopped' ? 'Stopped' : r.copy ? 'Not copied' : 'Not moved'}: ${t.said}`;
            await modelsChanged();
          });
        }
        drawList(v);
      };
      del.addEventListener('click', async () => {
        if (x.hidden) {
          rowSay[x.id] = `${x.name} is hidden, which keeps it from Delete. Unhide it first, then Delete.`;
          return drawList(v);
        }
        const pick = await app.deleteAsk(askBox(), x, { pc: 'here', text: `Delete ${x.name} from this PC? It frees ${GBs(x.bytes)} and cannot be undone.`, yes: `Delete ${x.name}` });
        if (pick === null) return;
        if (pick !== 'delete') return moving(pick);
        try {
          await api('/api/models/delete', { id: x.id, kind: x.kind });
          delete rowSay[x.id];
        } catch (e) {
          rowSay[x.id] = e.message;
        }
        await modelsChanged();
      });
      // Move: copied to a linked PC, checked byte for byte there, and only then removed from this PC (src/jobrun/copies.ts moveTo).
      const move = el('button', { class: 'link', type: 'button', text: 'Move to another PC', title: `Copy ${x.name} to a linked PC, check the copy, then remove it from this PC` });
      move.addEventListener('click', async () => {
        const r = await app.moveAsk(askBox(), x);
        if (r) moving(r);
      });
      // Move on its own line; Hide at the left and Delete at the right of the next one.
      more.push(...(x.ollama ? [] : [move]), el('span', { class: 'pc-more-row' }, hide, del));
    } else {
      // A linked PC's model: deleted over the link, so a PC nobody sits at can be kept tidy. That PC's own tick ("Accept
      // models from linked PCs") decides, and it refuses a hidden or loaded model, saying why in its own words.
      const del = el('button', { class: 'icon-btn pc-bin', type: 'button', title: `Delete ${x.name} from "${v.name}"`, 'aria-label': `Delete ${x.name} from ${v.name}` }, svgIcon(BIN, 18), el('span', { text: 'Delete' }));
      del.addEventListener('click', async () => {
        if ((await app.deleteAsk(askBox(), x, { pc: v.id, text: `Delete ${x.name} from "${v.name}"? It frees ${GBs(x.bytes)} there and cannot be undone: it would have to be sent again.`, yes: `Delete ${x.name}` })) !== 'delete') return;
        // That PC asks its own app lock PIN, as for an update: asked here, and again after a wrong one.
        let nodePin;
        for (;;) {
          try {
            const r = await api('/api/network/model-remove', nodePin === undefined ? { pc: v.id, id: x.id, kind: x.kind } : { pc: v.id, id: x.id, kind: x.kind, nodePin });
            rowSay[x.id] = r.said || 'Deleted.';
            break;
          } catch (e) {
            if (e.data?.needNodePin && typeof askAppPin === 'function') {
              nodePin = await askAppPin(nodePin === undefined ? '' : e.message, v.name, { button: 'Delete', about: `Deleting a model on another PC needs the PIN (or password) that opens TOMLIN on "${v.name}", typed here for this delete. It is checked there and not kept here.` });
              if (nodePin !== null) continue;
            }
            rowSay[x.id] = e.message;
            break;
          }
        }
        await modelsChanged();
      });
      more.push(del);
    }
    // Find the fastest setup: a chat model here, or one a linked PC lends (that PC runs the test on itself).
    if (x.kind === 'chat' && !x.ollama) more.unshift(app.finderButton(v.here ? x.id : `remote:${v.id}:${x.id}`, { name: x.name, pcName: v.name, link: true }));
    return el('li', { class: `pc-model${x.hidden ? ' hidden-model' : ''}` },
      el('span', { class: 'pc-model-text' },
        el('strong', {}, x.name, v.here && x.disk?.hdd ? el('span', { class: 'pc-hdd', title: `On ${x.disk.drive}, a hard disk: it loads slower than from an SSD`, text: 'HDD' }) : null),
        el('span', { class: 'hint', text: facts || 'Size not known' })),
      state ? el('span', { class: `pc-model-state${x.loaded || x.busy ? ' on' : ''}`, text: state }) : null,
      acts.length || more.length ? el('span', { class: 'pc-model-acts' }, ...acts,
        more.length ? el('details', { class: 'pc-model-more' }, el('summary', { 'aria-label': `More for ${x.name}`, title: 'Find the fastest setup, Hide, Move, Delete', text: '…' }), el('span', { class: 'pc-model-more-list' }, ...more)) : null) : null,
      x.staffNote ? el('p', { class: 'hint pc-model-staff', text: x.staffNote }) : null,
      // One row for a model found twice (src/server/thispc.ts copiesWords); a split model with a part missing says so.
      x.copiesNote ? el('p', { class: 'hint pc-model-staff', text: x.copiesNote }) : null,
      x.incomplete ? el('p', { class: 'hint fault-line pc-model-staff', text: x.incomplete }) : null,
      diskLine(v, x),
      said ? el('p', { class: 'hint fault-line pc-model-said', role: 'status', text: said }) : null);
  }

  /**
   * A model on a hard disk (Windows says so; nothing when it does not): the "HDD" mark, the line, and Move to SSD when an
   * SSD of this PC has room and the model is TOMLIN's own. With the load time when it is known. Nothing blocks a load.
   */
  function diskLine(v, x) {
    const d = v.here ? x.disk : null;
    if (!d || (!d.hdd && !d.loadSeconds)) return null;
    const time = d.loadSeconds ? `Loads in about ${span(d.loadSeconds)}${d.hdd ? ` from ${d.drive}` : ''}.` : '';
    const words = [d.hdd ? 'Move to SSD for better performance.' : '', time].filter(Boolean).join(' ');
    let go = null;
    if (d.hdd && d.ssd && d.canMove) {
      go = el('button', { class: 'link', type: 'button', text: `Move to SSD (${d.ssd.drive})` });
      go.addEventListener('click', async () => {
        const yes = await askPick(askBox(), `Move ${x.name} (${GBs(x.bytes)}) from ${d.drive} (a hard disk) to ${d.ssd.drive} (an SSD)? It is copied there, checked, and only then removed from ${d.drive}.${d.ssd.newHome ? ` Models are then kept in ${d.ssd.drive}\\TOMLIN models: new downloads go there too, and the models left on ${d.drive} are still used where they are.` : ''}`, [{ label: `Move to ${d.ssd.drive}`, value: 'go', danger: false }], 'Keep it here');
        if (yes !== 'go') return;
        go.disabled = true;
        try {
          const r = await api('/api/models/to-ssd', { id: x.id });
          rowSay[x.id] = r.said;
          drawList(v);
          // Followed until it ends (the same move as Where models are kept: /api/models/where says how it went).
          const tick = async () => {
            const w = await api('/api/models/where').catch(() => null);
            if (w?.move?.state === 'moving') return void setTimeout(tick, 2000);
            rowSay[x.id] = w?.move?.said || 'The move ended: Models shows where it is now.';
            await modelsChanged();
          };
          setTimeout(tick, 2000);
        } catch (e) {
          rowSay[x.id] = e.message;
          drawList(v);
        }
      });
    }
    return el('p', { class: `hint pc-model-staff${d.hdd ? ' pc-slow-disk' : ''}` }, words, go ? ' ' : null, go);
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
    const none = !v.models.length ? (v.here ? 'No models on this PC yet. Models shows which ones fit.' : v.online ? `${v.name} has no models yet. Send one there from Models.` : `${v.name} has not said which models it shares: it is off or not answering.`)
      : q ? `No ${list.cat === 'all' ? '' : `${CAT_WORD[list.cat].toLowerCase()} `}models match "${list.q.trim()}".` : `No ${CAT_WORD[list.cat].toLowerCase()} models.`;
    listBox.replaceChildren(
      rows.length ? el('ul', { class: 'pc-models' }, ...rows.map(x => modelRow(v, x))) : el('p', { class: 'hint', text: none }),
      el('div', { class: 'pc-list-foot' }, shown.length > PAGE ? el('span', { class: 'hint', text: `Showing ${from + 1} to ${from + rows.length} of ${shown.length}` }) : null, pager));
  }

  /**
   * "Free space: C: 162 GB · D: 1611 GB", above Free up space: each drive of that PC with the room it has now. A PC that
   * does not list its drives (an older TOMLIN) gives the one drive it keeps its data on; none known gives nothing.
   */
  function freeSpaceLine(v) {
    const drives = v.drives?.length ? v.drives : [];
    const one = v.disk ?? v.diskThere;
    const words = drives.length
      ? drives.map(d => `${d.drive}${d.label ? ` ${d.label}` : ''} ${GBs(d.free)}`).join(' · ')
      : one ? `${GBs(one.free)} on the drive it keeps its data on` : '';
    return words ? el('span', { class: 'hint pc-free-space', title: 'Free space on each drive of this PC, as it said just now', text: `Free space: ${words}` }) : null;
  }

  // ---- This PC: what it is (admin, node, network backup) and where its models and backups are kept ----
  // One element kept across redraws, so a folder typed and not yet kept stays typed; the figures are read again each time it is drawn.
  const here = { el: null, share: null, linked: null, models: null, backups: null, form: null, said: { models: '', backups: '' }, fault: '', shareFault: '', timer: 0, wasMoving: false };

  /** Saves a change to this PC's sharing as the Network page does (a node asks for the app lock PIN): the new state, or null when cancelled. */
  async function saveShare(body) {
    let appPin;
    for (;;) {
      try {
        return await api('/api/share', appPin === undefined ? body : { ...body, appPin });
      } catch (e) {
        if (!e.data?.needAppPin || typeof askAppPin !== 'function') throw e;
        appPin = await askAppPin(appPin === undefined ? '' : e.message);
        if (appPin === null) return null;
      }
    }
  }

  async function readThis() {
    clearTimeout(here.timer);
    try {
      const [n, others, models, backups] = await Promise.all([api('/api/nodes'), api('/api/nodes/others').catch(() => null), api('/api/models/where').catch(() => null), api('/api/backups/where').catch(() => null)]);
      Object.assign(here, { share: n.share, linked: others ? (others.pcs ?? []).filter(p => p.role !== 'guest').length : null, models, backups, fault: '' });
    } catch (e) {
      here.fault = e.message;
    }
    paintThis();
    const moving = here.models?.move?.state === 'moving';
    if (moving) here.timer = setTimeout(readThis, 1500);
    // The move ended: each model shows in its new place.
    else if (here.wasMoving) load(showing);
    here.wasMoving = moving;
  }

  function paintThis() {
    const sh = here.share;
    const title = el('h3', { id: 'pc-this-title', text: 'This PC is' });
    if (!sh) return here.el.replaceChildren(title, el('p', { class: here.fault ? 'fault-line' : 'hint', text: here.fault || 'Reading…' }));
    const allow = sh.allow ?? {};
    const node = sh.on === true;
    const backup = node && allow.backup === true;
    const change = async body => {
      here.shareFault = '';
      try {
        const r = await saveShare(body);
        if (r) here.share = r;
      } catch (e) {
        here.shareFault = e.message;
      }
      await readThis();
    };
    const role = (label, about, on, disabled, onChange) => {
      const input = el('input', { type: 'checkbox', role: 'switch', 'aria-label': label, disabled });
      input.checked = on;
      input.addEventListener('change', () => onChange(input.checked));
      return el('label', { class: `pc-role${disabled ? ' pc-role-off' : ''}`, title: about }, el('span', { class: 'set-sw' }, input, el('i', { 'aria-hidden': 'true' })), el('span', { class: 'pc-role-name', text: label }));
    };
    const linked = here.linked === null ? '' : here.linked ? ` · ${here.linked} linked PC${here.linked === 1 ? '' : 's'}` : ' · no PC linked yet (Network)';
    const roles = el('div', { class: 'pc-roles' },
      el('span', { class: 'pc-role pc-role-admin', title: 'Any PC becomes an admin when it links other PCs (Network). It can also be a node and a network backup.' }, el('b', { text: 'An admin PC' }), el('span', { class: 'hint', text: linked })),
      el('span', { class: 'pc-role-bar', 'aria-hidden': 'true' }),
      role('A node', 'Other PCs can use this PC: its models, its graphics card and RAM (what they may do is under Sharing and cluster permissions).', node, false, on => change({ on })),
      role('A network backup', 'Other PCs keep their backups and project history here. It listens on the home network like a node, so it needs the node switch.', backup, !node, on => change({ allow: { ...allow, backup: on } })));
    const where = (key, name, w, disabled, off) => {
      const shown = el('span', { class: 'pc-store-where' }, w ? `${w.missing ?? w.dir}${w.missing ? ' (not there now)' : w.free !== null ? `, ${GBs(w.free)} free on ${w.drive}` : ''}` : 'not known');
      const open = here.form === key && !disabled;
      const btn = el('button', { class: 'btn quiet', type: 'button', text: 'Change folder or drive', disabled, 'aria-expanded': String(open), onclick: () => openStoreForm(key) });
      const input = el('input', { type: 'text', autocomplete: 'off', placeholder: key === 'models' ? 'D:\\Tomlin\\models' : 'D:\\Tomlin\\backups', 'aria-label': `The folder to keep ${key} in`, id: `pc-store-${key}`, value: w && !w.isUsual ? w.dir : '' });
      // One click per drive (FAT drives are refused, so not offered): it fills <drive>\Tomlin\<models or backups>, to keep or change.
      const fit = (w?.drives ?? []).filter(d => d.total > 0 && !/^fat/i.test(d.fs || ''));
      const drivesRow = fit.length ? el('div', { class: 'pc-store-drives', role: 'group', 'aria-label': `Drives to keep ${key} on` }, el('span', { class: 'hint', text: 'Pick a drive:' }),
        ...fit.map(d => el('button', { class: 'btn quiet', type: 'button', title: `Fills in ${d.drive}\\Tomlin\\${key}${d.removable ? ' (a removable drive: keep it plugged in)' : ''}`, text: `${d.drive}${d.label ? ` ${d.label}` : ''} · ${GBs(d.free)} free`, onclick: () => {
          input.value = `${d.drive}\\Tomlin\\${key}`;
          input.focus();
        } }))) : null;
      const form = open ? el('form', { class: 'pc-store-form' }, drivesRow, el('label', { class: 'field grow' }, el('span', { class: 'sr-only', text: `The folder to keep ${key} in` }), input), el('button', { class: 'btn', type: 'submit', text: `Keep ${key} here` }), w && !w.isUsual ? el('button', { class: 'btn quiet', type: 'button', text: 'Back to the usual folder', onclick: () => keepIn(key, null) }) : null) : null;
      form?.addEventListener('submit', e => {
        e.preventDefault();
        keepIn(key, input.value);
      });
      const said = here.said[key] || (disabled ? off : '');
      const toMove = key === 'models' && w?.toMove?.files ? el('p', { class: 'hint' }, `${w.toMove.files} model file${w.toMove.files === 1 ? ' is' : 's are'} still in ${w.toMove.from.join(' and ')} (${GBs(w.toMove.bytes)}). `, w.move?.state === 'moving' ? `Moving ${w.move.now || 'the models'}: ${GBs(w.move.got)} of ${GBs(w.move.bytes)}.` : el('button', { class: 'btn', type: 'button', text: 'Move them to the new folder', onclick: () => api('/api/models/move', {}).then(readThis, e => { here.said.models = e.message; paintThis(); }) })) : null;
      const kept = key === 'backups' && w && !disabled ? el('span', { class: 'hint', text: w.kept ? ` ${w.kept} linked PC${w.kept === 1 ? ' keeps' : 's keep'} backups here now.` : ' No backups kept here yet.' }) : null;
      return el('div', { class: `pc-store-row${disabled ? ' pc-store-off' : ''}` }, el('div', { class: 'pc-store-line' }, el('b', { text: name }), shown, kept, btn), form, said ? el('p', { class: 'hint', role: 'status', text: said }) : null, toMove);
    };
    here.el.replaceChildren(...[title, roles,
      here.shareFault || here.fault ? el('p', { class: 'fault-line', role: 'alert', text: here.shareFault || here.fault }) : null,
      el('div', { class: 'pc-store' },
        where('models', 'Models are kept in', here.models, false, ''),
        where('backups', 'Backups from other PCs are kept in', here.backups, !backup, 'Switch on "A network backup" to keep other PCs\' backups on this PC.'))].filter(Boolean));
  }

  /** Keeps models or backups in `dir` (null: the usual folder), and says how it went in the row. */
  async function keepIn(key, dir) {
    try {
      const w = await api(`/api/${key}/where`, { dir });
      here.said[key] = w.said ?? '';
      here.form = null;
    } catch (e) {
      here.said[key] = e.message;
    }
    await readThis();
  }

  /** Opens the folder box of one row ("models" or "backups"), and puts the cursor in it. */
  function openStoreForm(key) {
    here.form = here.form === key ? null : key;
    here.said[key] = '';
    paintThis();
    if (here.form) here.el.scrollIntoView({ block: 'nearest' });
    document.getElementById(`pc-store-${key}`)?.focus();
  }

  function thisPcPart() {
    if (!here.el) here.el = el('section', { class: 'pc-part pc-card-part pc-this', 'aria-labelledby': 'pc-this-title' });
    if (!here.share) paintThis();
    readThis();
    return here.el;
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
    // Search, filters and sort are for a long list: with a few models they are clutter. A hidden model still needs its filter.
    const many = v.models.length > 6;
    const add = v.here ? el('button', { class: 'btn', type: 'button', text: 'Get a model', onclick: () => { dlg.close(); app.openModels?.(); } }) : null;
    // Free up space: the models used least, to tick and remove (src/cleanup.ts). A linked PC's are only listed here: they go on that PC.
    const free = el('button', { class: 'btn', type: 'button', text: 'Free up space', title: v.here ? 'Lists the models used least, to remove the ones you do not need' : `Lists the models used least on ${v.name}`, onclick: () => app.openCleanup?.({ pc: v.id, onChanged: modelsChanged }) });
    // This PC's list starts folded away (the roles and where things are kept come first); a linked PC's window shows it as before.
    const fold = v.here;
    const open = !fold || foldsOpen.models === true;
    const toggle = fold ? el('button', { class: 'btn quiet pc-models-toggle', type: 'button', text: open ? 'Hide models' : 'Show models', 'aria-expanded': String(open), 'aria-controls': 'pc-models-body' }) : null;
    // Where new models go is chosen in the part above (Models: Change folder or drive); this button takes you there.
    const change = v.here ? el('button', { class: 'btn', type: 'button', text: 'Change folder or drive', title: 'Where new models are kept on this PC', onclick: () => openStoreForm('models') }) : null;
    const listBody = el('div', { class: 'pc-models-body', id: 'pc-models-body', hidden: !open },
      many ? search : null,
      many ? el('div', { class: 'pc-tools' }, shelf, el('label', { class: 'pc-sort' }, 'Sort ', sort)) : cats.includes('hidden') ? el('div', { class: 'pc-tools' }, shelf) : null,
      v.here ? null : el('p', { class: 'hint', text: 'Hide is on that PC itself. Delete works here when its owner ticks Accept models from linked PCs.' }),
      listBox);
    toggle?.addEventListener('click', () => {
      listBody.hidden = !listBody.hidden;
      foldsOpen.models = !listBody.hidden;
      toggle.textContent = listBody.hidden ? 'Show models' : 'Hide models';
      toggle.setAttribute('aria-expanded', String(!listBody.hidden));
    });
    // The buttons share one row and the free-space words sit under them, on a row of their own: long words no longer push a button down.
    return el('section', { class: 'pc-part pc-card-part' },
      el('div', { class: 'pc-part-head' }, el('h3', { title: 'Memory needed is an estimate (a chat model with an 8K context).', text: `Models (${shown})` }), toggle, el('div', { class: 'pc-free-actions' }, free, change, add)),
      freeSpaceLine(v),
      listBody);
  }

  // ---- Who works on it, and its most-used models (last 7 days) ----

  function peoplePart(v) {
    const rows = v.staff.map(s => el('li', { class: 'pc-person' },
      app.avatar ? app.avatar(`staff:${s.id}`, initials(s.name)) : el('span', { class: 'rail-avatar', 'aria-hidden': 'true', text: initials(s.name) }),
      el('strong', { text: s.name }),
      el('span', { class: 'hint', text: s.role }),
      el('span', { class: 'pc-num', text: s.ms ? span(s.ms / 1000) : '—' })));
    const hire = el('button', { class: 'btn', type: 'button', text: 'Hire staff here', onclick: () => {
      dlg.close();
      app.openHire?.({ pc: v.id });
    } });
    return el('section', { class: 'pc-part pc-card-part' },
      el('div', { class: 'pc-part-head' }, el('h3', { title: 'Time worked, last 7 days', text: `Staff on this PC (${v.staff.length})` }), hire),
      rows.length ? el('ul', { class: 'pc-people' }, ...rows) : el('p', { class: 'hint', text: 'Nobody works on this PC yet.' }));
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

  /** Its photo, or a computer. */
  function pcPicture(v) {
    if (v.profile.photo) return el('img', { class: 'pc-head-pic', src: v.profile.photo, alt: `Photo of ${v.name}` });
    const pic = svgIcon(PC_PICTURE, 56);
    const line = pic.querySelector('path');
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', 'currentColor');
    line.setAttribute('stroke-width', '1.4');
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('stroke-linejoin', 'round');
    pic.classList.add('pc-head-pic');
    return pic;
  }

  /** Its name in the title: this PC's, or a linked PC's as the left panel names it (with the words telling twins apart). */
  const pcTitle = v => (v.here ? v.name : app.pcLabel?.(v.id) ?? v.name);

  /** What it is, in one line: processor, memory, graphics card. */
  const specLine = v => {
    const m = v.memory;
    // The card TOMLIN uses there (the strongest: src/hardware.ts strongestFirst); "and N more" when it has others.
    const more = Math.max(0, (m?.cards?.list?.length ?? 0) - 1);
    const card = m?.gpu && !m.gpu.shared && m.gpu.total ? `${(m.gpu.name ?? 'graphics card').replace(/^(NVIDIA|AMD)\s+(?!card\b)/i, '')} with ${GBs(m.gpu.total)}${more ? ` and ${more} more card${more === 1 ? '' : 's'}` : ''}` : m?.ram?.total ? 'no graphics card' : '';
    const cpu = v.cpu?.name?.replace(/\(R\)|\(TM\)|\bCPU\b|@.*$/g, '').replace(/^Intel\s+Core\s+/i, '').replace(/\s+/g, ' ').trim();
    return [cpu, m?.ram?.total ? `${GBs(m.ram.total)} of RAM` : '', card].filter(Boolean).join(', ');
  };

  /** A nearly full disk says so at the top, without being looked for. */
  const LOW_DISK = 10 * 2 ** 30;

  /** Its processor, memory and drive, as known: this PC reads them; a linked PC says its memory when it answers. */
  function specsPart(v) {
    const m = v.memory;
    const rows = [];
    if (v.cpu) rows.push(['Processor', `${v.cpu.name} (${v.cpu.cores} cores, ${v.cpu.threads} threads)`]);
    rows.push(['RAM', m?.ram?.total ? GBs(m.ram.total) : 'Not known yet']);
    rows.push(['Graphics memory', m?.gpu && !m.gpu.shared && m.gpu.total ? `${GBs(m.gpu.total)}${m.gpu.name ? ` (${m.gpu.name})` : ''}${m.gpu.guessed ? ', worked out from its cards together: it runs an older TOMLIN' : ''}` : m?.ram?.total ? 'None of its own' : 'Not known yet']);
    // Two or more cards: each one, the one TOMLIN uses first at the top (src/pccards.ts).
    const cards = m?.cards?.list ?? [];
    if (cards.length > 1) rows.push(['Graphics cards', cards.map((c, i) => `${c.name}, ${GBs(c.total)}${i ? '' : ' (used first)'}`).join('; ')]);
    if (v.disk) rows.push(['Disk free', `${GBs(v.disk.free)} of ${GBs(v.disk.total)} (the drive TOMLIN keeps its data on)`]);
    return el('section', { class: 'pc-specs' }, el('h3', { text: 'Specifications' }),
      el('dl', {}, ...rows.flatMap(([k, x]) => [el('dt', { text: k }), el('dd', { text: x })])));
  }

  // ---- A linked PC's log (folded): a day of the 7 it keeps, newest line last, with a word to look for ----
  /** The Log part as you left it: the day ('' for today), the word, and the last answer (a redraw shows it again). */
  const logAsk = { pc: '', day: '', find: '', shown: null };
  const dayName = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  function logPart(v) {
    if (logAsk.pc !== v.id) Object.assign(logAsk, { pc: v.id, day: '', find: '', shown: null });
    const days = Array.from({ length: 7 }, (_, i) => new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() - i));
    const pick = el('select', { 'data-key': 'pc-log-day', 'aria-label': 'Which day' }, ...days.map((d, i) => el('option', { value: i ? dayName(d) : '', text: i === 0 ? 'Today' : i === 1 ? 'Yesterday' : d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) })));
    pick.value = logAsk.day;
    const find = el('input', { type: 'search', 'data-key': 'pc-log-find', maxlength: '100', placeholder: 'A word to look for', 'aria-label': 'Only lines with this word', value: logAsk.find });
    const show = el('button', { class: 'btn', type: 'button', text: 'Show' });
    const said = el('p', { class: 'hint', role: 'status' });
    // Text only: the lines are that PC's own words, never read as page code.
    const out = el('pre', { class: 'pc-log-lines', tabindex: '0', 'aria-label': `The log of ${v.name}` });
    const put = s => {
      said.textContent = s.said;
      out.textContent = s.text;
      out.hidden = !s.text;
      // Newest last: the end is what is shown first.
      out.scrollTop = out.scrollHeight;
    };
    let mine = 0;
    const read = async () => {
      Object.assign(logAsk, { day: pick.value, find: find.value.trim() });
      const n = ++mine;
      put({ said: 'Reading…', text: '' });
      let s;
      try {
        const q = new URLSearchParams({ pc: v.id, lines: '500', ...(logAsk.day ? { day: logAsk.day } : {}), ...(logAsk.find ? { find: logAsk.find } : {}) });
        const got = await api(`/api/node/log?${q}`);
        const when = pick.selectedOptions[0]?.textContent ?? 'Today';
        const lines = got.lines ?? [];
        const which = logAsk.find ? ` with "${logAsk.find}"` : '';
        s = got.state === 'old' ? { said: 'That PC runs an older TOMLIN that cannot send its log. Update it to read its log here.', text: '' }
          : got.state !== 'on' ? { said: got.error ? `It did not send its log: ${got.error}` : 'It did not answer.', text: '' }
          : { said: `${got.todayOnly ? 'That PC runs an older TOMLIN that sends only today\'s log, every line: update it for other days and the search. ' : ''}${lines.length ? `${got.todayOnly ? 'Today' : when}: ${lines.length === 500 ? 'the last 500 lines' : `${lines.length} line${lines.length === 1 ? '' : 's'}`}${which}, newest last.` : `${when}: no lines${which}.`}`, text: lines.join('\n') };
      } catch (e) {
        s = { said: e.message, text: '' };
      }
      if (n !== mine) return;
      logAsk.shown = s;
      put(s);
    };
    pick.addEventListener('change', read);
    show.addEventListener('click', read);
    find.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      read();
    });
    const part = el('div', { class: 'pc-log' }, el('div', { class: 'pc-log-ask' }, pick, find, show), said, out);
    if (logAsk.shown) put(logAsk.shown);
    else out.hidden = true;
    return { part, read };
  }

  function draw(v) {
    // Settings > This PC: only the models list, the same one as in this PC's window (drawn into the page, not the window).
    // On the page, what this PC is and where things are kept have a card of their own above the models (`pageTop`).
    if (!dlg.open && page) {
      if (pageTop && v.here) pageTop.replaceChildren(thisPcPart());
      return page.replaceChildren(...(v.here && !pageTop ? [thisPcPart()] : []), modelsPart(v));
    }
    // Two linked PCs with one name are told apart here as in the left panel (app.pcLabel, public/home.js).
    const title = pcTitle(v);
    $('#pc-title').textContent = title;
    // ---- Behind this PC: Update it sends this PC's TOMLIN there (it starts the new version by itself), or why not ----
    // Behind: a lower version, or the same version with different files (its build id differs from this PC's).
    const older = !v.here && v.update;
    const built = b => (b ? `, build ${b}` : '');
    const version = v.here ? `TOMLIN ${v.version}${built(v.build)}`
      // Why it did not answer is the line under the head: here only what that means for its version.
      : v.fault ? 'Its version is not known until it answers.'
      : v.checking && !v.version ? `Asking ${title} now…`
      : older ? `${pcVersionWords(v, true).line}${v.update.why ? `. ${v.update.why.charAt(0).toUpperCase()}${v.update.why.slice(1)}` : ''}`
      : v.pull ? `${pcVersionWords(v, false).line}${v.pull.why ? `. ${v.pull.why.charAt(0).toUpperCase()}${v.pull.why.slice(1)}` : ''}`
      : v.version === v.ours ? `TOMLIN ${v.version}${built(v.build)}: Up to date${v.installed ? `: Last updated ${new Date(v.installed).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}`
      : `TOMLIN ${v.version ?? '(it did not say)'}: this PC runs ${v.ours}`;
    // ---- Ahead of this PC (a newer version, or the same one with different files): Update this PC from it, or why not ----
    const ahead = !v.here && !older && !v.fault && v.pull;
    let go = null;
    if (ahead && !v.pull.why) {
      go = el('button', { class: 'btn primary', type: 'button', text: pcVersionWords(v, false).button });
      go.addEventListener('click', async () => {
        go.disabled = true;
        try {
          const r = typeof pullWithAsk === 'function' ? await pullWithAsk({ id: v.id, name: v.name, version: v.version, build: v.build }) : await api('/api/network/pull', { pc: v.id });
          if (!r) {
            go.disabled = false;
            return;
          }
          dlg.close();
          app.openUpdate(r.transfer);
        } catch (e) {
          say(e.message, true);
          go.disabled = false;
        }
      });
    }
    if (older && !v.update.why) {
      go = el('button', { class: 'btn primary', type: 'button', text: pcVersionWords(v, true).button });
      go.addEventListener('click', async () => {
        go.disabled = true;
        try {
          // That PC's own PIN, asked when it asks one (audit X2; home.js updatePcWithPin).
          const r = typeof updatePcWithPin === 'function' ? await updatePcWithPin({ id: v.id, name: v.name }) : await api('/api/network/update', { pc: v.id });
          if (!r) {
            go.disabled = false;
            return;
          }
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
    // Its state in one word, the same as the left panel says (src/home.ts pcLook); as it said last until it answers.
    const look = v.look ?? { activity: on ? 'available' : 'offline', word: on ? 'On' : 'Off or not answering' };
    // This PC only: Repair install, Shortcut to desktop, Start on start up, under Manage PC.
    let manage = null;
    if (v.here) {
      // Update TOMLIN now sits inside Manage PC and updates (the Updates tile), not beside the version.
      thisPc = v;
      manage = el('button', { class: 'btn quiet', type: 'button', text: 'Manage PC and updates','aria-expanded': String(!installBox.hidden), 'aria-controls': 'pc-manage' });
      manage.addEventListener('click', () => {
        installBox.hidden = !installBox.hidden;
        manage.setAttribute('aria-expanded', String(!installBox.hidden));
      });
      installBox.id = 'pc-manage';
    }
    // The short version beside the name; said in full only when there is something to do about it.
    const fine = !v.fault && !older && !ahead && (v.here || v.version === v.ours);
    const head = el('div', { class: 'pc-head' },
      pcPicture(v),
      el('span', { class: 'pc-head-name' },
        el('span', { class: 'pc-head-title' }, el('strong', { text: title }), el('span', { class: `pc-head-chip${look.activity === 'offline' ? ' off' : look.activity === 'available' && look.word === 'Asleep' ? ' asleep' : ''}`, title: look.text ?? '', text: look.word }), el('span', { class: 'sr-only', text: on ? ' (connected)' : ' (not connected)' })),
        el('span', { class: 'hint', text: [v.profile.model, specLine(v)].filter(Boolean).join(' · ') })),
      el('span', { class: `pc-head-ver${v.fault ? ' fault-line' : ''}${!fine && !v.fault ? ' long-line' : ''}` },
        fine ? el('strong', { text: `TOMLIN ${v.version ?? ''}` }) : version,
        fine && !v.here ? el('span', { class: 'pc-head-ok', text: '✓ Up to date' }) : null),
      manage);

    // ---- The actions of a linked PC, under its head: Update (a tick when up to date) and Shut down ----
    const mark = d => (typeof clusterIcon === 'function' ? clusterIcon(d) : null);
    let actions = null;
    if (!v.here) {
      const upBtn = go ?? el('button', { class: 'btn', type: 'button', disabled: true, title: v.fault ? 'It is not answering, so it cannot be updated now.' : older ? (v.update.why ? `${v.update.why.charAt(0).toUpperCase()}${v.update.why.slice(1)}.` : '') : 'It runs the same TOMLIN as this PC: nothing to update.', text: older ? 'Update' : 'Up to date' });
      upBtn.prepend(mark('M12 19V5M6.5 10.5 12 5l5.5 5.5') ?? '');
      let offBtn = null;
      // The question before a shut down, asked in the window (the browser's own confirm box is silently refused in some
      // windows, so the press did nothing).
      const offAsk = el('div', { class: 'pc-off-ask', hidden: true });
      if (v.off?.can) {
        const why = !v.off.allowed ? 'Its owner has not switched on "Allow host to turn this PC off" (Network, sharing permissions).' : v.off.away ? 'Someone is using it now.' : 'Shuts that PC down. It asks for its PIN (its own, or the host PIN), and stays off until someone switches it on again.';
        offBtn = el('button', { class: 'btn', type: 'button', title: why, disabled: !v.off.allowed || !!v.off.away }, mark('M12 3v9M6.3 6.8a8 8 0 1 0 11.4 0') ?? '', 'Shut down');
        offBtn.addEventListener('click', async () => {
          if (!(await askHere(offAsk, `Turn off "${title}"? It shuts down about 15 seconds after it answers, and stays off until someone switches it on again. Anything it is doing for you stops.`, `Turn off ${title}`, 'Keep it on'))) return;
          offBtn.disabled = true;
          try {
            const r = typeof powerOffWithPin === 'function' ? await powerOffWithPin({ id: v.id, name: v.name }) : null;
            say(r ? r.said : 'Not turned off (no PIN given).', !r);
          } catch (e) {
            say(e.message, true);
          }
          offBtn.disabled = false;
        });
      }
      actions = el('div', { class: 'pc-actions', role: 'group', 'aria-label': `Actions for ${title}` }, upBtn, offBtn ?? '', offAsk);
    }

    // ---- The strip: TOMLIN, tokens, time worked, power cost ----
    const updateWords = older && !v.update.why ? 'Update it with the button above' : older ? 'Update it there (see above)' : 'Update it there';
    const t = v.meter?.total ?? null;
    const powerCost = v.meter?.costs.power ?? v.mine.costs.power;
    const stat = (label, value, sub) => el('div', { class: 'pc-stat' }, el('span', { class: 'pc-stat-label', text: label }), el('strong', { class: 'pc-stat-value', text: value }), sub ? el('span', { class: 'hint', text: sub }) : null);
    const strip = el('div', { class: 'pc-strip' },
      stat('TOMLIN', v.version ?? '—', v.here ? 'This PC' : v.fault ? 'Not answering' : older ? (v.update.other ? 'Different files' : 'Outdated') : ahead ? (v.pull.other ? 'Different files' : 'Newer') : v.version === v.ours ? 'Up to date' : ''),
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

    const opened = (key, details) => {
      details.open = !!foldsOpen[key];
      details.addEventListener('toggle', () => { foldsOpen[key] = details.open; });
      return details;
    };
    const detailsFold = opened('details', el('details', { class: 'pc-fold' }, el('summary', {}, el('span', { text: 'Details' }), el('span', { class: 'hint', text: 'processor, disk, tokens, power cost' })), specsPart(v), strip, tokenLine, ...up, topPart(v)));
    const nameFold = opened('name', el('details', { class: 'pc-fold' }, el('summary', {}, el('span', { text: 'Name and photo' }), el('span', { class: 'hint', text: 'what this PC is called in the left panel' })), profileBlock(v)));
    // A linked PC's log, read from here when the fold is opened (this PC's own is under Help, Open the log).
    let logFold = null;
    if (!v.here) {
      const lp = logPart(v);
      logFold = opened('log', el('details', { class: 'pc-fold' }, el('summary', {}, el('span', { text: 'Log' }), el('span', { class: 'hint', text: 'what happened on that PC, the last 7 days' })), lp.part));
      logFold.addEventListener('toggle', () => { if (logFold.open && !logAsk.shown) lp.read(); });
      if (logFold.open && !logAsk.shown) lp.read();
    }
    const lowDisk = v.disk && v.disk.free < LOW_DISK ? el('p', { class: 'fault-line pc-warn', role: 'alert', text: `The disk is nearly full: ${GBs(v.disk.free)} free. A model or a backup may not fit.` }) : null;
    const away = !v.here && v.fault ? el('p', { class: 'fault-line pc-warn', role: 'status', text: v.fault })
      : v.checking ? el('p', { class: 'hint pc-warn', role: 'status', text: `Shown as ${title} said last. Asking it now…` }) : null;
    body.replaceChildren(head, actions ?? '', away ?? '', lowDisk ?? '', v.here ? installBox : '', v.here ? thisPcPart() : '', modelsPart(v), peoplePart(v), detailsFold, nameFold, fold, logFold ?? ''
    );
  }
  const foldsOpen = {};
  let foldOpen = false;
  installBox.hidden = true;

  /** Opens a PC's window: 'here' for this PC, else a linked PC's id. */
  app.openPc = id => {
    say('');
    // The log is read again each time the window opens (an open Log fold reads it at once).
    logAsk.shown = null;
    // Its name at once (a linked PC's window said "My PC" until it answered).
    $('#pc-title').textContent = app.pcLabel?.(id || 'here') ?? (id && id !== 'here' ? 'A linked PC' : 'My PC');
    body.replaceChildren(el('p', { class: 'hint', text: 'Reading…' }));
    if (!dlg.open) dlg.showModal();
    // "Its settings" only in this PC's own window for now (dropped from a linked PC's).
    $('#pc-more').hidden = !!id && id !== 'here';
    load(id || 'here', true);
  };
  /**
   * Escape with a model's "…" menu open closes the menu only (focus back on its button); the next Escape closes the
   * window. The keydown is stopped before the dialog takes it as its own close request.
   */
  const openMenu = () => dlg.querySelector('details.pc-model-more[open]');
  const closeMenu = menu => {
    menu.open = false;
    menu.querySelector('summary')?.focus();
  };
  dlg.addEventListener('keydown', e => {
    const menu = e.key === 'Escape' ? openMenu() : null;
    if (!menu) return;
    e.preventDefault();
    e.stopPropagation();
    closeMenu(menu);
  });
  dlg.addEventListener('cancel', e => {
    const menu = openMenu();
    if (!menu) return;
    e.preventDefault();
    closeMenu(menu);
  });
  /** Settings > This PC: draws this PC's models list (search, All | Chat | Pictures, sort, Test speed, Hide, Delete) into `host`. */
  app.pcModelsInto = (host, ask, top) => {
    page = host;
    pageAsk = ask;
    pageTop = top ?? null;
    host.replaceChildren(el('p', { class: 'hint', text: 'Reading…' }));
    return load('here');
  };
  $('#pc-more').addEventListener('click', () => {
    dlg.close();
    app.pcMore?.(showing);
  });
}
