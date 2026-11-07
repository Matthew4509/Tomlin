// One part of the audit (the code rules, the AI agent files, the private details pass, a skill check) on a thread of its
// own, so a slow pattern can be ended from outside and the Bridge keeps answering meanwhile. This file is both ends:
// Parts, which the main thread uses, and the small loop the thread runs (at the bottom).
// A part has two limits. Its budget is a soft deadline (data.softAt) the part checks between files, so it stops by itself
// and keeps what it found. A few seconds later the thread is ended, for a part stuck inside one regex or one call: what
// that part found is lost, and the audit says so.
// One thread serves all the parts of an audit; another starts only after one was ended. Starting one costs 100-200 ms, far
// more than a small audit itself, so a thread that had no trouble waits a moment for the next audit, then goes.
'use strict';
const { Worker, SHARE_ENV, isMainThread, parentPort, workerData } = require('worker_threads');

const MARK = 'bridge-audit-part';
const GRACE_MS = 5000;    // how long past its budget a part has to stop by itself
const END_WAIT_MS = 2000; // how long an ended thread is waited for: one held by a system call ends when the call returns
const WARM_MS = 2000;     // how long a thread with nothing to do waits for the next audit
let alive = 0;
/** How many helper threads are running now, the one waiting for the next audit included. */
const workersAlive = () => alive;

// A thread waiting for the next audit. It never holds the process open.
let warm = null, warmTimer = null;
function takeWarm() {
  if (!warm) return null;
  const t = warm;
  warm = null;
  clearTimeout(warmTimer);
  t.w.ref();
  return t;
}
function keepWarm(t) {
  if (warm) { t.w.terminate(); return; }
  warm = t;
  t.w.unref();
  warmTimer = setTimeout(() => { if (warm === t) { warm = null; t.w.terminate(); } }, WARM_MS);
  warmTimer.unref();
}

class Parts {
  // o.runPart: a part run on this thread, when no helper thread can be had. o.inline: always on this thread.
  // o.graceMs, o.workerFile: for tests.
  constructor(o) {
    this.runPart = o.runPart;
    this.noThread = !!o.inline;
    this.alone = false; // true once a thread was wanted and could not be had
    this.file = o.workerFile || __filename;
    this.graceMs = o.graceMs == null ? GRACE_MS : o.graceMs;
    this.thread = null;
    this.ending = [];
    this.trouble = false; // a part stopped or crashed: this thread does not wait for the next audit
  }

  start() {
    const had = this.file === __filename && takeWarm();
    if (had) return had;
    const w = new Worker(this.file, { workerData: MARK, env: SHARE_ENV });
    const t = { w, ready: false, dead: false };
    alive++;
    w.once('exit', () => { alive--; t.dead = true; if (warm && warm.w === w) { warm = null; clearTimeout(warmTimer); } });
    w.on('error', () => {}); // a late error from a thread nothing waits for any more is not the server's to die of
    return t;
  }

  kill(t) {
    if (this.thread === t) this.thread = null;
    this.ending.push(t.w.terminate());
  }

  async here(part, sent) {
    try { return { state: 'done', result: await this.runPart(part, sent) }; }
    catch (e) { return { state: 'crashed', error: String((e && e.message) || e) }; }
  }
  fallBack(part, sent) {
    this.noThread = true;
    this.alone = true;
    return this.here(part, sent);
  }

  /** One part: { state: 'done', result } | { state: 'stopped', ms } | { state: 'crashed', error }. */
  run(part, data, budgetMs) {
    const t0 = Date.now();
    const sent = { ...data, softAt: t0 + budgetMs, budgetMs };
    if (this.noThread) return this.here(part, sent);
    let t;
    // A thread that ended by itself between two parts would drop the next one without a word, and it would wait out its budget.
    if (this.thread && this.thread.dead) this.thread = null;
    try { t = this.thread || (this.thread = this.start()); }
    catch { return this.fallBack(part, sent); }
    return new Promise(resolve => {
      const { w } = t;
      let over = false, timer = null;
      const end = r => {
        if (over) return;
        over = true;
        clearTimeout(timer);
        w.off('message', onMessage); w.off('error', onFail); w.off('exit', onFail);
        resolve(r);
      };
      // What cannot go to a thread (a function in the options) still runs, here.
      const post = () => { try { w.postMessage({ part, data: sent }); } catch { end(this.fallBack(part, sent)); } };
      const onMessage = m => {
        if (m.ready) { t.ready = true; post(); return; }
        if (m.error != null) this.trouble = true;
        end(m.error != null ? { state: 'crashed', error: m.error } : { state: 'done', result: m.result });
      };
      // Before it said it is ready the thread could not start at all (nothing was tried yet); after, the part crashed.
      const onFail = e => {
        if (this.thread === t) this.thread = null;
        if (!t.ready) { end(this.fallBack(part, sent)); return; }
        this.trouble = true;
        end({ state: 'crashed', error: e && e.message ? String(e.message) : 'its thread ended by itself' });
      };
      w.on('message', onMessage); w.on('error', onFail); w.on('exit', onFail);
      timer = setTimeout(() => { this.trouble = true; this.kill(t); end({ state: 'stopped', ms: Date.now() - t0 }); }, budgetMs + this.graceMs);
      if (t.ready) post();
    });
  }

  /** The audit is over: its thread waits for the next one, or is ended and waited for (not for ever). */
  async close() {
    if (this.thread && !this.trouble) { keepWarm(this.thread); this.thread = null; }
    if (this.thread) this.kill(this.thread);
    if (!this.ending.length) return;
    let timer;
    await Promise.race([Promise.all(this.ending), new Promise(r => { timer = setTimeout(r, END_WAIT_MS); })]);
    clearTimeout(timer);
    this.ending = [];
  }
}

module.exports = { Parts, workersAlive, MARK };

// Tests only (like BRIDGE_TEST_AUDIT_SPIN_MS): BRIDGE_TEST_AUDIT_SLOW="code=60000" holds the named part that long at its
// start, "code-file=200" holds it that long after each file it reads, "code=crash" makes it throw.
function testSlowdown(part, data) {
  const spec = process.env.BRIDGE_TEST_AUDIT_SLOW;
  if (!spec) return;
  const hold = ms => { const until = Date.now() + ms; while (Date.now() < until) { /* busy */ } };
  for (const item of spec.split(',')) {
    const [name, value] = item.split('=');
    if (name === part && value === 'crash') throw new Error('made to crash by a test');
    if (name === part) hold(Number(value) || 0);
    if (name === part + '-file') data.eachFile = () => hold(Number(value) || 0);
  }
}

if (!isMainThread && workerData === MARK) {
  const { runPart } = require('./audit');
  parentPort.on('message', async ({ part, data }) => {
    try {
      testSlowdown(part, data);
      parentPort.postMessage({ result: await runPart(part, data) });
    } catch (e) { parentPort.postMessage({ error: String((e && e.message) || e) }); }
  });
  parentPort.postMessage({ ready: true });
}
