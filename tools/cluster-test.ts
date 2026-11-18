// Times the network and a linked PC's RPC server for the cluster engine, with nobody at that PC: it uses the cluster
// test door the linked PC's TOMLIN opens (src/cluster/testdoor.ts; that PC needs a TOMLIN with it, and its "Allow to be
// used as part of a cluster" tick on, and nobody using it). The link is read from this PC's TOMLIN data (read only).
//
//   node tools/cluster-test.ts <PC name or id> probe [--count 2000] [--hidden 2560]
//       a layer-sized frame there and back, sealed as Max mode and then NOT encrypted, through a port on this PC
//   node tools/cluster-test.ts <PC name or id> rpc [--plain] [--build b11284] [--all] [--port 50071] [--minutes 15]
//       a port on 127.0.0.1 that is that PC's RPC server (each connection one stream), for llama.cpp's --rpc or
//       docs/cluster-native/overlap; it stays open for --minutes, or until Ctrl+C
//
// --plain asks for the bytes after the opening NOT to be encrypted: anyone on the home network who can reach the wire
// could read or change them. Only on a private, wired network.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveHome } from '../src/keep.ts';
import type { Remote } from '../src/store.ts';
import { probe, spread } from '../src/cluster/harness.ts';
import { NO_REASON, testBridge, type StreamNews, type TestWant } from '../src/cluster/testwire.ts';

const args = process.argv.slice(2);
const [who, what = 'probe'] = args;
const flag = (name: string, fallback: number) => {
  const i = args.indexOf(name);
  return i >= 0 && Number.isFinite(Number(args[i + 1])) ? Number(args[i + 1]) : fallback;
};
const text = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

/** The linked PC by id, or by name when only one has it. */
export function findPc(remotes: Remote[], said: string): Remote | string {
  const byId = remotes.find(r => r.id.toLowerCase() === said.toLowerCase());
  if (byId) return byId;
  const byName = remotes.filter(r => r.name.toLowerCase() === said.toLowerCase());
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) return `${byName.length} linked PCs are called "${said}": name one by its id (${byName.map(r => `${r.id} at ${r.url}`).join(', ')}).`;
  return `no linked PC here is called "${said}" (linked: ${remotes.map(r => `"${r.name}" ${r.id}`).join(', ') || 'none'}).`;
}

/**
 * One plain line when the linked PC refused a stream or ended it ('' for anything else): a test that never ran, or
 * was stopped there, must not look like a crash (llama.cpp says "Remote RPC server crashed" for both).
 */
export function testSummary(n: StreamNews): string {
  if (n.kind === 'refused') return `The test did not run: ${n.reason}`;
  if (n.kind !== 'ended' || !n.byNode) return '';
  const why = n.reason === NO_REASON ? `the linked PC closed the stream (${NO_REASON})` : n.reason;
  return `The test did not run to the end: ${why}. If llama.cpp says "Remote RPC server crashed or returned malformed response" now, it is this end, not a crash.`;
}

async function main(): Promise<void> {
  if (!who || !['probe', 'rpc'].includes(what)) {
    console.log('Use: node tools/cluster-test.ts <PC name or id> probe [--count N] [--hidden N]\n     node tools/cluster-test.ts <PC name or id> rpc [--plain] [--build bNNNN] [--all] [--port N] [--minutes N]');
    process.exit(1);
  }
  const data = resolveHome().data;
  const settings = JSON.parse(readFileSync(join(data, 'settings.json'), 'utf8')) as { remotes?: Remote[] };
  const pc = findPc(settings.remotes ?? [], who);
  if (typeof pc === 'string') throw new Error(pc);
  if (what === 'probe') {
    const count = flag('--count', 2000);
    const hidden = flag('--hidden', 2560);
    console.log(`Probe to "${pc.name}" (${pc.url}): ${count} frames of ${hidden} values (${hidden * 4} bytes) there and back, one at a time.`);
    for (const plain of [false, true]) {
      // The stream's own end or refusal, said once it is known (an end the linked PC made is asked of it after the close).
      let told = '';
      const { server, port } = await testBridge(pc, { target: 'echo', plain, minutes: 5 }, 0, undefined, n => void (told ||= testSummary(n)));
      try {
        const s = spread(await probe('127.0.0.1', port, hidden, count));
        console.log(`  ${plain ? 'not encrypted' : 'sealed (Max mode)'}: median ${s.median.toFixed(3)} ms, 90% under ${s.p90.toFixed(3)} ms, 99% under ${s.p99.toFixed(3)} ms`);
      } catch (e) {
        for (let t = 0; t < 30 && !told; t++) await new Promise(res => setTimeout(res, 100));
        throw told ? new Error(told) : e;
      } finally {
        server.close();
      }
    }
    console.log('Both include one Node relay on each PC; a direct link would save about 0.1 to 0.2 ms more.');
    process.exit(0);
  }
  const want: TestWant = { target: 'rpc', plain: args.includes('--plain'), build: text('--build', ''), all: args.includes('--all'), minutes: flag('--minutes', 15) };
  const summed = new Set<string>();
  const { port } = await testBridge(pc, want, flag('--port', 50071), line => console.log(line), n => {
    const line = testSummary(n);
    if (line && !summed.has(line)) {
      summed.add(line);
      console.log(line);
    }
  });
  console.log(`"${pc.name}"'s RPC server (${want.all ? 'card, RAM and cores' : 'card'}, ${want.plain ? 'NOT encrypted' : 'sealed'}) is at 127.0.0.1:${port} for ${want.minutes} minutes. Ctrl+C ends it.`);
  setTimeout(() => process.exit(0), (want.minutes ?? 15) * 60_000).unref();
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('tools/cluster-test.ts')) {
  main().catch(e => {
    console.error((e as Error).message);
    process.exit(1);
  });
}
