// Runs the hidden tests again over the folders a soak built: node benchmarks/soak/regrade.mjs <soak OUT folder> <projects json>
import { readdirSync, readFileSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url));
const [out, pj = join(here, 'projects-hard.json')] = process.argv.slice(2);
const projects = JSON.parse(readFileSync(pj, 'utf8'));
const built = join(out, 'built');
const rows = [];
for (const d of readdirSync(built)) {
  const id = d.replace(/-\d+$/, ''); const p = projects.find(x => x.id === id);
  if (!p?.hidden) continue;
  const dir = join(built, d);
  copyFileSync(join(here, 'hidden', p.hidden), join(dir, p.hidden)); copyFileSync(join(here, 'hidden', '_load.mjs'), join(dir, '_load.mjs'));
  const t0 = Date.now(); const r = spawnSync(process.execPath, ['--test', p.hidden], { cwd: dir, encoding: 'utf8', timeout: 300_000 });
  const o = (r.stdout || '') + (r.stderr || '');
  const pass = Number(/(?:# |ℹ )pass (\d+)/.exec(o)?.[1] ?? 0), fail = Number(/(?:# |ℹ )fail (\d+)/.exec(o)?.[1] ?? 0);
  const failed = [...o.matchAll(/✖ ([^\n(]+)/g)].map(m => m[1].trim()).filter(x => !x.endsWith('.mjs')).slice(0, 8);
  rows.push({ id, pass, fail, secs: Math.round((Date.now() - t0) / 1000), failed, load: /ERR_MODULE_NOT_FOUND|SyntaxError|is not a function|Cannot find/.test(o) && pass + fail <= 1 ? (o.split(/\r?\n/).find(l => /Error/.test(l)) ?? '').slice(0, 160) : '' });
  console.log(id.padEnd(12), `${pass} pass, ${fail} fail`, `${rows.at(-1).secs}s`, rows.at(-1).load, failed.length ? '| ' + failed.join('; ').slice(0, 300) : '');
}
