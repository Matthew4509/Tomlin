// Profile photos, one per person (/api/faces, src/faces.ts): TOMLIN, each hire and you.
// "Set as profile photo" asks whose it is; the chat list, the chat head, "+ New chat", the staff rows and the chat
// lines show each person's own photo, or their initials. Uses app.js's helpers (el, api, store) and chats.js's chatUi.
'use strict';

const faceUi = { faces: {}, looks: {}, pcs: {}, people: [], picture: null, button: null };

async function loadFaces() {
  try {
    const d = await api('/api/faces');
    faceUi.faces = d.faces;
    faceUi.looks = d.looks ?? {};
    faceUi.people = d.people;
    app.look?.setOptions(d.lookOptions);
    // Each PC's name, make and model and photo, as given in its window (src/pcprofile.ts).
    faceUi.pcs = (await api('/api/pc/profiles')).profiles ?? {};
  } catch {
    // The top bar says when the server is not answering; the photos stay as they were.
  }
  drawFaces();
}
app.loadFaces = loadFaces;
app.faceOf = who => faceUi.faces[who] ?? null;
/** A hire's saved look (src/look.ts), or null: drawn as their picture when they have no photo (public/look.js). */
app.lookOf = who => faceUi.looks[who] ?? null;
/** A PC's details by key ('here' = this PC, else its link id): { name, model, photo } or null. */
app.pcProfileOf = key => faceUi.pcs[key] ?? null;
/** Their picture's address: the photo when there is one, else their drawn look, else null (initials). A PC (pc:mine,
 * pc:<id>): its photo, else null ('PC'). */
const pictureOf = who => {
  if (who.startsWith('pc:')) return app.pcProfileOf(who === 'pc:mine' ? 'here' : who.slice(3))?.photo ?? null;
  return app.faceOf(who)?.url ?? (app.lookOf(who) && app.look?.ready() ? app.look.picture(app.lookOf(who)) : null);
};

/** A round avatar: the person's own photo, else their drawn look, else their initials. `extra` (a state dot) goes inside. */
app.avatar = (who, initials, ...extra) => {
  const src = pictureOf(who);
  return el('span', { class: `rail-avatar${src ? ' has-face' : ''}`, 'aria-hidden': 'true' }, src ? el('img', { class: 'face-img', src, alt: '' }) : initials, ...extra);
};

/** Who the open chat is with ("manager" or "staff:<id>"). */
const chatWho = () => chatUi.open?.who ?? kindOf(app.models?.settings?.who ?? 'standard');
const personOf = who => faceUi.people.find(p => p.who === who) ?? chatUi.people.find(p => p.who === who);

function drawFaces() {
  app.drawChats?.();
  if (typeof drawRail === 'function') drawRail();
  if ($('#new-chat').open) drawPeople();
  drawChatFaces();
}
app.drawFaces = drawFaces;

/** The chat pane: the photo left of the model list is the open chat's person; the chat lines show both faces. */
function drawChatFaces() {
  const who = chatWho();
  const person = personOf(who);
  const name = person?.name ?? 'This person';
  const face = app.faceOf(who);
  // No photo: their drawn look (Staff > Edit Staff > Look), when they have one.
  const drawn = face ? null : pictureOf(who);
  const avatar = $('#chat-avatar');
  const img = $('.avatar-img', avatar);
  avatar.classList.toggle('has-photo', !!(face || drawn));
  img.hidden = !(face || drawn);
  if (face) {
    img.src = face.url;
    avatar.title = `${name}'s profile photo: ${face.prompt}. To change it, open a picture and press "Set as profile photo".`;
    avatar.setAttribute('aria-label', `${name}'s profile photo`);
  } else if (drawn) {
    img.src = drawn;
    avatar.title = `${name}'s look, from Staff: Edit Staff, Look. A profile photo takes its place once set: open a picture and press "Set as profile photo".`;
    avatar.setAttribute('aria-label', `${name}'s look`);
  } else {
    img.removeAttribute('src');
    avatar.title = `${name} has no profile photo yet. Open a picture and press "Set as profile photo".`;
    avatar.setAttribute('aria-label', `${name}: no profile photo yet`);
  }
  $('#avatar-line').hidden = !face;
  $('#avatar-line-name').textContent = `${name}'s profile photo is set.`;
  const log = $('#chat-log');
  const me = app.faceOf('me');
  log.classList.toggle('face-them', !!(face || drawn));
  log.classList.toggle('face-me', !!me);
  if (face || drawn) log.style.setProperty('--face-them', `url("${face?.url ?? drawn}")`);
  else log.style.removeProperty('--face-them');
  if (me) log.style.setProperty('--face-me', `url("${me.url}")`);
  else log.style.removeProperty('--face-me');
}
app.drawAvatar = drawChatFaces;

$('#avatar-remove').addEventListener('click', async () => {
  try {
    const d = await api('/api/faces', { who: chatWho(), picture: null });
    faceUi.faces = d.faces;
    drawFaces();
  } catch (e) {
    app.chatNote?.(e.message);
  }
});

// ---- "Set as profile photo": whose? ----

const facePick = $('#face-pick');

/** Opens the "whose photo?" list for picture `p` (from the Images pane); `button` says what happened afterwards. */
app.pickFace = (p, button) => {
  faceUi.picture = p;
  faceUi.button = button ?? null;
  $('#face-pick-img').src = `/api/images/file/${p.output.split('/').map(encodeURIComponent).join('/')}`;
  $('#face-pick-fault').hidden = true;
  const open = chatWho();
  // The open chat's person first, then you, then everyone else.
  const order = [...faceUi.people].sort((a, b) => (b.who === open) - (a.who === open) || (b.who === 'me') - (a.who === 'me'));
  $('#face-pick-people').replaceChildren(...order.map(person => {
    const has = app.faceOf(person.who);
    const sub = [person.who === open ? 'In this chat' : '', person.role, has ? 'has a photo: this replaces it' : ''].filter(Boolean).join(' · ');
    const b = el('button', { class: 'pick-row', type: 'button', 'data-key': `face:${person.who}` },
      app.avatar(person.who, person.avatar),
      el('span', { class: 'rail-text' },
        el('span', { class: 'rail-name', text: person.name }),
        el('span', { class: 'rail-sub', text: sub })));
    b.addEventListener('click', () => setFace(person, b));
    return el('li', {}, b);
  }));
  facePick.showModal();
  $('#face-pick-people .pick-row')?.focus();
};

async function setFace(person, b) {
  const fault = $('#face-pick-fault');
  fault.hidden = true;
  b.disabled = true;
  try {
    const d = await api('/api/faces', { who: person.who, picture: faceUi.picture.id });
    faceUi.faces = d.faces;
    faceUi.people = d.people;
    facePick.close();
    if (faceUi.button) faceUi.button.textContent = person.who === 'me' ? 'Your photo is set' : `${person.name}'s photo is set`;
    drawFaces();
  } catch (e) {
    fault.textContent = e.message;
    fault.hidden = false;
  } finally {
    b.disabled = false;
  }
}

// Before 2.0.18 one photo was kept in this browser and shown for everyone. It moves in once, as TOMLIN's
// (where it was shown), unless TOMLIN already has one; the browser's copy is then forgotten.
async function moveOldPhoto() {
  let old = null;
  try { old = JSON.parse(store('profile-photo') || 'null'); } catch { old = null; }
  if (!old?.url) return;
  const m = /^\/api\/images\/file\/(.+)$/.exec(old.url);
  try {
    if (m && !app.faceOf('manager')) {
      const d = await api('/api/faces', { who: 'manager', file: m[1].split('/').map(decodeURIComponent).join('/') });
      faceUi.faces = d.faces;
      app.chatNote?.('Your profile photo from before is now TOMLIN\'s. Each person can now have their own: open a picture and press "Set as profile photo".');
    }
  } catch {
    // The picture is gone: nothing to move.
  }
  store('profile-photo', 'null');
  drawFaces();
}

loadFaces().then(moveOldPhoto);
