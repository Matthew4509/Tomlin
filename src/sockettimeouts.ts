// The local server's connections: Node closes an idle keep-alive connection after 5 s, and a client that sends its next
// request in that instant (a benchmark driver at the end of a long run) gets "fetch failed ... ECONNABORTED". The server
// now holds an idle one for a minute, longer than any client keeps one, and a slow reader is not cut off.
import type { Server } from 'node:http';

export function keepSocketsOpen(server: Pick<Server, 'keepAliveTimeout' | 'headersTimeout' | 'requestTimeout'>): void {
  server.keepAliveTimeout = 65_000;
  // Must be above keepAliveTimeout, or Node closes a reused connection while it waits for the next request's headers.
  server.headersTimeout = 70_000;
  // An upload or answer on a slow link is not cut by a whole-request limit (answers stream for many minutes).
  server.requestTimeout = 0;
}
