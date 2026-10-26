// Max mode, this PC's side as the borrower: llama-server's --rpc connects to a port on 127.0.0.1 here, and each
// connection becomes a sealed stream (src/linkstream.ts) to the linked PC that lends its card (src/jobrun/maxnode.ts).
// HIDDEN for now: only the PCs named in TOMLIN_MAX (their names or ids, comma-separated) are borrowed from, for every
// chat model this PC loads, until the planner and the Max mode screens are built.
import { request } from 'node:http';
import { createServer, type Server, type Socket } from 'node:net';
import * as share from '../share.ts';
import * as link from '../link.ts';
import { joinWhenOpen, newNonce, streamKeys } from '../linkstream.ts';
import type { Remote } from '../store.ts';
import { log } from '../log.ts';
import { backupsOnly, backupsOnlyWhy, onHomeNetwork } from './links.ts';
import { d } from './shared.ts';
import { MAX_DOOR, MAX_UPGRADE } from './maxnode.ts';

/** The linked PCs named in TOMLIN_MAX (by name or id), as saved here. */
export function maxPcs(said = process.env.TOMLIN_MAX ?? ''): Remote[] {
  const names = said.split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  if (!names.length) return [];
  return (d.store.peek()?.remotes ?? []).filter(r => names.includes(r.name.toLowerCase()) || names.includes(r.id.toLowerCase()));
}

/** Opens one sealed stream to `r`: its socket, this stream's keys, and any bytes read past the answer. Throws in plain words. */
export async function openWire(r: Remote, ms = 30_000): Promise<{ socket: Socket; keys: { send: Buffer; read: Buffer }; head: Buffer }> {
  if (backupsOnly(r.id)) throw new Error(backupsOnlyWhy(r.name));
  const linkKeys = link.keysOf(r.key);
  if (!linkKeys) throw new Error(`"${r.name}" was linked before links were encrypted. Link it again.`);
  await onHomeNetwork(r);
  const hostNonce = newNonce();
  const sealed = link.sealRequest(linkKeys, MAX_DOOR, { nonce: hostNonce.toString('base64url') });
  const id = link.requestId(sealed.box);
  const u = new URL(r.url);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path: MAX_DOOR, method: 'GET', headers: { connection: 'Upgrade', upgrade: MAX_UPGRADE, authorization: `Link ${share.hashToken(r.token)}`, 'x-link': sealed.box } });
    req.setTimeout(ms, () => req.destroy(new Error(`"${r.name}" did not answer in ${Math.round(ms / 1000)} seconds.`)));
    req.on('error', e => reject(new Error((e as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? `"${r.name}" could not be reached (TOMLIN not running there, or sharing off).` : (e as Error).message)));
    req.on('response', res => {
      let text = '';
      res.on('data', c => (text += c));
      res.on('end', () => {
        let error = '';
        try {
          error = String((JSON.parse(text) as { error?: unknown }).error ?? '');
        } catch {
          // not JSON: an older TOMLIN without the door
        }
        reject(new Error(error || `"${r.name}" runs a TOMLIN without Max mode (it answered ${res.statusCode}). Update it there.`));
      });
    });
    req.on('upgrade', (res, socket, head) => {
      try {
        const said = link.openAnswer(linkKeys, id, 0, res.headers['x-link']) as { nonce?: unknown };
        const nodeNonce = Buffer.from(String(said.nonce ?? ''), 'base64url');
        resolve({ socket, keys: streamKeys(linkKeys, hostNonce, nodeNonce, 'host'), head });
      } catch (e) {
        socket.destroy();
        reject(e);
      }
    });
    req.end();
  });
}

/** One port here for each lending PC; llama-server may open several connections to it. */
const ports = new Map<string, { server: Server; port: number; last: string }>();

async function portFor(r: Remote): Promise<number> {
  const had = ports.get(r.id);
  if (had) return had.port;
  const entry = { server: createServer(), port: 0, last: '' };
  entry.server.on('connection', (local: Socket) => {
    const now = (d.store.peek()?.remotes ?? []).find(x => x.id === r.id) ?? r;
    joinWhenOpen(local, () => openWire(now)).then(why => {
      if (why) {
        entry.last = why;
        log.warn('max', `The stream to "${now.name}" ended: ${why}`);
      }
    }, (e: Error) => {
      entry.last = e.message;
      log.warn('max', `"${now.name}" did not lend: ${e.message}`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    entry.server.once('error', reject);
    entry.server.listen(0, '127.0.0.1', () => resolve());
  });
  entry.port = (entry.server.address() as { port: number }).port;
  ports.set(r.id, entry);
  return entry.port;
}

/** Why the last stream to linked PC `id` failed or ended ('' when none did). */
export const lastFault = (id: string) => ports.get(id)?.last ?? '';

/**
 * For a chat model about to load: the --rpc addresses of the PCs that lend now, and a line for each that does not.
 * Each is asked first (one stream opened and closed), so a PC that refuses is left out instead of failing the load.
 */
export async function rpcFor(pcs = maxPcs()): Promise<{ endpoints: string[]; lent: string[]; notes: string[] }> {
  const endpoints: string[] = [];
  const lent: string[] = [];
  const notes: string[] = [];
  for (const r of pcs) {
    try {
      const { socket } = await openWire(r);
      socket.destroy();
      endpoints.push(`127.0.0.1:${await portFor(r)}`);
      lent.push(r.name);
    } catch (e) {
      notes.push(`Max mode: ${(e as Error).message}`);
    }
  }
  return { endpoints, lent, notes };
}
