// The Project tab on the right of the chat (public/projecttab.js): the open chat's project, its chats by kind of work
// and person, a press opens one, and a short word when something is happening there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f: string) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const js = read('projecttab.js');
/** A function of projecttab.js by name, taken out of the page's source and made callable here. */
function take<T>(name: string): T {
  const at = js.indexOf(`function ${name}(`);
  const end = js.indexOf('\n  }\n', at) + 4;
  return new Function(`${js.slice(at, end)}; return ${name};`)() as T;
}

type Chat = { id: string; who: string; name: string; title: string; project?: string; roleId?: string; roleKind?: string; role?: string; updated?: string; pinned?: boolean };
type Group = { id: string; name: string; people: { who: string; name: string; roleId: string; role: string; chats: Chat[] }[] };
const projectGroups = take<(chats: Chat[], project: string) => Group[]>('projectGroups');
const chatStateWord = take<(id: string, known?: object) => string>('chatStateWord');

const chat = (id: string, who: string, name: string, roleId: string, o: Partial<Chat> = {}): Chat =>
  ({ id, who, name, title: `Chat ${id}`, project: 'p1', roleId, roleKind: roleId === 'artist' || roleId === 'designer' ? 'image' : roleId === 'videographer' ? 'video' : roleId ? 'chat' : '', role: roleId, updated: `2026-11-0${id.length}T10:00:00Z`, ...o });

test('a project\'s chats are grouped by kind of work in a fixed order, then by person, with every chat under them', () => {
  const chats = [
    chat('v1', 'staff:v', 'Quill', 'videographer', { role: 'Videographer' }),
    chat('w1', 'staff:w', 'Bramble', 'writer', { role: 'Writer' }),
    chat('c1', 'staff:c', 'Nettle', 'coder'),
    chat('a1', 'staff:a', 'Juniper', 'artist', { role: 'Artist · draws what you ask' }),
    chat('d1', 'staff:d', 'Alder', 'designer'),
    chat('g1', 'staff:g', 'Sorrel', 'agent'),
    chat('h1', 'manager', 'The host', ''),
    chat('x1', 'staff:w', 'Bramble', 'writer', { project: 'other' }),
    chat('n1', 'staff:n', 'Rowan', 'default', { project: undefined }),
  ];
  const groups = projectGroups(chats, 'p1');
  assert.deepEqual(groups.map(k => k.name), ['Writing', 'Code', 'Pictures', 'Videos', 'Agents']);
  // Writing holds the writer and the host (a role not listed); Pictures the artist and the designer, by name.
  assert.deepEqual(groups[0].people.map(p => p.name), ['Bramble', 'The host']);
  assert.deepEqual(groups[2].people.map(p => p.name), ['Alder', 'Juniper']);
  assert.equal(groups[2].people[1].role, 'Artist');
  // One chat each is still listed under the person; chats in another project or in none are left out.
  assert.deepEqual(groups[0].people[0].chats.map(c => c.id), ['w1']);
  assert.equal(groups.flatMap(k => k.people.flatMap(p => p.chats)).length, 7);
  // No project: nothing.
  assert.deepEqual(projectGroups(chats, ''), []);
});

test('a person\'s chats are pinned first, then newest first; a kind with no chats is left out', () => {
  const chats = [
    chat('a', 'staff:w', 'Bramble', 'writer', { updated: '2026-11-01T00:00:00Z' }),
    chat('b', 'staff:w', 'Bramble', 'writer', { updated: '2026-11-03T00:00:00Z' }),
    chat('c', 'staff:w', 'Bramble', 'writer', { updated: '2026-11-02T00:00:00Z', pinned: true }),
  ];
  const groups = projectGroups(chats, 'p1');
  assert.deepEqual(groups.map(k => k.id), ['writing']);
  assert.deepEqual(groups[0].people[0].chats.map(c => c.id), ['c', 'b', 'a']);
});

test('the state word: a shot being made, a picture drawing, an answer coming, waiting for you, or nothing', () => {
  const list = { run: 'running', shots: [{ n: 1, state: 'done' }, { n: 2, state: 'done' }, { n: 3, state: 'making' }, ...Array.from({ length: 9 }, (_, i) => ({ n: 4 + i, state: 'waiting' }))] };
  assert.equal(chatStateWord('v1', { shots: list }), 'making shot 3 of 12');
  assert.equal(chatStateWord('a1', { answering: [{ chat: 'a1', what: 'picture' }] }), 'drawing a picture');
  assert.equal(chatStateWord('w1', { answering: [{ chat: 'w1', what: 'answer' }] }), 'answering');
  assert.equal(chatStateWord('w1', { waiting: [{ chat: 'w1' }] }), 'waiting for you');
  assert.equal(chatStateWord('v1', { shots: { run: 'paused', shots: [{ n: 1, state: 'waiting' }] } }), 'shot list paused');
  assert.equal(chatStateWord('w1', { answering: [{ chat: 'other', what: 'answer' }] }), '');
  assert.equal(chatStateWord('w1'), '');
});

test('the tab: Open project, a press opens the chat, the open one is marked, a new chat in the project, a chat in none', () => {
  assert.match(js, /text: planned \? 'Open project' : 'Make the plan'/);
  assert.match(js, /onclick: \(\) => \(planned \? app\.openJob\(p\.id\) : app\.planProject\(p\.id, p\.goal \|\| p\.name\)\)/);
  assert.match(js, /'aria-current': here \? 'true' : null[^\n]*onclick: \(\) => app\.openChat\(c\.id\)/);
  assert.match(js, /text: '\+ New chat in this project'[^\n]*onclick: \(\) => \$\('#rail-new'\)\.click\(\)/);
  assert.match(js, /text: 'This chat is in Default: no project of its own, so what it saves goes in its own folder.'/);
  assert.match(js, /text: 'Put this chat in a project'/);
  // The shot lists are read at most every 15 s, and only while the tab (or the fold under a shot list) is shown.
  assert.match(js, /const SHOT_EVERY = 15_000;/);
  assert.match(js, /if \(!shown\) return;/);
  const html = read('index.html');
  assert.match(html, /<div class="side-panel side-project" role="tabpanel" id="panel-project" aria-labelledby="tab-project"><\/div>/);
  assert.match(html, /<details class="side-fold shot-project" id="shot-project" hidden>/);
  assert.ok(html.indexOf('<script src="projecttab.js"></script>') > html.indexOf('<script src="shots.js"></script>'));
  assert.ok(html.indexOf('<script src="projecttab.js"></script>') > html.indexOf('<script src="team.js"></script>'));
  // The tab's words: no "Staff overview" left in the chat's panel.
  const aside = html.slice(html.indexOf('<aside class="subjects"'), html.indexOf('</aside>'));
  assert.doesNotMatch(aside, /Staff overview|staff overview/);
  assert.match(read('shots.js'), /'Project \| Tools \| Office'/);
  assert.match(read('style.css'), /\.pt-chat\[aria-current="true"\] \{[^}]*font-weight: 600;/);
});
