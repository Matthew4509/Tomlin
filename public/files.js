// Files (open, edit and save plain text files in one workspace folder) and the blog writer. Uses app.js's helpers ($, el, api, app).
'use strict';

const filesDlg = $('#files');
const fileState = { folder: '', files: [], path: '', saved: '' };
const fileEditor = $('#file-text');
const fileNote = $('#file-note');

function fileFault(message) {
  const f = $('#files-fault');
  f.textContent = message ?? '';
  f.hidden = !message;
}

const sizeText = n => (n < 1024 ? `${n} B` : `${Math.round(n / 1024)} KB`);

function drawFileList() {
  const box = $('#file-list');
  box.replaceChildren();
  if (!fileState.files.length) box.append(el('p', { class: 'hint', text: 'No files yet. Type a name below and press New file, or write a blog post.' }));
  for (const f of fileState.files) {
    const b = el('button', { class: `file-item${f.path === fileState.path ? ' current' : ''}`, type: 'button', title: `${f.path} · ${sizeText(f.bytes)} · ${new Date(f.at).toLocaleString()}` }, el('span', { text: f.path }), el('span', { class: 'hint', text: sizeText(f.bytes) }));
    b.addEventListener('click', () => openFile(f.path));
    box.append(b);
  }
}

async function loadFiles() {
  const r = await api('/api/files');
  fileState.folder = r.folder;
  fileState.files = r.files;
  $('#files-folder').value = r.folder;
  drawFileList();
}

function dirty() {
  return fileState.path && fileEditor.value !== fileState.saved;
}

async function openFile(path) {
  if (dirty() && !(await askHere($('#file-ask-box'), `${fileState.path} has changes you have not saved. Open another file and lose them?`, 'Open it, lose the changes', 'Stay here'))) return;
  fileFault(null);
  try {
    const r = await api(`/api/files/read?path=${encodeURIComponent(path)}`);
    fileState.path = r.path;
    fileState.saved = r.text;
    fileEditor.value = r.text;
    fileEditor.disabled = false;
    $('#file-name').textContent = r.path;
    $('#file-save').disabled = false;
    fileNote.textContent = '';
    drawFileList();
  } catch (e) {
    fileFault(e.message);
  }
}

async function saveFile(path, text, create) {
  fileFault(null);
  try {
    const r = await api('/api/files/save', { path, text, create });
    await loadFiles();
    return r;
  } catch (e) {
    fileFault(e.message);
    return null;
  }
}

$('#file-save').addEventListener('click', async () => {
  const r = await saveFile(fileState.path, fileEditor.value, false);
  if (r) {
    fileState.saved = fileEditor.value;
    fileNote.textContent = `Saved ${r.path}. The earlier version is kept as ${r.path}.bak.`;
  }
});
fileEditor.addEventListener('input', () => {
  fileNote.textContent = dirty() ? 'Unsaved changes.' : '';
});
$('#file-new-form').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('#file-new').value.trim();
  if (!name) return;
  const r = await saveFile(name.includes('.') ? name : `${name}.md`, '', true);
  if (r) {
    $('#file-new').value = '';
    await openFile(r.path);
  }
});
$('#file-add-answer').addEventListener('click', () => {
  if (!fileState.path) return fileFault('Open a file first.');
  const last = [...document.querySelectorAll('#chat-log .msg.assistant')].filter(m => !m.querySelector('.chat-pic')).at(-1);
  if (!last) return fileFault('There is no chat answer yet.');
  const text = [...last.childNodes].filter(n => !(n.classList && n.classList.contains('speed'))).map(n => n.textContent).join('').trim();
  fileEditor.value += `${fileEditor.value && !fileEditor.value.endsWith('\n') ? '\n\n' : ''}${text}\n`;
  fileEditor.dispatchEvent(new Event('input'));
  fileNote.textContent = 'Added the last chat answer at the end. Save to keep it.';
});
$('#file-ask').addEventListener('click', () => {
  if (!fileState.path) return fileFault('Open a file first.');
  const input = $('#chat-input');
  input.value = `Here is my file ${fileState.path}:\n\n${fileEditor.value}\n\n`;
  filesDlg.close();
  app.showPanes?.();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  app.chatNote('The file is in the message box. Type what you want done with it, then send.');
});
$('#files-folder-form').addEventListener('submit', async e => {
  e.preventDefault();
  fileFault(null);
  // Changing the folder closes the open file: unsaved changes are asked about first.
  if (dirty() && !(await askHere($('#file-ask-box'), `${fileState.path} has changes you have not saved. Use the other folder and lose them?`, 'Change folder, lose the changes', 'Stay here'))) return;
  $('#files-folder-note').textContent = '';
  try {
    const r = await api('/api/files/folder', { path: $('#files-folder').value.trim() });
    $('#files-folder-note').textContent = r.made ? `That folder did not exist, so TOMLIN made it. If the name has a typo, type the right one and press Use this folder again.` : 'Now using this folder. Jobs are kept in the folder too: the jobs in the old folder stay there, and come back if you switch back to it.';
    fileState.folder = r.folder;
    fileState.files = r.files;
    fileState.path = '';
    fileEditor.value = '';
    fileEditor.disabled = true;
    $('#file-save').disabled = true;
    $('#file-name').textContent = 'No file open';
    $('#files-folder').value = r.folder;
    drawFileList();
  } catch (err) {
    fileFault(err.message);
  }
});

// ---- Blog writer ----

const blog = { title: '', path: '' };

function blogFault(message) {
  const f = $('#blog-fault');
  f.textContent = message ?? '';
  f.hidden = !message;
}

$('#blog-form').addEventListener('submit', async e => {
  e.preventDefault();
  blogFault(null);
  const go = $('#blog-go');
  const out = $('#blog-draft');
  go.disabled = true;
  $('#blog-stop').hidden = false;
  let stopped = false;
  $('#blog-stop').onclick = () => {
    stopped = true;
    // The blog writer's own work only ('' is work that is not a chat): a chat's answer carries on.
    api('/api/chat/stop', { chatId: '' }).catch(() => undefined);
  };
  $('#blog-edit').hidden = true;
  $('#blog-saved').hidden = true;
  out.hidden = false;
  out.textContent = 'Writing…';
  const t0 = performance.now();
  try {
    const res = await fetch('/api/blog', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topic: $('#blog-topic').value, audience: $('#blog-audience').value, words: Number($('#blog-words').value), tone: $('#blog-tone').value }) });
    if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error ?? `TOMLIN answered ${res.status}.`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (\w+)/m.exec(block)?.[1];
        const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? '{}');
        if (ev === 'text') out.textContent = data.text;
        else if (ev === 'error' || ev === 'refused') throw new Error(data.text);
        else if (ev === 'done') {
          out.hidden = true;
          $('#blog-title').value = data.title;
          $('#blog-body').value = data.body;
          // A new post: its first Save picks a new file name.
          blog.path = '';
          $('#blog-saved').hidden = true;
          $('#blog-edit').hidden = false;
          $('#blog-count').textContent = `${stopped ? 'Stopped: here is what was written so far. ' : ''}${data.words} words, written in ${Math.round((performance.now() - t0) / 1000)} s. Edit anything, then save it.`;
        }
      }
    }
  } catch (err) {
    out.hidden = true;
    blogFault(err.message);
  } finally {
    go.disabled = false;
    $('#blog-stop').hidden = true;
  }
});

$('#blog-save').addEventListener('click', async () => {
  blogFault(null);
  try {
    const again = blog.path;
    const r = await api('/api/blog/save', { title: $('#blog-title').value, body: $('#blog-body').value, path: again });
    blog.path = r.path;
    $('#blog-saved').hidden = false;
    $('#blog-saved-line').textContent = again === r.path ? `Saved again over ${r.path} (the version before is kept as ${r.path}.bak).` : `Saved as ${r.path} in your workspace.`;
    $('#blog-pic-result').replaceChildren();
    await loadFiles();
  } catch (err) {
    blogFault(err.message);
  }
});

// The picture: the chat model writes its prompt from the post, and the Send to card shows it before anything is drawn
// (change it, copy it, or send it to an artist). Drawn here by an artist on this PC (or none), it is added to the post.
$('#blog-pic').addEventListener('click', async () => {
  blogFault(null);
  const btn = $('#blog-pic');
  btn.disabled = true;
  const result = $('#blog-pic-result');
  result.replaceChildren(el('span', { class: 'hint', text: 'Writing a picture prompt from the post…' }));
  try {
    const r = await api('/api/blog/prompt', { path: blog.path });
    result.replaceChildren();
    await app.openSend({ text: r.prompt, who: r.as, blog: { path: blog.path }, from: { label: 'the blog writer' } });
  } catch (err) {
    result.replaceChildren();
    blogFault(err.message);
  } finally {
    btn.disabled = false;
  }
});

/** Draws the post's picture from the prompt sent from the card, as that artist ('' = nobody), and adds it to the post. */
app.blogDraw = async (prompt, as) => {
  blogFault(null);
  const btn = $('#blog-pic');
  btn.disabled = true;
  const result = $('#blog-pic-result');
  const say = text => result.replaceChildren(el('span', { class: 'hint', text }));
  try {
    // Their picture model loads first when it is not the one loaded (the card said so before Send was pressed).
    const p = chatUi.people.find(x => x.who === as);
    const v = app.status?.panes.image;
    const theirs = as ? (await api('/api/staff')).staff.find(s => `staff:${s.id}` === as)?.model : null;
    if (p && theirs && !(v?.state === 'connected' && v.model === theirs)) await app.wakeAndWait(as, say);
    say('Drawing it. On a CPU this takes a few minutes; the top bar shows how far it is (Picture …%).');
    // The chat on screen gets the picture, named ('' = none): not whichever chat another window opened last.
    const r = await api('/api/blog/picture', { path: blog.path, prompt, as: as ?? '', chat: app.chatId ?? '' });
    result.replaceChildren(el('img', { class: 'team-pic', src: `/api/files/picture?path=${encodeURIComponent(r.picture)}&t=${Date.now()}`, alt: r.prompt }), el('p', { class: 'hint', text: `Added to the post as ${r.picture.split('/').pop()}. Picture prompt: ${r.prompt}` }));
    await loadFiles();
  } catch (err) {
    result.replaceChildren();
    blogFault(err.message);
  } finally {
    btn.disabled = false;
  }
};

$('#files-open').addEventListener('click', async () => {
  fileFault(null);
  // The blog writer's own tone, starting from the chat's.
  const tones = app.models?.tones ?? [];
  if (!$('#blog-tone').options.length) {
    $('#blog-tone').replaceChildren(...tones.map(t => el('option', { value: t.id, text: t.name })));
    $('#blog-tone').value = app.models?.settings?.tone ?? tones[0]?.id ?? '';
  }
  try {
    await loadFiles();
  } catch (e) {
    fileFault(e.message);
  }
  if (!filesDlg.open) filesDlg.showModal();
});
