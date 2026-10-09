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

function renderStatus() {
  const run = rows.filter(r => r.running).length;
  renderRunning(); renderLivePanel(); renderOrbit(); renderConn();
  $('st-projects').textContent = rows.length + ' project' + (rows.length === 1 ? '' : 's');
  $('st-running').textContent = run ? '● ' + run + ' running' : '○ none running';
  const g = [gitSummary(), nodeSummary()].filter(Boolean).join(' · ');
  $('st-git').textContent = g; $('st-git').hidden = !g;
  $('n-projects').textContent = rows.length || '';
  if (!stats) return;
  $('st-tokens').textContent = stats.tokensError ? 'Token count failed: Recount in the This PC panel' : stats.tokensBusy ? 'Counting tokens…' : stats.tokensAt ? 'Tokens counted ' + fmtWhen(Date.parse(stats.tokensAt)) : '';
  $('n-folders').textContent = stats.workingFolders.length || '';
  $('about-version').textContent = 'Bridge, part of TOMLIN ' + stats.version + (stats.dryRun ? ' (test copy: windows are reported, not opened)' : '');
  // A test copy says so everywhere a person could mistake it for the real one (in a test copy, Run local copy
  // reports the browser instead of opening it, which looks broken if you do not know).
  $('testbar').hidden = !stats.dryRun;
  document.title = stats.dryRun ? 'Bridge (TEST COPY)' : 'Bridge · TOMLIN';
  renderPC();
}

const SVG = 'http://www.w3.org/2000/svg';
function svg(tag, attrs, ...kids) { const el = document.createElementNS(SVG, tag); for (const k in attrs) el.setAttribute(k, attrs[k]); el.append(...kids); return el; }
// shown: the text in the middle (default "p%"); a ring with no reading shows a dash and, given onclick, is a
// button that says why.
function ring(label, pct, tip, shown, onclick) {
  const C = 2 * Math.PI * 26, p = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  const off = pct == null, text = off ? '—' : shown || p + '%';
  const attrs = onclick ? { type: 'button', onclick, 'aria-label': label + ': ' + (off ? 'no reading. ' : text + '. ') + tip }
    : { role: 'img', 'aria-label': label + ' ' + (off ? 'no reading' : text) };
  return h(onclick ? 'button' : 'div', { class: 'ring' + (p > 85 ? ' hot' : '') + (off ? ' off' : ''), title: tip, ...attrs },
    svg('svg', { viewBox: '0 0 64 64', 'aria-hidden': 'true' },
      svg('circle', { class: 'trk', cx: 32, cy: 32, r: 26, fill: 'none', 'stroke-width': 6 }),
      svg('circle', { class: 'val', cx: 32, cy: 32, r: 26, fill: 'none', 'stroke-width': 6, 'stroke-linecap': 'round',
        'stroke-dasharray': C.toFixed(2), 'stroke-dashoffset': (C * (1 - p / 100)).toFixed(2), transform: 'rotate(-90 32 32)' })),
    h('div', { class: 'ring-v' }, text), h('div', { class: 'ring-k' }, label));
}
const ENGINE_NAMES = { '3d': '3D', videodecode: 'video decoding', videoencode: 'video encoding', videoprocessing: 'video processing', copy: 'copying', 'gdi render': 'drawing windows', legacyoverlay: 'overlay', compute: 'compute' };
function gpuRing(g) {
  const card = g.adapters && g.adapters.length ? '\n' + g.adapters.join('\n') : '';
  if (g.pct == null) return ring('GPU', null, (g.error || 'Reading the GPU…') + card, null, g.error ? () => dialog('GPU use', [h('p', null, g.error), h('p', { class: 'muted' }, 'The Bridge reads GPU use from the same Windows counters Task Manager uses. Task Manager › Performance › GPU shows the same figure.')], [cancelBtn('Close')]) : null);
  const what = g.engine ? ENGINE_NAMES[g.engine.toLowerCase()] || g.engine : '';
  return ring('GPU', g.pct, 'GPU ' + g.pct + '%' + (what ? ' (busiest part: ' + what + ')' : '') + card + '\nThe same figure as Task Manager › Performance › GPU');
}
function tempRing(t) {
  if (t.c != null) return ring('CPU temp', t.c, 'CPU temperature ' + t.c + ' °C (' + t.label + (t.cpu ? ', ' + t.cpu : '') + ')\nRead from LibreHardwareMonitor. The full ring is 100 °C; it turns orange above 85 °C.', t.c + '°');
  return ring('CPU temp', null, t.error || 'Click to see why there is no reading', null, () => dialog('CPU temperature', [
    t.error ? h('p', { class: 'err' }, t.error) : null,
    h('p', null, 'Windows only gives the CPU\'s temperature to programs running as administrator, and the Bridge does not run as administrator. The one reading Windows gives everyone else comes from a sensor on the board that stays still while the CPU heats up, so the Bridge does not show it: it would be a wrong number that looks right.'),
    h('p', null, 'To fill this ring, install LibreHardwareMonitor (free and open source), run it as administrator, and turn on Options › Remote Web Server (port ' + t.port + '). Its Options menu can also start it with Windows. The Bridge then reads the CPU temperature from it every few seconds, on this PC only.'),
    h('p', null, h('a', { href: 'https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases', target: '_blank', rel: 'noopener' }, 'LibreHardwareMonitor downloads (GitHub)'))], [cancelBtn('Close')]));
}
// This PC lives in the nav pane (it used to be its own page).
// Disk sizes in whole GB (a tenth of a GB on a 238 GB drive is noise); memory keeps its tenth.
const gbWhole = b => String(Math.round(b / 1073741824));
function renderPC() {
  if (!stats) return;
  const s = stats, used = s.mem.total - s.mem.free;
  $('pc-host').textContent = s.host || '';
  $('pc-host').title = s.host || '';
  const rings = [ring('CPU', s.cpuPct, 'CPU ' + s.cpuPct + '% (' + s.cores + ' threads)' + (s.cpuModel ? '\n' + s.cpuModel.trim() : '')),
    ring('Memory', Math.round(100 * used / s.mem.total), 'Memory ' + fmtGB(used) + ' of ' + fmtGB(s.mem.total) + ' GB')];
  const fact = (k, v, tip) => h('div', { class: 'pc-fact', title: tip || null }, h('span', null, k), h('b', null, v));
  const facts = [fact('Up for', fmtUp(s.uptime)), fact('Memory', fmtGB(used) + ' of ' + fmtGB(s.mem.total) + ' GB')];
  if (s.disk) {
    const du = s.disk.total - s.disk.free;
    rings.push(ring('Disk', Math.round(100 * du / s.disk.total), 'Disk (the working folder\'s drive) ' + gbWhole(du) + ' of ' + gbWhole(s.disk.total) + ' GB'));
    facts.push(fact('Disk', gbWhole(du) + ' of ' + gbWhole(s.disk.total) + ' GB', 'The drive your working folder is on'));
  }
  if (s.gpu) rings.push(gpuRing(s.gpu));
  if (s.temp) rings.push(tempRing(s.temp));
  const counting = tokensCounting(), busy = s.tokensBusy || recounting;
  facts.push(fact('Tokens this month', counting ? 'counting…' : fmtTok(rows.reduce((t, r) => t + r.tokensMonth, 0))),
    fact('Tokens on disk', counting ? 'counting…' : fmtTok(rows.reduce((t, r) => t + r.tokens, 0)), 'Every token in the Claude Code and Codex transcripts on this PC'),
    h('div', { class: 'pc-count', 'aria-live': 'polite' }, h('span', null, busy ? 'Counting now…' : s.tokensAt ? 'Counted ' + fmtWhen(Date.parse(s.tokensAt)) : 'Not counted yet'),
      h('button', { class: 'linkbtn', type: 'button', onclick: recount, disabled: busy, 'aria-busy': busy ? 'true' : null, title: 'Count the tokens again from the transcripts (about half a minute)' }, busy ? 'Counting…' : 'Recount')));
  $('pc-rings').replaceChildren(...rings);
  $('pc-facts').replaceChildren(...facts);
}

function renderAudits() {
  const aud = rows.filter(r => r.audit).sort((a, b) => Date.parse(b.audit.ranAt) - Date.parse(a.audit.ranAt));
  $('audit-list').replaceChildren(...(aud.length ? aud.map(r => {
    const l = auditLabel(r.audit);
    return h('div', { class: 'set-row' }, icon(0xEA18), h('div', { class: 'txt' }, h('b', null, r.name), h('span', null, l.when + (r.audit.url ? ' · code + ' + r.audit.url : ' · code') + (r.audit.liveUrl ? ' + live ' + hostOf(r.audit.liveUrl) : r.audit.url ? '' : ' only'))),
      h('span', { class: l.cls, style: 'font-weight:600;font-size:13px' }, l.text), h('button', { class: 'btn', type: 'button', onclick: () => showLastAudit(r) }, 'Open'));
  }) : [h('div', { class: 'set-row' }, h('div', { class: 'txt' }, h('b', null, 'No audits yet'), h('span', null, 'Run one from a project\'s … menu › Scan app.')))]));
}
