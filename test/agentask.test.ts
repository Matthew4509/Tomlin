// N4 (27 Nov agents plan): Ask about a report and "Next run, also". The note goes into the next run's brief only (it
// is kept with the job, never in the recipe, so no approving again), and the page opens an ordinary chat with the
// Agent whose first line names the report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { brief } from '../src/agentrun.ts';
import { cleanJob, approvedNow } from '../src/agents.ts';
import { readRecipe, recipeHash } from '../src/recipe.ts';

const recipe = readRecipe('Name: Price check\nAgent: Robin\nWhen: Every day at 07:00\nTask: Note the price.\nTools: working notes').recipe;

test('the note is in the brief of the run that has it, and in no other', () => {
  const o = { recipe, agentName: 'Robin', memory: '', lastReport: '', by: 'its timer', ctx: 8192 };
  assert.match(brief({ ...o, note: 'Also check the delivery price.' }), /For this run only, the person also asks:\nAlso check the delivery price\./);
  assert.doesNotMatch(brief(o), /For this run only/);
});

test('the note and the phone tick are kept with the job, outside the recipe: it stays approved', () => {
  const j = cleanJob({ id: 'j1', recipe, approved: recipeHash(recipe), paused: false, next: [], seen: {}, nextNote: { text: `  ${'a'.repeat(700)}  `, at: '2026-11-27T07:00:00Z' }, phone: true, made: '', changed: '' })!;
  assert.equal(j.nextNote!.text.length, 600);
  assert.equal(j.phone, true);
  assert.equal(approvedNow(j), true);
  assert.equal(cleanJob({ id: 'j2', recipe, nextNote: { text: '   ' } })!.nextNote, undefined);
});

test('the page: Ask about this opens a new chat with the Agent, its first line naming the report; the note box says it is for one run', () => {
  const page = readFileSync(new URL('../public/agents.js', import.meta.url), 'utf8');
  assert.match(page, /app\.askAboutReport = async \(\{ agent, path, at, text \}\) =>/);
  // The report goes in as a document, the paperclip's way.
  assert.match(page, /app\.addDocs\(\[new File\(\[text\], name/);
  assert.match(readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), /\napp\.addDocs = addDocs;/);
  assert.match(page, /api\('\/api\/chats\/new', \{ who: `staff:\$\{agent\}` \}\)/);
  assert.match(page, /About your report\$\{when\} \(\$\{typeof text === 'string' && app\.addDocs \? `added to this chat as \$\{name\}` : `in the workspace: \$\{path\}`\}\): /);
  assert.match(page, /text: 'Ask about this'/);
  assert.match(page, /Given to the next run only, then cleared/);
  assert.match(page, /action: 'note', job: job\.id/);
});
