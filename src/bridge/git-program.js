// The Git program itself (not a project): which version this PC has, and whether it is older than the last security
// fix this build knows about. Old Git versions had holes that a single "git clone" of a bad repository could set off,
// so an old Git is worth a warning even though the Bridge only reads git.
// Asking the internet for the newest Git is OFF until the person ticks it on the About page; with it off, nothing
// here makes a network request.
'use strict';
const { execFile } = require('child_process');

// The last security fixes this build knows about (checked against the Git and Git for Windows security advisories,
// KNOWN.checked says when). Git for Windows builds are compared with WINDOWS; any other Git with CORE, where each older release
// line also got the fix in the patch release listed (a "backport").
const KNOWN = {
  checked: '2026-10-02',
  WINDOWS: { fixed: '2.55.0.windows.3', when: 'July 2026', what: 'heap overflows in its Windows credential helper and Git leaking your Windows sign-in hash when cloning' },
  CORE: { fixed: '2.50.1', when: 'July 2025', what: 'clones of bad repositories running their code or writing files outside the folder',
    backports: ['2.43.7', '2.44.4', '2.45.4', '2.46.4', '2.47.3', '2.48.2', '2.49.1'] },
  advisories: { windows: 'https://github.com/git-for-windows/git/security/advisories', core: 'https://github.com/git/git/security/advisories' },
};
const LATEST_URL = process.env.BRIDGE_GIT_LATEST_URL || 'https://api.github.com/repos/git-for-windows/git/releases/latest';

// "git version 2.55.0.windows.3" -> { text: '2.55.0.windows.3', parts: [2,55,0,3], windows: true }
function parseVersion(s) {
  const m = /(\d+)\.(\d+)\.(\d+)(?:\.windows\.(\d+))?/.exec(String(s || ''));
  if (!m) return null;
  return { text: m[0], parts: [+m[1], +m[2], +m[3], m[4] ? +m[4] : 0], windows: !!m[4] };
}
function compare(a, b) {
  for (let i = 0; i < 4; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0) ? -1 : 1;
  return 0;
}

// Is this version older than the last known fix? { old, fixedIn, when, what }
function judge(v) {
  if (!v) return null;
  if (v.windows) {
    const fix = parseVersion(KNOWN.WINDOWS.fixed);
    return { old: compare(v.parts, fix.parts) < 0, fixedIn: KNOWN.WINDOWS.fixed, when: KNOWN.WINDOWS.when, what: KNOWN.WINDOWS.what };
  }
  const fix = parseVersion(KNOWN.CORE.fixed);
  let old = compare(v.parts, fix.parts) < 0;
  // An older release line that got the fix in its own patch release is fine from that patch on.
  if (old) for (const b of KNOWN.CORE.backports) {
    const bp = parseVersion(b).parts;
    if (bp[0] === v.parts[0] && bp[1] === v.parts[1] && v.parts[2] >= bp[2]) { old = false; break; }
  }
  return { old, fixedIn: KNOWN.CORE.fixed, when: KNOWN.CORE.when, what: KNOWN.CORE.what };
}

let installed = null; // { at, version, missing }
function readInstalled() {
  return new Promise(resolve => {
    execFile('git', ['--version'], { timeout: 8000, windowsHide: true }, (err, out) => {
      if (err) return resolve({ missing: err.code === 'ENOENT', error: err.code === 'ENOENT' ? null : String(err.message || err) });
      resolve({ version: parseVersion(out) });
    });
  });
}

// The newest Git for Windows, from GitHub (only when the person has turned this on). Kept for a day.
let latest = { at: 0, version: null, error: null, busy: null };
const DAY = 86400000;
async function checkLatest(force) {
  if (latest.busy) return latest.busy;
  if (!force && latest.at && Date.now() - latest.at < DAY) return latest;
  latest.busy = (async () => {
    try {
      const r = await fetch(LATEST_URL, { headers: { 'User-Agent': 'TOMLIN/1 (Git version check)', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error('GitHub answered ' + r.status);
      const j = await r.json();
      const v = parseVersion(j.tag_name || j.name);
      if (!v) throw new Error('no version in the answer');
      latest = { at: Date.now(), version: v.text, error: null, busy: null };
    } catch (e) {
      latest = { at: Date.now(), version: null, error: 'The newest Git version could not be read (' + (e.message || e) + ').', busy: null };
    }
    return latest;
  })();
  return latest.busy;
}

// What the page shows. online: the person's tick. Never asks the internet when online is false.
async function status({ online, fresh } = {}) {
  if (!installed || fresh || Date.now() - installed.at > 3600000) installed = { at: Date.now(), ...(await readInstalled()) };
  const v = installed.version;
  const out = {
    installed: v ? v.text : null, missing: !!installed.missing, error: installed.error || null,
    known: { checked: KNOWN.checked, ...(v && !v.windows ? KNOWN.CORE : KNOWN.WINDOWS), advisories: KNOWN.advisories },
    judge: judge(v), online: !!online, latest: null,
  };
  if (online && (!v || v.windows || process.platform === 'win32')) {
    const l = await checkLatest(fresh);
    out.latest = { version: l.version, error: l.error, at: l.at ? new Date(l.at).toISOString() : null,
      newer: !!(v && l.version && compare(v.parts, parseVersion(l.version).parts) < 0) };
  }
  return out;
}

module.exports = { status, parseVersion, compare, judge, KNOWN, _resetForTests: () => { installed = null; latest = { at: 0, version: null, error: null, busy: null }; } };
