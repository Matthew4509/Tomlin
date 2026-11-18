import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculate, cellNumber, csvRows, evaluate, parseDay, parseWhere, showNumber, tableStats } from '../src/sums.ts';

test('the calculator works sums out in the right order, with brackets, powers and the named helpers', () => {
  assert.equal(evaluate('1 + 2 * 3'), 7);
  assert.equal(evaluate('(1 + 2) * 3'), 9);
  assert.equal(evaluate('2 ^ 3 ^ 2'), 512, 'a power of a power is read from the right');
  assert.equal(evaluate('-3 + 10 % 4'), -1);
  assert.equal(evaluate('round(17 / 3, 2)'), 5.67);
  assert.equal(evaluate('sum(1, 2, 3) + avg(2, 4) + max(1, 200) - min(5, 3)'), 6 + 3 + 200 - 3);
  assert.equal(evaluate('sqrt(144) * 2 × 3 ÷ 4'), 18);
  assert.equal(calculate('0.1 + 0.2').text, '0.1 + 0.2 = 0.3', 'no 0.30000000000000004');
  assert.equal(calculate('(1250 * 0.2) + 40').text, '(1250 * 0.2) + 40 = 290');
  assert.equal(showNumber(1234567.5), '1234567.5');
});

test('the calculator counts days and moves dates, by the calendar', () => {
  assert.equal(evaluate('days(2026-01-05, 2026-03-01)'), 55);
  assert.equal(evaluate('2026-03-01 - 2026-01-05'), 55);
  assert.equal(calculate('add_days(2026-11-10, 45)').text, 'add_days(2026-11-10, 45) = 2026-12-25 (a Friday)');
  assert.equal(calculate('add_months(2026-01-31, 1)').text, 'add_months(2026-01-31, 1) = 2026-02-28 (a Saturday)', 'the end of a shorter month');
  assert.equal(calculate('weekday(2026-11-10)').text, 'weekday(2026-11-10) = 2 (Tuesday)');
  assert.equal(calculate('2026-11-10 + 7').text, '2026-11-10 + 7 = 2026-11-17 (a Tuesday)');
  assert.equal(parseDay('2026-02-30'), null, 'a day that is not in the calendar');
});

test('the calculator runs no code and says plainly what it cannot read', () => {
  for (const bad of ['process.exit(1)', 'require("fs")', 'a = 1', '1; 2', 'constructor', '[1,2]', '`x`', '1 +', '(1 + 2', 'sqrt', 'days(1, 2)', '2026-02-30 + 1', '5 / 0', 'unknown(3)']) {
    const r = calculate(bad);
    assert.equal(r.ok, false, bad);
    assert.match(r.text, /^Not worked out: /, bad);
  }
  assert.equal(calculate('').ok, false);
  assert.equal(calculate('1+'.repeat(300) + '1').ok, false, 'too long');
  assert.equal(calculate(42).ok, false);
});

test('a CSV text is read into rows: quoted cells, doubled quotes, semicolons or tabs', () => {
  assert.deepEqual(csvRows('a,b\n"x, y","say ""hi"""\n\n1,2\n'), [['a', 'b'], ['x, y', 'say "hi"'], ['1', '2']]);
  assert.deepEqual(csvRows('a;b\r\n1;2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(csvRows('﻿a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
  assert.equal(csvRows('a\n1\n2\n3', 2).length, 2, 'the most rows asked for');
});

test('a cell is a number in the ways people write one', () => {
  assert.equal(cellNumber('1,234.50'), 1234.5);
  assert.equal(cellNumber('£12'), 12);
  assert.equal(cellNumber('15%'), 15);
  assert.equal(cellNumber('(200)'), -200);
  assert.equal(cellNumber('-0.5'), -0.5);
  for (const no of ['', 'n/a', '12 apples', '1,23', '2026-11-10']) assert.equal(cellNumber(no), null, no);
});

test('a table is counted, totalled and averaged here, by column, and by rows that pass a test', () => {
  const rows = csvRows('Region,Sales,Note\nNorth,100,ok\nSouth,250,late\nNorth,50,\nEast,n/a,ok\n');
  const all = tableStats(rows);
  assert.equal(all.ok, true);
  assert.match(all.text, /^4 rows \(of 4\), 3 columns: Region, Sales, Note\./);
  assert.match(all.text, /Sales: count 3, total 400, average 133\.3333333, smallest 50, largest 250 \(1 cell is not a number and left out\)\./);
  assert.doesNotMatch(all.text, /Region:|Note:/, 'columns of words are not summed');
  const north = tableStats(rows, { column: 'sales', where: parseWhere('Region = north') });
  assert.match(north.text, /^2 rows where Region = north \(of 4\)/);
  assert.match(north.text, /Sales: count 2, total 150, average 75, smallest 50, largest 100\./);
  assert.match(tableStats(rows, { where: parseWhere('Sales >= 100') }).text, /^2 rows where Sales >= 100/);
  assert.match(tableStats(rows, { column: 'Region' }).text, /Region: not a column of numbers/);
  assert.equal(tableStats(rows, { column: 'Profit' }).ok, false);
  assert.match(tableStats(rows, { column: 'Profit' }).text, /no column called "Profit". The columns are: Region, Sales, Note/);
  assert.equal(tableStats(rows, { where: parseWhere('Nope = 1') }).ok, false);
  assert.equal(tableStats([['a']]).ok, false, 'headings alone');
  assert.equal(parseWhere('no sign here'), null);
  assert.deepEqual(parseWhere('Total<=  "10"'), { column: 'Total', op: '<=', value: '10' });
});
