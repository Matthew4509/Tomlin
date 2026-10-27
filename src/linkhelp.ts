// The link helper (2.0.64): what stops a main PC linking a node, said in plain words with the steps that fix it.
// Two halves, because each PC sees only part of it. On the node, nodeChecklist reads its own connection, address,
// network type and firewall (its Check button: before 2.0.64 it read the firewall alone and said "reachable" while its
// address, typed in by hand on another network, kept every PC out). On the main PC, diagnoseLink turns what it can
// test from there (the typed address, a ping, the node port, the node's hello, a name lookup, devices seen only by a
// link-local address) into one verdict. Pure rules here; the Windows readers are in src/netfacts.ts.
import { isIP } from 'node:net';
import { isPrivateAddress } from './share.ts';

export type Kind = 'home' | 'virtual' | 'vpn';
export type State = 'ok' | 'bad' | 'warn' | 'info';
export type Probe = 'open' | 'refused' | 'timeout' | 'unreachable';

/** One network connection of this PC with an IPv4 address, as Windows reports it. */
export interface Adapter {
  alias: string;
  description?: string;
  address: string;
  prefix: number;
  /** true: the router gives the address; false: typed in by hand; null: not known. */
  dhcp: boolean | null;
  gateway: string | null;
  /** The router answered a ping (null: not asked or not known). */
  gatewayAnswers: boolean | null;
}
/** A home connection of the main PC, as the helper uses it. */
export interface Own { alias: string; address: string; prefix: number; gateway: string | null }
export interface Line { state: State; text: string; steps?: string[] }

export interface NodeFacts {
  on: boolean;
  listening: boolean;
  port: number;
  adapters: Adapter[];
  /** src/firewall.ts judge(), or null when it could not be read. */
  firewall: { ok: boolean; problems: string[]; networks: { alias: string; category: string }[] } | null;
  /** Other security programs with a firewall of their own (Windows Security Center). */
  others: string[];
}
export interface NodeReport { ok: boolean; lines: Line[]; typeThis: string | null }

export interface LinkFacts {
  own: Own[];
  /** The person's answer to "Is TOMLIN open on the other PC, with Enable this PC as a node ticked?" (null: not sure). */
  nodeOn: boolean | null;
  address: string;
  name: string;
  port: number;
  ping: boolean | null;
  probe: Probe | null;
  whoami: { tomlin: boolean; version: string; linkOk: boolean } | null;
  named: { found: string[] } | null;
  /** Devices on this network seen only by a link-local IPv6 address (no IPv4 address on this network). */
  v6Only: number;
}
export interface Verdict { state: 'ok' | 'bad'; title: string; steps: string[]; lines: Line[] }

// ---- small helpers ----

const v4 = (ip: string) => ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
/** a and b on the same network, by the prefix (24 when not known). */
export function sameNet(a: string, b: string, prefix = 24): boolean {
  if (isIP(a) !== 4 || isIP(b) !== 4) return false;
  const bits = Math.max(0, Math.min(32, prefix || 24));
  const mask = bits ? (0xffffffff << (32 - bits)) >>> 0 : 0;
  return ((v4(a) & mask) >>> 0) === ((v4(b) & mask) >>> 0);
}
/** "192.168.0" of "192.168.0.20": what an address on the same home network starts with. */
const start = (ip: string) => ip.split('.').slice(0, 3).join('.');
const apipa = (ip: string) => ip.startsWith('169.254.');

/** Edit distance, for "192.178" typed for "192.168". */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
/** A public address one or two keys away from 192.168.x.y: the home address meant. */
function typoFix(ip: string): string | null {
  const [a, b, c, e] = ip.split('.');
  const head = `${a}.${b}`;
  return head !== '192.168' && distance(head, '192.168') <= 2 ? `192.168.${c}.${e}` : null;
}

// ---- adapters ----

const VPN = /vpn|tap-windows|\btap\b|wireguard|tailscale|zerotier|openvpn|nordlynx|anyconnect|fortinet|forticlient|wintun|globalprotect|pangp|hamachi|radmin/i;
const VIRTUAL = /vmware|virtualbox|hyper-v|vethernet|\bvirtual\b|loopback|npcap|\bwsl\b|docker|wi-fi direct|hosted network|local area connection\*|bluetooth/i;
/** A connection to the home router, a virtual-machine / hotspot / Bluetooth one, or a VPN, by its names. */
export function adapterKind(alias: string, description = ''): Kind {
  const s = `${alias} ${description}`;
  if (VPN.test(s)) return 'vpn';
  if (VIRTUAL.test(s)) return 'virtual';
  return 'home';
}

/** The JSON src/netfacts.ts reads from Windows (one object or a list) -> adapters; loopback and bad entries left out. */
export function parseAdapters(json: string): Adapter[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  const list = (Array.isArray(raw) ? raw : raw ? [raw] : []) as Record<string, unknown>[];
  return list.flatMap(x => {
    const address = String(x.address ?? '');
    if (isIP(address) !== 4 || address.startsWith('127.')) return [];
    const dhcp = String(x.dhcp ?? '').toLowerCase();
    const gateway = String(x.gateway ?? '').trim();
    return [{
      alias: String(x.alias ?? '').slice(0, 120),
      description: String(x.description ?? '').slice(0, 200),
      address,
      prefix: Number(x.prefix) || 24,
      dhcp: dhcp === 'enabled' ? true : dhcp === 'disabled' ? false : null,
      gateway: isIP(gateway) === 4 ? gateway : null,
      gatewayAnswers: null,
    }];
  });
}

/** The main PC's home connections: no virtual ones, no VPNs, none without an address from a network. */
export const homeOf = (adapters: Adapter[]): Own[] => adapters
  .filter(a => adapterKind(a.alias, a.description) === 'home' && !apipa(a.address))
  .map(({ alias, address, prefix, gateway }) => ({ alias, address, prefix, gateway }));

/** A failed connection's error code -> what it means for the node port. */
export function probeOf(code: string): Probe {
  if (code === 'ECONNREFUSED') return 'refused';
  if (code === 'ETIMEDOUT' || code === 'timeout') return 'timeout';
  return 'unreachable';
}

/**
 * Devices on this PC's network seen only by a link-local IPv6 address: their card has no IPv4 address on this network.
 * Windows still shares files with such a PC (it falls back to IPv6), so "file sharing works" proves nothing here.
 */
export function countV6Only(neighbors: { ip: string; mac: string }[], own: Own[]): number {
  const real = (mac: string) => /^[0-9a-f]{2}(-[0-9a-f]{2}){5}$/i.test(mac) && !/^33-33-/i.test(mac) && !/^(00-){5}00$/.test(mac) && !/^(ff-){5}ff$/i.test(mac);
  const here = new Set(neighbors.filter(n => isIP(n.ip) === 4 && own.some(o => sameNet(o.address, n.ip, o.prefix))).map(n => n.mac.toUpperCase()));
  return new Set(neighbors.filter(n => /^fe80:/i.test(n.ip) && real(n.mac) && !here.has(n.mac.toUpperCase())).map(n => n.mac.toUpperCase())).size;
}

// ---- the node: its own checklist ----

/** The steps that put a connection back on the router's addresses (Automatic, DHCP), on the PC itself. */
function automaticSteps(alias: string): string[] {
  const wifi = /wi-?fi|wireless|wlan/i.test(alias);
  return [
    `Open Settings, Network & internet, ${wifi ? "Wi-Fi, then your network's properties" : alias}.`,
    'Next to IP assignment, press Edit and pick Automatic (DHCP). Save.',
    'If DNS server assignment says Manual, set it to Automatic (DHCP) too.',
    "Wait 10 seconds, then press Check again: the address should now start like your main PC's.",
  ];
}

export function nodeChecklist(f: NodeFacts): NodeReport {
  const lines: Line[] = [];
  if (!f.on) lines.push({ state: 'bad', text: 'Enable this PC as a node is off: other PCs cannot link to it.', steps: ['Tick Enable this PC as a node, at the top of this page.'] });
  else if (!f.listening) lines.push({ state: 'bad', text: `TOMLIN could not open port ${f.port} for other PCs (another program may be using it).`, steps: ['Under Advanced: port, try another port, such as 8742.', 'Type the same port on your main PC.'] });

  const home = f.adapters.filter(a => adapterKind(a.alias, a.description) === 'home');
  let typeThis: string | null = null;
  if (!home.length) lines.push({ state: 'bad', text: 'This PC is not connected to a router: no cable or Wi-Fi connection with a home address.', steps: ['Plug in its network cable, or join the same Wi-Fi as your main PC.', 'Then press Check again.'] });
  for (const h of home) {
    const before = lines.length;
    const manual = h.dhcp === false;
    const routerHere = !!h.gateway && sameNet(h.gateway, h.address, h.prefix);
    if (apipa(h.address)) {
      lines.push({ state: 'bad', text: `${h.alias} did not get an address from your router (${h.address}).`, steps: ['Check the cable or the Wi-Fi, then restart the router or this PC.', ...automaticSteps(h.alias)] });
    } else if (manual && (!routerHere || h.gatewayAnswers === false)) {
      const dot1 = h.address.endsWith('.1');
      lines.push({ state: 'bad', text: `This PC's address on ${h.alias}, ${h.address}, was typed in by hand${dot1 ? ' (and .1 is the address a router usually has)' : ''}, and no router answers ${h.gateway ? `at ${h.gateway}` : 'there'}. Other PCs on your network cannot reach it this way, even if shared files still work.`, steps: automaticSteps(h.alias) });
    } else if (h.dhcp === null && h.gateway === null) {
      lines.push({ state: 'ok', text: `Connected by ${h.alias}: ${h.address} (its router could not be read).` });
    } else if (!h.gateway) {
      lines.push({ state: 'bad', text: `${h.alias} has the address ${h.address} but no router.`, steps: ['Check the cable or the Wi-Fi, then restart the router or this PC.', 'Then press Check again.'] });
    } else if (h.gatewayAnswers === false) {
      lines.push({ state: 'warn', text: `Connected by ${h.alias}: ${h.address}, but the router at ${h.gateway} did not answer. Some routers never do; if linking fails, restart the router.` });
    } else {
      lines.push({ state: 'ok', text: `Connected by ${h.alias}: ${h.address}, router ${h.gateway}${h.gatewayAnswers ? ' answers' : ''}${manual ? ' (address typed in by hand, and it matches the router: fine)' : ''}.` });
    }
    if (!typeThis && !lines.slice(before).some(l => l.state === 'bad')) typeThis = `${h.address}:${f.port}`;
  }

  if (!f.firewall) lines.push({ state: 'warn', text: `Could not read this PC's firewall. Allow TCP port ${f.port} in for your home network.` });
  else if (f.firewall.ok) lines.push({ state: 'ok', text: `Windows Firewall lets other PCs in on port ${f.port} (${f.firewall.networks.map(n => `${n.alias}: ${n.category}`).join(', ') || 'no network'}).` });
  else lines.push({ state: 'bad', text: f.firewall.problems.join(' '), steps: ['Press Copy below, then: Start, type PowerShell, right-click it, Run as administrator, paste, press Enter.', 'Then press Check again.'] });
  if (f.others.length) lines.push({ state: 'warn', text: `${f.others.join(', ')} also guards this PC, and Windows' rules do not pass it. This cannot be checked from here: if your main PC still finds nothing, mark your home network as trusted in it, or allow Node.js.` });

  for (const a of f.adapters.filter(x => adapterKind(x.alias, x.description) === 'vpn')) lines.push({ state: 'warn', text: `A VPN is on (${a.alias}): it can hide this PC from your home network. Turn it off while linking, or allow local-network access in it.` });
  for (const a of f.adapters.filter(x => adapterKind(x.alias, x.description) === 'virtual')) lines.push({ state: 'info', text: `Ignore ${a.alias} (${a.address}): it belongs to a virtual-machine, hotspot or Bluetooth program, not your home network.` });

  const ok = !lines.some(l => l.state === 'bad');
  lines.push({ state: 'info', text: "These are this PC's own settings. Whether other PCs get through is tested from your main PC: Network, Find PCs on my network, then the Link helper there." });
  return { ok, lines, typeThis: ok ? typeThis : null };
}

// ---- the main PC: what was typed ----

export function addressAdvice(raw: string, own: Own[], defaultPort = 8741): { url: string | null; problem: string | null; suggest: string | null; warn: string | null } {
  const ex = `${own[0] ? start(own[0].address) : '192.168.1'}.20:${defaultPort}`;
  const no = (problem: string, suggest: string | null = null) => ({ url: null, problem, suggest, warn: null });
  const typed = String(raw ?? '').trim();
  if (!typed) return no(`Type the address shown on that PC under Network (for example ${ex}).`);
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(typed) ? typed : `http://${typed}`);
  } catch {
    return no(`${typed.slice(0, 60)} is not a PC's address. Type it as that PC shows it (for example ${ex}).`);
  }
  if (u.protocol !== 'http:' || u.username || u.password || (u.pathname !== '/' && u.pathname !== '')) return no(`${typed.slice(0, 60)} is not a PC's address. Type it as that PC shows it (for example ${ex}).`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const port = u.port ? Number(u.port) : defaultPort;
  const readIt = "Read the other PC's own address on it: TOMLIN, Network, This PC's address.";
  if (isIP(host) === 4) {
    if (!isPrivateAddress(host)) {
      const fixed = typoFix(host);
      if (fixed && own.some(o => o.gateway === fixed)) return no(`${host} is not a home-network address. ${fixed} would be your router (the box that shares the internet), not the other PC. ${readIt}`);
      if (fixed) return no(`${host} is not a home-network address: did you mean ${fixed}?`, `${fixed}:${port}`);
      return no(`${host} is not on your home network. Use the address shown on that PC under Network (for example ${ex}).`);
    }
    if (own.some(o => o.gateway === host)) return no(`${host} is your router (the box that shares the internet), not the other PC. ${readIt}`);
    if (own.some(o => o.address === host)) return no(`${host} is this PC's own address. Type the other PC's address, shown on it under Network.`);
    const last = Number(host.split('.')[3]);
    if (last === 0 || last === 255) return no(`${host} ends in .${last}, which is not a PC's address. ${readIt}`);
    const warn = own.length && !own.some(o => sameNet(o.address, host, o.prefix))
      ? `${host} is on a different network from this PC (${own.map(o => o.address).join(', ')}). On the same router, the other PC's address should start ${start(own[0].address)}. If it really shows ${host}, its address was probably typed in by hand: on it, TOMLIN, Network, press Check.`
      : null;
    return { url: `http://${host}:${port}`, problem: null, suggest: null, warn };
  }
  if (isIP(host) === 6) return isPrivateAddress(host) ? { url: `http://[${host}]:${port}`, problem: null, suggest: null, warn: null } : no(`${host} is not on your home network.`);
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(host)) return no(`${host.slice(0, 60)} is not a PC's address or name.`);
  return { url: `http://${host}:${port}`, problem: null, suggest: null, warn: null };
}

/** The link PIN box: empty, or the 6 digits that PC shows. 4 or 5 digits is its app lock PIN, which never goes here. */
export function pinAdvice(pin: string): string | null {
  const digits = String(pin ?? '').replace(/\D/g, '');
  if (!digits || digits.length === 6) return null;
  return 'A link PIN is 6 digits, shown on that PC under "Also ask for a PIN". This looks like its app lock PIN, which never goes here: leave this box empty unless that PC shows a link PIN.';
}

// ---- the main PC: the verdict ----

export function diagnoseLink(f: LinkFacts): Verdict {
  const lines: Line[] = [];
  const bad = (title: string, steps: string[]): Verdict => ({ state: 'bad', title, steps, lines });
  if (!f.own.length) return bad('This PC has no home-network connection, so it cannot reach another PC.', ['Plug in its network cable, or join your home Wi-Fi.', 'Then press Check again.']);
  const here = start(f.own[0].address);
  lines.push({ state: 'info', text: `This PC: ${f.own.map(o => `${o.address} on ${o.alias}`).join(', ')}${f.own[0].gateway ? `, router ${f.own[0].gateway}` : ''}.` });
  if (f.nodeOn === false) return bad('Start TOMLIN on the other PC first.', ['On the other PC: open TOMLIN (Start menu, TOMLIN).', 'Set up, Network: tick Enable this PC as a node (it asks for an app lock PIN first).', 'Then press Check here again.']);

  const advice = f.address ? addressAdvice(f.address, f.own, f.port) : null;
  if (advice?.problem) return bad(advice.problem, advice.suggest ? [`Use ${advice.suggest}, then press Check again.`] : [`On the other PC: TOMLIN, Set up, Network. Its address is under This PC's address: type the one that starts ${here}.`]);

  const who = f.name || 'that PC';
  const onThatPc = (name: string) => [
    `On ${name}: Settings, Network & internet, then its Ethernet or Wi-Fi connection.`,
    'Next to IP assignment, press Edit and pick Automatic (DHCP). Save (DNS server assignment too, if it says Manual).',
    `Its address should then start ${here}. Press Find PCs on my network here again.`,
  ];
  let found: string | null = null;
  if (f.name && f.named) {
    const near = f.named.found.filter(ip => f.own.some(o => sameNet(o.address, ip, o.prefix)));
    if (near.length) {
      lines.push({ state: 'info', text: `${f.name} is at ${near.join(', ')}.` });
      found = near.find(ip => isIP(ip) === 4) ?? null;
    } else if (f.named.found.length) lines.push({ state: 'warn', text: `${f.name} answers by name at ${f.named.found.join(', ')}, which is not this PC's network.` });
    else lines.push({ state: 'info', text: `No PC called ${f.name} answered by name (some home networks never answer names).` });
  }
  // A device here with no address on this network: said only where the other PC was not reached (a PC that answers
  // on this network is not it).
  const v6Line = () => { if (f.v6Only) lines.push({ state: 'warn', text: `${f.v6Only} device${f.v6Only === 1 ? '' : 's'} on your network ${f.v6Only === 1 ? 'has' : 'have'} no ${here}. address: one is most likely the other PC, with its address typed in by hand.` }); };

  const target = advice?.url ? new URL(advice.url).hostname.replace(/^\[|\]$/g, '') : found;
  if (!target) {
    v6Line();
    if (f.name) return bad(`Could not find ${f.name} from here.`, [`Type the address shown on ${f.name} instead: TOMLIN, Set up, Network, This PC's address (the one that starts ${here}).`, ...(f.v6Only ? onThatPc(f.name) : [])]);
    return bad('Type the address shown on that PC, or its name.', [`On the other PC: TOMLIN, Set up, Network, This PC's address (the one that starts ${here}).`]);
  }
  const port = advice?.url ? Number(new URL(advice.url).port) || f.port : f.port;
  const at = `${target}:${port}`;

  if (f.whoami) {
    if (!f.whoami.tomlin) return bad(`Something else answers at ${at}, not TOMLIN.`, ['Check the port: 8741 unless it was changed on that PC (Network, Advanced: port).']);
    if (!f.whoami.linkOk) return bad(`${at} runs an older TOMLIN (${f.whoami.version || 'before 2.0.26'}), which cannot make the encrypted link.`, ['Update TOMLIN on that PC: copy the newest zip there and run its Install TOMLIN.cmd.', 'Then link again.']);
    return { state: 'ok', title: `TOMLIN answers at ${at}${f.whoami.version ? ` (${f.whoami.version})` : ''}.`, steps: ['Type its setup code (shown on it under Network) and press Link. Leave Link PIN empty unless it shows one.'], lines };
  }
  if (f.probe === 'open') return bad(`Something answers at ${at}, but not as TOMLIN.`, ['Check the port: 8741 unless it was changed on that PC (Network, Advanced: port).']);
  if (f.probe === 'refused') return bad(`${target} is there, but TOMLIN's node is not listening on port ${port}.`, [`On ${who}: open TOMLIN, Set up, Network, tick Enable this PC as a node.`, 'If it is ticked, compare its port (Advanced: port) with the one here.']);
  if (advice?.warn) {
    v6Line();
    lines.push({ state: 'warn', text: advice.warn });
    return bad(`${target} is on a different network from this PC.`, [...onThatPc(who), 'Or, if that PC is on another router (a second router, an extender with its own network, or a guest Wi-Fi), connect it to the same router or Wi-Fi as this PC.']);
  }
  if (f.ping) return bad(`${target} is on, but something on it blocks port ${port}.`, [
    `On ${who}: TOMLIN, Set up, Network, press Check under "Can other PCs reach this one?" and do what it says.`,
    'If Check finds nothing wrong, its antivirus or security program is blocking: in it, trust your home network or allow Node.js.',
    'Or run Install TOMLIN.cmd again there and answer Yes to the firewall question.',
  ]);
  v6Line();
  return bad(`Nothing answers at ${target}.`, [
    'Check that PC is on and awake, and on the same router or Wi-Fi as this one (not a guest Wi-Fi).',
    "Read its address again on it (TOMLIN, Network, This PC's address): it can change after a restart.",
    ...(f.v6Only ? onThatPc(who) : []),
  ]);
}
