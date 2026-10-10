// A project's secrets: names (DB_PASS, STRIPE_KEY) with a Local value (this PC) and a Live value (the hosted site).
// The code reads a secret by name (PHP getenv('DB_PASS')), so the same code runs in both places:
//   local: the Bridge hands the Local values to the local copy it starts, as environment variables (runner.js);
//   live:  each push writes the Live values to one file outside the site's web folder, and the uploaded
//          tomlin-secrets.php loads them (deploy.js).
// The page sees names and whether each value is set (and its length), never a value. Nothing here writes into the
// project's folder.
'use strict';
const crypto = require('crypto');
const vault = require('./vault');
const store = require('./store');

const MAX = 40;
const forPage = dir => store.secretRows(dir).map(r => ({ name: r.name, local: !!r.local, live: !!r.live, made: r.made || null }));

// A strong value to paste nowhere: letters and digits only, so it is safe in any config format. 32 characters = 190 bits.
function strong(n = 32) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const out = [];
  while (out.length < n) { const b = crypto.randomBytes(64); for (const x of b) if (x < 228 && out.length < n) out.push(abc[x % abc.length]); }
  return out.join('');
}

// rows: [{ name, local?, live?, clearLocal?, clearLive?, generateLive?, generateLocal? }]: the whole list, in order.
// A value left out keeps the saved one; a row missing from the list is deleted.
async function save(dir, rows) {
  if (!Array.isArray(rows) || rows.length > MAX) return { ok: false, error: 'Send a list of up to ' + MAX + ' secrets.' };
  const old = new Map(store.secretRows(dir).map(r => [r.name, r]));
  const seen = new Set();
  const plan = [];
  for (const r of rows) {
    const name = String((r && r.name) || '').trim().toUpperCase();
    if (!name) continue;
    if (!store.NAME_RE.test(name)) return { ok: false, error: '"' + name + '" cannot be a secret name: use capital letters, digits and _, starting with a letter (like DB_PASS).' };
    if (seen.has(name)) return { ok: false, error: name + ' is in the list twice.' };
    seen.add(name);
    const prev = old.get(name) || { local: '', live: '', made: null };
    const take = (k, gen, clear) => {
      if (r[clear] === true) return { keep: false, value: '' };
      if (r[gen] === true) return { keep: false, value: strong() };
      if (typeof r[k] === 'string' && r[k] !== '') {
        if (r[k].length > 4000) throw Object.assign(new Error(name + ' is longer than 4,000 characters.'), { status: 400 });
        if (/[\r\n\0]/.test(r[k])) throw Object.assign(new Error(name + ' has a line break in it: a secret is one line.'), { status: 400 });
        return { keep: false, value: r[k] };
      }
      return { keep: true, value: prev[k] };
    };
    plan.push({ name, local: take('local', 'generateLocal', 'clearLocal'), live: take('live', 'generateLive', 'clearLive'), made: r.generateLive || r.generateLocal ? new Date().toISOString() : prev.made });
  }
  const fresh = plan.flatMap(p => [p.local, p.live]).filter(x => !x.keep && x.value);
  const sealed = await vault.sealAll(fresh.map(x => x.value));
  fresh.forEach((x, i) => { x.value = sealed[i]; });
  store.saveSecretRows(dir, plan.map(p => ({ name: p.name, local: p.local.value, live: p.live.value, made: p.made })));
  return { ok: true, secrets: forPage(dir) };
}

// Add or replace some values without touching the rest (the database setup fills DB_HOST, DB_NAME, DB_USER, DB_PASS).
async function put(dir, scope, values) {
  const rows = store.secretRows(dir);
  const names = Object.keys(values);
  const sealed = await vault.sealAll(names.map(n => values[n]));
  names.forEach((n, i) => {
    let r = rows.find(x => x.name === n);
    if (!r) rows.push(r = { name: n, local: '', live: '', made: null });
    r[scope] = sealed[i];
    r.made = new Date().toISOString();
  });
  store.saveSecretRows(dir, rows);
}

/** { NAME: value } for 'live' or 'local'. Only for the server side: never sent to the page. */
async function values(dir, scope) {
  const rows = store.secretRows(dir).filter(r => r[scope]);
  const opened = await vault.openAll(rows.map(r => r[scope]));
  const out = {};
  rows.forEach((r, i) => { out[r.name] = opened[i]; });
  return out;
}

module.exports = { forPage, save, put, values, strong };
