// The arcade machine's games, once it is bought for the lounge (public/office.js): click the machine in the office, or
// Play on its card under Look after the team, and pick one. Three small games on one screen: Tetris, Lunar Lander and
// Moon Rover. They run only while their screen has the keyboard (click it), and each game's best score is kept in this
// browser. Uses app.js's el; adds only app.arcade.
'use strict';

(() => {
  /** The screen, in game units (drawn twice as sharp). */
  const W = 480;
  const H = 360;
  const COLOURS = ['#69bfe9', '#efbd72', '#b29be4', '#78c6a3', '#ef8a91', '#74a7d0', '#f2a65a'];

  const bestOf = (id) => { try { return Number(localStorage.getItem(`tomlin-arcade-${id}`)) || 0; } catch { return 0; } };
  const keepBest = (id, n) => { try { if (n > bestOf(id)) localStorage.setItem(`tomlin-arcade-${id}`, String(n)); } catch { /* kept for this visit only */ } };

  function text(c, s, x, y, size, col = '#e8ecf2', align = 'left', weight = 700) {
    c.font = `${weight} ${size}px Segoe UI, system-ui, sans-serif`;
    c.textAlign = align;
    c.fillStyle = col;
    c.fillText(s, x, y);
    c.textAlign = 'left';
  }
  function cell(c, x, y, s, col) {
    c.fillStyle = col;
    c.fillRect(x + 1, y + 1, s - 2, s - 2);
    c.fillStyle = 'rgba(255, 255, 255, 0.28)';
    c.fillRect(x + 1, y + 1, s - 2, 3);
  }
  /** A line across the middle of the screen, with a smaller one under it (game over, landed, paused). */
  function banner(c, big, small) {
    c.fillStyle = 'rgba(8, 12, 24, 0.78)';
    c.fillRect(0, H / 2 - 42, W, small ? 78 : 56);
    text(c, big, W / 2, H / 2 - 6, 26, '#ffffff', 'center', 800);
    if (small) text(c, small, W / 2, H / 2 + 24, 15, '#cfd8e3', 'center', 600);
  }
  const stars = Array.from({ length: 60 }, (_, i) => [(i * 97) % W, (i * 53) % (H - 80), (i % 3) + 1]);
  function sky(c, top = '#0b1020', bottom = '#1c2541') {
    const g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);
    c.fillStyle = 'rgba(255, 255, 255, 0.7)';
    for (const [x, y, s] of stars) c.fillRect(x, y, s * 0.8, s * 0.8);
  }

  // ---- Tetris: a 10 x 20 well, the seven pieces from a shuffled bag, the next one shown ----

  const SHAPES = [
    [[0, 1], [1, 1], [2, 1], [3, 1]], // I
    [[0, 0], [1, 0], [0, 1], [1, 1]], // O
    [[1, 0], [0, 1], [1, 1], [2, 1]], // T
    [[1, 0], [2, 0], [0, 1], [1, 1]], // S
    [[0, 0], [1, 0], [1, 1], [2, 1]], // Z
    [[0, 0], [0, 1], [1, 1], [2, 1]], // J
    [[2, 0], [0, 1], [1, 1], [2, 1]], // L
  ];
  const BOX = [4, 2, 3, 3, 3, 3, 3];
  function tetris() {
    const S = 16;
    const X0 = 160;
    const Y0 = 20;
    const g = {
      id: 'tetris', score: 0, lines: 0, level: 1, over: false, well: [], bag: [], piece: null, next: 0, fall: 0, slide: {},
    };
    const take = () => {
      if (!g.bag.length) g.bag = [0, 1, 2, 3, 4, 5, 6].sort(() => Math.random() - 0.5);
      return g.bag.pop();
    };
    const cells = (p) => p.cells.map(([x, y]) => [x + p.x, y + p.y]);
    const fits = (p) => cells(p).every(([x, y]) => x >= 0 && x < 10 && y < 20 && (y < 0 || !g.well[y][x]));
    function spawn() {
      const k = g.next;
      g.next = take();
      g.piece = { k, cells: SHAPES[k].map((c) => [...c]), x: k === 1 ? 4 : 3, y: k === 0 ? -1 : 0 };
      if (!fits(g.piece)) g.over = true;
    }
    function reset() {
      g.well = Array.from({ length: 20 }, () => Array(10).fill(0));
      Object.assign(g, { score: 0, lines: 0, level: 1, over: false, bag: [], fall: 0 });
      g.next = take();
      spawn();
    }
    const move = (dx, dy) => {
      const p = { ...g.piece, x: g.piece.x + dx, y: g.piece.y + dy };
      if (!fits(p)) return false;
      g.piece = p;
      return true;
    };
    function turn() {
      if (g.piece.k === 1) return;
      const n = BOX[g.piece.k];
      const turned = { ...g.piece, cells: g.piece.cells.map(([x, y]) => [n - 1 - y, x]) };
      // Against a wall or a stack: tried one and two squares either side before giving up.
      for (const dx of [0, -1, 1, -2, 2]) {
        const p = { ...turned, x: turned.x + dx };
        if (fits(p)) { g.piece = p; return; }
      }
    }
    function lock() {
      for (const [x, y] of cells(g.piece)) {
        if (y < 0) { g.over = true; return; }
        g.well[y][x] = g.piece.k + 1;
      }
      const full = g.well.filter((r) => r.every(Boolean)).length;
      if (full) {
        g.well = [...Array.from({ length: full }, () => Array(10).fill(0)), ...g.well.filter((r) => !r.every(Boolean))];
        g.lines += full;
        g.score += [0, 100, 300, 500, 800][full] * g.level;
        g.level = 1 + Math.floor(g.lines / 10);
      }
      spawn();
    }
    reset();
    return {
      id: 'tetris',
      score: () => g.score,
      press(k) {
        if (g.over) { if (k === 'space' || k === 'enter') reset(); return; }
        if (k === 'up') turn();
        else if (k === 'left' || k === 'right') { move(k === 'left' ? -1 : 1, 0); g.slide = { k, wait: 0.17 }; }
        else if (k === 'down') { if (move(0, 1)) g.score += 1; }
        else if (k === 'space') {
          let n = 0;
          while (move(0, 1)) n++;
          g.score += n * 2;
          lock();
          g.fall = 0;
        }
      },
      step(dt, held) {
        if (g.over) return;
        // A side key held down keeps moving the piece, after a short wait.
        if (g.slide.k && held.has(g.slide.k)) {
          g.slide.wait -= dt;
          if (g.slide.wait <= 0) { move(g.slide.k === 'left' ? -1 : 1, 0); g.slide.wait = 0.055; }
        } else g.slide = {};
        const every = held.has('down') ? 0.04 : Math.max(0.08, 0.8 - (g.level - 1) * 0.07);
        g.fall += dt;
        while (g.fall >= every) {
          g.fall -= every;
          if (move(0, 1)) { if (held.has('down')) g.score += 1; } else { lock(); break; }
        }
      },
      draw(c) {
        sky(c, '#10162b', '#1b2440');
        c.fillStyle = '#070b16';
        c.fillRect(X0 - 4, Y0 - 4, 10 * S + 8, 20 * S + 8);
        c.strokeStyle = '#3a4a6b';
        c.lineWidth = 2;
        c.strokeRect(X0 - 4, Y0 - 4, 10 * S + 8, 20 * S + 8);
        g.well.forEach((r, y) => r.forEach((v, x) => { if (v) cell(c, X0 + x * S, Y0 + y * S, S, COLOURS[v - 1]); }));
        if (!g.over) {
          // Where it would land, faintly; then the piece itself.
          let drop = 0;
          while (fits({ ...g.piece, y: g.piece.y + drop + 1 })) drop++;
          c.globalAlpha = 0.22;
          for (const [x, y] of cells({ ...g.piece, y: g.piece.y + drop })) if (y >= 0) cell(c, X0 + x * S, Y0 + y * S, S, COLOURS[g.piece.k]);
          c.globalAlpha = 1;
          for (const [x, y] of cells(g.piece)) if (y >= 0) cell(c, X0 + x * S, Y0 + y * S, S, COLOURS[g.piece.k]);
        }
        text(c, 'NEXT', 360, 44, 14, '#9fb0c8');
        for (const [x, y] of SHAPES[g.next]) cell(c, 360 + x * S, 58 + y * S, S, COLOURS[g.next]);
        text(c, 'SCORE', 24, 44, 14, '#9fb0c8');
        text(c, String(g.score), 24, 68, 22);
        text(c, 'LINES', 24, 108, 14, '#9fb0c8');
        text(c, String(g.lines), 24, 132, 22);
        text(c, 'LEVEL', 24, 172, 14, '#9fb0c8');
        text(c, String(g.level), 24, 196, 22);
        text(c, 'BEST', 24, 236, 14, '#9fb0c8');
        text(c, String(Math.max(bestOf('tetris'), g.score)), 24, 260, 22);
        if (g.over) { keepBest('tetris', g.score); banner(c, 'Game over', `${g.score} points · Space for a new game`); }
      },
    };
  }

  // ---- Lunar Lander: gravity pulls, the engine pushes; land gently and upright on a green pad ----

  function lander() {
    const GRAVITY = 16;
    const THRUST = 42;
    const g = { score: 0, round: 1, ship: null, ground: [], pads: [], state: 'flying', bits: [], fuel: 100 };
    function makeGround() {
      const pts = [];
      let y = H - 60;
      for (let x = 0; x <= W; x += 16) {
        y = Math.max(H - 150, Math.min(H - 16, y + (Math.random() - 0.5) * 46));
        pts.push([x, y]);
      }
      // Three pads, flattened: the narrower the pad, the more it is worth.
      const pads = [];
      for (const [wide, worth] of [[5, 2], [4, 3], [3, 5]].sort(() => Math.random() - 0.5)) {
        for (let tries = 0; tries < 30; tries++) {
          const at = 2 + Math.floor(Math.random() * (pts.length - wide - 4));
          if (pads.some((p) => at < p.at + p.wide + 2 && at + wide + 2 > p.at)) continue;
          const py = pts[at][1];
          for (let k = 0; k <= wide; k++) pts[at + k][1] = py;
          pads.push({ at, wide, worth, x0: pts[at][0], x1: pts[at + wide][0], y: py });
          break;
        }
      }
      g.ground = pts;
      g.pads = pads;
    }
    function groundY(x) {
      const i = Math.max(0, Math.min(g.ground.length - 2, Math.floor(x / 16)));
      const [ax, ay] = g.ground[i];
      const [bx, by] = g.ground[i + 1];
      return ay + ((by - ay) * (x - ax)) / (bx - ax || 1);
    }
    function round() {
      makeGround();
      g.ship = { x: 40, y: 40, vx: 28, vy: 0, a: 0, burn: false };
      g.state = 'flying';
      g.bits = [];
    }
    function reset() {
      Object.assign(g, { score: 0, round: 1, fuel: 100 });
      round();
    }
    reset();
    const safe = (s) => Math.abs(s.vy) < 24 && Math.abs(s.vx) < 16 && Math.abs(s.a) < 0.22;
    return {
      id: 'lander',
      score: () => g.score,
      press(k) {
        if (k !== 'enter' && k !== 'space') return;
        if (g.state === 'landed') { g.round++; g.fuel = Math.min(100, g.fuel + 35); round(); }
        else if (g.state === 'crashed' && k === 'enter') reset();
      },
      step(dt, held) {
        for (const b of g.bits) { b.x += b.vx * dt; b.y += b.vy * dt; b.vy += GRAVITY * dt; b.life -= dt; }
        g.bits = g.bits.filter((b) => b.life > 0);
        if (g.state !== 'flying') return;
        const s = g.ship;
        if (held.has('left')) s.a = Math.max(-1.5, s.a - 2.4 * dt);
        if (held.has('right')) s.a = Math.min(1.5, s.a + 2.4 * dt);
        s.burn = (held.has('up') || held.has('space')) && g.fuel > 0;
        s.vy += GRAVITY * dt;
        if (s.burn) {
          s.vx += Math.sin(s.a) * THRUST * dt;
          s.vy -= Math.cos(s.a) * THRUST * dt;
          g.fuel = Math.max(0, g.fuel - 9 * dt);
        }
        s.x = (s.x + s.vx * dt + W) % W;
        s.y += s.vy * dt;
        if (s.y + 9 < groundY(s.x)) return;
        const pad = g.pads.find((p) => s.x - 6 >= p.x0 && s.x + 6 <= p.x1);
        if (pad && safe(s)) {
          s.y = pad.y - 9;
          g.state = 'landed';
          g.won = 50 * pad.worth + Math.round(g.fuel);
          g.score += g.won;
        } else {
          g.state = 'crashed';
          keepBest('lander', g.score);
          for (let i = 0; i < 26; i++) g.bits.push({ x: s.x, y: s.y, vx: (Math.random() - 0.5) * 120, vy: -Math.random() * 90, life: 1 + Math.random(), col: COLOURS[i % COLOURS.length] });
        }
      },
      draw(c) {
        sky(c);
        c.beginPath();
        c.moveTo(0, H);
        for (const [x, y] of g.ground) c.lineTo(x, y);
        c.lineTo(W, H);
        c.closePath();
        c.fillStyle = '#5b6478';
        c.fill();
        c.strokeStyle = '#a7b1c4';
        c.lineWidth = 2;
        c.stroke();
        for (const p of g.pads) {
          c.fillStyle = '#4fd18b';
          c.fillRect(p.x0, p.y - 2, p.x1 - p.x0, 4);
          text(c, `×${p.worth}`, (p.x0 + p.x1) / 2, p.y + 18, 13, '#4fd18b', 'center');
        }
        const s = g.ship;
        if (g.state !== 'crashed') {
          c.save();
          c.translate(s.x, s.y);
          c.rotate(s.a);
          if (s.burn) {
            c.beginPath();
            c.moveTo(-4, 8);
            c.lineTo(0, 16 + Math.random() * 8);
            c.lineTo(4, 8);
            c.fillStyle = '#f2a65a';
            c.fill();
          }
          c.fillStyle = '#d9e2ec';
          c.beginPath();
          c.arc(0, -2, 7, 0, Math.PI * 2);
          c.fill();
          c.fillStyle = '#69bfe9';
          c.beginPath();
          c.arc(0, -3, 3, 0, Math.PI * 2);
          c.fill();
          c.strokeStyle = '#d9e2ec';
          c.lineWidth = 2;
          c.beginPath();
          c.moveTo(-5, 3); c.lineTo(-9, 9);
          c.moveTo(5, 3); c.lineTo(9, 9);
          c.stroke();
          c.restore();
        }
        for (const b of g.bits) { c.fillStyle = b.col; c.fillRect(b.x, b.y, 3, 3); }
        // Fuel, and each speed in green while it is gentle enough to land.
        c.fillStyle = '#26314d';
        c.fillRect(16, 16, 120, 10);
        c.fillStyle = g.fuel > 20 ? '#efbd72' : '#ef8a91';
        c.fillRect(16, 16, 1.2 * g.fuel, 10);
        text(c, `Fuel ${Math.round(g.fuel)}`, 144, 26, 13);
        text(c, `Down ${Math.round(s.vy)}`, 16, 46, 13, Math.abs(s.vy) < 24 ? '#4fd18b' : '#ef8a91');
        text(c, `Across ${Math.round(Math.abs(s.vx))}`, 16, 64, 13, Math.abs(s.vx) < 16 ? '#4fd18b' : '#ef8a91');
        text(c, `Score ${g.score}`, W - 16, 26, 14, '#e8ecf2', 'right');
        text(c, `Best ${Math.max(bestOf('lander'), g.score)} · Round ${g.round}`, W - 16, 44, 13, '#9fb0c8', 'right');
        if (g.state === 'landed') banner(c, 'The Eagle has landed', `+${g.won} points · Enter for the next landing`);
        else if (g.state === 'crashed') banner(c, 'Crashed', `${g.score} points · Enter to start again`);
      },
    };
  }

  // ---- Moon Rover: drive a buggy across rugged moon ground from the lander to the outpost. Low gravity throws it off
  // the crests; tip it in the air so it lands on its wheels, and pick up batteries before the power runs out ----

  function rover() {
    const GRAVITY = 120;
    const MOTOR = 70;
    const TOP = 150;
    const STEP = 4;
    const START = 150;
    /** How long this run's moon is, and where the outpost stands (set with the ground). */
    let LENGTH = 6000;
    let FINISH = LENGTH - 160;
    const g = {};
    /** The ground's height at every STEP across the world: a flat pad for the lander, then small craters, deeper ones,
     * a hill, hard craters and the last climb to the outpost, all roughened so no stretch is smooth. */
    function makeGround() {
      const phase = Math.random() * 100;
      const features = [];
      let x = 420;
      const add = (kind, w, h) => { features.push({ kind, c: x + w / 2, r: w / 2, h }); x += w + 50 + Math.random() * 70; };
      for (let i = 0; i < 5; i++) add('crater', 70 + Math.random() * 40, 16 + Math.random() * 14);
      for (let i = 0; i < 4; i++) add('crater', 130 + Math.random() * 50, 45 + Math.random() * 20);
      add('hill', 520, 110);
      for (let i = 0; i < 5; i++) add('crater', 90 + Math.random() * 30, 55 + Math.random() * 20);
      add('climb', 500, 70);
      for (let i = 0; i < 3; i++) add('crater', 70 + Math.random() * 40, 20 + Math.random() * 15);
      LENGTH = Math.ceil((x + 300) / STEP) * STEP;
      FINISH = LENGTH - 160;
      const n = LENGTH / STEP + 1;
      const ys = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const wx = i * STEP;
        let y = 270;
        for (const f of features) {
          const d = (wx - f.c) / f.r;
          if (f.kind === 'crater') {
            if (Math.abs(d) < 1) y += f.h * (1 - d * d);
            // A raised rim round each crater.
            y -= f.h * 0.35 * Math.exp(-((((Math.abs(d) - 1.05) * f.r) / 10) ** 2));
          } else if (f.kind === 'hill') {
            if (Math.abs(d) < 1) y -= f.h * (0.5 + 0.5 * Math.cos(Math.PI * d));
          } else if (wx > f.c - f.r) y -= f.h * Math.min(1, (wx - (f.c - f.r)) / (2 * f.r));
        }
        // Rugged everywhere but under the lander and at the outpost.
        const rough = wx < START + 60 || wx > FINISH - 40 ? 0 : 1;
        y += rough * (3.2 * Math.sin(wx / 11 + phase) + 1.6 * Math.sin(wx / 6.3 + phase * 2) + 0.6 * Math.sin(wx / 3.1 + phase * 3));
        ys[i] = y;
      }
      g.ground = ys;
      // Batteries stand on the ground along the way.
      g.cells = [];
      for (let bx = 700; bx < FINISH - 200; bx += 620 + Math.random() * 260) g.cells.push({ x: bx, got: false });
    }
    function groundY(wx) {
      const f = Math.max(0, Math.min(LENGTH - 1, wx)) / STEP;
      const i = Math.floor(f);
      return g.ground[i] + (g.ground[Math.min(g.ground.length - 1, i + 1)] - g.ground[i]) * (f - i);
    }
    const slopeAt = (wx) => Math.atan2(groundY(wx + 12) - groundY(wx - 12), 24);
    function reset() {
      makeGround();
      Object.assign(g, { x: START, y: groundY(START), vx: 0, vy: 0, a: 0, w: 0, air: false, power: 100, got: 0, state: 'driving', stall: 0, t: 0, dust: [] });
    }
    reset();
    const metres = () => Math.max(0, Math.round((g.x - START) / 2));
    const score = () => metres() + g.got * 50 + (g.state === 'finished' ? Math.round(g.power) * 5 : 0);
    const end = (state, why) => { g.state = state; g.why = why; keepBest('rover', score()); };
    return {
      id: 'rover',
      score,
      /** Where the buggy is (for the checks that drive it without a screen). */
      look: () => ({ air: g.air, a: g.a, x: g.x, finish: FINISH }),
      press(k) { if (k === 'enter' && g.state !== 'driving') reset(); },
      step(dt, held) {
        for (const d of g.dust) { d.x += d.vx * dt; d.y += d.vy * dt; d.vy += GRAVITY * dt; d.life -= dt; }
        g.dust = g.dust.filter((d) => d.life > 0);
        if (g.state !== 'driving' || !(dt > 0)) return;
        g.t += dt;
        const go = held.has('right') || held.has('up');
        const back = held.has('left');
        const powered = g.power > 0;
        g.power = Math.max(0, g.power - ((go || back) && powered ? 5 : 0.4) * dt);
        if (!g.air) {
          const s = slopeAt(g.x);
          g.a = s;
          // The hill pulls along the slope; the motor pushes; Left brakes, then reverses.
          let acc = GRAVITY * Math.sin(s);
          if (go && powered) acc += MOTOR;
          if (back) acc += g.vx > 5 ? -140 : powered ? -45 : 0;
          // Coasting: the dust slows it, to a stop and no further.
          if (!go && !back) acc -= Math.sign(g.vx) * Math.min(Math.abs(g.vx) / dt, 18);
          g.vx = Math.max(-50, Math.min(TOP, g.vx + acc * dt));
          const nx = Math.max(START, g.x + g.vx * Math.cos(s) * dt);
          if (nx === START && g.vx < 0) g.vx = 0;
          const gy = groundY(nx);
          // The ground falls away faster than the wheels can follow it down: off the crest and into the air.
          const fly = g.y + g.vy * dt + GRAVITY * dt * dt;
          if (fly < gy - 1.5 && Math.abs(g.vx) > 25) {
            g.air = true;
            g.vy += GRAVITY * dt;
            g.y = fly;
            g.w = 0;
          } else {
            g.vy = (gy - g.y) / Math.max(dt, 0.001);
            g.y = gy;
          }
          g.x = nx;
          if (go && powered && Math.random() < 0.4) g.dust.push({ x: g.x - 18, y: g.y - 2, vx: -20 - Math.random() * 30, vy: -20 - Math.random() * 20, life: 0.6 });
        } else {
          // In the air a turning wheel turns the buggy: drive tips the nose up, brake tips it down.
          if (go && powered) g.w -= 3.2 * dt;
          if (back && powered) g.w += 3.2 * dt;
          g.w = Math.max(-3, Math.min(3, g.w));
          g.a += g.w * dt;
          g.vy += GRAVITY * dt;
          g.x = Math.max(START, g.x + g.vx * dt);
          g.y += g.vy * dt;
          const gy = groundY(g.x);
          if (g.y >= gy) {
            const s = slopeAt(g.x);
            let rel = (g.a - s) % (Math.PI * 2);
            if (rel > Math.PI) rel -= Math.PI * 2;
            if (rel < -Math.PI) rel += Math.PI * 2;
            g.y = gy;
            if (Math.abs(rel) > 1.9) {
              for (let i = 0; i < 24; i++) g.dust.push({ x: g.x, y: g.y - 6, vx: (Math.random() - 0.5) * 120, vy: -Math.random() * 80, life: 1 + Math.random(), col: COLOURS[i % COLOURS.length] });
              return end('crashed', 'On its roof');
            }
            // Down on its wheels, from any height: the speed along the ground carries on.
            g.air = false;
            g.vx *= Math.max(0.4, Math.cos(rel));
            g.a = s;
            g.w = 0;
            g.vy = 0;
            for (let i = 0; i < 6; i++) g.dust.push({ x: g.x + (Math.random() - 0.5) * 30, y: g.y, vx: (Math.random() - 0.5) * 50, vy: -Math.random() * 30, life: 0.5 });
          }
        }
        for (const c of g.cells) {
          if (!c.got && Math.abs(c.x - g.x) < 18 && g.y > groundY(c.x) - 26) { c.got = true; g.got++; g.power = Math.min(100, g.power + 40); }
        }
        if (g.x >= FINISH) return end('finished', 'Outpost reached');
        // No power and as good as stopped on the ground, for a moment: the run is over.
        g.stall = !g.power && !g.air && Math.abs(g.vx) < 4 ? g.stall + dt : 0;
        if (g.stall > 1.5) end('stalled', 'Out of power');
      },
      draw(c) {
        sky(c, '#050814', '#141c33');
        c.fillStyle = '#4a90c8';
        c.beginPath();
        c.arc(410, 56, 20, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = '#78c6a3';
        c.beginPath();
        c.arc(404, 51, 7, 0, Math.PI * 2);
        c.fill();
        // The camera keeps the buggy a third of the way across.
        const cam = Math.max(0, Math.min(LENGTH - W, g.x - 150));
        c.beginPath();
        c.moveTo(0, H);
        for (let sx = 0; sx <= W; sx += 2) c.lineTo(sx, groundY(cam + sx));
        c.lineTo(W, H);
        c.closePath();
        c.fillStyle = '#5b6478';
        c.fill();
        c.strokeStyle = '#a7b1c4';
        c.lineWidth = 2;
        c.stroke();
        // The lander at the start, on its pad, and the outpost flag at the end.
        const lx = START - 70 - cam;
        if (lx > -80) {
          const ly = groundY(START - 70);
          c.fillStyle = '#4fd18b';
          c.fillRect(lx - 34, ly - 2, 68, 4);
          c.strokeStyle = '#cfd8e3';
          c.lineWidth = 2;
          c.beginPath();
          c.moveTo(lx - 22, ly); c.lineTo(lx - 14, ly - 22);
          c.moveTo(lx + 22, ly); c.lineTo(lx + 14, ly - 22);
          c.stroke();
          c.fillStyle = '#d9e2ec';
          c.fillRect(lx - 18, ly - 46, 36, 26);
          c.fillStyle = '#69bfe9';
          c.fillRect(lx - 6, ly - 40, 12, 8);
          c.strokeStyle = '#9aa2b4';
          c.beginPath();
          c.moveTo(lx + 18, ly - 22); c.lineTo(lx + 52, ly);
          c.stroke();
        }
        const fx = FINISH - cam;
        if (fx < W + 20) {
          const fy = groundY(FINISH);
          c.strokeStyle = '#e8ecf2';
          c.lineWidth = 2;
          c.beginPath();
          c.moveTo(fx, fy); c.lineTo(fx, fy - 46);
          c.stroke();
          c.fillStyle = '#ef8a91';
          c.beginPath();
          c.moveTo(fx, fy - 46); c.lineTo(fx + 24, fy - 39); c.lineTo(fx, fy - 32);
          c.fill();
          text(c, 'OUTPOST', fx, fy + 18, 12, '#e8ecf2', 'center');
        }
        for (const b of g.cells) {
          if (b.got) continue;
          const bx = b.x - cam;
          if (bx < -10 || bx > W + 10) continue;
          const by = groundY(b.x);
          c.fillStyle = '#4fd18b';
          c.fillRect(bx - 5, by - 18, 10, 16);
          c.fillStyle = '#e8ecf2';
          c.fillRect(bx - 2, by - 21, 4, 3);
        }
        for (const d of g.dust) { c.fillStyle = d.col || '#a7b1c4'; c.fillRect(d.x - cam, d.y, 2, 2); }
        // The buggy at its angle: two wheels, the body over them, a cab and an aerial.
        if (g.state !== 'crashed') {
          c.save();
          c.translate(g.x - cam, g.y);
          c.rotate(g.a);
          c.fillStyle = '#efbd72';
          c.fillRect(-18, -16, 36, 9);
          c.fillStyle = '#69bfe9';
          c.fillRect(-4, -23, 14, 7);
          c.strokeStyle = '#e8ecf2';
          c.lineWidth = 2;
          c.beginPath();
          c.moveTo(-13, -16); c.lineTo(-17, -32);
          c.stroke();
          const spin = g.x / 6;
          for (const wx of [-12, 12]) {
            c.fillStyle = '#1c2541';
            c.beginPath();
            c.arc(wx, -5, 6, 0, Math.PI * 2);
            c.fill();
            c.strokeStyle = '#cfd8e3';
            c.stroke();
            c.beginPath();
            c.moveTo(wx, -5); c.lineTo(wx + 5 * Math.cos(spin), -5 + 5 * Math.sin(spin));
            c.stroke();
          }
          c.restore();
        }
        c.fillStyle = '#26314d';
        c.fillRect(16, 16, 120, 10);
        c.fillStyle = g.power > 25 ? '#4fd18b' : '#ef8a91';
        c.fillRect(16, 16, 1.2 * g.power, 10);
        text(c, `Power ${Math.round(g.power)}`, 144, 26, 13);
        text(c, `${metres()} m of ${Math.round((FINISH - START) / 2)} m`, 16, 46, 13, '#9fb0c8');
        text(c, `Score ${score()}`, W - 16, 26, 14, '#e8ecf2', 'right');
        text(c, `Best ${Math.max(bestOf('rover'), score())}`, W - 16, 44, 13, '#9fb0c8', 'right');
        if (g.state !== 'driving') banner(c, g.why, `${score()} points · Enter to drive again`);
      },
    };
  }

  // ---- The machine: a cabinet with its marquee, its screen (the menu, or the game) and its control panel ----

  const GAMES = [
    { id: 'tetris', name: 'Tetris', make: tetris, about: 'Fit the falling pieces into full lines.', keys: '← → move · ↑ turns · ↓ falls faster · Space drops' },
    { id: 'lander', name: 'Lunar Lander', make: lander, about: 'Land gently and upright on a green pad.', keys: '↑ or Space fires the engine · ← → tilt · Enter lands again' },
    { id: 'rover', name: 'Moon Rover', make: rover, about: 'Drive the rugged ground to the outpost; land on your wheels.', keys: '→ or ↑ drives · ← brakes and reverses · in the air → ← tip it · Enter drives again' },
  ];
  const KEY = { ArrowLeft: 'left', a: 'left', A: 'left', ArrowRight: 'right', d: 'right', D: 'right', ArrowUp: 'up', w: 'up', W: 'up', ArrowDown: 'down', s: 'down', S: 'down', ' ': 'space', Enter: 'enter' };
  const held = new Set();
  let running = null;
  /** One drawing loop at a time, whichever game is on. */
  let looping = false;
  let last = 0;
  /** The game last picked: the menu comes back with it chosen. */
  let chosen = 0;

  function frame(now) {
    const r = running;
    if (!r || !r.canvas.isConnected) { stop(r); looping = false; return; }
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
    last = now;
    const playing = document.activeElement === r.canvas && !document.hidden;
    // The first frame of a game has no time gone by yet: nothing moves until there is.
    if (playing && dt > 0) r.game.step(dt, held);
    const c = r.ctx;
    c.setTransform(r.canvas.width / W, 0, 0, r.canvas.height / H, 0, 0);
    r.game.draw(c);
    // Without the keyboard the game waits, and says how to carry on.
    if (!playing) banner(c, 'Paused', 'Click the screen to play');
    requestAnimationFrame(frame);
  }
  document.addEventListener('keydown', (e) => {
    const k = KEY[e.key];
    if (!running || !k || document.activeElement !== running.canvas) return;
    e.preventDefault();
    if (!e.repeat) running.game.press(k);
    held.add(k);
  });
  document.addEventListener('keyup', (e) => { if (KEY[e.key]) held.delete(KEY[e.key]); });
  window.addEventListener('blur', () => held.clear());

  /** The game put away (closed, or another picked): its score so far still counts for its best. */
  function stop(r = running) {
    if (r) keepBest(r.game.id, r.game.score());
    if (r === running) running = null;
    held.clear();
  }

  /** A small picture of each game for the menu (64 x 48, drawn twice as sharp). */
  function icon(id) {
    const cv = el('canvas', { class: 'cab-icon', width: 128, height: 96, 'aria-hidden': 'true' });
    const c = cv.getContext('2d');
    c.scale(2, 2);
    c.fillStyle = '#070b16';
    c.fillRect(0, 0, 64, 48);
    if (id === 'tetris') {
      for (const [x, y, k] of [[20, 6, 2], [28, 6, 2], [36, 6, 2], [28, 14, 2], [8, 38, 0], [16, 38, 0], [24, 38, 0], [32, 38, 0], [40, 30, 1], [48, 30, 1], [40, 38, 1], [48, 38, 1]]) cell(c, x, y, 8, COLOURS[k]);
    } else if (id === 'lander') {
      c.fillStyle = '#5b6478';
      c.beginPath();
      c.moveTo(0, 48); c.lineTo(0, 36); c.lineTo(14, 30); c.lineTo(24, 40); c.lineTo(42, 40); c.lineTo(52, 30); c.lineTo(64, 34); c.lineTo(64, 48);
      c.fill();
      c.fillStyle = '#4fd18b';
      c.fillRect(24, 39, 18, 3);
      c.fillStyle = '#f2a65a';
      c.beginPath(); c.moveTo(30, 24); c.lineTo(33, 32); c.lineTo(36, 24); c.fill();
      c.fillStyle = '#d9e2ec';
      c.beginPath(); c.arc(33, 17, 6, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#69bfe9';
      c.beginPath(); c.arc(33, 16, 2.5, 0, Math.PI * 2); c.fill();
    } else {
      c.fillStyle = '#7a8296';
      c.fillRect(0, 38, 64, 10);
      c.fillStyle = '#070b16';
      c.fillRect(42, 38, 14, 10);
      c.fillStyle = '#efbd72';
      c.fillRect(8, 24, 24, 8);
      c.fillStyle = '#69bfe9';
      c.fillRect(17, 18, 9, 6);
      c.fillStyle = '#cfd8e3';
      for (const x of [11, 20, 29]) { c.beginPath(); c.arc(x, 35, 3.5, 0, Math.PI * 2); c.fill(); }
      c.fillStyle = '#4a90c8';
      c.beginPath(); c.arc(52, 10, 6, 0, Math.PI * 2); c.fill();
    }
    return cv;
  }
  /** A button on the control panel: a round cap with its word under it. */
  const panelButton = (word, kind, onclick) => el('button', { type: 'button', class: `cab-btn ${kind}`, onclick }, el('span', { class: 'cab-cap', 'aria-hidden': 'true' }), el('span', { class: 'cab-label', text: word }));
  /** The cabinet round a screen: the lit marquee (with what is on), the screen in its bezel, the panel, the coin door. */
  // The machine's own window, over the office (Esc closes it; the game's score so far counts for its best).
  const box = el('dialog', { class: 'arcade-box', 'aria-label': 'Arcade', onclose: () => stop() });
  document.body.append(box);
  const closeWindow = () => { if (box.open) box.close(); };
  function showCabinet(title, sub, screen, buttons, keys) {
    box.setAttribute('aria-label', title);
    box.replaceChildren(el('div', { class: 'cabinet' },
      el('div', { class: 'cab-marquee' }, el('span', { class: 'cab-brand', text: 'ARCADE' }), el('span', { class: 'cab-sub', text: sub })),
      el('div', { class: 'cab-bezel' }, el('div', { class: 'cab-screen' }, screen)),
      el('div', { class: 'cab-panel' }, el('span', { class: 'cab-stick', 'aria-hidden': 'true' }, el('span')), el('div', { class: 'cab-buttons' }, ...buttons)),
      el('p', { class: 'cab-keys', text: keys }),
      el('div', { class: 'cab-coin', 'aria-hidden': 'true' }, el('span', { text: 'FREE PLAY' }))));
    if (!box.open) box.showModal();
  }
  function play(g) {
    stop();
    chosen = GAMES.indexOf(g);
    const canvas = el('canvas', { width: W * 2, height: H * 2, tabindex: '0', role: 'img', 'aria-label': `${g.name}. ${g.keys}.`, onblur: () => held.clear() });
    showCabinet(`Arcade: ${g.name}`, g.name, canvas, [panelButton('Games', 'back', pick), panelButton('Close', 'exit', closeWindow)], g.keys);
    running = { canvas, ctx: canvas.getContext('2d'), game: g.make() };
    last = 0;
    canvas.focus();
    if (!looping) { looping = true; requestAnimationFrame(frame); }
  }
  /** The machine's menu, on its screen: one line per game with its picture and its best score here. */
  function pick() {
    stop();
    const picks = GAMES.map((g, i) => el('button', { type: 'button', class: 'cab-pick', onclick: () => play(g), onfocus: () => { chosen = i; } },
      icon(g.id), el('span', { class: 'cab-pick-text' }, el('b', { text: g.name }), el('span', { text: g.about }),
        el('span', { class: 'cab-best', text: bestOf(g.id) ? `Best ${bestOf(g.id).toLocaleString()}` : 'Not played yet' }))));
    // Up and down move along the list, as a joystick would.
    const list = el('ul', { class: 'cab-list', onkeydown: (e) => {
      const d = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      picks[(picks.indexOf(document.activeElement) + d + picks.length) % picks.length].focus();
    } }, ...picks.map((b) => el('li', {}, b)));
    const menu = el('div', { class: 'cab-menu' }, el('p', { class: 'cab-title', text: 'SELECT GAME' }), list, el('p', { class: 'cab-hint', text: '↑ ↓ choose · Enter plays' }));
    showCabinet('Arcade', 'Tetris · Lunar Lander · Moon Rover', menu, [panelButton('Play', 'go', () => play(GAMES[chosen])), panelButton('Close', 'exit', closeWindow)],
      'Click a game, or choose with ↑ ↓ and press Enter. A game plays while its screen has the keyboard.');
    picks[chosen].focus();
  }
  app.arcade = { open: pick };
})();
