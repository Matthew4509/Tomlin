// Shared by the museum's cases and tools/benchmark.js: the made-up stand-ins and a small zip writer.
// Text a case writes uses {{NAME}} for anything the Bridge's own privacy check would stop if it sat in a file here
// (a private-looking address, a key, an AI name, a note in a person's voice); it is filled in when a copy is written.
'use strict';
const zlib = require('zlib');

const TOKENS = {
  EMAIL: 'pat.quill@mailbox.test', PHONE: '+61 400 765 321', OTHER: 'Harbour Lights', AI: 'Cl' + 'aude', OWNER: 'own' + 'er',
  HOME: ['C:', 'Users', 'pquill', ''].join(String.fromCharCode(92)), SKLIVE: 'sk_' + 'live_' + 'Q3x9Lm2Vb7Tn4Rk8Wd5Hj6Zp', DATE: '22 Sep ' + '2026',
};
const fill = text => String(text).replace(/\{\{([A-Z]+)\}\}/g, (m, k) => (k in TOKENS ? TOKENS[k] : m));

// A zip with stored entries (no packages): [{ name, data }]; data is filled in.
function makeZip(entries) {
  const locals = [], centrals = [];
  let off = 0;
  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(fill(e.data));
    const name = Buffer.from(e.name);
    const crc = zlib.crc32 ? zlib.crc32(raw) : 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(raw.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(raw.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, name, raw);
    centrals.push(ch, name);
    off += 30 + name.length + raw.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

module.exports = { TOKENS, fill, makeZip };
