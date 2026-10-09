// Git health: what to do about a project's git state (commands to copy; the Bridge itself never runs them), the
// projects waiting for a save or push, and the Git program's own version.
'use strict';

// Names from a repository's own files can hold characters a terminal reads as commands (git allows ; & $ in branch
// and remote names), so a command to copy only ever names a remote made of plain characters, and pushes HEAD.
const plainName = s => (/^[A-Za-z0-9._-]{1,60}$/.test(s || '') ? s : null);
function gitSteps(g) {
  if (!g || g.state === 'error') return null;
  const remote = plainName(g.remoteName) || 'origin';
  const save = ['git status', 'git add -A', 'git commit -m "Save work"'];
  let lead, cmds;
  switch (g.state) {
    case 'none': lead = 'To start a history here (skip it for scratch folders):'; cmds = ['git init', 'git add -A', 'git commit -m "First save"']; break;
    case 'empty': lead = 'Make the first save:'; cmds = ['git add -A', 'git commit -m "First save"']; break;
    case 'local': lead = 'Make an empty repository on GitHub (no README), then link it and push' + (g.changes ? ', after saving the changed files' : '') + ':';
      cmds = [...(g.changes ? save : []), 'git remote add origin https://github.com/YOUR-NAME/YOUR-REPO.git', 'git push -u origin HEAD']; break;
    case 'unpushed': lead = 'Push this branch to ' + g.remote + ':'; cmds = [...(g.changes ? save : []), 'git push -u ' + remote + ' HEAD']; break;
    case 'ahead': lead = 'Push the saves to ' + g.remote + ':'; cmds = ['git push']; break;
    case 'changes': lead = 'Save the changed files, then push:'; cmds = [...save, ...(g.remote ? ['git push'] : [])]; break;
    default: return null;
  }
  const copyBtn = c => h('button', { class: 'btn', type: 'button', title: 'Copy this command', onclick: () => copyText(c, 'Copied. Paste it into a terminal in the project folder.') }, icon(0xE8C8));
  return [h('p', { style: 'margin:14px 0 4px' }, h('b', null, 'What to do'), h('br'), lead),
    ...cmds.map(c => h('div', { class: 'git-cmd' }, h('code', null, c), copyBtn(c))),
    h('p', { class: 'muted', style: 'font-size:13px' }, (cmds.includes('git add -A') ? 'Read git status first: add -A saves every changed file, so a .gitignore should keep passwords and private files out. ' : '') + 'Paste into a terminal opened in the project folder (… menu › Open terminal here).')];
}

// The projects waiting for something, by what they need.
function gitWaiting() {
  const g = rows.filter(r => r.git && !['none', 'error'].includes(r.git.state));
  return {
    unsaved: g.filter(r => r.git.changes > 0),
    unpushed: g.filter(r => r.git.state === 'ahead' || r.git.state === 'unpushed' || (r.git.state === 'changes' && r.git.ahead > 0)),
    local: g.filter(r => r.git.state === 'local'),
  };
}
const GIT_GROUPS = [['unsaved', 'Unsaved changes', 'Files changed since the last save (commit).'],
  ['unpushed', 'Not pushed', 'Saved on this PC but not on the backup copy yet.'],
  ['local', 'Only on this PC', 'No backup copy anywhere: if this PC is lost, so is the history.']];
function gitHealthDialog() {
  const w = gitWaiting();
  const detail = (k, g) => k === 'unsaved' ? plural(g.changes, 'file changed', 'files changed') : k === 'unpushed' ? (g.ahead ? plural(g.ahead, 'save', 'saves') + ' to push' : 'branch never pushed') : '';
  const since = r => r.git.lastCommit ? 'last save ' + fmtWhen(Date.parse(r.git.lastCommit)) : '';
  dialog('Git: projects waiting', [
    h('p', { class: 'muted' }, 'The Bridge only reads git. Open a project for the commands to copy.'),
    ...GIT_GROUPS.flatMap(([k, title, say]) => w[k].length ? [h('p', { style: 'margin:14px 0 4px' }, h('b', null, title + ' (' + w[k].length + ')'), h('br'), h('span', { class: 'muted', style: 'font-size:13px' }, say)),
      ...w[k].map(r => h('div', { class: 'git-wait' }, h('button', { class: 'linkbtn', type: 'button', onclick: () => gitDialog(r) }, r.name), h('span', null, [detail(k, r.git), since(r), k === 'local' && r.node ? (nodeCurrent(r.node) ? 'a copy is on ' + r.node.pcName : 'no copy on another PC either') : ''].filter(Boolean).join(' · '))))] : [])],
    [h('button', { class: 'btn accent', type: 'button', onclick: closeDialog }, 'Close')], 'wide');
}
$('st-git').addEventListener('click', gitHealthDialog);

// ---- The Git program (About › Git) ----
let gitProg = null;
async function loadGitProgram(fresh) {
  try { gitProg = await api('/api/git-program' + (fresh ? '?fresh=1' : '')); renderGitProgram(); renderStatus(); } catch (e) { info(e.message, true); }
}
function renderGitProgram() {
  const p = gitProg;
  if (!p) return;
  $('git-online').checked = p.online;
  const lines = [];
  if (p.missing) lines.push('Git is not installed on this PC, so the Bridge cannot show whether your projects are backed up.');
  else if (!p.installed) lines.push('The Git version could not be read' + (p.error ? ': ' + p.error : '.'));
  else if (p.judge.old) lines.push(h('span', { class: 'warn-line' }, '▲ Git ' + p.installed + ' is older than ' + p.judge.fixedIn + ' (' + p.judge.when + '), which has the fixes for ' + p.judge.what + '. Update it: How to update shows how.'));
  else lines.push('● Git ' + p.installed + ': has every security fix this Bridge knows about (up to ' + p.judge.when + ').');
  if (p.online && p.latest) lines.push(p.latest.error ? p.latest.error : p.latest.newer ? h('span', { class: 'warn-line' }, '▲ A newer Git is out: ' + p.latest.version + '.') : 'Newest Git: ' + p.latest.version + ' (checked ' + fmtWhen(Date.parse(p.latest.at)) + ').');
  $('git-note').replaceChildren(...lines.flatMap((l, i) => i ? [h('br'), l] : [l]));
}
$('git-online').addEventListener('change', async e => {
  const on = e.target.checked;
  try { const r = await api('/api/git-online', { on }); gitProg = r.git; renderGitProgram(); renderStatus(); info(on ? 'The Bridge will ask GitHub for the newest Git version once a day.' : 'The Bridge will not ask the internet about Git.'); }
  catch (er) { e.target.checked = !on; info(er.message, true); }
});
$('btn-git-help').addEventListener('click', () => {
  const p = gitProg || {};
  const cmd = 'winget upgrade --id Git.Git -e';
  dialog('Update Git', [
    h('p', null, 'Old versions of Git had security holes that a single clone of a bad repository could set off, so keep it up to date.'),
    p.installed ? h('p', null, 'You have Git ' + p.installed + '.') : null,
    h('p', null, 'In a terminal, Windows\' own installer updates it (close any program using Git first):'),
    h('div', { class: 'git-cmd' }, h('code', null, cmd), h('button', { class: 'btn', type: 'button', title: 'Copy this command', onclick: () => copyText(cmd, 'Copied. Paste it into a terminal.') }, icon(0xE8C8))),
    h('p', null, 'Or download the installer from ', h('a', { href: 'https://git-scm.com/downloads', target: '_blank', rel: 'noopener' }, 'git-scm.com'), '. GitHub Desktop carries its own copy of Git: keep GitHub Desktop updated too.'),
    h('p', { class: 'muted', style: 'font-size:13px' }, 'This Bridge knows the security fixes up to ' + (p.judge ? p.judge.when : 'its release') + ' (', h('a', { href: p.known ? p.known.advisories.windows : 'https://github.com/git-for-windows/git/security/advisories', target: '_blank', rel: 'noopener' }, 'Git for Windows security advisories'), '). After updating, Check again reads the version again.')],
    [h('button', { class: 'btn accent', type: 'button', onclick: () => { closeDialog(); loadGitProgram(true); } }, 'Check again'), cancelBtn('Close')]);
});
