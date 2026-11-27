// The Agents page (public/agents.js), read from the page's own files: a page in the middle panel reached from the
// Settings list and from Home's line for a run; no browser pop-ups; 12px or more; the Agent role's spy icon.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f: string) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');

test('the Agents page is its own page, hidden unless on screen, not kept over a reload, and in the Settings list', () => {
  const html = read('index.html');
  assert.match(html, /<section class="nodes agents-page" id="agents-page" data-crumb="Agents" aria-labelledby="agents-page-title">/);
  assert.ok(html.indexOf('<script src="agents.js"></script>') > html.indexOf('<script src="team.js"></script>'));
  assert.match(html, /data-setup="agents"[^>]*>.*Agents<\/button>/);
  assert.match(read('style.css'), /\.shell:not\(\[data-view="agents"\]\) > #agents-page \{ display: none; \}/);
  const home = read('home.js');
  assert.match(home, /view !== 'agents'/);
  assert.match(home, /agents: '#agents-page'/);
  assert.match(read('homeview.js'), /b\.dataset\.setup === 'agents'\) app\.openAgents/);
  assert.match(read('homeview.js'), /x\.agent && app\.agentCard/);
});

test('the page asks on the page, never in a browser pop-up, and its new styles are 12px or more', () => {
  const page = read('agents.js');
  assert.doesNotMatch(page, /\b(alert|confirm|prompt)\(/);
  assert.match(page, /Approve and save/);
  const css = read('style.css');
  const ours = css.slice(css.indexOf('/* ---- Agents (public/agents.js) ---- */'));
  for (const m of ours.matchAll(/font-size:\s*(\d+)px/g)) assert.ok(Number(m[1]) >= 12, m[0]);
});

test('the Agent role has its own icon, a spy with a hat and glasses', () => {
  assert.match(read('team.js'), /\/\/ A spy: a hat with a brim over round glasses[^\n]*\n\s+agent: 'M/);
});

/** The short form's field helpers from agents.js, run on their own. */
function formFields(): { fieldGet: (t: string, f: string) => string; fieldSet: (t: string, f: string, v: string) => string } {
  const page = read('agents.js');
  const src = page.slice(page.indexOf('  const FIELD_WORDS = '), page.indexOf('  app.agentFields = { fieldGet, fieldSet };'));
  return new Function(`${src}; return { fieldGet, fieldSet };`)();
}

test('New standing job is a short form (Name, Agent, When, Task) written into the recipe, with Edit as text', async () => {
  const page = read('agents.js');
  assert.match(page, /tool\('add', 'New standing job', \(\) => openEdit\(null\)\)/);
  assert.doesNotMatch(page, /'New job'|`New job on/);
  assert.match(page, /text: e\.form \? 'Edit as text' : 'Back to the short form'/);
  assert.match(page, /e\.form \? formPart\(e, changed\) : box,/);
  const { fieldGet, fieldSet } = formFields();
  const blank = ['Name: ', 'Agent: Robin', 'When: Every weekday at 07:00', 'Task: ', 'Pages: ', 'Tools: web pages, working notes, calculate', 'Results: folder ""; keep 30 runs', 'Stop after: 20 rounds, 15 minutes, 40,000 words read', 'Wait at most: 60 minutes', 'Memory: no'].join('\n');
  let t = fieldSet(blank, 'Name', 'Morning price check');
  t = fieldSet(t, 'Task', 'Open the pages.\nWhat: say any price change.\nWrite a short summary.');
  t = fieldSet(t, 'When', 'Every 6 hours');
  assert.equal(fieldGet(t, 'Name'), 'Morning price check');
  assert.equal(fieldGet(t, 'Agent'), 'Robin');
  assert.equal(fieldGet(t, 'When'), 'Every 6 hours');
  assert.equal(fieldGet(t, 'Task'), 'Open the pages.\n- What: say any price change.\nWrite a short summary.');
  assert.equal(fieldGet(t, 'Tools'), 'web pages, working notes, calculate');
  // The rest of the recipe is untouched, and the server reads what the form wrote.
  assert.match(t, /\nPages: \nTools: web pages, working notes, calculate\nResults: folder ""; keep 30 runs\n/);
  const { readRecipe } = await import('../src/recipe.ts');
  const r = readRecipe(t).recipe;
  assert.equal(r.name, 'Morning price check');
  assert.equal(r.agent, 'Robin');
  assert.deepEqual(r.when, [{ kind: 'hours', hours: 6 }]);
  assert.equal(r.task, 'Open the pages.\n- What: say any price change.\nWrite a short summary.');
  // A field not there yet goes in the usual order (after the fields above it).
  assert.equal(fieldSet('Agent: Robin\nTools: notes', 'Name', 'Check'), 'Name: Check\nAgent: Robin\nTools: notes');
  assert.equal(fieldSet('Name: A\nTools: notes', 'Task', 'Do it'), 'Name: A\nTask: Do it\nTools: notes');
});

test('with no standing job the Starters come first, and with no Agent the page has Hire an Agent', () => {
  const page = read('agents.js');
  assert.match(page, /const parts = \[!d\.jobs\.length && ag\.help\?\.starters\?\.length \? startersPart\(\) : '', /);
  assert.match(page, /text: 'No standing jobs yet\. First hire an Agent \(Hire staff, role Agent\), then press New standing job\.'/);
  assert.match(page, /text: 'Hire an Agent', onclick: \(\) => app\.openHire\?\.\(\{ role: 'agent' \}\)/);
});

test('Help has a page for Agents (recipe fields, Check, approving, holds, reports, a linked PC) and Memory is about the editor', () => {
  const help = (f: string) => read(`help/${f}`);
  const agents = help('agents.html');
  for (const h of ['agents-new', 'agents-recipe', 'agents-check', 'agents-held', 'agents-reports', 'agents-node']) assert.match(agents, new RegExp(`<h2 id="${h}">`), h);
  for (const f of ['Name', 'Agent', 'Runs on', 'When', 'Task', 'Pages', 'Tools', 'Results', 'Stop after', 'Wait at most', 'Memory']) assert.match(agents, new RegExp(`<li><b>${f}</b>: `), f);
  assert.match(agents, /<b>Approve and save<\/b> is the only permission the job has/);
  assert.match(agents, /<b>Allow next time<\/b>/);
  assert.match(agents, /<code>report\.md<\/code>/);
  assert.match(help('topics.js'), /\{ id: 'agents', group: 'staff', title: 'Agents: standing jobs'/);
  assert.match(help('index.html'), /<li><a href="agents\.html"><b>Agents: standing jobs<\/b>/);
  assert.match(help('first-steps.html'), /Agents \(<a href="agents\.html">standing jobs<\/a>\), <a href="memory\.html">Memory<\/a>, Models,/);
  const memory = help('memory.html');
  for (const h of ['memory-editor', 'memory-list', 'memory-search', 'memory-files', 'memory-inbox', 'memory-gets']) assert.match(memory, new RegExp(`<h2 id="${h}">`), h);
  assert.match(memory, /<code>data\\memory<\/code>: <code>team\.md<\/code> for the team/);
  assert.match(memory, /<b>Open file<\/b> opens the notebook in Notepad/);
  assert.match(memory, /changing an entry's words in the file makes it yours: it then shows as written by you, even if a model suggested it first/);
  assert.doesNotMatch(memory, /under the chat box/);
  // No gendered words for hires in either page.
  for (const t of [agents, memory]) assert.doesNotMatch(t, /\b(he|she|him|her|his|hers|himself|herself)\b/i);
});
