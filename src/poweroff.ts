// A host turns a linked PC (a node) off (17 Nov 2026). Three things must all be true on the node: its owner's tick "Allow
// host to turn this PC off" (on unless unticked, src/carry.ts Allow.off), nobody using it now (TOMLIN, or any other program in the last minutes), and its app lock PIN typed
// on the host for this one turn-off (checked there, wrong tries counted per link, as for an update or a model delete).
// One PC per request: a cluster is turned off by asking each of its PCs in turn, never by one request for many. A guest
// link never reaches the door (src/guestpass.ts allows only GUEST_DOORS). The node answers first, then shuts down.
// Plain parts, tested in test/poweroff.test.ts; the door is in src/jobrun/node.ts, the host side in src/jobrun/copies.ts.
export const POWER_DOOR = '/worker/power-off';
/** Seconds between the node's answer and Windows shutting down (the node can still tell the host, a person can cancel with shutdown /a). */
export const OFF_SECONDS = 15;
/** A PC used this short a while ago (and not locked) is not turned off: Windows closes its open programs without saving. */
export const USED_MINUTES = 5;

type Pin = { ok: true } | { status: number; error: string };

export interface PowerOffDeps {
  /** The owner's tick. */
  allowed: () => boolean;
  pcName: () => string;
  /** Away: the owner is using the PC for the hours the main PC agreed to. */
  away: () => boolean;
  /** Why the PC cannot go off now (someone is answering, drawing, a job runs), or null. */
  busy: () => string | null;
  /**
   * Someone is at the PC in another program (Windows not locked, a key or the mouse used in the last USED_MINUTES): how,
   * in plain words; null when nobody is, or when it cannot be told. Left out: not looked at.
   */
  inUse?: () => Promise<string | null>;
  /** The app lock PIN as typed on the host, checked here; or the host PIN that link gave (`host`, src/hostpin.ts). */
  pinCheck: (pin: unknown, who: string, host?: { pin: unknown; link: string | undefined }) => Promise<Pin>;
  /** Whether this PC can be shut down by TOMLIN (Windows). */
  supported: boolean;
  /** Starts the shutdown, `seconds` from now, naming who asked. */
  run: (seconds: number, by: string) => void;
}

/** The node's door: the answer for one request from a linked PC. Never throws. */
export function powerOffSide(d: PowerOffDeps) {
  return async (body: Record<string, unknown>, who: { key: string; name: string; link?: string }): Promise<{ status: number; json: Record<string, unknown> }> => {
    const name = d.pcName();
    if (!d.allowed()) return { status: 403, json: { error: `"${name}" does not allow a host to turn it off now (its owner ticks "Allow host to turn this PC off" on This PC).` } };
    if (!d.supported) return { status: 501, json: { error: `"${name}" cannot be turned off by TOMLIN (only a Windows PC can).` } };
    if (d.away()) return { status: 503, json: { error: `"${name}" is being used by its owner for now. Try again later.` } };
    const busy = d.busy();
    if (busy) return { status: 409, json: { error: `"${name}" is not turned off: ${busy}. Try again when it has finished.` } };
    // Turning off closes every open program there without saving: never under someone who is working in one.
    const used = await d.inUse?.().catch(() => null);
    if (used) return { status: 409, json: { error: `"${name}" is not turned off: someone is using it (${used}). It can be turned off once Windows is locked there, or after ${USED_MINUTES} minutes with nobody using it.` } };
    // The app lock PIN typed on the host: the tick alone is not enough to switch a PC off.
    const pin = await d.pinCheck(body.appPin, who.key, body.hostPin !== undefined ? { pin: body.hostPin, link: who.link } : undefined);
    if ('error' in pin) return { status: pin.status, json: { error: `"${name}" ${pin.error}.`, needPin: pin.status === 403 } };
    d.run(OFF_SECONDS, who.name);
    return { status: 200, json: { said: `"${name}" is turning off in ${OFF_SECONDS} seconds.`, in: OFF_SECONDS } };
  };
}

/** The arguments of Windows' shutdown.exe: off in `seconds`, with a note on the screen that names who asked. */
export function shutdownArgs(seconds: number, by: string): string[] {
  const who = by.replace(/[^\w .'-]/g, '').trim().slice(0, 40) || 'a linked PC';
  return ['/s', '/t', String(Math.max(5, Math.min(120, Math.round(seconds)))), '/c', `TOMLIN: turned off by ${who}. To stop it, open Command Prompt and type shutdown /a`];
}
