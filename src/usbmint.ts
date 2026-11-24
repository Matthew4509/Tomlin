// Bootable USB (Settings), step 3: Mint. Adds TOMLIN to a Debian live stick that Rufus made, from Windows. Everything
// goes on the stick's first part (FAT32, which Windows writes; the persistent part Rufus makes is ext3, which it does
// not):
//   tomlin/tomlin-node.json  the admin's public key, this stick's own id and key pair, and the ticks a node starts with (src/usbnode.ts reads it on the node)
//   tomlin/app/              this TOMLIN (src, public, registry, node_modules without other platforms' parts)
//   tomlin/stick/            start.sh and the service (tools/usbnode/ in this folder)
//   tomlin/hook.sh           the boot hook named on the TOMLIN node entries
//   tomlin/downloads/        Node.js and the llama.cpp builds for Linux (tools/usbnode/pins.json, checked by SHA-256)
//   tomlin/models/           models to start with (optional; under 4 GB each on FAT32)
// and the boot menus get the TOMLIN node entries (the originals kept once as *.tomlin-orig). The node runs
// TOMLIN itself, so a stick PC is an ordinary linked PC.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { copyFile, cp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { patchGrub, patched, patchSyslinux, patchTimeout, strip, unpatchSyslinux } from './usbmenu.ts';
import { cleanStick, STICK_ALLOW, type StickConfig } from './usbnode.ts';
import type { Allow } from './carry.ts';
import * as adminkey from './adminkey.ts';
import { SKIP as UPDATE_SKIP } from './update.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The app folder (the one holding src/). */
export const APP_DIR = resolve(HERE, '..');
export const USB_DIR = join(APP_DIR, 'tools', 'usbnode');
const FAT32_MAX = 2 ** 32 - 1;
const MB = 2 ** 20;

/** `npm`: an npm package (sharp's Linux build), unpacked into the stick's node_modules rather than copied as a file. */
export interface Pin { file: string; url: string; bytes: number; sha256: string; runner?: string; optional?: boolean; licence?: string; npm?: string }

/** An npm package's .tgz unpacked into `dest` (its "package/" folder laid flat), with Windows' own tar or the system's. */
export async function unpackNpm(tgz: string, dest: string): Promise<void> {
  mkdirSync(dest, { recursive: true });
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  await new Promise<void>((ok, fail) => execFile(tar, ['-xzf', tgz, '-C', dest, '--strip-components=1'], { windowsHide: true, timeout: 120_000 }, e => (e ? fail(new Error(`${basename(tgz)} could not be unpacked (${e.message}).`)) : ok())));
}
export interface Pins { parts: Record<string, Pin>; debianIso: Pin }

export const readPins = (dir = USB_DIR): Pins => JSON.parse(readFileSync(join(dir, 'pins.json'), 'utf8')) as Pins;

/** The parts a stick takes: Node.js, CPU and Vulkan always; the CUDA build and its runtime only when asked. */
export const wanted = (pins: Pins, cuda: boolean) => Object.entries(pins.parts).filter(([, p]) => cuda || !p.optional).map(([id, p]) => ({ id, ...p }));

export function sha256File(path: string, onBytes?: (n: number) => void): Promise<string> {
  return new Promise((ok, fail) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', d => {
      h.update(d);
      onBytes?.(d.length);
    }).on('end', () => ok(h.digest('hex'))).on('error', fail);
  });
}

/**
 * One pinned file downloaded into `dir`, checked by SHA-256 (a file already there and right is kept). Cut short or
 * wrong, nothing is left under the real name.
 */
export async function fetchPin(p: Pin, dir: string, o: { say?: (l: string) => void; progress?: (got: number, of: number) => void; signal?: AbortSignal; fetcher?: typeof fetch } = {}): Promise<string> {
  const say = o.say ?? (() => undefined);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, p.file);
  if (existsSync(dest) && statSync(dest).size === p.bytes) {
    if ((await sha256File(dest)) === p.sha256) return dest;
    rmSync(dest, { force: true });
  }
  say(`${p.file}: downloading ${(p.bytes / MB).toFixed(0)} MB from ${new URL(p.url).host}...`);
  const res = await (o.fetcher ?? fetch)(p.url, { redirect: 'follow', signal: o.signal });
  if (!res.ok || !res.body) throw new Error(`${p.file}: the download failed (${res.status}).`);
  const part = `${dest}.part`;
  let got = 0;
  try {
    const counted = Readable.fromWeb(res.body as never);
    counted.on('data', (d: Buffer) => {
      got += d.length;
      o.progress?.(got, p.bytes);
    });
    await pipeline(counted, createWriteStream(part));
  } catch (e) {
    rmSync(part, { force: true });
    throw new Error(`${p.file}: the download was cut short (${(e as Error).message}). Press it again: it starts afresh.`);
  }
  const sum = await sha256File(part);
  if (sum !== p.sha256) {
    rmSync(part, { force: true });
    throw new Error(`${p.file}: the file that arrived is not the pinned one (SHA-256 ${sum.slice(0, 12)}...), so it was deleted.`);
  }
  rmSync(dest, { force: true });
  renameSync(part, dest);
  say(`${p.file}: done and checked.`);
  return dest;
}

/** Which of the stick's parts are in the cache already (by size; the SHA-256 is checked again at Mint). */
export function partsHere(cache: string, cuda: boolean, pins = readPins()): { file: string; bytes: number; here: boolean; optional: boolean }[] {
  return wanted(pins, cuda).map(p => ({ file: p.file, bytes: p.bytes, optional: p.optional === true, here: existsSync(join(cache, p.file)) && statSync(join(cache, p.file)).size === p.bytes }));
}

/** Copies under a .part name and renames: a copy cut short (the stick pulled) never has the real name, so it is redone. */
async function copyWhole(from: string, to: string): Promise<void> {
  const part = `${to}.part`;
  rmSync(part, { force: true });
  await copyFile(from, part);
  rmSync(to, { force: true });
  renameSync(part, to);
}

/** Writes a whole file under a .part name and renames it: a stick pulled mid-write never leaves a menu cut short. */
function writeWhole(to: string, text: string): void {
  const part = `${to}.part`;
  writeFileSync(part, text);
  rmSync(to, { force: true });
  renameSync(part, to);
}

/** The menu files a Debian live stick has that hold a live entry, and which patcher each takes. */
export function menuFiles(root: string): Array<{ path: string; kind: 'grub' | 'syslinux' }> {
  const out: Array<{ path: string; kind: 'grub' | 'syslinux' }> = [];
  for (const p of ['boot/grub/grub.cfg', 'boot/grub/x86_64-efi/grub.cfg', 'boot/grub/loopback.cfg']) {
    const f = join(root, p);
    if (existsSync(f) && /\bboot=live\b/.test(readFileSync(f, 'utf8'))) out.push({ path: f, kind: 'grub' });
  }
  for (const p of ['isolinux/live.cfg', 'isolinux/isolinux.cfg', 'isolinux/menu.cfg', 'syslinux.cfg']) {
    const f = join(root, p);
    if (existsSync(f) && /\bboot=live\b/.test(readFileSync(f, 'utf8'))) {
      out.push({ path: f, kind: 'syslinux' });
      break;
    }
  }
  return out;
}

/** isolinux's top files that may set their own timeout after the live menu is read (not the menu file itself). */
export function timeoutFiles(root: string, menus = menuFiles(root)): string[] {
  return ['isolinux/isolinux.cfg', 'syslinux.cfg', 'isolinux/syslinux.cfg'].map(p => join(root, p)).filter(f => existsSync(f) && !menus.some(m => m.path === f));
}

/** Puts the TOMLIN node entries in the stick's menus (the originals kept once as *.tomlin-orig). Returns the files changed. */
export function patchMenus(root: string, menus = menuFiles(root)): string[] {
  const done: string[] = [];
  const keepOrig = (path: string, text: string) => {
    const orig = `${path}.tomlin-orig`;
    if (!existsSync(orig) && !patched(text)) writeWhole(orig, text);
  };
  for (const m of menus) {
    const text = readFileSync(m.path, 'utf8');
    keepOrig(m.path, text);
    writeWhole(m.path, m.kind === 'grub' ? patchGrub(text) : patchSyslinux(text));
    done.push(m.path);
  }
  if (menus.some(m => m.kind === 'syslinux')) {
    for (const f of timeoutFiles(root, menus)) {
      const text = readFileSync(f, 'utf8');
      if (!/^\s*timeout\s/im.test(text) && !patched(text)) continue;
      keepOrig(f, text);
      writeWhole(f, patchTimeout(text));
      done.push(f);
    }
  }
  return done;
}

export interface StickLook {
  /** The drive as given (E:\). */
  root: string;
  /** A Debian live stick (live/filesystem.squashfs). */
  live: boolean;
  /** Its menus with a live entry. */
  menus: number;
  free: number | null;
  /** Minted before (tomlin/tomlin-node.json), and with which key's tag. */
  minted: boolean;
  tag: string;
  /** What is wrong, in words ('' when it can be minted). */
  why: string;
}

/** What a drive looks like, for the page's drive list and before Mint. */
export function inspect(root: string): StickLook {
  const live = existsSync(join(root, 'live', 'filesystem.squashfs'));
  const menus = live ? menuFiles(root).length : 0;
  let free: number | null = null;
  try {
    const s = statfsSync(root);
    free = s.bavail * s.bsize;
  } catch {
    // Not read.
  }
  let tag = '';
  const cfgFile = join(root, 'tomlin', 'tomlin-node.json');
  const minted = existsSync(cfgFile);
  if (minted) {
    try {
      tag = adminkey.keyTag(cleanStick(JSON.parse(readFileSync(cfgFile, 'utf8')))?.adminPub ?? '');
    } catch {
      // Unreadable: minted again over it.
    }
  }
  const why = !live ? `${root} is not a Debian live stick (no live\\filesystem.squashfs). Do step 3 in Rufus first, with the Debian ISO.`
    : !menus ? `${root} has no boot menu with a live entry (boot\\grub\\grub.cfg or isolinux).` : '';
  return { root, live, menus, free, minted, tag, why };
}

/** The drives Windows shows as removable (letters D: to Z:), each looked at. On another system: none. */
export function removableDrives(listRemovable: () => string[]): StickLook[] {
  return listRemovable().map(r => inspect(r));
}

/**
 * The app files a stick carries: what an update carries (src/update.ts PARTS) but the runners and the launchers. Every
 * part of the build id (BUILD_PARTS) goes whole, as an update sends it, so the node's build is this PC's and the admin
 * does not see it as "other files".
 */
export const APP_PARTS = ['src', 'public', 'tools', 'registry', 'node_modules', 'package.json', 'package-lock.json', 'runtimes.json', 'LICENSE', 'THIRD-PARTY.md'];
/**
 * Left off the stick in node_modules: the type check's tools, the Windows builds of the picture tools and ONNX runtime,
 * PDF.js's extras (the Linux ones stay, and sharp's Linux build is added from the parts). Elsewhere: what an update
 * leaves off (src/update.ts SKIP).
 */
export const APP_SKIP_MODULES = /node_modules[\\/](typescript|@typescript|@types|undici-types)([\\/]|$)|node_modules[\\/]\.bin([\\/]|$)|@napi-rs[\\/]|pdfjs-dist[\\/](build|web|image_decoders|types|wasm|iccs)[\\/]|pdfjs-dist[\\/]legacy[\\/](web|image_decoders)[\\/]|pdfjs-dist[\\/].*\.map$|pdfjs-dist[\\/]legacy[\\/]build[\\/]pdf\.(sandbox|min|worker\.min)|onnxruntime-node[\\/]bin[\\/]napi-v\d+[\\/](darwin|win32)|@img[\\/]sharp-(?!linux-x64|libvips-linux-x64)|\.(part|zip)$/i;
/** Whether a path inside the app folder ("\src\x.ts") is left off the stick. */
export const leftOff = (path: string) => (/(^|[\\/])node_modules([\\/]|$)/.test(path) ? APP_SKIP_MODULES.test(path) : UPDATE_SKIP.test(path));

export interface MintOptions {
  /** The admin's PUBLIC key (its private half never goes onto a stick). */
  adminPub: string;
  /** This stick's own identity, made for it alone (src/adminkey.ts newStick). */
  stick: adminkey.StickIdentity;
  admin: string;
  name?: string;
  allow?: Allow;
  plainLinks?: boolean;
  port?: number;
  version: string;
  cuda?: boolean;
  models?: string[];
  /** Where the Linux downloads are (the page's Get the parts puts them there). */
  cache: string;
  /** The app folder copied (this one unless a test gives another). */
  app?: string;
  /** Skip the SHA-256 check of the downloads (tests). */
  trust?: boolean;
  say?: (line: string) => void;
  /** How an npm part is unpacked (tests give their own). */
  unpack?: (tgz: string, dest: string) => Promise<void>;
}

/**
 * The error to show when writing failed: when the stick itself is gone (pulled out, or its drive letter dropped), says
 * so; anything else as it was. Files are copied under .part names, so what is on the stick is whole or redone next time.
 */
function stickGone(root: string, e: unknown): unknown {
  if (existsSync(join(root, 'live', 'filesystem.squashfs'))) return e;
  return new Error(`The stick at ${root} went away while it was being written (${(e as Error)?.message ?? e}). Plug it back in and press Mint again: what was copied whole is kept, the rest is copied again.`);
}

/** The config written on the stick. */
export function stickConfig(o: MintOptions, now = new Date()): StickConfig {
  const c = cleanStick({ v: 2, adminPub: o.adminPub, stick: o.stick, admin: o.admin, name: o.name ?? 'USB node', allow: o.allow ?? STICK_ALLOW, plainLinks: o.plainLinks === true, port: o.port ?? 8741, minted: now.toISOString(), version: o.version });
  if (!c) throw new Error('This PC has no admin key yet: make one first.');
  return c;
}

/** Mint: writes TOMLIN, the admin's public key and this stick's own identity onto the stick at `root` (a drive letter such as E:\). Returns the lines shown. */
export async function mintStick(root: string, o: MintOptions): Promise<string[]> {
  const lines: string[] = [];
  const say = (l: string) => {
    lines.push(l);
    o.say?.(l);
  };
  const look = inspect(root);
  if (look.why) throw new Error(look.why);
  const config = stickConfig(o);
  const pins = readPins(join(o.app ?? APP_DIR, 'tools', 'usbnode'));
  const parts = wanted(pins, o.cuda === true);
  const missing = parts.filter(p => !existsSync(join(o.cache, p.file)));
  if (missing.length) throw new Error(`Not downloaded yet: ${missing.map(p => p.file).join(', ')}. Press "Get the parts" first.`);
  for (const m of o.models ?? []) {
    if (!/\.gguf$/i.test(m)) throw new Error(`${basename(m)} is not a .gguf model.`);
    if (statSync(m).size > FAT32_MAX) throw new Error(`${basename(m)} is over 4 GB, which the stick's FAT32 part cannot hold. Send it to the node once it is linked instead (Models, Send to a PC).`);
  }
  const onStick = (name: string, folder: string, bytes: number) => {
    const f = join(root, 'tomlin', folder, name);
    return existsSync(f) && statSync(f).size === bytes;
  };
  const need = parts.filter(p => !onStick(p.file, 'downloads', p.bytes)).reduce((s, p) => s + p.bytes, 0)
    + (o.models ?? []).filter(m => !onStick(basename(m), 'models', statSync(m).size)).reduce((s, m) => s + statSync(m).size, 0) + 400 * MB;
  if (look.free !== null && look.free < need) throw new Error(`The stick has ${(look.free / 2 ** 30).toFixed(1)} GB free on its first part; Mint needs ${(need / 2 ** 30).toFixed(1)} GB. In Rufus, make the persistent partition smaller, or leave models off.`);

  if (!o.trust) {
    for (const p of parts) {
      if ((await sha256File(join(o.cache, p.file))) !== p.sha256) throw new Error(`${p.file} is not the pinned file (SHA-256 differs). Press "Get the parts" again: it is downloaded afresh.`);
    }
    say(`Checked ${parts.length} downloads (SHA-256).`);
  }

  const app = o.app ?? APP_DIR;
  const usb = join(app, 'tools', 'usbnode');
  try {
    const t = join(root, 'tomlin');
    mkdirSync(join(t, 'downloads'), { recursive: true });
    mkdirSync(join(t, 'models'), { recursive: true });
    // TOMLIN itself, replaced whole each time (under app.part, then renamed: a stick pulled mid-copy keeps the old one).
    say('Copying TOMLIN onto the stick (a few minutes on a slow stick)...');
    const appPart = join(t, 'app.part');
    await rm(appPart, { recursive: true, force: true });
    for (const p of APP_PARTS) {
      const from = join(app, p);
      if (!existsSync(from)) continue;
      await cp(from, join(appPart, p), { recursive: true, filter: src => !leftOff(src.slice(app.length)) });
    }
    // sharp's Linux build (the picture tools: without it TOMLIN stops at its start on Linux).
    for (const p of parts.filter(x => x.npm)) await (o.unpack ?? unpackNpm)(join(o.cache, p.file), join(appPart, 'node_modules', ...p.npm!.split('/')));
    await rm(join(t, 'app'), { recursive: true, force: true });
    renameSync(appPart, join(t, 'app'));
    mkdirSync(join(t, 'stick'), { recursive: true });
    // The scripts in Linux line ends (a Windows checkout may hold them with CRLF, which sh cannot run).
    for (const f of ['start.sh', 'tomlin-node.service']) writeWhole(join(t, 'stick', f), readFileSync(join(usb, f), 'utf8').replace(/\r\n/g, '\n'));
    writeWhole(join(t, 'hook.sh'), readFileSync(join(usb, 'hook.sh'), 'utf8').replace(/\r\n/g, '\n'));
    writeWhole(join(t, 'tomlin-node.json'), JSON.stringify(config, null, 2));
    say(`This stick is ${adminkey.showId(config.stick.id)}, for the admin with tag ${adminkey.keyTag(config.adminPub)} only. No admin secret is on it.`);

    // Downloads: copied when missing or a different size; old versions of the same part removed.
    const files = parts.filter(p => !p.npm);
    const keep = new Set(files.map(p => p.file));
    for (const f of readdirSync(join(t, 'downloads'))) if (!keep.has(f)) rmSync(join(t, 'downloads', f), { force: true });
    for (const p of files) {
      const dest = join(t, 'downloads', p.file);
      if (existsSync(dest) && statSync(dest).size === p.bytes) continue;
      say(`Copying ${p.file} (${(p.bytes / MB).toFixed(0)} MB)...`);
      await copyWhole(join(o.cache, p.file), dest);
    }
    for (const m of o.models ?? []) {
      const dest = join(t, 'models', basename(m));
      if (existsSync(dest) && statSync(dest).size === statSync(m).size) continue;
      say(`Copying model ${basename(m)}...`);
      await copyWhole(m, dest);
    }
    for (const f of patchMenus(root)) say(`Boot menu: ${f.slice(root.length).replace(/^[\\/]/, '')} has the TOMLIN node entries (the default).`);
  } catch (e) {
    throw stickGone(root, e);
  }
  say('Minted. Take the stick out, boot a PC from it (F9, F12 or Esc for its boot menu), then use "Scan the network" under Network, Add another PC.');
  return lines;
}

/**
 * Takes TOMLIN off a stick: the menus as they were, the tomlin folder gone. Only on a Debian live stick that was
 * minted (a wrong drive letter must not delete someone's own folder named tomlin).
 */
export function removeFromStick(root: string): string[] {
  if (!existsSync(join(root, 'live', 'filesystem.squashfs'))) throw new Error(`${root} is not a Debian live stick (no live\\filesystem.squashfs): nothing was removed.`);
  const menus = menuFiles(root);
  const files = [...menus.map(m => m.path), ...timeoutFiles(root, menus)];
  const ours = files.some(f => patched(readFileSync(f, 'utf8'))) || existsSync(join(root, 'tomlin', 'tomlin-node.json'));
  if (!ours) throw new Error(`${root} was not minted (no TOMLIN node entries, no tomlin\\tomlin-node.json): nothing was removed.`);
  const lines: string[] = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    if (!patched(text)) continue;
    const grub = menus.some(m => m.path === f && m.kind === 'grub');
    writeWhole(f, grub ? strip(text) : unpatchSyslinux(text));
    rmSync(`${f}.tomlin-orig`, { force: true });
    lines.push(`Boot menu: ${f.slice(root.length).replace(/^[\\/]/, '')} as it was.`);
  }
  rmSync(join(root, 'tomlin'), { recursive: true, force: true });
  lines.push('The tomlin folder is gone from the stick.');
  return lines;
}
