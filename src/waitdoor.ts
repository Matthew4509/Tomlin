// Answers on TOMLIN's port while the start may take a while (6 Nov slow-start plan, fix 2). keep.prepare runs before
// the app is in place: the first start of a new version backs up data/ first, and an import or a restore runs there
// too. Nothing listened meanwhile, so the page said "can't reach this page" for minutes, and a person closed TOMLIN in
// Task Manager in the middle of a backup. Now a holding page answers at once and opens TOMLIN by itself when it is
// ready; the API says 503 "getting ready". The app then takes over the same listening socket (takeWaitDoor), so there
// is never a moment with nothing on the port. A start test of a new copy (src/newcopy.ts) wants TOMLIN's own
// /api/status, so this page never passes for a started TOMLIN.
import { createServer, type Server } from 'node:http';

/** What the holding door answers: a page for the browser, 503 for the API, 403 for another host name (as the app). */
export function waitAnswer(url: string, host: string, port: number): { status: number; type: string; body: string } {
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return { status: 403, type: 'application/json', body: JSON.stringify({ error: `Open TOMLIN at http://127.0.0.1:${port}` }) };
  const path = url.split('?')[0];
  if (path.startsWith('/api/') || path.startsWith('/v1/')) {
    return { status: 503, type: 'application/json', body: JSON.stringify({ busy: 'starting', error: 'TOMLIN is getting ready (a new version keeps a copy of your data first). Try again in a moment.' }) };
  }
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="3"><title>TOMLIN is getting ready</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f4ef;color:#222;font:16px/1.5 system-ui,sans-serif}main{max-width:30rem;padding:2rem;background:#fff;border-radius:16px;box-shadow:0 2px 12px rgba(0,0,0,.08)}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:.5rem 0;color:#555}@media (prefers-color-scheme:dark){body{background:#1b1b1b;color:#eee}main{background:#262626}p{color:#bbb}}</style></head>
<body><main><h1>TOMLIN is getting ready</h1><p>The first start of a new version keeps a copy of your data before it uses it. This can take a few minutes.</p><p>Please leave TOMLIN running. This page opens TOMLIN by itself when it is ready.</p></main></body></html>`;
  return { status: 503, type: 'text/html; charset=utf-8', body: page };
}

let door: Server | null = null;

/** Starts the holding door on `port`; resolves once it listens, or at once when the port is taken (the app says why later). */
export function openWaitDoor(port: number, host = '127.0.0.1'): Promise<void> {
  const s = createServer((req, res) => {
    const a = waitAnswer(req.url ?? '/', req.headers.host ?? '', port);
    res.writeHead(a.status, { 'content-type': a.type, 'cache-control': 'no-store', 'retry-after': '3', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" });
    res.end(a.body);
  });
  return new Promise(done => {
    s.once('error', () => {
      if (door === s) door = null;
      done();
    });
    s.listen(port, host, () => {
      door = s;
      done();
    });
  });
}

/**
 * The holding door's listening server, for the app to answer on from now on (its own request handler, nothing of the
 * door's left); null when there is none, and the app listens itself.
 */
export function takeWaitDoor(): Server | null {
  const s = door;
  door = null;
  if (!s?.listening) return null;
  s.removeAllListeners('request');
  s.removeAllListeners('error');
  return s;
}
