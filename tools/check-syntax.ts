// A real syntax check of TOMLIN's own files: every .ts, .js and .json under src/, tools/ and test/ (sub-folders too:
// src/server, src/jobrun, the Bridge part in src/bridge, ...), and the pages' scripts (public/*.js, public/bridge/js/*.js).
// Use this instead of `node --check src/x.ts`, which checks nothing for TypeScript modules (it exits 0 on broken code).
// Run: node tools/check-syntax.ts
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { syntaxCheck } from '../src/checks.ts';

const root = join(import.meta.dirname, '..');
const files: { path: string; text: string }[] = [];
/** Every file under a folder, sub-folders too (the Bridge tests' made-up projects are data, so museum/ is left out). */
async function walk(dir: string, deep: boolean): Promise<void> {
  for (const e of await readdir(join(root, dir), { withFileTypes: true }).catch(() => [])) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) { if (deep && e.name !== 'museum' && e.name !== 'node_modules') await walk(rel, deep); }
    else if (/\.(ts|js|json)$/.test(e.name)) files.push({ path: rel, text: await readFile(join(root, rel), 'utf8') });
  }
}
for (const dir of ['src', 'tools', 'test']) await walk(dir, true);
await walk('public', false);
await walk('public/bridge/js', false);
const results = await syntaxCheck(files);
const bad = results.filter(r => !r.ok);
for (const r of bad) console.log(`FAIL ${r.path} (${r.tool})\n${r.message}\n`);
console.log(`${results.length - bad.length} of ${results.length} files pass the syntax check.`);
// A page's scripts are plain scripts sharing one page: a name declared at the top of two of them stops the second
// from loading at all ("Identifier has already been declared"), which no single-file check sees. TOMLIN's page
// (public/*.js) and the Bridge's page (public/bridge/js/*.js) are two pages, each checked on its own.
let twice: [string, string[]][] = [];
for (const page of [/^public\/[^/]+\.js$/, /^public\/bridge\/js\/[^/]+\.js$/]) {
  const tops = new Map<string, string[]>();
  for (const f of files.filter(x => page.test(x.path))) {
    for (const m of f.text.matchAll(/^(?:const|let|var|function|async function|class)\s+([A-Za-z_$][\w$]*)/gm)) tops.set(m[1], [...(tops.get(m[1]) ?? []), f.path]);
  }
  twice = [...twice, ...[...tops].filter(([, where]) => where.length > 1)];
}
for (const [name, where] of twice) console.log(`FAIL "${name}" is declared at the top of ${where.join(' and ')}: the page loads only the first.`);
process.exitCode = bad.length || twice.length ? 1 : 0;
