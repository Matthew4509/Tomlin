// The queue (src/server/queue.ts): Home's Queue panel (each line in order with its PC, Stop or Resume, up and down,
// Cancel), the lines that wait for him when work comes back (Review photos, Review documents, Reply and answer), the
// photos to review, and "Add to the queue" from the Images window, the Jobs window and a chat whose PC is busy.
// Everything here sits in one block: page scripts share one global scope, so no name of this file can clash.
'use strict';
{
  const KIND = { picture: 'Picture', project: 'Project', chat: 'Message' };
  const STATE = { waiting: 'Waiting', running: 'Running now', done: 'Done', needs: 'Needs you', failed: 'Did not finish', cancelled: 'Cancelled' };
  const time = n => (n < 60 ? `${n} s` : n < 3600 ? `${Math.floor(n / 60)} min` : `${Math.floor(n / 3600)} h ${Math.floor((n % 3600) / 60)} min`);
  const picUrl = rel => `/api/images/file/${String(rel).split('/').map(encodeURIComponent).join('/')}`;
  const winPath = p => String(p).replace(/\//g, '\\');
  let last = null;

  /** Adds work to the queue (one item, or a list as one action). Throws with the reason when nothing was added. */
  async function add(items) {
    const r = await api('/api/queue/add', items.length === 1 ? items[0] : { items });
    last = r;
    app.refreshHome?.();
    return r;
  }
  app.addToQueue = add;

  async function seen(ids) {
    await api('/api/queue/seen', { ids }).catch(() => undefined);
    app.refreshHome?.();
  }

  // ---- Waiting for you: what came back ----

  /** A line of Home's Waiting for you from the queue: its button, and Seen to take it off. */
  app.queueCard = (x, key) => {
    const go = el('button', { class: `btn${x.kind === 'photos' || x.kind === 'documents' ? ' primary' : ''}`, type: 'button', text: x.action, 'data-key': key });
    go.addEventListener('click', () => act(x));
    const off = el('button', { class: 'btn quiet', type: 'button', text: 'Seen', title: 'Take this line off Waiting for you', 'data-key': `${key}:seen` });
    off.addEventListener('click', () => seen(x.ids));
    return el('article', { class: `home-item k-q-${x.kind}` },
      el('div', { class: 'home-item-text' }, el('strong', { text: x.text }), el('span', { class: 'hint', text: x.detail })),
      el('div', { class: 'home-item-actions' }, go, off));
  };

  async function act(x) {
    if (x.kind === 'photos') return showPhotos(x);
    await seen(x.ids);
    if ((x.kind === 'documents' || x.kind === 'needs') && x.job) return app.openJob(x.job);
    if (x.kind === 'reply' && x.chat) return app.openChat(x.chat);
    $('#home-queue-title').scrollIntoView({ block: 'nearest' });
  }

  /** The photos that came back, side by side; Reviewed takes the line off Home. */
  async function showPhotos(x) {
    const q = await api('/api/queue').catch(() => null);
    const pics = (q?.items ?? []).filter(i => x.ids.includes(i.id) && i.output);
    $('#queue-photos-title').textContent = x.text.replace(/\.$/, '');
    $('#queue-photos-line').textContent = x.detail;
    $('#queue-photos-grid').replaceChildren(...(pics.length ? pics.map(p => el('figure', { class: 'queue-photo' },
      el('a', { href: picUrl(p.output), target: '_blank', rel: 'noopener', title: 'Open it full size' }, el('img', { src: picUrl(p.output), alt: p.title, loading: 'lazy' })),
      el('figcaption', { class: 'hint', text: [p.title, p.handed ? (p.handed.startsWith('Not ') ? p.handed : `In ${winPath(p.handed)}`) : 'In the gallery'].join(' · ') }))) : [el('p', { class: 'hint', text: 'These pictures are not in the gallery any more.' })]));
    const dlg = $('#queue-photos');
    $('#queue-photos-done').onclick = async () => {
      dlg.close();
      await seen(x.ids);
    };
    $('#queue-photos-later').onclick = () => dlg.close();
    dlg.showModal();
  }

  // ---- Working now: a picture the queue has a linked PC drawing (this PC's own shows from the picture pane) ----

  app.queueWorking = q => (q?.running ?? []).filter(x => x.kind === 'picture' && !x.here).map(x => {
    const frac = x.steps ? Math.min(1, (x.step ?? 0) / x.steps) : 0;
    const fill = el('div', { class: 'home-fill' });
    fill.style.width = `${Math.round(frac * 100)}%`;
    return el('article', { class: 'home-item k-working' },
      el('div', { class: 'home-item-text' },
        el('strong', { text: `Drawing on "${x.pc}": ${x.title}` }),
        el('span', { class: 'hint', text: [x.stage, x.steps ? `step ${x.step ?? 0} of ${x.steps}` : '', x.eta ? `about ${time(x.eta)} left` : '', `${time(x.seconds ?? 0)} so far`].filter(Boolean).join(' · ') }),
        el('div', { class: 'home-track', role: 'progressbar', 'aria-label': 'Picture progress', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(frac * 100)) }, fill),
        x.projectName ? el('span', { class: 'hint home-goal', text: `For ${x.projectName}` }) : null));
  });

  // ---- The Queue panel ----

  async function post(path, body) {
    try {
      last = await api(path, body);
      draw(last);
    } catch (e) {
      say(e.message);
    }
    app.refreshHome?.();
  }
  function say(text) {
    const box = $('#home-queue-ask');
    if (!text) return void (box.hidden = true);
    sayHere(box, text);
  }

  function row(x, n) {
    const where = [KIND[x.kind], x.projectName ? `for ${x.projectName}` : '', x.pc ? `on ${x.pc === 'this PC' ? 'this PC' : `"${x.pc}"`}` : '', STATE[x.state]].filter(Boolean).join(' · ');
    const more = x.state === 'running'
      ? [x.stage, x.steps ? `step ${x.step ?? 0} of ${x.steps}` : '', x.eta ? `about ${time(x.eta)} left` : '', `${time(x.seconds ?? 0)} so far`].filter(Boolean).join(' · ')
      : x.state === 'waiting' ? (x.waitFor ? 'Waiting for its picture.' : x.note) : x.error || x.result;
    const acts = [];
    if (x.state === 'waiting') {
      for (const [dir, label, word] of [['up', '↑', 'Move up'], ['down', '↓', 'Move down']]) {
        acts.push(el('button', { class: 'btn quiet queue-arrow', type: 'button', text: label, title: word, 'aria-label': `${word}: ${x.title}`, 'data-key': `q:${x.id}:${dir}`, onclick: () => post('/api/queue/move', { id: x.id, dir }) }));
      }
    }
    if (x.state === 'waiting' || x.state === 'running') {
      acts.push(el('button', { class: 'btn quiet', type: 'button', text: 'Cancel', 'aria-label': `Cancel: ${x.title}`, 'data-key': `q:${x.id}:cancel`, onclick: async () => {
        // Running: what it has done so far is lost (a picture part-way, an answer part-way); asked first.
        if (x.state === 'running' && !(await askHere($('#home-queue-ask'), `Cancel "${x.title.slice(0, 60)}"? It is running now: what it has done so far is lost.${x.kind === 'project' ? ' Steps already saved stay saved.' : ''}`, 'Cancel it', 'Keep it'))) return;
        post('/api/queue/cancel', { id: x.id });
      } }));
    }
    if (x.state === 'failed' || x.state === 'cancelled') {
      acts.push(el('button', { class: 'btn quiet', type: 'button', text: 'Again', title: 'Put it back in line, at the end', 'aria-label': `Again: ${x.title}`, 'data-key': `q:${x.id}:again`, onclick: () => post('/api/queue/again', { id: x.id }) }));
    }
    return el('li', { class: `queue-row q-${x.state}` },
      el('span', { class: 'queue-n', 'aria-hidden': 'true', text: n ? String(n) : x.state === 'running' ? '▶' : '·' }),
      el('div', { class: 'queue-text' },
        el('strong', { text: x.title }),
        el('span', { class: 'hint', text: where }),
        more ? el('span', { class: `hint${x.state === 'failed' ? ' fault-line' : ''}`, text: more }) : null),
      acts.length ? el('div', { class: 'queue-acts' }, ...acts) : null);
  }

  /** The panel from the queue as the server has it now. */
  function draw(q) {
    if (!q) return;
    const items = q.items ?? [];
    const open = items.filter(x => x.state === 'running' || x.state === 'waiting');
    const done = items.filter(x => x.state !== 'running' && x.state !== 'waiting');
    $('#home-queue-count').textContent = q.count;
    const tools = [];
    if (q.paused) tools.push(el('button', { class: 'btn primary', type: 'button', text: 'Resume', 'data-key': 'q:resume', onclick: () => post('/api/queue/pause', { paused: false }) }));
    else if (open.length) tools.push(el('button', { class: 'btn', type: 'button', text: 'Stop', title: 'Stop what runs now (it goes back in line) and start nothing new until Resume', 'data-key': 'q:stop', onclick: () => post('/api/queue/pause', { paused: true }) }));
    if (done.length) tools.push(el('button', { class: 'btn quiet', type: 'button', text: 'Clear finished', 'data-key': 'q:clear', onclick: () => post('/api/queue/clear', {}) }));
    if (open.some(x => x.state === 'waiting')) tools.push(el('button', { class: 'btn quiet', type: 'button', text: 'Clear the list', 'data-key': 'q:clear-all', onclick: async () => {
      if (await askHere($('#home-queue-ask'), 'Take every waiting line off the queue? What runs now carries on. Nothing finished is touched.', 'Clear the list', 'Keep them')) post('/api/queue/clear', { all: true });
    } }));
    const keep = typeof keepFocus === 'function' ? keepFocus : (box, kids) => box.replaceChildren(...kids);
    keep($('#home-queue-tools'), tools);
    let n = 0;
    const rows = [...open.map(x => row(x, x.state === 'waiting' ? ++n : 0)), ...done.slice(-8).reverse().map(x => row(x, 0))];
    keep($('#home-queue'), rows.length ? rows : [el('li', { class: 'home-empty', text: 'Nothing in line. Add pictures from the Images window, a project from Jobs, or a message when a PC is busy.' })]);
  }
  app.drawQueue = async () => {
    try {
      draw(await api('/api/queue'));
    } catch {
      // The top bar already says when TOMLIN is not answering.
    }
  };

  // ---- Adding from the Images window ----

  /** The projects for "for", newest first; the open chat's project picked when it has one. */
  async function fillProjects() {
    const sel = $('#img-queue-project');
    const had = sel.value;
    const r = await api('/api/queue/projects').catch(() => null);
    const jobs = r?.projects ?? [];
    sel.replaceChildren(el('option', { value: '', text: 'no project (the gallery)' }), ...jobs.map(j => el('option', { value: j.id, text: j.name.slice(0, 60) })));
    const chatProject = (typeof chatUi !== 'undefined' ? chatUi.open?.project : '') || '';
    sel.value = jobs.some(j => j.id === had) ? had : jobs.some(j => j.id === chatProject) ? chatProject : '';
  }
  $('#img-queue-project').addEventListener('focus', () => fillProjects().catch(() => undefined));
  fillProjects().catch(() => undefined);

  function pictureFields() {
    const num = id => (Number($(id).value) > 0 ? Number($(id).value) : undefined);
    return { kind: 'picture', as: $('#draw-as').value || undefined, mode: $('#img-mode').value, width: num('#img-w'), height: num('#img-h'), project: $('#img-queue-project').value || undefined };
  }
  function imgNote(text) {
    $('#img-note').textContent = text;
    $('#img-note').hidden = !text;
  }
  const where = () => {
    const sel = $('#img-queue-project');
    return sel.value ? `for ${sel.selectedOptions[0]?.text ?? 'the project'}` : 'for the gallery';
  };
  $('#img-queue').addEventListener('click', async () => {
    const prompt = $('#img-prompt').value.trim();
    if (!prompt) return imgNote('Type what to draw first, then Add to the queue.');
    try {
      const r = await add([{ ...pictureFields(), prompt }]);
      $('#img-prompt').value = '';
      const ahead = (r.items ?? []).filter(x => x.state === 'waiting' || x.state === 'running').length - 1;
      imgNote(`Added to the queue ${where()}${ahead > 0 ? `: ${ahead} ahead of it` : ''}. It is drawn by itself; Home says when it is back.`);
    } catch (e) {
      imgNote(e.message);
    }
  });
  $('#img-list-go').addEventListener('click', async () => {
    const lines = $('#img-list').value.split('\n').map(s => s.trim()).filter(Boolean);
    const line = $('#img-list-line');
    if (!lines.length) return void (line.textContent = 'Type one picture per line first.');
    try {
      const base = pictureFields();
      const r = await add(lines.map(prompt => ({ ...base, prompt })));
      $('#img-list').value = '';
      line.textContent = `${r.added} picture${r.added === 1 ? '' : 's'} added to the queue ${where()}. Home says when they are back.`;
    } catch (e) {
      line.textContent = e.message;
    }
  });

  // ---- Adding from the Jobs window, and when LETS GO!!! finds another project working ----

  /** Puts the open job in the queue (the auditor reads each step when that box is ticked, as with LETS GO!!!). */
  app.queueJob = async (job, say) => {
    try {
      const r = await add([{ kind: 'project', project: job.id, review: $('#job-review-each').checked }]);
      const ahead = (r.items ?? []).filter(x => x.state === 'waiting' || x.state === 'running').length - 1;
      say(`Added to the queue${ahead > 0 ? ` with ${ahead} ahead of it` : ''}. Its steps run by themselves; Home says when it is done or needs you. You can close this window.`);
    } catch (e) {
      say(e.message, true);
    }
  };

  // ---- A chat whose hire's PC is busy with the queue: "busy: add to the queue" ----

  /** Asked in the chat: add the message to the queue, send it now anyway, or not now. Resolves with the choice. */
  app.offerQueue = (data, message, think) => new Promise(done => {
    const box = $('#chat-ask');
    const end = how => {
      box.replaceChildren();
      box.hidden = true;
      done(how);
    };
    app.askFor?.(box, () => end('no'));
    const queueIt = el('button', { class: 'btn primary', type: 'button', text: 'Add to the queue', onclick: async () => {
      try {
        await add([{ kind: 'chat', chat: data.chat, message, think }]);
        end('queued');
        app.chatNote?.('Added to the queue: it is answered in this chat when that PC is free. Home says when the answer is back.');
      } catch (e) {
        end('no');
        app.chatNote?.(e.message);
      }
    } });
    box.classList.add('page-ask');
    box.setAttribute('role', 'alert');
    box.replaceChildren(el('span', { text: data.text }), queueIt,
      el('button', { class: 'btn', type: 'button', text: 'Send now anyway', onclick: () => end('now') }),
      el('button', { class: 'btn quiet', type: 'button', text: 'Not now', onclick: () => end('no') }));
    box.hidden = false;
    queueIt.focus();
  });

  // Home drew its lists before this file was read: drawn again now, so the queue's lines get their own cards.
  if (typeof homeUi !== 'undefined') homeUi.drawn.items = '';
  app.refreshHome?.();
}
