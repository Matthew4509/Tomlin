// Home: Developer notes above Recent projects, naming what may be phased out, each still opening from there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f: string) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('Developer notes sit above Recent projects: Possibly phasing out, then Bridge, Planner and Jobs', () => {
  const html = read('index.html');
  const notes = html.indexOf('id="home-devnotes"');
  assert.ok(notes > 0 && notes < html.indexOf('id="home-ready-box"'), 'above Recent projects');
  const box = html.slice(notes, html.indexOf('</section>', notes));
  assert.match(box, /<h3 id="home-devnotes-title">Developer notes<\/h3>/);
  assert.doesNotMatch(box.split('\n')[0], /hidden/, 'shown with or without recent projects');
  assert.match(box, /<span>Possibly phasing out:<\/span>\s*<a class="btn" href="\/bridge\/" id="devnotes-bridge">Bridge<\/a>\s*<button class="btn" type="button" id="devnotes-planner">Planner<\/button>\s*<button class="btn" type="button" id="devnotes-jobs">Jobs<\/button>/);
  const view = read('homeview.js');
  assert.match(view, /\$\('#devnotes-planner'\)\.addEventListener\('click', \(\) => \$\('#project-open'\)\.click\(\)\);/);
  // Plan as a job is gone from the Home form, kept hidden so Planner still opens through it.
  assert.match(read('index.html'), /<button class="btn home-advanced" type="button" id="project-open" hidden /);
  assert.match(view, /\$\('#devnotes-jobs'\)\.addEventListener\('click', \(\) => \$\('#jobs-open'\)\.click\(\)\);/);
});
