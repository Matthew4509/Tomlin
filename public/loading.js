// The loading screen: while the open chat's model loads, the chat area says which model, what it is doing (reading
// from the drive, sending to a lending PC, placing it on the card), how far it has got and how long it should take.
// The figures come from the server (src/loadeta.ts, in /api/status): the estimate is the model's size over this PC's
// measured drive speed, plus the bytes sent to lending PCs at the link's speed, plus 2%; it corrects itself as the
// bytes are read from the drive. Its look is in style.css (the page allows no styles from scripts). A big model on a
// hard disk takes minutes: this says so, so nobody gives up on it.
(() => {
  const log = document.getElementById('chat-log');
  if (!log) return;

  const box = document.createElement('div');
  box.className = 'load-screen big';
  box.id = 'load-screen';
  box.setAttribute('role', 'status');
  box.hidden = true;
  box.innerHTML = `
    <h3 class="ls-name"></h3>
    <div class="ls-doing"></div>
    <div class="ls-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100"><div class="ls-fill"></div></div>
    <div class="ls-time"></div>
    <div class="ls-left"></div>
    <div class="ls-how"></div>
    <div class="ls-why"></div>
    <div class="ls-row"><button class="btn quiet" type="button" data-ls-small>Show the chat</button></div>`;
  log.before(box);
  const part = c => box.querySelector(c);
  /** The person chose to see the chat while it loads: the screen shrinks to a bar above it, for this load. */
  let smallFor = null;
  part('[data-ls-small]').addEventListener('click', () => {
    smallFor = smallFor ? null : app.status?.panes.chat.loadStartedAt ?? null;
    draw(app.status);
  });

  const time = s => {
    s = Math.max(0, Math.round(s));
    if (s < 60) return `${s} s`;
    if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
    return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
  };
  const size = n => `${(n / 2 ** 30).toFixed(n >= 10 * 2 ** 30 ? 0 : 1)} GB`;
  const speed = n => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB/s` : `${Math.round(n / 1e6)} MB/s`);
  const names = n => (n.length <= 1 ? n.map(x => `"${x}"`).join('') : `${n.slice(0, -1).map(x => `"${x}"`).join(', ')} and "${n[n.length - 1]}"`);
  const driveText = l => (l.kind === 'hdd' ? `${l.drive} (a hard disk)` : l.kind === 'ssd' ? `${l.drive} (an SSD)` : l.drive);

  function draw(s) {
    const v = s?.panes?.chat;
    const on = v?.state === 'loading';
    if (!on) {
      if (!box.hidden) {
        box.hidden = true;
        log.hidden = false;
      }
      smallFor = null;
      return;
    }
    const l = v.load;
    const small = smallFor !== null && smallFor === v.loadStartedAt;
    box.hidden = false;
    box.classList.toggle('big', !small);
    box.classList.toggle('small', small);
    log.hidden = !small;
    part('[data-ls-small]').textContent = small ? 'Show the loading screen' : 'Show the chat';
    part('.ls-name').textContent = `Loading ${v.modelName ?? 'the chat model'}`;
    const spent = v.loadStartedAt ? (Date.now() - v.loadStartedAt) / 1000 : 0;
    if (!l) {
      // A load without figures (started another way): the runner's own words and the time so far.
      part('.ls-doing').textContent = v.stage ?? 'Starting the runner';
      part('.ls-fill').style.width = `${Math.round(Math.min(0.95, spent / Math.max(1, v.expectedSeconds || 1)) * 100)}%`;
      part('.ls-time').textContent = v.expectedSeconds ? `Estimated time to load: ${time(v.expectedSeconds)}` : '';
      part('.ls-left').textContent = `${time(spent)} so far`;
      part('.ls-how').textContent = '';
      part('.ls-why').textContent = '';
      return;
    }
    part('.ls-doing').textContent = `${l.doing}…`;
    const pct = Math.round(l.done * 100);
    part('.ls-fill').style.width = `${pct}%`;
    part('.ls-bar').setAttribute('aria-valuenow', String(pct));
    part('.ls-time').textContent = `Estimated time to load: ${time(l.totalSeconds)}`;
    part('.ls-left').textContent = l.late
      ? `${time(l.spentSeconds)} so far: longer than estimated. It is still working; a busy or slow drive takes longer.`
      : `About ${time(l.leftSeconds)} left · ${time(l.spentSeconds)} so far · ${pct}% done${l.basis === 'time' ? ' (by the clock: nothing read from the drive yet)' : ''}`;
    const how = [
      l.lenders.length ? `${size(l.lentBytes)} sent first to ${names(l.lenders)} at ${speed(l.net)} (${l.netFrom === 'measured' ? 'measured on earlier loads' : 'a gigabit network; measured after this load'})` : '',
      `${size(l.bytes - l.lentBytes)}${l.lenders.length ? " of this PC's own part" : ''} read from ${driveText(l)} at ${speed(l.read)} (${l.readFrom === 'measured' ? 'measured on earlier loads' : 'usual for this kind of drive; measured after this load'})`,
      l.rate ? `going at ${speed(l.rate)} now` : '',
    ].filter(Boolean);
    part('.ls-how').textContent = `${how.join('; ')}. The estimate has 2% added.`;
    part('.ls-why').textContent = l.kind === 'hdd'
      ? 'A model is read whole before it can answer, and a hard disk reads several times slower than an SSD. Leave TOMLIN open: it is working.'
      : 'A model is read whole before it can answer, so a big one takes a while. Leave TOMLIN open: it is working.';
  }

  app.onStatus.push(draw);
})();
