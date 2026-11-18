import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { cleanFolder, cleanPath, inside, isNetworkPath, list, NETWORK_WHY, read, save, systemFolderWhy } from '../src/workspace.ts';
import { blogAsk, blogFile, blogSlug, blogSystem, splitPost, withoutFrontMatter } from '../src/blog.ts';

test('only plain relative text-file paths are accepted', () => {
  assert.equal(cleanPath('notes.md'), 'notes.md');
  assert.equal(cleanPath('blog\\post.md'), 'blog/post.md');
  for (const bad of ['../x.md', 'a/../../x.md', 'C:\\x.md', '.hidden.md', 'a/.git/x.md', 'run.exe', 'a.md.', 'x<y>.md', '', 'a//b.md']) assert.equal(cleanPath(bad), null, bad);
});

test('files are listed, read and saved inside the workspace; a changed file keeps one .bak; nothing else is touched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ws-'));
  try {
    await writeFile(join(root, 'a.md'), 'one');
    await writeFile(join(root, 'pic.png'), 'x');
    await mkdir(join(root, '.git'));
    await writeFile(join(root, '.git', 'c.md'), 'hidden');
    const files = await list(root);
    assert.deepEqual(files.map(f => f.path), ['a.md']);
    assert.deepEqual(await read(root, 'a.md'), { path: 'a.md', text: 'one' });
    assert.ok('error' in (await read(root, '../a.md')));
    assert.deepEqual(await save(root, 'blog/new.md', 'hello'), { path: 'blog/new.md', created: true });
    assert.deepEqual(await save(root, 'a.md', 'two'), { path: 'a.md', created: false });
    assert.equal(await readFile(join(root, 'a.md.bak'), 'utf8'), 'one');
    assert.equal(await readFile(join(root, 'a.md'), 'utf8'), 'two');
    assert.ok('error' in (await save(root, '../out.md', 'x')));
    assert.ok('error' in (await save(root, 'bad.exe', 'x')));
    assert.ok('error' in (await save(root, 'missing.md', 'x', false)));
    assert.ok('error' in (await save(root, 'big.md', 'x'.repeat((1 << 20) + 1))));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a PowerShell profile is never saved: with Documents as the workspace, PowerShell would run it each time it opens', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ws-'));
  try {
    for (const p of ['WindowsPowerShell/profile.ps1', 'PowerShell/Microsoft.PowerShell_profile.ps1', 'WindowsPowerShell/Microsoft.VSCode_profile.ps1', 'Documents/WindowsPowerShell/PROFILE.PS1']) {
      assert.ok('error' in (await save(root, p, 'Start-Process calc')), p);
    }
    assert.deepEqual(await save(root, 'scripts/build.ps1', 'Write-Output hi'), { path: 'scripts/build.ps1', created: true }, 'another script is a file like any other');
    assert.deepEqual(await save(root, 'notes/profile.md', 'x'), { path: 'notes/profile.md', created: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a link pointing out of the workspace is not followed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ws-'));
  const outside = await mkdtemp(join(tmpdir(), 'out-'));
  try {
    await writeFile(join(outside, 'secret.md'), 'secret');
    const linked = await symlink(outside, join(root, 'link'), 'junction').then(() => true, () => false);
    if (linked) {
      assert.equal(await inside(root, 'link/secret.md'), null);
      assert.ok('error' in (await save(root, 'link/new.md', 'x')));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('a file is never saved into a folder Windows runs files from, through a link inside the workspace (the home folder holds "Start Menu", which leads to the Startup folder)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ws-'));
  // A stand-in AppData, with its own Startup folder, inside the workspace as a user's home folder holds it.
  const appdata = join(root, 'AppData', 'Roaming');
  const startup = join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  try {
    await mkdir(startup, { recursive: true });
    const linked = await symlink(join(appdata, 'Microsoft', 'Windows', 'Start Menu'), join(root, 'Start Menu'), 'junction').then(() => true, () => false);
    // Temp is not looked at as a system folder, so this test's Temp is named elsewhere.
    const env = { APPDATA: appdata, TEMP: join(root, 'not-temp'), TMP: join(root, 'not-temp') };
    if (linked) {
      assert.equal(await inside(root, 'Start Menu/Programs/Startup/run.js', true, env), null);
      assert.equal(await inside(root, 'Start Menu/Programs/Startup/new/run.js', true, env), null);
    }
    // Straight in (a shallow AppData) is refused the same way; a folder of one's own beside it is not.
    assert.equal(await inside(root, 'AppData/Roaming/run.js', true, env), null);
    assert.ok(await inside(root, 'Documents/notes.md', true, env));
    // A workspace that is itself where the system keeps files (an older setting) is not made unusable by this.
    assert.ok(await inside(appdata, 'notes.md', true, env));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the blog ask has limits, the post splits into title and body, the file has front matter and the picture', () => {
  assert.equal(blogAsk({ topic: '  ' }), null);
  assert.deepEqual(blogAsk({ topic: 'Tuning a piano', words: 5000 }), { topic: 'Tuning a piano', audience: '', words: 1200 });
  assert.match(blogSystem({ topic: 't', audience: 'new owners', words: 300 }), /About 300 words/);
  assert.match(blogSystem({ topic: 't', audience: 'new owners', words: 300 }), /new owners/);
  assert.deepEqual(splitPost('# How often to tune\n\nTwice a year is a good start.'), { title: 'How often to tune', body: 'Twice a year is a good start.' });
  assert.equal(splitPost('How often to tune\n\nText.').title, 'How often to tune');
  assert.equal(blogSlug('How Often Should You Tune a Piano in Winter?'), 'how-often-should-you-tune-a');
  const f = blogFile('Tuning', 'Body text.', { picture: 'tuning.webp', alt: 'A piano', date: new Date('2026-10-03T12:00:00Z') });
  assert.match(f, /^---\ntitle: "Tuning"\ndate: 2026-10-03\nimage: "tuning.webp"\n---\n\n# Tuning\n\n!\[A piano\]\(tuning.webp\)\n\nBody text.\n$/);
  assert.doesNotMatch(blogFile('T', 'B'), /image:/);
});

test('front matter ends at a --- on its own line: a title holding --- leaves nothing of it in the post', () => {
  const f = blogFile('Before --- after', 'Body text.', { date: new Date('2026-10-03T12:00:00Z') });
  assert.equal(withoutFrontMatter(f), '# Before --- after\n\nBody text.\n');
  assert.equal(withoutFrontMatter(f.replace(/\n/g, '\r\n')), '# Before --- after\r\n\r\nBody text.\r\n');
  assert.equal(withoutFrontMatter('---\n---\n\nBody.'), 'Body.');
  assert.equal(withoutFrontMatter('---\ntitle: "only"\n---'), '');
  // No front matter: a line of --- in the post stays, and so does one at the top with no closing line.
  assert.equal(withoutFrontMatter('Body.\n\n---\n\nMore.'), 'Body.\n\n---\n\nMore.');
  assert.equal(withoutFrontMatter('---\n\nBody.'), '---\n\nBody.');
});

test('a folder typed or pasted from Windows is accepted with or without its quotes; drive roots and Windows folders are not', () => {
  assert.equal(cleanFolder(''), '');
  assert.equal(cleanFolder('  '), '');
  assert.equal(cleanFolder('C:\\Users\\me\\Writing'), 'C:\\Users\\me\\Writing');
  assert.equal(cleanFolder('"C:\\Users\\me\\My Writing"'), 'C:\\Users\\me\\My Writing');
  assert.equal(cleanFolder(' “C:\\Users\\me\\Writing” '), 'C:\\Users\\me\\Writing');
  for (const bad of ['C:\\', 'D:', 'Writing', 'C:\\Windows\\Temp', 'c:\\program files\\x', 'C:\\Users\\a"b', '"C:\\"']) assert.equal(cleanFolder(bad), null, bad);
});

test('a folder Windows runs files from, or a network folder, is never the workspace: said why, whatever the case of its letters', () => {
  const env = { APPDATA: 'C:\\Users\\me\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', ProgramData: 'C:\\ProgramData', SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', TEMP: 'C:\\Users\\me\\AppData\\Local\\Temp' };
  const startup = 'C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup';
  for (const bad of [startup, startup.toUpperCase(), 'c:/users/me/appdata/roaming/x', 'C:\\Users\\me\\AppData\\Local\\Programs\\Thing', 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\StartUp', 'C:\\Windows\\System32\\Tasks', 'C:\\Program Files (x86)\\Thing']) assert.match(String(systemFolderWhy(bad, env)), /^that folder is in (AppData|ProgramData|the Windows folder|Program Files)\b.*\. Choose a folder of your own/, bad);
  assert.match(String(systemFolderWhy(startup, env)), /Startup folder/);
  for (const net of ['\\\\server\\share\\Writing', '//server/share/x', '\\\\?\\UNC\\server\\share\\x', '\\\\?\\C:\\Users\\me\\AppData\\Roaming\\x']) assert.equal(systemFolderWhy(net, env), NETWORK_WHY, net);
  for (const good of ['C:\\Users\\me\\Documents\\Writing', 'D:\\Work', 'C:\\Users\\me\\AppData-notes', 'C:\\Users\\me\\AppData\\Local\\Temp\\scratch']) assert.equal(systemFolderWhy(good, env), null, good);
  assert.equal(isNetworkPath('\\\\pc\\share'), true);
  assert.equal(isNetworkPath('D:\\Models'), false);
  // And cleanFolder refuses them too, on this PC's own folders.
  if (process.env.APPDATA) assert.equal(cleanFolder(join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')), null);
  assert.equal(cleanFolder('\\\\server\\share\\Writing'), null);
  // The routes say it: the workspace, and both models folder routes, refuse a network folder.
  for (const [file, find] of [['src/server/work.ts', /systemFolderWhy\(typed\)/], ['src/server/hf.ts', /isNetworkPath\(dir\)/], ['src/server/modelhome.ts', /isNetworkPath\(dir\)/], ['src/server/core.ts', /!systemFolderWhy\(chosen\)/]] as const) assert.match(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), find, file);
});

test('Windows device names are not file names, with or without an extension or a folder (flows soak: aux.md, CON.txt)', () => {
  for (const bad of ['con', 'CON.txt', 'aux.md', 'nul.md', 'prn.md', 'com1.md', 'LPT9.txt', 'sub/aux.md', 'aux/file.md', 'conin$.md', 'com\u00b9.md']) assert.equal(cleanPath(bad), null, bad);
  for (const ok of ['console.md', 'auxiliary.md', 'notes/communication.md', 'com10.md', 'lpt.md', 'connect.txt']) assert.equal(cleanPath(ok), ok, ok);
});
