// "Can other PCs reach this one?": reads this PC's own Windows network type and firewall rules (no admin needed to read)
// and writes the PowerShell lines that would fix what it finds. Nothing here changes a setting: the owner copies the
// lines and runs them in an administrator PowerShell window.
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
  /** Other security programs that run their own firewall (ESET, Norton...), from Windows Security Center. */
  others: string[];
}
export interface FirewallCheck {
  ok: boolean;
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
  if (!allowed) {
    problems.push(`No firewall rule lets other PCs in on port ${port}.`);
    fix.push(`New-NetFirewallRule -DisplayName ${q(RULE_NAME)} -Direction Inbound -Protocol TCP -LocalPort ${port} -Action Allow -Profile Private,Domain`);
  }
  return { ok: !problems.length, problems, fix: fix.join('\n'), run: fix.length ? oneCommand(fix) : '', others: f.others, networks: nets };
}

/** Reads the facts from Windows. Null on other systems, or when PowerShell cannot answer. */
export async function read(port: number, exe: string): Promise<FirewallFacts | null> {
  if (process.platform !== 'win32') return null;
  const rules = (filter: string) => `@(${filter} -ErrorAction SilentlyContinue | Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' } | ForEach-Object { [pscustomobject]@{ name = $_.DisplayName; profile = [string]$_.Profile; action = [string]$_.Action } })`;
  const ps = [
    `$n = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ alias = $_.InterfaceAlias; category = [string]$_.NetworkCategory } })`,
    `$p = ${rules(`Get-NetFirewallPortFilter -Protocol TCP | Where-Object { $_.LocalPort -eq '${port}' }`)}`,
    `$a = ${rules(`Get-NetFirewallApplicationFilter -Program ${q(exe)}`)}`,
    `$o = @(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName FirewallProduct -ErrorAction SilentlyContinue | ForEach-Object { $_.displayName })`,
    `[pscustomobject]@{ networks = $n; portRules = $p; appRules = $a; others = $o } | ConvertTo-Json -Depth 4 -Compress`,
  ].join('; ');
  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 60_000 });
    const j = JSON.parse(stdout.trim()) as Record<string, unknown>;
    const list = <T>(v: unknown): T[] => (Array.isArray(v) ? v : v ? [v] : []) as T[];
    return {
      networks: list<{ alias: string; category: string }>(j.networks).map(n => ({ alias: String(n.alias), category: String(n.category) })),
      portRules: list<FirewallRule>(j.portRules).map(r => ({ name: String(r.name), profile: String(r.profile), action: String(r.action) })),
      appRules: list<FirewallRule>(j.appRules).map(r => ({ name: String(r.name), profile: String(r.profile), action: String(r.action) })),
      others: [...new Set(list<string>(j.others).map(String))],
    };
  } catch {
    return null;
  }
}
