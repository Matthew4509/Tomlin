// Staff overview's office: the staff drawn as little people (public/look.js) in an office seen from above, where they
// are and what they do read from Home's staff list every few seconds (src/home.ts doingOf, sent by src/server/team.ts).
// Desks are the PCs: My PC first, then each linked PC. Typing, researching, drawing and a project step sit at their PC's
// desk; a long think goes to the boardroom once it has a table; waiting for the PC stands in line beside its desk;
// resting is the kitchen or the lounge (what is bought for it), a long rest a deck chair on the beach (once bought); a PC
// that is off sends its staff out of the front door, on holiday on a towel at the beach. The boardroom and the lounge
// start empty: the shop (the tokens the staff write) buys each piece (src/home.ts SHOP, roomsOf). A tile at the top of
// Staff overview (Home's right panel and the chat's) follows the person picked; Watch opens it full screen (Esc
// closes). Drag a person onto another desk (or one from the left panel onto a desk) to move them: the same Move window
// as the left panel's, then they carry their box over. Frames are drawn only while the office is on screen. Uses app.js's el; adds only app.office.
'use strict';

(() => {
  const W = 1200;
  /** The building is the top 800; outside the front door, the path and the beach. */
  const H = 940;
  const COLS = 60;
  const ROWS = 40;
  const INK = '#27364e';
  const PALETTE = ['#69bfe9', '#b29be4', '#78c6a3', '#ef8a91', '#efbd72', '#74a7d0'];
  const ROOMS = [
    { name: 'Computer room', x: 20, y: 20, w: 540, h: 340, fill: '#e8eff2' },
    { name: 'Boardroom', x: 640, y: 20, w: 540, h: 340, fill: '#e9e7f1' },
    { name: 'Kitchen', x: 20, y: 440, w: 540, h: 340, fill: '#f3e9dc' },
    { name: 'Lounge and library', x: 640, y: 440, w: 540, h: 340, fill: '#e0ece7' },
  ];
  /** The employee of the month's frame on the lounge wall. */
  const FRAME = { x: 815, y: 452, w: 80, h: 84 };
  /** Places round the kitchen table for a pizza. */
  const PIZZA = [[250, 588, 'south'], [295, 588, 'south'], [340, 588, 'south'], [250, 668, 'north'], [295, 668, 'north'], [340, 668, 'north'], [205, 625, 'east'], [405, 625, 'west']];
  /** How long a pizza (or the donuts) lasts on the table (seconds). */
  const PIZZA_SECONDS = 45;
  /** What can come to the kitchen table: pizza (free) and donuts (from the shop), with their words. */
  const FOOD = {
    pizza: { courier: 'Pizza delivery', called: 'Pizza delivery!', cheer: ['Pizza!', 'Yum!', 'Thanks, boss!'], going: 'Off to the kitchen: pizza!', having: 'Having pizza in the kitchen', holding: 'a slice of pizza' },
    donuts: { courier: 'Donut delivery', called: 'Donuts!', cheer: ['Donuts!', 'Sprinkles!', 'Thanks, boss!'], going: 'Off to the kitchen: donuts!', having: 'Having a donut in the kitchen', holding: 'a donut' },
  };
  /** How long a delivered coffee is held (seconds). */
  const COFFEE_HELD = 120;
  /** The gym in the lounge once bought: a treadmill and a weights bench, and the spots in front of them. */
  const GYM = [{ x: 778, y: 566, w: 70, h: 36 }, { x: 872, y: 566, w: 64, h: 36 }];
  /** What is always there to walk round (the frame and the kitchen), and the pieces bought for the boardroom and lounge. */
  const FIXED = [FRAME, { x: 80, y: 475, w: 180, h: 43 }, { x: 465, y: 480, w: 60, h: 65 }, { x: 230, y: 600, w: 150, h: 45 }];
  const PIECES = { table: { x: 760, y: 145, w: 290, h: 100 }, bookcase: { x: 680, y: 475, w: 110, h: 35 }, tv: { x: 950, y: 485, w: 160, h: 50 }, sofa: { x: 920, y: 720, w: 200, h: 32 } };
  /** Round the boardroom table; a pair of chairs bought is one seat each side (0 and 3, then 1 and 4, then 2 and 5). */
  const MEETING = [[790, 110, 'south'], [890, 110, 'south'], [990, 110, 'south'], [790, 285, 'north'], [890, 285, 'north'], [990, 285, 'north']];
  /** Where staff whose PC's owner is using it wait while the lounge is empty. */
  const WINDOW = { id: 'window', x: 1135, y: 606, face: 'east', area: 'lounge', words: 'looking out of the lounge window' };
  /** Where resting happens, and the words for it (the lounge's only once its piece is bought: src/home.ts roomsOf). */
  const REST = [
    { id: 'coffee', x: 170, y: 548, face: 'north', area: 'kitchen', words: 'having a coffee' },
    { id: 'vending', x: 495, y: 572, face: 'north', area: 'kitchen', words: 'at the vending machine' },
    { id: 'lunch', x: 305, y: 668, face: 'north', area: 'kitchen', words: 'having lunch' },
    { id: 'tv', x: 1015, y: 690, face: 'north', area: 'lounge', words: 'watching TV' },
    { id: 'library', x: 735, y: 560, face: 'north', area: 'lounge', words: 'reading in the library' },
    { id: 'chat', x: 860, y: 640, face: 'west', area: 'lounge', words: 'chatting in the lounge' },
    { id: 'nap', x: 712, y: 700, face: 'north', area: 'lounge', words: 'having a nap in the armchair' },
    { id: 'treadmill', x: 813, y: 618, face: 'north', area: 'lounge', words: 'running on the treadmill', gym: true },
    { id: 'weights', x: 904, y: 618, face: 'north', area: 'lounge', words: 'lifting weights', gym: true },
  ];
  const DOOR = [600, 768];
  /** Just outside the front door, on the path. */
  const STEP_OUT = [600, 805];
  /** Where someone leaving the team walks off, along the path. */
  const GONE = [-60, 805];
  /** Towels on the sand, left of the front door: where the staff of a PC that is off lie in the sun. */
  const BEACH = [70, 160, 250, 340, 430, 520].map((x, i) => [x, 868 + (i % 2) * 10]);
  /** The deck chairs bought (each under its umbrella), right of the front door: where a break is taken. Bought in this
   * order, so the first three stand well apart. */
  const DECK = [800, 940, 1080, 870, 1010, 1150].map(x => [x, 866]);
  /** Seconds with nothing to do before a break in a deck chair (after the lounge stage). */
  const BREAK_IDLE = 600;
  const outdoors = (x, y) => y > 785;
  const MAX_DESKS = 12;
  /** Seconds: thinking this long goes to the boardroom; idle this long stands up; idle this long leaves the room. */
  const THINK_AWAY = 15;
  const SIT_IDLE = 120;
  const LEAVE_IDLE = 300;
  /** Where people stand up and stretch: the free strip along the computer room's right-hand wall. */
  const STRETCH = [[522, 70], [522, 130], [522, 190], [522, 250], [522, 310]];
  const clock = () => performance.now() / 1000;
  const WALK = 95;
  /** Walking to work: quicker. */
  const HURRY = 160;

  /** Every office starts empty: what is bought comes from the server (GET /api/office `rooms`). */
  const EMPTY = { boardroom: { table: false, chairs: 0, whiteboard: false }, lounge: { armchair: false, bookcase: false, sofa: false, tv: false, gym: false }, rest: ['coffee', 'vending', 'lunch'], away: ['window'], deckchairs: 0 };
  const world = { desks: [], people: new Map(), staff: [], time: 0, selected: null, follow: null, seenAt: 0, first: true, grid: [], layout: '', pizzaUntil: 0, pizzaOn: false, food: 'pizza', rooms: EMPTY, roomsKey: '', purse: null, shop: [], awards: [], weekBoard: [], monthName: '', monthKey: '', behind: null, installing: new Set(), ghosts: [], blocks: FIXED };
  /** The pieces in the way now: the fixed ones and whatever is bought (kept in world.blocks: walkable runs often). */
  const blocksOf = () => [...FIXED, ...Object.entries(PIECES).filter(([k]) => k === 'table' ? world.rooms.boardroom.table : world.rooms.lounge[k]).map(([, b]) => b), ...(world.rooms.lounge.gym ? GYM : [])];
  const views = [];
  let background = null;
  let ownerLook = null;

  // ---- The floor: which squares can be walked on, and the way from one place to another ----

  const deskBlock = d => ({ x: d.x - 51, y: d.y - 20, w: 102, h: 33 });
  function walkable(x, y) {
    if (x < 30 || x > 1170 || y < 30 || y > 770) return false;
    let free = (x >= 570 && x <= 630) || (y >= 370 && y <= 430);
    ROOMS.forEach((r, i) => {
      if (x > r.x + 9 && x < r.x + r.w - 9 && y > r.y + 9 && y < r.y + r.h - 9) free = true;
      // Each room's doorway onto the corridor.
      const dy = i < 2 ? 190 : 610;
      const edge = i % 2 === 0 ? r.x + r.w : r.x;
      if (Math.abs(x - edge) < 22 && Math.abs(y - dy) < 30) free = true;
    });
    const blocked = r => x >= r.x - 7 && x <= r.x + r.w + 7 && y >= r.y - 7 && y <= r.y + r.h + 7;
    return free && !world.blocks.some(blocked) && !world.desks.some(d => blocked(deskBlock(d)));
  }
  const cellX = i => (i % COLS) * 20 + 10;
  const cellY = i => Math.floor(i / COLS) * 20 + 10;
  function regrid() {
    world.grid = Array.from({ length: COLS * ROWS }, (_, i) => walkable(cellX(i), cellY(i)));
  }
  function nearest(x, y) {
    let best = -1;
    let dist = Infinity;
    for (let i = 0; i < world.grid.length; i++) {
      if (!world.grid[i]) continue;
      const d = (cellX(i) - x) ** 2 + (cellY(i) - y) ** 2;
      if (d < dist) { dist = d; best = i; }
    }
    return best;
  }
  /** The squares from (x, y) to (gx, gy), ending on the exact spot. */
  function pathTo(x, y, gx, gy) {
    const start = nearest(x, y);
    const goal = nearest(gx, gy);
    if (start < 0 || goal < 0) return [[gx, gy]];
    const prev = new Int32Array(world.grid.length).fill(-1);
    prev[start] = start;
    const queue = [start];
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q];
      if (i === goal) break;
      for (const n of [i - 1, i + 1, i - COLS, i + COLS]) {
        if (n < 0 || n >= world.grid.length || !world.grid[n] || prev[n] !== -1 || Math.abs((n % COLS) - (i % COLS)) > 1) continue;
        if (!walkable((cellX(n) + cellX(i)) / 2, (cellY(n) + cellY(i)) / 2)) continue;
        prev[n] = i;
        queue.push(n);
      }
    }
    if (prev[goal] === -1) return [[gx, gy]];
    const out = [[gx, gy]];
    for (let i = goal; i !== start; i = prev[i]) out.push([cellX(i), cellY(i)]);
    return out.reverse();
  }

  // ---- The desks (PCs) and the people (hires), from Home's lists ----

  function deskAt(i) {
    // Four rows: the bottom one's chairs stay inside the room's wall.
    return { x: 110 + (i % 3) * 160, y: 95 + Math.floor(i / 3) * 70 };
  }
  /** Where each chair is on a desk with n people at it. */
  const SEATS = { 1: [0], 2: [-24, 24], 3: [-32, 0, 32] };
  const seatsOf = n => SEATS[Math.max(1, Math.min(3, n))];

  function placeDesks(list, animate) {
    const before = new Map(world.desks.map(d => [d.key, d]));
    // PCs that answer fill the room from the top left; a PC that is off is pushed into the far corner (bottom right),
    // dusty and in cobwebs: still there to see, clearly not working.
    const on = list.filter(d => d.activity !== 'offline');
    const off = list.filter(d => d.activity === 'offline');
    const offShown = off.slice(0, 4);
    const onShown = on.slice(0, MAX_DESKS - offShown.length);
    const slots = [...onShown.map((d, i) => [d, i]), ...offShown.map((d, j) => [d, MAX_DESKS - 1 - j])];
    const desks = slots.map(([d, i]) => {
      const dead = d.activity === 'offline';
      // A chair for each hire who works at this PC (one with no model yet, or whose PC is off, has none).
      const crew = dead ? [] : world.staff.filter(s => (s.pcId ?? '') === d.key && s.doing !== 'nodesk' && s.doing !== 'off');
      return { ...deskAt(i), key: d.key, name: d.name, activity: d.activity, dead, crew: crew.map(s => s.id), seats: seatsOf(crew.length) };
    });
    const layout = JSON.stringify(desks.map(d => [d.key, d.seats.length, d.dead, d.x, d.y]));
    world.desks = desks;
    if (animate) {
      // A PC newly linked: IT carries it in and sets it up. One removed: IT comes to take it away.
      for (const d of desks) if (!before.has(d.key)) {
        world.installing.add(d.key);
        itJobs.push({ kind: 'install', key: d.key });
      }
      for (const [key, d] of before) if (!desks.some(x => x.key === key)) {
        const ghost = { key, x: d.x, y: d.y, name: d.name };
        world.ghosts.push(ghost);
        itJobs.push({ kind: 'remove', ghost });
      }
    }
    if (layout !== world.layout) {
      world.layout = layout;
      background = null;
      regrid();
      for (const p of world.people.values()) p.targetKey = '';
    }
  }
  const deskOf = key => world.desks.find(d => d.key === key) ?? null;

  /** Where someone goes for what they are doing: a spot, the way they face, and the room (for "Walking to …"). */
  /**
   * The desk is home: work of every kind is done sitting there (thinking goes to the boardroom only once it has gone on
   * for THINK_AWAY seconds). With nothing to do they stay at the desk SIT_IDLE seconds, then stand and stretch beside
   * the desks (still in the room) until LEAVE_IDLE, then go to the kitchen or the lounge.
   */
  function targetOf(p) {
    const s = p.row;
    const desk = deskOf(s.pcId ?? '');
    const now = clock();
    const idle = now - (p.idleSince ?? -Infinity);
    const longThink = s.doing === 'thinking' && now - (p.doingSince ?? now) >= THINK_AWAY;
    const table = world.rooms.boardroom.table;
    // Connected in the chat open now (their model loaded, nothing asked yet): at their PC, ready. Pressing Connect sends
    // them there (arriving while it loads); a PC its owner is using keeps them away ('owner').
    const ready = s.doing === 'resting' && s.state === 'on' && !!s.active;
    // No boardroom table yet: a long think stays at the desk.
    const atDesk = ['typing', 'working', 'drawing', 'researching', 'arriving', 'waiting'].includes(s.doing) || (s.doing === 'thinking' && (!longThink || !table)) || (s.doing === 'resting' && idle < SIT_IDLE) || ready;
    if (p.leaving) return { key: 'gone', x: GONE[0], y: GONE[1], face: 'west', area: 'gone' };
    if (s.doing === 'off') {
      const i = world.staff.filter(x => x.doing === 'off').findIndex(x => x.id === s.id);
      const [x, y] = BEACH[i % BEACH.length];
      return { key: `beach:${i}`, x: x + Math.floor(i / BEACH.length) * 30, y, face: 'south', area: 'beach' };
    }
    if (table && (longThink || (s.doing === 'thinking' && !desk))) {
      // The chairs bought are sat in first; past them, they stand at the table.
      const i = boardroomThinkers().findIndex(x => x.id === s.id);
      const seat = MEETING[seatOrder()[i]] ?? [1090, 140 + (i - MEETING.length) * 30, 'east'];
      return { key: `think:${i}`, x: seat[0], y: seat[1], face: seat[2], area: 'boardroom', chair: i < world.rooms.boardroom.chairs };
    }
    if (s.doing === 'thinking' && !desk) {
      // No desk and no boardroom: thinking on their feet, along the computer room's wall.
      const [x, y] = STRETCH[p.seed % STRETCH.length];
      return { key: `stretch:${x}:${y}`, x, y, face: 'south', area: 'stretch' };
    }
    // A long think in the boardroom: up to two with nothing to do (away from their PC, no desk, or idle long enough to
    // have left it) join in and help, one to each chair left over.
    const helper = helperIndex(p);
    if (helper >= 0) {
      const seat = MEETING[seatOrder()[boardroomThinkers().length + helper]];
      return { key: `help:${helper}`, x: seat[0], y: seat[1], face: seat[2], area: 'boardroom', helping: true, chair: true };
    }
    // Pizza on the kitchen table: everyone with nothing to do gathers round it (whoever works, works on).
    if (world.pizzaOn && ['resting', 'nodesk', 'owner'].includes(s.doing)) {
      const i = world.staff.filter(x => ['resting', 'nodesk', 'owner'].includes(x.doing)).findIndex(x => x.id === s.id);
      const [x, y, face] = PIZZA[i % PIZZA.length];
      return { key: `pizza:${i}`, x: x + Math.floor(i / PIZZA.length) * 12, y, face, area: 'kitchen', pizza: true };
    }
    if (desk && atDesk) {
      const i = Math.min(desk.crew.indexOf(s.id), desk.seats.length - 1);
      return { key: `seat:${desk.key}:${i}`, x: desk.x + desk.seats[Math.max(0, i)], y: desk.y + 35, face: 'north', area: 'desk', desk };
    }
    if (desk && s.doing === 'resting' && idle < LEAVE_IDLE) {
      // Up and stretching, along the free wall of the computer room.
      const [x, y] = STRETCH[p.seed % STRETCH.length];
      return { key: `stretch:${x}:${y}`, x, y, face: 'south', area: 'stretch', desk };
    }
    // A break: nothing to do for BREAK_IDLE seconds and a deck chair free on the beach (none bought, or all taken: the
    // kitchen or the lounge, as before).
    const brk = breakIndex(p);
    if (brk >= 0) {
      const [x, y] = DECK[brk];
      return { key: `break:${brk}`, x, y, face: 'south', area: 'break' };
    }
    // Resting, no desk: a spot in the kitchen or the lounge (what it has), a new one now and then. Away (their PC's
    // owner is using it): the lounge only, often asleep in the armchair; by its window while it is empty.
    const spots = s.doing === 'owner' ? [...REST, WINDOW].filter(r => world.rooms.away.includes(r.id)) : REST.filter(r => world.rooms.rest.includes(r.id));
    if (!p.rest || !spots.includes(p.rest) || (world.time > p.restUntil && !p.path.length)) {
      const taken = new Set([...world.people.values()].filter(o => o !== p && o.rest).map(o => o.rest.id));
      const free = spots.filter(r => !taken.has(r.id) && r.id !== p.rest?.id);
      const pick = (free.length ? free : spots)[Math.floor(Math.random() * (free.length || spots.length))];
      p.rest = pick;
      p.restUntil = world.time + 25 + Math.random() * 30;
    }
    const r = p.rest;
    return { key: `rest:${r.id}`, x: r.x + ((p.seed % 5) - 2) * 10, y: r.y + ((p.seed >> 3) % 3) * 6, face: r.face, area: r.area, rest: r };
  }

  /** Who is in the boardroom thinking now (thinking for THINK_AWAY seconds or more), in team order; nobody without a table. */
  function thinkersNow() {
    const now = clock();
    if (!world.rooms.boardroom.table) return [];
    return world.staff.filter(x => x.doing === 'thinking' && now - (world.people.get(x.id)?.doingSince ?? now) >= THINK_AWAY);
  }
  /** Who thinks in the boardroom: a long think, or any think by someone with no desk (once there is a table). */
  function boardroomThinkers() {
    const now = clock();
    if (!world.rooms.boardroom.table) return [];
    return world.staff.filter(x => x.doing === 'thinking' && (now - (world.people.get(x.id)?.doingSince ?? now) >= THINK_AWAY || !deskOf(x.pcId ?? '')));
  }
  /** The boardroom's places in the order they are taken: the chairs bought (a pair at a time), then standing room. */
  function seatOrder() {
    const pairs = world.rooms.boardroom.chairs / 2;
    const chairs = [0, 3, 1, 4, 2, 5].filter(i => i % 3 < pairs);
    return [...chairs, ...[0, 1, 2, 3, 4, 5].filter(i => !chairs.includes(i))];
  }
  /** 0 or 1: the first two free to help a long think, while chairs are left over, in team order; -1 for anyone else. */
  function helperIndex(p) {
    const thinking = boardroomThinkers().length;
    const room = Math.min(2, world.rooms.boardroom.chairs - thinking);
    if (!thinkersNow().length || room <= 0 || p.firing || p.leaving) return -1;
    const now = clock();
    const free = world.staff.filter(x => {
      const o = world.people.get(x.id);
      return o && !o.firing && (x.doing === 'owner' || x.doing === 'nodesk' || (x.doing === 'resting' && now - (o.idleSince ?? -Infinity) >= SIT_IDLE));
    });
    const i = free.findIndex(x => x.id === p.id);
    return i >= 0 && i < room ? i : -1;
  }
  /** A deck chair for p (its index), or -1: resting BREAK_IDLE seconds, in team order, while chairs last. */
  function breakIndex(p) {
    if (!world.rooms.deckchairs || p.firing || p.leaving) return -1;
    const now = clock();
    const free = world.staff.filter(x => {
      const o = world.people.get(x.id);
      // Resting at a desk of their own (no desk yet stays "No desk yet": the card says a model is needed).
      return o && !o.firing && !o.leaving && x.doing === 'resting' && !(x.state === 'on' && x.active) && now - (o.idleSince ?? -Infinity) >= BREAK_IDLE;
    });
    const i = free.findIndex(x => x.id === p.id);
    return i >= 0 && i < Math.min(world.rooms.deckchairs, DECK.length) ? i : -1;
  }
  /** On a break (in or walking to a deck chair) or on holiday (PC off): the two are never said the same way. */
  const breakOf = p => p?.target?.area === 'break';

  function retarget(p, snap = false) {
    const t = targetOf(p);
    // A rest spot is let go once they work: another person may take it.
    if (!t.rest) p.rest = null;
    if (t.key === p.targetKey && !snap) return;
    // Where they come from ("Back in from a break").
    p.from = p.target?.area ?? '';
    p.targetKey = t.key;
    p.target = t;
    if (snap) {
      [p.x, p.y] = [t.x, t.y];
      p.path = [];
      p.face = t.face;
      p.out = t.key === 'gone';
      return;
    }
    p.path = route(p.x, p.y, t.x, t.y);
  }
  /** The way from (x, y) to (tx, ty): in and out of the building only by the front door; outside, along the path. */
  function route(x, y, tx, ty) {
    const inside = !outdoors(x, y);
    const toOutside = outdoors(tx, ty);
    if (inside && toOutside) return [...pathTo(x, y, DOOR[0], DOOR[1]), STEP_OUT, [tx, STEP_OUT[1]], [tx, ty]];
    if (!inside && !toOutside) return [[x, STEP_OUT[1]], STEP_OUT, DOOR, ...pathTo(DOOR[0], DOOR[1], tx, ty)];
    if (!inside) return [[x, STEP_OUT[1]], [tx, STEP_OUT[1]], [tx, ty]];
    return pathTo(x, y, tx, ty);
  }
  /** One step along o's path at `speed`; true when the last point is reached. */
  function move(o, dt, speed) {
    const [x, y] = o.path[0];
    const dx = x - o.x;
    const dy = y - o.y;
    const d = Math.hypot(dx, dy);
    const v = speed * dt;
    o.face = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'east' : 'west') : dy > 0 ? 'south' : 'north';
    if (d > v) {
      o.x += (dx / d) * v;
      o.y += (dy / d) * v;
      return false;
    }
    o.x = x;
    o.y = y;
    o.path.shift();
    return !o.path.length;
  }

  function say(p, text, seconds = 3) {
    p.bubble = text;
    p.bubbleUntil = world.time + seconds;
  }

  /** Home's lists, every few seconds: the staff (with what each is doing) and the desks. */
  function update({ staff, desks, follow }) {
    world.staff = staff;
    const now = performance.now();
    // Shown again after a long time away: everyone is put where they are now, not walked there.
    const snap = world.first || now - world.seenAt > 4000;
    placeDesks(desks, !snap);
    const ids = new Set(staff.map(s => s.id));
    for (const s of staff) {
      let p = world.people.get(s.id);
      if (!p) {
        // A new hire comes along the path and in through the front door.
        p = { id: s.id, x: GONE[0], y: GONE[1], face: 'east', path: [], targetKey: '', seed: hash(s.id), bubble: '', bubbleUntil: 0 };
        world.people.set(s.id, p);
        if (!world.first) say(p, 'Hello!');
      }
      // Moved to another PC: they pack a box and carry it to the new desk.
      if (p.row && (p.row.pcId ?? '') !== (s.pcId ?? '') && !snap) {
        p.carry = true;
        say(p, 'Moving desks…');
      }
      // When they started doing this, and since when they have had nothing to do (from the server: it remembers a
      // short answer between two of these lists too).
      if (p.row?.doing !== s.doing) p.doingSince = clock();
      // A project step just started: a folder of work is delivered to their desk (it goes when the step ends).
      if (s.doing === 'working' && p.row && p.row.doing !== 'working' && !snap) deliveries.push({ kind: 'folder', who: s.id });
      if (s.doing !== 'working') p.folders = 0;
      p.idleSince = s.idleFor == null ? -Infinity : clock() - s.idleFor;
      p.row = s;
      p.look = (app.lookOf?.(`staff:${s.id}`)) ?? null;
      retarget(p, snap);
    }
    // Left the team: they walk out of the front door.
    for (const p of world.people.values()) if (!ids.has(p.id) && !p.leaving && !p.firing) {
      p.leaving = true;
      p.row = { ...p.row, doing: 'gone' };
      say(p, 'Goodbye!');
      retarget(p, snap);
    }
    // The open chat's person is followed when the chat changes to them.
    if (follow !== world.follow) {
      world.follow = follow;
      if (follow) world.selected = follow;
    }
    if (world.selected && !ids.has(world.selected) && world.selected !== world.firing) world.selected = null;
    world.first = false;
    wake();
  }

  function hash(s) {
    let h = 7;
    for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return h;
  }

  // ---- Time passing ----

  let lookedAt = 0;
  function step(dt) {
    world.time += dt;
    // Once a second, each person standing still checks whether time has moved them on (sat long enough, thought long
    // enough): the same rule as a new list.
    if (world.time - lookedAt > 1) {
      lookedAt = world.time;
      for (const p of world.people.values()) if (!p.path.length && !p.drag && !p.leaving && !p.firing) retarget(p);
    }
    for (const p of world.people.values()) {
      if (p.drag) continue;
      if (p.path.length) {
        // Work waiting: they hurry to the desk (or the boardroom); anywhere else, a stroll.
        if (move(p, dt, ['desk', 'boardroom'].includes(p.target?.area) && !p.firing ? HURRY : WALK)) arrived(p);
        continue;
      }
      // A rest spot is changed now and then (the target is worked out again).
      if (p.target?.rest && world.time > p.restUntil && !p.firing) retarget(p);
    }
    stepBoss(dt);
    stepCourier(dt);
    stepIt(dt);
    for (const [id, p] of world.people) if (p.leaving && p.out) world.people.delete(id);
  }

  // ---- Fired: the boss comes in by the front door, says it, waits while a box is packed, watches them out ----

  let boss = null;
  const BOSS_WORDS = { coming: 'The boss is coming over', talking: 'Being let go by the boss', packing: 'Packing a box: mug, plant, notebook', leaving: 'Leaving with a box' };
  function fire(id) {
    const p = world.people.get(id);
    if (!p || p.out || boss) return false;
    Object.assign(p, { firing: 'coming', path: [], drag: null, carry: false, leaving: false });
    say(p, 'The boss wants a word?', 5);
    const look = app.look?.ready() ? { ...app.look.fromId('the-boss', ''), gender: 'man', hair: 'short', hairColour: 'grey', top: 'charcoal', glasses: 'none', headwear: 'none' } : null;
    const tx = p.x + (p.x > 1100 ? -64 : 64);
    boss = { id: 'boss', row: { name: 'The boss', roleId: '', doing: 'boss' }, x: GONE[0], y: GONE[1], face: 'east', look, who: id, phase: 'coming', timer: 0, bubble: '', bubbleUntil: 0, seed: 3, path: route(GONE[0], GONE[1], tx, p.y + 4) };
    world.selected = id;
    world.firing = id;
    return true;
  }
  function stepBoss(dt) {
    const b = boss;
    if (!b) return;
    const p = world.people.get(b.who);
    if (b.path.length) {
      if (!move(b, dt, HURRY)) return;
    }
    if (b.phase === 'coming') {
      if (!p) return leaveBoss();
      b.phase = 'talking';
      b.timer = 3.5;
      b.face = b.x > p.x ? 'west' : 'east';
      p.face = b.x > p.x ? 'east' : 'west';
      p.firing = 'talking';
      say(b, "You're fired.", 4);
      say(p, "I'll get my things…", 4);
    } else if (b.phase === 'talking') {
      if ((b.timer -= dt) > 0) return;
      b.phase = 'packing';
      b.timer = 3;
      p.firing = 'packing';
      say(p, 'Mug, plant, notebook…', 3);
    } else if (b.phase === 'packing') {
      if ((b.timer -= dt) > 0) return;
      b.phase = 'watching';
      Object.assign(p, { firing: 'leaving', carry: true, leaving: true, targetKey: 'gone', target: { key: 'gone', area: 'gone', face: 'west' } });
      p.path = route(p.x, p.y, GONE[0], GONE[1]);
    } else if (b.phase === 'watching') {
      if (p && !p.out) return;
      leaveBoss();
    } else if (b.phase === 'leaving') {
      boss = null;
      world.firing = null;
      if (world.selected === b.who) world.selected = null;
    }
  }
  function leaveBoss() {
    boss.phase = 'leaving';
    boss.path = route(boss.x, boss.y, GONE[0], GONE[1]);
  }

  // ---- Pizza or donuts: a delivery comes in by the front door to the kitchen table; the idle gather round it ----

  let courier = null;
  /** Waiting to be delivered, in turn: {kind: 'pizza'}, {kind: 'donuts'} or {kind: 'folder', who}. */
  const deliveries = [];
  /** Food on the table, or on its way there: one at a time. */
  const tableBusy = () => world.pizzaOn || deliveries.some(d => FOOD[d.kind]) || !!FOOD[courier?.job.kind];
  function orderFood(kind) {
    if (tableBusy()) return false;
    deliveries.push({ kind });
    return true;
  }
  /** Where a delivery is handed over: the kitchen table, or beside the desk of whoever the folder is for. */
  /** Beside the next one on a coffee delivery's list who is still here (job.at moves on past anyone gone), or null. */
  function coffeeStop(job) {
    for (; job.at < job.who.length; job.at++) {
      const p = world.people.get(job.who[job.at]);
      if (p && !p.out && !p.leaving && !p.firing && p.row.doing !== 'off') return [p.x + (p.x > 1100 ? -26 : 26), p.y + 4];
    }
    return null;
  }
  function dropOf(job) {
    if (FOOD[job.kind]) return [305, 668];
    if (job.kind === 'coffee') return coffeeStop(job);
    const p = world.people.get(job.who);
    if (!p || p.out || p.leaving) return null;
    const d = deskOf(p.row.pcId ?? '');
    return d ? [d.x + 64, d.y + 10] : [p.x + 30, p.y + 8];
  }
  function startCourier() {
    while (!courier && deliveries.length) {
      const job = deliveries.shift();
      const at = dropOf(job);
      if (!at) continue;
      const food = FOOD[job.kind];
      const coffee = job.kind === 'coffee';
      const look = app.look?.ready() ? { ...app.look.fromId('courier', ''), top: food ? 'coral' : coffee ? 'mint' : 'mustard', headwear: 'cap', glasses: 'none' } : null;
      courier = { id: 'courier', row: { name: food?.courier ?? (coffee ? 'Coffee delivery' : 'Courier'), doing: 'courier' }, job, x: GONE[0], y: GONE[1], face: 'east', look, seed: 5, phase: 'coming', carry: food ? job.kind : coffee ? 'coffee' : 'folder', bubble: '', bubbleUntil: 0, path: route(GONE[0], GONE[1], at[0], at[1]) };
      say(courier, food?.called ?? (coffee ? 'Coffee delivery!' : 'Work for you!'), 3);
    }
  }
  function stepCourier(dt) {
    startCourier();
    const k = courier;
    if (k) {
      if (k.path.length && !move(k, dt, HURRY)) return;
      if (k.phase === 'coming' && k.job.kind === 'coffee') {
        // A coffee for each, wherever they are (busy or not); someone who walked off meanwhile is followed.
        const at = coffeeStop(k.job);
        if (at && Math.hypot(at[0] - k.x, at[1] - k.y) > 40) {
          k.path = route(k.x, k.y, at[0], at[1]);
          return;
        }
        const got = at ? world.people.get(k.job.who[k.job.at]) : null;
        if (got) {
          got.coffee = 'have';
          got.coffeeUntil = world.time + COFFEE_HELD;
          k.face = got.x < k.x ? 'west' : 'east';
          say(k, 'Here you go!', 2);
          say(got, ['Thanks for the coffee!', 'Flat white, perfect!', 'Just what I needed.'][got.seed % 3], 3);
          k.job.at++;
        }
        const next = coffeeStop(k.job);
        if (next) k.path = route(k.x, k.y, next[0], next[1]);
        else {
          k.phase = 'leaving';
          k.carry = null;
          k.path = route(k.x, k.y, GONE[0], GONE[1]);
        }
        return;
      }
      if (k.phase === 'coming') {
        k.phase = 'leaving';
        k.carry = null;
        k.face = 'west';
        if (FOOD[k.job.kind]) {
          world.pizzaOn = true;
          world.food = k.job.kind;
          world.pizzaUntil = world.time + PIZZA_SECONDS;
          say(k, 'Enjoy!', 2);
          for (const p of world.people.values()) if (['resting', 'nodesk', 'owner'].includes(p.row.doing) && !p.firing) say(p, FOOD[world.food].cheer[p.seed % 3], 3);
        } else {
          const p = world.people.get(k.job.who);
          if (p && p.row.doing === 'working') {
            p.folders = Math.min(5, (p.folders ?? 0) + 1);
            say(p, p.folders > 2 ? 'My desk is disappearing!' : 'Another folder? Thanks…', 3);
          }
          say(k, 'Sign here!', 2);
        }
        k.path = route(k.x, k.y, GONE[0], GONE[1]);
      } else courier = null;
    }
    if (world.pizzaOn && world.time > world.pizzaUntil) {
      world.pizzaOn = false;
      for (const p of world.people.values()) if (p.target?.pizza) p.targetKey = '';
    }
  }

  // ---- IT: a PC linked while watched is carried in and set up; one removed is packed and carried out ----

  let it = null;
  const itJobs = [];
  const IT_SECONDS = 2.6;
  function stepIt(dt) {
    while (!it && itJobs.length) {
      const job = itJobs.shift();
      const d = job.kind === 'install' ? deskOf(job.key) : job.ghost;
      if (!d) {
        world.installing.delete(job.key);
        continue;
      }
      const look = app.look?.ready() ? { ...app.look.fromId('it-person', ''), top: 'steel', headwear: 'none' } : null;
      it = { id: 'it', row: { name: 'IT', doing: 'it' }, job, x: GONE[0], y: GONE[1], face: 'east', look, seed: 7, phase: 'coming', carry: job.kind === 'install' ? 'pc' : null, timer: IT_SECONDS, bubble: '', bubbleUntil: 0, path: route(GONE[0], GONE[1], d.x + 64, d.y + 10) };
      say(it, job.kind === 'install' ? 'A new PC!' : 'Collecting a PC', 3);
    }
    const t = it;
    if (!t) return;
    if (t.path.length && !move(t, dt, HURRY)) return;
    if (t.phase === 'coming') {
      t.phase = 'working';
      t.face = 'west';
      say(t, t.job.kind === 'install' ? 'Setting it up…' : 'Packing it up…', IT_SECONDS);
    } else if (t.phase === 'working') {
      if ((t.timer -= dt) > 0) return;
      t.phase = 'leaving';
      if (t.job.kind === 'install') {
        t.carry = null;
        world.installing.delete(t.job.key);
        say(t, 'All set!', 2);
      } else {
        t.carry = 'pc';
        world.ghosts = world.ghosts.filter(g => g !== t.job.ghost);
      }
      t.path = route(t.x, t.y, GONE[0], GONE[1]);
    } else it = null;
  }

  // ---- Employee of the month (the server picks: most tokens written this month) and the weekly leaderboard ----

  function officeData(d) {
    world.purse = d.purse ?? null;
    world.shop = d.shop ?? [];
    // What is bought is part of the office: drawn in, walked round, places to sit, rest and think.
    const rooms = d.rooms ?? world.rooms;
    const key = JSON.stringify(rooms);
    if (key !== world.roomsKey) {
      world.rooms = rooms;
      world.roomsKey = key;
      world.blocks = blocksOf();
      background = null;
      regrid();
      // Everyone works out again where to be (a spot taken away by a piece, a chair to sit in now).
      for (const p of world.people.values()) if (!p.firing && !p.leaving) p.targetKey = '';
    }
    drawShop();
    world.awards = d.awards ?? [];
    world.weekBoard = d.week?.board ?? [];
    world.monthBoard = d.month?.board ?? [];
    world.monthName = d.month?.name ?? '';
    world.monthKey = d.month?.key ?? '';
    world.behind = d.month?.behind ?? null;
    for (const v of views) v.told = '';
    drawBoard();
  }
  async function loadOffice() {
    try {
      officeData(await api('/api/office'));
    } catch { /* the office draws without the frame and the board */ }
  }
  async function award(button) {
    button.disabled = true;
    try {
      const d = await api('/api/office/award', {});
      officeData(d);
      const a = d.award;
      const p = world.people.get(a.id);
      if (p) say(p, 'Employee of the month? Me?!', 6);
      for (const o of world.people.values()) if (o !== p && !o.out && !o.firing) say(o, `Congratulations, ${a.name}!`, 4);
      world.selected = a.id;
      fullSay(`${a.name} is employee of the month for ${d.month.name}: ${a.out.toLocaleString()} tokens written. The prize: a 20% off voucher (it shows in what ${a.name} is holding).`);
      wake();
    } catch (e) {
      fullSay(e.message);
    } finally {
      button.disabled = false;
    }
  }
  // ---- The frame pressed: who won, and this month's tokens by person (a pie) ----

  const monthDlg = el('dialog', { class: 'small-dlg month-dlg', 'aria-labelledby': 'month-title' });
  document.body.append(monthDlg);
  const PIE = ['#3f7fd9', '#e0a030', '#4fa77a', '#c8507a', '#7b62c9', '#3aa6b9', '#9aa5b1'];
  function openMonth() {
    const a = world.awards.at(-1);
    const when = key => {
      const [y, m] = String(key).split('-').map(Number);
      return y && m ? new Date(y, m - 1, 1).toLocaleString('en-GB', { month: 'long', year: 'numeric' }) : key;
    };
    const rows = (world.monthBoard ?? []).filter(r => r.out > 0).sort((x, y) => y.out - x.out);
    const total = rows.reduce((n, r) => n + r.out, 0);
    // Six slices at most: the rest together as "Everyone else".
    const slices = rows.length > 6 ? [...rows.slice(0, 5), { name: 'Everyone else', out: rows.slice(5).reduce((n, r) => n + r.out, 0) }] : rows;
    const pct = n => (total ? Math.round((n / total) * 100) : 0);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 120 120');
    svg.setAttribute('width', '150');
    svg.setAttribute('height', '150');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `Tokens written in ${world.monthName}, by person: ${slices.map(s => `${s.name} ${pct(s.out)}%`).join(', ')}`);
    let from = -Math.PI / 2;
    for (const [i, s] of slices.entries()) {
      const turn = (s.out / total) * Math.PI * 2;
      const to = from + turn;
      const path = document.createElementNS('http://www.w3.org/2000/svg', slices.length === 1 ? 'circle' : 'path');
      if (slices.length === 1) {
        path.setAttribute('cx', '60');
        path.setAttribute('cy', '60');
        path.setAttribute('r', '56');
      } else path.setAttribute('d', `M60 60 L${60 + 56 * Math.cos(from)} ${60 + 56 * Math.sin(from)} A56 56 0 ${turn > Math.PI ? 1 : 0} 1 ${60 + 56 * Math.cos(to)} ${60 + 56 * Math.sin(to)} Z`);
      path.setAttribute('fill', PIE[i % PIE.length]);
      path.setAttribute('stroke', 'var(--panel, #fff)');
      path.setAttribute('stroke-width', '1.5');
      svg.append(path);
      from = to;
    }
    const won = a ? el('p', {}, el('strong', { text: a.name }), ` won ${when(a.month)} with ${a.out.toLocaleString()} tokens written.`)
      : el('p', { text: 'Nobody has been made employee of the month yet. Award employee of the month (at the top of Staff overview) picks whoever wrote the most this month.' });
    monthDlg.replaceChildren(el('div', { class: 'help-body' },
      el('h2', { id: 'month-title', text: 'Employee of the month' }),
      won,
      el('h3', { text: `${world.monthName || 'This month'} so far: ${total.toLocaleString()} tokens written` }),
      total ? el('div', { class: 'month-pie' }, svg, el('ul', { class: 'month-legend' }, ...slices.map((s, i) => {
        const sw = el('span', { class: 'month-swatch', 'aria-hidden': 'true' });
        sw.style.background = PIE[i % PIE.length];
        return el('li', {}, sw, el('span', { text: s.name }), el('span', { class: 'hint', text: `${s.out.toLocaleString()} (${pct(s.out)}%)` }));
      }))) : el('p', { class: 'hint', text: 'Nobody has written anything this month yet.' }),
      el('div', { class: 'team-actions' }, el('button', { class: 'btn', type: 'button', text: 'Close', onclick: () => monthDlg.close() }))));
    monthDlg.showModal();
  }

  /** Undo award: this month's award is taken off (the server keeps one per month; the frame shows the newest left). */
  async function undoLastAward(button) {
    button.disabled = true;
    try {
      const d = await api('/api/office/award/undo', {});
      officeData(d);
      const left = world.awards.at(-1);
      fullSay(`The award to ${d.undone.name} for ${d.month.name} is undone.${left ? ` The frame shows ${left.name} again, from an earlier month.` : ' The frame is empty until the next award.'}`);
      wake();
    } catch (e) {
      fullSay(e.message);
    } finally {
      button.disabled = false;
    }
  }
  const vouchersOf = id => world.awards.filter(a => a.id === id).length;
  /** What someone has in their hands (press them to see it), as in RollerCoaster Tycoon. */
  function holding(p) {
    const items = [];
    const still = !p.path.length;
    if (p.carry) items.push('a box of belongings');
    if (p.folders) items.push(p.folders === 1 ? 'a folder of project work' : `${p.folders} folders of project work`);
    if (p.coffee === 'have' && world.time < p.coffeeUntil) items.push('a coffee (your treat)');
    if (p.target?.pizza && still) items.push(FOOD[world.food].holding);
    else if (p.target?.rest?.id === 'weights' && still) items.push('a pair of dumbbells');
    else if (p.target?.rest?.id === 'treadmill' && still) items.push('a water bottle');
    else if (p.target?.rest?.id === 'coffee' && still) items.push('a mug of coffee');
    else if (p.target?.rest?.id === 'vending' && still) items.push('a can from the vending machine');
    else if (p.target?.rest?.id === 'library' && still) items.push('a book from the library');
    else if (p.target?.rest?.id === 'tv' && still) items.push('the TV remote');
    else if (p.target?.area === 'beach' && still) items.push('a towel and sunglasses');
    else if (p.target?.area === 'break' && still) items.push('a cold drink');
    else if (p.target?.area === 'stretch' && still) items.push('a dumbbell');
    const n = vouchersOf(p.id);
    if (n) items.push(n === 1 ? 'a 20% off voucher (employee of the month)' : `${n} × 20% off voucher (employee of the month ${n} times)`);
    return items.length ? items.join(', ') : 'nothing';
  }
  function arrived(p) {
    p.face = p.target?.face ?? 'south';
    if (p.targetKey === 'gone') p.out = true;
    // The box is put down on arriving: at the new desk with a word, anywhere else (the move fell through) without.
    if (p.carry) {
      p.carry = false;
      if (p.target?.area === 'desk') say(p, 'New desk!');
    }
  }

  /** "Walking to the boardroom", or what they are doing there. */
  function wordsOf(p) {
    const s = p.row;
    const t = p.target;
    if (p.firing) return BOSS_WORDS[p.firing];
    if (t?.pizza) return p.path.length ? FOOD[world.food].going : FOOD[world.food].having;
    if (t?.helping) {
      const lead = thinkersNow()[0]?.name ?? 'someone';
      return p.path.length ? `Off to the boardroom to help ${lead} think` : `Helping ${lead} brainstorm`;
    }
    if (s.doing === 'owner' && t?.rest && !p.path.length) return `Away (their PC's owner is using it): ${t.rest.words}`;
    const thinkHere = s.doing === 'thinking' && !world.rooms.boardroom.table;
    if (p.path.length && !p.out) {
      if (t?.area === 'gone') return 'Leaving the office';
      if (t?.area === 'beach') return 'PC off: off to the beach on holiday';
      if (t?.area === 'break') return 'Off out for a break in a deck chair';
      if (outdoors(p.x, p.y)) return p.from === 'break' ? 'Back in from a break' : 'Back from holiday: their PC is on';
      if (t?.area === 'boardroom') return 'Walking to the boardroom to think';
      if (t?.area === 'stretch') return thinkHere ? 'Thinking on their feet (no boardroom table yet)' : 'Getting up to stretch their legs';
      if (t?.area === 'desk') return `Walking to ${t.desk?.name ?? 'their desk'}${p.carry ? ', carrying a box' : ''}`;
      return `Walking to the ${t?.area ?? 'kitchen'}`;
    }
    if (t?.area === 'beach') return 'PC off: on holiday, lying on a towel';
    if (t?.area === 'break') return 'On a break: in a deck chair on the beach';
    if (thinkHere && t?.area === 'stretch') return 'Thinking on their feet (no boardroom table yet)';
    if (thinkHere && t?.area === 'desk' && clock() - (p.doingSince ?? clock()) >= THINK_AWAY) return 'Thinking at the desk (no boardroom table yet)';
    if (s.doing === 'resting' && t?.area === 'desk') return 'At the desk, ready for the next message';
    if (s.doing === 'resting' && t?.area === 'stretch') return 'Stretching their legs: nothing to do for 2 minutes';
    if (s.doing === 'resting' && t?.rest) return `Resting: ${t.rest.words}`;
    return s.doingText || 'Resting';
  }

  // ---- Drawing ----

  function box(c, x, y, w, h, r, fill, stroke = INK, width = 2.5) {
    c.beginPath();
    c.roundRect(x, y, w, h, r);
    c.fillStyle = fill;
    c.fill();
    if (stroke) { c.strokeStyle = stroke; c.lineWidth = width; c.stroke(); }
  }
  function oval(c, x, y, rx, ry, fill, stroke = INK, width = 2) {
    c.beginPath();
    c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    c.fillStyle = fill;
    c.fill();
    if (stroke) { c.strokeStyle = stroke; c.lineWidth = width; c.stroke(); }
  }
  function line(c, x, y, xx, yy, col = INK, width = 3) {
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(xx, yy);
    c.strokeStyle = col;
    c.lineWidth = width;
    c.lineCap = 'round';
    c.stroke();
  }
  function text(c, s, x, y, size, col = INK, align = 'left') {
    c.font = `600 ${size}px Segoe UI, system-ui, sans-serif`;
    c.fillStyle = col;
    c.textAlign = align;
    c.fillText(s, x, y);
    c.textAlign = 'left';
  }
  function mug(c, x, y) {
    box(c, x - 5, y - 6, 10, 13, 3, '#fff9eb', INK, 2);
    oval(c, x + 7, y, 3, 4, '#fff9eb');
  }

  /** The rooms, the furniture and the desks: drawn once (and again when the desks change), then copied each frame. */
  function drawBackground() {
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const c = cv.getContext('2d');
    c.fillStyle = '#cbd6df';
    c.fillRect(0, 0, W, H);
    ROOMS.forEach((r, i) => {
      box(c, r.x, r.y, r.w, r.h, 16, r.fill);
      const xx = i % 2 === 0 ? r.x + r.w : r.x;
      const dy = i < 2 ? 190 : 610;
      c.fillStyle = r.fill;
      c.fillRect(xx - 5, dy - 25, 10, 50);
      line(c, xx, dy - 25, xx + (i % 2 === 0 ? 30 : -30), dy - 45, '#7b8b9a', 3);
    });
    // The lounge's window on its outside wall (staff wait by it while the lounge is empty).
    box(c, 1172, 566, 14, 82, 3, '#cfe8f5', INK, 2);
    line(c, 1179, 570, 1179, 644, '#fff', 1.5);
    // Outside: the path past the front door, the sand, the sea; a towel for each place on the beach, and the deck chairs
    // bought, each under its umbrella.
    c.fillStyle = '#b9c9a4';
    c.fillRect(0, 786, W, 38);
    c.fillStyle = '#d9cfb8';
    c.fillRect(0, 797, W, 16);
    c.fillStyle = '#f2dfae';
    c.fillRect(0, 824, W, 82);
    c.fillStyle = '#7fc4e0';
    c.fillRect(0, 906, W, H - 906);
    for (let x = 20; x < W; x += 70) line(c, x, 920 + (x % 140 ? 6 : 0), x + 30, 920 + (x % 140 ? 6 : 0), '#d8f0fa', 2);
    BEACH.forEach(([x, y], i) => {
      box(c, x - 34, y - 4, 68, 24, 4, PALETTE[i % PALETTE.length], INK, 1.5);
      line(c, x - 30, y + 2, x + 30, y + 2, '#fff', 1.5);
    });
    DECK.slice(0, world.rooms.deckchairs).forEach(([x, y], i) => deckChair(c, x, y, i));
    // The front door.
    box(c, 574, 750, 52, 28, 4, '#a4b8c3');
    line(c, 570, 790, 570, 762, '#667e94', 4);
    line(c, 630, 790, 630, 762, '#667e94', 4);
    // Desks: the top, a chair per person, a PC tower at the side.
    for (const d of world.desks) {
      box(c, d.x - 49, d.y - 19, 98, 36, 8, '#e8bb80');
      box(c, d.x + 38, d.y - 16, 9, 30, 2, '#5d7084', INK, 2);
      if (!d.dead) for (const off of d.seats) box(c, d.x + off - 15, d.y + 26, 30, 21, 7, '#9eb3c8');
    }
    // Boardroom (what is bought): the table, the chairs round it, the whiteboard.
    const br = world.rooms.boardroom;
    if (br.table) box(c, 760, 145, 290, 100, 22, '#e8bb80');
    for (const i of seatOrder().slice(0, br.chairs)) box(c, MEETING[i][0] - 19, MEETING[i][1] - 8, 38, 26, 8, '#a6aacb');
    if (br.whiteboard) {
      box(c, 1110, 105, 40, 160, 7, INK);
      box(c, 1116, 112, 28, 146, 3, '#fff7ed');
    }
    // Kitchen: counter with the coffee machine, the vending machine, the table, the sink.
    box(c, 80, 475, 180, 43, 9, '#e8bb80');
    box(c, 110, 480, 45, 33, 5, INK);
    box(c, 117, 487, 29, 12, 3, '#9ab6c7');
    mug(c, 132, 509);
    mug(c, 180, 501);
    box(c, 465, 480, 60, 65, 7, '#608cad');
    box(c, 472, 487, 45, 39, 3, '#d9eaf5');
    for (let i = 0; i < 6; i++) box(c, 480 + (i % 3) * 12, 493 + Math.floor(i / 3) * 15, 7, 11, 2, PALETTE[i], INK, 1.5);
    box(c, 230, 600, 150, 45, 15, '#e8bb80');
    box(c, 80, 690, 55, 40, 7, '#a4b8c3');
    oval(c, 106, 707, 17, 10, '#d5e3e8');
    // Lounge (what is bought): the bookcase, the armchair, the sofa, the TV, the gym.
    const lo = world.rooms.lounge;
    if (lo.bookcase) {
      box(c, 680, 475, 110, 35, 5, '#b78966');
      for (let i = 0; i < 11; i++) box(c, 686 + i * 9, 480, 7, 23, 1, PALETTE[i % 6], INK, 1.5);
    }
    if (lo.armchair) box(c, 683, 641, 55, 39, 12, '#a4bac9');
    if (lo.sofa) {
      box(c, 920, 720, 200, 32, 10, '#9ab4c9');
      box(c, 925, 684, 190, 40, 12, '#b8cddd');
    }
    if (lo.tv) {
      box(c, 950, 485, 160, 50, 7, INK);
      box(c, 957, 492, 146, 36, 4, '#182638');
    }
    if (lo.gym) drawGym(c);
    return cv;
  }

  /** The boardroom and the lounge while nothing is bought for them (the gym alone still leaves the lounge's seats empty). */
  function emptyRooms() {
    const b = world.rooms.boardroom;
    const l = world.rooms.lounge;
    return ROOMS.filter(r => (r.name === 'Boardroom' && !b.table && !b.chairs && !b.whiteboard) || (r.name === 'Lounge and library' && !l.armchair && !l.bookcase && !l.sofa && !l.tv && !l.gym));
  }
  /** A deck chair seen from above (striped, its back to the path) under a beach umbrella. */
  function deckChair(c, x, y, i) {
    box(c, x - 17, y - 30, 34, 50, 6, '#c98f5a', INK, 2);
    for (let k = 0; k < 4; k++) box(c, x - 13, y - 26 + k * 11, 26, 9, 2, k % 2 ? '#fff6e4' : PALETTE[i % PALETTE.length], null);
    line(c, x + 27, y + 18, x + 27, y - 20, '#7b6a55', 3);
    c.beginPath();
    c.arc(x + 27, y - 22, 19, Math.PI, 0);
    c.closePath();
    c.fillStyle = i % 2 ? '#ef8a91' : '#efbd72';
    c.fill();
    c.strokeStyle = INK;
    c.lineWidth = 2;
    c.stroke();
  }

  /** The coffee delivery's tray: a cup holder with takeaway cups. */
  function coffeeTray(c, p) {
    const dx = p.face === 'east' ? 22 : p.face === 'west' ? -22 : 0;
    const dy = p.face === 'north' ? -30 : 9;
    box(c, p.x + dx - 18, p.y + dy - 9, 36, 20, 4, '#c98f5a', INK, 2);
    for (let i = 0; i < 4; i++) {
      oval(c, p.x + dx - 12 + (i % 2) * 24, p.y + dy - 3 + Math.floor(i / 2) * 9, 5, 5, '#fff9eb', INK, 1.2);
      oval(c, p.x + dx - 12 + (i % 2) * 24, p.y + dy - 3 + Math.floor(i / 2) * 9, 2.5, 2.5, '#8a6a4c', null);
    }
  }
  /** The gym in the lounge, once bought: a treadmill, and a weights bench with its bar and plates. */
  function drawGym(c) {
    const [t, b] = GYM;
    box(c, t.x, t.y, t.w, t.h, 6, '#5d7084');
    box(c, t.x + 6, t.y + 8, t.w - 22, t.h - 16, 3, '#2f3d4f', INK, 1.5);
    for (let i = 0; i < 5; i++) line(c, t.x + 12 + i * 9, t.y + 10, t.x + 12 + i * 9, t.y + t.h - 10, '#56677b', 1.5);
    box(c, t.x + t.w - 14, t.y + 4, 10, t.h - 8, 3, '#9ab6c7', INK, 1.5);
    box(c, b.x + 10, b.y + 12, b.w - 20, 14, 5, '#ef8a91');
    line(c, b.x + 2, b.y + 6, b.x + b.w - 2, b.y + 6, '#56677b', 3);
    oval(c, b.x + 4, b.y + 6, 4, 8, INK, null);
    oval(c, b.x + b.w - 4, b.y + 6, 4, 8, INK, null);
    for (let i = 0; i < 3; i++) oval(c, b.x + 16 + i * 16, b.y + b.h - 2, 5, 3, '#56677b', INK, 1);
  }

  /** The employee of the month on the lounge wall: their portrait in a gold frame (empty until the first award). */
  function drawFrame(c, full) {
    const a = world.awards.at(-1);
    box(c, FRAME.x, FRAME.y, FRAME.w, FRAME.h, 6, '#deb967', INK, 2.5);
    box(c, FRAME.x + 7, FRAME.y + 7, FRAME.w - 14, FRAME.w - 14, 4, '#edf3fb', INK, 1.5);
    const look = a && app.look?.ready() ? app.lookOf?.(`staff:${a.id}`) ?? app.look.fromId(a.id, world.staff.find(s => s.id === a.id)?.roleId ?? '') : null;
    if (look) {
      c.save();
      c.translate(FRAME.x + 7, FRAME.y + 7);
      app.look.portrait(c, look, FRAME.w - 14, { round: false });
      c.restore();
    }
    // A small gold star under it.
    oval(c, FRAME.x + FRAME.w / 2, FRAME.y + FRAME.h - 7, 5, 5, '#f2b733', INK, 1.5);
  }

  /** Each desk's screens (what the person at it is doing), and a PC that is off or in use by its owner. */
  function drawDesks(c, full) {
    // A removed PC's desk, until IT has carried it away.
    for (const g of world.ghosts) {
      box(c, g.x - 49, g.y - 19, 98, 36, 8, 'rgba(232, 187, 128, .55)', INK, 2);
      box(c, g.x - 20, g.y - 16, 40, 19, 4, INK);
    }
    if (it?.phase === 'working') {
      const d = it.job.kind === 'install' ? deskOf(it.job.key) : it.job.ghost;
      if (d) {
        box(c, d.x - 25, d.y - 33, 50, 5, 2, '#d4dfeb', null);
        box(c, d.x - 25, d.y - 33, Math.max(1, 50 * (1 - it.timer / IT_SECONDS)), 5, 2, '#78c6a3', null);
      }
    }
    for (const d of world.desks) {
      if (world.installing.has(d.key)) {
        // Waiting for IT: an empty desk.
        continue;
      }
      const n = d.seats.length;
      const mw = n === 1 ? 40 : n === 2 ? 36 : 28;
      d.seats.forEach((off, i) => {
        const x = d.x + off;
        const who = world.people.get(d.crew[i]);
        const sat = who && !who.path.length && who.targetKey === `seat:${d.key}:${i}`;
        box(c, x - mw / 2, d.y - 16, mw, 19, 4, INK);
        drawScreen(c, x, d.y - 12, mw - 8, d.activity === 'offline' ? 'off' : d.activity === 'owner' && i === 0 ? 'owner' : sat ? who.row.doing : 'idle');
        box(c, x - mw / 2 + 3, d.y + 7, mw - 6, 7, 2, '#fff7e9', INK, 2);
        // The folders of project work delivered to whoever sits here.
        for (let j = 0; j < (who?.folders ?? 0); j++) box(c, x - mw / 2 - 16, d.y + 4 - j * 4, 14, 7, 1, PALETTE[j % PALETTE.length], INK, 1.5);
      });
      if (d.activity === 'owner') {
        // Its owner sits at it: the staff wait in the lounge.
        ownerLook ??= app.look?.ready() ? app.look.fromId('pc-owner', '') : null;
        if (ownerLook) app.look.sprite(c, ownerLook, d.x + d.seats[0], d.y + 35, 'north', { time: world.time });
      }
      if (d.dead) {
        // Dust over the desk, and cobwebs in its corners: the PC is off.
        box(c, d.x - 49, d.y - 19, 98, 36, 8, 'rgba(120, 128, 138, .55)', null);
        cobweb(c, d.x - 49, d.y - 19, 1);
        cobweb(c, d.x + 49, d.y - 19, -1);
        cobweb(c, d.x + 49, d.y + 17, -1, -1);
      }
    }
  }
  /** A cobweb in a corner at (x, y), spreading right (sx 1) or left (-1), down (sy 1) or up (-1). */
  function cobweb(c, x, y, sx, sy = 1) {
    const col = 'rgba(245, 247, 250, .9)';
    const r = 22;
    for (let k = 0; k <= 4; k++) {
      const a = (k / 4) * (Math.PI / 2);
      line(c, x, y, x + sx * Math.cos(a) * r, y + sy * Math.sin(a) * r, col, 1);
    }
    for (const rr of [7, 13, 19]) {
      c.beginPath();
      for (let k = 0; k <= 4; k++) {
        const a = (k / 4) * (Math.PI / 2);
        const px = x + sx * Math.cos(a) * rr;
        const py = y + sy * Math.sin(a) * rr;
        if (k) c.quadraticCurveTo(x + sx * Math.cos(a - Math.PI / 16) * rr * 0.85, y + sy * Math.sin(a - Math.PI / 16) * rr * 0.85, px, py);
        else c.moveTo(px, py);
      }
      c.strokeStyle = col;
      c.lineWidth = 1;
      c.stroke();
    }
  }

  function drawScreen(c, x, y, w, what) {
    const t = world.time;
    const fill = { off: '#11161f', owner: '#e58a8a', idle: '#5d7084', arriving: '#8fa3b6', drawing: '#fff7ed', researching: '#f4f6f9' }[what] ?? '#69bfe9';
    box(c, x - w / 2, y, w, 10, 2, fill, null);
    if (what === 'typing' || what === 'working') {
      // Lines of the answer, scrolling.
      for (let i = 0; i < 3; i++) {
        const len = ((Math.sin(t * 3 + i * 2) + 1) / 2) * (w - 8) + 4;
        line(c, x - w / 2 + 3, y + 2 + i * 3, x - w / 2 + 3 + len, y + 2 + i * 3, '#e9f6ff', 1.2);
      }
    } else if (what === 'researching') {
      for (let i = 0; i < 3; i++) line(c, x - w / 2 + 4, y + 2.5 + i * 3, x + w / 2 - 6 - i * 3, y + 2.5 + i * 3, '#9aa7b6', 1.2);
    } else if (what === 'drawing') {
      for (let i = 0; i < 4; i++) oval(c, x - w / 2 + 5 + i * ((w - 10) / 3), y + 5 + Math.sin(t * 2 + i) * 1.5, 2.5, 2.5, PALETTE[(i + Math.floor(t)) % 6], null);
    } else if (what === 'arriving') {
      box(c, x - w / 2 + 3, y + 4, (w - 6) * ((t % 3) / 3), 2.5, 1, '#78c6a3', null);
    }
  }

  /** The little picture above someone's head that says what they do (shapes only: it reads in the small tile too). */
  function drawIcon(c, p) {
    const s = p.row.doing;
    if (p.firing || s === 'boss' || s === 'courier' || s === 'it' || p.target?.pizza) return;
    const x = p.x;
    const y = p.y - 50 + Math.sin(world.time * 3 + p.seed) * 1.5;
    if (p.path.length && !p.out) return;
    if (s === 'thinking') {
      oval(c, x + 8, y + 20, 3, 3, '#fff', INK, 1.5);
      oval(c, x + 13, y + 12, 4, 4, '#fff', INK, 1.5);
      oval(c, x + 4, y - 2, 16, 12, '#fff', INK, 2);
      // The bulb lights up and dims.
      oval(c, x + 4, y - 4, 5, 5, `rgba(247, 205, 80, ${0.55 + 0.45 * Math.sin(world.time * 4) ** 2})`, INK, 1.5);
      box(c, x + 1.5, y + 1, 5, 3, 1, '#9aa7b6', INK, 1);
    } else if (s === 'typing' || s === 'working') {
      box(c, x - 14, y - 8, 28, 14, 6, '#fff', INK, 2);
      for (let i = 0; i < 3; i++) oval(c, x - 7 + i * 7, y - 1 - (Math.floor(world.time * 4) % 3 === i ? 2 : 0), 2, 2, INK, null);
    } else if (s === 'researching') {
      box(c, x - 13, y - 8, 13, 15, 2, '#b29be4', INK, 1.5);
      box(c, x, y - 8, 13, 15, 2, '#b29be4', INK, 1.5);
      line(c, x - 9, y - 3, x - 3, y - 3, '#fff', 1.2);
      line(c, x + 3, y - 3, x + 9, y - 3, '#fff', 1.2);
    } else if (s === 'drawing') {
      oval(c, x, y - 1, 13, 9, '#f9ead0', INK, 1.5);
      PALETTE.slice(0, 4).forEach((col, i) => oval(c, x - 7 + i * 5, y - 3 + (i % 2) * 4, 2, 2, col, null));
    } else if (s === 'waiting') {
      // An hourglass, turning over now and then.
      c.save();
      c.translate(x, y);
      c.rotate(Math.floor(world.time / 2) % 2 ? Math.PI : 0);
      c.beginPath();
      c.moveTo(-7, -9); c.lineTo(7, -9); c.lineTo(-7, 9); c.lineTo(7, 9); c.closePath();
      c.fillStyle = '#efbd72';
      c.fill();
      c.strokeStyle = INK;
      c.lineWidth = 1.8;
      c.stroke();
      c.restore();
    } else if (s === 'off') {
      // PC off: a power symbol, grey (never the same shape or colour as a break's cup).
      powerMark(c, x, y - 4);
    } else if (breakOf(p)) {
      cupMark(c, x, y - 4);
    } else if (p.target?.helping) {
      // A small bulb: helping someone think.
      oval(c, x, y - 2, 6, 6, `rgba(247, 205, 80, ${0.5 + 0.5 * Math.sin(world.time * 3 + p.seed) ** 2})`, INK, 1.5);
      box(c, x - 2.5, y + 3, 5, 3, 1, '#9aa7b6', INK, 1);
    } else if (s === 'resting' && p.target?.area === 'stretch') {
      // A dumbbell, lifted and lowered.
      const lift = Math.abs(Math.sin(world.time * 3)) * 4;
      line(c, x - 9, y - lift, x + 9, y - lift, INK, 2.5);
      box(c, x - 13, y - 5 - lift, 5, 10, 1.5, '#9aa7b6', INK, 1.5);
      box(c, x + 8, y - 5 - lift, 5, 10, 1.5, '#9aa7b6', INK, 1.5);
    } else if (s === 'nodesk' || s === 'resting' || s === 'owner') {
      // Sitting at the desk ready, or with a coffee: nothing over the head.
      if (p.target?.area === 'desk' || p.target?.rest?.id === 'coffee' || p.target?.rest?.id === 'vending') return;
      // Z z: resting.
      const k = (world.time + p.seed % 7) % 3;
      c.globalAlpha = 0.85;
      text(c, 'z', x + 6 + k * 3, y + 4 - k * 4, 13, '#56677b');
      c.globalAlpha = 1;
    }
  }

  /** PC off: a grey disc with the power symbol (a broken ring and a bar). */
  function powerMark(c, x, y) {
    oval(c, x, y, 11, 11, '#8a96a3', INK, 1.5);
    c.beginPath();
    c.arc(x, y + 1, 5.5, -Math.PI / 2 + 0.75, -Math.PI / 2 - 0.75 + Math.PI * 2);
    c.strokeStyle = '#fff';
    c.lineWidth = 2;
    c.lineCap = 'round';
    c.stroke();
    line(c, x, y - 6, x, y, '#fff', 2);
  }
  /** On a break: a green disc with a cup. */
  function cupMark(c, x, y) {
    oval(c, x, y, 11, 11, '#4fa77a', INK, 1.5);
    box(c, x - 5, y - 4, 8, 9, 2, '#fff', null);
    c.beginPath();
    c.arc(x + 4, y, 3, -Math.PI / 2, Math.PI / 2);
    c.strokeStyle = '#fff';
    c.lineWidth = 1.6;
    c.stroke();
  }
  /** Under the name in the full view: "On a break" (green, a cup) or "PC off" (grey, the power symbol). */
  function stateTag(c, p, y) {
    const off = p.target?.area === 'beach';
    if (!off && !breakOf(p)) return;
    const words = off ? 'PC off' : 'On a break';
    const size = labelSize(c) * 0.9;
    c.font = `600 ${size}px Segoe UI, system-ui, sans-serif`;
    const w = c.measureText(words).width + size * 2.6;
    // Worded only where it has room (or for the person picked): next to each other, the mark over each head says it.
    const near = [...world.people.values()].some(o => o !== p && !o.path.length && (o.target?.area === 'beach' || breakOf(o)) && Math.abs(o.x - p.x) < w + 4 && Math.abs(o.y - p.y) < 40);
    if (near && world.selected !== p.id) return;
    const h = size * 1.6;
    box(c, p.x - w / 2, y, w, h, h / 2, off ? '#e6e9ed' : '#dff2e7', off ? '#7b8794' : '#3c8a64', 1.5);
    (off ? powerMark : cupMark)(c, p.x - w / 2 + size * 0.95, y + h / 2);
    text(c, words, p.x - w / 2 + size * 1.9, y + h * 0.7, size, off ? '#4a5563' : '#24603f');
  }

  function bubble(c, p, size) {
    c.font = `600 ${size}px Segoe UI, system-ui, sans-serif`;
    const w = c.measureText(p.bubble).width + size * 1.4;
    const h = size * 1.9;
    const bx = Math.max(4, Math.min(W - w - 4, p.x - w / 2));
    // The boss's words sit higher, clear of the other person's.
    const by = Math.max(4, p.y - 46 - h - (p.id === 'boss' ? h + 6 : 0));
    box(c, bx, by, w, h, 8, '#fff', INK, 2);
    text(c, p.bubble, bx + w / 2, by + h * 0.68, size, INK, 'center');
  }

  /** A folder of work, carried in by the courier. */
  function folderCarried(c, p) {
    const dx = p.face === 'east' ? 22 : p.face === 'west' ? -22 : 0;
    const dy = p.face === 'north' ? -30 : 9;
    box(c, p.x + dx - 16, p.y + dy - 9, 32, 22, 3, '#e8b971', INK, 2);
    line(c, p.x + dx - 11, p.y + dy - 1, p.x + dx + 11, p.y + dy - 1, '#fff7ed', 2.5);
    line(c, p.x + dx - 11, p.y + dy + 5, p.x + dx + 7, p.y + dy + 5, '#fff7ed', 2.5);
  }
  /** A PC (a screen) carried by the IT person. */
  function pcCarried(c, p) {
    const dx = p.face === 'east' ? 24 : p.face === 'west' ? -24 : 0;
    const dy = p.face === 'north' ? -34 : 9;
    box(c, p.x + dx - 17, p.y + dy - 11, 34, 23, 4, INK);
    box(c, p.x + dx - 13, p.y + dy - 7, 26, 13, 2, '#69bfe9', null);
  }

  /** A pizza box, carried in by the delivery. */
  function pizzaBox(c, p, kind = 'pizza') {
    const dx = p.face === 'east' ? 24 : p.face === 'west' ? -24 : 0;
    const dy = p.face === 'north' ? -32 : 9;
    box(c, p.x + dx - 22, p.y + dy - 10, 44, 20, 4, kind === 'donuts' ? '#ffe3ef' : '#fff2d8', INK, 2);
    if (kind === 'donuts') for (let i = 0; i < 3; i++) donut(c, p.x + dx - 12 + i * 12, p.y + dy, 4.5, PALETTE[i + 1]);
    else oval(c, p.x + dx, p.y + dy, 12, 6, '#e6a64c', null);
  }
  /** A donut seen from above: the dough, the icing, the hole. */
  function donut(c, x, y, r, icing) {
    oval(c, x, y, r, r, '#d39a5a', INK, 1.2);
    oval(c, x, y, r * 0.72, r * 0.72, icing, null);
    oval(c, x, y, r * 0.3, r * 0.3, '#fff6e4', INK, 1);
  }
  /** A takeaway coffee in hand, delivered. */
  function coffeeHeld(c, p) {
    const dx = p.face === 'west' ? -15 : 15;
    box(c, p.x + dx - 4, p.y - 6, 8, 11, 2, '#fff9eb', INK, 1.5);
    box(c, p.x + dx - 5, p.y - 8, 10, 3, 1, '#8a6a4c', INK, 1);
  }

  /** A cold drink with a straw, on a break. */
  function drinkHeld(c, p) {
    box(c, p.x + 13, p.y - 4, 8, 12, 2, '#bfe6f2', INK, 1.5);
    line(c, p.x + 18, p.y - 4, p.x + 21, p.y - 11, '#ef8a91', 1.8);
  }

  /** The box of belongings carried to a new desk. */
  function carried(c, p) {
    const dx = p.face === 'east' ? 22 : p.face === 'west' ? -22 : 0;
    const dy = p.face === 'north' ? -30 : 10;
    box(c, p.x + dx - 17, p.y + dy - 8, 34, 22, 3, '#c49a6c', INK, 2);
    mug(c, p.x + dx + 4, p.y + dy - 9);
    oval(c, p.x + dx - 8, p.y + dy - 14, 6, 8, '#78a984');
  }

  /** Text in the full view is never under 12 px on the screen. */
  function labelSize(c) {
    const onScreen = c.getTransform().a / Math.min(2, window.devicePixelRatio || 1);
    return Math.max(13, 12.5 / (onScreen || 1));
  }

  function drawPeople(c, full, view) {
    const ready = app.look?.ready();
    const list = [...world.people.values(), ...(boss ? [boss] : []), ...(courier ? [courier] : []), ...(it ? [it] : [])].filter(p => !p.out || p.path.length).sort((a, b) => a.y - b.y);
    for (const p of list) {
      const walk = p.path.length > 0;
      const lifted = p.drag && p.drag.view === view;
      const y = lifted ? p.y - 14 : p.y;
      if (world.selected === p.id) oval(c, p.x, p.y + 12, 22, 11, '#f8d878', null);
      if (lifted) oval(c, p.x, p.y + 12, 18, 8, 'rgba(39, 54, 78, .2)', null);
      const look = ready ? p.look ?? app.look.fromId(p.id, p.row.roleId ?? '') : null;
      if (look && !walk && p.target?.area === 'beach') {
        // On holiday: lying on the towel in the sun (head to the left; the middle of the body over the towel's).
        c.save();
        c.translate(p.x + 4, y + 8);
        c.rotate(-Math.PI / 2);
        app.look.sprite(c, look, 0, 0, 'south', { time: world.time });
        // Sunglasses.
        oval(c, -5, -12, 4.5, 3.2, '#1d2633', null);
        oval(c, 5, -12, 4.5, 3.2, '#1d2633', null);
        line(c, -1, -12, 1, -12, '#1d2633', 1.5);
        c.restore();
      } else if (look && !walk && (p.target?.area === 'stretch' || p.target?.rest?.gym)) {
        // Stretching or at the gym: hopping on the spot.
        app.look.sprite(c, look, p.x, y - Math.abs(Math.sin(world.time * 5 + p.seed)) * 6, 'south', { walk: true, time: world.time, seed: p.seed % 10 });
      } else if (look) app.look.sprite(c, look, p.x, y, p.face, { walk, time: world.time, seed: p.seed % 10 });
      else oval(c, p.x, y, 14, 18, PALETTE[p.seed % 6]);
      if (p.carry === 'coffee') coffeeTray(c, { ...p, y });
      else if (FOOD[p.carry]) pizzaBox(c, { ...p, y }, p.carry);
      else if (p.carry === 'folder') folderCarried(c, { ...p, y });
      else if (p.carry === 'pc') pcCarried(c, { ...p, y });
      else if (p.carry) carried(c, { ...p, y });
      else if (p.coffee === 'have' && world.time < p.coffeeUntil) coffeeHeld(c, { ...p, y });
      else if (breakOf(p) && !walk) drinkHeld(c, { ...p, y });
      if (full && p.bubbleUntil > world.time) bubble(c, { ...p, y }, labelSize(c));
      else drawIcon(c, { ...p, y });
      if (world.selected === p.id) {
        // A marker above the one picked: it shows in the small tile too.
        const b = Math.sin(world.time * 5) * 3;
        c.beginPath();
        c.moveTo(p.x - 9, y - 74 + b);
        c.lineTo(p.x + 9, y - 74 + b);
        c.lineTo(p.x, y - 62 + b);
        c.closePath();
        c.fillStyle = '#f2b733';
        c.fill();
        c.strokeStyle = INK;
        c.lineWidth = 2;
        c.stroke();
      }
      // At their desk a name would sit over the computers: only the one picked has it there.
      const atDesk = !walk && p.targetKey?.startsWith('seat:');
      if (full && (!atDesk || world.selected === p.id)) {
        const ny = p.target?.area === 'beach' && !walk ? y + 46 : y + 34;
        text(c, p.row.name, p.x, ny, labelSize(c), INK, 'center');
        // Lying on a towel near the sea's edge: the tag goes above them, clear of the bottom.
        if (!walk) stateTag(c, p, p.target?.area === 'beach' ? y - 36 : ny + labelSize(c) * 0.4);
      }
    }
  }

  // ---- Views: the tile in each Staff overview tab, and the full-screen window ----

  /** The part of the office a view shows: all of it, or (the tile) the person picked, close up. */
  function cameraOf(view) {
    // Held still while a person is dragged in it.
    if (view.press?.moved && view.cam) return view.cam;
    // The tile follows the person picked; the full view zooms in only on someone being fired, as the boss comes.
    const zoom = view.kind === 'tile' ? world.selected : world.firing;
    const p = zoom ? world.people.get(zoom) : null;
    const want = p && (!p.out || p.path.length)
      ? { w: 540, h: (540 * H) / W, x: Math.max(0, Math.min(W - 540, p.x - 270)), y: Math.max(0, Math.min(H - (540 * H) / W, p.y - 230)) }
      : { w: W, h: H, x: 0, y: 0 };
    const cam = view.cam ?? want;
    // Glides to the new view rather than jumping.
    const k = view.cam ? 0.12 : 1;
    view.cam = { w: cam.w + (want.w - cam.w) * k, h: cam.h + (want.h - cam.h) * k, x: cam.x + (want.x - cam.x) * k, y: cam.y + (want.y - cam.y) * k };
    return view.cam;
  }

  function fit(view) {
    const cv = view.canvas;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    let cw = cv.parentElement.clientWidth;
    let ch = (cw * H) / W;
    if (view.kind === 'full') {
      const room = cv.parentElement.getBoundingClientRect();
      ch = Math.min(room.height, (cw * H) / W);
      cw = (ch * W) / H;
      // The window only as wide as the office and the menu need (no empty bands either side of the office), up to the
      // 96% of the screen it may take; a phone keeps the whole width.
      const wide = window.matchMedia?.('(min-width: 800px)').matches;
      const want = Math.max(760, Math.ceil(cw + (full.offsetWidth - cv.parentElement.clientWidth)));
      if (!wide || want >= window.innerWidth * 0.96) full.style.width = '';
      else if (Math.abs(full.offsetWidth - want) > 2) full.style.width = `${want}px`;
    }
    if (!cw) return false;
    const pw = Math.round(cw * ratio);
    const ph = Math.round(ch * ratio);
    if (cv.width !== pw || cv.height !== ph) {
      cv.width = pw;
      cv.height = ph;
      cv.style.width = `${cw}px`;
      cv.style.height = `${ch}px`;
    }
    return true;
  }

  function draw(view) {
    if (!fit(view)) return;
    const c = view.ctx;
    const cam = cameraOf(view);
    const k = view.canvas.width / cam.w;
    view.scale = k;
    view.cam = cam;
    background ??= drawBackground();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, view.canvas.width, view.canvas.height);
    c.setTransform(k, 0, 0, k, -cam.x * k, -cam.y * k);
    c.drawImage(background, 0, 0);
    // Names are written only where they can be read at 12 px or more without crowding the rooms (not on a phone).
    const full = view.kind === 'full' && labelSize(c) <= 24;
    // A room with nothing bought for it yet says so (and how it fills).
    if (full) for (const r of emptyRooms()) text(c, 'Empty: furnish it from Look after the team', r.x + r.w / 2, r.y + r.h / 2 + 30, labelSize(c), '#7b8794', 'center');
    drawDesks(c, full);
    drawFrame(c, full);
    if (world.pizzaOn && world.food === 'donuts') {
      box(c, 268, 603, 70, 38, 4, '#ffe3ef', INK, 2);
      for (let i = 0; i < 6; i++) donut(c, 281 + (i % 3) * 22, 613 + Math.floor(i / 3) * 18, 7, PALETTE[i % 6]);
    } else if (world.pizzaOn) {
      box(c, 268, 603, 70, 38, 4, '#fff6e4', INK, 2);
      oval(c, 303, 622, 26, 14, '#f2bc66');
      for (let i = 0; i < 6; i++) oval(c, 285 + i * 7, 618 + (i % 2) * 7, 3, 3, '#dc776e', null);
    }
    // The desk a person is dragged over: green when they can move there, red when not.
    if (view.hover) {
      const d = deskOf(view.hover.key);
      if (d) box(c, d.x - 54, d.y - 24, 108, 76, 12, view.hover.ok ? 'rgba(120, 198, 163, .35)' : 'rgba(239, 138, 145, .35)', view.hover.ok ? '#3c8a64' : '#a8322a', 3);
    }
    // The whiteboard (once bought) fills with notes while someone thinks in the boardroom.
    if (world.rooms.boardroom.whiteboard && thinkersNow().length) for (let i = 0; i < 4; i++) line(c, 1122, 140 + i * 23, 1122 + 16 * ((Math.sin(world.time + i) + 1) / 2) + 2, 140 + i * 23, PALETTE[i], 4);
    drawPeople(c, full, view);
  }

  // ---- Frames: only while a view is on the screen ----

  let running = false;
  let last = 0;
  // The tiles rest while the full-screen window is open over them.
  const shown = v => v.canvas.isConnected && v.seen && v.canvas.offsetParent !== null && !document.hidden && (v.kind === 'full' ? v.dialog.open : !full.open);
  function wake() {
    if (running || !views.some(shown)) return;
    running = true;
    last = 0;
    requestAnimationFrame(frame);
  }
  function frame(now) {
    const live = views.filter(shown);
    if (!live.length) {
      running = false;
      return;
    }
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    world.seenAt = now;
    step(dt);
    for (const v of live) {
      // The tile draws 20 times a second (the laptop's graphics are small), the full view up to 40.
      if (now - (v.drawnAt ?? 0) < (v.kind === 'tile' ? 48 : 24)) continue;
      v.drawnAt = now;
      draw(v);
      if (now - (v.toldAt ?? 0) > 300) {
        v.toldAt = now;
        tell(v);
      }
    }
    requestAnimationFrame(frame);
  }
  document.addEventListener('visibilitychange', wake);

  /** The line under the office: the person picked and what they do, or how the staff are now. */
  function tell(v) {
    const p = world.selected ? world.people.get(world.selected) : null;
    const key = p ? `${p.id}|${wordsOf(p)}|${p.row.pc ?? ''}|${holding(p)}` : `all|${world.staff.map(s => s.doing).join()}`;
    if (key === v.told) return;
    v.told = key;
    if (p) {
      const s = p.row;
      v.strip.replaceChildren(
        app.avatar ? app.avatar(`staff:${s.id}`, s.name.slice(0, 2).toUpperCase()) : el('span'),
        el('span', { class: 'office-who' }, el('span', { class: 'office-name' }, el('strong', { text: s.name }), el('span', { class: 'hint', text: ` · ${s.pc || 'My PC'}` })), el('span', { class: 'office-doing', text: wordsOf(p) }), el('span', { class: 'hint', text: `Holding: ${holding(p)}` })),
        el('button', { class: 'btn quiet', type: 'button', text: 'Show everyone', onclick: () => { world.selected = null; v.told = ''; } }));
      return;
    }
    v.strip.replaceChildren(el('span', { class: 'hint', text: world.staff.length ? 'Click on a staff to see what they are up to.' : 'Nobody hired yet.' }));
  }

  // ---- Pointer: press a person to pick them, a desk to open its PC window; drag a person onto another desk ----

  function at(view, e) {
    const r = view.canvas.getBoundingClientRect();
    const cam = view.cam ?? { x: 0, y: 0, w: W, h: H };
    return [cam.x + ((e.clientX - r.left) / r.width) * cam.w, cam.y + ((e.clientY - r.top) / r.height) * cam.h];
  }
  const personAt = (x, y) => [...world.people.values()].filter(p => !p.out).sort((a, b) => b.y - a.y).find(p => Math.hypot(p.x - x, p.y - 10 - y) < 28);
  const onFrame = (x, y) => x > FRAME.x && x < FRAME.x + FRAME.w && y > FRAME.y && y < FRAME.y + FRAME.h;
  const deskUnder = (x, y) => world.desks.find(d => x > d.x - 60 && x < d.x + 60 && y > d.y - 30 && y < d.y + 55);
  /** Whether `s` can be moved to desk d: not the one they sit at, not a PC that is off or in use by its owner. */
  const canMove = (s, d) => !!d && d.key !== (s.pcId ?? '') && d.activity !== 'offline' && d.activity !== 'owner';

  function hookPointer(view) {
    const cv = view.canvas;
    cv.addEventListener('pointerdown', e => {
      const [x, y] = at(view, e);
      const p = personAt(x, y);
      view.press = { x, y, p, moved: false, desk: p ? null : deskUnder(x, y) };
      if (p) cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', e => {
      const [x, y] = at(view, e);
      const press = view.press;
      if (!press) {
        cv.style.cursor = personAt(x, y) ? 'grab' : deskUnder(x, y) || onFrame(x, y) ? 'pointer' : '';
        return;
      }
      if (!press.p) return;
      if (!press.moved && Math.hypot(x - press.x, y - press.y) > 8) {
        press.moved = true;
        press.from = [press.p.x, press.p.y];
        press.p.drag = { view };
      }
      if (press.moved) {
        press.p.x = x;
        press.p.y = y;
        cv.style.cursor = 'grabbing';
        const d = deskUnder(x, y);
        view.hover = d ? { key: d.key, ok: canMove(press.p.row, d) } : null;
      }
    });
    const end = e => {
      const press = view.press;
      view.press = null;
      view.hover = null;
      cv.style.cursor = '';
      if (!press) return;
      if (press.p && press.moved) {
        const p = press.p;
        const [x, y] = at(view, e);
        const d = deskUnder(x, y);
        // Back where they were: they walk over once the move is made (the same Move window as the left panel's).
        [p.x, p.y] = press.from;
        p.drag = null;
        if (canMove(p.row, d)) app.deskMove?.(p.row, d.key, d.name);
        else if (d) say(p, d.key === (p.row.pcId ?? '') ? 'This is my desk.' : 'That PC is not free.');
        return;
      }
      if (press.p) {
        world.selected = press.p.id;
        view.told = '';
        return;
      }
      if (press.desk) app.openPc?.(press.desk.key || 'here');
      else if (onFrame(press.x, press.y)) openMonth();
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', () => {
      const p = view.press?.p;
      if (p?.drag && view.press.from) [p.x, p.y] = view.press.from;
      if (p) p.drag = null;
      view.press = null;
      view.hover = null;
    });
    // A person dragged from the left panel (home.js) onto a desk here.
    cv.addEventListener('dragover', e => {
      const s = app.deskDragging?.();
      if (!s) return;
      const d = deskUnder(...at(view, e));
      view.hover = d ? { key: d.key, ok: canMove(s, d) } : null;
      if (canMove(s, d)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }
    });
    cv.addEventListener('dragleave', () => { view.hover = null; });
    cv.addEventListener('drop', e => {
      const s = app.deskDragging?.();
      const d = deskUnder(...at(view, e));
      view.hover = null;
      if (!s || !canMove(s, d)) return;
      e.preventDefault();
      app.deskMove?.(s, d.key, d.name);
    });
  }

  function addView(kind, holder, dialog = null) {
    const canvas = el('canvas', { class: 'office-canvas', role: 'img', 'aria-label': 'The office: each hire as a little person, at their PC\'s desk when they work, in the boardroom when they think a long time (once it has a table), in the kitchen, the lounge or a deck chair on the beach when they rest, on a towel on the beach when their PC is off. The list below says the same in words.' });
    const strip = el('div', { class: 'office-strip', 'aria-live': 'off' });
    const view = { kind, canvas, ctx: canvas.getContext('2d'), strip, dialog, seen: kind === 'full' };
    holder.append(el('div', { class: 'office-stage' }, canvas), strip);
    if (kind === 'tile') {
      new IntersectionObserver(list => {
        view.seen = list.some(x => x.isIntersecting);
        wake();
      }).observe(canvas);
    }
    hookPointer(view);
    views.push(view);
    return view;
  }

  // The full-screen window: Watch on a tile opens it, Esc (or Close) shuts it.
  const full = el('dialog', { class: 'office-full', 'aria-labelledby': 'office-full-title' });
  const awardBtn = el('button', { class: 'btn', type: 'button', text: 'Award employee of the month', title: 'Most tokens written this month wins (a 20% off voucher)', onclick: () => award(awardBtn) });
  const undoAwardBtn = el('button', { class: 'btn', type: 'button', text: 'Undo award', title: "Takes this month's award off again", hidden: true, onclick: () => undoLastAward(undoAwardBtn) });
  const pizzaBtn = el('button', { class: 'btn', type: 'button', text: 'Buy them pizza', title: 'A pizza comes to the kitchen; whoever has nothing to do gathers round it', onclick: () => {
    if (orderFood('pizza')) wake();
    else fullSay('A pizza is on its way, or on the table already.');
  } });
  const purseLine = el('p', { class: 'office-purse' });
  const fullHead = el('div', { class: 'office-full-head' },
    el('div', { class: 'office-full-title' }, el('h2', { id: 'office-full-title', text: 'Staff overview' }), purseLine),
    el('span', { class: 'office-full-tools' }, awardBtn, undoAwardBtn, pizzaBtn, el('button', { class: 'btn', type: 'button', text: 'Close', onclick: () => full.close() })));
  const fullSaid = el('p', { class: 'hint office-said', 'aria-live': 'polite' });
  /** What the window has to say (a purchase, an award, why not): at the foot of the menu, where the buying is done. */
  const fullSay = words => {
    fullSaid.textContent = words;
    if (words) shopPanel.open = true;
  };

  // ---- The shop: rewards paid from the team's tokens written (the server keeps the purse: src/home.ts buy) ----

  // The menu beside the office: each thing to buy as a picture card with its price.
  // On a phone it sits under the office (the window scrolls to it). It can be folded away.
  const shopTiles = el('div', { class: 'office-shop-groups' });
  const shopPanel = el('details', { class: 'office-shop-panel' },
    el('summary', {}, el('h3', { id: 'office-shop-title', text: 'Look after the team' }), el('span', { class: 'hint', text: 'Gain tokens from work done' })),
    shopTiles, fullSaid);
  shopPanel.open = true;
  /** Each item's button (short) and what it does (the title); `done`: said once it is bought. */
  const SHOP_WORDS = {
    pizza: { label: 'Pizza', title: 'A pizza comes to the kitchen; whoever has nothing to do gathers round it (free)' },
    coffee: { label: 'Coffee', title: 'A coffee delivery comes in by the front door and hands each of them a coffee, wherever they are, busy or not' },
    donuts: { label: 'Donuts', title: 'A box of donuts comes to the kitchen table; whoever has nothing to do gathers round it' },
    table: { label: 'Table', title: 'Opens the boardroom: a think over 15 seconds goes to the table (until then it stays at the desk)', done: 'the boardroom is open: a think over 15 seconds goes to the table now. Buy chairs to seat them, and a helper in each chair left over' },
    chairs: { label: 'Chairs', each: 'a pair', title: 'Two chairs round the boardroom table, up to six: the thinkers sit first, and each chair left over seats someone with nothing to do who joins in to help (up to two)', done: 'two more chairs round the boardroom table' },
    whiteboard: { label: 'Whiteboard', title: 'Fills with notes while someone thinks in the boardroom', done: 'it fills with notes while someone thinks in the boardroom' },
    armchair: { label: 'Armchair', title: 'Staff with nothing to do nap in it', done: 'staff with nothing to do nap in it' },
    bookcase: { label: 'Bookcase', title: 'Staff with nothing to do read there', done: 'staff with nothing to do read there' },
    sofa: { label: 'Sofa', title: 'Staff with nothing to do chat in the lounge', done: 'staff with nothing to do chat in the lounge' },
    tv: { label: 'TV', title: 'Staff with nothing to do watch it from the sofa', done: 'staff with nothing to do watch it' },
    gym: { label: 'Gym', title: 'A treadmill and a weights bench for the lounge, kept for good: staff with nothing to do work out there', done: 'a treadmill and a weights bench in the lounge, kept for good. Staff with nothing to do work out there now and then' },
    deckchair: { label: 'Deck chair', title: 'A deck chair under an umbrella on the beach, up to six: staff with nothing to do for 10 minutes take a break there (busy staff never go; the staff of a PC that is off lie on towels instead)', done: 'staff with nothing to do for 10 minutes take a break there' },
  };
  const num = n => Number(n || 0).toLocaleString();
  /** A shop item's picture, drawn with the office's own pencils into a 100 x 75 box. */
  function drawPic(c, id) {
    if (id === 'coffee') {
      box(c, 37, 24, 26, 40, 5, '#fff9eb');
      box(c, 37, 36, 26, 13, 2, '#c98f5a', INK, 2);
      box(c, 33, 16, 34, 9, 3, '#8a6a4c');
    } else if (id === 'donuts') {
      donut(c, 50, 40, 24, '#ef8a91');
      for (let i = 0; i < 6; i++) line(c, 40 + i * 4, 28 + (i % 2) * 18, 42 + i * 4, 31 + (i % 2) * 18, PALETTE[i % 6], 2);
    } else if (id === 'pizza') {
      c.beginPath();
      c.moveTo(22, 18);
      c.lineTo(80, 28);
      c.lineTo(36, 66);
      c.closePath();
      c.fillStyle = '#f2bc66';
      c.fill();
      c.strokeStyle = INK;
      c.lineWidth = 2.5;
      c.stroke();
      line(c, 24, 18, 78, 28, '#c98f5a', 6);
      for (const [x, y] of [[44, 32], [58, 36], [42, 48]]) oval(c, x, y, 5, 5, '#dc776e', null);
    } else if (id === 'table') {
      box(c, 14, 24, 72, 30, 12, '#e8bb80');
    } else if (id === 'chairs') {
      box(c, 18, 26, 28, 24, 8, '#a6aacb');
      box(c, 54, 26, 28, 24, 8, '#a6aacb');
    } else if (id === 'whiteboard') {
      box(c, 16, 12, 68, 50, 6, INK);
      box(c, 22, 18, 56, 38, 3, '#fff7ed');
      for (let i = 0; i < 3; i++) line(c, 28, 26 + i * 10, 52 + i * 8, 26 + i * 10, PALETTE[i], 3);
    } else if (id === 'armchair') {
      box(c, 26, 18, 48, 42, 12, '#a4bac9');
      box(c, 34, 30, 32, 26, 8, '#c6d6e2', INK, 1.5);
    } else if (id === 'bookcase') {
      box(c, 12, 22, 76, 32, 5, '#b78966');
      for (let i = 0; i < 8; i++) box(c, 17 + i * 8.5, 26, 7, 24, 1, PALETTE[i % 6], INK, 1.5);
    } else if (id === 'sofa') {
      box(c, 10, 36, 80, 20, 9, '#9ab4c9');
      box(c, 14, 18, 72, 24, 10, '#b8cddd');
    } else if (id === 'tv') {
      box(c, 12, 14, 76, 40, 6, INK);
      box(c, 17, 19, 66, 30, 3, '#182638');
      line(c, 50, 54, 50, 62, INK, 3);
      line(c, 38, 63, 62, 63, INK, 3);
    } else if (id === 'gym') {
      line(c, 22, 38, 78, 38, '#56677b', 4);
      box(c, 16, 24, 10, 28, 3, INK);
      box(c, 74, 24, 10, 28, 3, INK);
      box(c, 26, 28, 7, 20, 2, '#9ab6c7', INK, 1.5);
      box(c, 67, 28, 7, 20, 2, '#9ab6c7', INK, 1.5);
    } else if (id === 'deckchair') {
      c.save();
      c.translate(36, 46);
      c.scale(0.8, 0.8);
      deckChair(c, 0, 0, 0);
      c.restore();
    }
  }
  /** The menu's sections: the treats, then the office by room, each a row of picture cards. */
  const SECTIONS = [['Treat the team', [['', ['pizza', 'coffee', 'donuts']]]], ['Improve the office', [['Boardroom', ['table', 'chairs', 'whiteboard']], ['Lounge', ['armchair', 'bookcase', 'sofa', 'tv', 'gym']], ['Beach', ['deckchair']]]]];
  /** Pizza is the boss's treat (free): on the menu beside the paid ones. */
  const PIZZA_ITEM = { id: 'pizza', name: 'Pizza', price: 0, room: 'treats', keeps: false, most: 0, have: 0, owned: false, waits: false };
  function tile(i) {
    const w = SHOP_WORDS[i.id] ?? { label: i.name, title: '' };
    const pic = el('canvas', { class: 'office-tile-pic', width: 128, height: 96, 'aria-hidden': 'true' });
    const c = pic.getContext('2d');
    c.scale(1.28, 1.28);
    drawPic(c, i.id);
    const left = world.purse?.left ?? 0;
    const count = i.most > 1 ? (i.id === 'chairs' ? `${i.have * 2} of 6` : `${i.have} of ${i.most}`) : '';
    // What the card says under the name: bought, its table first, the price, and how far off it is.
    const lines = i.owned ? [count ? `✓ All ${i.id === 'chairs' ? 6 : i.most}` : '✓ Bought']
      : [i.price ? `${num(i.price)}${w.each ? ` ${w.each}` : ''}` : 'Free', count && `${count} bought`, i.waits ? 'Table first' : i.price > left ? `${num(i.price - left)} more to go` : ''].filter(Boolean);
    const body = [pic, el('span', { class: 'office-tile-name', text: w.label }), ...lines.map((t, k) => el('span', { class: k ? 'office-tile-note' : 'office-tile-price', text: t }))];
    const said = `${w.label}. ${lines.join('. ')}. ${w.title}`;
    if (i.owned) return el('div', { class: 'office-tile owned', title: `${i.name}: bought. ${w.title}`, role: 'img', 'aria-label': said }, ...body);
    // Short of tokens or before its table: still pressable, and the shop says why (a greyed card explains nothing).
    const short = i.waits || i.price > left;
    return el('button', { class: `office-tile${short ? ' short' : ''}`, type: 'button', title: `${w.title}${i.price ? ` (${num(i.price)} tokens)` : ''}`, 'aria-label': said, onclick: e => (i.id === 'pizza' ? pizzaBtn.click() : buyItem(i, e.currentTarget)) }, ...body);
  }
  function drawShop() {
    const p = world.purse;
    purseLine.textContent = p ? `To spend: ${num(p.left)} tokens` : 'To spend: …';
    purseLine.title = p ? `Gain tokens from work done: ${num(p.earned)} tokens written in all, ${num(p.spent)} spent in the shop. Every token they write adds to it.` : 'Not read yet';
    const item = id => (id === 'pizza' ? PIZZA_ITEM : world.shop.find(i => i.id === id));
    shopTiles.replaceChildren(...SECTIONS.map(([head, groups]) => el('section', { class: 'office-shop-section' },
      el('h4', { text: head }),
      ...groups.flatMap(([room, ids]) => {
        const items = ids.map(item).filter(Boolean);
        return items.length ? [...(room ? [el('p', { class: 'office-shop-room', text: room })] : []), el('div', { class: 'office-tiles' }, ...items.map(tile))] : [];
      }))));
  }
  /** Who can enjoy a treat now: in the office, not leaving or being fired. */
  const present = () => [...world.people.values()].filter(p => !p.out && !p.leaving && !p.firing);
  async function buyItem(item, button) {
    // Nothing is paid for that cannot happen: nobody to buy a treat for, or the table taken.
    if (item.room === 'treats' && !present().length) return fullSay('Nobody is in the office to buy for: hire someone first.');
    if (item.id === 'donuts' && tableBusy()) return fullSay('Food is on the table, or on its way: buy the donuts once it is eaten.');
    if (item.id === 'coffee' && (courier?.job.kind === 'coffee' || deliveries.some(d => d.kind === 'coffee'))) return fullSay('A coffee delivery is on its way already: buy another once it has been round.');
    button.disabled = true;
    try {
      const d = await api('/api/office/buy', { item: item.id });
      officeData(d);
      const left = `${num(d.purse?.left)} tokens left to spend.`;
      if (item.id === 'coffee') {
        deliveries.push({ kind: 'coffee', who: present().filter(p => p.row.doing !== 'off').map(p => p.id), at: 0 });
        fullSay(`Coffee ordered (${num(item.price)} tokens): a coffee delivery comes in by the front door with one for each of them, wherever they are. ${left}`);
      } else if (item.id === 'donuts') {
        orderFood('donuts');
        fullSay(`Donuts ordered (${num(item.price)} tokens): they come in by the front door to the kitchen table. ${left}`);
      } else {
        const now = d.shop?.find(i => i.id === item.id);
        const cheer = item.id === 'gym' ? ['A gym!', 'New treadmill!', 'Time to lift!'] : item.room === 'beach' ? ['A deck chair!', 'Beach time!', 'Sun lounger!'] : ['New furniture!', 'Nice!', 'Very smart!'];
        for (const p of present()) {
          say(p, cheer[p.seed % 3], 4);
          if (p.target?.rest) p.restUntil = 0;
        }
        const count = item.id === 'chairs' ? `, ${(now?.have ?? 0) * 2} of 6` : item.most > 1 ? `, ${now?.have ?? 0} of ${item.most}` : '';
        fullSay(`${item.name} bought${count} (${num(item.price)} tokens): ${SHOP_WORDS[item.id]?.done ?? 'it is in the office now'}. ${left}`);
      }
      wake();
    } catch (e) {
      fullSay(e.message);
    } finally {
      button.disabled = false;
    }
  }
  const boardLine = el('p', { class: 'hint office-board' });
  /** This week's leaderboard: tokens written since Monday, most first. */
  function drawBoard() {
    const rows = world.weekBoard;
    const now = world.awards.find(a => a.month === world.monthKey);
    undoAwardBtn.hidden = !now;
    // This month is still running: an award given earlier can fall behind, and saying so beats a wrong frame.
    const behind = now && world.behind ? ` ${now.name} was made employee of the month for ${world.monthName} at ${now.out.toLocaleString()} tokens written; ${world.behind.name} has written more since (${world.behind.out.toLocaleString()}). Award it again to update it, or Undo award.` : '';
    boardLine.textContent = ((rows.length ? `This week's leaderboard (tokens written since Monday): ${rows.map((r, i) => `${i + 1}. ${r.name} ${r.out.toLocaleString()}`).join(' · ')}.` : '') + behind).trim();
  }
  const fullBody = el('div', { class: 'office-full-body' });
  full.append(fullHead, el('div', { class: 'office-full-main' }, fullBody, shopPanel));
  document.body.append(full);
  addView('full', fullBody, full);
  fullBody.append(boardLine);
  full.addEventListener('close', wake);

  for (const holder of document.querySelectorAll('[data-office]')) {
    const watch = el('button', { class: 'btn office-watch', type: 'button', title: 'Watch the office full screen (Esc closes it)', 'aria-label': 'Watch the office full screen' });
    // Four corners pointing out: full screen.
    watch.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    watch.append(' Watch');
    watch.addEventListener('click', () => {
      fullSay('');
      loadOffice();
      full.showModal();
      wake();
    });
    holder.append(watch);
    addView('tile', holder);
  }

  loadOffice();

  app.office = {
    update,
    /**
     * Fired (Staff, after its own question): the office opens full screen, close on them; the boss walks in, says it,
     * a box is packed and carried out of the front door. False when they are not in the office (or a firing is on).
     */
    fire: id => {
      if (!fire(id)) return false;
      fullSay('');
      if (!full.open) full.showModal();
      for (const v of views) v.told = '';
      wake();
      return true;
    },
    /** The chat opened is with this person: the tiles follow them now (Home's next list says the same). */
    follow: id => {
      world.follow = id;
      world.selected = id;
      for (const v of views) v.told = '';
      wake();
    },
    /** Picks a person (a Staff overview card was pressed): the tiles follow them. */
    select: id => {
      world.selected = id;
      for (const v of views) v.told = '';
      wake();
    },
    /** Moves the office on by `seconds` without waiting for frames (for checks; the screen draws as usual). */
    advance: seconds => {
      world.seenAt = performance.now();
      for (let t = 0; t < seconds; t += 0.05) step(0.05);
      for (const v of views.filter(shown)) {
        draw(v);
        tell(v);
      }
    },
    /** The person followed now (their id), or null. */
    picked: () => world.selected,
    /** Who is on a break in a deck chair now (ids): Staff overview's cards say so (a PC that is off says PC off). */
    breaks: () => [...world.people.values()].filter(breakOf).map(p => p.id),
    /** Where someone is in the office (units of the 1200 x 940 picture) and the words said for them. */
    where: id => {
      const visitor = { boss, courier, it }[id];
      if (['boss', 'courier', 'it'].includes(id)) return visitor ? { x: visitor.x, y: visitor.y, walking: visitor.path.length > 0, phase: visitor.phase } : null;
      const p = world.people.get(id);
      return p ? { x: p.x, y: p.y, walking: p.path.length > 0, carrying: !!p.carry, words: wordsOf(p) } : null;
    },
  };
})();
