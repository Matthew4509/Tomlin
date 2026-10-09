// A hire's look (src/look.ts): the little person drawn for them. Two drawings from one look: the portrait (head and
// shoulders, front on) used as their round picture when they have no photo, and the person seen from above that walks
// around the office game, facing south, east, north or west. The parts and their colours come from /api/faces
// (faces.js passes them in), so this file only knows shapes. The editor (Staff > Edit Staff > Look, and Hire staff > Change look) picks
// the parts and shows both drawings as they change. Uses app.js's el.
'use strict';

(() => {
  const INK = '#27364e';
  let options = null;
  const pictures = new Map();

  const colourOf = (kind, id) => options?.[kind]?.find(o => o.id === id)?.colour ?? '#999';
  const nameOf = (kind, id) => options?.[kind]?.find(o => o.id === id)?.name ?? id;

  /** A colour made darker (f below 1) or lighter (f above 1), for shading. */
  function shade(hex, f) {
    const n = parseInt(hex.slice(1), 16);
    const ch = s => Math.max(0, Math.min(255, Math.round(f < 1 ? ((n >> s) & 255) * f : 255 - (255 - ((n >> s) & 255)) * (2 - f))));
    return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`;
  }

  function oval(c, x, y, rx, ry, fill, stroke = INK, width = 2) {
    c.beginPath();
    c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    c.fillStyle = fill;
    c.fill();
    if (stroke) { c.strokeStyle = stroke; c.lineWidth = width; c.stroke(); }
  }
  function box(c, x, y, w, h, r, fill, stroke = INK, width = 2) {
    c.beginPath();
    c.roundRect(x, y, w, h, r);
    c.fillStyle = fill;
    c.fill();
    if (stroke) { c.strokeStyle = stroke; c.lineWidth = width; c.stroke(); }
  }
  function line(c, x, y, xx, yy, col = INK, width = 2) {
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(xx, yy);
    c.strokeStyle = col;
    c.lineWidth = width;
    c.lineCap = 'round';
    c.stroke();
  }
  /** The top half of an ellipse, closed along its middle: the hair cap and the cap's dome. */
  function dome(c, x, y, rx, ry, fill, stroke = INK, width = 2) {
    c.beginPath();
    c.ellipse(x, y, rx, ry, 0, Math.PI, Math.PI * 2);
    c.closePath();
    c.fillStyle = fill;
    c.fill();
    if (stroke) { c.strokeStyle = stroke; c.lineWidth = width; c.stroke(); }
  }

  // ---- The portrait: drawn on a 100 x 100 square, scaled to the size asked for ----

  function portrait(c, look, size, { round = true } = {}) {
    const skin = colourOf('skin', look.skin);
    const hair = colourOf('hairColour', look.hairColour);
    const top = colourOf('top', look.top);
    c.save();
    c.scale(size / 100, size / 100);
    if (round) {
      c.beginPath();
      c.arc(50, 50, 50, 0, Math.PI * 2);
      c.clip();
    }
    c.fillStyle = '#e3ebf3';
    c.fillRect(0, 0, 100, 100);
    // Behind the head: long hair, a bob's sides, the afro, a bun, a ponytail.
    if (look.hair === 'afro') {
      for (const [x, y] of [[50, 30], [30, 38], [70, 38], [36, 22], [64, 22], [27, 52], [73, 52]]) oval(c, x, y, 17, 17, hair, null);
      oval(c, 50, 38, 33, 30, hair);
    }
    if (look.hair === 'long') box(c, 21, 34, 58, 56, 14, hair);
    if (look.hair === 'bob') box(c, 23, 30, 54, 36, 12, hair);
    if (look.hair === 'bun') oval(c, 50, 16, 11, 10, hair);
    if (look.hair === 'ponytail') oval(c, 76, 56, 7, 15, hair);
    // Shoulders, neck, ears, head.
    const wide = look.gender === 'man' ? 34 : look.gender === 'woman' ? 28 : 31;
    box(c, 50 - wide, 76, wide * 2, 40, 22, top);
    line(c, 44, 78, 50, 86, shade(top, 0.75), 2);
    line(c, 56, 78, 50, 86, shade(top, 0.75), 2);
    box(c, 43, 62, 14, 16, 4, skin, null);
    oval(c, 27, 47, 5, 7, skin);
    oval(c, 73, 47, 5, 7, skin);
    oval(c, 50, 45, 23, 25, skin);
    // Facial hair under the face's features.
    if (look.facial === 'stubble') {
      c.save();
      c.globalAlpha = 0.28;
      c.beginPath();
      c.ellipse(50, 56, 19, 13, 0, 0, Math.PI);
      c.fillStyle = hair;
      c.fill();
      c.restore();
    }
    if (look.facial === 'beard') {
      c.beginPath();
      c.moveTo(28, 46);
      c.quadraticCurveTo(29, 74, 50, 74);
      c.quadraticCurveTo(71, 74, 72, 46);
      c.quadraticCurveTo(66, 58, 50, 58);
      c.quadraticCurveTo(34, 58, 28, 46);
      c.fillStyle = hair;
      c.fill();
      c.strokeStyle = INK;
      c.lineWidth = 2;
      c.stroke();
    }
    // Eyes, brows, cheeks, mouth.
    for (const dx of [-9, 9]) {
      oval(c, 50 + dx, 45, 5, 6, '#fff', INK, 1.5);
      oval(c, 51 + dx, 46, 2.6, 3.4, INK, null);
      line(c, 46 + dx, 36, 54 + dx, 35 + (dx < 0 ? 1 : 0), look.hair === 'bald' ? shade(skin, 0.6) : hair, 2.5);
    }
    if (look.gender === 'woman') {
      line(c, 36, 41, 33, 39, INK, 1.5);
      line(c, 64, 41, 67, 39, INK, 1.5);
    }
    c.save();
    c.globalAlpha = 0.35;
    oval(c, 35, 54, 4, 2.5, '#ef8a91', null);
    oval(c, 65, 54, 4, 2.5, '#ef8a91', null);
    c.restore();
    if (look.facial === 'moustache') {
      oval(c, 45, 56, 6, 2.6, hair, INK, 1.5);
      oval(c, 55, 56, 6, 2.6, hair, INK, 1.5);
    }
    c.beginPath();
    c.arc(50, look.facial === 'moustache' ? 59 : 56, 6, 0.15, Math.PI - 0.15);
    c.strokeStyle = INK;
    c.lineWidth = 2;
    c.stroke();
    // Hair over the forehead.
    portraitHair(c, look.hair, hair);
    // Glasses, then whatever is on the head.
    portraitGlasses(c, look.glasses);
    portraitHeadwear(c, look.headwear, top);
    c.restore();
  }

  function portraitHair(c, style, hair) {
    if (style === 'bald') {
      c.save();
      c.globalAlpha = 0.5;
      oval(c, 40, 27, 5, 2.5, '#fff', null);
      c.restore();
      return;
    }
    if (style === 'buzz') {
      c.save();
      c.globalAlpha = 0.8;
      dome(c, 50, 38, 23, 17, hair, null);
      c.restore();
      return;
    }
    if (style === 'curly' || style === 'afro') {
      dome(c, 50, 37, 24, 18, hair);
      for (let a = Math.PI * 1.05; a <= Math.PI * 1.96; a += Math.PI / 7) oval(c, 50 + Math.cos(a) * 22, 37 + Math.sin(a) * 16, 6.5, 6.5, hair, INK, 1.5);
      return;
    }
    if (style === 'side-part') {
      dome(c, 50, 37, 24, 18, hair);
      c.beginPath();
      c.moveTo(27, 42);
      c.quadraticCurveTo(30, 26, 58, 26);
      c.quadraticCurveTo(70, 27, 74, 40);
      c.quadraticCurveTo(62, 31, 27, 42);
      c.fillStyle = hair;
      c.fill();
      c.strokeStyle = INK;
      c.lineWidth = 2;
      c.stroke();
      return;
    }
    if (style === 'bob') {
      dome(c, 50, 38, 25, 19, hair);
      box(c, 27, 30, 46, 7, 3, hair, null);
      line(c, 27, 37, 73, 37, INK, 2);
      return;
    }
    if (style === 'long') {
      dome(c, 50, 38, 25, 19, hair);
      c.beginPath();
      c.moveTo(50, 22);
      c.quadraticCurveTo(38, 30, 27, 44);
      c.moveTo(50, 22);
      c.quadraticCurveTo(62, 30, 73, 44);
      c.strokeStyle = INK;
      c.lineWidth = 2;
      c.stroke();
      return;
    }
    if (style === 'ponytail' || style === 'bun') {
      // Pulled back: smooth, no fringe.
      dome(c, 50, 37, 24, 17, hair);
      line(c, 34, 27, 46, 22, shade(hair, 1.35), 1.5);
      return;
    }
    // 'short'
    dome(c, 50, 37, 24, 18, hair);
    for (const [x, y] of [[33, 37], [44, 35], [56, 35], [67, 37]]) oval(c, x, y, 6, 3.5, hair, null);
  }

  function portraitGlasses(c, kind) {
    if (kind === 'none') return;
    if (kind === 'round') {
      oval(c, 41, 45, 7.5, 7.5, 'rgba(255,255,255,0.15)', INK, 2);
      oval(c, 59, 45, 7.5, 7.5, 'rgba(255,255,255,0.15)', INK, 2);
    } else if (kind === 'sun') {
      box(c, 32, 40, 15, 10, 4, '#1f2733');
      box(c, 53, 40, 15, 10, 4, '#1f2733');
    } else {
      // 'square'
      box(c, 33, 39.5, 15, 11, 3, 'rgba(255,255,255,0.15)', INK, 2);
      box(c, 52, 39.5, 15, 11, 3, 'rgba(255,255,255,0.15)', INK, 2);
    }
    line(c, 47.5, 44, 52.5, 44, INK, 2);
    line(c, 27, 44, 32.5, 43, INK, 2);
    line(c, 73, 44, 67.5, 43, INK, 2);
  }

  function portraitHeadwear(c, kind, top) {
    const hat = shade(top, 0.72);
    if (kind === 'beret') {
      c.beginPath();
      c.ellipse(53, 22, 25, 9, -0.15, 0, Math.PI * 2);
      c.fillStyle = hat;
      c.fill();
      c.strokeStyle = INK;
      c.lineWidth = 2;
      c.stroke();
      line(c, 55, 13, 56, 9, INK, 2.5);
    } else if (kind === 'cap') {
      dome(c, 50, 31, 25, 15, hat);
      oval(c, 50, 31, 27, 4.5, shade(hat, 0.85));
      oval(c, 50, 18, 2.5, 2.5, shade(hat, 0.85), INK, 1.5);
    } else if (kind === 'beanie') {
      box(c, 25, 13, 50, 22, 12, hat);
      box(c, 24, 28, 52, 8, 3, shade(hat, 0.85));
      oval(c, 50, 11, 5, 5, shade(hat, 1.4));
    } else if (kind === 'headphones') {
      c.beginPath();
      c.arc(50, 44, 27, Math.PI * 1.05, Math.PI * 1.95);
      c.strokeStyle = '#2c3442';
      c.lineWidth = 5;
      c.stroke();
      box(c, 19, 38, 10, 17, 4, '#2c3442');
      box(c, 71, 38, 10, 17, 4, '#2c3442');
    } else if (kind === 'bow') {
      c.beginPath();
      c.moveTo(66, 24);
      c.lineTo(56, 16);
      c.lineTo(57, 31);
      c.closePath();
      c.moveTo(66, 24);
      c.lineTo(77, 16);
      c.lineTo(76, 31);
      c.closePath();
      c.fillStyle = hat;
      c.fill();
      c.strokeStyle = INK;
      c.lineWidth = 2;
      c.stroke();
      oval(c, 66, 24, 3.5, 3.5, shade(hat, 0.8));
    }
  }

  // ---- The person seen from above, as the office game draws its staff (about 50 units tall, standing at x, y) ----

  /**
   * face: 'south' (towards you), 'north' (back of the head), 'east' or 'west'. opts.walk bobs the step, opts.time is the
   * clock in seconds, opts.seed offsets the step so two walkers do not move as one.
   */
  function sprite(c, look, x, y, face = 'south', { walk = false, time = 0, seed = 0 } = {}) {
    const skin = colourOf('skin', look.skin);
    const hair = colourOf('hairColour', look.hairColour);
    const top = colourOf('top', look.top);
    const bob = walk ? Math.sin(time * 12 + seed) * 2 : 0;
    y += bob;
    oval(c, x - 6, y + 13, 5, 6, INK);
    oval(c, x + 6, y + 13 - (walk ? bob : 0), 5, 6, INK);
    // Long hair behind the body when seen from the front.
    if (face === 'south' && look.hair === 'long') box(c, x - 15, y - 18, 30, 24, 8, hair);
    if (face === 'south' && look.hair === 'bob') box(c, x - 15, y - 18, 30, 14, 6, hair);
    if (look.hair === 'afro') oval(c, face === 'east' ? x - 3 : face === 'west' ? x + 3 : x, y - 15, 18, 17, hair);
    const w = look.gender === 'woman' ? 18 : look.gender === 'man' ? 22 : 20;
    box(c, x - w / 2, y - 2, w, 20, 7, top);
    oval(c, x - w / 2 - 3, y + 5, 4, 5, skin);
    oval(c, x + w / 2 + 3, y + 5, 4, 5, skin);
    if (face === 'north') spriteBack(c, look, x, y, hair, skin);
    else if (face === 'east' || face === 'west') spriteSide(c, look, x, y, face === 'east' ? 1 : -1, hair, skin);
    else spriteFront(c, look, x, y, hair, skin);
    spriteHeadwear(c, look.headwear, x, y, face, shade(top, 0.72));
  }

  function spriteBack(c, look, x, y, hair, skin) {
    if (look.hair === 'long') box(c, x - 14, y - 22, 28, 28, 10, hair);
    if (look.hair === 'ponytail') oval(c, x, y + 1, 4, 9, hair);
    oval(c, x, y - 12, 15, 15, look.hair === 'bald' ? skin : hair);
    if (look.hair === 'bun') oval(c, x, y - 27, 6, 6, hair);
    if (look.hair === 'curly') for (const dx of [-9, 0, 9]) oval(c, x + dx, y - 22, 5, 5, hair, INK, 1.5);
    if (look.hair !== 'bald' && look.hair !== 'buzz') line(c, x - 7, y - 21, x + 4, y - 24, shade(hair, 1.35), 2);
  }

  function spriteSide(c, look, x, y, s, hair, skin) {
    if (look.hair === 'long') box(c, x - s * 14 - 6, y - 22, 14, 28, 6, hair);
    if (look.hair === 'ponytail') oval(c, x - s * 16, y - 9, 4, 9, hair);
    oval(c, x, y - 12, 13, 15, skin);
    if (look.hair !== 'bald') {
      const big = look.hair === 'buzz' ? [6, 11] : look.hair === 'curly' ? [10, 15] : [8, 13];
      oval(c, x - s * 7, y - 16, big[0], big[1], hair, null);
      if (look.hair === 'bob') box(c, x - s * 4 - 7, y - 16, 14, 16, 5, hair, null);
    }
    if (look.hair === 'bun') oval(c, x - s * 8, y - 28, 5, 5, hair);
    oval(c, x + s * 12, y - 9, 4, 4, skin);
    oval(c, x + s * 5, y - 15, 4, 5, '#fff');
    oval(c, x + s * 6, y - 14, 2, 3, INK, null);
    if (look.facial === 'beard') oval(c, x + s * 3, y - 3, 9, 6, hair);
    else if (look.facial === 'moustache') line(c, x + s * 7, y - 6, x + s * 11, y - 6, hair, 3);
    else line(c, x + s * 7, y - 5, x + s * 10, y - 6, INK, 1.5);
    if (look.glasses !== 'none') {
      box(c, x + s * 5 - 4.5, y - 19, 9, 8, 2, look.glasses === 'sun' ? '#1f2733' : 'rgba(255,255,255,0.1)', INK, 1.5);
      line(c, x + s * 1, y - 15, x - s * 6, y - 15, INK, 1.5);
    }
  }

  function spriteFront(c, look, x, y, hair, skin) {
    oval(c, x, y - 12, 15, 15, skin);
    if (look.facial === 'stubble') {
      c.save();
      c.globalAlpha = 0.3;
      c.beginPath();
      c.ellipse(x, y - 7, 11, 7, 0, 0, Math.PI);
      c.fillStyle = hair;
      c.fill();
      c.restore();
    }
    if (look.facial === 'beard') {
      c.beginPath();
      c.moveTo(x - 14, y - 12);
      c.quadraticCurveTo(x - 12, y + 3, x, y + 3);
      c.quadraticCurveTo(x + 12, y + 3, x + 14, y - 12);
      c.quadraticCurveTo(x, y - 4, x - 14, y - 12);
      c.fillStyle = hair;
      c.fill();
    }
    // Hair on top, by style.
    if (look.hair === 'buzz') {
      c.save();
      c.globalAlpha = 0.8;
      c.beginPath();
      c.arc(x, y - 16, 14, Math.PI, Math.PI * 2);
      c.fillStyle = hair;
      c.fill();
      c.restore();
    } else if (look.hair !== 'bald') {
      c.beginPath();
      c.arc(x, y - 17, 14, Math.PI, Math.PI * 2);
      c.fillStyle = hair;
      c.fill();
      if (look.hair === 'curly' || look.hair === 'afro') for (const dx of [-10, -3, 4, 11]) oval(c, x + dx, y - 26 + Math.abs(dx) / 3, 5, 5, hair, null);
      if (look.hair === 'side-part') oval(c, x + 4, y - 22, 11, 5, hair, null);
      if (look.hair === 'bob' || look.hair === 'short') box(c, x - 13, y - 20, 26, 4, 2, hair, null);
    }
    if (look.hair === 'bun') oval(c, x, y - 32, 6, 5, hair);
    oval(c, x - 5, y - 14, 4, 5, '#fff');
    oval(c, x + 5, y - 14, 4, 5, '#fff');
    oval(c, x - 4, y - 13, 2, 3, INK, null);
    oval(c, x + 6, y - 13, 2, 3, INK, null);
    if (look.gender === 'woman') {
      line(c, x - 9, y - 17, x - 11, y - 19, INK, 1.2);
      line(c, x + 9, y - 17, x + 11, y - 19, INK, 1.2);
    }
    if (look.facial === 'moustache') line(c, x - 4, y - 7, x + 4, y - 7, hair, 3);
    c.beginPath();
    c.arc(x, y - 7, 5, 0, Math.PI);
    c.strokeStyle = INK;
    c.lineWidth = 1.5;
    c.stroke();
    if (look.glasses !== 'none') {
      const fill = look.glasses === 'sun' ? '#1f2733' : 'rgba(255,255,255,0.1)';
      if (look.glasses === 'round') {
        oval(c, x - 5, y - 14, 5.5, 5.5, fill, INK, 1.5);
        oval(c, x + 5, y - 14, 5.5, 5.5, fill, INK, 1.5);
      } else {
        box(c, x - 11, y - 19, 10, 9, 2, fill, INK, 1.5);
        box(c, x + 1, y - 19, 10, 9, 2, fill, INK, 1.5);
      }
    }
  }

  function spriteHeadwear(c, kind, x, y, face, hat) {
    const s = face === 'east' ? 1 : face === 'west' ? -1 : 0;
    if (kind === 'beret') {
      c.beginPath();
      c.ellipse(x + 2, y - 27, 14, 5, -0.15, 0, Math.PI * 2);
      c.fillStyle = hat;
      c.fill();
      c.strokeStyle = INK;
      c.lineWidth = 1.5;
      c.stroke();
    } else if (kind === 'cap') {
      c.beginPath();
      c.arc(x, y - 19, 15, Math.PI, Math.PI * 2);
      c.closePath();
      c.fillStyle = hat;
      c.fill();
      c.strokeStyle = INK;
      c.lineWidth = 1.5;
      c.stroke();
      if (face === 'south') oval(c, x, y - 19, 16, 3.5, shade(hat, 0.85), INK, 1.5);
      else if (s) oval(c, x + s * 16, y - 19, 9, 3, shade(hat, 0.85), INK, 1.5);
    } else if (kind === 'beanie') {
      box(c, x - 14, y - 32, 28, 15, 8, hat, INK, 1.5);
      oval(c, x, y - 33, 4, 4, shade(hat, 1.4), INK, 1.5);
    } else if (kind === 'headphones') {
      c.beginPath();
      c.arc(x, y - 13, 17, Math.PI * 1.1, Math.PI * 1.9);
      c.strokeStyle = '#2c3442';
      c.lineWidth = 3;
      c.stroke();
      if (face === 'south' || face === 'north') {
        box(c, x - 19, y - 17, 6, 10, 3, '#2c3442', null);
        box(c, x + 13, y - 17, 6, 10, 3, '#2c3442', null);
      } else box(c, x - 4, y - 18, 8, 11, 3, '#2c3442', null);
    } else if (kind === 'bow') {
      const bx = s ? x - s * 6 : x + 9;
      c.beginPath();
      c.moveTo(bx, y - 26);
      c.lineTo(bx - 7, y - 31);
      c.lineTo(bx - 7, y - 21);
      c.closePath();
      c.moveTo(bx, y - 26);
      c.lineTo(bx + 7, y - 31);
      c.lineTo(bx + 7, y - 21);
      c.closePath();
      c.fillStyle = hat;
      c.fill();
      c.strokeStyle = INK;
      c.lineWidth = 1.2;
      c.stroke();
    }
  }

  // ---- Looks made up: for a new hire (Shuffle), and for someone with none saved (the game still needs a person) ----

  /** A small seeded random (mulberry32), so the same hire always gets the same made-up look. */
  function seeded(text) {
    let h = 2166136261;
    for (const ch of String(text)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    return () => {
      h = (h + 0x6d2b79f5) | 0;
      let t = Math.imul(h ^ (h >>> 15), 1 | h);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** A made-up look. The role leans it a little: designers and artists towards a beret, coders towards headphones. */
  function random(role = '', rnd = Math.random) {
    if (!options) return null;
    const any = kind => options[kind][Math.floor(rnd() * options[kind].length)].id;
    const from = list => list[Math.floor(rnd() * list.length)];
    const gender = any('gender');
    const hair = gender === 'woman' ? from(['long', 'bob', 'ponytail', 'bun', 'curly', 'afro', 'short', 'side-part'])
      : gender === 'man' ? from(['short', 'buzz', 'side-part', 'curly', 'afro', 'bald', 'short', 'long'])
        : any('hair');
    const hairColour = rnd() < 0.08 ? from(['blue', 'pink']) : from(['black', 'dark-brown', 'brown', 'auburn', 'ginger', 'blonde', 'black', 'dark-brown', 'grey']);
    const lean = { designer: ['beret', 0.45], artist: ['beret', 0.45], coder: ['headphones', 0.4], writer: ['none', 1], pm: ['none', 1] }[role];
    const headwear = lean && rnd() < lean[1] ? lean[0] : rnd() < 0.2 ? any('headwear') : 'none';
    const glassesOdds = role === 'writer' || role === 'coder' ? 0.5 : 0.25;
    return {
      gender,
      skin: any('skin'),
      hair,
      hairColour,
      top: any('top'),
      glasses: rnd() < glassesOdds ? from(['square', 'round']) : rnd() < 0.05 ? 'sun' : 'none',
      facial: gender === 'man' && rnd() < 0.45 ? from(['stubble', 'beard', 'moustache']) : 'none',
      headwear: headwear === 'bow' && gender === 'man' ? 'none' : headwear,
    };
  }

  /** The look the office game draws for someone with none saved: made up, the same each time for the same hire. */
  const fromId = (id, role = '') => random(role, seeded(`look:${id}`));

  /** Their round picture (a PNG address), drawn once per look and kept. */
  function picture(look, px = 160) {
    const key = `${px}|${JSON.stringify(look)}`;
    if (!pictures.has(key)) {
      const cv = document.createElement('canvas');
      cv.width = px;
      cv.height = px;
      portrait(cv.getContext('2d'), look, px);
      pictures.set(key, cv.toDataURL('image/png'));
    }
    return pictures.get(key);
  }

  /** A canvas drawn sharp on a high-density screen, `css` pixels square on the page. */
  function sharpCanvas(css, cls) {
    const ratio = Math.min(3, window.devicePixelRatio || 1);
    const cv = el('canvas', { class: cls, width: Math.round(css * ratio), height: Math.round(css * ratio), 'aria-hidden': 'true' });
    cv.style.width = `${css}px`;
    cv.style.height = `${css}px`;
    return { cv, c: cv.getContext('2d'), ratio };
  }

  // ---- The editor ----

  /**
   * The parts, one tab each: its shapes (when it has any), and under them the one colour row, which colours the part on
   * the tab (skin, the hair, the top).
   */
  const PARTS = [
    { id: 'gender', label: 'Gender', shape: 'gender', show: 'text' },
    { id: 'skin', label: 'Skin', colour: 'skin' },
    { id: 'hair', label: 'Hair', shape: 'hair', show: 'face', colour: 'hairColour' },
    { id: 'top', label: 'Top', colour: 'top' },
    { id: 'glasses', label: 'Glasses', shape: 'glasses', show: 'face' },
    { id: 'facial', label: 'Facial hair', shape: 'facial', show: 'face' },
    { id: 'headwear', label: 'Headwear', shape: 'headwear', show: 'face' },
  ];
  const FACING = ['south', 'east', 'north', 'west'];

  /**
   * The look picker: both drawings on the left (the round picture, and the person turning round as the game shows them),
   * on the right the parts as tabs, the part's shapes, then one colour row. Shuffle makes a new one (leaning on `role`).
   * `extra` goes under Shuffle. Two ways to keep it:
   * - onChange(look): called with the whole look at every pick (Hire staff keeps it in its form);
   * - onSave(look): nothing is kept until Save is pressed (a hire's profile); `saved` says the look shown is the saved
   *   one (else Save is offered at once, for a made-up look). onSave returns false when it was not saved.
   */
  function editor({ look, role = '', onChange, onSave, saved = true, extra = null }) {
    let now = { ...look };
    let kept = saved ? { ...look } : null;
    let part = 'gender';
    const big = sharpCanvas(112, 'look-portrait');
    const walker = sharpCanvas(112, 'look-sprite');
    const tabs = el('div', { class: 'look-tabs', role: 'group', 'aria-label': 'Part to change' });
    const shapes = el('div', { class: 'look-choices look-shapes' });
    const colours = el('div', { class: 'look-colours' });
    const shuffle = el('button', { class: 'btn quiet', type: 'button', text: 'Shuffle', title: 'Make up a new look (you can change any part after)' });
    const saveBtn = onSave ? el('button', { class: 'btn primary', type: 'button', text: 'Save look' }) : null;
    const undo = onSave ? el('button', { class: 'btn quiet', type: 'button', text: 'Undo changes', title: 'Back to the look last saved' }) : null;
    const state = onSave ? el('span', { class: 'hint look-state', role: 'status' }) : null;
    const wrap = el('div', { class: 'look-editor' },
      el('div', { class: 'look-preview' },
        el('div', { class: 'look-pics' }, big.cv, walker.cv),
        el('p', { class: 'hint look-said', 'aria-live': 'polite' }),
        el('div', { class: 'look-buttons' }, shuffle, extra)),
      el('div', { class: 'look-side' }, tabs, shapes, colours,
        onSave ? el('div', { class: 'look-savebar' }, saveBtn, undo, state) : null));

    function said() {
      const low = (kind, id) => nameOf(kind, id).toLowerCase();
      const parts = [
        nameOf('gender', now.gender),
        `${low('skin', now.skin)} skin`,
        now.hair === 'bald' ? 'bald' : `${low('hairColour', now.hairColour)} hair (${low('hair', now.hair)})`,
        `${low('top', now.top)} top`,
        ...['glasses', 'facial', 'headwear'].filter(k => now[k] !== 'none').map(k => low(k, now[k])),
      ];
      return `${parts.join(', ')}.`;
    }

    /** One choice: a word (gender), a small portrait wearing it (hair, glasses, ...), or a colour with a tick. */
    function choice(kind, label, show, o) {
      const on = now[kind] === o.id;
      const b = el('button', { class: `look-choice look-${show}`, type: 'button', 'aria-pressed': on ? 'true' : 'false', 'data-key': `${kind}:${o.id}`, title: o.name, 'aria-label': `${label}: ${o.name}` });
      if (show === 'swatch') {
        b.style.background = o.colour;
        // The tick, so the chosen colour is told by shape as well as by the ring.
        if (on) b.append(el('span', { class: 'look-tick', 'aria-hidden': 'true', text: '✓' }));
      } else if (show === 'face') {
        const small = sharpCanvas(40, 'look-mini');
        const ask = kind === 'hair' && o.id !== 'bald' && now.headwear !== 'none' ? { ...now, [kind]: o.id, headwear: 'none' } : { ...now, [kind]: o.id };
        portrait(small.c, ask, 40 * small.ratio);
        b.append(small.cv, el('span', { text: o.name }));
      } else b.textContent = o.name;
      b.addEventListener('click', () => pickPart(kind, o.id));
      return b;
    }

    function drawRows(focusKey) {
      const p = PARTS.find(x => x.id === part);
      tabs.replaceChildren(...PARTS.map(x => {
        const b = el('button', { class: 'look-tab', type: 'button', 'aria-pressed': x.id === part ? 'true' : 'false', 'data-key': `tab:${x.id}`, text: x.label, title: `${x.label}: ${nameOf(x.shape ?? x.colour, now[x.shape ?? x.colour])}` });
        b.addEventListener('click', () => {
          part = x.id;
          drawRows(`tab:${x.id}`);
        });
        return b;
      }));
      shapes.hidden = !p.shape;
      if (p.shape) shapes.replaceChildren(...options[p.shape].map(o => choice(p.shape, p.label, p.show, o)));
      // The one colour row: the part on the tab (Hair: the hair's colour); a part with no colour says so.
      const colourLabel = p.id === 'hair' ? 'Hair colour' : `${p.label} colour`;
      colours.replaceChildren(
        el('span', { class: 'look-colour-k' }, 'Colour', p.colour ? el('strong', { text: `: ${nameOf(p.colour, now[p.colour])}` }) : null),
        p.colour ? el('div', { class: 'look-choices' }, ...options[p.colour].map(o => choice(p.colour, colourLabel, 'swatch', o)))
          : el('span', { class: 'hint', text: `${p.label} has no colour to pick: Skin, Hair and Top do.` }));
      if (focusKey) wrap.querySelector(`[data-key="${focusKey}"]`)?.focus();
      big.c.setTransform(1, 0, 0, 1, 0, 0);
      big.c.clearRect(0, 0, big.cv.width, big.cv.height);
      portrait(big.c, now, big.cv.width);
      wrap.querySelector('.look-said').textContent = said();
      drawSave();
    }

    /** Save and Undo (a profile): offered while what is shown is not the look last saved. */
    function drawSave() {
      if (!onSave) return;
      const changed = !kept || JSON.stringify(kept) !== JSON.stringify(now);
      saveBtn.disabled = !changed;
      undo.hidden = !changed || !kept;
      state.textContent = changed ? (kept ? 'Changed, not saved yet.' : 'Made up for now, not saved yet.') : 'Saved.';
    }

    function changedTo(look, focusKey) {
      now = look;
      drawRows(focusKey);
      if (!onSave) onChange?.({ ...now });
    }
    function pickPart(kind, id) {
      if (now[kind] !== id) changedTo({ ...now, [kind]: id }, `${kind}:${id}`);
    }
    shuffle.addEventListener('click', () => changedTo(random(role) ?? now));
    if (onSave) {
      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        const look = { ...now };
        if ((await onSave(look)) !== false) kept = look;
        drawSave();
      });
      undo.addEventListener('click', () => changedTo({ ...kept }));
    }

    // The person turns round, a quarter turn every 1.2 s, stepping in place. It draws only while on the page and
    // seen: the frame loop ends by itself once the editor is gone.
    let start = 0;
    function frame(t) {
      if (!wrap.isConnected) return;
      if (!start) start = t;
      const s = (t - start) / 1000;
      if (wrap.offsetParent !== null) {
        const c = walker.c;
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.clearRect(0, 0, walker.cv.width, walker.cv.height);
        c.fillStyle = '#e3ebf3';
        c.beginPath();
        c.roundRect(0, 0, walker.cv.width, walker.cv.height, 16 * walker.ratio);
        c.fill();
        const k = walker.cv.width / 112;
        c.setTransform(k * 1.9, 0, 0, k * 1.9, 0, 0);
        sprite(c, now, 29.5, 34, FACING[Math.floor(s / 1.2) % 4], { walk: true, time: s });
      }
      requestAnimationFrame(frame);
    }
    drawRows();
    requestAnimationFrame(frame);
    return wrap;
  }

  app.look = {
    setOptions: o => {
      if (o && typeof o === 'object') options = o;
    },
    ready: () => !!options,
    portrait,
    sprite,
    picture,
    random,
    fromId,
    editor,
  };
})();
