// A project's page (index.html #pp-dlg), opened from Home's Recent projects tiles and the Project tab: the project's
// name, its mini description and its folder, then its chats by kind of work and person on the left (projecttab.js
// projectGroups), and its work on the right, read from its folder (/api/project/work, src/projectwork.ts): the code
// (View code opens it in Files, Play it runs index.html in the sandboxed preview), the pictures as small previews, the
// writing, the videos and the chats saved from it, each with Open folder.
// Uses app.js's helpers ($, el, api, app), chats.js's (chatUi, chatAvatar) and team.js's roleIcon.
// Everything here sits in one block: page scripts share one global scope, so no name of this file can clash.
'use strict';
{
  const dlg = $('#pp-dlg');
  const ui = { id: '', work: null, preview: null, cards: [] };

  const ago = iso => {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : new Date(iso).toLocaleDateString();
  };
  const sizeText = n => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  const nameOf = path => path.split('/').pop();
  /** The path inside the project folder, for a code file in a sub-folder ("src/game.js"). */
  const inside = path => (ui.work?.folder ? path.slice(ui.work.folder.length + 1) : path);

  function say(text) {
    const s = $('#pp-said');
    s.textContent = text ?? '';
    s.hidden = !text;
  }

  async function openFolder(part) {
    say('');
    try {
      await api('/api/project/open-folder', { project: ui.id, part });
    } catch (e) {
      say(e.message);
    }
  }
  const folderBtn = (part, label = 'Open folder') => el('button', { class: 'btn quiet', type: 'button', text: label, title: 'Opens it in Windows Explorer', onclick: () => openFolder(part) });

  /** The project's chats by kind of work, then by person: a press opens the chat (the page closes). */
  function chatsPart(p) {
    const groups = app.projectGroups?.(chatUi.list ?? [], p.id) ?? [];
    if (!groups.length) return [el('p', { class: 'hint', text: 'No chats in this project yet.' })];
    const line = c => el('li', {}, el('button', { class: 'pt-chat', type: 'button', title: `${c.title}\nPress to open this chat`, onclick: () => {
      dlg.close();
      app.openChat(c.id);
    } }, el('span', { class: 'pt-title', text: c.title }), el('span', { class: 'pt-word', text: ago(c.updated ?? '') })));
    const person = g => el('li', { class: 'pt-person' },
      el('div', { class: 'pt-who' }, chatAvatar(g.chats[0]), el('span', { class: 'pt-name', text: g.name }),
        g.role ? el('span', { class: 'pt-role', title: g.role }, typeof roleIcon === 'function' ? roleIcon(g.roleId) : null, el('span', { class: 'sr-only', text: g.role })) : null),
      el('ul', { class: 'pt-chats' }, ...g.chats.map(line)));
    return groups.map(k => el('section', { class: 'pt-kind', 'aria-label': k.name }, el('h4', { text: k.name }), el('ul', { class: 'pt-people' }, ...k.people.map(person))));
  }

  const more = n => (n ? el('p', { class: 'hint', text: `and ${n} more: Open folder shows them all` }) : null);
  /** A file's line: a code file by its path in the project folder, the rest by name (their folder is in the heading). */
  const fileRow = (f, opens, short = false) => el('li', {}, el('button', { class: 'pp-file', type: 'button', title: `${f.path} · ${sizeText(f.bytes)}${opens ? '\nPress to open it in Files' : ''}`, disabled: !opens, onclick: opens ? () => { dlg.close(); app.openFileAt?.(f.path); } : null },
    el('span', { class: 'pp-file-name', text: short ? nameOf(f.path) : inside(f.path) }), el('span', { class: 'pp-file-at', text: ago(f.at) })));
  /** Files opens text files only: a code file that is not text (a picture, a sound) is listed, not opened. */
  const TEXT = /\.(md|txt|html?|css|js|mjs|jsx|ts|tsx|json|csv|xml|ya?ml|py|php|sql|toml|java|c|h|cpp|cs|go|rs|rb|kt|swift|vue|scss|ini|sh|ps1)$/i;

  function workPart(w) {
    if (w.top) return [el('p', { class: 'hint', text: 'This project is kept at the top of the workspace, so its files are not told apart from everyone else\'s. Open Files to see them.' })];
    const out = [];
    if (ui.cards?.length) out.push(el('section', { class: 'pp-part', 'aria-label': 'Characters and locations' },
      el('div', { class: 'pp-part-head' }, el('h4', { text: 'Characters and locations' }), el('span', { class: 'hint', text: 'specialists\\characters\\ and locations\\ · use @Name in a picture, clip or shot' })),
      el('div', { class: 'pp-pics' }, ...ui.cards.map(c => el('figure', { class: 'pp-card', title: `${c.kind === 'character' ? 'Character' : 'Location'}: ${c.words || c.name}` },
        c.refs[0] ? el('img', { src: `/api/files/picture?path=${encodeURIComponent(`${c.folder}/${c.refs[0]}`)}`, alt: '' }) : el('span', { class: 'cs-noimg', 'aria-hidden': 'true', text: c.name.slice(0, 1) }),
        el('figcaption', { text: `@${c.name}` }))))));
    const part = (title, where, items, extra = []) => el('section', { class: 'pp-part', 'aria-label': title },
      el('div', { class: 'pp-part-head' }, el('h4', { text: title }), el('span', { class: 'hint', text: where }), ...extra), ...items);
    const { code, pictures, writing, videos, chats, more: left } = w.work;
    out.push(part('Code', `${w.folder}\\`, code.length ? [el('ul', { class: 'pp-files' }, ...code.map(f => fileRow(f, TEXT.test(f.path)))), more(left.code)] : [el('p', { class: 'hint', text: 'No code yet.' })],
      [w.play ? el('button', { class: 'btn', type: 'button', text: 'Play it', title: `Opens ${nameOf(w.play)} in a new tab, in the same safe preview as Jobs`, onclick: play }) : null, folderBtn('')].filter(Boolean)));
    const pics = pictures.filter(f => /\.(png|webp)$/i.test(f.path));
    out.push(part('Pictures', 'specialists\\images\\', pictures.length ? [
      el('div', { class: 'pp-pics' }, ...pics.slice(0, 24).map(f => {
        const src = `/api/files/picture?path=${encodeURIComponent(f.path)}`;
        return el('a', { class: 'pp-pic', href: src, target: '_blank', rel: 'noopener', title: `${nameOf(f.path)} · ${ago(f.at)}\nPress to see it full size` }, el('img', { src, alt: nameOf(f.path), loading: 'lazy' }));
      })),
      pictures.length > pics.slice(0, 24).length ? el('p', { class: 'hint', text: `${pictures.length - pics.slice(0, 24).length + left.pictures} more in the folder` }) : null,
    ] : [el('p', { class: 'hint', text: 'No pictures saved to this project yet.' })], pictures.length ? [folderBtn('pictures')] : []));
    out.push(part('Writing', 'specialists\\writer\\', writing.length ? [el('ul', { class: 'pp-files' }, ...writing.map(f => fileRow(f, TEXT.test(f.path), true))), more(left.writing)] : [el('p', { class: 'hint', text: 'Nothing written for this project yet.' })], writing.length ? [folderBtn('writing')] : []));
    out.push(part('Videos', 'specialists\\videos\\', videos.length ? [el('ul', { class: 'pp-files' }, ...videos.map(f => fileRow(f, false, true))), more(left.videos)] : [el('p', { class: 'hint', text: 'No videos yet.' })], videos.length ? [folderBtn('videos')] : []));
    if (chats.length) out.push(part('Saved chats', 'chats\\', [el('ul', { class: 'pp-files' }, ...chats.map(f => fileRow(f, TEXT.test(f.path), true))), more(left.chats)], [folderBtn('chats')]));
    return out;
  }

  async function play() {
    say('');
    try {
      ui.preview = ui.preview ?? await api('/api/preview');
      const url = `/preview/${ui.preview.key}/${ui.work.play.split('/').map(encodeURIComponent).join('/')}`;
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      say(e.message);
    }
  }

  function draw() {
    const p = chatUi.projects?.find(x => x.id === ui.id) ?? { id: ui.id, name: ui.work?.name ?? 'Project', goal: '' };
    $('#pp-title').textContent = p.name;
    $('#pp-about').textContent = [p.about || p.goal, ui.work && !ui.work.top ? `Folder: ${ui.work.folder}` : ''].filter(Boolean).join(' · ');
    const planned = p.plan !== false;
    $('#pp-acts').replaceChildren(
      el('button', { class: 'btn', type: 'button', text: '+ New chat', title: `New chat, with ${p.name} picked as its project`, onclick: () => { dlg.close(); app.newChatIn?.(p.id); } }),
      el('button', { class: 'btn quiet', type: 'button', text: planned ? 'Plan and steps' : 'Make the plan', title: planned ? `Open ${p.name} in Jobs` : `${p.name} has no plan yet: the planner makes one from its Scope card`,
        onclick: () => { dlg.close(); planned ? app.openJob(p.id) : app.planProject(p.id, p.goal || p.name); } }));
    $('#pp-chats').replaceChildren(...chatsPart(p));
    $('#pp-work').replaceChildren(...(ui.work ? workPart(ui.work) : [el('p', { class: 'hint', text: 'Reading the project folder…' })]));
  }

  /** Opens project `id`'s page. */
  app.openProjectPage = async id => {
    ui.id = id;
    ui.work = null;
    say('');
    draw();
    if (!dlg.open) dlg.showModal();
    try {
      ui.work = await api(`/api/project/work?id=${encodeURIComponent(id)}`);
      // Its characters and locations (src/server/cards.ts), shown above its work; none for a project at the top.
      ui.cards = ui.work.top ? [] : (await api(`/api/cards?project=${encodeURIComponent(id)}`).catch(() => ({ cards: [] }))).cards;
    } catch (e) {
      say(e.message);
    }
    if (ui.id === id) draw();
  };
}
