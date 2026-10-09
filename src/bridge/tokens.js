// Token usage per project folder, read from Claude Code transcripts (~/.claude/projects/**/*.jsonl) and Codex
// sessions (~/.codex/sessions/**/*.jsonl). Every assistant
// reply carries message.usage, a reply split over lines repeats it, so dedupe by message id; total = fresh input +
// cache write + cache read + output. A reply is credited to the last project folder a tool call touched.
// Results are cached per file by size+mtime, so a refresh only rereads transcripts that grew.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const MONTHS = '__months__'; // per-file bucket of "id|YYYY-MM" -> tokens
const cache = new Map(); // file -> { key, per: {id: tokens} }

function walk(dir, out) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// Finds which project a piece of text (a cwd, or a tool call's input) points into: the project whose full path
// appears LAST in the text; at the same spot the longer path wins (a project inside another). Paths are compared
// lower-case with every backslash (single, or doubled by JSON) turned into "/".
const slash = t => String(t).toLowerCase().replace(/\\\\/g, '/').replace(/\\/g, '/');
function makeMatcher(projects) {
  const dirs = projects.map(p => ({ id: p.id, d: slash(p.dir).replace(/\/+$/, '') })).filter(x => x.d);
  const END = /[\/"'\s,)\]}]/;
  return text => {
    const t = slash(text);
    let best = null, bestAt = -1, bestLen = 0;
    for (const x of dirs) {
      let at = t.lastIndexOf(x.d);
      while (at >= 0) {
        const next = t[at + x.d.length];
        if (next === undefined || END.test(next)) break;
        at = at > 0 ? t.lastIndexOf(x.d, at - 1) : -1;
      }
      if (at < 0) continue;
      if (at > bestAt || (at === bestAt && x.d.length > bestLen)) { best = x.id; bestAt = at; bestLen = x.d.length; }
    }
    return best;
  };
}

// Calls fn for each line of a file, read 1 MB at a time: transcripts can be hundreds of MB, and reading one whole
// kept the Bridge at about 400 MB long after the count finished. A newline byte never sits inside a UTF-8 character,
// so splitting the bytes on it is safe.
function eachLine(file, fn) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return; }
  const buf = Buffer.alloc(1 << 20);
  let rest = Buffer.alloc(0), n;
  try {
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      let chunk = rest.length ? Buffer.concat([rest, buf.subarray(0, n)]) : buf.subarray(0, n);
      let start = 0, nl;
      while ((nl = chunk.indexOf(10, start)) !== -1) { if (nl > start) fn(chunk.toString('utf8', start, nl)); start = nl + 1; }
      rest = Buffer.from(chunk.subarray(start));
    }
    if (rest.length) fn(rest.toString('utf8'));
  } finally { fs.closeSync(fd); }
}

function scanClaude(file, match, dirHint) {
  const per = {}, months = {};
  per[MONTHS] = months;
  const seen = new Set();
  let current = dirHint;
  eachLine(file, line => {
    // Only lines with a folder, a tool call or a token count matter; the rest are not parsed at all.
    if (!line.includes('"cwd"') && !line.includes('tool_use') && !line.includes('"usage"')) return;
    let o; try { o = JSON.parse(line); } catch { return; }
    if (o.cwd) { const c = match(o.cwd); if (c) current = c; }
    const msg = o.message;
    if (!msg || !Array.isArray(msg.content)) return;
    for (const part of msg.content) {
      if (part.type === 'tool_use') { const c = match(JSON.stringify(part.input || {})); if (c) current = c; }
    }
    const u = msg.usage;
    if (o.type !== 'assistant' || !u || !current) return;
    if (msg.id) { if (seen.has(msg.id)) return; seen.add(msg.id); }
    const n = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    per[current] = (per[current] || 0) + n;
    if (o.timestamp) { const k = current + '|' + String(o.timestamp).slice(0, 7); months[k] = (months[k] || 0) + n; }
  });
  return per;
}

// Codex: session_meta carries cwd; token_count events carry a running total, so keep the last one.
function scanCodex(file, match) {
  const per = {};
  let proj = null, total = 0, stamp = '';
  eachLine(file, line => {
    let o; try { o = JSON.parse(line); } catch { return; }
    const p = o.payload || {};
    if (p.cwd && !proj) proj = match(p.cwd);
    const t = p.info && p.info.total_token_usage;
    if (o.timestamp) stamp = String(o.timestamp).slice(0, 7);
    if (p.type === 'token_count' && t) total = t.total_tokens || ((t.input_tokens || 0) + (t.output_tokens || 0));
  });
  if (proj && total) { per[proj] = total; if (stamp) per[MONTHS] = { [proj + '|' + stamp]: total }; }
  return per;
}

// projects: [{ id, dir }] - full paths, from any number of working folders. The per-file cache is thrown away when
// the list of projects changes, since the same transcript then splits differently.
let cacheSig = '';
function tokenTotals(projects) {
  const sig = projects.map(p => p.id + '=' + p.dir).sort().join('|');
  if (sig !== cacheSig) { cache.clear(); cacheSig = sig; }
  const match = makeMatcher(projects);
  const totals = {}, byMonth = {};
  const add = per => {
    for (const k in per) {
      if (k === MONTHS) { for (const mk in per[k]) byMonth[mk] = (byMonth[mk] || 0) + per[k][mk]; }
      else totals[k] = (totals[k] || 0) + per[k];
    }
  };
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  const codexDir = path.join(os.homedir(), '.codex', 'sessions');
  const jobs = [
    ...walk(claudeDir, []).map(f => ({ f, kind: 'claude' })),
    ...walk(codexDir, []).map(f => ({ f, kind: 'codex' })),
  ];
  for (const { f, kind } of jobs) {
    let st; try { st = fs.statSync(f); } catch { continue; }
    const key = st.size + ':' + st.mtimeMs;
    let hit = cache.get(f);
    if (!hit || hit.key !== key) {
      // A transcript folder named after a project folder (e.g. ...-projects-mysite-...) starts there.
      const hint = kind === 'claude' ? hintFromDirName(path.relative(claudeDir, f).split(path.sep)[0], projects) : null;
      hit = { key, per: kind === 'claude' ? scanClaude(f, match, hint) : scanCodex(f, match) };
      cache.set(f, hit);
    }
    add(hit.per);
  }
  const thisMonth = new Date().toISOString().slice(0, 7);
  const month = {};
  for (const mk in byMonth) { const [id, m] = mk.split('|'); if (m === thisMonth) month[id] = byMonth[mk]; }
  return { total: totals, month };
}

// Claude Code names a transcript folder after the folder it was started in, every non-letter/digit turned into "-"
// (C:\Users\x\projects\site -> C--Users-x-projects-site). A transcript folder named after a project starts there.
function hintFromDirName(dirName, projects) {
  const d = dirName.toLowerCase();
  let best = null, bestLen = 0;
  for (const p of projects) {
    const enc = p.dir.toLowerCase().replace(/[^a-z0-9]/g, '-');
    if ((d === enc || d.startsWith(enc + '-')) && enc.length > bestLen) { best = p.id; bestLen = enc.length; }
  }
  return best;
}

module.exports = { tokenTotals, eachLine };
