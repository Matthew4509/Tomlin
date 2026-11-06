// Run and probe: after the last step of a job, start the project the job made, ask for every page and form its own
// pages point to, and report what does not answer; plus which of the project's own tests to run. The faults become fix
// steps for the same model (src/jobrun/actions.ts), so the job repairs its own work. The plain rules are here and tested
// in test/verify.test.ts; starting the program runs workspace code, so a run only does it when the person asked.
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { testEnv } from './checks.ts';
import { MAX_STEP_FILES, testFixStep, VERIFY_ROUNDS, type Job, type Step } from './jobs.ts';

export interface Target { method: 'GET' | 'POST'; path: string }
export interface Probe extends Target { status: number | null }
export interface Start { label: string; exe: string; args: string[]; shell?: boolean; static?: boolean }

/**
 * A tiny static file server for a plain web page (index.html + scripts) that has no server of its own. It serves only
 * the project folder, on 127.0.0.1 and the PORT it is given; a path that climbs out of the folder is refused.
 */
const STATIC_SERVER = `const h=require('http'),f=require('fs'),p=require('path');const r=p.resolve('.');const T={'.html':'text/html','.htm':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.gif':'image/gif','.ico':'image/x-icon','.webp':'image/webp'};h.createServer((q,s)=>{let u;try{u=decodeURIComponent(q.url.split('?')[0])}catch{s.writeHead(400);return s.end()}if(u.endsWith('/'))u+='index.html';const x=p.resolve(r,'.'+u);if(x!==r&&!x.startsWith(r+p.sep)){s.writeHead(403);return s.end()}f.readFile(x,(e,d)=>{if(e){s.writeHead(404);return s.end()}s.writeHead(200,{'content-type':T[p.extname(x).toLowerCase()]||'application/octet-stream'});s.end(d)})}).listen(+process.env.PORT||8000,'127.0.0.1')`;

const MAX_TARGETS = 40;
const WHOLE_FILE_CHARS = 16_000;
const CODE = /\.(html?|py|js|mjs|cjs|ts|php|jinja2?|tpl)$/i;

/** The local addresses the project's own pages and code point to: form actions (with their method), links, fetches. */
export function linkTargets(files: Record<string, string>): Target[] {
  const out = new Map<string, Target>();
  const add = (method: 'GET' | 'POST', raw: string) => {
    // Addresses with a placeholder ({slug}, <slug>, ${id}) name a family of pages, not one: left out.
    if (!raw.startsWith('/') || raw.startsWith('//') || /[{<$%]/.test(raw)) return;
    const path = raw.replace(/[?#].*$/, '') || '/';
    const key = `${method} ${path}`;
    if (!out.has(key) && out.size < MAX_TARGETS) out.set(key, { method, path });
  };
  for (const [name, text] of Object.entries(files)) {
    if (!CODE.test(name)) continue;
    for (const f of text.matchAll(/<form\b[^>]*>/gi)) {
      const action = /\baction\s*=\s*["']([^"']*)["']/i.exec(f[0]);
      if (!action) continue;
      const post = /\bmethod\s*=\s*["']?post/i.test(f[0]);
      add(post ? 'POST' : 'GET', action[1]);
    }
    for (const a of text.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']*)["']/gi)) add('GET', a[1]);
    for (const a of text.matchAll(/\bfetch\(\s*["'`]([^"'`]*)["'`]/g)) add('GET', a[1]);
  }
  return [...out.values()];
}

/** How to start the project: a Python or Node file that serves web pages, or an npm start script; null when none shows. */
export function detectStart(paths: string[], texts: Record<string, string>): Start | null {
  const has = (p: string) => paths.includes(p);
  const pkg = texts['package.json'];
  if (has('package.json') && pkg && /"start"\s*:/.test(pkg)) return { label: 'npm start', exe: 'npm', args: ['start'], shell: true };
  for (const f of ['app.py', 'server.py', 'main.py', 'run.py', 'wsgi.py']) {
    if (has(f) && /wsgiref|http\.server|flask|Flask\(|serve_forever|app\.run\(|uvicorn|make_server|aiohttp|bottle/i.test(texts[f] ?? '')) return { label: `python ${f}`, exe: 'python', args: [f] };
  }
  for (const f of ['server.js', 'app.js', 'index.js', 'server.mjs', 'app.mjs']) {
    if (has(f) && /\.listen\(|createServer\(/.test(texts[f] ?? '')) return { label: `node ${f}`, exe: process.execPath, args: [f] };
  }
  // A plain web page with no server (the Flappy Bird and fitness builds): served as files.
  if (has('index.html')) return { label: 'a static file server for index.html', exe: process.execPath, args: ['-e', STATIC_SERVER], static: true };
  return null;
}

/**
 * What a plain web page loads, as addresses to request: each page itself, and the scripts, styles, images and local
 * links in it (relative ones resolved from the page's folder). Outside addresses and fragments are left out.
 */
export function pageTargets(files: Record<string, string>): Target[] {
  const out = new Map<string, Target>();
  const add = (path: string) => { if (!out.has(path) && out.size < MAX_TARGETS) out.set(path, { method: 'GET', path }); };
  for (const [name, text] of Object.entries(files)) {
    if (!/\.html?$/i.test(name)) continue;
    const dir = name.includes('/') ? name.slice(0, name.lastIndexOf('/') + 1) : '';
    add(/(^|\/)index\.html?$/i.test(name) ? `/${dir}` : `/${name}`);
    for (const m of text.matchAll(/<(?:script|img|link|a|source|audio|video)\b[^>]*\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
      const raw = m[1].replace(/[?#].*$/, '');
      if (!raw || /^[a-z][\w+.-]*:|^\/\//i.test(raw) || /[{<$%]/.test(raw)) continue;
      const parts: string[] = [];
      for (const seg of (raw.startsWith('/') ? raw.slice(1) : dir + raw).split('/')) {
        if (seg === '..') parts.pop();
        else if (seg && seg !== '.') parts.push(seg);
      }
      add(`/${parts.join('/')}`);
    }
  }
  return [...out.values()];
}

/** The project's own tests, as an id of src/checks.ts TESTS; null when it has none. */
export function detectTest(paths: string[], texts: Record<string, string>): 'unittest' | 'npm-test' | 'node-test' | null {
  if (paths.includes('package.json') && /"test"\s*:/.test(texts['package.json'] ?? '')) return 'npm-test';
  if (paths.some(p => /(^|\/)(test_[^/]*|[^/]*_test)\.py$/i.test(p))) return 'unittest';
  if (paths.some(p => /\.(test|spec)\.m?js$/i.test(p))) return 'node-test';
  return null;
}

/** The ports the project may listen on: those written in its code, then the usual ones; each once. */
export function portsOf(texts: Record<string, string>): number[] {
  const out: number[] = [];
  const add = (n: number) => { if (n >= 1024 && n <= 65535 && !out.includes(n)) out.push(n); };
  // In the order they are written, file by file.
  for (const t of Object.values(texts)) {
    const found: { at: number; n: number }[] = [];
    for (const re of [/(?:port|PORT)\W{0,16}(\d{4,5})\b/g, /make_server\([^,]*,\s*(\d{4,5})/g, /\.listen\(\s*(\d{4,5})/g]) {
      for (const m of t.matchAll(re)) found.push({ at: m.index ?? 0, n: Number(m[1]) });
    }
    for (const f of found.sort((x, y) => x.at - y.at)) add(f.n);
  }
  for (const n of [8000, 8080, 3000, 5000, 8888]) add(n);
  return out;
}

/** The faults in what the project answered: no answer, a server error, or a 404 for a page its own pages point to. */
export function judgeProbes(results: Probe[]): string[] {
  const out: string[] = [];
  for (const r of results) {
    const who = `${r.method} ${r.path}`;
    if (r.status === null) out.push(`${who}: no answer (the app stopped or did not reply).`);
    else if (r.status === 404) out.push(`${who} answers 404: a page or form points to it, but the app has no route for it.`);
    else if (r.status >= 500) out.push(`${who} answers ${r.status}: the app failed on it.`);
  }
  return out;
}

/** A coder step that fixes what running the project showed: on the files that name the failing paths, and the server code. */
export function probeFixStep(job: Job, problems: string[], workspaceFiles: string[], texts: Record<string, string>): Step {
  const code = workspaceFiles.filter(f => !f.startsWith('jobs/') && CODE.test(f) && !/(^|[/._-])(test|tests|spec)([/._-]|$)/i.test(f));
  const paths = problems.map(p => /\s(\/[^\s:]*)/.exec(p)?.[1]).filter((p): p is string => !!p);
  const naming = code.filter(f => paths.some(p => (texts[f] ?? '').includes(p)));
  const server = code.filter(f => /wsgiref|http\.server|flask|serve_forever|\.listen\(|createServer\(|path ==|app\.route|router/i.test(texts[f] ?? ''));
  // Kept to what a whole-file answer holds (about 20,000 characters at a 32,768 context): the server file first. A long
  // file changed by edit blocks is where a small model drops functions, so fewer files and a whole-file rewrite is safer.
  const files: string[] = [];
  let chars = 0;
  for (const f of [...new Set([...server, ...naming])]) {
    const n = texts[f]?.length ?? 0;
    if (files.length && chars + n > WHOLE_FILE_CHARS) continue;
    files.push(f);
    chars += n;
    if (files.length >= MAX_STEP_FILES) break;
  }
  const base = testFixStep(job, 'running the project', '', workspaceFiles, texts);
  return {
    ...base,
    title: 'Fix what running the project showed',
    files: files.length ? files : base.files,
    brief: `The project was started and its own pages and forms were requested. These failed:\n${problems.slice(0, 8).map(p => `- ${p}`).join('\n')}\nChange the code so every form and link the pages contain is served by the app, and each form works. Keep the page text and the route names consistent: if a form posts to a path, the app must handle that exact path. A login that works answers with a redirect AND sets its session cookie in that same answer.\nMake the smallest change: give edit blocks that copy only the few lines that must change, not whole functions. Do not remove or rename any function, route or the program start; keep every one that is there now.`,
    check: 'every page and form the project points to answers',
  };
}

/** Whether something already accepts connections on a local port. */
const listening = (port: number): Promise<boolean> => new Promise(resolve => {
  const s = connect({ port, host: '127.0.0.1' });
  const done = (v: boolean) => { s.destroy(); resolve(v); };
  s.setTimeout(400, () => done(false));
  s.once('connect', () => done(true));
  s.once('error', () => done(false));
});

/**
 * Starts the project, waits for it to listen (on one of `ports` that nothing held before), requests each target, and
 * stops it. `output`: what the program printed (the start of it), for a message when it would not start.
 */
export async function startAndProbe(cwd: string, start: Start, targets: Target[], ports: number[], opts: { waitMs?: number; requestMs?: number } = {}): Promise<{ started: boolean; port: number | null; results: Probe[]; output: string; error?: string }> {
  const busy = new Set<number>();
  for (const p of ports) if (await listening(p)) busy.add(p);
  const free = ports.find(p => !busy.has(p)) ?? 0;
  let out = '';
  let exited = false;
  let child: ReturnType<typeof spawn>;
  try {
    // PORT is offered to programs that read it; one that fixes its own port is found among `ports`.
    child = spawn(start.exe, start.args, { cwd, shell: start.shell ?? false, windowsHide: true, env: { ...testEnv(process.env), PORT: String(free || 8000), FORCE_COLOR: '0' } });
  } catch (e) {
    return { started: false, port: null, results: [], output: '', error: (e as Error).message };
  }
  const add = (d: Buffer) => { if (out.length < 3000) out += d.toString('utf8'); };
  child.stdout?.on('data', add);
  child.stderr?.on('data', add);
  let spawnError = '';
  child.on('error', e => { spawnError = e.message; exited = true; });
  child.on('close', () => { exited = true; });
  // Ended for good before this returns: a port is not free while the program is still shutting down.
  const closed = new Promise<void>(resolve => { child.on('close', () => resolve()); child.on('error', () => resolve()); });
  const kill = async () => {
    if (!child.pid || exited) return;
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill('SIGKILL');
    await Promise.race([closed, new Promise(r => setTimeout(r, 4000))]);
    for (let i = 0; i < 20 && free && (await listening(free)); i++) await new Promise(r => setTimeout(r, 150));
  };
  try {
    const give = Date.now() + (opts.waitMs ?? 12_000);
    let port: number | null = null;
    while (Date.now() < give && !exited && port === null) {
      for (const p of ports) if (!busy.has(p) && (await listening(p))) { port = p; break; }
      if (port === null) await new Promise(r => setTimeout(r, 250));
    }
    if (port === null) return { started: false, port: null, results: [], output: out.trim(), ...(spawnError ? { error: spawnError } : {}) };
    const results: Probe[] = [];
    for (const t of targets) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), opts.requestMs ?? 5000);
      try {
        const r = await fetch(`http://127.0.0.1:${port}${t.path}`, { method: t.method, redirect: 'manual', signal: ac.signal, ...(t.method === 'POST' ? { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '' } : {}) });
        results.push({ ...t, status: r.status });
        await r.arrayBuffer().catch(() => undefined);
      } catch {
        results.push({ ...t, status: null });
      } finally {
        clearTimeout(timer);
      }
    }
    return { started: true, port, results, output: out.trim() };
  } finally {
    await kill();
  }
}

/**
 * What to do with the faults a run showed: nothing wrong is "ok"; a fault not seen before is "fix" (a fix step is added);
 * the same faults again after a fix, or no rounds left, is "halt": ask the person (the two-tries rule).
 */
export function verifyDecision(problems: string[], rounds: number, last: string[] | undefined): 'ok' | 'fix' | 'halt' {
  if (!problems.length) return 'ok';
  if (rounds >= VERIFY_ROUNDS) return 'halt';
  const key = (l: string[]) => [...l].sort().join('\n');
  return last && last.length && key(last) === key(problems) ? 'halt' : 'fix';
}

/** The report when a job stops: the faults, what was tried, and what the person is asked for. */
export function haltReport(problems: string[], tried: string[]): string {
  const faults = problems.slice(0, 6).map(p => `- ${p}`).join('\n');
  const done = tried.length ? tried.slice(-3).map(t => `- ${t}`).join('\n') : '- nothing yet: no fix was tried';
  return `The project still has faults after running it:\n${faults}\n\nWhat was tried:\n${done}\n\nTwo tries did not fix it, so it stops here. What I need from you: tell me what is wrong from your side (what you see, or what the page should do), or change the goal, and press Run again.`;
}

/** After a repair: worse when there are more faults, or the project no longer starts when it did before. */
export function isWorse(before: string[], after: string[]): boolean {
  const noStart = (l: string[]) => l.some(p => p.startsWith('The project did not start'));
  if (noStart(after) && !noStart(before)) return true;
  return after.length > before.length && !noStart(before);
}
