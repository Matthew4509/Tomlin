// A node that is in use asks Windows not to sleep; idle, it is left free to sleep (and to be woken by wake-on-LAN: src/wake.ts).
import { spawn } from 'node:child_process';

/** A node is in use while a linked PC has a model loaded there or any request is running. */
export const nodeBusy = (o: { linkedModels: number; requests: number }): boolean => o.linkedModels > 0 || o.requests > 0;

/**
 * The Windows call, kept in a small helper process: ES_CONTINUOUS | ES_SYSTEM_REQUIRED (the PC stays awake; the screen may
 * still turn off). The setting lasts as long as that helper's thread lives, and it ends when this program's pipe closes.
 */
export function holdScript(): string {
  return [
    "Add-Type -Namespace T -Name P -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);'",
    '[void][T.P]::SetThreadExecutionState(0x80000001)',
    '[void][Console]::In.ReadToEnd()',
  ].join('; ');
}

export interface Hold {
  release(): void;
}

/** Holds Windows awake while wanted. `grace` keeps it held through the gap between two requests. */
export class KeepAwake {
  private hold: Hold | null = null;
  private idleSince = 0;
  private start: (() => Hold) | null;
  private grace: number;
  constructor(start: (() => Hold) | null, grace = 60_000) {
    this.start = start;
    this.grace = grace;
  }
  get holding(): boolean {
    return this.hold !== null;
  }
  set(wanted: boolean, now = Date.now()): void {
    if (!this.start) return;
    if (wanted) {
      this.idleSince = 0;
      this.hold ??= this.start();
      return;
    }
    if (!this.hold) return;
    this.idleSince ||= now;
    if (now - this.idleSince >= this.grace) {
      this.hold.release();
      this.hold = null;
      this.idleSince = 0;
    }
  }
}

/** Asks Windows through a helper PowerShell; nothing on another system or if it cannot start. */
function startWindowsHold(): Hold {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', holdScript()], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  child.on('error', () => undefined);
  child.stdin?.on('error', () => undefined);
  child.unref();
  return { release: () => void (child.stdin?.end(), child.kill()) };
}

/** This program's own holder. */
export const awake = new KeepAwake(process.platform === 'win32' ? startWindowsHold : null);

/** Another holder of its own (a shot list's), so it never lets go of the node's hold or the node of its. */
export const keepAwakeHolder = (): KeepAwake => new KeepAwake(process.platform === 'win32' ? startWindowsHold : null);
