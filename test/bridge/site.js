// A demo site for the Bridge's tests: serves one fake project's public/ folder on 127.0.0.1:<port>.
//   node test/bridge/site.js <port> <project folder>
// Sends the usual security headers, so a clean demo site passes the built-in audit's localhost checks.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const port = Number(process.argv[2]);
const root = path.join(path.resolve(process.argv[3] || '.'), 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const HEADERS = {
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

http.createServer((req, res) => {
  let rel = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(root, path.normalize(rel));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403, HEADERS); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { ...HEADERS, 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { ...HEADERS, 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(port, '127.0.0.1', () => console.log('Demo site on http://127.0.0.1:' + port + '/'));
