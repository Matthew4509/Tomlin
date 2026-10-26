// The app lock (src/applock.ts): the padlock in the top bar, the "Create a new pin" window, the full-page lock screen,
// and the App lock part of the bell window. The server refuses everything while locked; this page only shows it.
// A1: the lock is a PIN (a number pad) or a password (a text box), chosen by the person. A2: 10 recovery codes, shown
// once, each of which sets a new PIN or password once from the lock screen.
'use strict';

const appLockUi = { view: null, booted: false, lastTouch: 0 };
const lockWord = kind => (kind === 'password' ? 'password' : 'PIN');

/** A box for the lock's PIN (digits; a number pad on a touch screen) or password (anything, any length). */
function fitSecret(input, kind) {
  if (kind === 'password') {
    input.removeAttribute('pattern');
    input.removeAttribute('inputmode');
    input.maxLength = 256;
  } else {
    input.setAttribute('pattern', '[0-9 ]*');
    input.setAttribute('inputmode', 'numeric');
    input.maxLength = 16;
  }
}
app.lockKind = () => appLockUi.view?.kind ?? 'pin';
app.fitSecret = fitSecret;

/** The [ PIN | Password ] switch: `box` holds two role=radio buttons; `pick` is told the kind on each change. */
function kindSwitch(box, kind, pick) {
  const set = k => {
    for (const b of box.querySelectorAll('[data-kind]')) b.setAttribute('aria-checked', String(b.dataset.kind === k));
    pick(k);
  };
  for (const b of box.querySelectorAll('[data-kind]')) b.onclick = () => set(b.dataset.kind);
  set(kind);
  return () => box.querySelector('[aria-checked="true"]')?.dataset.kind ?? 'pin';
}

/** The strength line under a new password (weak / OK / strong, src/lock.ts strength): it refuses nothing. */
function strengthLine(input, line, kindNow) {
  let n = 0;
  const draw = async () => {
    const mine = ++n;
    if (kindNow() !== 'password' || !input.value) {
      line.hidden = true;
      return;
    }
    const r = await api('/api/applock', { action: 'strength', pin: input.value }).catch(() => null);
    if (mine !== n || !r?.strength) return;
    line.textContent = `Strength: ${r.strength}${r.strength === 'weak' ? ' (still allowed; a longer one is harder to guess)' : ''}`;
    line.dataset.strength = r.strength;
    line.hidden = false;
  };
  input.addEventListener('input', draw);
  return draw;
}

/** Generate: 4 plain words in both boxes, shown on the line beside it so they can be written down. */
async function generateInto(a, b, said, draw) {
  const r = await api('/api/applock', { action: 'generate' }).catch(err => ({ error: err.message }));
  if (!r.words) return void (said.textContent = r.error ?? '');
  a.value = b.value = r.words;
  said.textContent = `Your password: ${r.words}. Write it down before you go on.`;
  draw();
}

/** The lock screen over everything (every other part of the page is hidden, open windows are closed). */
function showAppLock(view) {
  app.lockShown = true;
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  document.body.classList.add('app-locked');
  $('#applock').hidden = false;
  const wait = view?.waitMinutes ?? 0;
  $('#applock-about').hidden = !wait;
  $('#applock-about').textContent = wait ? `Too many wrong tries. Wait ${wait} minute${wait > 1 ? 's' : ''}, then try again.` : '';
  const kind = view?.kind ?? 'pin';
  const box = $('#applock-open-pin');
  fitSecret(box, kind);
  box.placeholder = kind === 'password' ? 'Password' : 'PIN';
  box.setAttribute('aria-label', kind === 'password' ? 'Password' : 'PIN');
  drawPad(kind);
  $('#applock-recover-open').hidden = !view?.codes?.left;
  drawLockNode(view);
  box.focus();
}

/** A PIN lock shows a number pad under its box (a password lock, a text box only). Each key types into the box. */
function drawPad(kind) {
  const pad = $('#applock-pad');
  pad.hidden = kind !== 'pin';
  if (pad.hidden || pad.childElementCount) return;
  const box = $('#applock-open-pin');
  const key = (text, label, press) => el('button', { class: 'btn', type: 'button', text, 'aria-label': label, onclick: () => {
    press();
    box.focus();
  } });
  for (const d of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) pad.append(key(d, d, () => (box.value += d)));
  pad.append(key('⌫', 'Delete the last digit', () => (box.value = box.value.slice(0, -1))), key('0', '0', () => (box.value += '0')), key('Clear', 'Clear', () => (box.value = '')));
}

const clock = iso => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/**
 * On a node, the lock screen carries "Send host": whoever sits at this PC asks the main PC to log out for 1, 2 or 4
 * hours, no PIN needed. The main PC decides (it may be running work there); nothing stops here until it says yes.
 */
function drawLockNode(view) {
  const n = view?.node;
  $('#applock-node').hidden = !n?.on;
  drawUpdating(n);
  if (!n?.on) return;
  const a = n.ask;
  $('#applock-ask-row').hidden = !!n.away;
  $('#applock-node-line').textContent = n.away && n.until
    ? `Logged out until ${clock(n.until)}${a?.answer === 'yes' && a.by ? ` ("${a.by}" said yes)` : ''}. The PC is yours until then; TOMLIN starts again by itself.`
    : n.away ? `Logged out since ${clock(n.away)}. The main PC can start it again.`
    : a && !a.answer ? `Sent at ${clock(a.at)}: waiting for the host to answer.`
    : a?.answer === 'no' ? `The host said not now (${clock(a.answeredAt)}).`
    : '';
}

/** "Keep this window open": an update coming in from the main PC, on the lock screen or (unlocked) at the foot of the page. */
function drawUpdating(n) {
  const u = n?.updating;
  const text = !u ? '' : u.starting ? `Starting TOMLIN ${u.version}. Keep this window open.` : `"${u.from}" is updating TOMLIN here to ${u.version}. Keep this window open: it starts again by itself.`;
  for (const p of [$('#applock-update'), $('#node-updating')]) {
    p.textContent = text;
    p.hidden = !text;
  }
  if (app.lockShown) $('#node-updating').hidden = true;
}

$('#applock-ask').addEventListener('click', async () => {
  const btn = $('#applock-ask');
  btn.disabled = true;
  $('#applock-fault').hidden = true;
  try {
    appLockUi.view = await api('/api/applock', { action: 'ask', hours: Number($('#applock-hours').value) });
    drawLockNode(appLockUi.view);
  } catch (err) {
    $('#applock-fault').textContent = err.message;
    $('#applock-fault').hidden = false;
  }
  btn.disabled = false;
});

/**
 * A node's screen reads its state every 4 seconds: the host's answer, the end of the hours asked for, an update coming
 * in. While the update restarts TOMLIN it does not answer; once it answers with a new version (or the same version with
 * other files: its build id changed) the page loads again. A build id not read yet ('' just after start) is not a change.
 */
let lockSeen = null;
setInterval(async () => {
  const was = appLockUi.view;
  if (!was?.node?.on) return;
  try {
    const v = await api('/api/applock');
    const said = v.node?.version ? { version: v.node.version, build: v.node.build || '' } : null;
    lockSeen ??= said;
    if (said && lockSeen && (said.version !== lockSeen.version || (said.build && lockSeen.build && said.build !== lockSeen.build))) return location.reload();
    if (said?.build && lockSeen && !lockSeen.build) lockSeen = said;
    appLockUi.view = { ...was, ...v };
    if (app.lockShown) drawLockNode(v);
    else drawUpdating(v.node);
  } catch {
    if (was.node.updating) drawUpdating({ ...was.node, updating: { ...was.node.updating, starting: true } });
  }
}, 4000);

// While this PC works for a linked PC, the top bar says for whom: never the words or the picture (F7 E2).
app.onStatus.push(s => {
  const chip = $('#serving-chip');
  const list = s.serving ?? [];
  chip.hidden = !list.length;
  chip.textContent = list.length > 1 ? `${list[0]} (+${list.length - 1})` : list[0] ?? '';
});

/** A call was refused as locked. A page that was open has chats on it: it starts again, so they leave the page too. */
app.appLocked = () => {
  // The first lock's codes are on screen (the lock shut at once): they stay until one is typed back.
  if (app.lockShown || appLockUi.showingCodes) return;
  if (appLockUi.booted && appLockUi.view?.open) {
    app.keepDraft?.();
    location.reload();
  }
  else showAppLock(appLockUi.view);
};

function drawPadlock() {
  const v = appLockUi.view;
  const btn = $('#applock-btn');
  btn.hidden = !v;
  if (!v) return;
  // On: a shut padlock that locks at once. Off: an open one that offers to set a PIN.
  $('#applock-shackle').setAttribute('d', v.on ? 'M8 11V7a4 4 0 0 1 8 0v4' : 'M8 11V7a4 4 0 0 1 7.5-2');
  btn.title = v.on ? 'Lock TOMLIN now (the PIN opens it again)' : 'App lock: set a PIN for the whole app';
  btn.setAttribute('aria-label', v.on ? 'Lock now' : 'App lock: set a PIN');
}

async function appLockBoot() {
  try {
    appLockUi.view = await api('/api/applock');
  } catch {
    return; // not answering: app.js already says so in the top bar
  }
  if (appLockUi.view.on && !appLockUi.view.open) return showAppLock(appLockUi.view);
  appLockUi.booted = true;
  drawPadlock();
}

$('#applock-btn').addEventListener('click', async () => {
  if (!appLockUi.view?.on) return openAppLockNew();
  app.keepDraft?.();
  try {
    await api('/api/applock', { action: 'lock' });
  } finally {
    location.reload();
  }
});

// ---- His window: Create a new pin, Confirm pin, the tick, the warning, Save pin and lock ----

const appNew = $('#applock-new');
function appNewFault(text) {
  $('#applock-new-fault').textContent = text;
  $('#applock-new-fault').hidden = !text;
}
/** The new-PIN window's auto-lock minutes: the choices Settings offers, less Never; 15 unless one is set. */
function fillAppIdle() {
  const v = appLockUi.view;
  const box = $('#applock-idle');
  box.replaceChildren(...(v?.idleChoices ?? [5, 10, 15, 30, 60]).filter(m => m > 0).map(m => el('option', { value: String(m), text: String(m) })));
  box.value = String(v?.idleMinutes > 0 ? v.idleMinutes : 15);
}
/** The window's words follow the kind picked: the same wording for a PIN and for a password. */
function drawNewKind(kind) {
  const w = kind === 'password' ? 'password' : 'pin';
  $('#applock-pin-label').textContent = `Create a new ${w}`;
  $('#applock-pin2-label').textContent = `Confirm ${w}`;
  $('#applock-rule').textContent = kind === 'password' ? 'Any length. A few plain words are easy to remember and hard to guess.' : '4 to 12 digits.';
  $('#applock-agree-text').textContent = `I confirm if I lose my ${w} I will be locked out`;
  $('#applock-warn').textContent = `WARNING, BY ENABLING THIS YOU NEED TO USE ${w.toUpperCase()} TO LOGIN`;
  $('#applock-save').textContent = `Save ${w} and lock`;
  $('#applock-gen-row').hidden = kind !== 'password';
  $('#applock-gen-words').textContent = '';
  for (const i of [$('#applock-pin'), $('#applock-pin2')]) {
    fitSecret(i, kind);
    i.value = '';
  }
  $('#applock-strength').hidden = true;
}
const newKind = kindSwitch($('#applock-kind'), 'pin', drawNewKind);
const newStrength = strengthLine($('#applock-pin'), $('#applock-strength'), newKind);
$('#applock-gen').addEventListener('click', () => generateInto($('#applock-pin'), $('#applock-pin2'), $('#applock-gen-words'), newStrength));
function openAppLockNew() {
  appNewFault('');
  fillAppIdle();
  drawNewKind(newKind());
  $('#applock-agree').checked = false;
  appNew.showModal();
  $('#applock-pin').focus();
}
$('#applock-cancel').addEventListener('click', () => appNew.close());
$('#applock-new-form').addEventListener('submit', async e => {
  e.preventDefault();
  if (!$('#applock-agree').checked) return appNewFault(`Tick "${$('#applock-agree-text').textContent}" first: without it the app does not open.`);
  $('#applock-save').disabled = true;
  // The lock shuts as the server saves it: other calls answer 423 from then on, which must not reload the page before
  // the recovery codes come back and are shown.
  appLockUi.showingCodes = true;
  try {
    const r = await api('/api/applock', { action: 'set', kind: newKind(), pin: $('#applock-pin').value, pin2: $('#applock-pin2').value, agree: true, idleMinutes: Number($('#applock-idle').value) });
    $('#applock-pin').value = '';
    $('#applock-pin2').value = '';
    appNew.close();
    // A2: the first lock's recovery codes, shown once; the page locks once one is typed back.
    if (r.recoveryCodes) await showCodes(r.recoveryCodes);
    location.reload();
  } catch (err) {
    appLockUi.showingCodes = false;
    appNewFault(err.message);
    $('#applock-save').disabled = false;
  }
});

// ---- The lock screen ----

$('#applock-form').addEventListener('submit', async e => {
  e.preventDefault();
  const fault = $('#applock-fault');
  $('#applock-open').disabled = true;
  try {
    await api('/api/applock', { action: 'unlock', pin: $('#applock-open-pin').value });
    location.reload();
  } catch (err) {
    fault.textContent = err.message;
    fault.hidden = false;
    $('#applock-open-pin').value = '';
    $('#applock-open-pin').focus();
    $('#applock-open').disabled = false;
  }
});

// ---- A2: "Use a recovery code" on the lock screen ----

const recoverKind = kindSwitch($('#applock-recover-kind'), 'pin', kind => {
  const w = lockWord(kind);
  $('#applock-new1-label').textContent = `New ${w}`;
  $('#applock-new2-label').textContent = `The new ${w} again`;
  $('#applock-recover-rule').textContent = kind === 'password' ? 'Any length.' : '4 to 12 digits.';
  $('#applock-recover-gen-row').hidden = kind !== 'password';
  $('#applock-recover-gen-words').textContent = '';
  for (const i of [$('#applock-new1'), $('#applock-new2')]) {
    fitSecret(i, kind);
    i.value = '';
  }
  $('#applock-recover-strength').hidden = true;
});
const recoverStrength = strengthLine($('#applock-new1'), $('#applock-recover-strength'), recoverKind);
$('#applock-recover-gen').addEventListener('click', () => generateInto($('#applock-new1'), $('#applock-new2'), $('#applock-recover-gen-words'), recoverStrength));
function recoverShown(on) {
  $('#applock-form').hidden = on;
  $('#applock-recover').hidden = !on;
  $('#applock-recover-fault').hidden = true;
  if (!on) return void $('#applock-open-pin').focus();
  $('#applock-recover-kind').querySelector(`[data-kind="${appLockUi.view?.kind ?? 'pin'}"]`)?.click();
  $('#applock-code').value = '';
  $('#applock-code').focus();
}
$('#applock-recover-open').addEventListener('click', () => recoverShown(true));
$('#applock-recover-back').addEventListener('click', () => recoverShown(false));
$('#applock-recover').addEventListener('submit', async e => {
  e.preventDefault();
  const fault = $('#applock-recover-fault');
  $('#applock-recover-go').disabled = true;
  try {
    await api('/api/applock', { action: 'recover', code: $('#applock-code').value, kind: recoverKind(), pin: $('#applock-new1').value, pin2: $('#applock-new2').value });
    location.reload();
  } catch (err) {
    fault.textContent = err.message;
    fault.hidden = false;
    $('#applock-recover-go').disabled = false;
  }
});

// ---- A2: the codes window: shown once, with Copy / Save as text file / Print; one typed back closes it ----

/** Shows the codes until one of them is typed back (Escape does not close it); ends once it is closed. */
function showCodes(codes) {
  const dlg = $('#codes-dlg');
  const nl = '\r\n';
  const text = [`TOMLIN recovery codes (made ${new Date().toLocaleString()})`, 'Each code works once, to set a new PIN or password on the lock screen (Use a recovery code).', '', ...codes.map((c, i) => `${String(i + 1).padStart(2)}. ${c}`), ''].join(nl);
  const said = t => ($('#codes-said').textContent = t);
  $('#codes-list').replaceChildren(...codes.map(c => el('li', { text: c })));
  $('#codes-back').value = '';
  $('#codes-fault').hidden = true;
  said('');
  $('#codes-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      said('Copied. Paste them somewhere safe (not only on this PC).');
    } catch {
      said('This browser did not let the page copy. Select the codes and copy them, or use Save as text file.');
    }
  };
  $('#codes-save').onclick = () => {
    const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: 'TOMLIN recovery codes.txt' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    said('Saved as "TOMLIN recovery codes.txt" (in Downloads). Keep a copy somewhere safe, away from this PC.');
  };
  $('#codes-print').onclick = () => {
    const w = window.open('', '_blank', 'width=600,height=700');
    if (!w) return said('The print window was blocked. Use Save as text file, then print that.');
    const pre = w.document.createElement('pre');
    pre.style.font = '16px/1.6 monospace';
    pre.textContent = text;
    w.document.title = 'TOMLIN recovery codes';
    w.document.body.append(pre);
    w.focus();
    w.print();
  };
  const plain = v => String(v).toUpperCase().replace(/[\s-]+/g, '');
  appLockUi.showingCodes = true;
  return new Promise(done => {
    dlg.oncancel = e => e.preventDefault();
    $('#codes-form').onsubmit = e => {
      e.preventDefault();
      const typed = plain($('#codes-back').value);
      if (!codes.some(c => plain(c) === typed)) {
        $('#codes-fault').textContent = typed ? 'That is not one of the codes above. Type one of them as you saved it.' : 'Type one of the codes above to show you kept them.';
        $('#codes-fault').hidden = false;
        return;
      }
      $('#codes-list').replaceChildren();
      appLockUi.showingCodes = false;
      dlg.close();
      done();
    };
    dlg.showModal();
    $('#codes-back').focus();
  });
}

// Something done in the page (not the once-a-second polling) starts the "lock by itself" clock again.
for (const type of ['pointerdown', 'keydown', 'wheel']) {
  window.addEventListener(type, () => {
    const v = appLockUi.view;
    if (!v?.on || !v.idleMinutes || app.lockShown || Date.now() - appLockUi.lastTouch < 30_000) return;
    appLockUi.lastTouch = Date.now();
    api('/api/applock', { action: 'touch' }).catch(() => undefined);
  }, { passive: true, capture: true });
}

// ---- The App lock part of the Settings page ----

/** sd-server takes no key (src/picturelock.ts): what the lock does and does not do for picture models, said plainly. */
const PICTURE_WORDS = 'Picture models: while TOMLIN is locked, a picture model you loaded is unloaded once it has had nothing to draw for 2 minutes (a linked PC drawing here loads one for its pictures, kept 10 minutes after its last one). While TOMLIN is open, a loaded picture model can be used by any program on this PC: its runner takes no key, so TOMLIN cannot lock it. Chat models take a key.';

app.appLockBox = () => {
  const v = appLockUi.view;
  if (!v) return null;
  const note = el('p', { class: 'hint', role: 'status' });
  const say = text => {
    note.textContent = text;
  };
  if (!v.on) {
    return el('div', { class: 'notify-box' },
      el('h3', { text: 'App lock' }),
      el('p', { class: 'hint', text: 'Off. A PIN for the whole app: while it is locked, nobody at this PC can open the chats, jobs or files here.' }),
      el('div', { class: 'team-actions' }, el('button', { class: 'btn quiet', type: 'button', text: 'Set a PIN…', onclick: () => {
        document.querySelector('dialog.mute-dlg[open], #settings[open]')?.close();
        openAppLockNew();
      } })));
  }
  const idle = el('select', { 'aria-label': 'Lock by itself' });
  for (const m of v.idleChoices) idle.append(el('option', { value: String(m), text: m ? `After ${m} minutes with nothing done` : 'Never (only the padlock locks it)' }));
  idle.value = String(v.idleMinutes);
  idle.addEventListener('change', async () => {
    try {
      appLockUi.view = await api('/api/applock', { action: 'idle', idleMinutes: Number(idle.value) });
      say('Saved.');
    } catch (err) {
      say(err.message);
    }
  });
  const w = lockWord(v.kind);
  const pinBox = (label, auto, kind) => {
    const i = el('input', { type: 'password', autocomplete: auto, 'aria-label': label });
    fitSecret(i, kind);
    return i;
  };
  const current = pinBox(`Current app lock ${w}`, 'current-password', v.kind);
  const pin = pinBox('New PIN or password', 'new-password', v.kind);
  const pin2 = pinBox('The new one again', 'new-password', v.kind);
  const field = (text, input) => el('label', { class: 'field' }, el('span', { text }), input);
  // A1: the new one may be the other kind (PIN to password or back).
  const kindBox = el('div', { class: 'lock-kind', role: 'radiogroup', 'aria-label': 'Open TOMLIN with' },
    el('button', { type: 'button', role: 'radio', 'aria-checked': 'false', 'data-kind': 'pin', text: 'PIN' }),
    el('button', { type: 'button', role: 'radio', 'aria-checked': 'false', 'data-kind': 'password', text: 'Password' }));
  const strong = el('p', { class: 'hint lock-strength', role: 'status', hidden: true });
  const genWords = el('span', { class: 'hint', role: 'status' });
  const genRow = el('div', { class: 'team-actions' });
  const pinLabel = el('span');
  const pin2Label = el('span');
  const kindNow = kindSwitch(kindBox, v.kind, k => {
    for (const i of [pin, pin2]) {
      fitSecret(i, k);
      i.value = '';
    }
    pinLabel.textContent = `New ${lockWord(k)}`;
    pin2Label.textContent = `The new ${lockWord(k)} again`;
    genRow.hidden = k !== 'password';
    genWords.textContent = '';
    strong.hidden = true;
  });
  const draw = strengthLine(pin, strong, kindNow);
  genRow.append(el('button', { class: 'btn quiet', type: 'button', text: 'Generate', onclick: () => generateInto(pin, pin2, genWords, draw) }), genWords);
  const change = el('button', { class: 'btn quiet', type: 'button', text: 'Change it', onclick: async () => {
    try {
      appLockUi.view = await api('/api/applock', { action: 'change', current: current.value, kind: kindNow(), pin: pin.value, pin2: pin2.value });
      current.value = pin.value = pin2.value = '';
      say(`The app lock ${lockWord(appLockUi.view.kind)} is set. Any other browser that had TOMLIN open is locked now.`);
      $('#settings-lock').replaceChildren(app.appLockBox() ?? '');
    } catch (err) {
      say(err.message);
    }
  } });
  // A2: the recovery codes: how many are left, a nudge below 3, and New set (the current lock or a current code).
  const c = v.codes;
  const codesLine = v.codesDamaged ? 'The recovery codes file is damaged, so no code works. Make a new set.'
    : !c ? 'No recovery codes yet. Make a set: each code can set a new PIN or password once if you forget yours.'
    : `Recovery codes: ${c.left} of ${c.total} left.`;
  const nudge = c && c.left < 3 ? el('p', { class: 'applock-warn', role: 'note', text: c.left ? `Only ${c.left} recovery code${c.left > 1 ? 's' : ''} left. Make a new set.` : 'No recovery codes left. Make a new set.' }) : null;
  const newSet = el('button', { class: 'btn quiet', type: 'button', text: c ? 'New set…' : 'Make recovery codes…', onclick: async () => {
    if (!current.value) return say(`Type your current ${w} (or one of your recovery codes) in the box above first.`);
    try {
      const { recoveryCodes, ...view } = await api('/api/applock', { action: 'codes-new', current: current.value });
      current.value = '';
      appLockUi.view = view;
      await showCodes(recoveryCodes);
      $('#settings-lock').replaceChildren(app.appLockBox() ?? '');
    } catch (err) {
      say(err.message);
    }
  } });
  const off = el('button', { class: 'btn quiet', type: 'button', text: 'Turn the app lock off', onclick: async () => {
    try {
      appLockUi.view = await api('/api/applock', { action: 'off', current: current.value });
      current.value = pin.value = pin2.value = '';
      drawPadlock();
      say('The app lock is off: TOMLIN opens without a PIN or password. Your recovery codes are kept for when you set one again.');
    } catch (err) {
      say(err.message);
    }
  } });
  return el('div', { class: 'notify-box' },
    el('h3', { text: 'App lock' }),
    el('p', { class: 'hint', text: `On, with a ${w}. The padlock in the top bar locks TOMLIN at once; a restart or a new browser also starts locked. It locks the app, not the files on disk.` }),
    el('p', { class: 'hint', text: PICTURE_WORDS }),
    field('Lock by itself', idle),
    field(`Current app lock ${w} (to change it, turn the lock off or make new recovery codes)`, current),
    el('div', { class: 'field' }, el('span', { text: 'Open TOMLIN with' }), kindBox),
    el('div', { class: 'team-actions' }, el('label', { class: 'field' }, pinLabel, pin), el('label', { class: 'field' }, pin2Label, pin2)),
    strong,
    genRow,
    el('div', { class: 'team-actions' }, change, off),
    el('p', { class: 'hint', role: 'status', text: codesLine }),
    nudge,
    el('div', { class: 'team-actions' }, newSet),
    note);
};

void appLockBoot();
