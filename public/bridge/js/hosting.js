// Push live: a project's files to its web host in one press (cPanel, FTPS or SFTP), its secrets, its database, and
// Go back. The server does the work (src/bridge/hosting); this page never receives a secret value, a token, a
// password or a key, and a value typed here is sent once and never shown again.
// Every top-level name here starts with "pl" (the page's scripts share one global scope).
'use strict';

const PL_KIND = { cpanel: 'cPanel', ftps: 'FTPS', sftp: 'SFTP' };
let plInfo = null; // { on, connections }

async function plLoad() { plInfo = await api('/api/hosting'); return plInfo; }
const plConn = id => (plInfo && plInfo.connections.find(c => c.id === id)) || null;
const plErrBox = () => h('div', { class: 'err', role: 'alert' });
const plBusy = on => { for (const b of $('dlg-foot').querySelectorAll('button')) b.disabled = on; for (const b of $('dlg-body').querySelectorAll('button')) b.disabled = on; };
function plWhen(iso) { return iso ? fmtWhen(Date.parse(iso)) : 'never'; }
function plCopyBtn(text, label = 'Copy') {
  const b = h('button', { class: 'btn', type: 'button', onclick: async () => {
    try { await navigator.clipboard.writeText(text); b.lastChild.textContent = 'Copied'; setTimeout(() => { b.lastChild.textContent = label; }, 1500); } catch { info('Copy did not work here: select the text and press Ctrl+C.', true); }
  } }, icon(0xE8C8), h('span', null, label));
  return b;
}

// ---------- the main window ----------
async function plOpen(r) {
  let d;
  try { await plLoad(); d = await api('/api/hosting/site?id=' + encodeURIComponent(r.id)); } catch (e) { return info(e.message, true); }
  if (!plInfo.on) return plOffDialog(r);
  if (!d.site || !d.site.connection) return plSetupDialog(r, d);
  plMainDialog(r, d);
}

function plOffDialog(r) {
  dialog('Push live', [
    h('p', null, 'Push live sends ' + r.name + '\'s files to your web host in one press (cPanel, FTPS or SFTP) and makes the site\'s address its live address here, with the light.'),
    h('ul', { class: 'pl-list' },
      h('li', null, 'Sent: the files in the folder you pick, and only those that changed since the last push.'),
      h('li', null, 'Never sent: .env files, git\'s history, installed packages, keys, working notes (AI hand-offs and prompts). data/, logs, backups and .sql files only when you tick them.'),
      h('li', null, 'A file holding a key, a password or one of your private details stops the push before anything leaves this PC, and names the file and line.'),
      h('li', null, 'Secrets (passwords, API keys) are kept locked by Windows on this PC and written on the server to one file outside the web folder.'),
      h('li', null, 'Before a file on the server is replaced, a copy is kept, so Go back puts the files of the last push back the way they were (the Live secrets and a database are not put back).')),
    h('p', { class: 'muted' }, 'It is off until you turn it on, because it is the one part of TOMLIN that sends a project out to the internet. Turn it off again in this window any time.')],
    [h('button', { class: 'btn accent', type: 'button', onclick: async () => {
      try { await api('/api/hosting/on', { on: true }); plOpen(r); } catch (e) { info(e.message, true); }
    } }, 'Turn on push live'), cancelBtn()], 'wide');
}

function plMainDialog(r, d) {
  const s = d.site;
  const conn = plConn(s.connection);
  const err = plErrBox();
  const steps = h('ol', { class: 'pl-steps', hidden: true });
  const out = h('div', { class: 'pl-out' });
  const last = s.pushes.find(x => !x.undone);
  const summary = h('div', { class: 'pl-summary' },
    h('p', null, 'From ', h('b', null, s.folder ? s.folder + '/' : 'the project folder'), ' to ', h('b', null, s.url), conn ? ' (' + PL_KIND[conn.kind] + ': ' + conn.label + ')' : ''),
    h('p', { class: 'muted' }, s.pushes.length ? 'Last push: ' + plWhen(s.pushes[0].at) + ', ' + plural(s.pushes[0].sent, 'file', 'files') + (s.pushes[0].pending || s.pushes[0].failed ? ' to send; it STOPPED PART WAY, so the site may be half old, half new: push again, or Go back to undo what it did' : ' sent') + (s.pushes[0].undone ? ' (undone with Go back)' : '') + (s.pushes[0].verified === 'not-checked' && !s.pushes[0].undone ? '; the live site could not be asked whether it shows a secret' : '') + '.' : 'Not pushed yet: the first push sends every file.'),
    d.secrets.length ? h('p', { class: 'muted' }, 'Secrets: ' + d.secrets.map(x => x.name + (x.live ? '' : ' (no Live value)')).join(', ') + '.') : null,
    s.lastError ? h('p', { class: 'fld-err' }, 'The last try (' + plWhen(s.lastError.at) + ') stopped: ' + s.lastError.error) : null);
  const more = h('div', { class: 'pl-acts' },
    h('button', { class: 'btn', type: 'button', onclick: () => plRunCheck(r, out, err) }, icon(0xE73E), 'Check first'),
    last ? h('button', { class: 'btn', type: 'button', title: 'Puts back what the push of ' + plWhen(last.at) + ' replaced, and removes what it added', onclick: () => plGoBack(r, last, steps, out, err) }, icon(0xE7A7), 'Go back') : null,
    h('button', { class: 'btn', type: 'button', onclick: () => plSecretsDialog(r) }, icon(0xE72E), 'Secrets…'),
    conn && conn.kind === 'cpanel' ? h('button', { class: 'btn', type: 'button', onclick: () => plDbDialog(r) }, 'Database…') : null,
    h('button', { class: 'btn', type: 'button', onclick: () => plSetupDialog(r, d) }, icon(0xE713), 'Set up…'),
    s.url ? h('a', { class: 'btn', href: s.url, target: '_blank', rel: 'noopener noreferrer' }, icon(0xE8A7), 'Open live site') : null);
  const all = h('input', { type: 'checkbox' });
  dialog('Push live: ' + r.name, [summary, more,
    h('label', { class: 'tick pl-tick' }, all, 'Send every file, not only the changed ones (when files were changed on the server by hand)'),
    err, steps, out,
    h('p', { class: 'muted pl-small' }, 'Push live is on. ', h('button', { class: 'linkbtn', type: 'button', onclick: async () => {
      try { await api('/api/hosting/on', { on: false }); closeDialog(); info('Push live is off. Nothing is sent until it is turned on again; your set-ups and secrets are kept.'); } catch (e) { info(e.message, true); }
    } }, 'Turn it off'))],
    [h('button', { class: 'btn accent', type: 'button', onclick: () => plPush(r, all.checked, steps, out, err) }, icon(0xE898), 'Push live'), cancelBtn('Close')], 'wide');
}

function plFindings(r, list, again) {
  return h('div', { class: 'pl-findings' },
    h('p', { class: 'fld-err' }, plural(list.length, 'thing', 'things') + ' must not go live. Fix ' + (list.length === 1 ? 'it' : 'them') + ' in the file (keep values in Secrets and read them with getenv), then push again.'),
    ...list.map(f => h('div', { class: 'check' },
      h('span', { class: 'sev' }, f.rule === 'VALUE' ? 'Secret' : f.rule === 'KEY' ? 'Key' : f.rule === 'ASSIGN' ? 'Password?' : f.rule === 'PATH' ? 'PC path' : f.rule === 'READ' ? 'Unread' : 'Private'),
      h('span', { class: 'what' }, h('b', null, f.rel + (f.line ? ':' + f.line : '')), ' ' + f.what),
      f.canIgnore ? h('button', { class: 'btn', type: 'button', title: 'Marks this line as fine to send. If the line changes, it is checked again.', onclick: async e => {
        e.target.disabled = true;
        try { const x = await api('/api/hosting/ignore', { id: r.id, key: f.key }); if (!x.ok) return info(x.error, true); e.target.closest('.check').remove(); if (again) again(); } catch (er) { info(er.message, true); }
      } }, 'Not a secret') : null)));
}

async function plRunCheck(r, out, err) {
  err.textContent = ''; out.replaceChildren(h('p', { class: 'muted' }, 'Checking the files…'));
  try {
    const c = await api('/api/hosting/check', { id: r.id });
    if (!c.ok) { out.replaceChildren(); err.textContent = c.error; return; }
    out.replaceChildren(
      h('p', null, plural(c.files, 'file', 'files') + ' (' + (c.bytes / 1048576).toFixed(1) + ' MB) would be sent.' + (c.findings.length ? '' : ' Nothing in them must stay private.')),
      c.findings.length ? plFindings(r, c.findings, () => plRunCheck(r, out, err)) : null,
      c.left.length ? h('details', { class: 'pl-left' }, h('summary', null, 'Left out: ' + c.left.reduce((a, g) => a + g.count, 0) + ' (why)'),
        ...c.left.map(g => h('p', { class: 'muted' }, h('b', null, g.count + ' × '), g.why + ': ' + g.some.join(', ') + (g.count > g.some.length ? ', …' : '')))) : null);
  } catch (e) { out.replaceChildren(); err.textContent = e.message; }
}

function plShowSteps(steps, job) {
  steps.hidden = false;
  steps.replaceChildren(...job.steps.map(s => h('li', { class: 'pl-step ' + s.state }, h('span', { class: 'mark', 'aria-hidden': 'true' }, s.state === 'done' ? '✓' : s.state === 'fail' ? '✕' : '…'), h('span', null, s.text + (s.state === 'fail' ? ' (stopped here)' : '')))));
}
async function plFollow(r, jobId, steps, out, err, onDone) {
  for (;;) {
    let p;
    try { p = await api('/api/hosting/progress', { job: jobId }); } catch (e) { err.textContent = e.message; break; }
    if (!p.ok) { err.textContent = p.error; break; }
    plShowSteps(steps, p.job);
    if (p.job.done) { onDone(p.job); break; }
    await new Promise(res => setTimeout(res, 400));
  }
  plBusy(false);
}

async function plPush(r, all, steps, out, err) {
  err.textContent = ''; out.replaceChildren(); plBusy(true);
  let x;
  try { x = await api('/api/hosting/push', { id: r.id, all }); } catch (e) { err.textContent = e.message; return plBusy(false); }
  if (!x.ok) { err.textContent = x.error; return plBusy(false); }
  plFollow(r, x.job, steps, out, err, job => {
    if (job.findings) { out.replaceChildren(plFindings(r, job.findings)); err.textContent = job.error; return; }
    const res = job.result;
    if (!res) { err.textContent = job.error; return; }
    out.replaceChildren(
      h('p', null, h('b', null, job.ok ? 'Live at ' : 'Sent to '), h('a', { href: res.url, target: '_blank', rel: 'noopener noreferrer' }, res.url), '. ' + plural(res.sent, 'file', 'files') + ' sent, ' + res.same + ' unchanged' + (res.removed ? ', ' + res.removed + ' removed' : '') + (res.kept ? '; copies kept of ' + plural(res.kept, 'file', 'files') + ' it replaced or removed (Go back)' : '') + '.'),
      res.secrets ? h('p', { class: 'muted' }, 'Live secrets written to ' + res.secrets.file + (res.secrets.chmod ? ' (only this hosting account can read it).' : '. The server did not take the owner-only setting: set the file to 600 in your host\'s file manager.')) : null,
      h('p', { class: 'muted' }, 'Checked on the live site: ' + res.leaks.map(l => l.path + ' ' + (l.ok === false ? '✕ ' : l.ok ? '✓ ' : '? ') + l.said).join('; ') + '.'),
      res.live ? h('p', { class: 'muted' }, 'Its live address is set here; the light says: ' + res.live.reason) : null);
    if (job.error) err.textContent = job.error;
    else info(r.name + ' is live at ' + res.url + '.');
    load();
  });
}

async function plGoBack(r, last, steps, out, err) {
  if (!confirm('Go back from the push of ' + plWhen(last.at) + '? The files it replaced are put back and the ' + plural(last.added, 'file', 'files') + ' it added are removed from the server. Files only: the Live secrets and a database stay as they are now.')) return;
  err.textContent = ''; out.replaceChildren(); plBusy(true);
  let x;
  try { x = await api('/api/hosting/back', { id: r.id }); } catch (e) { err.textContent = e.message; return plBusy(false); }
  if (!x.ok) { err.textContent = x.error; return plBusy(false); }
  plFollow(r, x.job, steps, out, err, job => {
    if (!job.ok) { err.textContent = 'Go back stopped: ' + job.error + ' What was already put back stays put back; press Go back again to finish.'; return; }
    out.replaceChildren(h('p', null, 'Gone back: ' + job.result.restored + ' put back, ' + job.result.removed + ' removed. The Live secrets and any database were not changed. The next push sends every file again.'));
    info(r.name + ': the last push was undone.');
  });
}

// ---------- set up: where it goes ----------
async function plSetupDialog(r, d) {
  await plLoad().catch(() => {});
  const s = d.site || {};
  const err = plErrBox();
  const connSel = h('select', { class: 'sel', 'aria-label': 'Connection' },
    h('option', { value: '' }, plInfo.connections.length ? 'Pick a connection' : 'No connection yet: connect a host first'),
    ...plInfo.connections.map(c => h('option', { value: c.id, selected: c.id === s.connection }, PL_KIND[c.kind] + ': ' + c.label)));
  const where = h('div', { class: 'pl-where' });
  const folderSel = h('select', { class: 'sel', 'aria-label': 'Upload folder' },
    ...d.folders.map(f => h('option', { value: f, selected: (s.folder != null && s.connection ? s.folder : d.guess) === f }, f ? f + '/' : r.name + ' itself (the whole project)')));
  const soft = d.soft.map(x => h('label', { class: 'tick' }, h('input', { type: 'checkbox', value: x.key, checked: (s.sendAnyway || []).includes(x.key) }), 'Also send ' + x.label));
  let picked = { domain: s.domain || '', root: s.connection ? s.root : 'public_html' };
  const drawWhere = async () => {
    err.textContent = '';
    const c = plConn(connSel.value);
    if (!c) return where.replaceChildren();
    // FTPS/SFTP: the two boxes at once (they do not need the server); the server's folders are added when it answers.
    if (c.kind !== 'cpanel') {
      const root = h('input', { type: 'text', class: 'pl-root', value: picked.root, placeholder: 'public_html', 'aria-label': 'Web folder on the server', spellcheck: 'false' });
      const url = h('input', { type: 'text', class: 'pl-url', value: s.connection === c.id ? s.url || '' : '', placeholder: 'example.com', inputmode: 'url', 'aria-label': 'The address the site shows at', spellcheck: 'false' });
      const hint = h('span', { class: 'muted' }, ' (asking ' + c.host + ' which folders it has…)');
      where.replaceChildren(h('label', { class: 'fld-label' }, 'Web folder on the server', hint), h('div', { class: 'field' }, root),
        h('label', { class: 'fld-label' }, 'The address it shows at'), h('div', { class: 'field' }, url),
        h('p', { class: 'muted pl-small' }, 'Secrets go in a folder called tomlin-secrets beside the web folder (one level up), never inside it.'));
      let p;
      try { p = await api('/api/hosting/places', { connection: c.id, dir: '' }); } catch (e) { p = { ok: false, error: e.message }; }
      if (p.ok) hint.textContent = ' (folders at the top of the account: ' + (p.folders.join(', ') || 'none') + ')';
      else { hint.textContent = ''; err.textContent = p.error + ' You can still save, and push once it answers.'; }
      return;
    }
    where.replaceChildren(h('p', { class: 'muted' }, 'Asking ' + c.host + '…'));
    let p;
    try { p = await api('/api/hosting/places', { connection: c.id }); } catch (e) { p = { ok: false, error: e.message }; }
    if (!p.ok) { where.replaceChildren(); err.textContent = p.error; return; }
    const dom = h('select', { class: 'sel', 'aria-label': 'Site' }, ...p.domains.map(x => h('option', { value: x.domain, selected: x.domain === picked.domain }, x.domain + ' (' + x.root + ')')));
    const sub = h('input', { type: 'text', class: 'pl-sub', value: s.sub || '', placeholder: 'empty = the site itself', 'aria-label': 'Folder inside the site', spellcheck: 'false' });
    where.replaceChildren(h('label', { class: 'fld-label' }, 'Site'), h('div', { class: 'field' }, dom),
      h('label', { class: 'fld-label' }, 'Folder inside the site (optional, like app for ' + (p.domains[0] ? p.domains[0].domain : 'example.com') + '/app/)'), h('div', { class: 'field' }, sub),
      h('p', { class: 'muted pl-small' }, 'Other sites\' folders inside this one (cPanel puts addon domains inside public_html) are never touched: a push only replaces or removes files it sent itself.'));
  };
  connSel.addEventListener('change', drawWhere);
  const save = h('button', { class: 'btn accent', type: 'button', onclick: async () => {
    const c = plConn(connSel.value);
    if (!c) { err.textContent = 'Pick a connection, or connect a host first.'; return connSel.focus(); }
    const body = { id: r.id, connection: c.id, folder: folderSel.value, sendAnyway: soft.map(l => l.querySelector('input')).filter(i => i.checked).map(i => i.value) };
    if (c.kind === 'cpanel') { const dom = where.querySelector('select'); if (!dom) { err.textContent = 'Wait for the list of sites, then save.'; return; } body.domain = dom.value; body.sub = where.querySelector('.pl-sub').value; }
    else { body.root = where.querySelector('.pl-root').value; body.url = where.querySelector('.pl-url').value; }
    save.disabled = true; err.textContent = '';
    try {
      const x = await api('/api/hosting/site/set', body);
      if (!x.ok) { err.textContent = x.error; save.disabled = false; return; }
      info(r.name + ' goes to ' + x.site.url + '. Press Push live to send it.');
      plOpen(r);
    } catch (e) { err.textContent = e.message; save.disabled = false; }
  } }, 'Save');
  dialog('Set up push live: ' + r.name, [
    h('label', { class: 'fld-label' }, 'Connection'), h('div', { class: 'field' }, connSel, h('button', { class: 'btn', type: 'button', onclick: () => plConnectionsDialog(() => plSetupDialog(r, d)) }, 'Connections…')),
    where,
    h('label', { class: 'fld-label' }, 'Upload folder (what goes to the server)'), h('div', { class: 'field' }, folderSel),
    h('div', { class: 'pl-soft' }, ...soft),
    err,
    s.connection ? h('p', { class: 'muted pl-small' }, h('button', { class: 'linkbtn', type: 'button', onclick: async () => {
      if (!confirm('Forget where ' + r.name + ' goes? Nothing on the server is touched.')) return;
      try { const x = await api('/api/hosting/site/remove', { id: r.id }); info(x.note || 'Forgotten.'); closeDialog(); } catch (e) { info(e.message, true); }
    } }, 'Forget this set-up')) : null],
    [save, h('button', { class: 'btn', type: 'button', onclick: () => (s.connection ? plOpen(r) : closeDialog()) }, 'Cancel')], 'wide');
  drawWhere();
}

// ---------- connections ----------
async function plConnectionsDialog(back) {
  try { await plLoad(); } catch (e) { return info(e.message, true); }
  const err = plErrBox();
  const rows = plInfo.connections.map(c => h('div', { class: 'check pl-conn' },
    h('span', { class: 'sev' }, PL_KIND[c.kind]),
    h('span', { class: 'what' }, h('b', null, c.label), ' ' + c.user + '@' + c.host + ':' + c.port + (c.lastOk ? '. Worked ' + plWhen(c.lastOk) : '. Not tested yet') + (c.hostKey ? '. Server key ' + c.hostKey : '') + '.'),
    c.kind === 'sftp' && c.publicKey ? plCopyBtn(c.publicKey, 'Copy public key') : null,
    h('button', { class: 'btn', type: 'button', onclick: async e => {
      e.target.disabled = true;
      try { const x = await api('/api/hosting/test', { connection: c.id }); x.ok ? info(c.label + ' works.' + (x.connection.hostKey ? ' Server key: ' + x.connection.hostKey : '')) : info(x.error, true); }
      catch (er) { info(er.message, true); }
      e.target.disabled = false;
    } }, 'Test'),
    h('button', { class: 'btn danger', type: 'button', onclick: async () => {
      if (!confirm('Disconnect ' + c.label + '? ' + (c.kind === 'cpanel' && c.tokenName ? 'TOMLIN deletes its own token in cPanel. ' : '') + 'Projects that push there will need a connection again.')) return;
      try { const x = await api('/api/hosting/disconnect', { connection: c.id }); info('Disconnected. ' + (x.note || '')); plConnectionsDialog(back); } catch (er) { info(er.message, true); }
    } }, 'Disconnect')));
  dialog('Hosting connections', [
    rows.length ? h('div', null, ...rows) : h('p', { class: 'muted' }, 'No host connected yet.'),
    h('div', { class: 'pl-acts' },
      h('button', { class: 'btn', type: 'button', onclick: () => plConnectDialog('cpanel', back) }, 'Connect cPanel…'),
      h('button', { class: 'btn', type: 'button', onclick: () => plConnectDialog('ftps', back) }, 'Connect FTPS…'),
      h('button', { class: 'btn', type: 'button', onclick: () => plConnectDialog('sftp', back) }, 'Connect SFTP…')),
    h('p', { class: 'muted pl-small' }, 'cPanel is the best fit for most shared hosting. FTPS and SFTP reach almost any other host. Plain FTP is not offered: it sends your password and every file unprotected.'),
    err],
    [h('button', { class: 'btn', type: 'button', onclick: () => (back ? back() : closeDialog()) }, back ? 'Back' : 'Close')], 'wide');
}

function plConnectDialog(kind, back) {
  const err = plErrBox();
  const inp = (cls, attrs) => h('input', { type: 'text', class: cls, spellcheck: 'false', autocomplete: 'off', ...attrs });
  const host = inp('pl-host', { placeholder: 'server123.yourhost.com', 'aria-label': 'Server name' });
  const port = inp('pl-port', { value: kind === 'cpanel' ? '2083' : kind === 'ftps' ? '21' : '22', inputmode: 'numeric', 'aria-label': 'Port' });
  const user = inp('pl-user', { placeholder: kind === 'ftps' ? 'the FTP account\'s user name' : kind === 'sftp' ? 'the account\'s user name (on cPanel hosts, your cPanel one)' : 'your cPanel user name', 'aria-label': 'User name' });
  const label = inp('pl-label', { placeholder: 'a name for it here (optional)', 'aria-label': 'Name' });
  const pass = h('input', { type: 'password', class: 'pl-pass', autocomplete: 'new-password', 'aria-label': kind === 'cpanel' ? 'cPanel password' : 'FTP password' });
  const token = inp('pl-token', { placeholder: 'or paste a token made in cPanel', 'aria-label': 'cPanel API token' });
  const implicit = h('input', { type: 'checkbox' });
  const kids = [
    h('label', { class: 'fld-label' }, 'Server name'), h('div', { class: 'field' }, host, port),
    h('label', { class: 'fld-label' }, 'User name'), h('div', { class: 'field' }, user)];
  if (kind === 'cpanel') kids.push(
    h('label', { class: 'fld-label' }, 'Password'), h('div', { class: 'field' }, pass),
    h('p', { class: 'muted pl-small' }, 'Used once to make TOMLIN\'s own token in your cPanel (Security, Manage API Tokens: it is named TOMLIN_ and this PC\'s name), then dropped: nothing on this PC keeps your password. Disconnect deletes the token again.'),
    h('label', { class: 'fld-label' }, 'Or a token (accounts with two-step sign-in)'), h('div', { class: 'field' }, token),
    h('p', { class: 'muted pl-small' }, 'The server name is in your hosting welcome email, or in cPanel under General Information ("Server Name"). Your own domain often has the wrong certificate for cPanel\'s port.'));
  if (kind === 'ftps') kids.push(
    h('label', { class: 'fld-label' }, 'Password'), h('div', { class: 'field' }, pass),
    h('label', { class: 'tick' }, implicit, 'Implicit FTPS (port 990): only if your host says so'),
    h('p', { class: 'muted pl-small' }, 'Kept on this PC locked by Windows for your account, and handed to Windows\' own curl only while it sends. Plain FTP (no TLS) is refused.'));
  if (kind === 'sftp') kids.push(
    h('p', { class: 'muted pl-small' }, 'SFTP signs in with a key, not a password: TOMLIN makes one now and shows its public half, which you add once in your host\'s panel (cPanel: SSH Access, Manage SSH Keys, Import Key, then Authorize). The private half stays on this PC, locked by Windows.'));
  kids.push(h('label', { class: 'fld-label' }, 'Name (optional)'), h('div', { class: 'field' }, label), err);
  const go = h('button', { class: 'btn accent', type: 'button', onclick: async () => {
    go.disabled = true; err.textContent = '';
    const body = { kind, host: host.value, port: port.value, user: user.value, label: label.value };
    if (kind !== 'sftp') body.password = pass.value;
    if (kind === 'cpanel' && token.value.trim()) { body.token = token.value.trim(); delete body.password; }
    if (kind === 'ftps') body.implicit = implicit.checked;
    try {
      const x = await api('/api/hosting/connect', body);
      pass.value = '';
      if (!x.ok) { err.textContent = x.error; go.disabled = false; return; }
      if (kind === 'sftp') return plSftpKeyDialog(x.connection, back);
      info('Connected: ' + x.connection.label + '.' + (x.passwordDropped ? ' Your password was used once and dropped.' : ''));
      plConnectionsDialog(back);
    } catch (e) { err.textContent = e.message; go.disabled = false; }
  } }, kind === 'sftp' ? 'Make the key' : 'Connect');
  dialog('Connect ' + PL_KIND[kind], kids, [go, h('button', { class: 'btn', type: 'button', onclick: () => plConnectionsDialog(back) }, 'Cancel')], 'wide');
  host.focus();
}

function plSftpKeyDialog(c, back) {
  const err = plErrBox();
  dialog('Add TOMLIN\'s key on the server', [
    h('p', null, 'Add this public key to ' + c.user + '@' + c.host + ' once. In cPanel: SSH Access, Manage SSH Keys, Import Key, paste it under Public Key, then Authorize it. Other hosts: their SSH keys page, or the account\'s ~/.ssh/authorized_keys.'),
    h('textarea', { class: 'prompt-text judge-text', readonly: true, 'aria-label': 'Public key' }, c.publicKey),
    h('div', { class: 'pl-acts' }, plCopyBtn(c.publicKey, 'Copy public key')),
    h('p', { class: 'muted pl-small' }, 'The first test remembers the server\'s own key; if it ever changes, TOMLIN stops and says so.'),
    err],
    [h('button', { class: 'btn accent', type: 'button', onclick: async e => {
      e.target.disabled = true; err.textContent = '';
      try { const x = await api('/api/hosting/test', { connection: c.id }); if (!x.ok) { err.textContent = x.error; e.target.disabled = false; return; } info('SFTP works. Server key: ' + x.connection.hostKey); plConnectionsDialog(back); }
      catch (er) { err.textContent = er.message; e.target.disabled = false; }
    } }, 'Test the connection'), h('button', { class: 'btn', type: 'button', onclick: () => plConnectionsDialog(back) }, 'Later')], 'wide');
}

// ---------- secrets ----------
async function plSecretsDialog(r) {
  let d;
  try { d = await api('/api/hosting/site?id=' + encodeURIComponent(r.id)); } catch (e) { return info(e.message, true); }
  const err = plErrBox();
  const list = h('div', { class: 'pl-secrets' });
  const row = x => {
    const name = h('input', { type: 'text', class: 'ps-name', value: x ? x.name : '', placeholder: 'NAME, like DB_PASS', 'aria-label': 'Name', spellcheck: 'false', autocomplete: 'off', readonly: !!x });
    const loc = h('input', { type: 'password', class: 'ps-local', autocomplete: 'new-password', placeholder: x && x.local ? 'saved: type to replace' : 'Local value (this PC)', 'aria-label': 'Local value' });
    const liv = h('input', { type: 'password', class: 'ps-live', autocomplete: 'new-password', placeholder: x && x.live ? 'saved: type to replace' : 'Live value (the site)', 'aria-label': 'Live value' });
    const gen = h('input', { type: 'checkbox', class: 'ps-gen' });
    const el = h('div', { class: 'ps-row' }, h('div', { class: 'field' }, name), h('div', { class: 'field' }, loc), h('div', { class: 'field' }, liv),
      h('label', { class: 'tick', title: 'TOMLIN makes a strong 32-character Live value; nobody needs to see it' }, gen, 'Make a strong Live value'),
      h('button', { class: 'btn', type: 'button', 'aria-label': 'Remove ' + (x ? x.name : 'this secret'), onclick: () => el.remove() }, 'Remove'));
    return el;
  };
  list.append(...d.secrets.map(row));
  if (!d.secrets.length) list.append(row(null));
  const code = "@include __DIR__ . '/tomlin-secrets.php';\n$pass = getenv('DB_PASS');";
  const save = h('button', { class: 'btn accent', type: 'button', onclick: async () => {
    const rows = [...list.querySelectorAll('.ps-row')].map(el => ({ name: el.querySelector('.ps-name').value.trim(), local: el.querySelector('.ps-local').value, live: el.querySelector('.ps-live').value, generateLive: el.querySelector('.ps-gen').checked }))
      .filter(x => x.name || x.local || x.live);
    if (rows.some(x => !x.name)) { err.textContent = 'Give every secret a name (capital letters, digits and _, like DB_PASS).'; return; }
    save.disabled = true; err.textContent = '';
    try {
      const x = await api('/api/hosting/secrets', { id: r.id, rows });
      for (const i of list.querySelectorAll('input[type=password]')) i.value = '';
      if (!x.ok) { err.textContent = x.error; save.disabled = false; return; }
      info('Saved ' + plural(x.secrets.length, 'secret', 'secrets') + '. Local values reach the local copy the next time it starts; Live values reach the site on the next push.');
      plOpen(r);
    } catch (e) { err.textContent = e.message; save.disabled = false; }
  } }, 'Save');
  dialog('Secrets: ' + r.name, [
    h('p', null, 'Passwords and API keys, each under a name. Your code reads them by name, so the same code works on this PC and live: '),
    h('pre', { class: 'pl-code' }, code), h('div', { class: 'pl-acts' }, plCopyBtn(code, 'Copy the PHP lines')),
    h('p', { class: 'muted pl-small' }, 'Local: given to the local copy the Bridge starts (Run), as environment variables. Live: written on each push to one file outside the site\'s web folder that only the hosting account can read; tomlin-secrets.php (no values in it) loads them. Values are locked by Windows for your account on this PC and never shown again here, never put in the project folder, a chat, a hire\'s prompt or a backup.'),
    list,
    h('button', { class: 'btn', type: 'button', onclick: () => { const x = row(null); list.append(x); x.querySelector('input').focus(); } }, 'Add secret'),
    err,
    h('p', { class: 'muted pl-small' }, 'Anyone who can sign in to the hosting account (or the hosting company) can read the Live file; anyone signed in to this Windows account can open TOMLIN (the app lock PIN covers the screen).')],
    [save, h('button', { class: 'btn', type: 'button', onclick: () => plOpen(r) }, 'Cancel')], 'wide');
}

// ---------- database (cPanel) ----------
async function plDbDialog(r) {
  let d;
  try { d = await api('/api/hosting/site?id=' + encodeURIComponent(r.id)); } catch (e) { return info(e.message, true); }
  const err = plErrBox();
  const s = d.site;
  const back = h('button', { class: 'btn', type: 'button', onclick: () => plOpen(r) }, 'Back');
  if (!s.db) {
    const name = h('input', { type: 'text', value: r.folder.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12) || 'site', 'aria-label': 'Database name', spellcheck: 'false' });
    const go = h('button', { class: 'btn accent', type: 'button', onclick: async () => {
      go.disabled = true; err.textContent = '';
      try { const x = await api('/api/hosting/db/setup', { id: r.id, name: name.value }); if (!x.ok) { err.textContent = x.error; go.disabled = false; return; } info(x.note); plDbDialog(r); }
      catch (e) { err.textContent = e.message; go.disabled = false; }
    } }, 'Make the database');
    return dialog('Database: ' + r.name, [
      h('p', null, 'TOMLIN makes a MySQL database and its user in your cPanel, with a generated password, and keeps the details as the Live secrets DB_HOST, DB_NAME, DB_USER and DB_PASS (written to the server straight away).'),
      h('label', { class: 'fld-label' }, 'Name (cPanel puts your account name and _ in front)'), h('div', { class: 'field' }, name), err], [go, back], 'wide');
  }
  const file = h('select', { class: 'sel', 'aria-label': '.sql file' }, ...(d.sqlFiles.length ? d.sqlFiles.map(f => h('option', { value: f }, f)) : [h('option', { value: '' }, 'No .sql file in ' + r.name)]));
  const load = h('button', { class: 'btn accent', type: 'button', onclick: async () => {
    if (!file.value) { err.textContent = 'Put a .sql file (a database export) in ' + r.name + ' first.'; return; }
    if (!confirm('Load ' + file.value + ' into the live database ' + s.db.name + '? Every statement in it runs there: a file that drops or empties tables drops or empties them.')) return;
    load.disabled = true; err.textContent = 'Loading…';
    try { const x = await api('/api/hosting/db/load', { id: r.id, file: file.value }); err.textContent = x.ok ? '' : x.error; if (x.ok) info(x.note); }
    catch (e) { err.textContent = e.message; }
    load.disabled = false;
  } }, 'Load into the live database');
  dialog('Database: ' + r.name, [
    h('p', null, 'Database ', h('b', null, s.db.name), ', user ', h('b', null, s.db.user), ', made ' + plWhen(s.db.at) + '. Its password is the Live secret DB_PASS.'),
    s.db.loaded ? h('p', { class: 'muted' }, 'Last loaded: ' + s.db.loaded.file + ', ' + plWhen(s.db.loaded.at) + ' (' + s.db.loaded.statements + ' statements).') : null,
    h('label', { class: 'fld-label' }, 'Load a .sql file (up to 64 MB) from the project'), h('div', { class: 'field' }, file),
    h('p', { class: 'muted pl-small' }, 'The file goes to the secrets folder outside the web folder, and a one-time page with a random name loads it over https with a one-time key, then deletes itself and the file. It needs the site\'s padlock (https) working.'),
    err,
    h('p', { class: 'muted pl-small' }, h('button', { class: 'linkbtn', type: 'button', onclick: async () => {
      if (!confirm('Forget TOMLIN\'s record of this database? The database itself and its DB_ secrets stay.')) return;
      try { const x = await api('/api/hosting/db/forget', { id: r.id }); info(x.note); plOpen(r); } catch (e) { info(e.message, true); }
    } }, 'Forget the record'))],
    [load, back], 'wide');
}
