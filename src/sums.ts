// Sums for a model that gets arithmetic and dates wrong: a calculator that reads one expression (no code is run:
// the expression is parsed here, a name that is not on the list is refused) and a table reader that counts, adds and
// averages the columns of a CSV text. Plain parts, tested in test/sums.test.ts.

export const EXPR_MAX = 400;

type Val = number | Date;
type Tok = { k: 'num'; v: number } | { k: 'date'; v: Date } | { k: 'name'; v: string } | { k: 'op'; v: string };

const day = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** A date written year-month-day (2026-11-10), or null. A day that is not in the calendar (2026-02-30) is null. */
export function parseDay(s: string): Date | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? d : null;
}

function tokens(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    const date = /^["']?(\d{4}-\d{1,2}-\d{1,2})["']?/.exec(src.slice(i));
    if (date) {
      const d = parseDay(date[1]);
      if (!d) throw new Error(`"${date[1]}" is not a date in the calendar`);
      out.push({ k: 'date', v: d });
      i += date[0].length;
      continue;
    }
    // No commas inside a number: a comma parts two values (min(1,200) is two numbers), so 1,200 is written 1200.
    const num = /^(\d+\.?\d*(e[+-]?\d+)?|\.\d+)/i.exec(src.slice(i));
    if (num) {
      out.push({ k: 'num', v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const name = /^[a-z_][a-z0-9_]*/i.exec(src.slice(i));
    if (name) {
      out.push({ k: 'name', v: name[0].toLowerCase() });
      i += name[0].length;
      continue;
    }
    if ('+-*/^%(),'.includes(c)) { out.push({ k: 'op', v: c }); i++; continue; }
    if (c === '×') { out.push({ k: 'op', v: '*' }); i++; continue; }
    if (c === '÷') { out.push({ k: 'op', v: '/' }); i++; continue; }
    throw new Error(`"${c}" is not something a sum can hold`);
  }
  return out;
}

const num = (v: Val, what: string): number => {
  if (typeof v !== 'number') throw new Error(`${what} needs a number, not a date`);
  return v;
};
const date = (v: Val, what: string): Date => {
  if (!(v instanceof Date)) throw new Error(`${what} needs a date written year-month-day, like 2026-11-10`);
  return v;
};

const FUNCS: Record<string, (a: Val[]) => Val> = {
  sqrt: a => Math.sqrt(num(a[0], 'sqrt')),
  abs: a => Math.abs(num(a[0], 'abs')),
  floor: a => Math.floor(num(a[0], 'floor')),
  ceil: a => Math.ceil(num(a[0], 'ceil')),
  round: a => {
    const p = 10 ** (a.length > 1 ? num(a[1], 'round') : 0);
    return Math.round((num(a[0], 'round') + Number.EPSILON) * p) / p;
  },
  min: a => Math.min(...a.map(x => num(x, 'min'))),
  max: a => Math.max(...a.map(x => num(x, 'max'))),
  sum: a => a.reduce<number>((s, x) => s + num(x, 'sum'), 0),
  avg: a => a.reduce<number>((s, x) => s + num(x, 'avg'), 0) / a.length,
  /** Whole days from the first date to the second. */
  days: a => Math.round((date(a[1], 'days').getTime() - date(a[0], 'days').getTime()) / 86_400_000),
  add_days: a => new Date(date(a[0], 'add_days').getTime() + Math.round(num(a[1], 'add_days')) * 86_400_000),
  add_months: a => {
    const d = date(a[0], 'add_months');
    const n = Math.round(num(a[1], 'add_months'));
    const to = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
    const last = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() + 1, 0)).getUTCDate();
    return new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), Math.min(d.getUTCDate(), last)));
  },
  /** 0 Sunday to 6 Saturday; the answer names the day as well. */
  weekday: a => date(a[0], 'weekday').getUTCDay(),
};
const NEEDS: Record<string, [number, number]> = { sqrt: [1, 1], abs: [1, 1], floor: [1, 1], ceil: [1, 1], round: [1, 2], min: [1, 99], max: [1, 99], sum: [1, 99], avg: [1, 99], days: [2, 2], add_days: [2, 2], add_months: [2, 2], weekday: [1, 1] };

/** The value of one expression. Throws, in plain words, on anything it cannot read. */
export function evaluate(src: string): Val {
  const t = tokens(src);
  let i = 0;
  const peek = (v: string) => t[i]?.k === 'op' && t[i].v === v;
  const expr = (): Val => {
    let a = term();
    while (peek('+') || peek('-')) {
      const op = t[i++].v as string;
      const b = term();
      if (a instanceof Date && typeof b === 'number') a = new Date(a.getTime() + (op === '+' ? 1 : -1) * Math.round(b) * 86_400_000);
      else if (a instanceof Date && b instanceof Date && op === '-') a = Math.round((a.getTime() - b.getTime()) / 86_400_000);
      else a = op === '+' ? num(a, 'A plus') + num(b, 'A plus') : num(a, 'A minus') - num(b, 'A minus');
    }
    return a;
  };
  const term = (): Val => {
    let a = power();
    while (peek('*') || peek('/') || peek('%')) {
      const op = t[i++].v as string;
      const b = num(power(), 'A sum');
      const x = num(a, 'A sum');
      if (op !== '*' && b === 0) throw new Error('a number cannot be divided by zero');
      a = op === '*' ? x * b : op === '/' ? x / b : x % b;
    }
    return a;
  };
  const power = (): Val => {
    const a = unary();
    if (!peek('^')) return a;
    i++;
    return num(a, 'A power') ** num(power(), 'A power');
  };
  const unary = (): Val => {
    if (peek('-')) { i++; return -num(unary(), 'A minus'); }
    if (peek('+')) { i++; return unary(); }
    return atom();
  };
  const atom = (): Val => {
    const k = t[i++];
    if (!k) throw new Error('the sum ends too soon');
    if (k.k === 'num' || k.k === 'date') return k.v;
    if (k.k === 'op' && k.v === '(') {
      const v = expr();
      if (!peek(')')) throw new Error('a bracket is not closed');
      i++;
      return v;
    }
    if (k.k === 'name') {
      if (k.v === 'pi') return Math.PI;
      const f = FUNCS[k.v];
      if (!f) throw new Error(`"${k.v}" is not known. The names are: ${Object.keys(FUNCS).join(', ')}, pi`);
      if (!peek('(')) throw new Error(`${k.v} needs brackets, like ${k.v}(...)`);
      i++;
      const args: Val[] = [];
      if (!peek(')')) {
        args.push(expr());
        while (peek(',')) { i++; args.push(expr()); }
      }
      if (!peek(')')) throw new Error('a bracket is not closed');
      i++;
      const [lo, hi] = NEEDS[k.v];
      if (args.length < lo || args.length > hi) throw new Error(`${k.v} takes ${lo === hi ? lo : `${lo} or more`} value${hi === 1 ? '' : 's'}`);
      return f(args);
    }
    throw new Error(`"${k.v}" is in the wrong place`);
  };
  const v = expr();
  if (i < t.length) throw new Error(`"${t[i].v}" is in the wrong place`);
  return v;
}

/** A number as a person writes it: at most 10 significant figures, no trailing noughts, no 0.30000000000000004. */
export function showNumber(n: number): string {
  if (!Number.isFinite(n)) throw new Error('the answer is not a number (too large, or not defined)');
  const r = Number(n.toPrecision(10));
  return Math.abs(r) >= 1e15 || (r !== 0 && Math.abs(r) < 1e-6) ? String(r) : r.toLocaleString('en-GB', { maximumFractionDigits: 10, useGrouping: false });
}

/** The calculator's answer as one line for the model, or why not. */
export function calculate(raw: unknown): { ok: boolean; text: string } {
  const src = typeof raw === 'string' ? raw.trim() : '';
  if (!src) return { ok: false, text: 'Not worked out: give the sum, like (1250 * 0.2) + 40 or days(2026-01-05, 2026-03-01).' };
  if (src.length > EXPR_MAX) return { ok: false, text: `Not worked out: a sum is at most ${EXPR_MAX} characters.` };
  try {
    const v = evaluate(src);
    if (v instanceof Date) return { ok: true, text: `${src} = ${day(v)} (a ${DAYS[v.getUTCDay()]})` };
    const wd = /^\s*weekday\s*\(/i.test(src) ? ` (${DAYS[v]})` : '';
    return { ok: true, text: `${src} = ${showNumber(v)}${wd}` };
  } catch (e) {
    return { ok: false, text: `Not worked out: ${(e as Error).message}. Numbers, + - * / ^ %, brackets, and: sqrt, abs, round(x, places), floor, ceil, min, max, sum, avg, days(date, date), add_days(date, n), add_months(date, n), weekday(date). Dates are written 2026-11-10.` };
  }
}

/** A CSV text as rows of cells: quoted cells, doubled quotes, commas or semicolons or tabs (whichever the first line has most of). */
export function csvRows(text: string, most = 20_000): string[][] {
  const src = text.replace(/^﻿/, '');
  const first = src.slice(0, src.search(/\r?\n|$/));
  const count = (ch: string) => first.split(ch).length - 1;
  const sep = count('\t') > count(',') && count('\t') >= count(';') ? '\t' : count(';') > count(',') ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some(x => x.trim())) rows.push(row);
      row = [];
      if (rows.length >= most) return rows;
    } else cell += c;
  }
  row.push(cell);
  if (row.some(x => x.trim())) rows.push(row);
  return rows;
}

/** A cell as a number: 1,234.50, £12, 15%, (200) for minus 200. Null when it is not one. */
export function cellNumber(cell: string): number | null {
  let s = cell.trim();
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s);
  s = s.replace(/^\(|\)$/g, '').replace(/^[£$€]\s*/, '').replace(/\s*%$/, '');
  if (!/^-?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$|^-?\.\d+$/.test(s)) return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

export interface Where { column: string; op: '=' | '!=' | '>' | '<' | '>=' | '<='; value: string }

/** "Region = North", "Total >= 100": one test on one column, or null. */
export function parseWhere(raw: unknown): Where | null {
  const m = /^\s*(.+?)\s*(>=|<=|!=|=|>|<)\s*(.+?)\s*$/.exec(typeof raw === 'string' ? raw : '');
  return m ? { column: m[1], op: m[2] as Where['op'], value: m[3].replace(/^["']|["']$/g, '') } : null;
}

/**
 * What a table holds, worked out here: how many rows, and for each column of numbers its count, total, average,
 * smallest and largest. `column`: only that one. `where`: only the rows that pass one test. The first row is the headings.
 */
export function tableStats(rows: string[][], o: { column?: string; where?: Where | null } = {}): { ok: boolean; text: string } {
  if (rows.length < 2) return { ok: false, text: 'Not worked out: the table needs a row of headings and at least one row under it.' };
  const head = rows[0].map(h => h.trim());
  const find = (name: string) => head.findIndex(h => h.toLowerCase() === name.trim().toLowerCase());
  let body = rows.slice(1);
  let filtered = '';
  if (o.where) {
    const at = find(o.where.column);
    if (at < 0) return { ok: false, text: `Not worked out: there is no column called "${o.where.column}". The columns are: ${head.join(', ')}.` };
    const w = o.where;
    const want = cellNumber(w.value);
    body = body.filter(r => {
      const cell = (r[at] ?? '').trim();
      const n = cellNumber(cell);
      if (w.op === '=') return want !== null && n !== null ? n === want : cell.toLowerCase() === w.value.toLowerCase();
      if (w.op === '!=') return want !== null && n !== null ? n !== want : cell.toLowerCase() !== w.value.toLowerCase();
      if (want === null || n === null) return false;
      return w.op === '>' ? n > want : w.op === '<' ? n < want : w.op === '>=' ? n >= want : n <= want;
    });
    filtered = ` where ${head[at]} ${w.op} ${w.value}`;
  }
  const only = o.column ? find(o.column) : -1;
  if (o.column && only < 0) return { ok: false, text: `Not worked out: there is no column called "${o.column}". The columns are: ${head.join(', ')}.` };
  const lines = [`${body.length.toLocaleString('en-GB')} row${body.length === 1 ? '' : 's'}${filtered} (of ${(rows.length - 1).toLocaleString('en-GB')}), ${head.length} columns: ${head.join(', ')}.`];
  let any = false;
  for (const [c, name] of head.entries()) {
    if (only >= 0 && c !== only) continue;
    const nums = body.map(r => cellNumber(r[c] ?? '')).filter((n): n is number => n !== null);
    const filled = body.filter(r => (r[c] ?? '').trim()).length;
    // A column counts as numbers when most of its filled cells are; a few stray words are said, not hidden.
    if (!nums.length || nums.length < filled * 0.6) {
      if (only >= 0) lines.push(`${name}: not a column of numbers (${filled} filled cell${filled === 1 ? '' : 's'}, ${nums.length} of them numbers).`);
      continue;
    }
    any = true;
    const total = nums.reduce((s, n) => s + n, 0);
    lines.push(`${name}: count ${nums.length}, total ${showNumber(total)}, average ${showNumber(total / nums.length)}, smallest ${showNumber(Math.min(...nums))}, largest ${showNumber(Math.max(...nums))}${filled > nums.length ? ` (${filled - nums.length} cell${filled - nums.length === 1 ? ' is' : 's are'} not a number and left out)` : ''}.`);
  }
  if (!any && only < 0) lines.push('No column of numbers was found.');
  return { ok: true, text: lines.join('\n') };
}
