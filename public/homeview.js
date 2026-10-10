// The Home view (what is waiting for you, what is working now, set-up links, "Lets create a project", hire from Home)
// and keeping Home fresh. Moved out of home.js, whose rail, desks and Nodes and memory it uses; loaded right after it.
'use strict';

// ---- The Home view ----

function itemCard(x, key) {
  // What the queue brought back (Review photos, Review documents, Reply and answer): queue.js draws it.
  if (x.queue && app.queueCard) return app.queueCard(x, key);
  if (x.kind === 'pcask') return pcAskCard(x, key);
  const go = el('button', { class: `btn${x.kind === 'result' ? ' primary' : ''}`, type: 'button', text: x.action, 'data-key': key });
  go.addEventListener('click', () => app.openJob(x.job));
  return el('article', { class: `home-item k-${x.kind}` },
    el('div', { class: 'home-item-text' },
      el('strong', { text: x.text }),
      el('span', { class: 'hint', text: x.detail }),
      el('span', { class: 'hint home-goal', text: `Job: ${x.goal}` })),
    el('div', { class: 'home-item-actions' }, go));
}

/**
 * Someone at a linked PC sent "I need to use the pc, please log out for N hours" from its lock screen. Log out: no new
 * work goes there for those hours (it starts again by itself after); Not now: they are told so on that screen.
 */
function pcAskCard(x, key) {
  const hours = `${x.hours} hour${x.hours === 1 ? '' : 's'}`;
  const sent = new Date(x.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const answer = yes => async e => {
    for (const b of e.target.parentElement.querySelectorAll('button')) b.disabled = true;
    try {
      const r = await api('/api/remotes', { action: 'answer', id: x.pc, at: x.at, yes });
      sayHere($('#home-ask-say'), r.text);
    } catch (err) {
      sayHere($('#home-ask-say'), err.message);
    }
    await refresh();
  };
  return el('article', { class: 'home-item k-pcask' },
    el('div', { class: 'home-item-text' },
      el('strong', { text: x.text }),
      el('span', { class: 'hint', text: `Sent at ${sent} from the lock screen on "${x.name}". Log out: no new work goes there for ${hours}, and its models are unloaded once the work running there finishes; it starts again by itself after that.` })),
    el('div', { class: 'home-item-actions' },
      el('button', { class: 'btn primary', type: 'button', text: `Log out for ${hours}`, 'data-key': `${key}:yes`, onclick: answer(true) }),
      el('button', { class: 'btn quiet', type: 'button', text: 'Not now', 'data-key': `${key}:no`, onclick: answer(false) })));
}

/** One of the recent projects: its name, how far it is, and Open (or Make the plan, for one saved without a plan). */
function recentCard(x, key) {
  const go = el('button', { class: 'btn', type: 'button', text: x.action, 'data-key': key });
  go.addEventListener('click', () => (x.plan ? app.planProject(x.job, x.goal) : app.openJob(x.job)));
  return el('article', { class: 'home-item k-recent' },
    el('div', { class: 'home-item-text' },
      el('strong', { text: x.name }),
      el('span', { class: 'hint', text: x.detail }),
      x.goal && x.goal !== x.name ? el('span', { class: 'hint home-goal', text: x.goal }) : null),
    el('div', { class: 'home-item-actions' }, go));
}

function bar(fraction, label) {
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  // Set through the style property: the page's security policy ignores a style attribute.
  const fill = el('div', { class: 'home-fill' });
  fill.style.width = `${pct}%`;
  return el('div', { class: 'home-track', role: 'progressbar', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct) }, fill);
}

const secsText = n => (n < 60 ? `${n} s` : `${Math.floor(n / 60)} min ${n % 60} s`);

function workingCards() {
  const d = homeUi.data;
  const out = [];
  const w = d.working;
  if (w) {
    const open = el('button', { class: 'btn', type: 'button', text: 'Open the job', 'data-key': 'working-job' });
    open.addEventListener('click', () => (w.job ? app.openJob(w.job) : $('#jobs-open').click()));
    out.push(el('article', { class: 'home-item k-working' },
      el('div', { class: 'home-item-text' },
        el('strong', { text: w.text }),
        w.stage ? el('span', { class: 'hint', text: w.stage }) : null,
        w.total ? bar(w.done / w.total, `${w.done} of ${w.total} steps done`) : null,
        el('span', { class: 'hint', text: `${w.total ? `${w.done} of ${w.total} steps done · ` : ''}${secsText(w.seconds)} on this` }),
        el('span', { class: 'hint home-goal', text: `Job: ${w.goal}` })),
      open));
  }
  // Someone answering in a chat (here or on a linked PC), with the chat it is in.
  for (const a of d.answering ?? []) {
    const doing = a.what === 'picture' ? 'is drawing a picture' : a.what === 'handoff' ? 'is writing a handoff' : a.what === 'continue' ? 'is carrying on an answer' : 'is answering';
    const open = el('button', { class: 'btn', type: 'button', text: 'Open the chat', 'data-key': `working-chat:${a.chat}` });
    open.addEventListener('click', () => app.openChat(a.chat));
    out.push(el('article', { class: 'home-item k-working' },
      el('div', { class: 'home-item-text' },
        el('strong', { text: `${a.name} ${doing}.` }),
        el('span', { class: 'hint', text: [a.role, a.pc ? (a.pc === 'this PC' ? 'on this PC' : `on "${a.pc}"`) : '', `${secsText(a.seconds)} so far`].filter(Boolean).join(' · ') }),
        a.title ? el('span', { class: 'hint home-goal', text: `Chat: ${a.title}` }) : null),
      open));
  }
  // A picture being drawn, and a model waking up, are read from the same status the top bar uses.
  const s = app.status;
  const j = s?.panes.image.job;
  if (j && PICTURE_RUNNING.includes(j.state)) {
    const total = j.count * j.steps;
    const done = (Math.max(1, j.image) - 1) * j.steps + j.step;
    const frac = j.state === 'drawing' ? done / Math.max(1, total) : j.state === 'queued' || j.state === 'starting' ? 0 : 1;
    const see = el('button', { class: 'btn', type: 'button', text: 'See it', 'data-key': 'working-picture' });
    see.addEventListener('click', () => $('#job-chip').click());
    const artist = d.staff.find(x => x.kind === 'image' && x.active);
    out.push(el('article', { class: 'home-item k-working' },
      el('div', { class: 'home-item-text' },
        el('strong', { text: `${artist ? `${artist.name} is drawing` : 'Drawing'} a picture${j.count > 1 ? ` (${j.count} drafts)` : ''}.` }),
        el('span', { class: 'hint', text: j.prompt ?? '' }),
        bar(frac, 'Picture progress'),
        el('span', { class: 'hint', text: `${j.state === 'drawing' ? `Step ${j.step} of ${j.steps}` : j.state === 'queued' ? 'Waiting for the picture before it' : j.state === 'starting' ? 'Starting' : 'Finishing'} · ${secsText(Math.round(j.elapsed ?? 0))} so far` })),
      see));
  }
  // A picture the queue has a linked PC drawing (one drawn here shows above, from the picture pane).
  out.push(...(app.queueWorking?.(d.queue) ?? []));
  for (const [pane, label] of [['chat', 'chat'], ['image', 'picture']]) {
    const v = s?.panes[pane];
    if (v?.state !== 'loading') continue;
    const spent = v.loadStartedAt ? Math.round((Date.now() - v.loadStartedAt) / 1000) : 0;
    out.push(el('article', { class: 'home-item k-working' },
      el('div', { class: 'home-item-text' },
        el('strong', { text: `Waking up the ${label} model: ${(v.modelName ?? '').replace(/\s*[(+].*$/, '')}.` }),
        bar(Math.min(0.95, spent / Math.max(1, v.expectedSeconds)), 'Loading'),
        el('span', { class: 'hint', text: `${secsText(spent)} so far, about ${Math.max(0, Math.round(v.expectedSeconds - spent))} s more (estimated)` }))));
  }
  return out;
}

/** Big set-up cards while the basics are missing; afterwards they live as the rail's Set up links. */
function setupCards() {
  const u = homeUi.data.setup;
  const box = $('#home-setup');
  const sig = JSON.stringify(u);
  if (sig === homeUi.drawn.setup) return;
  homeUi.drawn.setup = sig;
  if (u.chatModels && u.staff) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const steps = [u.chatModels > 0, u.staff > 0, u.pcs > 0, !!u.node];
  const card = (done, title, text, button, onClick) => el('article', { class: `setup-card${done ? ' done' : ''}` },
    el('strong', { text: `${done ? '✓ ' : ''}${title}` }), el('p', { class: 'hint', text }),
    el('button', { class: `btn${done ? '' : ' primary'}`, type: 'button', text: button, onclick: onClick }));
  box.replaceChildren(
    el('h3', { text: `Setup progress ${steps.filter(Boolean).length}/${steps.length} start setup now:` }),
    el('div', { class: 'setup-grid' },
      card(u.chatModels > 0, 'Add a chat model', u.chatModels ? `${u.chatModels} chat model${u.chatModels > 1 ? 's' : ''} found.` : 'TOMLIN needs at least one chat model on this PC. Models shows which ones fit.', 'Models', () => app.openModels()),
      card(u.staff > 0, 'Hire your first staff member', u.staff ? `${u.staff} on the team.` : 'Give a person a name, a role (coder, writer, artist…) and a level. They appear in the list on the left.', 'Team', () => (u.staff ? $('#team-open').click() : app.openHire())),
      card(u.pcs > 0, 'Link another PC (optional)', [u.pcs ? `${u.pcs} PC${u.pcs > 1 ? 's' : ''} linked.` : '', u.pcsBroken?.length ? `${u.pcsBroken.map(n => `"${n}"`).join(', ')} need${u.pcsBroken.length > 1 ? '' : 's'} linking again: its old link no longer works.` : '', !u.pcs && !u.pcsBroken?.length ? 'Use a stronger PC on your home network for some of the work.' : ''].filter(Boolean).join(' '), 'Other PCs', () => app.openPcs()),
      card(u.node, 'Use this PC as a node (optional)', u.node ? 'Shared with your other PCs.' : 'Let another PC send work to this one: the steps, the memory it has, and which models stay loaded.', 'Nodes and memory', () => openNodes())));
}

// The Home title greets by the time of day, with the date under it.
function greet() {
  const now = new Date();
  const h = now.getHours();
  $('#home-title').textContent = h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  $('#home-date').textContent = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function drawHome() {
  const d = homeUi.data;
  if (!d) return;
  setupCards();
  greet();
  // The staff row follows the hires (hired here, in Staff, or fired): drawn with every refresh, not only by the status.
  drawHomeAsk();
  const sig = JSON.stringify([d.waiting, d.paused, d.recent]);
  if (sig !== homeUi.drawn.items) {
    homeUi.drawn.items = sig;
    keepFocus($('#home-waiting'), d.waiting.length ? d.waiting.map((x, i) => itemCard(x, `w:${x.job}:${i}`)) : [el('p', { class: 'home-empty', text: 'Nothing waiting' })]);
    $('#home-paused-box').hidden = !d.paused.length;
    keepFocus($('#home-paused'), d.paused.map((x, i) => itemCard(x, `p:${x.job}:${i}`)));
    const recent = d.recent ?? [];
    $('#home-ready-box').hidden = !recent.length;
    keepFocus($('#home-ready'), recent.map((x, i) => recentCard(x, `r:${x.job}:${i}`)));
  }
  const working = workingCards();
  keepFocus($('#home-working'), working.length ? working : [el('p', { class: 'home-empty', text: 'Nobody working' })]);
  app.drawQueue?.();
  // Folded, the panel still says that someone is working.
  $('#home-working-count').hidden = !working.length;
  $('#home-working-count').textContent = `${working.length} working`;
}

// ---- Keeping it fresh ----

let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    // "front": whether this page is shown and focused; the server raises a Windows notification only when it is not.
    homeUi.data = await api(`/api/home?front=${app.inFront?.() ? 1 : 0}`);
    if (app.models) keepPlain(app.models.settings.who);
    // The message box says who answers (the chat's own name and person are drawn by chats.js).
    // A hire who lives on another PC is not in this PC's staff list: the open chat's own person names them.
    const openChat = chatUi.list.find(c => c.id === (app.chatId ?? chatUi.current));
    // The person in the chat on screen; with no chat open yet, the one chosen (another window may have chosen since).
    const onScreen = String(chatUi.open?.who ?? '');
    const talking = (onScreen ? homeUi.data.staff.find(s => s.kind === 'chat' && `staff:${s.id}` === onScreen) : homeUi.data.staff.find(s => s.kind === 'chat' && s.active))
      ?? (String(openChat?.who ?? '').startsWith('node:') ? { name: openChat.name } : null);
    // The host is off for now (no row) and nobody who chats is hired: the box and the empty chat say to hire someone.
    app.nobodyToTalkTo = !homeUi.data.manager && !homeUi.data.staff.some(s => s.kind === 'chat');
    if (app.nobodyToTalkTo && !chatUi.open) {
      const empty = $('#chat-log .empty');
      if (empty) empty.textContent = app.nobodyYet;
    } else if (!app.nobodyToTalkTo) {
      // Someone was hired since the empty chat was drawn: it no longer says to hire someone first.
      const empty = $('#chat-log .empty');
      if (empty?.textContent === app.nobodyYet) empty.textContent = app.emptyChat;
    }
    // A chat with someone no longer on the team (or a retired node hire) is read, not carried on.
    $('#chat-input').placeholder = chatUi.open && chatUi.open.here === false ? READ_ONLY_BOX
      : app.nobodyToTalkTo ? 'Hire someone first: Settings, Set up, Staff, Hire staff'
      : `Message ${app.inSentence?.(talking ? talking.name : chatUi.people.find(p => p.who === 'manager')?.name ?? 'The host') ?? 'the host'}…`;
    drawRail();
    drawHome();
    app.afterHome?.();
    // A chat opened while its answer was still coming (chats.js): drawn again once it is finished.
    const waited = app.awaitAnswer;
    if (waited && !(homeUi.data.answering ?? []).some(a => a.chat === waited)) {
      app.awaitAnswer = '';
      if (app.chatId === waited) showChat(await app.chatAgain());
    }
    refreshNodes();
  } catch {
    // The top bar already says when TOMLIN is not answering.
  } finally {
    refreshing = false;
  }
}
// One ask at a time: a slow answer (a PC that is off takes seconds) is never overtaken by a later one; an ask made
// meanwhile (after a change) runs once when it ends. A failed ask keeps the PCs as last seen (the top bar already
// says when TOMLIN is not answering).
let pcsAsking = false, pcsAgain = false;
async function refreshPcs() {
  if (pcsAsking) { pcsAgain = true; return; }
  pcsAsking = true;
  try {
    homeUi.pcs = (await api('/api/home/pcs')).pcs;
    drawRail();
  } catch {
    // Kept as they were.
  } finally {
    pcsAsking = false;
    if (pcsAgain) { pcsAgain = false; refreshPcs(); }
  }
}
greet();
refresh();
refreshPcs();
setInterval(refresh, 3000);
// The queue (queue.js) asks for Home to be drawn again at once after a change.
app.refreshHome = refresh;
// Paired PCs are asked again now and then, so a PC that went off (and its staff) shows as off.
// Every 20 seconds while the page is in front, every minute behind; at once when it comes to the front again.
let pcsAt = Date.now();
const pcsDue = () => { pcsAt = Date.now(); refreshPcs(); };
setInterval(() => { if (!document.hidden || Date.now() - pcsAt >= 60_000) pcsDue(); }, 20_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - pcsAt >= 5_000) pcsDue(); });
// The picture and loading lines follow the once-a-second status without asking the server again.
app.onStatus.push(() => {
  if (homeUi.data && homeUi.view === 'home') drawHome();
});

// ---- Set-up links and the job box ----

for (const b of document.querySelectorAll('[data-setup]')) {
  b.addEventListener('click', () => {
    if (b.dataset.setup === 'settings') app.openSettings?.();
    else if (b.dataset.setup === 'staff') app.openHire({ page: true });
    else if (b.dataset.setup === 'models') app.openModels();
    else if (b.dataset.setup === 'nodes') openNodes();
    else if (b.dataset.setup === 'jobs') $('#jobs-open').click();
    else if (b.dataset.setup === 'files') $('#files-open').click();
    else app.openPcs();
  });
}
// Hiring, letting go, pairing a PC or sharing this one changes the lists: redraw when those windows close.
for (const id of ['#team', '#jobs']) $(id)?.addEventListener('close', () => {
  refresh();
  refreshPcs();
  refreshOthers();
});

// ---- "Lets create a project": a name, a mini description, the prompt, and who leads it ----
// The project's folder is the date and time it was made ("2026-10-07-1116"), made by the server.

const homeAsk = { pm: '', drawn: '' };

/** The name a project gets when none is typed: "Project " and the date and time now, as its folder is named. */
function folderNow() {
  const n = new Date();
  const p = x => String(x).padStart(2, '0');
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}-${p(n.getHours())}${p(n.getMinutes())}`;
}

/** The name it gets when none is typed, and the staff to pick from: Name - software - PC (or Hire staff). */
function drawHomeAsk() {
  $('#home-name').placeholder = `Project ${folderNow()}`;
  // A hire on a PC set to Backups only takes no work, so it is not offered.
  const staff = (homeUi.data?.staff ?? []).filter(s => s.kind === 'chat' && !s.backupsOnly)
    .map(s => ({ id: s.id, name: s.name, model: s.modelName || 'no model yet', pc: s.pc || 'This PC' }));
  if (homeAsk.pm && !staff.some(s => s.id === homeAsk.pm)) homeAsk.pm = '';
  const sig = JSON.stringify([staff, homeAsk.pm, team.data?.roles?.length ?? 0]);
  if (sig === homeAsk.drawn) return;
  homeAsk.drawn = sig;
  const pick = $('#home-staff');
  pick.hidden = !staff.length;
  $('.home-staff-label').hidden = !staff.length;
  // Nobody hired yet: the staff icons (one per chat role), each opening a window to hire one.
  const hire = $('#home-hire');
  hire.hidden = !!staff.length;
  if (!staff.length) hire.replaceChildren(...(team.data?.roles ?? []).map(r => el('button', { class: 'staff-chip', type: 'button', title: `Hire a ${r.name.toLowerCase()}: pick their PC and software`, onclick: () => quickHire(r.id) },
    el('span', { class: 'rail-avatar', 'aria-hidden': 'true' }, roleIcon(r.id)), el('span', { text: r.name }))));
  if (staff.length) {
    pick.replaceChildren(el('option', { value: '', text: 'Default - strongest available PC', title: 'The strongest worker that is free when it starts' }),
      ...staff.map(s => el('option', { value: s.id, text: `${s.name} - ${s.model} - ${s.pc}` })));
    pick.value = homeAsk.pm;
  }
  // Said only when nobody is hired yet: the drop-down says the rest.
  $('#home-staff-line').textContent = staff.length ? '' : 'Hire staff (staff connects a LLM model to a PC or node).';
  $('#home-staff-line').hidden = !!staff.length;
}
drawHomeAsk();
$('#home-staff').addEventListener('change', e => {
  homeAsk.pm = e.target.value;
  drawHomeAsk();
});

// ---- Hire staff from Home: an icon per role opens Hire staff (hire.js) with that role picked ----

const quickHire = role => app.openHire({ role });
app.onStatus.push(() => {
  if (homeUi.view === 'home') drawHomeAsk();
});

$('#home-ask').addEventListener('submit', async e => {
  e.preventDefault();
  const say = $('#home-ask-say');
  const prompt = $('#home-goal').value.trim();
  const about = $('#home-about').value.trim();
  if (!prompt && !about) {
    sayHere(say, 'Type the prompt first: what should exist when it is finished?');
    $('#home-goal').focus();
    return;
  }
  if ($('#home-staff').hidden) {
    sayHere(say, 'Set up staff first: press Setup staff, hire at least one person, then press Lets go! again.');
    return;
  }
  const go = $('#home-go');
  go.disabled = true;
  try {
    const r = await api('/api/projects/create', { name: $('#home-name').value, about, prompt, pm: homeAsk.pm });
    for (const id of ['#home-name', '#home-about', '#home-goal']) $(id).value = '';
    drawHomeAsk();
    say.hidden = true;
    await app.planProject(r.id, prompt || about);
  } catch (err) {
    sayHere(say, err.message);
  } finally {
    go.disabled = false;
  }
});

