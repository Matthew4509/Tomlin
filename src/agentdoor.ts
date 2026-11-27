// What the link door (src/jobrun/node.ts, /worker/agents) and the keep-awake timer need from the agents part of the
// server (src/server/agents.ts), without importing it: the server fills these in when it starts.
export const agentDoor: {
  /** An admin PC's ask over the link: list, save, delete, pause, run, stop, allow, reports, report. */
  handle: (body: Record<string, unknown>) => Promise<{ status: number; body: unknown }>;
  /** Agent runs going now: Windows is kept awake while there is one (src/keepawake.ts). */
  running: number;
} = {
  handle: async () => ({ status: 503, body: { error: 'Agents are not started on this PC yet.' } }),
  running: 0,
};
