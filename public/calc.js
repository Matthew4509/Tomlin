// "What can this PC run?": pick or type a PC, see which models fit and how fast they go (src/calc.ts works it out).
const calcUi = { view: null, busy: false, timer: 0 };
const CALC_PRESETS = {
  old: { ram: 8, card: 'builtin', vram: 0, cores: 2 },
  laptop: { ram: 16, card: 'builtin', vram: 0, cores: 2 },
  desktop: { ram: 32, card: 'none', vram: 0, cores: 4 },
};

async function openCalc() {
  const dlg = $('#calc');
  $('#calc-fault').hidden = true;
  if (!dlg.open) dlg.showModal();
  try {
    calcUi.view = await api('/api/calc');
  } catch (error) {
    return calcFault(error.message);
  }
  const v = calcUi.view;
  $('#calc-post-head').textContent = `${v.postWords}-word post`;
  const card = $('#calc-card');
  card.replaceChildren(
    el('option', { value: 'none', text: 'None' }),
    el('option', { value: 'builtin', text: 'Built into the processor' }),
    ...v.cards.map(c => el('option', { value: `card:${c.id}`, text: c.name })),
    el('option', { value: 'nvidia', text: 'Other NVIDIA card' }),
    el('option', { value: 'amd', text: 'Other AMD card' }));
  $('#calc-preset').value = 'this';
  fillCalc('this');
  testLine();
}

function calcFault(text) {
  $('#calc-fault').textContent = text;
  $('#calc-fault').hidden = false;
}

/** Puts a PC's numbers in the boxes: this PC from its hardware, the others from the presets. */
function fillCalc(which) {
  const v = calcUi.view;
  let hw;
  if (which === 'this') {
    const t = v.thisPc;
    const known = v.cards.find(c => c.card === t.card && Math.abs(c.vram - t.vram) < 0.5 * GB && t.vram > 0);
    hw = { ram: Math.round(t.ram / GB), card: known ? `card:${known.id}` : t.card, vram: Math.round(t.vram / GB), cores: t.cores };
  } else if (CALC_PRESETS[which]) hw = CALC_PRESETS[which];
  else return drawCalc();
  $('#calc-ram').value = hw.ram;
  $('#calc-card').value = hw.card;
  $('#calc-vram').value = hw.vram;
  $('#calc-cores').value = hw.cores;
  drawCalc();
}

/** What the boxes say, as the server reads it. */
function calcInput() {
  const pick = $('#calc-card').value;
  const known = pick.startsWith('card:') ? calcUi.view.cards.find(c => `card:${c.id}` === pick) : null;
  if (known) $('#calc-vram').value = Math.round(known.vram / GB);
  const card = known ? known.card : pick;
  $('#calc-vram-row').hidden = !(card === 'nvidia' || card === 'amd');
  return {
    ramGB: Number($('#calc-ram').value), vramGB: Number($('#calc-vram').value), card, cores: Number($('#calc-cores').value),
    cardSpeed: known?.speed, thisPc: $('#calc-preset').value === 'this',
  };
}

const WHERE = { card: 'on the graphics card', cpu: 'on the CPU', split: 'card + CPU', builtin: 'on the built-in chip' };
const FITS = { ok: 'Fits', tight: 'Tight', no: 'Too big' };

async function drawCalc() {
  let r;
  try {
    r = await api('/api/calc', calcInput());
  } catch (error) {
    return calcFault(error.message);
  }
  $('#calc-fault').hidden = true;
  const rows = r.chat.map(x => el('tr', { class: `calc-${x.level}` },
    el('th', { scope: 'row' }, el('span', { text: x.name }), x.here ? el('span', { class: 'mp-tag', text: 'on this PC' }) : null,
      el('span', { class: 'hint calc-size', text: ` ${gb(x.bytes)}` })),
    el('td', { 'data-label': 'Fits' }, el('span', { class: `calc-fit fit-${x.level}`, text: FITS[x.level] }), x.level === 'no' ? null : el('span', { class: 'hint', text: ` ${WHERE[x.where]}` })),
    el('td', { 'data-label': 'Words a second' }, x.perSecond ? `${words(x.perSecond.mid)} (${words(x.perSecond.low)}-${words(x.perSecond.high)})` : '–',
      x.measured ? el('span', { class: 'hint calc-measured', text: `Measured: ${words(x.measured.perSecond)} words a second on ${x.measured.on}` }) : null),
    el('td', { 'data-label': $('#calc-post-head').textContent }, x.postText ?? '–')));
  const p = r.picture;
  rows.push(el('tr', { class: `calc-${p.level} calc-pic` },
    el('th', { scope: 'row', text: 'Picture: ' + p.name }),
    el('td', { 'data-label': 'Fits' }, el('span', { class: `calc-fit fit-${p.level}`, text: FITS[p.level] }), p.level === 'no' ? null : el('span', { class: 'hint', text: ` ${WHERE[p.where]}` })),
    el('td', { 'data-label': 'Time' }, p.text ? `${p.text} a picture` : '–', el('span', { class: 'hint calc-measured', text: p.note })),
    el('td', { 'data-label': '' }, '')));
  $('#calc-rows').replaceChildren(...rows);
  const tested = $('#calc-preset').value === 'this' && calcUi.view.tested;
  $('#calc-basis').textContent = tested
    ? `Speeds use this PC's test (${calcUi.view.tested.perSecond} tokens a second on ${calcUi.view.tested.model}). A word is about 1.3 tokens.`
    : 'Estimates: about memory speed ÷ model size, checked against the measured figures. A word is about 1.3 tokens.';
}

/** Tokens a second as words a second (a word is about 1.3 tokens), rounded to read at a glance. */
function words(tokens) {
  const w = tokens * 0.75;
  return w >= 10 ? String(Math.round(w)) : w.toFixed(1);
}

function testLine() {
  const t = calcUi.view?.tested;
  // The test measures the CPU: said before the press, not only after a refusal.
  const v = app.status?.panes.chat;
  const how = v?.state !== 'connected' ? ' To test: connect a small chat model with Run on: CPU (gear), then press Test this PC.'
    : v.device && v.device !== 'cpu' ? ' The test measures the CPU, and the connected model runs on the graphics card: connect one with Run on: CPU (gear) to test. A model\'s speed on the card is measured by Test speed under Staff, Edit Staff.'
    : '';
  $('#calc-test-line').textContent = `${t ? `Tested ${new Date(t.at).toLocaleDateString()}: ${t.perSecond} tokens a second on ${t.model}.` : 'Not tested yet: speeds are estimates.'}${how}`;
}

$('#calc-test').addEventListener('click', async () => {
  if (calcUi.busy) return;
  calcUi.busy = true;
  const b = $('#calc-test');
  b.disabled = true;
  $('#calc-test-line').textContent = 'Testing on the connected model…';
  try {
    const t = await api('/api/calc/test', {});
    calcUi.view.tested = t;
    $('#calc-preset').value = 'this';
    fillCalc('this');
    testLine();
  } catch (error) {
    testLine();
    calcFault(error.message);
  } finally {
    calcUi.busy = false;
    b.disabled = false;
  }
});

$('#calc-preset').addEventListener('change', e => fillCalc(e.target.value));
// Typing a number makes it "Other"; the table follows a moment after the last key.
$('#calc-hw').addEventListener('input', e => {
  if (e.target.id !== 'calc-preset') $('#calc-preset').value = 'custom';
  clearTimeout(calcUi.timer);
  calcUi.timer = setTimeout(drawCalc, 250);
});
$('#calc-hw').addEventListener('submit', e => e.preventDefault());
document.addEventListener('click', e => {
  if (!e.target.closest?.('[data-calc]')) return;
  $('#help')?.open && $('#help').close();
  openCalc();
});
app.openCalc = openCalc;
