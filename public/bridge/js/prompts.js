// The Prompts page.
'use strict';

// ---- prompts page: a tile per category; a tile opens the prompts in it (address #prompts/<category id>). Saved
// prompts are copied into any AI. New category, Add prompt and Edit open a window; Remove and Delete ask first. ----
let prompts = null, promptCats = [], promptCat = '';
// No argument (the nav count at start) keeps the category already open.
async function loadPrompts(cat) {
  if (cat !== undefined && cat !== promptCat) { promptCat = cat; $('prompt-search').value = ''; }
  try { const r = await api('/api/prompts'); prompts = r.prompts; promptCats = r.categories; renderPrompts(); } catch (e) { info(e.message, true); }
}
const catOf = id => promptCats.find(c => c.id === id);
const inCat = id => prompts.filter(p => p.category === id);
const openCat = id => { location.hash = id ? '#prompts/' + encodeURIComponent(id) : '#prompts'; };

function renderPrompts() {
  if (!prompts) return;
  $('n-prompts').textContent = prompts.length || '';
  if (promptCat && !catOf(promptCat)) { promptCat = ''; if (location.hash.startsWith('#prompts/')) history.replaceState(null, '', '#prompts'); }
  const cat = catOf(promptCat);
  const raw = $('prompt-search').value.trim(), q = raw.toLowerCase();
  $('prompts-h1').textContent = cat ? cat.name : 'Prompts';
  $('prompts-crumb').hidden = !cat;
  $('prompts-crumb-here').textContent = cat ? cat.name : '';
  $('cmd-rename-cat').hidden = $('cmd-delete-cat').hidden = !cat;
  $('cmd-add-cat').hidden = !!cat;
  $('prompt-search').placeholder = cat ? 'Search ' + cat.name : 'Search all prompts';

  // All categories, no search: the tiles.
  const tiles = !cat && !q;
  $('prompt-tiles').hidden = !tiles;
  $('prompt-list').hidden = tiles;
  if (tiles) {
    $('prompt-tiles').replaceChildren(...promptCats.map(c => h('button', { class: 'ptile', type: 'button', onclick: () => openCat(c.id) },
      icon(0xE8B7), h('b', null, c.name), h('span', null, plural(inCat(c.id).length, 'prompt', 'prompts')))),
      h('button', { class: 'ptile add', type: 'button', onclick: () => categoryDialog() }, icon(0xE710), 'New category'));
    return;
  }

  // One category, or a search (inside the open category, or across all of them).
  const pool = cat ? inCat(cat.id) : prompts;
  const shown = q ? pool.filter(p => (p.title + '\n' + p.text).toLowerCase().includes(q)) : pool;
  const note = (b, s, btn) => [h('div', { class: 'set-row' }, h('div', { class: 'txt' }, h('b', null, b), h('span', null, s)), btn)];
  $('prompt-list').replaceChildren(...(shown.length ? shown.map(p => h('div', { class: 'set-row prompt-row' }, icon(0xE8BD),
    h('div', { class: 'txt' }, h('b', null, p.title), cat ? null : h('a', { class: 'cat', href: '#prompts/' + encodeURIComponent(p.category) }, (catOf(p.category) || {}).name), h('span', null, p.text)),
    h('div', { class: 'acts-row' },
      h('button', { class: 'btn accent', type: 'button', title: 'Copy the whole prompt to the clipboard', onclick: () => copyText(p.text, 'Prompt "' + p.title + '" copied. Paste it into the AI you use.') }, icon(0xE8C8), 'Copy'),
      inTomlin() ? startBtn(p.text, 'the Bridge prompt "' + p.title + '"', true) : null,
      h('button', { class: 'btn', type: 'button', onclick: () => promptDialog(p) }, 'Edit'),
      h('button', { class: 'btn', type: 'button', onclick: () => removePromptDialog(p) }, 'Remove'))))
    : q ? note('No prompt matches "' + raw + '"' + (cat ? ' in ' + cat.name : ''), 'Search looks in the names and the text. Clear the box to see them all.')
    : note('No prompts in ' + cat.name + ' yet', 'Save a prompt you use often, then copy it with one click.', h('button', { class: 'btn accent', type: 'button', onclick: () => promptDialog() }, 'Add prompt'))));
}
// Copies exactly the saved text. If the clipboard is blocked, the text is shown selected so Ctrl+C still works.
async function copyText(text, done) {
  try { await navigator.clipboard.writeText(text); info(done); }
  catch {
    const ta = h('textarea', { class: 'prompt-text', readonly: true }, text);
    dialog('Copy this prompt', [h('p', { class: 'muted' }, 'The clipboard was blocked, so copy it from here (Ctrl+C):'), ta], [h('button', { class: 'btn accent', type: 'button', onclick: closeDialog }, 'Done')]);
    ta.focus(); ta.select();
  }
}
function promptDialog(p) {
  if (!promptCats.length) { categoryDialog(); return info('Make a category first, then add the prompt to it.'); }
  const title = h('input', { type: 'text', id: 'pr-title', maxlength: '120', value: p ? p.title : '', placeholder: 'For example: Phase this project', spellcheck: 'false' });
  const start = p ? p.category : catOf(promptCat) ? promptCat : promptCats[0].id;
  const cat = h('select', { class: 'sel', id: 'pr-cat' }, promptCats.map(c => h('option', { value: c.id, selected: c.id === start }, c.name)));
  const text = h('textarea', { class: 'prompt-text', id: 'pr-text', placeholder: 'Type or paste the prompt. Put the parts to fill in each time in [brackets].' }, p ? p.text : '');
  const count = h('div', { class: 'fld-count', 'aria-live': 'polite' });
  const err = h('p', { class: 'fld-err', role: 'alert', hidden: true });
  const tally = () => { const n = text.value.length; count.textContent = n.toLocaleString() + ' of 20,000 characters'; count.classList.toggle('over', n > 20000); };
  text.addEventListener('input', tally); tally();
  const save = h('button', { class: 'btn accent', type: 'button' }, p ? 'Save' : 'Add prompt');
  save.addEventListener('click', async () => {
    save.disabled = true; err.hidden = true;
    try {
      const r = await api('/api/prompts/save', { id: p ? p.id : undefined, category: cat.value, title: title.value, text: text.value });
      if (!r.ok) { err.textContent = r.error; err.hidden = false; return; }
      closeDialog();
      const where = (catOf(r.prompt.category) || {}).name;
      info((p ? 'Prompt "' + r.prompt.title + '" saved' : 'Prompt "' + r.prompt.title + '" added') + (where ? ' in ' + where + '.' : '.'));
      await loadPrompts();
    } catch (e) { err.textContent = e.message; err.hidden = false; }
    finally { save.disabled = false; }
  });
  dialog(p ? 'Edit prompt' : 'Add prompt', [
    h('label', { class: 'fld-label', for: 'pr-title' }, 'Name'), h('div', { class: 'field' }, title),
    h('label', { class: 'fld-label', for: 'pr-cat' }, 'Category'), h('div', { class: 'field' }, cat),
    h('label', { class: 'fld-label', for: 'pr-text' }, 'Prompt'), text, count, err], [save, cancelBtn()], 'wide');
}
function removePromptDialog(p) {
  const remove = async () => {
    try { const r = await api('/api/prompts/remove', { id: p.id }); closeDialog(); if (!r.ok) info(r.error, true); else info('Prompt "' + p.title + '" removed.'); }
    catch (e) { info(e.message, true); }
    await loadPrompts();
  };
  dialog('Remove "' + p.title + '"?', [h('p', null, 'The prompt is deleted from the Bridge and cannot be brought back. Copy it first if you might want it again.')],
    [h('button', { class: 'btn accent', type: 'button', onclick: remove }, 'Remove'),
     h('button', { class: 'btn', type: 'button', onclick: () => copyText(p.text, 'Prompt "' + p.title + '" copied.') }, 'Copy first'), cancelBtn()]);
}

// ---- categories: New (no category given) or Rename; a new one opens straight away, ready for its first prompt ----
function categoryDialog(c) {
  const name = h('input', { type: 'text', id: 'pc-name', maxlength: '60', value: c ? c.name : '', placeholder: 'For example: Photography', spellcheck: 'false' });
  const err = h('p', { class: 'fld-err', role: 'alert', hidden: true });
  const save = h('button', { class: 'btn accent', type: 'button' }, c ? 'Rename' : 'Add category');
  const go = async () => {
    save.disabled = true; err.hidden = true;
    try {
      const r = await api('/api/prompts/category/save', { id: c ? c.id : undefined, name: name.value });
      if (!r.ok) { err.textContent = r.error; err.hidden = false; return; }
      closeDialog();
      info(c ? 'Category renamed to "' + r.category.name + '".' : 'Category "' + r.category.name + '" added. Add its first prompt with Add prompt.');
      if (c) await loadPrompts(); else openCat(r.category.id);
    } catch (e) { err.textContent = e.message; err.hidden = false; }
    finally { save.disabled = false; }
  };
  save.addEventListener('click', go);
  name.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  dialog(c ? 'Rename "' + c.name + '"' : 'New category', [h('label', { class: 'fld-label', for: 'pc-name' }, 'Name'), h('div', { class: 'field' }, name), err], [save, cancelBtn()]);
  name.focus();
}
function removeCategoryDialog(c) {
  const n = inCat(c.id).length;
  const remove = async () => {
    try {
      const r = await api('/api/prompts/category/remove', { id: c.id }); closeDialog();
      if (!r.ok) info(r.error, true); else { info('Category "' + c.name + '" deleted' + (r.prompts ? ', with its ' + plural(r.prompts, 'prompt', 'prompts') + '.' : '.')); openCat(''); }
    } catch (e) { info(e.message, true); }
    await loadPrompts();
  };
  dialog('Delete "' + c.name + '"?', [h('p', null, n
    ? 'The category and the ' + plural(n, 'prompt', 'prompts') + ' in it are deleted from the Bridge and cannot be brought back. To keep a prompt, Edit it and move it to another category first.'
    : 'The category is empty. It is deleted from the Bridge.')],
    [h('button', { class: 'btn accent', type: 'button', onclick: remove }, n ? 'Delete category and ' + plural(n, 'prompt', 'prompts') : 'Delete category'), cancelBtn()]);
}
$('cmd-add-prompt').addEventListener('click', () => promptDialog());
$('cmd-add-cat').addEventListener('click', () => categoryDialog());
$('cmd-rename-cat').addEventListener('click', () => { const c = catOf(promptCat); if (c) categoryDialog(c); });
$('cmd-delete-cat').addEventListener('click', () => { const c = catOf(promptCat); if (c) removeCategoryDialog(c); });
$('prompt-search').addEventListener('input', renderPrompts);
