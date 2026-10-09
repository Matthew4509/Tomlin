// Project actions and the command bar buttons.
'use strict';

// ---- project actions ----
async function load(fresh) {
  try {
    const d = await api('/api/projects' + (fresh === true ? '?fresh=1' : ''));
    rows = d.projects; stats = d.stats; loaded = true; liveRevSeen = stats.liveRev; rowsRevSeen = stats.rowsRev;
    renderList(); renderStatus(); announceDown();
    if (!$('page-audits').hidden) renderAudits();
    if (stats.tokensBusy) setTimeout(load, 4000);
  } catch (e) { info(e.message, true); }
}
// Recount: the button says "Counting…" from the click until the new count is in (up to half a minute on the server),
// then a message gives the new total.
let recounting = false;
async function recount() {
  if (recounting) return;
  const before = stats && stats.tokensAt, started = Date.now();
  recounting = true; renderPC();
  try {
    await api('/api/refresh-tokens', {});
    for (let i = 0; i < 90; i++) {
      await new Promise(r => setTimeout(r, 1000));
      await load();
      if (stats && !stats.tokensBusy && (stats.tokensAt !== before || stats.tokensError) && Date.now() - started > 900) break;
    }
    if (stats && stats.tokensError) info('Token count failed: ' + stats.tokensError, true);
    else info('Tokens counted again: ' + fmtTok(rows.reduce((t, r) => t + r.tokens, 0)) + ' on disk, ' + fmtTok(rows.reduce((t, r) => t + r.tokensMonth, 0)) + ' this month.');
  } catch (e) { info(e.message, true); }
  recounting = false; renderPC();
}
async function act(what, r) {
  try {
    const d = await api('/api/' + what, { id: r.id });
    if (d.ok === false) info(d.error, true);
    else if (d.dryRun) info('Dry run: ' + d.dryRun);
    else if (what === 'open-browser') info('Opened ' + d.url + ' in your browser.');
  } catch (e) { info(e.message, true); }
}
async function stop(r) { try { await api('/api/stop', { id: r.id }); info(r.name + ' stopped.'); await load(); } catch (e) { info(e.message, true); } }

// §24: Start = "Scan app / Skip".
function askStart(r, c) {
  dialog('Start ' + r.name + '?', [
    h('p', null, 'Runs "' + c.name + '" from ' + c.from + ' on localhost:' + c.port + ', then opens your browser.'),
    h('p', { class: 'muted' }, 'Scan app also runs the built-in audit (code rules and a few requests to localhost' + (r.liveUrl ? ', then the live site compared with it, one page every 5 seconds' : '') + ') and shows what failed.')],
    [h('button', { class: 'btn accent', type: 'button', onclick: () => start(r, c, true) }, 'Scan app'),
     h('button', { class: 'btn', type: 'button', onclick: () => start(r, c, false) }, 'Skip'), cancelBtn()]);
}
async function start(r, c, scanToo) {
  dialog('Starting ' + r.name + '…', [h('p', { class: 'muted' }, (c.ports ? 'Starting on the first free port of ' + c.ports.join(', ') + ' and waiting for it to answer' : 'Waiting for localhost:' + c.port + ' to answer') + (scanToo ? ', then scanning. This can take a minute on a big project.' : '.'))], []);
  try {
    const d = await api('/api/start', { id: r.id, key: c.key, scan: scanToo });
    if (!d.ok) {
      dialog(r.name + ' did not start', [h('p', null, d.error)], [
        d.portInUse ? h('button', { class: 'btn', type: 'button', onclick: () => { closeDialog(); act('open-browser', r); } }, 'Open localhost:' + d.portInUse) : null,
        h('button', { class: 'btn accent', type: 'button', onclick: closeDialog }, 'Close')].filter(Boolean));
    } else if (d.audit) {
      showAudit(r, d.audit, (d.already ? 'Already running at ' : 'Started at ') + d.url + (d.dryRun ? ' (dry run: browser not opened).' : ' and opened in your browser.'));
    } else {
      closeDialog();
      info(r.name + (d.already ? ' is already running at ' : ' is running at ') + d.url + (d.dryRun ? ' (dry run)' : '') + (d.note ? '. ' + d.note : ''));
    }
  } catch (e) { dialog('Could not start ' + r.name, [h('p', null, e.message)], [h('button', { class: 'btn accent', type: 'button', onclick: closeDialog }, 'Close')]); }
  load();
}
function scanParts(r) { return ['code', (r.running || r.portInUse) && 'localhost', r.liveUrl && 'live site'].filter(Boolean).join(' + ') + (r.running || r.portInUse || r.liveUrl ? '' : ' only'); }
async function scan(r) {
  const localToo = r.running || r.portInUse;
  dialog('Scanning ' + r.name + '…', [h('p', { class: 'muted' }, 'Checking the code' + (localToo ? ' and the running copy on localhost' : '') +
    (r.liveUrl ? ', then comparing the live site (' + hostOf(r.liveUrl) + ') with ' + (localToo ? 'it' : 'the project\'s files') + '. The live site is asked one page every 5 seconds, so its firewall does not take this for an attack: about a minute.' : '.'))], []);
  try { const d = await api('/api/audit', { id: r.id }); showAudit(r, d.audit); }
  catch (e) { dialog('Scan failed', [h('p', null, e.message)], [h('button', { class: 'btn accent', type: 'button', onclick: closeDialog }, 'Close')]); }
  load();
}
async function showLastAudit(r) {
  try { const d = await api('/api/audit?id=' + encodeURIComponent(r.id)); if (d.audit) showAudit(r, d.audit); else info('No audit saved for ' + r.name + ' yet.'); }
  catch (e) { info(e.message, true); }
}
const SEV = { Critical: { mark: '◆ Critical', cls: 'a-bad' }, High: { mark: '▲ High', cls: 'a-bad' }, Medium: { mark: '■ Medium', cls: 'a-warn' }, Low: { mark: '○ Low', cls: 'a-low' }, Info: { mark: '· Info', cls: 'a-low' } };
const minor = f => f.sev === 'Low' || f.sev === 'Info';
function faultsText(r, a) {
  // Findings can carry text pulled from a live site (titles, evidence). Flatten every field to one line so the
  // copied list, pasted into an AI, cannot smuggle in lines that look like separate instructions.
  // The folder's name only: the full path names this PC's user (C:\Users\<name>\...), and this text is for pasting.
  return 'Audit of ' + oneLine(r.name) + ' (folder ' + oneLine(r.folder) + '), ' + a.ranAt + '\n' + a.findings.map(f => '- [' + f.sev + '] ' + f.rule + ' ' + oneLine(f.title) + ' - ' + oneLine(f.where) + (f.also && f.also.length ? ' (also: ' + oneLine(f.also.join('; ')) + ')' : '') + (f.knownAs ? ' - already known as ' + oneLine(f.knownAs) : '') + (f.evidence ? ' - seen: ' + oneLine(f.evidence) : '') + ' - fix: ' + oneLine(f.fix)).join('\n');
}
function showAudit(r, a, lead) {
  const c = a.counts;
  const head = c.Critical || c.High ? 'Fix the Critical and High faults before this goes live.' : c.Medium ? 'No Critical or High faults. Medium ones are warnings.' : (c.Low || c.Info) ? 'Passed: only low-priority findings (below).' : 'Passed every rule that ran.';
  const liveNote = a.url ? (a.liveReached ? 'Checked ' + a.url + ' as well as the code.' : a.url + ' did not answer, so it was not checked.') : 'The local copy was not running, so localhost was not checked.';
  const cmp = a.compare;
  const cmpNote = cmp ? (cmp.stopped && !cmp.pages.length ? 'Live site ' + hostOf(cmp.liveUrl) + ': not compared. ' + cmp.stopped
    : 'Live site ' + hostOf(cmp.liveUrl) + ': ' + cmp.pages.length + ' page' + (cmp.pages.length === 1 ? '' : 's') + ' (' + cmp.pages.map(p => p.path).join(', ') + ') compared with ' + (cmp.localUrl ? 'the local copy' : 'the project\'s files (the local copy was not running)') + '; ' + cmp.requests + ' request' + (cmp.requests === 1 ? '' : 's') + ', ' + cmp.gapSeconds + ' s apart.' + (cmp.stopped ? ' Stopped early: ' + cmp.stopped : '')) : null;
  const major = a.findings.filter(f => !minor(f)), low = a.findings.filter(minor);
  const shown = major.slice(0, 60), lowShown = low.slice(0, 60);
  const notes = a.notes || [];
  const setAside = a.setAside || a.accepted || []; // `accepted`: an audit saved before the judged list
  const records = a.records || {};
  const recText = rec => 'set aside as not a fault in ' + rec.false + ' place' + (rec.false === 1 ? '' : 's') + ' (' + rec.files + ' file' + (rec.files === 1 ? '' : 's') + ') across your projects, still flagged in ' + rec.standing;
  const item = f => h('div', { class: 'check' }, h('span', { class: 'sev ' + (SEV[f.sev] || SEV.Medium).cls }, (SEV[f.sev] || SEV.Medium).mark),
    h('span', { class: 'what' }, f.title + ' (' + f.area + ')', f.knownAs ? h('b', null, ' · already known as ' + f.knownAs) : null,
      f.check && records[f.rule] ? h('b', null, ' · check this one: the rule was ' + recText(records[f.rule])) : null,
      h('span', { class: 'where' }, f.where + (f.also && f.also.length ? ' (also ' + f.also.length + ' other place' + (f.also.length > 1 ? 's' : '') + ': ' + f.also.slice(0, 3).join('; ') + (f.also.length > 3 ? '…' : '') + ')' : '') + ' · ' + f.rule + (f.evidence ? ' · seen: ' + f.evidence : '') + ' · ' + f.fix),
      h('button', { class: 'linkbtn', type: 'button', onclick: () => judgeDialog(r, a, f) }, 'Not a fault…')));
  const recRows = Object.entries(records).sort((x, y) => y[1].false - x[1].false);
  dialog('Audit: ' + r.name, [
    lead ? h('p', null, lead) : null,
    h('p', { class: 'muted' }, head + ' ' + a.rules + ' rules over ' + a.filesScanned + ' files in ' + a.seconds + ' s. ' + liveNote + (a.filesTruncated ? ' Stopped at the file limit; big folders are only partly checked.' : '')),
    cmpNote ? h('p', { class: 'muted' }, cmpNote) : null,
    ...shown.map(item),
    major.length > shown.length ? h('p', { class: 'muted' }, '…and ' + (major.length - shown.length) + ' more. Copy faults to see them all.') : null,
    low.length ? h('details', { class: 'notes' }, h('summary', null, low.length + ' low-priority finding' + (low.length === 1 ? '' : 's') + ' (Low and Info: true, but they rarely harm anyone; fix them when you are in the file)'),
      ...lowShown.map(item), low.length > lowShown.length ? h('p', { class: 'muted' }, '…and ' + (low.length - lowShown.length) + ' more. Copy faults to see them all.') : null) : null,
    recRows.length ? h('details', { class: 'notes' }, h('summary', null, 'Rule record: how often people judged these rules wrong'),
      h('ul', null, ...recRows.map(([rule, rec]) => h('li', null, rule + ': ' + recText(rec) + (rec.check ? ' — marked "check this one" (wrong in ' + rec.files + '+ files, more often than it stands)' : ''))))) : null,
    !major.length ? h('div', { class: 'check' }, h('span', { class: 'sev a-ok' }, '✓ Passed'), h('span', { class: 'what' }, 'Secrets, injection, auth, CSRF, uploads, exposed files, trackers' + (a.disclosure ? ', private details' : '') + (a.url || cmp ? ', headers' : '') + (cmp && !cmp.stopped ? ', live vs local' : ''))) : null,
    notes.length ? h('details', { class: 'notes' }, h('summary', null, notes.length + ' note' + (notes.length === 1 ? '' : 's') + ' (checked, not counted)'), h('ul', null, ...notes.slice(0, 30).map(n => h('li', null, n)))) : null,
    setAside.length ? h('details', { class: 'notes' }, h('summary', null, setAside.length + ' set aside: judged not a fault by a person (an edited line comes back)'),
      h('ul', null, ...setAside.map(f => h('li', null, f.rule + ' · ' + f.where + ' — ' + (f.judged ? f.judged.why + ' (' + f.judged.by + (f.judged.on ? ', ' + f.judged.on : '') + ')' : 'set aside in projects.json') + ' ',
        f.judged && f.judged.id ? h('button', { class: 'linkbtn', type: 'button', onclick: () => unjudge(r, f.judged.id) }, 'Bring back') : null)))) : null,
    h('p', { class: 'muted', style: 'margin-top:12px' }, 'This is a simple built-in check. It catches common core faults, not everything.')],
    [a.findings.length ? h('button', { class: 'btn', type: 'button', onclick: async () => {
        try { await navigator.clipboard.writeText(faultsText(r, a)); info('Faults copied. Paste them into the AI you use.'); }
        catch { info('Could not copy: the clipboard was blocked.', true); }
      } }, 'Copy faults') : null,
     a.findings.length && inTomlin() ? h('button', { class: 'btn', type: 'button', title: 'Opens the Send to card in TOMLIN with these faults: pick one of your staff (a coder), change anything, and send', onclick: () => startWithHire(faultsText(r, a), 'the faults found in ' + r.name) }, icon(0xE768), 'Fix with a hire') : null,
     h('button', { class: 'btn', type: 'button', onclick: () => reviewDialog(r, a) }, 'Review with AI…'),
     h('button', { class: 'btn', type: 'button', onclick: () => importDialog(r, a) }, 'Import report-back…'),
     h('button', { class: 'btn accent', type: 'button', onclick: closeDialog }, 'Close')].filter(Boolean));
}

// ---- Review with AI: a prompt to copy into any AI (the Bridge opens none), and the faults it reported ----
const FAULT_STATE = { open: 'Open', fixed: 'Fixed', false: 'Not a fault' };
// have: { prompt, faults } already built (after a status change only the list is new; the prompt is kept)
async function reviewDialog(r, a, lead, have) {
  let d = have;
  if (!d) {
    dialog('Review with AI: ' + r.name, [h('p', { class: 'muted' }, 'Building the prompt from the project\'s files and the last audit…')], []);
    try { d = await api('/api/review?id=' + encodeURIComponent(r.id)); } catch (e) { return info(e.message, true); }
    if (d.ok === false) return info(d.error, true);
  }
  const text = h('textarea', { class: 'prompt-text', rows: 12, readonly: 'readonly', 'aria-label': 'Review prompt' });
  text.value = d.prompt;
  const faults = d.faults || [];
  const open = faults.filter(f => f.status === 'open');
  const row = f => h('div', { class: 'check' },
    h('span', { class: 'sev ' + (f.status !== 'open' ? 'a-ok' : f.sev === 'Low' ? 'a-warn' : SEV[f.sev] ? SEV[f.sev].cls : 'a-warn') }, f.status === 'open' ? (SEV[f.sev] ? SEV[f.sev].mark : '● ' + f.sev) : (f.status === 'fixed' ? '✓ Fixed' : '✕ Not a fault')),
    h('span', { class: 'what' }, f.evidence + (f.category ? ' (checklist ' + f.category + ')' : ''),
      h('span', { class: 'where' }, f.where + ' · ' + (f.ref || f.id) + ' · ' + f.fix + ' · from ' + f.by + ', ' + f.on + (f.changed ? ' · ' + FAULT_STATE[f.status] + ' by ' + f.changed.by + ', ' + f.changed.on + (f.changed.why ? ': ' + f.changed.why : '') : '')),
      ...['open', 'fixed', 'false'].filter(s => s !== f.status).flatMap((s, n) => [n ? h('span', { class: 'muted' }, ' · ') : null,
        h('button', { class: 'linkbtn', type: 'button', onclick: () => faultStatus(r, a, f, s, d) }, s === 'open' ? 'Open again' : s === 'fixed' ? 'Mark fixed' : 'Not a fault…')])));
  dialog('Review with AI: ' + r.name, [
    lead ? h('p', null, lead) : null,
    h('p', { class: 'muted' }, 'Rules find patterns; a reviewer finds judgement faults (money, access, promises, data). Copy this prompt into the AI you use. It names the files to read first, the checklist, what the scanner already found and what was set aside, and asks for two tables back. Paste the answer with Import report-back…: its Findings go on the list below, its False flags set scanner findings aside. Nothing is sent from here.'),
    text,
    h('h3', null, faults.length ? 'Faults from reviews: ' + open.length + ' open of ' + faults.length : 'No faults from a review yet'),
    ...faults.slice().sort((x, y) => (x.status === 'open' ? 0 : 1) - (y.status === 'open' ? 0 : 1)).map(row)],
    [h('button', { class: 'btn accent', type: 'button', onclick: async () => {
        try { await navigator.clipboard.writeText(d.prompt); info('Review prompt copied. Paste it into the AI you use.'); }
        catch { info('Could not copy: the clipboard was blocked. Select the text and copy it.', true); }
      } }, 'Copy prompt'),
     inTomlin() ? startBtn(d.prompt, 'the review of ' + r.name) : null,
     h('button', { class: 'btn', type: 'button', onclick: () => importDialog(r, a) }, 'Import report-back…'),
     a ? h('button', { class: 'btn', type: 'button', onclick: () => showAudit(r, a) }, 'Back to the audit') : cancelBtn('Close')], 'wide');
}
function faultStatus(r, a, f, status, had) {
  const send = async (why, by) => {
    try {
      const d = await api('/api/faults/set', { id: r.id, fault: f.id, status, why, by });
      if (d.ok === false) return info(d.error, true);
      reviewDialog(r, a, (f.ref || f.id) + ' is now ' + FAULT_STATE[status].toLowerCase() + '.', { prompt: had.prompt, faults: d.faults });
    } catch (e) { info(e.message, true); }
  };
  if (status !== 'false') return send('', pref.get('judgedBy', ''));
  const why = textBox('Why it is not a fault', 4), by = byBox();
  const err = h('div', { class: 'err', role: 'alert' });
  dialog('Not a fault: ' + (f.ref || f.id), [h('p', null, f.evidence), h('p', { class: 'muted' }, f.where),
    h('label', { class: 'muted' }, 'Why it is not a fault'), why, h('label', { class: 'muted' }, 'Checked by'), h('div', { class: 'field' }, by), err],
    [h('button', { class: 'btn accent', type: 'button', onclick: () => {
        if (why.value.trim().length < 3) { err.textContent = 'Say why it is not a fault: the reason is kept with it.'; return why.focus(); }
        pref.set('judgedBy', by.value.trim()); send(why.value, by.value);
      } }, 'Save'), h('button', { class: 'btn', type: 'button', onclick: () => reviewDialog(r, a, null, had) }, 'Back')]);
  why.focus();
}

// ---- judging: "not a fault" for one place, with a reason and who says so; Bring back undoes it ----
const textBox = (label, rows) => h('textarea', { class: 'prompt-text judge-text', rows, 'aria-label': label, spellcheck: 'true' });
const byBox = () => h('input', { type: 'text', 'aria-label': 'Checked by', placeholder: 'you', maxlength: '60', value: pref.get('judgedBy', '') });
function judgeDialog(r, a, f) {
  const why = textBox('Why it is not a fault', 4), by = byBox();
  const err = h('div', { class: 'err', role: 'alert' });
  const back = () => showAudit(r, a);
  const ok = h('button', { class: 'btn accent', type: 'button', onclick: async () => {
    if (why.value.trim().length < 3) { err.textContent = 'Say why it is not a fault: the reason is kept with it, so whoever reads the list later knows.'; return why.focus(); }
    ok.disabled = true; err.textContent = '';
    try {
      pref.set('judgedBy', by.value.trim());
      const d = await api('/api/audit/judge', { id: r.id, rule: f.rule, where: f.where, fp: f.fp || null, why: why.value, by: by.value });
      if (d.ok === false) { err.textContent = d.error; ok.disabled = false; return; }
      showAudit(r, d.audit, f.rule + ' at ' + f.where + ' is set aside. It comes back if that line changes.');
    } catch (e) { err.textContent = e.message; ok.disabled = false; }
  } }, 'Set aside');
  dialog('Not a fault: ' + f.rule, [
    h('p', null, f.title), h('p', { class: 'muted' }, f.where),
    h('p', { class: 'muted' }, 'Only this place is set aside, and only while its line stays the same. The rule keeps checking everywhere else.'),
    h('label', { class: 'muted' }, 'Why it is not a fault'), why,
    h('label', { class: 'muted' }, 'Checked by'), h('div', { class: 'field' }, by), err],
    [ok, h('button', { class: 'btn', type: 'button', onclick: back }, 'Back to the audit')]);
  why.focus();
}
async function unjudge(r, entry) {
  try {
    const d = await api('/api/audit/unjudge', { id: r.id, entry });
    if (d.ok === false) return info(d.error, true);
    showAudit(r, d.audit, 'Brought back: it counts again.');
  } catch (e) { info(e.message, true); }
}
// A report-back's "False flags" table (| Rule | Where | Verdict | Why | What the rule should do |), pasted or opened.
function importDialog(r, a) {
  const text = textBox('Report-back table', 10), by = byBox();
  let source = '';
  const err = h('div', { class: 'err', role: 'alert' });
  const pick = h('input', { type: 'file', accept: '.md,.txt,text/markdown,text/plain', 'aria-label': 'Open a report-back file', onchange: () => {
    const file = pick.files[0];
    if (!file) return;
    if (file.size > 190000) { err.textContent = file.name + ' is too big to import (over 190 KB). Paste only its "False flags" table.'; return; }
    const rd = new FileReader();
    rd.onload = () => { text.value = String(rd.result); source = file.name; };
    rd.readAsText(file);
  } });
  const ok = h('button', { class: 'btn accent', type: 'button', onclick: async () => {
    if (!text.value.trim()) { err.textContent = 'Paste the table, or open the report-back file.'; return text.focus(); }
    ok.disabled = true; err.textContent = '';
    try {
      pref.set('judgedBy', by.value.trim());
      const d = await api('/api/audit/import', { id: r.id, text: text.value, by: by.value, source });
      if (d.ok === false) { err.textContent = d.error; ok.disabled = false; return; }
      const good = d.results.filter(x => x.ok).length, bad = d.results.filter(x => !x.ok);
      const after = d.audit || a;
      const fr = d.findings || { added: 0, again: 0, refused: [] };
      dialog('Report-back imported', [
        d.results.length ? h('p', null, 'False flags: ' + good + ' of ' + d.results.length + ' row' + (d.results.length > 1 ? 's' : '') + ' judged.' + (bad.length ? ' Not imported:' : '')) : null,
        bad.length ? h('ul', { class: 'notes' }, ...bad.map(x => h('li', null, x.rule + ' · ' + x.where + ': ' + x.error))) : null,
        fr.added || fr.again || fr.refused.length ? h('p', null, 'Findings: ' + fr.added + ' new on the fault list' + (fr.again ? ', ' + fr.again + ' already there (kept their status)' : '') + '.' + (fr.refused.length ? ' Not imported:' : '')) : null,
        fr.refused.length ? h('ul', { class: 'notes' }, ...fr.refused.map(x => h('li', null, (x.id || '(no id)') + ': ' + x.error))) : null],
        [fr.added || fr.again ? h('button', { class: 'btn accent', type: 'button', onclick: () => reviewDialog(r, after) }, 'See the fault list') : null,
         after ? h('button', { class: (fr.added || fr.again ? 'btn' : 'btn accent'), type: 'button', onclick: () => showAudit(r, after) }, 'Back to the audit') : cancelBtn('Close')].filter(Boolean));
    } catch (e) { err.textContent = e.message; ok.disabled = false; }
  } }, 'Import');
  dialog('Import a report-back', [
    h('p', { class: 'muted' }, 'Paste what an AI or a project thread wrote back, or open the file. Its "Findings" table (Id | Severity | Category | Where | Evidence | Fix) goes on the project\'s fault list; every finding must name a place as file:line. Its "False flags" table (Rule | Where | Verdict | Why | What the rule should do) sets scanner findings aside one place at a time: "false" sets it aside, "duplicate of <id>" tags it with that id, anything else is left alone.'),
    text, h('div', { class: 'field' }, pick),
    h('label', { class: 'muted' }, 'Checked by'), h('div', { class: 'field' }, by), err],
    [ok, h('button', { class: 'btn', type: 'button', onclick: () => showAudit(r, a) }, 'Back to the audit')], 'wide');
}

for (const id of ['cmd-add-project', 'cmd-add-project-2']) $(id).addEventListener('click', () => addProjectDialog());
for (const id of ['cmd-scan', 'cmd-scan-2']) $(id).addEventListener('click', scanNow);
$('cmd-add-folder').addEventListener('click', () => addFolderDialog());
$('cmd-refresh').addEventListener('click', () => load(true));
$('search').addEventListener('input', renderList);
$('sort').value = pref.get('sort', 'updated');
$('sort').addEventListener('change', () => { pref.set('sort', $('sort').value); renderList(); });
$('view-list').addEventListener('click', () => setView('list'));
$('view-tiles').addEventListener('click', () => setView('tiles'));
$('cmd-hidden').addEventListener('click', toggleHidden);
$('cmd-stopall').addEventListener('click', stopAllDialog);
