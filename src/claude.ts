// Connect Claude: a prompt to paste into Claude (Claude Code) so it works as the project manager of this PC's network of
// LLMs. It reaches the linked PCs through this copy's own API on 127.0.0.1, which already holds every link, so the
// prompt never needs (or holds) a PIN, a setup code or a link key. Tested in test/claude.test.ts.

export interface ClaudeInfo {
  version: string;
  appFolder: string;
  homeFolder: string;
  /** The newest handover in the app folder (file name), when there is one. */
  handoff: string | null;
  port: number;
  pcName: string;
  node: { on: boolean; port: number };
}

/** The version a handover's name carries ("...-SNIPPETS-2.0.42.md" -> [2, 0, 42]), [0, 0, 0] when none. */
const versionIn = (f: string): number[] => [...f.matchAll(/(\d+)\.(\d+)\.(\d+)/g)].at(-1)?.slice(1).map(Number) ?? [0, 0, 0];

/**
 * The newest handover among `files` (HANDOFF-<date>-....md), or null: the date in the name first, then, on a day with
 * several, the highest version in the name (by name alone, "UPTIME-COSTS-2.0.39" came after "TONE-TOKENS-...-2.0.42").
 */
export function newestHandoff(files: string[]): string | null {
  const order = (a: string, b: string) => {
    if (a.slice(8, 18) !== b.slice(8, 18)) return a.slice(8, 18) < b.slice(8, 18) ? -1 : 1;
    const va = versionIn(a), vb = versionIn(b);
    for (let i = 0; i < 3; i++) if (va[i] !== vb[i]) return va[i] - vb[i];
    return a < b ? -1 : a > b ? 1 : 0;
  };
  return files.filter(f => /^HANDOFF-\d{4}-\d{2}-\d{2}-.+\.md$/i.test(f)).sort(order).at(-1) ?? null;
}

const join = (dir: string, file: string) => `${dir.replace(/[\\/]+$/, '')}\\${file}`;

/** The prompt, in plain words: the owner's text, then the API the network is reached through, then how to work. */
export function claudePrompt(i: ClaudeInfo): string {
  const api = `http://127.0.0.1:${i.port}`;
  return [
    "I have a local network of LLMs, that do a variety of tasks such as coding, graphic design, writing and more.",
    'Your role is to act as the project manager. Assign and queue work to each node, ensure that work is delivered to the correct folders.',
    'You connect to the network via TOMLIN, a local AI app (chat, pictures, staff, jobs, linked PCs). Node.js with TypeScript run directly, no build step.',
    `App folder: ${i.appFolder}`,
    i.handoff ? `START HERE: ${join(i.appFolder, i.handoff)} (read it first).` : 'START HERE: there is no handover file in the app folder; read README.md there first.',
    `My data (never change it): ${i.homeFolder}`,
    `This PC: "${i.pcName}", my own copy running at ${api}. Never restart it.`,
    `This PC as a node: ${i.node.on ? `on, other PCs link to it on port ${i.node.port}` : 'off'}.`,
    '',
    `The network, through my copy's own API at ${api} (JSON in and out). It already holds the links to every PC, so you never need a PIN or a setup code:`,
    '- GET /api/home/pcs: the linked PCs, whether each is on, and what it has loaded.',
    '- GET /api/staff: the staff: each hire\'s id, name, role and the model they start on ("remote:<PC id>:..." is a model on a linked PC).',
    '- GET /api/jobs: the projects ("jobs" are planned; "unplanned" are saved and not planned yet).',
    '- POST /api/projects/create {"name", "prompt", "about", "pm": "<hire id>"}: a new project in the workspace folder.',
    '- POST /api/chats/new {"who": "staff:<hire id>", "title": "<subject>", "project": "<project id>"}: a subject with one hire, in a project; what it saves goes into that project\'s folder (a writer\'s work into specialists\\writer, pictures into specialists\\images). It answers with the chat\'s id.',
    '- POST /api/queue/add {"items": [{"kind": "chat", "chat": "<chat id>", "message": "..."}, {"kind": "picture", "prompt": "...", "as": "<artist id>", "project": "<project id>"}, {"kind": "project", "project": "<project id>"}]}: work for the queue; each PC works through its own lines in turn.',
    '- GET /api/queue: what is waiting, running and done, with each result and where it was handed in.',
    'An answer 423 means TOMLIN is locked on this PC: ask me to unlock it.',
    '',
    'How to work:',
    '1. Read START HERE, then do only what I ask.',
    '2. Test on scratch copies, never on my copy or my data: run src/server.ts from the app folder with TOMLIN_DATA set to a folder in your scratchpad, TOMLIN_PORT set to a free port (8788 to 8799), and TOMLIN_MODELS_FILE pointing at a file that names a models folder. A new scratch copy asks "Import your chats?": answer Decide later.',
    '3. To reach a linked PC: go through my copy\'s API above. Never ask me for a PIN or a code in the chat, and never read link keys from my data.',
    '4. A model run for a test goes on a linked PC above when there is one; on this PC only when I say so.',
    '5. Run npm test and npm run check before you say something works, and tell me what you ran and what you did not.',
    '6. Ask me before committing, baking a zip or uploading anything.',
  ].join('\n');
}
