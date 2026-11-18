// The first-run runner test (src/server/runnercheck.ts) and the ask to install a runner Max mode needs. One dialog:
// offered once a session when a card runner and a chat model are here and nothing is recorded for this card (Start the
// test, or Skip with its warning always in view), then each runner as it is tried, then the result. Models, Model runners
// opens it again. The same dialog asks, with the size and where it comes from, before a runner is installed on this PC or
// sent to a linked PC for Max mode; nothing is installed before that button is pressed. Uses app.js's helpers ($, el, api, app).
'use strict';

const rcheck = { timer: 0, poll: 0, offered: false, asked: new Set(), manual: false };

const rcBox = () => $('#runner-check-dlg');
const rcGB = n => `${(Math.round((n / 2 ** 30) * 10) / 10).toFixed(1)} GB`;
const rcSaved = {
  get: key => {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: key => {
    try {
      sessionStorage.setItem(key, '1');
    } catch {
      // not kept: the dialog may come again
    }
  },
};
const RC_WORDS = { waiting: 'Waiting', trying: 'Trying now', passed: 'Passed', failed: 'Failed', 'not needed': 'Not needed (one already passed)', 'not tried': 'Not tried' };

function rcFrame(...kids) {
  rcBox().replaceChildren(el('div', { class: 'help-body finder' }, el('h2', { id: 'rcheck-title', text: 'Test the graphics runner' }), ...kids));
}

function rcClose() {
  clearTimeout(rcheck.timer);
  if (rcBox().open) rcBox().close();
}

/** The runners in the order they are tried, each with how it went. */
function rcRows(rows) {
  return el('ol', { class: 'finder-rows' }, ...rows.map(r => el('li', { class: `finder-row${r.state === 'passed' ? ' is-done' : r.state === 'failed' ? ' is-failed' : ''}` },
    el('span', { class: 'finder-mark', 'aria-hidden': 'true', text: r.state === 'passed' ? '✓' : r.state === 'failed' ? '✗' : r.state === 'trying' ? '…' : '' }),
    el('strong', { text: r.name }),
    el('span', { class: 'hint', text: ` ${RC_WORDS[r.state] ?? r.state}${r.why ? `: ${r.why}` : ''}${r.state === 'passed' && r.write ? ` (${Math.round(r.write * 10) / 10} words a second)` : ''}` }))));
}

async function rcIntro(manual) {
  rcheck.manual = manual;
  let v;
  try {
    v = await api('/api/runner-check');
  } catch (e) {
    rcFrame(el('p', { class: 'fault-line', text: e.message }), el('div', { class: 'team-actions' }, el('button', { class: 'btn', type: 'button', text: 'Close', onclick: rcClose })));
    return;
  }
  if (v.job?.state === 'running') return rcWatch();
  const say = el('p', { class: 'hint fault-line', role: 'status' });
  if (v.cannot) {
    rcFrame(el('p', { text: v.cannot }), v.last ? rcLast(v.last) : null, el('div', { class: 'team-actions' }, el('button', { class: 'btn', type: 'button', text: 'Close', onclick: rcClose })));
    return;
  }
  const start = el('button', { class: 'btn primary', type: 'button', text: 'Start the test', onclick: async () => {
    start.disabled = true;
    try {
      await api('/api/runner-check/start', {});
      rcWatch();
    } catch (e) {
      say.textContent = e.message;
      start.disabled = false;
    }
  } });
  const skip = manual
    ? el('button', { class: 'btn', type: 'button', text: 'Close', onclick: rcClose })
    : el('button', { class: 'btn', type: 'button', text: 'Skip', title: 'Skip the test. Read the warning above first.', onclick: async () => {
      skip.disabled = true;
      try {
        await api('/api/runner-check/skip', {});
      } catch (e) {
        say.textContent = e.message;
      }
      rcClose();
    } });
  rcFrame(
    el('p', { text: v.explain }),
    el('p', { class: 'hint', text: 'It will try, in this order:' }),
    el('ol', { class: 'finder-plan' }, ...v.plan.map(p => el('li', {}, el('strong', { text: p.name })))),
    // The warning is always on screen beside the buttons, not in a tooltip.
    el('p', { class: 'rcheck-warn', id: 'rcheck-warn' }, el('strong', { text: 'Before you skip: ' }), v.skipWarning),
    v.last && manual ? rcLast(v.last) : null,
    say,
    el('div', { class: 'team-actions' }, start, skip));
  start.focus();
}

/** The last test's results, for the Models page's button. */
function rcLast(last) {
  return el('div', {},
    el('h3', { text: `Last test: ${new Date(last.at).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}${last.state === 'skipped' ? ' (skipped)' : ''}` }),
    last.results.length
      ? el('ul', { class: 'finder-plan' }, ...last.results.map(r => el('li', {}, el('strong', { text: r.name }), el('span', { class: 'hint', text: `: ${r.state === 'passed' ? 'passed' : `failed, ${r.why}`}${last.keep === r.pin ? ' (kept)' : ''}` }))))
      : el('p', { class: 'hint', text: 'No runner was tried.' }));
}

async function rcWatch() {
  clearTimeout(rcheck.timer);
  let v;
  try {
    v = await api('/api/runner-check');
  } catch {
    rcheck.timer = setTimeout(rcWatch, 3000);
    return;
  }
  const j = v.job;
  if (!j) return rcIntro(rcheck.manual);
  const running = j.state === 'running';
  const stop = el('button', { class: 'btn', type: 'button', text: 'Stop', onclick: async () => {
    stop.disabled = true;
    await api('/api/runner-check/stop', {}).catch(() => undefined);
  } });
  rcFrame(
    el('p', { class: 'hint', text: `${j.model}${j.by !== 'this PC' ? `, asked by "${j.by}"` : ''}` }),
    el('p', { role: 'status', text: running ? j.now || 'Working…' : j.said }),
    rcRows(j.rows),
    el('div', { class: 'team-actions' }, running ? stop : el('button', { class: 'btn primary', type: 'button', text: 'Done', onclick: rcClose })));
  if (running) rcheck.timer = setTimeout(rcWatch, 1500);
}

app.openRunnerCheck = () => {
  rcBox().onclose = () => clearTimeout(rcheck.timer);
  if (!rcBox().open) rcBox().showModal();
  rcIntro(true);
};

// ---- Asking before a runner is installed for Max mode ----

function rcAskInstall(m) {
  const say = el('p', { class: 'hint', role: 'status' });
  const rows = m.needs.map(n => {
    const cuda = n.device === 'cuda';
    const where = n.host ? 'this PC' : `"${n.name}"`;
    const label = `Install on ${n.host ? 'this PC' : n.name}`;
    // Only a CUDA runner can be sent to a linked PC; any other it downloads itself (Models there).
    const act = !n.host && !cuda
      ? el('span', { class: 'hint', text: `Open Models on "${n.name}" and download the ${n.runner} runner there.` })
      : el('button', { class: 'btn primary', type: 'button', text: label, onclick: async e => {
        const go = e.currentTarget;
        go.disabled = true;
        go.textContent = 'Starting…';
        try {
          if (n.host) await api('/api/runtimes/get', { id: n.pin });
          else await api('/api/network/runner', { pc: n.id, id: n.pin });
          say.textContent = `Installing ${n.runner} on ${where}. ${n.host ? 'Models, Model runners shows how far it is' : 'Network shows how far it is'}. Load the model again when it is done, and the other PCs will lend.`;
          if (!n.host) app.openNet?.();
        } catch (err) {
          say.textContent = err.message;
          go.disabled = false;
          go.textContent = label;
        }
      } });
    return el('li', {},
      el('strong', { text: `${n.runner} on ${where}` }),
      el('span', { class: 'hint', text: ` ${n.bytes ? rcGB(n.bytes) : ''}. ${n.host ? `Downloaded here from ${n.source || 'the llama.cpp release on GitHub'}, each file checked by SHA-256 before it is unpacked.` : cuda ? 'Sent from this PC over your home network. That PC checks every file against the build its own TOMLIN names before it unpacks it.' : ''} ` }),
      act);
  });
  rcFrame(
    el('p', { text: `Borrowing from linked PCs (Cluster, or a chat's Max mode) needs the same llama.cpp build (${m.build}) on every PC that takes part, and ${m.needs.length === 1 ? 'one runner is' : 'some runners are'} not installed yet. Nothing is installed until you press the button.` }),
    el('ul', { class: 'finder-plan' }, ...rows),
    say,
    el('div', { class: 'team-actions' }, el('button', { class: 'btn', type: 'button', text: 'Not now', onclick: rcClose })));
}

// ---- Offers ----

async function rcPoll() {
  clearTimeout(rcheck.poll);
  try {
    if (!document.hidden && !document.querySelector('dialog[open]')) {
      const m = await api('/api/runner-match');
      const key = `runnerMatch:${m.build}:${m.needs.map(n => `${n.id ?? 'here'}/${n.pin}`).join(',')}`;
      if (m.needs.length && !rcheck.asked.has(key) && !rcSaved.get(key)) {
        rcheck.asked.add(key);
        rcSaved.set(key);
        rcBox().onclose = () => undefined;
        rcBox().showModal();
        rcAskInstall(m);
      } else if (!rcheck.offered) {
        const v = await api('/api/runner-check');
        if (v.due && !rcSaved.get('runnerCheckOffered')) {
          rcheck.offered = true;
          rcSaved.set('runnerCheckOffered');
          rcBox().onclose = () => clearTimeout(rcheck.timer);
          rcBox().showModal();
          rcIntro(false);
        }
      }
    }
  } catch {
    // the server is busy or restarting: asked again
  }
  rcheck.poll = setTimeout(rcPoll, 5000);
}
rcheck.poll = setTimeout(rcPoll, 4000);
