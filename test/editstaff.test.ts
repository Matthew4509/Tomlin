// Edit staff in two pages (2.0.65): the three tabs (Look, Staff settings, PC settings) were one too many. Now the
// settings are one page, in the order they are used (Who, Works on, How they write, Memory), with the tokens folded at
// the foot beside Fire; the Look is a pop-up opened by the pencil on their picture. Read from the page's own files, as
// test/settingspages.test.ts does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const team = read('public/team.js');
const fn = (name: string) => {
  const at = team.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} is in team.js`);
  const next = team.indexOf('\nfunction ', at + 10);
  return team.slice(at, next < 0 ? undefined : next);
};

test('no tabs: one settings page, its parts in this order: Who, Works on, How they write, Memory, then Tokens and Fire', () => {
  assert.doesNotMatch(team, /settingsTab/);
  assert.doesNotMatch(team, /profile-tab/);
  assert.doesNotMatch(team, /'Staff settings'|'PC settings'/);
  const edit = fn('drawEdit');
  // On screen: the parts, then Memory (its list loads into its place), then the foot.
  const order = ["section('Who'", "section('Works on'", 'writingSection(m, section, { software: false })', '...body.filter(Boolean), memory, footer(m)'];
  let last = -1;
  for (const part of order) {
    const at = edit.indexOf(part);
    assert.ok(at > last, `${part} comes after the one before it`);
    last = at;
  }
  assert.ok(edit.includes("app.notebookList?.(`staff:${m.id}`, 'Memory', nbHint)"), 'Memory is their notebook');
  assert.ok(edit.includes('memory.replaceChildren(nb)'), 'it loads into its place before the foot');
  // Works on: the PC, the models, and the speed folded under one line (its chart and Find the fastest setup inside).
  assert.match(edit, /pcPicker\(m, sub\)/);
  assert.match(edit, /sub\('Models', modelOptions\(m\)\)/);
  assert.match(edit, /el\('details', \{ class: 'sub profile-speed-fold' \}/);
});

test('How they write keeps only the tone on this page (the software is under Works on, once)', () => {
  const w = fn('writingSection');
  assert.match(w, /function writingSection\(m, section, \{ software = true \} = \{\}\)/);
  assert.match(w, /return section\(software \? 'Software and tone' : 'How they write'/);
  assert.match(w, /software && brainChoices\(m\)\.length \?/);
});

test('the foot: tokens folded ("Tokens used"), and Fire beside them, not on the left under Talk', () => {
  const foot = fn('footer');
  assert.match(foot, /el\('details', \{ class: 'sub profile-tokens' \}, el\('summary', \{ text: tokensSummary\(m\) \}\)/);
  assert.match(foot, /usageSection\(m, \(_t, \.\.\.kids\) => el\('div', \{\}, \.\.\.kids\)\)/);
  assert.match(foot, /fireSection\(m\)/);
  assert.doesNotMatch(fn('drawPerson'), /fireSection\(m\)/);
  // Under their name: the speed only (the tokens are in the foot).
  const figures = fn('personFigures');
  assert.doesNotMatch(figures, /tokens`/);
  assert.match(figures, /speed not measured yet/);
});

test('the pencil on their picture opens the Look in a pop-up of its own, closed by its X or Esc', () => {
  const person = fn('drawPerson');
  assert.match(person, /pencilBtn\.addEventListener\('click', \(\) => lookPopup\(m\)\)/);
  const pop = fn('lookPopup');
  assert.match(pop, /el\('dialog', \{ class: 'look-pop', 'aria-labelledby': 'look-pop-title' \}/);
  assert.match(pop, /lookSection\(m, /);
  assert.match(pop, /box\.showModal\(\)/);
  assert.match(pop, /text: 'Close'/);
  assert.match(read('public/style.css'), /dialog\.look-pop \{/);
});

test('Help, the Models page hint and the README name the new layout, not the tabs', () => {
  assert.doesNotMatch(read('public/models.js'), /then PC settings/);
  assert.doesNotMatch(read('README.md'), /Look, Staff settings and PC settings tabs/);
  assert.ok(read('README.md').includes('Edit staff is one page (2.0.65; it had three tabs)'));
});
