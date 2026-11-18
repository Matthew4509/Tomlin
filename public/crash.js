// The crash notice (src/faults.ts, src/server/faults.ts): shown under an answer whose runner crashed, here or on a linked
// PC, and after a failed Test now in a model's gear. It names the PC and the fault in plain words, suggests the next
// runner to try (that PC's own pinned list, in the order src/faults.ts orderTries gives: failed with this model there
// skipped, worked there with other models first), links to the error log, and opens Report a problem. One button tries
// the suggestion: installs it if it is not there (asked first), tests it (asked first), and on a pass offers to keep it;
// on a fail the next one is suggested, until none is left. It never changes a runner on its own (app.crashActions).
'use strict';

const CRASH_KIND = { version: 'another version', type: 'the other runner type', cpu: 'the CPU (slow, but it does not crash on the card)' };

/** "3 whole answers, 1 crash, last crash 13 Nov" for one runner and this model, or that it was not used with it. */
function crashRecord(row) {
  if (!row || (!row.ok && !row.failed)) return 'not used with this model yet';
  const day = at => new Date(at).toLocaleDateString([], { day: 'numeric', month: 'short' });
  return [
    `${row.ok} whole answer${row.ok === 1 ? '' : 's'}`,
    `${row.failed} crash${row.failed === 1 ? '' : 'es'}`,
    row.lastFailed ? `last crash ${day(row.lastFailed)}` : '',
    row.lastOk ? `last worked ${day(row.lastOk)}` : '',
    row.write ? `${row.write} tokens a second` : '',
  ].filter(Boolean).join(', ');
}

/** One runner in the list of things to try, in words. */
function tryWords(t, rows) {
  const row = (rows ?? []).find(r => r.runner === t.pin);
  const size = !t.installed && t.bytes ? ` (not installed: a ${gb(t.bytes)} download)` : '';
  const mark = t.failedHere ? 'Failed with this model there: ' : t.worked ? 'Works there with other models: ' : '';
  return `${t.why ? 'Not here: ' : mark}${t.name}, ${CRASH_KIND[t.kind] ?? t.kind}${size}. ${t.why || crashRecord(row)}`;
}

/**
 * The next runner to suggest (src/faults.ts nextTry, the same rule): the first in the list that can run there, has not
 * failed with this model there, and was not tried in this notice. Null when the list is used up.
 */
const crashNext = (tries, tried = new Set()) => tries.find(t => !t.why && !t.failedHere && !tried.has(t.pin)) ?? null;

/** The text that goes into Report a problem: the fault and the runner's last lines (scrubbed again on the server). */
const crashReport = f => [`${crashTitle(f)}: ${f.fault}`, f.runnerName ? `Runner: ${f.runnerName}` : '', f.triedSaid ?? '', f.detail ? `The runner's last lines:\n${f.detail}` : ''].filter(Boolean).join('\n');
const crashTitle = f => `An error has occurred with "${f.pc}"`;

/** The notice for one fault. `f`: the fault record with its tries and history (src/faults.ts FaultRecord). */
app.crashNotice = f => {
  const card = el('div', { class: 'permit crash', role: 'alert' });
  const said = el('span', { class: 'hint', role: 'status' });
  const tries = (f.tries ?? []);
  const usable = tries.filter(t => !t.why);
  const pick = el('select', { 'aria-label': 'Runner to try' }, ...tries.map(t => el('option', { value: t.pin, text: tryWords(t, f.history), disabled: !!t.why })));
  if (usable[0]) pick.value = (crashNext(tries) ?? usable[0]).pin;
  const logBtn = el('button', { class: 'btn quiet', type: 'button', text: 'See the error log' });
  logBtn.addEventListener('click', async () => {
    try {
      if (f.pc === 'This PC' || f.here) {
        said.textContent = (await api('/api/keep', { do: 'open-log' })).said;
        return;
      }
      // A linked PC's log: its last lines, shown here (the log holds no chat's words).
      const got = await api(`/api/node/log?pc=${encodeURIComponent(f.pc)}&lines=80`);
      lines.textContent = (got.lines ?? []).join('\n') || 'That PC logged nothing today.';
      lines.hidden = false;
      said.textContent = '';
    } catch (err) {
      said.textContent = err.message;
    }
  });
  const lines = el('pre', { class: 'permit-detail', hidden: true });
  const report = el('button', { class: 'btn quiet', type: 'button', text: 'Report a problem' });
  report.addEventListener('click', () => app.openReport(crashReport(f), f.modelName || f.model));
  const record = (f.history ?? []).length
    ? el('details', { class: 'permit-now' },
      el('summary', { text: `Recent results for ${f.modelName || f.model} on "${f.pc}"` }),
      el('ul', {}, ...(f.history ?? []).map(r => el('li', { text: `${tries.find(t => t.pin === r.runner)?.name ?? (r.runner === f.runner ? f.runnerName : r.runner)}: ${crashRecord(r)}${r.lastFault && r.failed ? `. Last fault: ${r.lastFault}` : ''}` }))))
    : '';
  const detail = f.detail ? el('details', { class: 'permit-now' }, el('summary', { text: 'What the runner said' }), el('pre', { class: 'permit-detail', text: f.detail })) : '';
  // The buttons that act (Test now, Use this runner): they ask first, and are added where they live. None when the model's
  // file was gone (an unplugged drive): another runner would not help.
  const acts = f.gone ? [] : app.crashActions?.(f, pick, said, report) ?? [];
  card.append(
    el('p', { class: 'crash-title', text: `${crashTitle(f)}.` }),
    el('p', { text: f.fault }),
    f.fallbackSaid ? el('p', { class: 'crash-fell', text: f.fallbackSaid }) : '',
    tries.length ? el('p', { text: usable.length ? 'Possible fix: try another runner for this model. The next one to try is picked below, and you can pick another. Nothing changes until you choose.' : 'No other runner can be tried on that PC now; the reasons are in the list.' }) : '',
    tries.length ? el('div', { class: 'row' }, pick) : '',
    el('div', { class: 'row' }, ...acts, logBtn, report),
    said,
    lines,
    record,
    detail,
  );
  return card;
};

/** A permit card nobody answered in time: its buttons are taken away and the reason is said on it. */
app.permitEnded = (out, text) => {
  const card = out.querySelector('.permit') ?? out;
  for (const b of card.querySelectorAll('button')) b.disabled = true;
  card.append(el('p', { class: 'hint', role: 'status', text }));
};

/**
 * The wrong-model-for-tools notice (src/toolsnotice.ts): names the PC and the model, and lists models with the Tools mark.
 * Nothing is swapped: the person picks another model where models are picked, and sends again.
 */
app.toolsNotice = n => {
  const card = el('div', { class: 'permit crash', role: 'status' });
  const offers = n.offers ?? [];
  const models = el('button', { class: 'btn quiet', type: 'button', text: 'Open Models' });
  models.addEventListener('click', () => setView('models'));
  card.append(
    el('p', { class: 'crash-title', text: `"${n.model}" cannot use tools${n.pc && n.pc !== 'This PC' ? ` on "${n.pc}"` : ''}.` }),
    el('p', { text: n.text }),
    offers.length ? el('ul', {}, ...offers.map(o => el('li', { text: `${o.name}${o.loaded ? ' (loaded now)' : ''}` }))) : '',
    el('p', { text: n.how }),
    el('div', { class: 'row' }, models),
  );
  return card;
};


/**
 * The notice's guided flow, for the runner picked in its list (the next one to try is picked to start with). "Try this
 * runner" installs it if it is not there, then tests it; a pass offers to keep it as this model's Runner; a fail picks
 * the next one, until none is left, then says so and points at Report a problem. Each step asks first, in its own
 * words, and the test changes nothing. On a linked PC every step goes through that PC's own doors: a runner is sent only
 * if that PC's own TOMLIN pins that exact build (it checks every file's SHA-256 itself), and the test and the Runner
 * setting need its owner's run-settings tick.
 */
app.crashActions = (f, pick, said, report) => {
  const away = !f.here && f.pcId;
  const tries = f.tries ?? [];
  const chosen = () => tries.find(t => t.pin === pick.value);
  const where = away ? `on "${f.pc}"` : 'on this PC';
  const model = f.modelName || f.model;
  /** Runners tried in this notice that failed (or could not be installed), with why: never suggested again here. */
  const tried = new Map();
  let busy = false;
  let passed = '';
  const tryBtn = el('button', { class: 'btn primary', type: 'button', text: 'Try this runner' });
  const useBtn = el('button', { class: 'btn quiet', type: 'button', text: 'Use this runner' });
  const ask = (path, body) => (away ? api(path.network, { pc: f.pcId, ...body }) : api(path.here, body));
  const state = async () => (away
    ? api('/api/network/tune', { pc: f.pcId, action: 'runner-test-state', model: f.model })
    : api('/api/runner-test'));
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const sync = () => {
    const t = chosen();
    const kept = !!t && passed === t.pin;
    tryBtn.disabled = busy || !t || !!t.why;
    useBtn.disabled = busy || !t || !!t.why || !t.installed;
    tryBtn.textContent = !t || t.installed ? 'Try this runner' : 'Install and try this runner';
    useBtn.textContent = kept ? 'Keep it for this model' : 'Use this runner';
    tryBtn.className = kept ? 'btn quiet' : 'btn primary';
    useBtn.className = kept ? 'btn primary' : 'btn quiet';
  };
  pick.addEventListener('change', sync);

  /** Every runner that could be tried has been, or failed there before: said plainly, and Report a problem offered. */
  const usedUp = () => {
    const names = [...tried.entries()].map(([pin, why]) => `${tries.find(t => t.pin === pin)?.name ?? pin} (${why})`);
    f.triedSaid = names.length ? `Tried from the notice, without success: ${names.join('; ')}.` : '';
    said.textContent = `No runner is left to try for ${model} ${where}: ${names.length ? 'each one tried here failed, and ' : ''}the others failed with this model there before or cannot run there (the list says why). Report a problem sends the fault and what was tried, so it can be looked at.`;
    if (report) report.className = 'btn primary';
  };

  /** After a fail: the next runner is picked in the list and said, or the list is used up. */
  const onward = before => {
    const n = crashNext(tries, new Set(tried.keys()));
    if (!n) {
      usedUp();
      said.textContent = `${before} ${said.textContent}`;
      return;
    }
    pick.value = n.pin;
    said.textContent = `${before} Next to try: ${n.name}${n.installed ? '' : ` (not installed: a ${gb(n.bytes)} download)`}. Press "${n.installed ? 'Try this runner' : 'Install and try this runner'}" when you are ready.`;
  };

  /** Installs `t` on the PC that failed, after a yes. True when it is there now. */
  async function install(t) {
    if (away && t.device !== 'cuda') {
      tried.set(t.pin, 'not installed there');
      onward(`${t.name} is not installed on "${f.pc}", and only NVIDIA (CUDA) runners can be sent from here. To try it, open Models on "${f.pc}" and download it there.`);
      return false;
    }
    const how = away
      ? `This PC downloads it from the llama.cpp release on GitHub (or uses the copy it kept), checks each file by SHA-256, and sends it over your home network, sealed with the link's own keys. "${f.pc}" takes it only if its own TOMLIN pins this exact build, and checks every file's SHA-256 again before it unpacks it.`
      : 'It is downloaded from the llama.cpp release on GitHub, and each file is checked by SHA-256 before it is unpacked.';
    if (!confirm(`${t.name} is not installed ${where}. Install it now (a ${gb(t.bytes)} download)?\n\n${how} Nothing else is changed, and no model is let go.`)) return false;
    try {
      if (away) {
        const got = await api('/api/network/runner', { pc: f.pcId, id: t.pin });
        const id = got.transfer?.id;
        for (;;) {
          await wait(1500);
          const x = ((await api('/api/network')).transfers ?? []).find(y => (id ? y.id === id : y.kind === 'runner' && y.pc === f.pcId));
          if (!x) throw new Error('the send is no longer listed. Open Network to see how it went.');
          if (x.state === 'done') break;
          if (x.state !== 'working') throw new Error(x.said || 'the send stopped.');
          const pct = x.bytes ? ` (${Math.floor((100 * x.done) / x.bytes)}%)` : '';
          said.textContent = x.stage === 'get' ? `Downloading ${t.name} here first${pct}…` : `Sending ${t.name} to "${f.pc}"${pct}…`;
        }
      } else {
        await api('/api/runtimes/get', { id: t.pin });
        for (;;) {
          await wait(1500);
          const r = ((await api('/api/runtimes')).runtimes ?? []).find(y => y.id === t.pin);
          if (r?.installed) break;
          if (!r || r.getting?.error) throw new Error(r?.getting?.error || 'the download is no longer listed.');
          const g = r.getting;
          said.textContent = `Downloading ${t.name}${g?.bytes ? ` (${Math.floor((100 * g.got) / g.bytes)}%)` : ''}${g?.checking ? ', checking it' : ''}…`;
        }
      }
    } catch (err) {
      tried.set(t.pin, 'it could not be installed');
      onward(`${t.name} could not be installed ${where}: ${err.message}`);
      return false;
    }
    t.installed = true;
    return true;
  }

  tryBtn.addEventListener('click', async () => {
    const t = chosen();
    if (!t || busy) return;
    busy = true;
    passed = '';
    sync();
    try {
      if (!t.installed && !(await install(t))) return;
      const words = 'TOMLIN loads the model on that runner only, asks a short question, has it write a short answer, then gives it a long prompt (about 3,000 tokens, the kind that crashed runners before). It passes when every answer comes back and the runner is still running. Chats there wait meanwhile. A model loaded there is let go for the test, and the models that were loaded are loaded again afterwards. Nothing is changed: you choose afterwards whether to keep it.';
      if (!confirm(`Test ${model} on ${t.name}, ${where}?\n\n${words}`)) return;
      await ask({ here: '/api/runner-test', network: '/api/network/tune' }, { action: 'runner-test-start', model: f.model, runner: t.pin });
      let s = null;
      for (;;) {
        await wait(2000);
        s = (await state()).test;
        if (!s) break;
        said.textContent = s.now || s.said;
        if (s.state !== 'running') break;
      }
      if (s?.state === 'passed') {
        passed = t.pin;
        said.textContent = `Passed: ${model} ran on ${t.name} ${where}${s.write ? ` at ${s.write} tokens a second` : ''}. Keep it as this model's runner? Nothing changes until you press "Keep it for this model".`;
      } else if (s?.state === 'failed') {
        tried.set(t.pin, s.why ? s.why.replace(/\.$/, '') : 'its test failed');
        onward(`Failed: ${t.name} ${where}${s.why ? `: ${s.why}` : '.'} It is kept in the run history and not suggested again.`);
      } else if (s) {
        said.textContent = s.said || 'The test stopped. Nothing was changed.';
      }
    } catch (err) {
      said.textContent = err.message;
    } finally {
      busy = false;
      sync();
    }
  });
  useBtn.addEventListener('click', async () => {
    const t = chosen();
    if (!t) return;
    if (!confirm(`Use ${t.name} for ${model} ${where} from now on?\n\nIf the model is loaded and not answering, it is let go, so its next answer starts on this runner; if it is answering, it keeps its runner until its next load. You can set it back to Auto in the model's gear (Runner).`)) return;
    useBtn.disabled = true;
    try {
      said.textContent = (await ask({ here: '/api/runner-set', network: '/api/network/run-set' }, { model: f.model, runner: t.pin })).said;
      passed = '';
    } catch (err) {
      said.textContent = err.message;
    }
    sync();
  });
  // Automatic fallback: said when it moved the model; else offered, once agreed it is kept for this model on that PC.
  const auto = el('button', { class: 'btn quiet', type: 'button', text: f.fallback ? 'Stop moving it on its own' : 'Move it on its own next time' });
  auto.addEventListener('click', async () => {
    const on = !f.fallback;
    const ask = on
      ? `If ${model}'s runner crashes ${where} again, move it to the next runner that can run it, without asking each time?\n\nTOMLIN tells you each time it does, never moves it to the CPU on its own, and never back to a runner that crashed with it lately. You can turn this off here or in a later notice.`
      : `Stop moving ${model} ${where} to another runner on its own after a crash? The notice asks again instead.`;
    if (!confirm(ask)) return;
    auto.disabled = true;
    try {
      said.textContent = (await (away ? api('/api/network/run-set', { pc: f.pcId, model: f.model, fallback: on }) : api('/api/runner-set', { model: f.model, fallback: on }))).said;
      f.fallback = on;
      auto.textContent = on ? 'Stop moving it on its own' : 'Move it on its own next time';
    } catch (err) {
      said.textContent = err.message;
    }
    auto.disabled = false;
  });
  sync();
  if (tries.length && !crashNext(tries)) usedUp();
  return [tryBtn, useBtn, auto];
};
