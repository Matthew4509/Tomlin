// The Bridge part's fault log never grows past BRIDGE_LOG_MAX: at the cap the file becomes <name>.old.log (the one
// before it is dropped) and a new one starts, so a fault repeating all night cannot fill the drive. At most twice the
// cap on disk. A line is cut at 8,000 characters. Tested in test/bridge/logcap.test.js.
'use strict';
const fs = require('fs');
const path = require('path');

const BRIDGE_LOG_MAX = 5 * 1024 * 1024;

function appendCapped(dir, name, line, max = BRIDGE_LOG_MAX) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  // The cut steps back one unit when it would split a character made of two (an emoji, say).
  const cut = line.length > 8000 && /[\uD800-\uDBFF]/.test(line[7999]) ? 7999 : 8000;
  const text = line.length > 8000 ? line.slice(0, cut) + '\n' : line;
  let size = 0;
  try { size = fs.statSync(file).size; } catch {}
  if (size > 0 && size + Buffer.byteLength(text) > max) {
    // A file held open by another program (a viewer, a virus check) cannot be renamed on Windows: it is emptied
    // instead, so the log carries on within its cap rather than stopping at the first fault after the cap.
    try { fs.renameSync(file, path.join(dir, name.replace(/\.log$/, '') + '.old.log')); } catch {
      try { fs.writeFileSync(file, ''); } catch {}
    }
  }
  fs.appendFileSync(file, text);
}

module.exports = { appendCapped, BRIDGE_LOG_MAX };
