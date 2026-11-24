// Bootable USB (Settings): adding the TOMLIN node entries to a Debian live stick's boot menus (GRUB for UEFI, isolinux for BIOS), made by
// copying the stick's own first live entry (its kernel and initrd) and changing its line: persistence on (Rufus adds it
// to the stick's own entries when a persistent partition was made), the node's hook named by its path on the stick, and
// tomlin.node=1. A second entry also installs NVIDIA's driver once (it needs a network). Our lines sit between two
// marker lines, so making the stick again replaces them and removing takes them out; the stick's own entries are not
// changed, except that ours becomes the default.
//
// The hook is named as a file:// address on purpose: live-config's "hooks=medium" looks under /lib/live/mount/medium,
// a path the Debian 13 live system no longer has, while a file:// address is copied with cp from where it is.

export const START = '# >>> TOMLIN node (added by Mint in TOMLIN; Remove from stick takes it out)';
export const END = '# <<< TOMLIN node';
export const HOOK_URL = 'file:///run/live/medium/tomlin/hook.sh';

/**
 * The kernel line's words we drop from the copied entry (splash hides the node's screen; findiso is for ISO files).
 * nouveau is kept off on the node entries: the node has no desktop, and NVIDIA's own driver (installed by the second
 * entry) cannot load while nouveau holds the card; the stick's start files cannot carry the driver's own blacklist.
 */
const DROP = /^(splash|findiso=.*|persistence|persistence-media=.*|quiet|loglevel=.*|live-config\.hooks=.*|hooks=.*|tomlin\..*|modprobe\.blacklist=.*)$/;

export function nodeParams(base: string[], nvidia: boolean): string {
  const keep = base.filter(w => !DROP.test(w));
  // persistence-media=removable-usb: live-boot looks for the persistence on USB disks only, never on the PC's own disks.
  return [...keep, 'persistence', 'persistence-media=removable-usb', 'quiet', 'loglevel=3', `live-config.hooks=${HOOK_URL}`, 'modprobe.blacklist=nouveau', 'tomlin.node=1', ...(nvidia ? ['tomlin.nvidia=1'] : [])].join(' ');
}

/** The text with our marked block taken out. A start line with no end line after it (a file cut short) goes alone. */
export function strip(text: string): string {
  const lines = text.split('\n');
  const drop = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== START) continue;
    const end = lines.findIndex((l, j) => j > i && l.trim() === END);
    if (end < 0) {
      drop.add(i);
      continue;
    }
    for (let j = i; j <= end; j++) drop.add(j);
    i = end;
  }
  return lines.filter((_, i) => !drop.has(i)).join('\n');
}

export const patched = (text: string) => text.includes(START);

/** GRUB: the first menuentry whose linux line has boot=live: its kernel, words and initrd. */
export function grubLive(text: string): { kernel: string; words: string[]; initrd: string } | null {
  const re = /menuentry\s[^{]*\{([\s\S]*?)\n\s*\}/g;
  for (const m of text.matchAll(re)) {
    const linux = /^\s*linux(?:efi)?\s+(\S+)\s*(.*)$/m.exec(m[1]);
    const initrd = /^\s*initrd(?:efi)?\s+(.+)$/m.exec(m[1]);
    if (linux && initrd && /\bboot=live\b/.test(linux[2])) return { kernel: linux[1], words: linux[2].trim().split(/\s+/), initrd: initrd[1].trim() };
  }
  return null;
}

export function patchGrub(text: string): string {
  const clean = strip(text);
  const live = grubLive(clean);
  if (!live) throw new Error('no live entry (a linux line with boot=live) in grub.cfg');
  const entry = (label: string, nvidia: boolean) => [`menuentry "${label}" {`, `\tlinux\t${live.kernel} ${nodeParams(live.words, nvidia)}`, `\tinitrd\t${live.initrd}`, '}'];
  const block = [START, 'set default=0', 'set timeout=5', ...entry('TOMLIN node', false), ...entry('TOMLIN node (install NVIDIA driver once, needs a network)', true), END];
  const lines = clean.split('\n');
  const at = lines.findIndex(l => /^\s*menuentry\s/.test(l));
  lines.splice(at < 0 ? lines.length : at, 0, ...block);
  return lines.join('\n');
}

/** isolinux: the first label whose append line has boot=live. */
export function syslinuxLive(text: string): { kernel: string; words: string[]; initrd: string | null } | null {
  const blocks = text.split(/\n(?=\s*label\s)/i);
  for (const b of blocks) {
    const k = /^\s*(?:linux|kernel)\s+(\S+)/im.exec(b);
    const a = /^\s*append\s+(.*)$/im.exec(b);
    if (!k || !a || !/\bboot=live\b/.test(a[1])) continue;
    const words = a[1].trim().split(/\s+/);
    const fromAppend = words.find(w => w.startsWith('initrd='))?.slice(7) ?? null;
    const initrd = /^\s*initrd\s+(\S+)/im.exec(b)?.[1] ?? fromAppend;
    return { kernel: k[1], words: words.filter(w => !w.startsWith('initrd=')), initrd };
  }
  return null;
}

export function patchSyslinux(text: string): string {
  const clean = strip(text);
  const live = syslinuxLive(clean);
  if (!live) throw new Error('no live entry (an append line with boot=live) in the isolinux menu');
  const entry = (name: string, label: string, nvidia: boolean, isDefault: boolean) => [
    `label ${name}`, `\tmenu label ${label}`, ...(isDefault ? ['\tmenu default'] : []), `\tlinux ${live.kernel}`,
    ...(live.initrd ? [`\tinitrd ${live.initrd}`] : []), `\tappend ${nodeParams(live.words, nvidia)}`, '',
  ];
  const others = muteTimeouts(clean).split('\n').map(l => (/^\s*menu default\s*$/i.test(l) ? `${l.replace(/menu default/i, '# menu default')} ${'# (TOMLIN node is the default)'}` : l));
  // timeout is in tenths of a second: an unattended PC starts the node after 5 s (Debian's own menu waits for a key).
  const block = [START, 'timeout 50', ...entry('tomlin-node', '^TOMLIN node', false, true), ...entry('tomlin-node-nvidia', 'TOMLIN node (install ^NVIDIA driver once)', true, false), END];
  const at = others.findIndex(l => /^\s*label\s/i.test(l));
  others.splice(at < 0 ? others.length : at, 0, ...block);
  return others.join('\n');
}

const TIMEOUT_NOTE = '# (TOMLIN node sets the timeout)';

/** The stick's own "timeout" lines commented out (syslinux takes the last one it reads, so one would undo ours). */
function muteTimeouts(text: string): string {
  return text.split('\n').map(l => (/^\s*timeout\s+\d+\s*$/i.test(l) ? `# ${l.trim()} ${TIMEOUT_NOTE}` : l)).join('\n');
}

/**
 * isolinux.cfg (or syslinux.cfg) when it is not the file with the live entry: Debian's sets "timeout 0" after its
 * includes, which would win over ours. Its own timeout is commented out and ours goes last.
 */
export function patchTimeout(text: string): string {
  const clean = muteTimeouts(strip(text)).replace(/\n*$/, '');
  return `${clean}\n${START}\ntimeout 50\n${END}\n`;
}

/** Undoes patchSyslinux and patchTimeout: the stick's own "menu default" and "timeout" lines back as they were. */
export function unpatchSyslinux(text: string): string {
  return strip(text).split('\n').map(l => l.replace(/# menu default # \(TOMLIN node is the default\)\s*$/, 'menu default').replace(/^# (timeout\s+\d+) # \(TOMLIN node sets the timeout\)$/i, '$1')).join('\n');
}
