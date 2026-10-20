// The key each model runner is started with (src/worker.ts makes a new one every start). llama-server then answers only
// requests that carry it (its /health stays open), so another program on this PC, or a web page, that finds the runner's
// port cannot use the loaded model behind TOMLIN's back, the app lock included. The key never leaves this process: it
// is passed on the runner's command line and sent by TOMLIN's own requests (src/engine.ts, src/server/panes.ts).
// sd-server (pictures) has no such setting, so it is started without one.
const keys = new Map<string, string>();

export const remember = (base: string, key: string) => void keys.set(base, key);
export const forget = (base: string) => void keys.delete(base);

/** The header TOMLIN's own requests to the runner at `base` carry: none for an address it did not start. */
export function runnerHeaders(base: string): Record<string, string> {
  const key = keys.get(base);
  return key ? { authorization: `Bearer ${key}` } : {};
}
