// Help's pages (public/help/) each carry their own breadcrumbs (Help > Group > Topic) and previous / next links, written
// into the page so they read with nothing else loaded. This puts them right from public/help/topics.js, the one list of
// groups and topics: change the list, run `node tools/help-nav.ts`, and every page is rewritten between its markers.
// It never touches a page's text. A topic in the list with no page is named (make the page, with the two marker pairs;
// `node tools/help-nav.ts --new <id>` writes an empty one). test/help.test.ts fails when a page is out of step.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export type Group = { id: string; title: string; blurb: string };
export type Topic = { id: string; group: string; title: string; blurb: string };
export type HelpMap = { groups: Group[]; topics: Topic[]; aliases: Record<string, string> };

const DIR = join(import.meta.dirname, '..', 'public', 'help');

export async function loadMap(): Promise<HelpMap> {
  await import(pathToFileURL(join(DIR, 'topics.js')).href);
  return (globalThis as unknown as { TOMLIN_HELP: HelpMap }).TOMLIN_HELP;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function navTop(map: HelpMap, t: Topic): string {
  const g = map.groups.find(x => x.id === t.group);
  return `<!--nav-top--><nav class="crumbs" aria-label="Breadcrumb"><ol><li><a href="index.html">Help</a></li><li><a href="index.html#group-${esc(t.group)}">${esc(g?.title ?? t.group)}</a></li><li aria-current="page">${esc(t.title)}</li></ol></nav><!--/nav-top-->`;
}

export function navBottom(map: HelpMap, t: Topic): string {
  const i = map.topics.findIndex(x => x.id === t.id);
  const prev = map.topics[i - 1];
  const next = map.topics[i + 1];
  const link = (x: Topic | undefined, cls: string, label: string) =>
    x ? `<a class="${cls}" href="${esc(x.id)}.html" rel="${cls}"><span>${label}</span><b>${esc(x.title)}</b></a>` : `<span class="${cls} none"></span>`;
  return `<!--nav-bottom--><nav class="pager" aria-label="Previous and next topic">${link(prev, 'prev', '&larr; Previous')}${link(next, 'next', 'Next &rarr;')}</nav><!--/nav-bottom-->`;
}

/** A whole page around a topic's body (the HTML between <article> and </article>, which starts with its <h1>). */
export function pageHtml(map: HelpMap, t: Topic, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(t.title)} - TOMLIN Help</title>
<script src="../theme.js"></script>
<link rel="stylesheet" href="help.css">
<script src="topics.js" defer></script>
<script src="help.js" defer></script>
</head>
<body data-topic="${esc(t.id)}">
<header class="top">
  <a class="brand" href="index.html">TOMLIN Help</a>
  <form class="search" role="search" action="index.html"><input type="search" id="q" name="q" placeholder="Search Help" aria-label="Search Help" autocomplete="off"><div class="results" id="results" hidden></div></form>
</header>
<main>
${navTop(map, t)}
<article>
${body.trim()}
</article>
${navBottom(map, t)}
</main>
</body>
</html>
`;
}

/** The index: every group with its topics, written out so it reads with no script (the search only narrows it). */
export function indexHtml(map: HelpMap): string {
  const groups = map.groups.map(g => `<section class="group" id="group-${esc(g.id)}">
<h2>${esc(g.title)}</h2>
<p>${esc(g.blurb)}</p>
<ul>
${map.topics.filter(t => t.group === g.id).map(t => `<li><a href="${esc(t.id)}.html"><b>${esc(t.title)}</b><small>${esc(t.blurb)}</small></a></li>`).join('\n')}
</ul>
</section>`).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TOMLIN Help</title>
<script src="../theme.js"></script>
<link rel="stylesheet" href="help.css">
<script src="topics.js" defer></script>
<script src="help.js" defer></script>
</head>
<body data-topic="index">
<header class="top"><a class="brand" href="index.html">TOMLIN Help</a></header>
<main>
<div class="hero">
<h1>How can we help?</h1>
<p>Pick what you want to do, or search. New here? Start with <a href="first-steps.html">First steps</a>.</p>
<form role="search" action="index.html"><input type="search" id="q" name="q" placeholder="Search Help, for example: guest pass, backups, hibernation" aria-label="Search Help" autocomplete="off"></form>
<div class="results" id="results" hidden></div>
</div>
<div id="found" hidden aria-live="polite"></div>
<div class="groups" id="groups">
${groups}
</div>
</main>
</body>
</html>
`;
}

function swap(text: string, name: string, fresh: string): string {
  const re = new RegExp(`<!--${name}-->[\\s\\S]*?<!--/${name}-->`);
  return re.test(text) ? text.replace(re, () => fresh) : text;
}

async function main(): Promise<void> {
  const map = await loadMap();
  const newId = process.argv[2] === '--new' ? process.argv[3] : '';
  if (newId) {
    const t = map.topics.find(x => x.id === newId);
    if (!t) throw new Error(`${newId} is not in public/help/topics.js`);
    await writeFile(join(DIR, `${t.id}.html`), pageHtml(map, t, `<h1>${esc(t.title)}</h1>\n<p class="lead">${esc(t.blurb)}</p>`));
    console.log(`wrote ${t.id}.html`);
  }
  await writeFile(join(DIR, 'index.html'), indexHtml(map));
  let changed = 0;
  for (const t of map.topics) {
    const file = join(DIR, `${t.id}.html`);
    let text: string;
    try {
      text = (await readFile(file, 'utf8')).replace(/\r\n/g, '\n');
    } catch {
      console.log(`no page yet: ${t.id}.html`);
      continue;
    }
    const out = swap(swap(text, 'nav-top', navTop(map, t)), 'nav-bottom', navBottom(map, t));
    if (out !== text) {
      await writeFile(file, out);
      changed++;
    }
  }
  console.log(`${map.topics.length} topics, ${changed} pages rewritten.`);
}

if (process.argv[1] && import.meta.filename === process.argv[1]) await main();
