// Dialog windows (Add opens a window; Cancel leaves everything as it was).
'use strict';

// ---- dialogs (Add opens a window; Cancel leaves everything as it was) ----
function dialog(title, bodyKids, buttons, size) {
  $('dlg').className = size || '';
  $('dlg-body').replaceChildren(h('h3', null, title), ...bodyKids.filter(k => k != null && k !== false));
  $('dlg-foot').replaceChildren(...buttons);
  const d = $('dlg');
  if (!d.open) d.showModal();
  const f = $('dlg-body').querySelector('input') || $('dlg-foot').querySelector('.accent'); if (f) f.focus();
}
function closeDialog() { if ($('dlg').open) $('dlg').close(); }
const cancelBtn = (label = 'Cancel') => h('button', { class: 'btn', type: 'button', onclick: closeDialog }, label);
$('dlg-form').addEventListener('submit', e => { e.preventDefault(); const a = $('dlg-foot').querySelector('.accent'); if (a && !a.disabled) a.click(); });

function folderDialog({ title, lead, purpose, okLabel, submit }) {
  const input = h('input', { type: 'text', placeholder: 'C:\\Users\\you\\projects', 'aria-label': 'Folder path', spellcheck: 'false' });
  const err = h('div', { class: 'err', role: 'alert' });
  const browse = h('button', { class: 'btn', type: 'button', onclick: async () => {
    browse.disabled = true; err.textContent = '';
    try {
      const r = await api('/api/pick-folder', { purpose });
      if (r.path) input.value = r.path;
      else if (r.error) err.textContent = r.error;
      else if (r.dryRun) err.textContent = 'Dry run: ' + r.dryRun + ' (type a path instead).';
    } catch (e) { err.textContent = e.message; }
    browse.disabled = false; input.focus();
  } }, icon(0xE838), 'Browse…');
  const ok = h('button', { class: 'btn accent', type: 'button', onclick: async () => {
    if (!input.value.trim()) { err.textContent = 'Choose a folder with Browse, or type its path.'; return input.focus(); }
    ok.disabled = true; err.textContent = '';
    try { const r = await submit(input.value.trim()); if (r && r.error) err.textContent = r.error; }
    catch (e) { err.textContent = e.message; }
    ok.disabled = false;
  } }, okLabel);
  dialog(title, [h('p', { class: 'muted' }, lead), h('div', { class: 'field' }, input, browse), err], [ok, cancelBtn()]);
}

function addFolderDialog() {
  folderDialog({ title: 'Add a working folder', purpose: 'working', okLabel: 'Add folder',
    lead: 'Every folder inside it will show as a project. For example the folder you keep your Claude Code work in, or your ChatGPT/Codex one.',
    submit: async p => {
      const r = await api('/api/folders/add', { path: p });
      if (!r.ok) return r;
      closeDialog(); info('Added ' + r.path + ': ' + r.projects + ' project' + (r.projects === 1 ? '' : 's') + ' found.');
      await load(); if (!$('page-folders').hidden) loadFolders();
    } });
}
function addProjectDialog() {
  folderDialog({ title: 'Add a project', purpose: 'project', okLabel: 'Add project',
    lead: 'For a project kept outside your working folders. The Bridge only reads the folder; it never changes its files.',
    submit: async p => {
      const r = await api('/api/projects/add', { path: p });
      if (!r.ok) return r;
      closeDialog(); info(r.name + ' added to the list.');
      await load(); if (!$('page-folders').hidden) loadFolders();
    } });
}
function removeProjectDialog(r) {
  dialog('Remove ' + r.name + ' from the list?', [
    h('p', null, 'The folder and its files stay where they are: ', h('b', null, r.dir), '.'),
    r.running ? h('p', null, 'Its local copy on port ' + r.running.port + ' will be stopped.') : null,
    h('p', { class: 'muted' }, r.added ? 'It was added one by one; add it again any time with Add project.' : 'Bring it back any time from Folders › Removed from the list.')],
    [h('button', { class: 'btn accent', type: 'button', onclick: async () => {
      try { await api('/api/projects/remove', { id: r.id }); closeDialog(); info(r.name + ' removed from the list. Its files were not touched.'); await load(); if (!$('page-folders').hidden) loadFolders(); }
      catch (e) { info(e.message, true); }
    } }, 'Remove'), cancelBtn()]);
}
function removeFolderDialog(w) {
  dialog('Remove this working folder?', [
    h('p', null, h('b', null, w.path)),
    h('p', null, 'Its ' + w.projects + ' project' + (w.projects === 1 ? '' : 's') + ' leave the list. The folder and its files are not touched.')],
    [h('button', { class: 'btn accent', type: 'button', onclick: async () => {
      try { const r = await api('/api/folders/remove', { path: w.path }); if (!r.ok) return info(r.error, true); closeDialog(); info('Working folder removed. Its files were not touched.'); await load(); loadFolders(); }
      catch (e) { info(e.message, true); }
    } }, 'Remove'), cancelBtn()]);
}
async function showAgain(x) {
  try { const r = await api('/api/projects/show', { path: x.path }); if (!r.ok) return info(r.error, true); info(x.name + ' is back on the list.'); await load(); loadFolders(); }
  catch (e) { info(e.message, true); }
}
async function scanNow() {
  try {
    const r = await api('/api/scan', {});
    const parts = ['Scan finished: ' + r.total + ' project' + (r.total === 1 ? '' : 's') + ' in ' + r.folders + ' working folder' + (r.folders === 1 ? '' : 's') + '.'];
    if (r.added.length) parts.push('New: ' + r.added.join(', ') + '.');
    if (r.gone.length) parts.push('Gone: ' + r.gone.join(', ') + '.');
    if (!r.added.length && !r.gone.length && !r.first) parts.push('Nothing new since the last scan.');
    info(parts.join(' '));
    await load(); if (!$('page-folders').hidden) loadFolders();
  } catch (e) { info(e.message, true); }
}
async function openPath(p) {
  try { const r = await api('/api/folders/open', { path: p }); if (!r.ok) info(r.error, true); else if (r.dryRun) info('Dry run: ' + r.dryRun); }
  catch (e) { info(e.message, true); }
}
