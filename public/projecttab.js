// The Project tab on the right of the chat (index.html #panel-project): the open chat's project by name with Open
// project, then its chats by kind of work (Writing, Code, Pictures, Videos, Agents), each kind by person, each person's
// chats by title. A press on a chat opens it, as Recent chats does; the open one is marked. A short word beside a chat
// says what is happening there when the page knows it already: Home's answering and waiting lines (homeview.js), and a
// Videographer's shot list (one read of /api/shots per video chat, at most every 15 s while the tab is shown). In a
// Videographer's chat the tabs give way to the shot list, so the same view sits in a fold under its bar.
// Uses app.js's helpers ($, el, api, app), chats.js's (chatUi, chatShown, chatAvatar, chatGroup) and team.js's roleIcon.
// Everything here sits in one block: page scripts share one global scope, so no name of this file can clash.
'use strict';
{
  /**
   * The chats of `project` grouped by kind of work, then by person: [{ id, name, people: [{ who, name, roleId, role,
   * chats }] }], kinds in a fixed order and only those with a chat; people by name; each person's chats pinned first,
   * then newest first. A role not listed (Default, Writer, the host, a linked PC's hire) is Writing.
   */
  function projectGroups(chats, project) {
    const KINDS = [['writing', 'Writing'], ['code', 'Code'], ['pictures', 'Pictures'], ['videos', 'Videos'], ['agents', 'Agents']];
    const kindOf = c => (c.roleId === 'coder' ? 'code'
      : c.roleId === 'artist' || c.roleId === 'designer' || c.roleKind === 'image' ? 'pictures'
        : c.roleId === 'videographer' || c.roleKind === 'video' ? 'videos'
          : c.roleId === 'agent' ? 'agents' : 'writing');
    const mine = project ? chats.filter(c => c.project === project) : [];
    return KINDS.map(([id, name]) => {
      const people = new Map();
      for (const c of mine) {
        if (kindOf(c) !== id) continue;
        if (!people.has(c.who)) people.set(c.who, { who: c.who, name: c.name, roleId: c.roleId ?? '', role: String(c.role ?? '').split(' · ')[0], chats: [] });
        people.get(c.who).chats.push(c);
      }
      const list = [...people.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
      for (const p of list) p.chats.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || String(b.updated ?? '').localeCompare(String(a.updated ?? '')));
      return { id, name, people: list };
    }).filter(k => k.people.length);
  }

  /**
   * One short word for chat `id`, or '' when nothing is known: `shots` its shot list ({ run, shots }), `answering`
   * Home's answers coming now ({ chat, what }), `waiting` Home's lines waiting for you ({ chat }).
   */
  function chatStateWord(id, { shots = null, answering = [], waiting = [] } = {}) {
    const making = shots?.shots?.find(s => s.state === 'making');
    if (making) return `making shot ${making.n} of ${shots.shots.length}`;
    const a = answering.find(x => x.chat === id);
    if (a) return a.what === 'picture' ? 'drawing a picture' : 'answering';
    if (waiting.some(x => x.chat === id)) return 'waiting for you';
    if (shots?.run === 'paused') return 'shot list paused';
    if (shots?.run === 'held') return 'shot list held';
    if (shots?.run === 'scheduled') return 'shot list starts later';
    return '';
  }

  // The shot lists of the project's video chats other than the open one (shots.js keeps that one fresh).
  const SHOT_EVERY = 15_000;
  const SHOT_MOST = 8;
  const shotRead = { at: 0, project: '', lists: {}, busy: false };
  async function readShots(project, ids) {
    if (shotRead.busy || (shotRead.project === project && Date.now() - shotRead.at < SHOT_EVERY)) return;
    shotRead.busy = true;
    try {
      const got = await Promise.all(ids.slice(0, SHOT_MOST).map(id => api(`/api/shots?chat=${encodeURIComponent(id)}`).then(r => [id, r?.list ?? null]).catch(() => [id, null])));
      Object.assign(shotRead, { at: Date.now(), project, lists: Object.fromEntries(got) });
    } finally {
      shotRead.busy = false;
    }
    draw();
  }

  /** The open chat's project, drawn in `box` (`key` keeps the two copies' focus keys apart). */
  function projectView(box, key) {
    const chat = chatUi.open;
    if (!chat) return keepFocus(box, [el('p', { class: 'hint pt-none', text: 'Open a chat to see its project here.' })]);
    const p = chatGroup(chat);
    if (!p) {
      // In no project: the head's Project list puts it in one (chats.js putInProject); a chat kept to read has none.
      const can = !$('#chat-project-row').hidden;
      return keepFocus(box, [
        el('p', { class: 'pt-none', text: 'This chat is in Default: no project of its own, so what it saves goes in its own folder.' }),
        // Its own copy of the head's Project list: an artist's or videographer's chat hides the head's subject line, so a
        // button that only focused that list did nothing there. A choice here goes through the head's list (chats.js).
        can ? el('label', { class: 'field pt-put' }, el('span', { text: 'Put this chat in a project' }),
          el('select', { 'data-key': `${key}:put`, onchange: e => {
            const head = $('#chat-project');
            head.value = e.target.value;
            head.dispatchEvent(new Event('change'));
          } }, el('option', { value: '', text: 'Pick a project…' }), ...[...$('#chat-project').options].filter(o => o.value).map(o => el('option', { value: o.value, text: o.text })))) : null,
      ]);
    }
    const chats = chatUi.list.filter(chatShown);
    const groups = projectGroups(chats, p.id);
    const home = typeof homeUi === 'object' ? homeUi.data : null;
    const now = app.shotListNow?.() ?? { chat: '', list: null };
    const known = id => ({
      shots: id === now.chat ? now.list : shotRead.project === p.id ? shotRead.lists[id] ?? null : null,
      answering: home?.answering ?? [],
      waiting: (home?.waiting ?? []).filter(x => x.chat),
    });
    const inChat = homeUi.view === 'chat';
    const line = c => {
      const here = inChat && c.id === chatUi.current;
      const word = chatStateWord(c.id, known(c.id));
      return el('li', {}, el('button', { class: 'pt-chat', type: 'button', 'data-key': `${key}:${c.id}`, 'aria-current': here ? 'true' : null, title: `${c.title}${here ? '\nOpen now' : '\nPress to open this chat'}`, onclick: () => app.openChat(c.id) },
        el('span', { class: 'pt-title', text: c.title }),
        word ? el('span', { class: 'pt-word', text: word }) : null));
    };
    const person = g => el('li', { class: 'pt-person' },
      el('div', { class: 'pt-who' },
        chatAvatar(g.chats[0]),
        el('span', { class: 'pt-name', text: g.name }),
        g.role ? el('span', { class: 'pt-role', title: g.role }, typeof roleIcon === 'function' ? roleIcon(g.roleId) : null, el('span', { class: 'sr-only', text: g.role })) : null),
      el('ul', { class: 'pt-chats' }, ...g.chats.map(line)));
    const planned = p.plan !== false;
    const open = el('button', { class: 'btn', type: 'button', 'data-key': `${key}:open`,
      text: planned ? 'Open project' : 'Make the plan',
      title: planned ? `Open ${p.name} in Jobs` : `${p.name} has no plan yet: the planner makes one from its Scope card`,
      onclick: () => (planned ? app.openJob(p.id) : app.planProject(p.id, p.goal || p.name)) });
    keepFocus(box, [
      el('div', { class: 'pt-head' }, el('h3', { class: 'pt-project', text: p.name, title: p.goal || p.name }), open),
      el('button', { class: 'btn quiet pt-page', type: 'button', 'data-key': `${key}:page`, text: 'Project page', title: `${p.name}'s chats, and its code, pictures, writing and videos`, onclick: () => app.openProjectPage?.(p.id) }),
      ...groups.map(k => el('section', { class: 'pt-kind', 'aria-label': k.name }, el('h4', { text: k.name }), el('ul', { class: 'pt-people' }, ...k.people.map(person)))),
      el('button', { class: 'btn quiet pt-new', type: 'button', 'data-key': `${key}:new`, text: '+ New chat in this project', title: `New chat, with ${p.name} picked as its project`, onclick: () => $('#rail-new').click() }),
    ]);
    // The shot lists of its other video chats, now and then, while this is on screen.
    const video = groups.find(k => k.id === 'videos')?.people.flatMap(g => g.chats.map(c => c.id)).filter(id => id !== now.chat) ?? [];
    if (video.length) void readShots(p.id, video);
  }

  function draw() {
    const shotsOn = $('#subjects').classList.contains('shots-on');
    const shown = $('#subjects-fold').open && (shotsOn ? $('#shot-project').open : !$('#panel-project').hidden);
    // Under a Videographer's shot list: the Project fold, only there when the chat is in a project.
    $('#shot-project').hidden = !shotsOn || !(chatUi.open && chatGroup(chatUi.open));
    if (!shown) return;
    projectView(shotsOn ? $('#shot-project-body') : $('#panel-project'), shotsOn ? 'spt' : 'pt');
  }
  app.drawProjectTab = draw;
  app.projectGroups = projectGroups;

  // The fold under the shot list: drawn when opened; open or closed is kept in this browser.
  $('#shot-project').open = store('shot-project-open') === '1';
  $('#shot-project').addEventListener('toggle', e => {
    store('shot-project-open', e.target.open ? '1' : '0');
    if (e.target.open) draw();
  });
  $('#subjects-fold').addEventListener('toggle', () => draw());
}
