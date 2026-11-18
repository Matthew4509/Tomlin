// Draws chart.svg from results.csv (rows with chart=yes): writing speed in tokens a second, one group of bars per model,
// one bar per PC or setup. Run it again after adding rows:   node benchmarks/make-chart.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** A small CSV reader: commas, "quoted, fields" and "" for a quote inside one. */
function csv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(x => x !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return body.map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

const rows = csv(readFileSync(join(here, 'results.csv'), 'utf8')).filter(r => r.chart === 'yes');
// Colour-blind-safe set (Okabe and Ito); a bar is also labelled with its number, so colour is never the only cue.
const SERIES = [
  ['Main PC (Quadro P2000)', '#0072B2'],
  ['800 G1 (Quadro K1200)', '#E69F00'],
  ['Z820 (CPU only)', '#009E73'],
  ['Max mode split (Main PC + 800 G1)', '#CC79A7'],
];
const extra = [...new Set(rows.map(r => r.series))].filter(s => !SERIES.some(x => x[0] === s));
const palette = ['#56B4E9', '#D55E00', '#F0E442', '#999999'];
extra.forEach((s, i) => SERIES.push([s, palette[i % palette.length]]));

// Models, smallest file first.
const models = [...new Map(rows.map(r => [r.model, Number(r.file_gb)])).entries()].sort((a, b) => a[1] - b[1]).map(([m]) => m);
const present = SERIES.filter(([s]) => rows.some(r => r.series === s));

const W = 940, left = 300, right = 70, top = 96, barH = 15, gap = 3, groupGap = 14;
const max = Math.ceil(Math.max(...rows.map(r => Number(r.tokens_per_s))) / 10) * 10 || 10;
const scale = (W - left - right) / max;
let y = top;
const out = [];
for (const m of models) {
  const mine = present.map(([s, col]) => [s, col, rows.find(r => r.model === m && r.series === s)]).filter(x => x[2]);
  const h = mine.length * (barH + gap);
  out.push(`<text x="${left - 12}" y="${y + h / 2 + 4}" text-anchor="end" class="m">${esc(m)}</text>`);
  for (const [s, col, r] of mine) {
    const v = Number(r.tokens_per_s);
    out.push(`<rect x="${left}" y="${y}" width="${Math.max(1, v * scale).toFixed(1)}" height="${barH}" rx="2" fill="${col}"><title>${esc(`${s}: ${v} tokens a second (${r.setup})`)}</title></rect>`);
    out.push(`<text x="${left + v * scale + 6}" y="${y + barH - 3}" class="v">${r.tokens_per_s}</text>`);
    y += barH + gap;
  }
  y += groupGap;
}
const H = y + 30;
const ticks = [];
for (let t = 0; t <= max; t += max > 40 ? 10 : 5) {
  ticks.push(`<line x1="${left + t * scale}" y1="${top - 8}" x2="${left + t * scale}" y2="${y - groupGap + 4}" class="g"/><text x="${left + t * scale}" y="${top - 14}" text-anchor="middle" class="a">${t}</text>`);
}
let lx = left, ly = 34;
const key = present.map(([s, col]) => {
  const w = 26 + s.length * 6.2;
  if (lx + w > W - 10) { lx = left; ly += 18; }
  const g = `<rect x="${lx}" y="${ly - 10}" width="12" height="12" rx="2" fill="${col}"/><text x="${lx + 18}" y="${ly}" class="l">${esc(s)}</text>`;
  lx += w + 12;
  return g;
}).join('');
const height = H + (ly > 34 ? 18 : 0);
writeFileSync(join(here, 'chart.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${height}" width="${W}" role="img" aria-label="Writing speed in tokens a second for each model on each PC">
<style>
text{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;fill:#222}
.m{font-size:13px}.v{font-size:12px;font-weight:600}.a{font-size:11px;fill:#666}.l{font-size:12px}.t{font-size:15px;font-weight:700}
.g{stroke:#bbb;stroke-width:1;stroke-dasharray:2 3}
@media (prefers-color-scheme: dark){text{fill:#e6e6e6}.a{fill:#aaa}.g{stroke:#555}}
</style>
<text x="20" y="22" class="t">Writing speed, tokens a second (higher is better)</text>
${key}
${ticks.join('\n')}
${out.join('\n')}
<text x="${left}" y="${height - 8}" class="a">tokens a second while writing, from TOMLIN's own measurement. Sources: benchmarks/results.csv</text>
</svg>
`);
console.log(`chart.svg: ${models.length} models, ${present.length} series, ${rows.length} bars`);

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
