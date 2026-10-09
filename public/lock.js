// The app lock (src/applock.ts): the padlock in the top bar, the "Create a new pin" window, the full-page lock screen,
// and the App lock part of the bell window. The server refuses everything while locked; this page only shows it.
'use strict';

const appLockUi = { view: null, booted: false, lastTouch: 0 };

/** The lock screen over everything (every other part of the page is hidden, open windows are closed). */
function showAppLock(view) {
  app.lockShown = true;
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  document.body.classList.add('app-locked');
  $('#applock').hidden = false;
  const wait = view?.waitMinutes ?? 0;
  $('#applock-about').hidden = !wait;
  $('#applock-about').textContent = wait ? `Too many wrong PINs. Wait ${wait} minute${wait > 1 ? 's' : ''}, then try again.` : '';
  drawLockNode(view);
  $('#applock-open-pin').focus();
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
  if (app.lockShown) return;
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
function openAppLockNew() {
  appNewFault('');
  $('#applock-pin').value = '';
  $('#applock-pin2').value = '';
  $('#applock-agree').checked = false;
  appNew.showModal();
  $('#applock-pin').focus();
}
$('#applock-cancel').addEventListener('click', () => appNew.close());
$('#applock-new-form').addEventListener('submit', async e => {
  e.preventDefault();
  if (!$('#applock-agree').checked) return appNewFault('Tick "I confirm if I lose my pin I will be locked out" first: without the PIN the app does not open.');
  $('#applock-save').disabled = true;
  try {
    await api('/api/applock', { action: 'set', pin: $('#applock-pin').value, pin2: $('#applock-pin2').value, agree: true });
    $('#applock-pin').value = '';
    $('#applock-pin2').value = '';
    location.reload();
  } catch (err) {
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
  const pinBox = (label, auto) => el('input', { type: 'password', inputmode: 'numeric', pattern: '[0-9 ]*', maxlength: '16', autocomplete: auto, 'aria-label': label });
  const current = pinBox('Current app lock PIN', 'current-password');
  const pin = pinBox('New app lock PIN', 'new-password');
  const pin2 = pinBox('The new PIN again', 'new-password');
  const field = (text, input) => el('label', { class: 'field' }, el('span', { text }), input);
  const change = el('button', { class: 'btn quiet', type: 'button', text: 'Change the PIN', onclick: async () => {
    try {
      appLockUi.view = await api('/api/applock', { action: 'change', current: current.value, pin: pin.value, pin2: pin2.value });
      current.value = pin.value = pin2.value = '';
      say('The app lock PIN is changed. Any other browser that had TOMLIN open is locked now.');
    } catch (err) {
      say(err.message);
    }
  } });
  const off = el('button', { class: 'btn quiet', type: 'button', text: 'Turn the app lock off', onclick: async () => {
    try {
      appLockUi.view = await api('/api/applock', { action: 'off', current: current.value });
      current.value = pin.value = pin2.value = '';
      drawPadlock();
      say('The app lock is off: TOMLIN opens without a PIN.');
    } catch (err) {
      say(err.message);
    }
  } });
  return el('div', { class: 'notify-box' },
    el('h3', { text: 'App lock' }),
    el('p', { class: 'hint', text: 'On. The padlock in the top bar locks TOMLIN at once; a restart or a new browser also starts locked. It locks the app, not the files on disk.' }),
    field('Lock by itself', idle),
    field('Current app lock PIN (to change it or turn the lock off)', current),
    el('div', { class: 'team-actions' }, field('New app lock PIN', pin), field('The new PIN again', pin2)),
    el('div', { class: 'team-actions' }, change, off),
    note);
};

void appLockBoot();
