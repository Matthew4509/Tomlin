// What this page does as part of TOMLIN: keeps TOMLIN's app lock open while it is used, and
// About › Bring in from Myia Bridge.
'use strict';

// ---- The app lock: it closes after its idle minutes. Using this page counts as using TOMLIN (at most one
// touch a minute); a closed lock sends the page to TOMLIN's PIN screen. ----
let touchedAt = 0;
function touchLock() {
  if (Date.now() - touchedAt < 60000) return;
  touchedAt = Date.now();
  fetch('/api/applock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'touch' }) })
    .then(toLock, () => {});
}
for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, touchLock, { passive: true });

// ---- About › Bring in from Myia Bridge ----
let importFound = [];
async function loadImport() {
  try { importFound = (await api('/api/import')).candidates || []; } catch { importFound = []; }
  $('import-note').textContent = 'Copies your working folders, prompts, private details, set-asides, live addresses and fault lists from a Myia Bridge folder on this PC. That Bridge is only read: nothing in it changes.'
    + (importFound.length ? ' Found: ' + importFound.join('; ') + '.' : '');
}
$('btn-import').addEventListener('click', () => {
  folderDialog({
    title: 'Bring in from Myia Bridge',
    lead: 'Choose the Myia Bridge folder (the one with start-bridge.cmd in it). Its working folders, prompts, private details, "Not a fault" set-asides, live addresses, audits and fault lists replace the ones here. What is here now is put aside first, in a before-import folder in the Bridge\'s data, never deleted. Nothing in that Myia Bridge changes, and it keeps working on its own.',
    purpose: 'bridge',
    okLabel: 'Bring in',
    submit: async folder => {
      const r = await api('/api/import', { folder });
      if (!r.ok) return r;
      closeDialog();
      info('Brought in from ' + r.from + ': ' + r.brought.join(', ') + '. ' + r.folders + ' working folder' + (r.folders === 1 ? '' : 's') + ', ' + r.projects + ' project' + (r.projects === 1 ? '' : 's') + '. What was here before is in ' + r.aside + '.');
      await load(true);
      loadImport();
    },
  });
  const input = $('dlg-body').querySelector('input');
  if (input && importFound.length) input.value = importFound[0];
});

// ---- Start with a hire: the words go to TOMLIN's own page, in its Send to card (pick who, change anything,
// send). Kept in this browser's session for that one page, never sent anywhere by this. Copy stays for any other AI. ----
const inTomlin = () => !!(stats && stats.inTomlin);
function startWithHire(text, label) {
  if (!inTomlin()) return copyText(text, 'This copy is not inside TOMLIN, so it was copied instead: paste it into the AI you use.');
  try { sessionStorage.setItem('sm-start', JSON.stringify({ text, label, at: Date.now() })); }
  catch { return copyText(text, 'The browser keeps nothing for the next page here, so it was copied instead: paste it into a chat in TOMLIN.'); }
  location.href = '/?start=1';
}
const startBtn = (text, label, small) => h('button', { class: 'btn', type: 'button', title: 'Opens TOMLIN\'s Send to card with these words: pick one of your staff, change anything, and send', onclick: () => startWithHire(typeof text === 'function' ? text() : text, label) }, icon(0xE768), small ? 'Start' : 'Start with a hire');
