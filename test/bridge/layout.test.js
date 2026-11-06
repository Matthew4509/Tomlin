// Layout faults found in the real-app check, 5 Nov: footer buttons clipped, project names squeezed at 821-1100 px.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const css = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'bridge', 'app.css'), 'utf8');
let bad = 0;
function ok(name, fn) { try { fn(); console.log('ok   ' + name); } catch (e) { bad++; console.log('FAIL ' + name + ': ' + e.message); } }
ok('the dialog footer wraps its buttons instead of clipping them', () => {
  const m = css.match(/\.dlg-foot\{([^}]*)\}/);
  assert.ok(m && /flex-wrap:\s*wrap/.test(m[1]));
});
ok('at 1100px and under the action buttons take their own line, so the name keeps its room', () => {
  const i = css.indexOf('@media (max-width:1100px){');
  const block = css.slice(i, css.indexOf('@media (max-width:820px)', i));
  assert.ok(/\.row\{grid-template-columns:minmax\(0,1fr\) 92px 158px\}/.test(block.replace(/\s+/g, ' ').replace(/ ?\{ ?/g, '{').replace(/ ?\} ?/g, '}')) || /\.row,\.list-head\{grid-template-columns:minmax\(0,1fr\) 92px 158px\}/.test(block));
  assert.ok(/\.row \.acts\{[^}]*grid-column:\s*1\s*\/\s*-1/.test(block));
});
if (bad) { console.log(bad + ' FAILED'); process.exit(1); }
