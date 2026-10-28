// Zip files TOMLIN writes and reads back itself (the data backups, src/keep.ts). Windows' own tar.exe made them before,
// but it garbles or leaves out files and folders whose names are not plain English letters (é, ü, 日本) without
// saying so, and the zip it writes still lists and reads back clean. So: plain zip with names in UTF-8, deflate (or
// stored for files that are compressed already), zip64 when a file, the zip or the file count is too big for plain
// zip, and a check that inflates every file again and compares its size and CRC-32 with what was written. Node only,
// no packages. A write fault on the zip's own drive is never taken for an unreadable file (it is thrown), and the
// check compares each file's own header with the zip's list too. Windows' tar still unpacks these zips (Put back).
// Tested in test/zip.test.ts.
import { createReadStream } from 'node:fs';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, Writable, type Duplex } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

/** One entry to write: a file read from `abs`, bytes given as `data`, or a folder (`dir`, its name ending in "/"). */
export interface ZipItem {
  /** Its name in the zip, with "/" between folders. */
  name: string;
  abs?: string;
  data?: Buffer;
  dir?: boolean;
  /** The size it had when listed (a file that grows while read is still read whole). */
  size?: number;
  mtimeMs?: number;
}
export interface ZipEntry { name: string; size: number; csize: number; crc: number; method: number }
export interface Written { entries: ZipEntry[]; skipped: { name: string; why: string }[]; bytes: number }
export type Checked = { ok: true; files: number; bytes: number } | { ok: false; fault: string };

const crc32 = zlib.crc32;
const deflate = promisify(zlib.deflateRaw);
const inflate = promisify(zlib.inflateRaw);
// Kept as they are (method 0): deflating them again costs time and saves nothing.
const STORED = /\.(zip|7z|rar|gz|tgz|bz2|xz|zst|jpe?g|png|gif|webp|avif|heic|mp4|m4v|mov|mkv|webm|avi|mp3|m4a|aac|ogg|opus|flac|woff2?|pdf|docx|xlsx|pptx|jar|apk|nupkg|whl|gguf|safetensors|onnx|pack)$/i;
const MAX32 = 0xFFFFFFFF;
/** Files under 4 MB are read and deflated whole; bigger ones are streamed. */
const SMALL = 4 << 20;
/** A file this big or bigger gets zip64 sizes in its local header (it may still grow while read). */
const BIG = 0xFFFF0000;

function dosStamp(ms: number): { time: number; date: number } {
  const d = new Date(ms);
  if (!(d.getFullYear() >= 1980)) return { time: 0, date: (1 << 5) | 1 };
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}
const u64 = (buf: Buffer, v: number, at: number) => buf.writeBigUInt64LE(BigInt(v), at);
const abortError = () => Object.assign(new Error('Cancelled.'), { code: 'ABORT_ERR' });

/** Why a file could not be read, in plain words. */
function whyNot(e: unknown): string {
  const c = (e as NodeJS.ErrnoException | null)?.code;
  if (c === 'EBUSY' || c === 'EPERM' || c === 'EACCES') return `in use or access denied (${c})`;
  if (c === 'ENOENT') return 'gone before it could be read';
  return (e as Error | null)?.message || String(e);
}

/**
 * Everything under `root` as zip items, folders first in each folder (an empty folder is kept too). `skip(rel, dir)`
 * leaves out a path (and all under a folder); rel uses "/". Links and junctions are not followed: they are listed in
 * `links` (Node reads a Windows junction as a link too).
 */
export async function listFolder(root: string, skip: (rel: string, dir: boolean) => boolean = () => false): Promise<{ items: ZipItem[]; links: string[] }> {
  const items: ZipItem[] = [];
  const links: string[] = [];
  const walk = async (abs: string, rel: string) => {
    const list = await readdir(abs, { withFileTypes: true });
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of list) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const p = join(abs, e.name);
      if (e.isSymbolicLink()) { if (!skip(r, false)) links.push(r); continue; }
      if (e.isDirectory()) {
        if (skip(r, true)) continue;
        items.push({ name: `${r}/`, dir: true });
        await walk(p, r);
      } else if (e.isFile()) {
        if (skip(r, false)) continue;
        items.push({ name: r, abs: p });
      }
    }
  };
  await walk(root, '');
  // The sizes, for the zip64 choice and the stamps: one stat each, after the walk.
  for (const it of items) {
    if (!it.abs) continue;
    const s = await stat(it.abs).catch(() => null);
    it.size = s?.size ?? 0;
    it.mtimeMs = s?.mtimeMs;
  }
  return { items, links };
}

/**
 * Writes `file` as a zip of `items`. A file that cannot be opened or read (locked, access denied, gone) is left out and
 * listed in `skipped`, never fatal here: the caller says whether a zip with something left out will do. A fault
 * writing the zip itself (its drive full or gone) is thrown. o.onBytes(n): bytes of file content read so far.
 */
export async function writeZip(file: string, items: ZipItem[], o: { onBytes?: (n: number) => void; signal?: AbortSignal; level?: number } = {}): Promise<Written> {
  const { onBytes = () => undefined, signal, level = 5 } = o;
  const fh = await open(file, 'w');
  const central: { name: Buffer; method: number; time: number; date: number; crc: number; size: number; csize: number; offset: number; dir: boolean }[] = [];
  const entries: ZipEntry[] = [];
  const skipped: { name: string; why: string }[] = [];
  let pos = 0;
  let read = 0;
  // Small writes are gathered and written 1 MB at a time (a folder of thousands of small files was one write each).
  // Always: flushed + pendLen === pos.
  let flushed = 0;
  let pend: Buffer[] = [];
  let pendLen = 0;
  const flush = async () => {
    if (!pendLen) return;
    const b = Buffer.concat(pend, pendLen);
    pend = []; pendLen = 0;
    await fh.write(b, 0, b.length, flushed);
    flushed += b.length;
  };
  const put = async (buf: Buffer) => {
    pend.push(buf); pendLen += buf.length; pos += buf.length;
    if (pendLen >= 1 << 20) await flush();
  };
  /** Back to `to` (a file that failed part-way): what comes next is written over it. */
  const rewind = (to: number) => {
    if (to >= flushed) {
      const keep = Buffer.concat(pend, pendLen).subarray(0, to - flushed);
      pend = [keep]; pendLen = keep.length;
    } else {
      pend = []; pendLen = 0; flushed = to;
    }
    pos = to;
  };
  try {
    for (const it of items) {
      if (signal?.aborted) throw abortError();
      const name = Buffer.from(it.name, 'utf8');
      const { time, date } = dosStamp(it.mtimeMs || Date.now());
      const start = pos;
      const size0 = it.data ? it.data.length : it.size ?? 0;
      const big = !it.dir && !it.data && size0 >= BIG;
      const method = it.dir || !size0 || STORED.test(it.name) ? 0 : 8;
      const local = Buffer.alloc(30 + name.length + (big ? 20 : 0));
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(big ? 45 : 20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(big ? 20 : 0, 28);
      name.copy(local, 30);
      if (big) { local.writeUInt16LE(1, 30 + name.length); local.writeUInt16LE(16, 32 + name.length); local.writeUInt32LE(MAX32, 18); local.writeUInt32LE(MAX32, 22); }
      let crc = 0;
      let size = 0;
      let csize = 0;
      if (!it.dir && !big && (it.data || size0 < SMALL)) {
        // Most files are small (a chats folder is thousands of them): read whole, deflated in one go, written with the
        // header in one write. Stored instead when deflating does not make it smaller.
        let data: Buffer;
        try { data = it.data ?? await readFile(it.abs ?? ''); } catch (e) { skipped.push({ name: it.name, why: whyNot(e) }); continue; }
        crc = crc32(data); size = data.length;
        let body = data;
        let m = 0;
        if (method && size) { const d = await deflate(data, { level }); if (d.length < size) { body = d; m = 8; } }
        csize = body.length;
        if (size >= MAX32 || csize >= MAX32) { skipped.push({ name: it.name, why: 'it grew past 4 GB while it was being read' }); continue; }
        local.writeUInt16LE(m, 8); local.writeUInt32LE(crc >>> 0, 14); local.writeUInt32LE(csize, 18); local.writeUInt32LE(size, 22);
        await put(Buffer.concat([local, body]));
        read += size; onBytes(read);
        central.push({ name, method: m, time, date, crc: crc >>> 0, size, csize, offset: start, dir: false });
        entries.push({ name: it.name, size, csize, crc: crc >>> 0, method: m });
        continue;
      }
      if (!it.dir) {
        const src = createReadStream(it.abs ?? '', { highWaterMark: 1 << 20 });
        try { await new Promise((ok, bad) => { src.once('open', ok); src.once('error', bad); }); } catch (e) { skipped.push({ name: it.name, why: whyNot(e) }); continue; }
        await put(local);
        // A fault writing the zip is the zip's (its drive), never the project file's: marked so it is thrown, not
        // listed as a file that could not be read.
        let writeFault: unknown = null;
        const tap = new Transform({ transform(chunk: Buffer, _enc, done) { crc = crc32(chunk, crc); size += chunk.length; read += chunk.length; onBytes(read); done(null, chunk); } });
        const out = new Writable({ write(chunk: Buffer, _enc, done) { csize += chunk.length; put(chunk).then(() => done(), e => { writeFault = e; done(e); }); } });
        const steps: (NodeJS.ReadableStream | Duplex | Writable)[] = [src, tap];
        if (method) steps.push(zlib.createDeflateRaw({ level, chunkSize: 1 << 18 }));
        steps.push(out);
        try {
          await (pipeline as (...a: unknown[]) => Promise<void>)(...steps, signal ? { signal } : {});
        } catch (e) {
          if (signal?.aborted) throw abortError();
          if (writeFault) throw writeFault;
          rewind(start); read -= size; onBytes(read); // what was written of it is written over by the next file
          skipped.push({ name: it.name, why: whyNot(e) });
          continue;
        }
        if (!big && (size >= MAX32 || csize >= MAX32)) { rewind(start); skipped.push({ name: it.name, why: 'it grew past 4 GB while it was being read' }); continue; }
        // The sizes and CRC go back into the local header now they are known (no data descriptor, so any reader copes).
        await flush();
        const fix = Buffer.alloc(big ? 4 : 12);
        fix.writeUInt32LE(crc >>> 0, 0);
        if (!big) { fix.writeUInt32LE(csize, 4); fix.writeUInt32LE(size, 8); }
        await fh.write(fix, 0, fix.length, start + 14);
        if (big) { const z = Buffer.alloc(16); u64(z, size, 0); u64(z, csize, 8); await fh.write(z, 0, 16, start + 34 + name.length); }
      } else {
        await put(local);
      }
      central.push({ name, method, time, date, crc: crc >>> 0, size, csize, offset: start, dir: !!it.dir });
      entries.push({ name: it.name, size, csize, crc: crc >>> 0, method });
    }
    // The central directory: a zip64 extra for whichever of size, compressed size and offset do not fit 32 bits.
    const cdStart = pos;
    for (const c of central) {
      const ext = [c.size >= MAX32 ? c.size : -1, c.csize >= MAX32 ? c.csize : -1, c.offset >= MAX32 ? c.offset : -1].filter(v => v >= 0);
      const h = Buffer.alloc(46 + c.name.length + (ext.length ? 4 + 8 * ext.length : 0));
      h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(45, 4); h.writeUInt16LE(ext.length ? 45 : 20, 6); h.writeUInt16LE(0x0800, 8);
      h.writeUInt16LE(c.method, 10); h.writeUInt16LE(c.time, 12); h.writeUInt16LE(c.date, 14); h.writeUInt32LE(c.crc, 16);
      h.writeUInt32LE(Math.min(c.csize, MAX32), 20); h.writeUInt32LE(Math.min(c.size, MAX32), 24); h.writeUInt16LE(c.name.length, 28);
      h.writeUInt16LE(ext.length ? 4 + 8 * ext.length : 0, 30); h.writeUInt32LE(c.dir ? 0x10 : 0x20, 38); h.writeUInt32LE(Math.min(c.offset, MAX32), 42);
      c.name.copy(h, 46);
      if (ext.length) { const at = 46 + c.name.length; h.writeUInt16LE(1, at); h.writeUInt16LE(8 * ext.length, at + 2); ext.forEach((v, i) => u64(h, v, at + 4 + 8 * i)); }
      await put(h);
    }
    const cdSize = pos - cdStart;
    const n = central.length;
    if (n >= 0xFFFF || cdSize >= MAX32 || cdStart >= MAX32) {
      const z = Buffer.alloc(56 + 20);
      const at = pos;
      z.writeUInt32LE(0x06064b50, 0); u64(z, 44, 4); z.writeUInt16LE(45, 12); z.writeUInt16LE(45, 14);
      u64(z, n, 24); u64(z, n, 32); u64(z, cdSize, 40); u64(z, cdStart, 48);
      z.writeUInt32LE(0x07064b50, 56); u64(z, at, 64); z.writeUInt32LE(1, 72);
      await put(z);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Math.min(n, 0xFFFF), 8); end.writeUInt16LE(Math.min(n, 0xFFFF), 10);
    end.writeUInt32LE(Math.min(cdSize, MAX32), 12); end.writeUInt32LE(Math.min(cdStart, MAX32), 16);
    await put(end);
    await flush();
    await fh.truncate(pos);
    // Flushed to the drive before the check. The check's read-back may still come from Windows' memory of the file,
    // so it proves the zip is whole and matches what was read, and is called "read back and checked", no more.
    await fh.sync();
    return { entries, skipped, bytes: pos };
  } finally {
    await fh.close();
  }
}

/** The zip's own list, from its central directory, with where each entry starts. Throws on a zip cut short or not a zip. */
export async function listZip(file: string): Promise<(ZipEntry & { offset: number })[]> {
  const fh = await open(file, 'r');
  try {
    const { size: total } = await fh.stat();
    const tailLen = Math.min(total, 65557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, total - tailLen);
    let e = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new Error('it has no end record (cut short, or not a zip)');
    let n = tail.readUInt16LE(e + 10);
    let cdSize = tail.readUInt32LE(e + 12);
    let cdStart = tail.readUInt32LE(e + 16);
    if (n === 0xFFFF || cdSize === MAX32 || cdStart === MAX32) {
      const loc = e - 20;
      if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw new Error('its zip64 end record is missing');
      const at = Number(tail.readBigUInt64LE(loc + 8));
      const z = Buffer.alloc(56);
      await fh.read(z, 0, 56, at);
      if (z.readUInt32LE(0) !== 0x06064b50) throw new Error('its zip64 end record is damaged');
      n = Number(z.readBigUInt64LE(32)); cdSize = Number(z.readBigUInt64LE(40)); cdStart = Number(z.readBigUInt64LE(48));
    }
    if (cdStart + cdSize > total) throw new Error('its file list points past its end (cut short)');
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdStart);
    const out: (ZipEntry & { offset: number })[] = [];
    for (let p = 0, k = 0; k < n; k++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new Error(`its file list is damaged at entry ${k + 1}`);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let csize = cd.readUInt32LE(p + 20);
      let size = cd.readUInt32LE(p + 24);
      let offset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      for (let x = p + 46 + nameLen; x + 4 <= p + 46 + nameLen + extraLen;) {
        const tag = cd.readUInt16LE(x);
        const len = cd.readUInt16LE(x + 2);
        if (tag === 1) {
          let q = x + 4;
          if (size === MAX32) { size = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (csize === MAX32) { csize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (offset === MAX32) offset = Number(cd.readBigUInt64LE(q));
        }
        x += 4 + len;
      }
      out.push({ name, size, csize, crc: cd.readUInt32LE(p + 16), method: cd.readUInt16LE(p + 10), offset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  } finally {
    await fh.close();
  }
}

/**
 * The check: every entry read back, inflated, and its size and CRC-32 compared with the zip's own list, with its own
 * header (what a streaming unzipper reads), and with `expected` when given (what writeZip said it wrote). Without
 * `expected` (a zip made earlier, before Put back), the zip's own list is what it must match.
 */
export async function checkZip(file: string, expected?: ZipEntry[], o: { onBytes?: (n: number) => void; signal?: AbortSignal } = {}): Promise<Checked> {
  const { onBytes = () => undefined, signal } = o;
  let list: (ZipEntry & { offset: number })[];
  try { list = await listZip(file); } catch (e) { return { ok: false, fault: `The zip could not be read back: ${(e as Error).message}.` }; }
  if (expected && list.length !== expected.length) return { ok: false, fault: `The zip lists ${list.length} entries, but ${expected.length} were written.` };
  const fh = await open(file, 'r');
  let done = 0;
  let files = 0;
  // Reads come from a 1 MB window of the zip (thousands of small files were one read per header). Near the end of the
  // zip it gives fewer bytes than asked: the callers check.
  let winAt = -1;
  let win = Buffer.alloc(0);
  const readAt = async (at: number, len: number): Promise<Buffer> => {
    if (len > 1 << 20) {
      const b = Buffer.alloc(len);
      const r = await fh.read(b, 0, len, at);
      return b.subarray(0, r.bytesRead);
    }
    if (winAt < 0 || at < winAt || at + len > winAt + win.length) {
      const b = Buffer.alloc(1 << 20);
      const r = await fh.read(b, 0, b.length, at);
      win = b.subarray(0, r.bytesRead); winAt = at;
    }
    return win.subarray(at - winAt, Math.min(at - winAt + len, win.length));
  };
  try {
    for (let i = 0; i < list.length; i++) {
      if (signal?.aborted) throw abortError();
      const z = list[i];
      const w = expected?.[i];
      if (w && (z.name !== w.name || z.size !== w.size || z.crc !== w.crc)) return { ok: false, fault: `${z.name} in the zip does not match what was written.` };
      const head = await readAt(z.offset, 30);
      if (head.length !== 30 || head.readUInt32LE(0) !== 0x04034b50) return { ok: false, fault: `${z.name}: its place in the zip holds something else (damaged).` };
      if (z.name.endsWith('/')) continue;
      // A zip made by streaming (Windows tar, every data backup before this) leaves its header's CRC and sizes at 0 and
      // says so (flag 8): they follow the file instead, and the list holds them.
      const lcsize = head.readUInt32LE(18);
      const later = (head.readUInt16LE(6) & 8) !== 0;
      if (!later && (head.readUInt32LE(14) !== z.crc || (lcsize !== MAX32 && (lcsize !== z.csize || head.readUInt32LE(22) !== z.size)))) {
        return { ok: false, fault: `${z.name}: its own header in the zip disagrees with the zip's list (damaged).` };
      }
      const start = z.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
      let crc = 0;
      let size = 0;
      if (z.csize && z.csize < SMALL && z.size < SMALL * 4) {
        try {
          const raw = await readAt(start, z.csize);
          if (raw.length !== z.csize) throw new Error('the zip ends before it does');
          const data = z.method === 8 ? await inflate(raw) : raw;
          crc = crc32(data); size = data.length; done += size; onBytes(done);
        } catch (e) { return { ok: false, fault: `${z.name} could not be read back from the zip (${(e as Error).message}).` }; }
      } else if (z.csize) {
        const src = createReadStream('', { fd: fh, autoClose: false, start, end: start + z.csize - 1, highWaterMark: 1 << 20 });
        const sink = new Writable({ write(chunk: Buffer, _enc, cb) { crc = crc32(chunk, crc); size += chunk.length; done += chunk.length; onBytes(done); cb(); } });
        const steps: (NodeJS.ReadableStream | Duplex | Writable)[] = [src];
        if (z.method === 8) steps.push(zlib.createInflateRaw());
        steps.push(sink);
        try { await (pipeline as (...a: unknown[]) => Promise<void>)(...steps, signal ? { signal } : {}); } catch (e) {
          if (signal?.aborted) throw abortError();
          return { ok: false, fault: `${z.name} could not be read back from the zip (${(e as Error).message}).` };
        }
      }
      if (size !== z.size || (crc >>> 0) !== z.crc) return { ok: false, fault: `${z.name} read back ${size !== z.size ? `${size} bytes instead of ${z.size}` : 'with a different CRC-32'}: the zip is damaged.` };
      files++;
    }
  } finally {
    await fh.close();
  }
  return { ok: true, files, bytes: done };
}
