// The top bar's meters (public/app.js): this PC's row and the linked PC's row each open and fold on their own.
// Run: node --test test/metersfold.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('this PC\'s meters and the linked PC\'s meters fold apart, each kept in its own setting', () => {
  // The linked PC's row (inside #bar-node) has its own key; this PC's keeps the old one, so its choice is kept.
  assert.match(app, /const keyOf = box => \(box\.closest\('#bar-node'\) \? `\$\{METERS_KEY\}-node` : METERS_KEY\);/);
  assert.match(app, /localStorage\.setItem\(keyOf\(box\), metersOpen\(box\) \? 'folded' : 'open'\);/);
  assert.match(app, /box\.dataset\.folded !== '1' && metersOpen\(box\)/);
  // A press redraws only its own row, never every row.
  assert.doesNotMatch(app, /for \(const m of document\.querySelectorAll\('\.meters'\)\) drawMetersFold\(m\);/);
});
