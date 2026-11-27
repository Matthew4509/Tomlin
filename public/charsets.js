// The artist's two kinds of work in the Images window: [Pictures] (drawing as before) and [Character sets]: the
// chat's project's characters and locations (src/cards.ts, src/server/cards.ts). A card is a name, words that describe
// it, words to leave out, and its pictures, the best ones ticked as references. Writing @Name in What to draw (or in a
// clip or a shot of a chat in the project) adds its words; the chips under What to draw put @Name in for you.
// Make a sheet queues the card's views with one seed (the queue draws them into the gallery and the project), and Add
// puts a gallery picture into the card's folder.
// Uses app.js's helpers ($, el, api, app) and chats.js's chatUi.
'use strict';
{
  // top: the chat's project is kept at the top of the workspace (no folder for cards); recent: the Add rows (addRows).
  const ui = { tab: 'blog', project: '', top: false, cards: [], open: null, fresh: false, recent: [] };
  const fileUrl = rel => `/api/files/picture?path=${encodeURIComponent(rel)}`;
  const galleryUrl = rel => `/api/images/file/${rel.split('/').map(encodeURIComponent).join('/')}`;
  const projectOf = () => chatUi.list?.find(c => c.id === app.chatId)?.project ?? '';
  const projectName = id => chatUi.projects?.find(p => p.id === id)?.name ?? 'this project';

  function say(text, bad = false) {
    const s = $('#cs-said');
    s.textContent = text ?? '';
    s.hidden = !text;
    s.classList.toggle('fault', !!bad);
  }

  function setTab(tab) {
    ui.tab = tab;
    for (const b of document.querySelectorAll('#img-kinds [role=tab]')) {
      const on = b.dataset.kind === tab;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    $('#img-form').hidden = tab !== 'blog';
    $('#cs-panel').hidden = tab !== 'sets';
    if (tab === 'sets') void load();
  }

  async function load() {
    ui.project = projectOf();
    ui.top = false;
    if (!ui.project) {
      ui.cards = [];
      draw();
      return;
    }
    try {
      const r = await api(`/api/cards?project=${encodeURIComponent(ui.project)}`);
      ui.cards = r.cards;
      say('');
    } catch (e) {
      ui.cards = [];
      // 409: the project is kept at the top of the workspace, with no folder for cards: the head offers a new project.
      ui.top = e.status === 409;
      say(ui.top ? '' : e.message, true);
    }
    if (ui.open && !ui.fresh) ui.open = ui.cards.find(c => c.kind === ui.open.kind && c.name === ui.open.name) ?? null;
    draw();
    drawChips();
  }

  /** The cards as chips under What to draw: a press puts @Name in the prompt. */
  function drawChips() {
    const box = $('#img-cards');
    if (!box) return;
    box.hidden = !ui.cards.length;
    box.replaceChildren(...(ui.cards.length ? [el('span', { class: 'img-seg-name', text: 'Characters and locations:' }), ...ui.cards.map(c => el('button', { class: 'btn quiet cs-chip', type: 'button', text: `@${c.name}`, title: `${c.kind === 'character' ? 'Character' : 'Location'}: ${c.words || c.name}\nPress to put @${c.name} in What to draw`, onclick: () => {
      const p = $('#img-prompt');
      p.value = `${p.value.trim()}${p.value.trim() ? ' ' : ''}@${c.name} `;
      p.focus();
    } }))] : []));
  }
  app.drawCardChips = () => void (ui.project === projectOf() ? drawChips() : load());

  function list() {
    const kinds = [['character', 'Characters'], ['location', 'Locations']];
    return kinds.map(([kind, title]) => {
      const mine = ui.cards.filter(c => c.kind === kind);
      return el('section', { class: 'cs-kind', 'aria-label': title },
        el('div', { class: 'cs-kind-head' }, el('h4', { text: title }),
          el('button', { class: 'btn quiet', type: 'button', text: kind === 'character' ? '+ Character' : '+ Location', onclick: () => edit({ kind, name: '', words: '', avoid: '', refs: [], pictures: [] }, true) })),
        mine.length ? el('div', { class: 'cs-cards' }, ...mine.map(c => el('button', { class: `cs-card${ui.open?.name === c.name && ui.open?.kind === c.kind ? ' on' : ''}`, type: 'button', title: c.words || c.name, onclick: () => edit(c) },
          c.refs[0] ? el('img', { src: fileUrl(`${c.folder}/${c.refs[0]}`), alt: '' }) : el('span', { class: 'cs-noimg', 'aria-hidden': 'true', text: c.name.slice(0, 1) }),
          el('span', { class: 'cs-card-name', text: c.name }),
          el('span', { class: 'cs-card-n', text: `${c.pictures.length} picture${c.pictures.length === 1 ? '' : 's'}` }))))
          : el('p', { class: 'hint', text: kind === 'character' ? 'No characters yet: a person, an animal or a mascot drawn the same in every picture and shot.' : 'No locations yet: a place drawn the same in every picture and shot.' }));
    });
  }

  function edit(c, fresh = false) {
    ui.open = c;
    ui.fresh = fresh;
    draw();
    void loadRecent();
  }

  /**
   * The Add rows: this chat's newest pictures, then the newest of the rest (older pictures kept with no chat, and other
   * chats'), so a picture from before this chat can always be added too. A row with nothing in it is left out.
   */
  function addRows(mine, all) {
    const ids = new Set(mine.map(p => p.id));
    const rest = all.filter(p => !ids.has(p.id));
    return [
      mine.length ? { title: 'Add from this chat\'s newest pictures:', pictures: mine } : null,
      rest.length ? { title: mine.length ? 'Or from older pictures and other chats:' : 'Add from the newest pictures of every chat:', pictures: rest } : null,
    ].filter(Boolean);
  }

  async function loadRecent() {
    const newest = chat => api(`/api/images/gallery?shelf=all&offset=0&limit=12${chat ? `&chat=${encodeURIComponent(chat)}` : ''}`).then(g => g.pictures ?? []);
    try {
      const [mine, all] = await Promise.all([app.chatId ? newest(app.chatId) : [], newest('')]);
      ui.recent = addRows(mine, all);
    } catch {
      ui.recent = [];
    }
    if (ui.open) drawEditor();
  }

  async function save() {
    const c = ui.open;
    const card = { kind: c.kind, name: $('#cs-name').value.trim(), words: $('#cs-words').value, avoid: $('#cs-avoid').value, refs: [...document.querySelectorAll('#cs-pics input:checked')].map(x => x.value) };
    try {
      const r = await api('/api/cards/save', { project: ui.project, card, ...(ui.fresh ? {} : { was: c.name }) });
      ui.cards = r.cards;
      ui.open = r.cards.find(x => x.kind === c.kind && x.name === r.saved) ?? null;
      ui.fresh = false;
      say(`${r.saved} is saved in ${projectName(ui.project)}. Write @${r.saved} in What to draw, a clip or a shot to use it.`);
    } catch (e) {
      say(e.message, true);
    }
    draw();
    drawChips();
  }

  async function addPicture(p) {
    try {
      const r = await api('/api/cards/picture', { project: ui.project, kind: ui.open.kind, name: ui.open.name, picture: p.id });
      ui.cards = r.cards;
      ui.open = r.cards.find(x => x.kind === ui.open.kind && x.name === ui.open.name) ?? null;
      say('Added. Tick the best views as references.');
    } catch (e) {
      say(e.message, true);
    }
    draw();
  }

  async function sheet() {
    const c = ui.open;
    const views = c.kind === 'character' ? ['full body, front view', 'full body, three-quarter view', 'full body, side view', 'full body, back view', 'head and shoulders close-up, front view'] : ['wide shot', 'middle shot', 'close detail shot'];
    const words = $('#cs-words').value.trim().replace(/[.\s]+$/, '');
    const base = `${c.name}${words ? `, ${words}` : ''}`;
    const seed = Math.floor(Math.random() * 2 ** 31);
    const as = $('#draw-as')?.value || undefined;
    const mode = $('#cs-style')?.value || 'auto';
    const quality = $('#cs-quality')?.value || 'mid';
    const items = views.map(v => ({ kind: 'picture', prompt: c.kind === 'character' ? `Character sheet of ${base}, ${v}, plain light grey background, even studio light, no other people` : `${base}, ${v}, no people`, negative: $('#cs-avoid').value.trim() || undefined, seed, mode, style: mode, quality, project: ui.project, card: { kind: c.kind, name: c.name }, ...(app.chatId ? { chat: app.chatId } : {}), ...(as ? { as } : {}) }));
    try {
      await api('/api/queue/add', { items });
      say(`${items.length} views of ${c.name} are in the queue, all with seed ${seed}. Each one goes into ${c.name}'s pictures here as it is drawn: tick the best as references. Home shows how far they are.`);
      watchSheet(c);
    } catch (e) {
      say(e.message, true);
    }
  }

  // While a sheet is drawn: its views drawn so far, and the card's pictures, every 10 s until none is left to draw.
  let watching = 0;
  function watchSheet(c) {
    clearInterval(watching);
    const since = new Date(Date.now() - 60000).toISOString();
    watching = setInterval(async () => {
      const q = await api('/api/queue').catch(() => null);
      const mine = (q?.items ?? []).filter(i => i.project === ui.project && i.card?.kind === c.kind && i.card?.name === c.name && i.added >= since);
      const left = mine.filter(i => i.state === 'waiting' || i.state === 'running');
      const run = left.find(i => i.state === 'running');
      if (ui.tab === 'sets' && ui.project) {
        // load() clears the line, so it goes first.
        await load();
        say(left.length ? `${c.name}: ${mine.length - left.length} of ${mine.length} views drawn${run ? `, one drawing on ${run.pc || 'its PC'}${run.steps ? ` (step ${run.step ?? 0} of ${run.steps})` : ''}` : ''}.` : `${c.name}'s views are drawn. Tick the best as references.`);
      }
      if (!left.length) clearInterval(watching);
    }, 10000);
  }

  async function remove() {
    const c = ui.open;
    if (!(await askHere($('#cs-ask'), `Stop keeping ${c.name} as a ${c.kind}? Its pictures stay in its folder, and @${c.name} no longer adds its words.`, 'Stop keeping it', 'Keep it'))) return;
    try {
      const r = await api('/api/cards/remove', { project: ui.project, kind: c.kind, name: c.name });
      ui.cards = r.cards;
      ui.open = null;
      say(r.said);
    } catch (e) {
      say(e.message, true);
    }
    draw();
    drawChips();
  }

  /** The Sheet style list: every style (stylepick.js), or the four it always had before the styles are read. */
  const sheetStyles = () => stylePick.now()?.styles?.map(s => [s.value, s.name]) ?? [['auto', 'Auto'], ['blog', 'Photo'], ['cartoon', 'Cartoon'], ['icon', 'Flat']];
  /** The style tile picked shown pressed, without drawing the editor again (words typed and not saved stay). */
  function pressStyle() {
    const v = $('#cs-style')?.value ?? 'auto';
    for (const b of document.querySelectorAll('#cs-style-tiles .style-tile')) b.setAttribute('aria-pressed', String(stylePick.now()?.styles?.find(s => s.id === b.dataset.style)?.value === v));
  }

  function drawEditor() {
    const box = $('#cs-editor');
    const c = ui.open;
    box.hidden = !c;
    if (!c) return box.replaceChildren();
    const kindWord = c.kind === 'character' ? 'character' : 'location';
    const picks = c.pictures.map(path => {
      const file = path.split('/').pop();
      return el('label', { class: 'cs-pic', title: `${file}\nTick to give it to a reference-picture model as ${c.name}` },
        el('img', { src: fileUrl(path), alt: file, loading: 'lazy' }),
        el('span', {}, el('input', { type: 'checkbox', value: file, checked: c.refs.includes(file) }), ' Reference'));
    });
    // Parts left out are null: replaceChildren would write them as the word "null".
    box.replaceChildren(...[
      el('h4', { text: ui.fresh ? `New ${kindWord}` : c.name }),
      el('label', { class: 'field' }, el('span', { text: 'Name (used as @Name)' }), el('input', { id: 'cs-name', type: 'text', maxlength: '40', value: c.name, placeholder: c.kind === 'character' ? 'e.g. Ember' : 'e.g. Pine forest' })),
      el('label', { class: 'field' }, el('span', { text: c.kind === 'character' ? 'What they look like, always the same words' : 'What it looks like, always the same words' }),
        el('textarea', { id: 'cs-words', rows: '3', maxlength: '600', placeholder: c.kind === 'character' ? 'e.g. a young red fox, bright orange coat, white chest, black legs, amber eyes, slim build' : 'e.g. tall pines in deep snow, soft morning light, light mist, no path' }, c.words)),
      el('label', { class: 'field' }, el('span', { text: 'Leave out' }), el('input', { id: 'cs-avoid', type: 'text', maxlength: '300', value: c.avoid, placeholder: 'e.g. extra legs, collar' })),
      ui.fresh ? null : el('div', { class: 'cs-pics-head' }, el('strong', { text: 'Pictures' }), el('span', { class: 'hint', text: `Tick up to 4 best views as references. Kept in ${c.folder}` })),
      ui.fresh ? null : (picks.length ? el('div', { class: 'cs-pics', id: 'cs-pics' }, ...picks) : el('p', { class: 'hint', id: 'cs-pics', text: 'No pictures yet: press Make a sheet, and its views come in here as they are drawn.' })),
      ui.fresh ? null : el('div', { class: 'cs-sheet-opts' },
        el('label', {}, el('span', { text: 'Sheet style ' }), el('select', { id: 'cs-style', title: 'How every view of the sheet is drawn: Photo for a film, Cartoon for an illustrated story', onchange: e => { ui.style = e.target.value; pressStyle(); } }, ...sheetStyles().map(([v, t]) => el('option', { value: v, text: t, ...(v === (ui.style ?? 'auto') ? { selected: true } : {}) })))),
        el('label', {}, el('span', { text: ' Quality ' }), el('select', { id: 'cs-quality', title: 'Draft is quick and small; High is the largest this artist draws well', onchange: e => { ui.quality = e.target.value; } }, ...[['draft', 'Draft'], ['mid', 'Mid'], ['high', 'High']].map(([v, t]) => el('option', { value: v, text: t, ...(v === (ui.quality ?? 'mid') ? { selected: true } : {}) }))))),
      // The styles with no sample yet, said once above the tiles (stylepick.js), not under each one.
      ui.fresh || !stylePick.now() || !stylePick.missing(artistModel().model, artistModel().modelName) ? null : el('p', { class: 'hint style-none', text: stylePick.missing(artistModel().model, artistModel().modelName) }),
      ui.fresh || !stylePick.now() ? null : el('div', { class: 'style-tiles cs-style-tiles', id: 'cs-style-tiles', role: 'group', 'aria-label': 'Sheet style' }, ...stylePick.tiles({ ...artistModel(), value: ui.style ?? 'auto', pick: s => {
        ui.style = s.value;
        $('#cs-style').value = s.value;
        pressStyle();
      } })),
      ...(ui.fresh ? [] : ui.recent.map(row => el('div', { class: 'cs-recent' }, el('span', { class: 'hint', text: row.title }),
        el('div', { class: 'cs-recent-row' }, ...row.pictures.map(p => el('button', { class: 'cs-recent-pic', type: 'button', title: `${p.prompt}\nPress to add it to ${c.name}`, onclick: () => addPicture(p) }, el('img', { src: galleryUrl(p.output), alt: p.altText ?? p.prompt, loading: 'lazy' }))))))),
      el('div', { class: 'cs-acts' },
        el('button', { class: 'btn primary', type: 'button', text: 'Save', onclick: save }),
        ui.fresh ? null : el('button', { class: 'btn', type: 'button', text: 'Make a sheet', title: c.kind === 'character' ? 'Queues 5 views (front, three-quarter, side, back, close-up) with one seed, on a plain background' : 'Queues 3 plates (wide, middle, close) with one seed', onclick: sheet }),
        ui.fresh ? null : el('button', { class: 'btn quiet', type: 'button', text: 'Stop keeping it', onclick: remove }),
        el('button', { class: 'btn quiet', type: 'button', text: 'Close', onclick: () => { ui.open = null; ui.fresh = false; draw(); } })),
      el('div', { id: 'cs-ask', hidden: true })].filter(Boolean));
  }

  /** The words above "Make a project for these characters": a chat in no project, or in one kept at the top of the workspace. */
  function noFolderWords(top, name) {
    return top
      ? `${name} is kept at the top of the workspace, so it has no folder of its own for characters and locations. Make a project for these characters: it gets its own folder, and this chat moves into it.`
      : 'Characters and locations are kept in a project, and this chat is in none. Make a project for these characters, or put this chat in one you have.';
  }

  /** A new project with its own folder, and this chat put in it (chats.js putInProject, as New project does). */
  async function makeProject() {
    const name = $('#cs-pname').value.trim();
    const chat = chatUi.open;
    if (!name) return say('Give the project a name first.', true);
    if (!chat) return say('Open the artist\'s chat first.', true);
    try {
      const made = await api('/api/projects/create', { name, fromChat: true });
      await app.loadChats?.();
      // putInProject (chats.js) draws the lists again and loads Character sets for the new project.
      await putInProject(chat, made.id);
      // Loaded here too, so the line below is said after the load (which clears the line) and stays.
      await load();
      if (projectOf() === made.id) say(`${name} is made, and this chat is in it. Press + Character to make the first one.`);
    } catch (e) {
      say(e.message, true);
    }
  }

  /** The Project choice in the panel on the right, opened (the panel unfolded and its Project tab shown). */
  function openProjectChoice() {
    const fold = $('#subjects-fold');
    if (fold && !fold.open) fold.open = true;
    $('#tab-project')?.click();
    // The tab's own list goes through the head's list (projecttab.js); it gets the keyboard when it is there.
    setTimeout(() => ($('#panel-project select') ?? $('#tab-project'))?.focus(), 0);
  }

  function draw() {
    const head = $('#cs-head');
    if (!ui.project || ui.top) {
      const can = !!chatUi.open && chatUi.open.here !== false;
      const name = ui.project ? projectName(ui.project) : 'This project';
      head.replaceChildren(...[
        el('p', { class: 'hint', text: noFolderWords(ui.top, name) }),
        can ? el('form', { class: 'cs-make', onsubmit: e => { e.preventDefault(); void makeProject(); } },
          el('label', { class: 'field' }, el('span', { text: 'Project name' }), el('input', { id: 'cs-pname', type: 'text', maxlength: '80', autocomplete: 'off', placeholder: 'e.g. Fox and the forest', value: $('#cs-pname')?.value ?? '' })),
          el('div', { class: 'cs-acts' },
            el('button', { class: 'btn primary', type: 'submit', text: 'Make a project for these characters' }),
            ui.top ? null : el('button', { class: 'btn quiet', type: 'button', text: 'Pick a project you have', title: 'Opens the Project tab in the panel on the right', onclick: openProjectChoice }))) : null,
      ].filter(Boolean));
      $('#cs-list').replaceChildren();
      $('#cs-editor').hidden = true;
      return;
    }
    head.replaceChildren(el('p', { class: 'hint', text: `In ${projectName(ui.project)}. Write @Name in What to draw, a clip or a shot, and its words are added each time.` }));
    $('#cs-list').replaceChildren(...list());
    drawEditor();
  }

  for (const b of document.querySelectorAll('#img-kinds [role=tab]')) b.addEventListener('click', () => setTab(b.dataset.kind));
  app.charSets = { load, setTab };
}
