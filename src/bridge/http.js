// Answering the page: JSON replies with the Bridge's safety headers, request bodies, images, and the page's own files.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cfg = require('./config');

// Scripts and styles only from TOMLIN itself, never inline (the same rule as TOMLIN's own page): the page's
// script lives in public/bridge/js/, its look in app.css; a script sets a style through el.style, never an attribute.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP };

// Demo: real paths are shown as C:\Users\demo\... in every JSON answer.
const DEMO_MASKS = cfg.DEMO ? [[cfg.DEFAULT_ROOT, 'C:\\Users\\demo\\Projects'], [cfg.HERE, 'C:\\Users\\demo\\myia-bridge'], [os.homedir(), 'C:\\Users\\demo']]
  .flatMap(([real, shown]) => [[JSON.stringify(real).slice(1, -1), JSON.stringify(shown).slice(1, -1)], [real.replace(/\\/g, '/'), shown.replace(/\\/g, '/')]])
  .sort((a, b) => b[0].length - a[0].length) : [];
function demoMask(text) {
  for (const [real, shown] of DEMO_MASKS) text = text.split(real).join(shown).split(real.toLowerCase()).join(shown);
  return text;
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, ...HEADERS });
  const text = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.end(cfg.DEMO && typeof body === 'object' && !Buffer.isBuffer(body) ? demoMask(text) : text);
}

function readBody(req, limit = 10000) {
  return new Promise((resolve, reject) => {
    let b = '';
    // Too big: the rest is read and dropped, then a 413 with a reason (dropping the connection showed as Connection lost).
    let over = false;
    req.on('data', c => { if (over) return; b += c; if (b.length > limit) { over = true; b = ''; } });
    req.on('end', () => {
      if (over) return reject(Object.assign(new Error('That is more than the Bridge takes in one go (' + limit.toLocaleString('en') + ' characters). Make it shorter and try again.'), { status: 413 }));
      // Only an object is a request: null, a number or a list is read as an empty one, so each route refuses it plainly.
      try { const v = b ? JSON.parse(b) : {}; resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {}); } catch { reject(Object.assign(new Error('The request was not readable (not JSON). Reload the page and try again.'), { status: 400 })); }
    });
  });
}

function sendImage(res, file, type) {
  let data;
  try { data = fs.readFileSync(file); } catch { return send(res, 404, { error: 'No picture.' }); }
  // An SVG shown through <img> cannot run scripts; the sandbox CSP covers opening it directly as well.
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
  res.end(data);
}

// The page and its files, read once at start (a running TOMLIN keeps serving the page it started with).
// Only .css and .js files inside public/ are served, by exact name; nothing else on disk can be asked for.
const PUBLIC = cfg.PUBLIC;
const TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const PAGE = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8').replace('__BRIDGE_KEY__', cfg.KEY);
const ICON = fs.readFileSync(path.join(PUBLIC, 'bridge.ico'));
const FILES = new Map();
(function collect(dir, rel) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) collect(path.join(dir, e.name), rel + e.name + '/');
    else if (TYPES[path.extname(e.name)]) FILES.set('/' + rel + e.name, { type: TYPES[path.extname(e.name)], body: fs.readFileSync(path.join(dir, e.name)) });
  }
})(PUBLIC, '');

// true when it answered (the page, a page file, or the icon).
function servePublic(req, res, pathname) {
  if (req.method !== 'GET') return false;
  if (pathname === '/') { send(res, 200, PAGE, 'text/html; charset=utf-8'); return true; }
  // The page's icon. It holds nothing private.
  if (pathname === '/bridge.ico') {
    res.writeHead(200, { 'Content-Type': 'image/x-icon', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(ICON);
    return true;
  }
  const f = FILES.get(pathname);
  if (!f) return false;
  send(res, 200, f.body, f.type);
  return true;
}

module.exports = { send, readBody, sendImage, servePublic };
