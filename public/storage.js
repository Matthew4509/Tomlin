// Storage (left panel, Storage): two tiles side by side, Main model storage and Backup storage (the pools of
// src/drivejobs.ts: the Model store and Backups jobs). Each tile says how its drives work together, Duplicate (each
// file twice, on two different PCs: the pool's "mirror") or Extended (each file once, the room adds up: "spread"),
// lists its drives with Remove, and has + Add: a picker of every PC and its drives, where Select gives that drive the
// tile's job (/api/network/drive-jobs; a linked PC's only with its owner's tick). Under the tiles, which drive each PC
// runs its models from (/api/models/where here, /api/network/models-where on a linked PC), and the move of models left
// in a folder used before. Server: src/server/modelhome.ts, src/jobrun/storage.ts.
'use strict';
(() => {
  const st = { where: null, net: null, timer: 0, wasMoving: false, adding: '', noteOpen: new Set() };
  /** The two tiles: the pool each one is, its name, and what it is for. */
  const TILES = [
    { job: 'store', name: 'Main model storage', note: 'You can queue models to download directly, and it will download by itself even if all other PCs are off.', about: 'A copy of each model for all your PCs, so none has to download one again. Models run from each PC\'s own drive, set below.' },
    { job: 'backups', name: 'Backup storage', about: 'Where your PCs keep their backups and restore points.' },
  ];
  const MODES = [
    { mode: 'mirror', name: 'Duplicate', about: 'Each file is kept twice, on two different PCs: one can fail and nothing is lost. Half the room.' },
    { mode: 'spread', name: 'Extended', about: 'Each file is kept once and every drive\'s room adds up. A drive that fails loses what is on it.' },
  ];
  const size = n => (n >= 2 ** 40 ? `${(n / 2 ** 40).toFixed(1)} TB` : `${Math.round(n / GB)} GB`);
  const isFat = fs => /^fat(32|16|12)?$/i.test(fs || '');
  const say = t => { $('#storage-said').textContent = t || ''; };
  const ICON = 'M3 5h18v6H3zM3 13h18v6H3z';
  const tileIcon = () => el('span', { class: 'set-tile' }, svgOf(ICON));
  function svgOf(d) {
    const ns = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(ns, 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '20', height: '20', 'aria-hidden': 'true', focusable: 'false', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linejoin': 'round' })) s.setAttribute(k, v);
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    s.append(p);
    return s;
  }
  function bar(free, total) {
    const used = total > 0 ? Math.min(1, Math.max(0, (total - free) / total)) : 0;
    const fill = el('span');
    fill.style.width = `${Math.round(used * 100)}%`;
    return el('div', { class: `storage-bar${used > 0.9 ? ' full' : ''}`, role: 'img', 'aria-label': `${Math.round(used * 100)}% used` }, fill);
  }
  const driveName = d => `${d.drive}${d.label ? ` (${d.label})` : ''}${d.removable ? ', USB drive' : ''}`;
  const pcs = () => st.net?.pcs ?? [];
  const pcOf = id => pcs().find(p => p.id === id) ?? null;
  const jobsOf = (pc, drive) => pcOf(pc)?.drives?.find(x => x.drive === drive)?.jobs ?? [];
  const tileOf = job => TILES.find(t => t.job === job);
  /** A drive of this PC as Windows said it (its file system: a FAT drive takes no file over 4 GB, so no models). */
  const hereDrive = drive => st.where?.drives?.find(d => d.drive === drive) ?? null;
  const pcState = p => (p.here ? '' : !p.ok ? (p.answered ? 'Answered, but did not let this PC in' : 'Not answering now') : p.slow ? 'On, slow to answer' : 'On');

  async function load(fresh) {
    const [w, n] = await Promise.all([
      api(fresh ? '/api/storage/drives' : '/api/models/where', fresh ? {} : undefined).catch(e => (say(e.message), null)),
      api('/api/network/storage').catch(() => null),
    ]);
    if (w) st.where = w;
    if (n) st.net = n;
    draw();
  }

  /** Runs one change, says what the server said, and draws again from what it says now. */
  async function ask(path, body) {
    try {
      const r = await api(path, body);
      say(r.said ?? '');
      await load(false);
      return true;
    } catch (e) {
      say(e.message);
      return false;
    }
  }

  function setJob(pc, drive, job, on) {
    const now = jobsOf(pc, drive);
    const jobs = on ? [...new Set([...now, job])] : now.filter(j => j !== job);
    return ask('/api/network/drive-jobs', { pc, drive, jobs });
  }

  // ---- The two tiles ----

  function tile(t) {
    const v = (st.net?.pools ?? []).find(p => p.job === t.job);
    const mode = v?.mode ?? (t.job === 'backups' ? 'mirror' : 'spread');
    const seg = el('span', { class: 'storage-seg', role: 'group', 'aria-label': `How the drives of ${t.name} work together` },
      ...MODES.map(m => el('button', { type: 'button', class: 'btn', 'aria-pressed': String(mode === m.mode), title: m.about, onclick: () => mode === m.mode || ask('/api/network/pool', { pool: t.job, mode: m.mode }) }, m.name)));
    const drives = v?.drives ?? [];
    const rows = drives.length ? drives.map(d => el('div', { class: `storage-drive${d.ok ? '' : ' off'}` },
      el('span', { class: 'storage-drive-name' }, el('b', { text: d.pcName }), ` · ${driveName(d)}`),
      el('button', { class: 'btn quiet', type: 'button', title: `Stop using ${d.drive} on ${d.pcName} for ${t.name}. What is on it stays there.`, onclick: () => setJob(d.pc, d.drive, t.job, false) }, 'Remove'),
      el('span', { class: 'set-about', text: d.ok ? `${size(d.free)} free of ${size(d.total)}` : `${d.pcName} is not answering now: left out of the room` }),
      d.ok ? bar(d.free, d.total) : null))
      : [el('p', { class: 'set-about', text: 'No drive yet.' })];
    const room = drives.length ? el('p', { class: 'set-about', text: `${drives.length} drive${drives.length === 1 ? '' : 's'} · room ${size(v.size)} · ${size(v.free)} free` }) : null;
    const open = st.adding === t.job;
    return el('section', { class: 'set-card storage-tile', 'aria-labelledby': `storage-tile-${t.job}` },
      el('h3', { id: `storage-tile-${t.job}` }, t.name, t.note ? el('button', { class: 'storage-i', type: 'button', text: '!', title: t.note, 'aria-label': `About ${t.name}`, 'aria-expanded': String(st.noteOpen.has(t.job)), onclick: () => { if (!st.noteOpen.delete(t.job)) st.noteOpen.add(t.job); draw(); } }) : null),
      t.note && st.noteOpen.has(t.job) ? el('p', { class: 'set-about storage-note', text: t.note }) : null,
      el('p', { class: 'set-about', text: t.about }),
      seg,
      el('p', { class: 'set-about', text: MODES.find(m => m.mode === mode).about }),
      ...rows, room,
      ...(v?.warnings ?? []).map(w => el('p', { class: 'set-about storage-warn', text: w })),
      el('button', { class: 'btn storage-add', type: 'button', 'aria-expanded': String(open), 'aria-controls': 'storage-picker', onclick: () => openPicker(open ? '' : t.job) }, '+ Add'));
  }

  // ---- + Add: every PC and its drives; Select gives a drive the tile's job ----

  function openPicker(job) {
    st.adding = job;
    draw();
    if (job) $('#storage-picker').scrollIntoView({ block: 'nearest' });
  }

  function pickRow(p, d, t) {
    const used = d.jobs.includes(t.job);
    const other = TILES.find(o => o.job !== t.job && d.jobs.includes(o.job));
    const fat = p.here && isFat(hereDrive(d.drive)?.fs) && t.job === 'store';
    const no = p.why || (!p.may[t.job] ? (t.job === 'store' ? 'Its owner has not ticked "Accept models from linked PCs"' : 'Its owner has not ticked "Enable backups"') : fat ? `${hereDrive(d.drive).fs}: no file over 4 GB, so not for models` : '');
    return el('div', { class: 'set-row' }, tileIcon(),
      el('span', { class: 'set-txt' }, el('b', { text: driveName(d) }),
        el('span', { class: 'set-about', text: [`${size(d.free)} free of ${size(d.total)}`, other ? `also ${other.name}` : '', no].filter(Boolean).join(' · ') }), bar(d.free, d.total)),
      el('span', { class: 'set-side' }, used ? el('span', { class: 'storage-now', text: 'Selected' })
        : el('button', { class: 'btn primary', type: 'button', disabled: !!no, title: no || `Use ${d.drive} on ${p.name} for ${t.name}`, onclick: async () => { if (await setJob(p.id, d.drive, t.job, true)) openPicker(''); } }, 'Select')));
  }

  function drawPicker() {
    const box = $('#storage-picker');
    const t = tileOf(st.adding);
    box.hidden = !t;
    if (!t) return;
    $('#storage-picker-title').textContent = `Add a drive to ${t.name}`;
    const list = pcs();
    if (!list.length) return $('#storage-picker-list').replaceChildren(el('p', { class: 'set-about', text: 'Reading the PCs and their drives…' }));
    // This PC first, then the linked PCs that answer; one that does not is one folded line.
    const order = [...list].sort((a, b) => Number(b.here) - Number(a.here) || Number(b.ok) - Number(a.ok));
    $('#storage-picker-list').replaceChildren(...order.map(p => {
      const head = el('span', { class: 'storage-pc-head' }, el('b', { text: p.name }), p.here ? null : el('span', { class: 'set-about', text: ` · ${pcState(p)}` }));
      if (!p.ok) return el('details', { class: 'storage-pc-off' }, el('summary', {}, head), el('p', { class: 'set-about', text: p.why || 'Its drives show here when it answers.' }));
      return el('div', { class: 'storage-pc-box' }, head,
        ...(p.drives.length ? p.drives.map(d => pickRow(p, d, t)) : [el('p', { class: 'set-about', text: p.why || 'Its drives are not known yet.' })]));
    }));
  }

  // ---- Where each PC runs its models from ----

  function runRow(p) {
    const here = p.here;
    const w = st.where;
    const drives = here ? w?.drives ?? [] : p.drives;
    const now = here ? w?.drive : p.modelsDrive;
    const why = here ? '' : !p.ok ? pcState(p) : p.modelsWhy;
    const pick = el('select', { 'aria-label': `The drive ${p.name} runs its models from`, disabled: !!why || !drives.length, title: why || 'New downloads and copies go to <drive>\\TOMLIN models. The models already on the other drive stay there and are still used.' },
      ...(now ? [] : [el('option', { value: '', text: 'Not known' })]),
      ...drives.map(d => el('option', { value: d.drive, text: `${driveName(d)}, ${size(d.free)} free`, disabled: here && isFat(d.fs) })));
    pick.value = now ?? '';
    pick.addEventListener('change', () => (here ? ask('/api/models/where', { dir: `${pick.value}\\TOMLIN models` }) : ask('/api/network/models-where', { pc: p.id, drive: pick.value })));
    const about = here && w ? [`Models folder ${w.dir}`, w.missing ? `${w.missing} is not there now` : '', w.advice || ''].filter(Boolean).join(' · ') : why || (now ? `New models go to its ${now}` : '');
    return el('div', { class: 'set-row' }, tileIcon(),
      el('span', { class: 'set-txt' }, el('b', { text: p.name }), el('span', { class: 'set-about', text: about })),
      el('span', { class: 'set-side' }, pick,
        here && w && !w.isUsual ? el('button', { class: 'btn quiet', type: 'button', title: `TOMLIN's usual models folder is ${w.usual}.`, onclick: () => ask('/api/models/where', { dir: null }) }, 'Use the usual folder') : null));
  }

  function drawRun() {
    const box = $('#storage-run');
    const list = pcs().length ? [...pcs()].sort((a, b) => Number(b.here) - Number(a.here)) : st.where ? [{ id: 'here', name: 'This PC', here: true, ok: true, drives: [] }] : [];
    box.replaceChildren(...(list.length ? list.map(runRow) : [el('div', { class: 'set-row' }, el('span', { class: 'set-txt' }, el('span', { class: 'set-about', text: 'Reading the drives…' })))]));
  }

  function drawMove() {
    const w = st.where;
    const box = $('#storage-move');
    const moving = w?.move?.state === 'moving';
    box.hidden = !w || (!moving && !w.toMove.files && !w.move?.said);
    if (box.hidden) return;
    // Only an old folder on another drive is freed by the move; within one drive it is only tidier.
    const otherDrive = !!w?.toMove?.from?.some(f => f.slice(0, 2).toUpperCase() !== String(w.drive).slice(0, 2).toUpperCase());
    const what = moving ? `Moving ${w.move.now || 'the models'}: ${size(w.move.got)} of ${size(w.move.bytes)}.`
      : w.toMove.files ? `${w.toMove.files} model file${w.toMove.files === 1 ? ' is' : 's are'} still in ${w.toMove.from.join(' and ')} (${size(w.toMove.bytes)}), and used from there. Moving them is not needed${otherDrive ? '; it frees that drive' : ''}.` : w.move.said;
    box.replaceChildren(el('div', { class: 'set-row' }, el('span', { class: 'set-txt' }, el('b', { text: 'Models in a folder used before' }), el('span', { class: 'set-about', text: what })),
      el('span', { class: 'set-side' }, moving ? el('button', { class: 'btn', type: 'button', onclick: () => ask('/api/models/move/stop', {}) }, 'Stop')
        : w.toMove.files ? el('button', { class: 'btn', type: 'button', title: 'Copied, checked, then removed from the old folder. A model that is loaded is left where it is.', onclick: () => { st.wasMoving = true; ask('/api/models/move', {}); } }, otherDrive ? `Move them to ${w.drive}` : 'Move them to the new folder') : '')));
    clearTimeout(st.timer);
    if (moving) st.timer = setTimeout(() => load(false), 1000);
    st.wasMoving = moving;
  }

  function draw() {
    $('#storage-tiles').replaceChildren(...TILES.map(tile));
    drawPicker();
    drawRun();
    drawMove();
  }

  $('#storage-picker-close').addEventListener('click', () => openPicker(''));
  $('#storage-rescan').addEventListener('click', async () => {
    say('Looking for drives…');
    await load(true);
    say(`${st.where?.drives?.length ?? 0} drive${st.where?.drives?.length === 1 ? '' : 's'} on this PC.`);
  });

  /** Opens Storage; `add` ('store' or 'backups', from the Network map's Add) opens that tile's picker at once. */
  app.openStorage = ({ add = '' } = {}) => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
    say('');
    st.adding = tileOf(add) ? add : '';
    setView('storage');
    $('#storage-page').scrollTop = 0;
    draw();
    if (st.adding) $('#storage-picker').scrollIntoView({ block: 'nearest' });
    load(false);
  };
})();
