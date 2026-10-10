// The site's MySQL database on cPanel: made through cPanel's API (Mysql::create_database, create_user,
// set_privileges_on_database), with a generated password. Its details become the Live secrets DB_HOST, DB_NAME,
// DB_USER and DB_PASS, so the site reads them with getenv() like any other secret.
// Loading a .sql file: cPanel's API has no "load this file", so TOMLIN sends the file to the secrets folder (outside
// the web folder, owner-only) and a one-time loader page with a random 32-character name into the site. TOMLIN
// calls it over HTTPS with a one-time key (the page holds only the key's hash); it loads the file, deletes the file
// and itself, and answers how it went. Unused, it deletes itself after 15 minutes; TOMLIN deletes both again after.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const secrets = require('./secrets');
const connections = require('./connections');
const deploy = require('./deploy');

const MAX_SQL = 64 * 1024 * 1024;
const clean = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 40);
const phpStr = s => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";

// The site and its cPanel connection (no connecting yet: the job holds the project first).
function cpanelOf(p) {
  const s = store.site(p.dir);
  if (!s || !s.connection) throw new Error('Set up where ' + p.name + ' goes first.');
  const conn = store.connection(s.connection);
  if (!conn) throw new Error('The connection ' + p.name + ' used is gone. Pick another in Set up.');
  if (conn.kind !== 'cpanel') throw new Error('A database can be made only through cPanel. With ' + conn.kind.toUpperCase() + ', make it in your host\'s panel and type its details in Secrets (DB_HOST, DB_NAME, DB_USER, DB_PASS).');
  return { s, conn };
}

/** Make the database and its user (once). body: { name }. Never while a push or another database job of the project,
 * or of the same server folder, runs: both write the Live secrets file and the loader. */
async function setup(p, body) {
  const { s, conn } = cpanelOf(p);
  return deploy.holding(p, conn, s.root, async () => setupHeld(p, body, s, await connections.transport(conn)));
}
async function setupHeld(p, body, s, t) {
  if (s.db) return { ok: false, error: p.name + ' already has a database (' + s.db.name + '). Load a .sql file into it, or take it off TOMLIN\'s record first.' };
  const want = clean(body.name) || clean(p.folder) || 'site';
  const r = await t.dbRestrictions();
  const prefix = (r && r.prefix) || '';
  const maxDb = Number(r && r.max_database_name_length) || 64, maxUser = Number(r && r.max_username_length) || 16;
  const dbName = (prefix + want).slice(0, maxDb);
  const userName = (prefix + want).slice(0, maxUser);
  if (dbName.length <= prefix.length || userName.length <= prefix.length) return { ok: false, error: 'That name is too long for this host (database names up to ' + maxDb + ' and users up to ' + maxUser + ' characters, with ' + prefix + ' in front). Pick a shorter one.' };
  // A try that stopped half way (the user made, the database not) carries on with what it made; anything of the same
  // name that TOMLIN did not make is left alone (another site may use it) and the person picks another name.
  const made = s.dbMade && s.dbMade.want === want ? s.dbMade : { want };
  const list = await t.dbList().catch(() => []);
  if (made.db !== dbName && (list || []).some(d => d.database === dbName)) return { ok: false, error: 'A database called ' + dbName + ' is already on this account, and TOMLIN did not make it. Pick another name, or type its details in Secrets yourself.' };
  let password;
  if (made.user === userName) password = (await secrets.values(p.dir, 'live')).DB_PASS;
  if (!password) {
    password = secrets.strong(32);
    try { await t.dbUser(userName, password); }
    catch (e) {
      if (/exists/i.test(e.message)) return { ok: false, error: 'A database user called ' + userName + ' is already on this account, and TOMLIN did not make it. Pick another name (another site may use that user, so TOMLIN does not change its password).' };
      throw e;
    }
    // Kept at once, so a stop after this point does not lose the password.
    await secrets.put(p.dir, 'live', { DB_USER: userName, DB_PASS: password });
    store.updateSite(p.dir, x => ({ ...x, dbMade: { ...made, user: userName } }));
  }
  // With prefixing on, cPanel wants the whole name, prefix included (as set_privileges_on_database says).
  if (made.db !== dbName) {
    await t.dbCreate(dbName);
    store.updateSite(p.dir, x => ({ ...x, dbMade: { ...made, user: userName, db: dbName } }));
  }
  await t.dbGrant(userName, dbName);
  await secrets.put(p.dir, 'live', { DB_HOST: 'localhost', DB_NAME: dbName });
  store.updateSite(p.dir, x => { const y = { ...x, db: { name: dbName, user: userName, at: new Date().toISOString() } }; delete y.dbMade; return y; });
  // Straight to the server, so the site can use it before the next push.
  const live = await secrets.values(p.dir, 'live');
  await deploy.writeSecrets(t, store.site(p.dir), live, true, p.dir);
  return { ok: true, db: { name: dbName, user: userName }, note: 'Database ' + dbName + ' and user ' + userName + ' made, with a generated password kept only as the Live secret DB_PASS. Read them in your code with getenv(\'DB_NAME\') and the others.' };
}

function importerText(sqlPath, keyHash) {
  return '<?php\n// Made by TOMLIN for one database load. It deletes itself when done, or after 15 minutes unused.\n'
    + "header('Content-Type: application/json'); header('Cache-Control: no-store'); header('X-Robots-Tag: noindex');\n"
    + '$tomlin_me = __FILE__; $tomlin_sql = ' + phpStr(sqlPath) + ";\n"
    + "function tomlin_end($a) { global $tomlin_me, $tomlin_sql; @unlink($tomlin_sql); @unlink($tomlin_me); echo json_encode($a); exit; }\n"
    + "if (time() - filemtime($tomlin_me) > 900) { @unlink($tomlin_sql); @unlink($tomlin_me); http_response_code(404); exit; }\n"
    + "if ($_SERVER['REQUEST_METHOD'] !== 'POST' || !isset($_POST['key']) || !hash_equals(" + phpStr(keyHash) + ", hash('sha256', (string)$_POST['key']))) { http_response_code(404); exit; }\n"
    + "@set_time_limit(900); @ini_set('memory_limit', '512M');\n"
    + "@include __DIR__ . '/tomlin-secrets.php';\n"
    + "if (!class_exists('mysqli')) tomlin_end(array('ok' => false, 'error' => 'PHP on this host has no mysqli (switch it on in cPanel, Select PHP Version, Extensions)'));\n"
    + "mysqli_report(MYSQLI_REPORT_OFF);\n"
    + "$db = @new mysqli(getenv('DB_HOST') ?: 'localhost', getenv('DB_USER'), getenv('DB_PASS'), getenv('DB_NAME'));\n"
    + "if ($db->connect_errno) tomlin_end(array('ok' => false, 'error' => 'could not open the database: ' . $db->connect_error));\n"
    + "$db->set_charset('utf8mb4');\n"
    + "$text = @file_get_contents($tomlin_sql);\n"
    + "if ($text === false) tomlin_end(array('ok' => false, 'error' => 'the .sql file was not found on the server'));\n"
    + "$n = 0; $err = null;\n"
    + "if ($db->multi_query($text)) { do { $n++; if ($r = $db->store_result()) $r->free(); } while ($db->more_results() && $db->next_result()); }\n"
    + "if ($db->errno) $err = $db->error . ' (after ' . $n . ' statements)';\n"
    + "tomlin_end(array('ok' => $err === null, 'statements' => $n, 'error' => $err));\n";
}

// A fault says whether the site was reached (e.reached): connected (and, over https, the padlock checked), so the load
// may have started and stopped part way, or never reached at all, so nothing was loaded.
function postKey(url, key, opts = {}) {
  const u = new URL(url);
  const https = u.protocol === 'https:';
  const lib = https ? require('https') : require('http');
  const body = 'key=' + encodeURIComponent(key);
  return new Promise((resolve, reject) => {
    let reached = false;
    const fail = e => { e.reached = reached; reject(e); };
    const req = lib.request({ hostname: u.hostname, port: u.port || undefined, path: u.pathname, method: 'POST', timeout: 15 * 60 * 1000,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'TOMLIN push live' }, ...opts }, res => {
      reached = true;
      const chunks = []; res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', fail);
      res.on('aborted', () => fail(new Error('the connection broke off')));
    });
    req.on('socket', sock => { const on = () => { reached = true; }; if (!sock.connecting && (!https || sock.authorized)) on(); else sock.once(https ? 'secureConnect' : 'connect', on); });
    req.on('timeout', () => req.destroy(new Error('the site took over 15 minutes')));
    req.on('error', fail);
    req.end(body);
  });
}

/** Load a .sql file of the project into the site's database. body: { file } (path inside the project). Held like setup. */
async function load(p, body) {
  const { s, conn } = cpanelOf(p);
  return deploy.holding(p, conn, s.root, async () => loadHeld(p, body, s, await connections.transport(conn)));
}
async function loadHeld(p, body, s, t) {
  if (!s.db) return { ok: false, error: 'Make the database first (Set up database).' };
  const rel = String(body.file || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const abs = path.resolve(p.dir, rel);
  if (!rel || rel.split('/').includes('..') || !abs.toLowerCase().startsWith(path.resolve(p.dir).toLowerCase() + path.sep) || !/\.sql$/i.test(abs)) return { ok: false, error: 'Pick a .sql file inside ' + p.name + '.' };
  let st; try { st = fs.statSync(abs); } catch { return { ok: false, error: rel + ' is not there.' }; }
  if (st.size > MAX_SQL) return { ok: false, error: rel + ' is ' + (st.size / 1048576).toFixed(0) + ' MB; up to 64 MB can be loaded this way. Load a bigger one in cPanel, phpMyAdmin, Import.' };
  const url = s.url;
  const test = process.env.BRIDGE_TEST_HOSTING === '1';
  if (!/^https:/i.test(url) && !test) return { ok: false, error: s.url + ' has no https yet, so the one-time key would travel unprotected. Wait for its padlock (cPanel, SSL/TLS Status, Run AutoSSL), then load again.' };
  const key = crypto.randomBytes(32).toString('hex');
  const name = 'tomlin-import-' + crypto.randomBytes(16).toString('hex') + '.php';
  const sqlRemote = deploy.joinR(s.secretsDir, 'import-' + crypto.randomBytes(8).toString('hex') + '.sql');
  const pageRemote = deploy.joinR(s.root, name);
  await t.putText(sqlRemote, fs.readFileSync(abs), '0600');
  try {
    // The loader page needs the secrets loader beside it: written fresh, so DB_* are current.
    await deploy.writeSecrets(t, s, await secrets.values(p.dir, 'live'), true, p.dir);
    await t.putText(pageRemote, importerText(sqlRemote, crypto.createHash('sha256').update(key).digest('hex')), '0644');
    let r;
    try { r = await postKey(new URL(name, url).href, key); }
    catch (e) {
      if (e.reached) return { ok: false, error: 'The connection to ' + url + ' broke off part way through the load (' + e.message + '), so some of the file may be in the database, but not all of it. Look in cPanel, phpMyAdmin, before you load it again: loading it twice can add the same rows twice.' };
      return { ok: false, error: 'Could not reach ' + url + ' to load the file (' + e.message + '), so nothing was loaded. Is the domain pointing at this host yet?' };
    }
    let j = null; try { j = JSON.parse(r.text); } catch {}
    if (!j) return { ok: false, error: 'The site answered ' + r.status + ' instead of the loader\'s report' + (r.status === 404 ? ' (the site\'s address may not point at this folder yet)' : '') + '. Nothing was loaded, or not all of it: check in cPanel, phpMyAdmin.' };
    if (!j.ok) return { ok: false, error: 'The database load stopped: ' + j.error + '.' };
    store.updateSite(p.dir, x => ({ ...x, db: { ...x.db, loaded: { file: rel, at: new Date().toISOString(), statements: j.statements } } }));
    return { ok: true, statements: j.statements, note: rel + ' loaded into ' + s.db.name + ' (' + j.statements + ' statement' + (j.statements === 1 ? '' : 's') + ').' };
  } finally {
    try { await t.remove(pageRemote); } catch {}
    try { await t.remove(sqlRemote); } catch {}
  }
}

/** The .sql files in the project, for the picker. */
function sqlFiles(dir) {
  const out = [];
  const go = (d, rel, depth) => {
    if (depth > 4 || out.length > 50) return;
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory() && !/^(\.|node_modules$|vendor$)/.test(e.name)) go(path.join(d, e.name), rel + e.name + '/', depth + 1);
      else if (e.isFile() && /\.sql$/i.test(e.name)) out.push(rel + e.name);
    }
  };
  go(dir, '', 0);
  return out;
}

module.exports = { setup, load, sqlFiles, importerText };
