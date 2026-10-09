// Notifications: finished / question / stuck. The server raises a SILENT Windows notification when the page is not in
// front (closed, minimised or behind another window); clicking it opens that chat or job room. While the page is
// open it plays one short sound per kind of event. Words name the person and the event, never what was written.
// Mute (src/mute.ts) silences both. Settings in data/notify.json. Plain functions, tested in test/notify.test.ts.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { JobEvent } from './home.ts';
import type { Event } from './mute.ts';
import { readData, writeAtomic } from './atomic.ts';

export interface NotifySettings {
  /** A silent Windows notification when the page is not in front. */
  windows: boolean;
  /** One short sound in the page per event, while it is open. */
  sound: boolean;
  /** 0-100. */
  volume: number;
}

export const DEFAULTS: NotifySettings = { windows: true, sound: true, volume: 60 };

export function clean(x: Partial<NotifySettings> | null | undefined): NotifySettings {
  const v = Number(x?.volume);
  return {
    windows: x?.windows !== false,
    sound: x?.sound !== false,
    volume: Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : DEFAULTS.volume,
  };
}

/** One thing that happened, as the page and the notification show it. */
export interface Told {
  seq: number;
  at: string;
  event: Event;
  /** "Sam finished step 2. Please review." Person and event only. */
  text: string;
  /** What a click opens: "chat:<id>" or "room:<job id>". */
  open: string;
}

/** A job event worth telling, worded with the person who did it ("the coder" when nobody was hired), or null. */
export function jobTold(e: JobEvent, who: (role: string | null) => string): { event: Event; text: string; role: string | null } | null {
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  switch (e.type) {
    case 'result': return { event: 'finished', text: `${cap(who(e.role))} finished step ${e.n + 1}. Please review.`, role: e.role };
    case 'report': return { event: 'finished', text: 'The end-of-job report is written. Please read it.', role: 'reviewer' };
    case 'saved': return e.left === 0 ? { event: 'finished', text: 'Every step of a job is done. Please review the result.', role: null } : null;
    case 'plan': return { event: 'question', text: `${cap(who('planner'))} made a plan. Read it before it runs.`, role: 'planner' };
    case 'picture': return { event: 'question', text: `Step ${e.n + 1} needs a picture from ${who(e.role)}.`, role: e.role };
    case 'failed': return e.error === 'Stopped.' ? null : { event: 'stuck', text: `${cap(who(e.role))}'s step ${e.n + 1} stopped. It needs you.`, role: e.role };
    case 'tests': return e.ok ? null : { event: 'stuck', text: 'The tests failed. A job needs you.', role: null };
    default: return null;
  }
}

/** A chat answer: the person's name. */
export const chatTold = (name: string): string => `${name} answered.`;

const xml = (s: string) => s.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);

/** The PowerShell lines that show one silent notification; a click opens `url` in the browser. */
export function toastScript(text: string, url: string): string {
  const doc = `<toast activationType="protocol" launch="${xml(url)}"><visual><binding template="ToastGeneric"><text>TOMLIN</text><text>${xml(text)}</text></binding></visual><audio silent="true"/></toast>`;
  // Windows PowerShell's own app id: a notification needs a registered app, and this one is on every Windows PC.
  const app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
  return [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$x.LoadXml('${doc.replace(/'/g, "''")}')`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${app}').Show([Windows.UI.Notifications.ToastNotification]::new($x))`,
  ].join('\n');
}

/** Shows it (Windows only; a failure is ignored: a notification is never worth a fault). */
function toast(text: string, url: string): void {
  if (process.platform !== 'win32' || process.env.TOMLIN_NO_TOAST) return;
  try {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(toastScript(text, url), 'utf16le').toString('base64')], { stdio: 'ignore', windowsHide: true });
    p.on('error', () => {});
    p.unref();
  } catch {
    // ignored on purpose (see above)
  }
}

/** Keeps the settings, the last events for the page, and whether the page is in front. */
export class Notifier {
  private dir: string;
  private cache: NotifySettings | null = null;
  private told: Told[] = [];
  private seq = 0;
  private frontAt = 0;
  private lastText = new Map<string, number>();
  /** Where a click goes: http://127.0.0.1:<port>/ */
  base = '';

  constructor(dir: string) {
    this.dir = dir;
  }

  async settings(): Promise<NotifySettings> {
    if (!this.cache) {
      this.cache = clean(await readData<Partial<NotifySettings> | null>(join(this.dir, 'notify.json'), null));
    }
    return this.cache;
  }

  async save(change: Partial<NotifySettings>): Promise<NotifySettings> {
    this.cache = clean({ ...(await this.settings()), ...change });
    await writeAtomic(join(this.dir, 'notify.json'), JSON.stringify(this.cache, null, 1));
    return this.cache;
  }

  /** The page asks for Home every few seconds and says whether it is in front. */
  seen(front: boolean): void {
    if (front) this.frontAt = Date.now();
  }

  /** In front within the last 10 seconds. */
  inFront(now = Date.now()): boolean {
    return now - this.frontAt < 10_000;
  }

  /** The last events (the page plays a sound for ones newer than it has seen). */
  recent() {
    return { seq: this.seq, told: this.told };
  }

  /** A test notification, whatever is in front (the Notifications settings' "Send a test"). */
  test(): void {
    if (this.base) toast('A test notification. Click it to open TOMLIN.', this.base);
  }

  /** Tells one event (the caller has already checked Mute). The same words within 5 seconds are told once. */
  async tell(event: Event, text: string, open: string, now = Date.now()): Promise<Told | null> {
    if ((this.lastText.get(text) ?? 0) > now - 5000) return null;
    this.lastText.set(text, now);
    const t: Told = { seq: ++this.seq, at: new Date(now).toISOString(), event, text, open };
    this.told = [...this.told, t].slice(-20);
    const s = await this.settings();
    if (s.windows && !this.inFront(now) && this.base) {
      const [kind, id] = open.split(':');
      // A linked PC's news opens the app; a chat or a job room opens that one.
      toast(text, kind === 'nodes' ? this.base : `${this.base}?${kind === 'room' ? 'room' : 'chat'}=${encodeURIComponent(id ?? '')}`);
    }
    return t;
  }
}
