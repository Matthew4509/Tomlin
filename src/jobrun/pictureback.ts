// A picture asked of a linked PC, read back here, and collected again when the connection is lost part-way (2.0.89 on).
// A node that keeps pictures ("draw-outbox" in its hello) is asked with a request id: it draws to the end when this PC
// goes away (closed, asleep, off the network) and keeps the picture in its outbox (src/outbox.ts). Asked again with the
// same id it follows the drawing still running, or hands the kept picture over at once: it is never drawn twice. The
// queue asks with an id made from its item (src/server/queue.ts), so a host started again collects it too.
// Kept free of the app's state so two copies can be tried against each other in a test (test/hostaway.test.ts).
import { cleanMade, type Made } from '../sources.ts';

export interface Drawn {
  png: Buffer;
  modelName: string;
  modelPrompt: string;
  mode: string;
  seconds: number;
  note: string;
  made: Made | null;
}

/** A fault the linked PC said (not a lost connection): asking again would only bring it back. */
export type Said = Error & { said: true };
export const saidOf = (e: unknown) => (e as Partial<Said>)?.said === true;

/** How long the stream may say nothing: the node writes a line every 20 s while it draws. */
export const QUIET_MS = 75_000;

/** Reads one drawing's stream: its progress, then the picture or the fault it said. Throws when the stream is cut. */
export async function readPicture(res: Response, name: string, progress: (p: Record<string, unknown>) => void, quietMs = QUIET_MS): Promise<Drawn> {
  if (!res.body) throw new Error(`"${name}" sent nothing back.`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const silent = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`"${name}" went quiet for ${Math.round(quietMs / 1000)} s while drawing (it may have been closed, asleep or off the network).`));
        void reader.cancel().catch(() => undefined);
      }, quietMs);
    });
    const { value, done } = await Promise.race([reader.read(), silent]).finally(() => clearTimeout(timer));
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event: (\w+)/m.exec(block)?.[1];
      if (!ev) continue;
      const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? '{}') as Record<string, unknown>;
      if (ev === 'progress') progress(data);
      else if (ev === 'error') throw Object.assign(new Error(`"${name}" said: ${String(data.text)}`), { said: true as const });
      else if (ev === 'picture') {
        const png = Buffer.from(String(data.png ?? ''), 'base64');
        // Only a PNG is taken in: anything else is not what was asked for.
        if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47 || png.length > 20 * 2 ** 20) throw Object.assign(new Error(`"${name}" sent something that is not a picture.`), { said: true as const });
        return { png, modelName: String(data.modelName ?? ''), modelPrompt: String(data.modelPrompt ?? ''), mode: String(data.mode ?? 'custom'), seconds: Number(data.seconds) || 0, note: String(data.note ?? ''), made: cleanMade(data.made) };
      }
    }
  }
  throw new Error(`"${name}" stopped before the picture was finished (it may have been closed, or its picture model disconnected).`);
}

/** The error when a kept drawing could not be collected in time: the node still has it (the queue tries again). */
export type LostPicture = Error & { lost: { rid: string } };

export interface CollectOpts {
  name: string;
  /** The request id the node keeps the picture under; null: an older node, nothing is kept there. */
  rid: string | null;
  /** One ask of the node (with the id in it): its answer, or a throw when it cannot be reached. */
  ask: () => Promise<Response>;
  progress: (p: Record<string, unknown>) => void;
  signal: AbortSignal;
  /** A cut said in plain words (fetch's own "terminated"). */
  cutWords?: (message: string) => string;
  waitMs?: number;
  giveUpMs?: number;
  quietMs?: number;
}

/** Why an answer that is not a stream was refused, in its own words. */
async function refusal(res: Response, name: string): Promise<Error> {
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return new Error(`"${name}": ${String(data.error ?? `answered ${res.status}`)}`);
}

/**
 * Asks for a picture and reads it. With a request id, a stream cut part-way is asked for again with the same id every
 * `waitMs` (default 5 s) until `giveUpMs` (default 2 minutes): the node hands back what it kept or is still drawing.
 * After that the error carries `lost` and words the queue reads as "for now" ("not answering"), so it tries again later.
 */
export async function collectPicture(o: CollectOpts): Promise<Drawn> {
  const wait = o.waitMs ?? 5000;
  const giveUp = o.giveUpMs ?? 2 * 60_000;
  let res: Response;
  try {
    res = await o.ask();
  } catch (e) {
    if (o.signal.aborted) throw new Error('Stopped.');
    throw e;
  }
  if (!res.ok || !res.body) throw await refusal(res, o.name);
  let lostAt = 0;
  for (;;) {
    try {
      return await readPicture(res, o.name, o.progress, o.quietMs);
    } catch (e) {
      if (o.signal.aborted) throw new Error('Stopped.');
      if (!o.rid || saidOf(e)) throw saidOf(e) ? e : new Error(o.cutWords ? o.cutWords((e as Error).message) : (e as Error).message);
      lostAt ||= Date.now();
    }
    // The connection was lost part-way: that PC keeps drawing and keeps the picture. Asked again with the same id.
    for (;;) {
      if (Date.now() - lostAt > giveUp) throw Object.assign(new Error(`Lost the connection to "${o.name}" while it drew this: it is not answering now, and keeps the picture until it is collected.`), { lost: { rid: o.rid } });
      o.progress({ text: `Lost the connection to "${o.name}": it is still drawing. Reconnecting…` });
      await new Promise(r => setTimeout(r, wait));
      if (o.signal.aborted) throw new Error('Stopped.');
      let again: Response;
      try {
        again = await o.ask();
      } catch {
        if (o.signal.aborted) throw new Error('Stopped.');
        continue;
      }
      if (again.ok && again.body) {
        res = again;
        // Back again: a later drop gets its own full time to reconnect (it gave up at once on a second drop).
        lostAt = 0;
        break;
      }
      throw await refusal(again, o.name);
    }
  }
}
