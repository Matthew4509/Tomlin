// What the link helper (src/linkhelp.ts) reads from this PC and the home network: its connections (how each address
// was set, its router, whether the router answers), a ping, the node port, a name lookup, and the devices Windows has
// seen nearby. Nothing here changes a setting, and nothing is sent outside the home network: every address asked is
// checked as private first. Reads that cannot run (not Windows, PowerShell not answering) give null or nothing.
import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { connect, isIP } from 'node:net';
import { promisify } from 'node:util';
import { type Adapter, parseAdapters, type Probe, probeOf } from './linkhelp.ts';
import { isPrivateAddress } from './share.ts';

const run = promisify(execFile);
const ps = (script: string, timeout = 30_000) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout, maxBuffer: 1 << 20 });

/** One ping (about a second): true when it answered. Only a private address, given as a number. */
export async function pingHost(ip: string): Promise<boolean | null> {
  if (!isIP(ip) || !isPrivateAddress(ip)) return null;
  const args = process.platform === 'win32' ? ['-n', '1', '-w', '1200', ip] : ['-c', '1', '-W', '1', ip];
  try {
    const { stdout } = await run('ping', args, { windowsHide: true, timeout: 5000 });
    return /ttl[=<]/i.test(stdout);
  } catch (e) {
    return /ttl[=<]/i.test(String((e as { stdout?: string }).stdout ?? '')) ? true : false;
  }
}

/** This PC's IPv4 connections, each with how its address was set, its router and whether the router answers. */
export async function readAdapters(): Promise<Adapter[] | null> {
  if (process.platform !== 'win32') return null;
  const script = [
    '$c = @(Get-NetIPConfiguration -ErrorAction SilentlyContinue | Where-Object { $_.IPv4Address } | ForEach-Object {',
    '  $cfg = $_; $i = Get-NetIPInterface -InterfaceIndex $cfg.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue',
    '  foreach ($a in @($cfg.IPv4Address)) { [pscustomobject]@{ alias = $cfg.InterfaceAlias; description = $cfg.InterfaceDescription; address = $a.IPAddress; prefix = [int]$a.PrefixLength; dhcp = [string]$i.Dhcp; gateway = [string](@($cfg.IPv4DefaultGateway)[0].NextHop) } } })',
    'ConvertTo-Json -InputObject $c -Compress',
  ].join('\n');
  let adapters: Adapter[];
  try {
    adapters = parseAdapters((await ps(script)).stdout.trim());
  } catch {
    return null;
  }
  const gateways = [...new Set(adapters.map(a => a.gateway).filter((g): g is string => !!g))];
  const answers = new Map(await Promise.all(gateways.map(async g => [g, await pingHost(g)] as const)));
  return adapters.map(a => ({ ...a, gatewayAnswers: a.gateway ? answers.get(a.gateway) ?? null : null }));
}

/** Whether `port` takes a connection: open, refused (nothing listens), timeout (dropped: a firewall), unreachable. */
export function probePort(host: string, port: number, ms = 2500): Promise<Probe> {
  return new Promise(done => {
    const s = connect({ host, port });
    const end = (p: Probe) => {
      s.destroy();
      done(p);
    };
    s.setTimeout(ms, () => end('timeout'));
    s.once('connect', () => end('open'));
    s.once('error', e => end(probeOf((e as NodeJS.ErrnoException).code ?? '')));
  });
}

/** A PC's name looked up the way Windows does (DNS, then the home network's own name answers): private addresses only. */
export async function lookupName(name: string): Promise<string[]> {
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(name)) return [];
  try {
    const found = await Promise.race([lookup(name, { all: true }), new Promise<never>((_, no) => setTimeout(() => no(new Error('timeout')), 4000))]);
    return [...new Set(found.map(f => f.address).filter(a => isPrivateAddress(a)))];
  } catch {
    return [];
  }
}

/** The devices Windows has seen on this PC's networks lately (its neighbour table): address and card. */
export async function readNeighbors(): Promise<{ ip: string; mac: string }[]> {
  if (process.platform !== 'win32') return [];
  try {
    const { stdout } = await ps("ConvertTo-Json -Compress -InputObject @(Get-NetNeighbor -ErrorAction SilentlyContinue | Where-Object { $_.State -ne 'Unreachable' -and $_.LinkLayerAddress } | ForEach-Object { [pscustomobject]@{ ip = [string]$_.IPAddress; mac = [string]$_.LinkLayerAddress } })");
    const raw = JSON.parse(stdout.trim() || '[]') as unknown;
    return (Array.isArray(raw) ? raw : raw ? [raw] : []).map(n => ({ ip: String((n as Record<string, unknown>).ip ?? ''), mac: String((n as Record<string, unknown>).mac ?? '') }));
  } catch {
    return [];
  }
}
