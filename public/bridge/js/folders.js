// The Folders page.
'use strict';

// ---- folders page ----
async function loadFolders() {
  try { folders = await api('/api/settings'); renderFolders(); } catch (e) { info(e.message, true); }
}
// A project added one by one whose folder is gone is not on the list, so it is removed by its path.
async function forgetProject(x) {
  try { const r = await api('/api/projects/forget', { path: x.path }); if (!r.ok) return info(r.error, true); info(x.name + ' (not found) is off the list.'); loadFolders(); }
  catch (e) { info(e.message, true); }
}
function renderFolders() {
  const f = folders;
  $('last-scan').textContent = f.lastScan ? 'Last scan ' + fmtWhen(Date.parse(f.lastScan)) : '';
  $('wf-list').replaceChildren(...(f.workingFolders.length ? f.workingFolders.map(w => h('div', { class: 'set-row' }, icon(0xE8B7),
    h('div', { class: 'txt' }, h('b', null, w.path), h('span', null, w.exists ? w.projects + ' project' + (w.projects === 1 ? '' : 's') : 'Not found: the folder was moved or deleted')),
    h('button', { class: 'btn', type: 'button', onclick: () => openPath(w.path) }, 'Open'),
    h('button', { class: 'btn', type: 'button', onclick: () => removeFolderDialog(w) }, 'Remove')))
    : [h('div', { class: 'set-row' }, h('div', { class: 'txt' }, h('b', null, 'No working folders'), h('span', null, 'Add the folder that holds your projects.')), h('button', { class: 'btn accent', type: 'button', onclick: () => addFolderDialog() }, 'Add working folder'))]));
  $('extra-list').replaceChildren(...(f.extraProjects.length ? f.extraProjects.map(x => h('div', { class: 'set-row' }, icon(0xE8F4),
    h('div', { class: 'txt' }, h('b', null, x.name), h('span', null, x.exists ? x.path : x.path + ' (not found)')),
    h('button', { class: 'btn', type: 'button', onclick: () => { const r = rows.find(r => r.dir.toLowerCase() === x.path.toLowerCase()); if (r) removeProjectDialog(r); else forgetProject(x); } }, 'Remove')))
    : [h('div', { class: 'set-row' }, h('div', { class: 'txt' }, h('b', null, 'None'), h('span', null, 'Use Add project for a project kept outside your working folders.')))]));
  $('hidden-list').replaceChildren(...(f.hidden.length ? f.hidden.map(x => h('div', { class: 'set-row' }, icon(0xE738),
    h('div', { class: 'txt' }, h('b', null, x.name), h('span', null, x.path + (x.exists ? '' : ' (not found)'))),
    h('button', { class: 'btn', type: 'button', onclick: () => showAgain(x) }, 'Show again')))
    : [h('div', { class: 'set-row' }, h('div', { class: 'txt' }, h('b', null, 'Nothing removed'), h('span', null, 'Projects you remove from the list appear here.')))]));
}
