import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_load.mjs';

const { perft } = await load('chess.js');
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const KIWIPETE = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
const POS3 = '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1';
const POS4 = 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1';
const POS5 = 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8';

// Node counts published for these positions (the perft tables every move generator is tested with).
const table = [
  ['start, depth 1', START, 1, 20], ['start, depth 2', START, 2, 400], ['start, depth 3', START, 3, 8902],
  ['kiwipete, depth 1 (castling both sides, pins)', KIWIPETE, 1, 48], ['kiwipete, depth 2', KIWIPETE, 2, 2039], ['kiwipete, depth 3', KIWIPETE, 3, 97862],
  ['position 3, depth 1 (en passant that exposes the king)', POS3, 1, 14], ['position 3, depth 2', POS3, 2, 191], ['position 3, depth 3', POS3, 3, 2812], ['position 3, depth 4', POS3, 4, 43238],
  ['position 4, depth 1 (promotions, castling out of check)', POS4, 1, 6], ['position 4, depth 2', POS4, 2, 264], ['position 4, depth 3', POS4, 3, 9467],
  ['position 5, depth 1 (promotion with check)', POS5, 1, 44], ['position 5, depth 2', POS5, 2, 1486], ['position 5, depth 3', POS5, 3, 62379],
  ['start, depth 4', START, 4, 197281],
];
for (const [name, fen, depth, want] of table) test(name, { timeout: 120000 }, () => assert.equal(perft(fen, depth), want));

test('depth 0 is one position', () => assert.equal(perft(START, 0), 1));
test('checkmate has no moves', () => assert.equal(perft('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3', 1), 0));
