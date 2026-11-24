// The connection light and the bar at the bottom of every page.
'use strict';

// ---- The connection light (left, under the name) ----
function renderConn() {
  const c = $('conn');
  if (!c) return;
  c.className = 'conn ' + (lost ? 'lost' : 'ok');
  $('conn-text').textContent = lost ? (restartAt && Date.now() - restartAt < 15000 ? 'Reconnecting…' : 'Connection lost') : 'Connected';
  c.closest('.brand').classList.toggle('lost', lost);
  $('conn-logo').title = lost ? 'Connection lost' : 'Connected';
}

// What is running, said the same way in the bar, the Running list and the orbit: sites the Bridge started, and sites
// another program holds on a project's port.
function runningSplit() {
  const mine = rows.filter(r => r.running), other = rows.filter(r => !r.running && r.portInUse);
  const words = mine.length && other.length ? mine.length + ' started here · ' + other.length + ' other'
    : other.length ? other.length + ' started by another program' : mine.length + ' running';
  return { mine, other, n: mine.length + other.length, words };
}
function renderStatus() {
  const run = runningSplit();
  renderRunning(); renderLivePanel(); renderOrbit(); renderConn();
  $('st-projects').textContent = rows.length + ' project' + (rows.length === 1 ? '' : 's');
  $('st-running').textContent = run.n ? (run.mine.length ? '● ' : '◐ ') + run.words : '○ none running';
  const g = [gitSummary(), nodeSummary()].filter(Boolean).join(' · ');
  $('st-git').textContent = g; $('st-git').hidden = !g;
  const bad = gitProblems().length;
  $('st-gitproblem').textContent = bad ? '✕ ' + plural(bad, 'project', 'projects') + ' with a git problem' : '';
  $('st-gitproblem').hidden = !bad;
  $('n-projects').textContent = rows.length || '';
  if (!stats) return;
  $('st-tokens').textContent = stats.tokensError ? 'Token count failed' : stats.tokensBusy ? 'Counting tokens…' : stats.tokensAt ? 'Tokens counted ' + fmtWhen(Date.parse(stats.tokensAt)) : '';
  $('n-folders').textContent = stats.workingFolders.length || '';
  $('about-version').textContent = 'Bridge, part of TOMLIN ' + stats.version + (stats.dryRun ? ' (test copy: windows are reported, not opened)' : '');
  // A test copy says so everywhere a person could mistake it for the real one (in a test copy, Run local copy
  // reports the browser instead of opening it, which looks broken if you do not know).
  $('testbar').hidden = !stats.dryRun;
  document.title = stats.dryRun ? 'Bridge (TEST COPY)' : 'Bridge · TOMLIN';
}

function renderAudits() {
  const aud = rows.filter(r => r.audit).sort((a, b) => Date.parse(b.audit.ranAt) - Date.parse(a.audit.ranAt));
  $('audit-list').replaceChildren(...(aud.length ? aud.map(r => {
    const l = auditLabel(r.audit, r.updated);
    return h('div', { class: 'set-row' }, icon(0xEA18), h('div', { class: 'txt' }, h('b', null, r.name), h('span', null, l.when + (r.audit.url ? ' · code + ' + r.audit.url : ' · code') + (r.audit.liveUrl ? ' + live ' + hostOf(r.audit.liveUrl) : r.audit.url ? '' : ' only'))),
      h('span', { class: l.cls, style: 'font-weight:600;font-size:13px' }, l.text), h('button', { class: 'btn', type: 'button', onclick: () => showLastAudit(r) }, 'Open'));
  }) : [h('div', { class: 'set-row' }, h('div', { class: 'txt' }, h('b', null, 'No audits yet'), h('span', null, 'Run one from a project\'s … menu › Scan app.')))]));
}
