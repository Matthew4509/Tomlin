// One answer's use of the laptop helper (src/camhelper.ts): its read tools, run over the encrypted link, cut to the
// room and withheld when the text looks like a key or a password. Tested in test/camhelper.test.ts.
import { MACHINE_TOOLS, callHelper, isHelperTool, type HelperLink, type HelperTool } from './camhelper.ts';
import type { ToolDef } from './webtools.ts';
import { looksSecret } from './rules.ts';

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** One helper read, as the chat shows and keeps it under the answer. */
export interface MachineUse { name: HelperTool; input: string; ok: boolean; said: string; ms: number }

/** One answer's helper tools: read only, cut to the room, withheld when it looks like a key or a password. */
export class MachineTurn {
  readonly uses: MachineUse[] = [];
  private readonly o: { helper: HelperLink; me: string; perCall: number; get?: Fetch; now?: () => number };

  constructor(o: { helper: HelperLink; me: string; perCall: number; get?: Fetch; now?: () => number }) {
    this.o = o;
  }

  /** The tools this helper offers, of the ones TOMLIN knows. */
  get defs(): ToolDef[] {
    return MACHINE_TOOLS.filter(d => this.o.helper.tools.includes(d.function.name as HelperTool));
  }

  async run(name: string, rawArgs: string, signal?: AbortSignal): Promise<string> {
    if (!isHelperTool(name)) return `There is no tool called "${name}".`;
    const now = this.o.now ?? Date.now;
    const start = now();
    const done = (ok: boolean, said: string, result: string) => {
      this.uses.push({ name, input: this.o.helper.name, ok, said: said.slice(0, 200), ms: Math.max(0, now() - start) });
      return result;
    };
    let args: Record<string, unknown> = {};
    try {
      const a = JSON.parse(rawArgs || '{}') as Record<string, unknown>;
      if (a && typeof a === 'object') args = { ...(typeof a.menu === 'string' ? { menu: a.menu.slice(0, 80) } : {}) };
    } catch {
      // read with no arguments
    }
    try {
      const text = await callHelper(this.o.helper, this.o.me, name, args, this.o.get, signal);
      if (looksSecret(text)) return done(false, 'withheld', 'Not read: what the laptop sent looks like it holds a password, key or token, so it was withheld. Tell the person; do not guess what it showed.');
      if (!text.trim()) return done(true, 'nothing found', 'The laptop found nothing to read there.');
      const room = Math.max(500, this.o.perCall);
      const out = text.length > room ? `${text.slice(0, Math.max(0, text.lastIndexOf('\n', room)))}\n[cut here: no more room; ask for one menu with the menu argument]` : text;
      return done(true, `${text.split('\n').length} lines`, out);
    } catch (e) {
      const why = String((e as Error).message ?? e);
      return done(false, why.split('.')[0], `Not read: ${why} Nothing was read from the laptop, so do not describe its menus or its window.`);
    }
  }
}
