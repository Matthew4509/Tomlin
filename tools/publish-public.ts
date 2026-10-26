// The public copy of one commit of this source, made in the public clone (Tomlin/ in this folder, branch public, whose
// origin is the GitHub repo):
//   npm run publish-public                              (HEAD: checks only, the clone is put back as it was)
//   npm run publish-public -- <commit> --commit "<summary>"   (checks, then commits "TOMLIN <version> (beta): <summary>")
// 1. The clone must be on its branch with nothing changed. Every file it tracks but .gitattributes (its own) is taken
//    away and git archive <commit> without DROP goes in, so a file the source deleted goes from the public copy too.
// 2. Checked on a copy of exactly that archive, and any finding stops it: TOMLIN's own disclosure pass (the Bridge's:
//    this PC's details, your private list, the names of the other projects beside this one, AI trails, local paths),
//    key-shaped strings GitHub's push protection refuses, and private keys. Then the clone must hold exactly the
//    archive's files, all staged.
// 3. A stop, or a run without --commit, puts the clone back (git reset --hard, git clean). With --commit it commits as
//    TOMLIN <tomlin@localhost>. The push stays yours: git push origin public:main in the clone (your GitHub sign-in).
// Your private list: TOMLIN_PUBLISH_PRIVATE, or private-details.json in the private folder beside the release key
// (~/claude-private), in the Bridge's own shape: { "details": [{ "label": "...", "value": "..." }] }. Never shipped.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitExe } from './backup-source.ts';
import { keyHits } from './sign.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Never public: the working notes and the design record. */
export const DROP = ['docs', 'PLAN.md', 'TOKEN-LOG.md', 'USABILITY-AUDIT*'];
// Keys GitHub refuses on push, as docs/public-scan.py looked for them. Spelled in parts so this file is not a hit itself.
const KEY = new RegExp(['sk_live_[0-9A-Za-z]{8,}', 'sk_test_[0-9A-Za-z]{16,}', 'AKIA[0-9A-Z]{16}', 'ghp_[0-9A-Za-z]{30,}', 'github_pat_[0-9A-Za-z_]{30,}',
  'xox[baprs]-[0-9A-Za-z-]{10,}', 'AIza[0-9A-Za-z_-]{35}', 'sk-ant-[0-9A-Za-z_-]{20,}', 'sk-[0-9A-Za-z]{40,}'].join('|'));
const BINARY = /\.(png|jpe?g|gif|webp|ico|bmp|woff2?|ttf|otf|exe|dll|node|wasm|onnx|gguf|zip|pdf)$/i;
/** Findings that are meant to be public, by rule and file, each with why. Anything else stops the publish. */
export const ACCEPTED: { rule: string; file: string; why: string }[] = [
  { rule: 'DISC-003', file: 'src/staff.ts', why: 'the answer cleaner takes the "as an AI ..." opener out of answers: the phrase is what it looks for' },
  { rule: 'DISC-003', file: 'test/staff.test.ts', why: 'the answer cleaner\'s test' },
  { rule: 'DISC-003', file: 'test/claude.test.ts', why: 'Connect Claude writes a prompt naming a handover note: the test uses a made-up one' },
  { rule: 'DISC-004', file: 'test/claude.test.ts', why: 'a made-up home folder for the same prompt' },
  { rule: 'DISC-001', file: 'test/release.test.ts', why: 'the public repo\'s own address (owner/name), as package.json gives it' },
];

interface Finding { rule: string; sev: string; title: string; where: string }
const disclosure = createRequire(import.meta.url)('../src/bridge/disclosure.js') as {
  disclosurePass: (dir: string, ctx: object) => Promise<{ findings: Finding[]; notes: string[]; read: { files: number } }>;
  autoDetails: (folders: string[]) => { label: string; value: string; near?: boolean }[];
  readPrivateList: (file: string) => { label: string; value: string }[];
};

/** What the disclosure pass looks for in the public copy of `source`. */
export function publicContext(source = ROOT, privateFile = process.env.TOMLIN_PUBLISH_PRIVATE ?? join(homedir(), 'claude-private', 'private-details.json')) {
  const projects = dirname(source);
  // A short Windows user name ("User", "Admin") is also an ordinary word: the pass reads it beside any backslash (a
  // regex's \.user), so it is left to "your home folder", which finds it in a path (audit D21).
  const details = disclosure.autoDetails([projects]).filter(d => !(d.label === 'your user name on this PC' && d.near));
  const own = existsSync(privateFile) ? disclosure.readPrivateList(privateFile) : [];
  // The other folders beside this one, as the Bridge lists projects: tool folders (.claude, .agents) and ones named
  // like options or scratch (--help, _unpack-log) are not projects.
  const others = readdirSync(projects, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name !== basename(source) && !/^[.\-_]/.test(e.name)).map(e => e.name);
  return { details: [...own, ...details], others, own: [basename(source), 'TOMLIN'], privateFile, privateCount: own.length };
}

/** Every key-shaped string in the text files under `dir`, as "file line n". */
export function keyShaped(dir: string, files: string[]): string[] {
  const hits: string[] = [];
  for (const f of files) {
    if (BINARY.test(f)) continue;
    const text = readFileSync(join(dir, f), 'latin1');
    const m = KEY.exec(text);
    if (m) hits.push(`${f} line ${text.slice(0, m.index).split('\n').length}`);
  }
  return hits;
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--commit');
  const summary = at >= 0 ? args[at + 1] : '';
  if (at >= 0 && !summary) throw new Error('--commit needs the summary: --commit "what this release brings"');
  const commit = args.find((a, i) => !a.startsWith('--') && i !== at + 1) ?? 'HEAD';
  const clone = join(ROOT, 'Tomlin');
  const git = (dir: string, a: string[], input?: Buffer) => execFileSync(gitExe(), ['-C', dir, ...a], { input, maxBuffer: 1024 ** 3, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  if (!existsSync(join(clone, '.git'))) throw new Error(`the public clone is not at ${clone}`);
  if (git(clone, ['branch', '--show-current']).toString().trim() !== 'public') throw new Error('the public clone is not on its branch "public"');
  if (git(clone, ['status', '--porcelain']).length) throw new Error('the public clone has changes of its own: look at them first (git status in Tomlin/)');

  const sha = git(ROOT, ['rev-parse', '--verify', `${commit}^{commit}`]).toString().trim();
  const version = JSON.parse(git(ROOT, ['show', `${sha}:package.json`]).toString()).version as string;
  const archive = git(ROOT, ['archive', '--format=tar', sha, '--', '.', ...DROP.map(d => `:(exclude)${d}`)]);
  const shipped = git(ROOT, ['ls-tree', '-r', '--name-only', '-z', sha]).toString().split('\0').filter(Boolean)
    .filter(f => !DROP.some(d => d.endsWith('*') ? !f.includes('/') && f.startsWith(d.slice(0, -1)) : f === d || f.startsWith(`${d}/`)));
  console.log(`TOMLIN ${version} from ${sha.slice(0, 7)}: ${shipped.length} files (${DROP.join(', ')} left out).`);

  // 2. The checks, on a copy of exactly what ships.
  const scratch = mkdtempSync(join(tmpdir(), 'tomlin-public-'));
  const stops: string[] = [];
  try {
    execFileSync(tar, ['-x', '-f', '-', '-C', scratch], { input: archive, maxBuffer: 1024 ** 3, windowsHide: true });
    const ctx = publicContext();
    console.log(`Disclosure pass: ${ctx.details.length} details (${ctx.privateCount} from your list${ctx.privateCount ? '' : `: none at ${ctx.privateFile}`}), ${ctx.others.length} other project names.`);
    const pass = await disclosure.disclosurePass(scratch, ctx);
    const accepted = pass.findings.filter(f => ACCEPTED.some(a => a.rule === f.rule && a.file === f.where.replace(/:\d+$/, '')));
    for (const f of pass.findings) if (!accepted.includes(f)) stops.push(`${f.sev} ${f.rule} ${f.title}: ${f.where}`);
    if (accepted.length) console.log(`  ${accepted.length} finding(s) meant to be public (ACCEPTED in this file): ${accepted.map(f => f.where).join(', ')}`);
    for (const n of pass.notes) console.log(`  note: ${n}`);
    if (pass.read.files < shipped.length * 0.5) stops.push(`the disclosure pass read only ${pass.read.files} of ${shipped.length} files`);
    for (const k of keyShaped(scratch, shipped)) stops.push(`key-shaped string: ${k}`);
    for (const k of keyHits(scratch)) stops.push(`private key: ${k}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const putBack = () => { git(clone, ['reset', '--hard', '-q']); git(clone, ['clean', '-fdq']); };
  if (stops.length) {
    console.error(`Stopped: ${stops.length} finding(s); nothing was changed in the clone.\n  ${stops.join('\n  ')}`);
    process.exit(1);
  }
  console.log('Checks: no private details, other project names, AI trails, local paths, key-shaped strings or private keys.');

  // 1 and 3. Into the clone, then the file list.
  try {
    for (const f of git(clone, ['ls-files', '-z']).toString().split('\0').filter(Boolean)) if (f !== '.gitattributes') unlinkSync(join(clone, f));
    execFileSync(tar, ['-x', '-f', '-', '-C', clone], { input: archive, maxBuffer: 1024 ** 3, windowsHide: true });
    git(clone, ['add', '-A']);
    const tracked = new Set(git(clone, ['ls-files', '-z']).toString().split('\0').filter(Boolean));
    tracked.delete('.gitattributes');
    const missing = shipped.filter(f => !tracked.has(f));
    const extra = [...tracked].filter(f => !shipped.includes(f));
    const unstaged = git(clone, ['status', '--porcelain']).toString().split('\n').filter(l => l && !/^[AMDR] /.test(l));
    if (missing.length || extra.length || unstaged.length) {
      putBack();
      throw new Error(`the clone does not hold exactly the archive: ${missing.length} missing (${missing.slice(0, 3).join(', ')}), ${extra.length} extra (${extra.slice(0, 3).join(', ')}), ${unstaged.length} not staged (${unstaged.slice(0, 3).join(', ')}); put back`);
    }
    const status = git(clone, ['diff', '--cached', '--name-status']).toString().split('\n').filter(Boolean);
    const count = (k: string) => status.filter(l => l.startsWith(k)).length;
    console.log(`The clone holds exactly the ${shipped.length} files: ${count('A')} new, ${count('M')} changed, ${count('D')} taken away.`);
    if (!summary) {
      putBack();
      console.log('Checks only (no --commit): the clone was put back as it was.');
      return;
    }
    const msg = join(tmpdir(), `tomlin-public-msg-${process.pid}.txt`);
    writeFileSync(msg, `TOMLIN ${version} (beta): ${summary}\n`);
    try {
      git(clone, ['-c', 'user.name=TOMLIN', '-c', 'user.email=tomlin@localhost', 'commit', '-q', '-F', msg]);
    } finally {
      rmSync(msg, { force: true });
    }
    console.log(`Committed in the clone: ${git(clone, ['log', '-1', '--format=%h %s']).toString().trim()}`);
    console.log(`The push is yours, in ${clone}:\n  git push origin public:main`);
  } catch (e) {
    if (git(clone, ['status', '--porcelain']).length) putBack();
    throw e;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => {
    console.error(`Publish stopped: ${(e as Error).message}`);
    process.exit(1);
  });
}
