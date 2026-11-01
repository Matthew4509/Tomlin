// "Can other PCs reach this one?": reads this PC's own Windows network type and firewall rules and writes the PowerShell
// lines that would fix what it finds. Nothing here changes a setting: the owner copies the lines and runs them in an
// administrator PowerShell window. The rules are read through Windows' firewall object: on some PCs Get-NetFirewallRule
// answers "Access is denied" without admin, which used to read as "no rules".
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const RULE_NAME = 'TOMLIN node';
/** The rule under the app's earlier name, on PCs set up before it: it lets other PCs in just the same. */
export const OLD_RULE_NAMES = ['Smart Manager node'];

export interface FirewallRule { name: string; profile: string; action: string }
export interface FirewallFacts {
  /** Each connected network: its adapter ("Wi-Fi") and type ("Private", "Public", "DomainAuthenticated"). */
  networks: { alias: string; category: string }[];
  /** Enabled inbound rules for the worker port. */
  portRules: FirewallRule[];
  /** Enabled inbound rules for this Node.js program (Windows makes these when its "allow access" box is answered). */
  appRules: FirewallRule[];
  /** False when Windows would not give the rules: then the two lists above say nothing. */
  rulesRead?: boolean;
  /** Other security programs that run their own firewall (ESET, Norton...), from Windows Security Center. */
  others: string[];
}
/** One enabled inbound rule, as Windows' firewall object gives it. */
export interface RawRule {
  name: string;
  /** Network types added up: 1 Domain, 2 Private, 4 Public. */
  profiles: number;
  /** 1 allow, 0 block. */
  action: number;
  /** 6 TCP, 17 UDP, 256 any. */
  protocol: number;
  /** "8741", "80,443", "8000-9000" or "*". */
  ports: string;
  /** The program it is for, '' for any. */
  app: string;
}
export interface FirewallCheck {
  ok: boolean;
  /** The firewall's rules could not be read: nothing is known about them, good or bad. */
  unread?: boolean;
  problems: string[];
  /** The lines that fix it, to read; empty when nothing needs fixing. */
  fix: string;
  /** The same lines as one command that runs the same in PowerShell or Command Prompt (opened as administrator). */
  run: string;
  others: string[];
  networks: { alias: string; category: string }[];
}

/** PowerShell quoting: inside '...' a ' is written twice. */
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * PowerShell lines as one command for either window: Command Prompt does not know PowerShell's commands, and pasted
 * into PowerShell a "..." string would read $_ itself, so the lines travel encoded (UTF-16, base64) as PowerShell expects.
 */
export function oneCommand(lines: string[]): string {
  const script = [...lines, `Write-Host 'Done. Press Check again in TOMLIN.'`].join('; ');
  return `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
}

/** "Domain, Private" or "Any", from Windows' number, as Get-NetFirewallRule writes it. */
export function profileWords(bits: number): string {
  if ((bits & 7) === 7) return 'Any';
  return ([[1, 'Domain'], [2, 'Private'], [4, 'Public']] as const).filter(([bit]) => bits & bit).map(([, word]) => word).join(', ');
}

/** Whether a rule's ports take in `port`: one, a list, a range or all. */
export function portIn(ports: string, port: number): boolean {
  return ports.split(',').map(p => p.trim()).some(p => {
    if (p === '*' || p === String(port)) return true;
    const range = /^(\d+)-(\d+)$/.exec(p);
    return !!range && port >= Number(range[1]) && port <= Number(range[2]);
  });
}

/** The rules that decide `port` for `exe`: a TCP rule for that port, for any program or for this one. */
export function rulesFrom(raw: RawRule[], port: number, exe: string): { portRules: FirewallRule[]; appRules: FirewallRule[] } {
  const named = (r: RawRule): FirewallRule => ({ name: r.name, profile: profileWords(r.profiles), action: r.action === 1 ? 'Allow' : 'Block' });
  const here = raw.filter(r => (r.protocol === 6 || r.protocol === 256) && portIn(r.ports, port));
  return { portRules: here.filter(r => !r.app).map(named), appRules: here.filter(r => r.app.toLowerCase() === exe.toLowerCase()).map(named) };
}

/** Security Center's list without the programs since uninstalled (it keeps them), each name once. */
export function liveOthers(list: unknown): string[] {
  const all = (Array.isArray(list) ? list : list ? [list] : []) as { name: unknown; there: unknown }[];
  return [...new Set(all.filter(o => o.there !== false).map(o => String(o.name)))];
}

/** A rule covers a network type when its profile is Any or names that type. */
function covers(rule: FirewallRule, category: string): boolean {
  const p = rule.profile.toLowerCase();
  const want = category.toLowerCase().startsWith('domain') ? 'domain' : category.toLowerCase();
  return p === 'any' || p.split(/\s*,\s*/).includes(want);
}

/** What stops other PCs reaching `port`, and the lines that fix it. */
export function judge(f: FirewallFacts, port: number, exe: string): FirewallCheck {
  const problems: string[] = [];
  const fix: string[] = [];
  const nets = f.networks.length ? f.networks : [];
  const publicNets = nets.filter(n => n.category.toLowerCase() === 'public');
  for (const n of publicNets) {
    problems.push(`The network on ${n.alias} is set to Public, so Windows blocks other PCs.`);
    fix.push(`Set-NetConnectionProfile -InterfaceAlias ${q(n.alias)} -NetworkCategory Private`);
  }
  const all = [...f.portRules, ...f.appRules];
  const blocks = f.appRules.filter(r => r.action.toLowerCase() === 'block');
  if (blocks.length) {
    problems.push(`Windows has a rule blocking Node.js (made when its "allow access" box was cancelled).`);
    fix.push(`Get-NetFirewallApplicationFilter -Program ${q(exe)} | Get-NetFirewallRule | Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' } | Disable-NetFirewallRule`);
  }
  // After the fix every network is Private (or a work domain), so an allow rule must cover those.
  const after = nets.length ? nets.map(n => (n.category.toLowerCase() === 'public' ? 'Private' : n.category)) : ['Private'];
  const allowed = after.every(c => all.some(r => r.action.toLowerCase() === 'allow' && covers(r, c)));
  const unread = f.rulesRead === false;
  if (!allowed && !unread) {
    problems.push(`No firewall rule lets other PCs in on port ${port}.`);
    // Only ever one: running these lines again replaces TOMLIN's rule.
    fix.push(`Remove-NetFirewallRule -DisplayName ${q(RULE_NAME)} -ErrorAction SilentlyContinue`);
    fix.push(`New-NetFirewallRule -DisplayName ${q(RULE_NAME)} -Direction Inbound -Protocol TCP -LocalPort ${port} -Action Allow -Profile Private,Domain`);
  }
  return { ok: !problems.length && !unread, ...(unread ? { unread } : {}), problems, fix: fix.join('\n'), run: fix.length ? oneCommand(fix) : '', others: f.others, networks: nets };
}

/** Reads the facts from Windows. Null on other systems, or when PowerShell cannot answer. */
export async function read(port: number, exe: string): Promise<FirewallFacts | null> {
  if (process.platform !== 'win32') return null;
  const ps = [
    `$n = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ alias = $_.InterfaceAlias; category = [string]$_.NetworkCategory } })`,
    `$read = $true`,
    `$r = @()`,
    `try { $r = @((New-Object -ComObject HNetCfg.FwPolicy2).Rules | Where-Object { $_.Enabled -and $_.Direction -eq 1 } | ForEach-Object { [pscustomobject]@{ name = $_.Name; profiles = $_.Profiles; action = $_.Action; protocol = $_.Protocol; ports = [string]$_.LocalPorts; app = [Environment]::ExpandEnvironmentVariables([string]$_.ApplicationName) } }) } catch { $read = $false }`,
    // A path that is not a plain file on this PC cannot be checked, so it counts as there.
    `$o = @(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName FirewallProduct -ErrorAction SilentlyContinue | ForEach-Object { $x = [Environment]::ExpandEnvironmentVariables([string]$_.pathToSignedProductExe).Trim('"'); [pscustomobject]@{ name = $_.displayName; there = ($x -notmatch '^[A-Za-z]:\\\\' -or (Test-Path -LiteralPath $x)) } })`,
    `[pscustomobject]@{ networks = $n; rules = $r; read = $read; others = $o } | ConvertTo-Json -Depth 4 -Compress`,
  ].join('; ');
  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 60_000, maxBuffer: 1 << 24 });
    const j = JSON.parse(stdout.trim()) as Record<string, unknown>;
    const list = <T>(v: unknown): T[] => (Array.isArray(v) ? v : v ? [v] : []) as T[];
    return {
      networks: list<{ alias: string; category: string }>(j.networks).map(n => ({ alias: String(n.alias), category: String(n.category) })),
      ...rulesFrom(list<RawRule>(j.rules).map(r => ({ name: String(r.name), profiles: Number(r.profiles), action: Number(r.action), protocol: Number(r.protocol), ports: String(r.ports ?? ''), app: String(r.app ?? '') })), port, exe),
      rulesRead: j.read === true,
      others: liveOthers(j.others),
    };
  } catch {
    return null;
  }
}
