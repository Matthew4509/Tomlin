// Reading a request body with a size limit. A body over the limit is read to its end and thrown away, not abandoned: a
// server that stops reading and answers 413 leaves the sender (and the next request on its kept connection) waiting for ever
// (the API fuzzer: a 3 MB body to a 4 KB door, then the same again, hung 30 s). Past DRAIN_MAX the connection is cut.
import type { IncomingMessage } from 'node:http';

export class TooLarge extends Error {}

const DRAIN_MAX = 256 << 20;

export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  let over = false;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (over) {
      if (size > limit + DRAIN_MAX) {
        req.destroy();
        throw new TooLarge('too large');
      }
      continue;
    }
    if (size > limit) {
      over = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(c as Buffer);
  }
  if (over) throw new TooLarge('too large');
  return Buffer.concat(chunks);
}
