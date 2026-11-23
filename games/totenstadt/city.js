// Stadt von Totenstadt: Stadtplan per Wave Function Collapse mit Sockeln, Kacheln per Bau-Grammatik.
// Reines Generator-Modul (läuft im Worker): createGenerator({ seed }) für den Builder der Engine.
// Entities (Lichter, Behälter, Türen, Gebäude) meldet generate über ctx.add; den Türzustand liest es aus tile.state.
import { wfc } from '../../engine/gen/wfc.js';
import { planRooms } from '../../engine/gen/floorplan.js';
import { hash3, vnoise, mulberry32, pick, ri } from '../../engine/core/rand.js';
import { C, E, shade, jit } from '../../engine/core/voxel.js';
import { BIOME } from './biome.js';
import { VPM, M, SCALE, TS, GN, W, D, H, WALL_H, DOOR_H, DOOR_W, CLEAR, ROOF, WALLTOP, DOORLEAF, DOOROPEN, DIRS, GEN_VERSION, SUB } from './scale.js';

// ---- Kacheltypen und Sockel
//  Kante einer Straßenkachel: R (Straße, Kachel mit ≤ 2 Ästen), J (Straße an Kreuzung/T),
//  F (Straßenseite ohne Straße = Gehweg/Front). Grundstücke: L.
//  Erlaubt: R–R, R–J, F–L, L–L.  Verboten: J–J (Kreuzungen nebeneinander), F–F (Doppelstraße).
export const SR = 0, SJ = 1, SF = 2, SL = 3;
export const COMPAT = [[1, 1, 0, 0], [1, 0, 0, 0], [0, 0, 0, 1], [0, 0, 1, 1]];
export const TILES = [];
for (let m = 1; m < 16; m++) {
  const deg = (m & 1) + (m >> 1 & 1) + (m >> 2 & 1) + (m >> 3 & 1);
  const w = deg === 1 ? 0.25 : deg === 2 ? ((m === 5 || m === 10) ? 3 : 1.2) : deg === 3 ? 0.9 : 0.6;
  TILES.push({ kind: 'road', mask: m, deg, w });
}
TILES.push({ kind: 'haus', mask: 0, w: 18 }, { kind: 'laden', mask: 0, w: 4 }, { kind: 'park', mask: 0, w: 2.5 },
  { kind: 'parkplatz', mask: 0, w: 2 }, { kind: 'brache', mask: 0, w: 2 });
export const SOCK = TILES.map(t => [0, 1, 2, 3].map(d => t.kind !== 'road' ? SL : (t.mask >> d & 1) ? (t.deg >= 3 ? SJ : SR) : SF));
const CROSS = TILES.findIndex(t => t.mask === 15);
/** Zahl der Kacheltypen des alten Stadtplans (Generator v4). Neue Typen nur dahinter anhängen. */
export const OLD_TILES = TILES.length;
const OLD_W = TILES.map(t => t.w);
// Weltplaner (Generator v5): Wirtschaftswege, Gärten, Wiesen, Felder, Wald, Höfe (Zufahrt aus einer Richtung)
for (let m = 1; m < 16; m++) {
  const deg = (m & 1) + (m >> 1 & 1) + (m >> 2 & 1) + (m >> 3 & 1);
  TILES.push({ kind: 'weg', mask: m, deg, w: 0 });
}
TILES.push({ kind: 'garten', mask: 0, w: 0 }, { kind: 'wiese', mask: 0, w: 0 }, { kind: 'feld', mask: 0, w: 0 }, { kind: 'wald', mask: 0, w: 0 });
for (const m of [1, 2, 4, 8]) TILES.push({ kind: 'hof', mask: m, deg: 1, w: 0 });

/** Stadtplan: bester von bis zu 80 WFC-Läufen (Straßenanteil nahe 30 %). */
export function cityPlan(seed, n = GN) {
  const rng = mulberry32(seed);
  let res = null, bestErr = 9;
  const tries0 = n > 24 ? 12 : 80;
  for (let tries = 0; tries < tries0; tries++) {
    const r = wfc(n, rng, { weights: OLD_W, sockets: SOCK, compat: COMPAT, border: s => s >= SF, seed: { cell: (n >> 1) * n + (n >> 1), tile: CROSS } });
    if (!r) continue;
    const err = Math.abs(r.grid.filter(t => TILES[t].kind === 'road').length / (n * n) - 0.3);
    if (err < bestErr) { bestErr = err; res = r; }
    if (err < (n > 24 ? 0.05 : 0.04)) break;
  }
  return res;
}

const PLAN_OPT = { min: SCALE.zimmerMin, doorW: DOOR_W, windowW: SCALE.fenster.breite, bigWindowW: M(2) };

// ---- Türen: Lücke in der Wand, Blatt geschlossen in der Lücke oder offen senkrecht dazu
export function doorCells(dr) {
  const gap = [], leaf = [];
  for (let k = 0; k < DOOR_W; k++) gap.push(dr.v ? [dr.x, dr.y + k] : [dr.x + k, dr.y]);
  for (let k = 1; k <= DOOR_W; k++) leaf.push(dr.v ? [dr.x + dr.swing * k, dr.y] : [dr.x, dr.y + dr.swing * k]);
  return { gap, leaf };
}
export function doorVoxels(dr, set, getLay) {
  const { gap, leaf } = doorCells(dr);
  for (const [x, y] of gap) for (let z = 1; z <= DOOR_H; z++) set(x, y, z, 0);
  for (const [x, y] of leaf) for (let z = 1; z <= DOOR_H; z++) if (getLay(x, y, z) & DOORLEAF) set(x, y, z, 0);
  if (dr.broken) return;
  const cells = dr.open ? leaf : gap;
  cells.forEach(([x, y], k) => {
    for (let z = 1; z <= DOOR_H; z++) {
      const edge = k === 0 || k === DOOR_W - 1 || z === DOOR_H;
      const c = dr.glass ? (edge ? 0x3a3c42 : 0x2a4458) : (edge ? shade(dr.col, 0.75) : (z === 6 && k === DOOR_W - 2 ? 0xc8b060 : jit(dr.col, 0.1, hash3(x, y, z))));
      set(x, y, z, C(c), DOORLEAF | (dr.open ? DOOROPEN : 0) | (z >= 5 ? WALLTOP : 0));
    }
  });
}
export const doorCenter = dr => [dr.x + (dr.v ? 0.5 : DOOR_W / 2), dr.y + (dr.v ? DOOR_W / 2 : 0.5)];

/** Kollision: Dach nie, offenes Türblatt nie (Flag DOOROPEN), sonst alles. Rein aus den Flags, darum auch im Worker. */
export const blocks = (x, y, z, l) => !(l & ROOF) && !(l & DOOROPEN);

/** Generator für den Builder der Engine (Worker oder synchron). config = { seed, plan? } */
export function createGenerator(config) {
  const plan = config.plan || cityPlan(config.seed);
  const grid = plan.grid;
  const tileKind = (tx, ty) => (tx < 0 || ty < 0 || tx >= GN || ty >= GN) ? null : TILES[grid[ty * GN + tx]];
  const roadDirs = (tx, ty) => [0, 1, 2, 3].filter(d => { const k = tileKind(tx + DIRS[d][0], ty + DIRS[d][1]); return k && k.kind === 'road'; });
  const bio = plan.biom ? BIOME[plan.biom] : BIOME.gemaessigt;
  return { tileSize: TS, tilesX: GN, tilesY: GN, height: H, version: plan.version || GEN_VERSION, sub: SUB, voxelSize: 1 / VPM, blocks, generate };

  function generate(tile, vol, ctx) {
  const key = tile.key, tx = tile.tx, ty = tile.ty, rng = ctx.rng, doorState = (ctx.state && ctx.state.doors) || [];
  const tileDoors = [];
  const ox = ctx.ox, oy = ctx.oy;
  const S = (x, y, z, c, l = 0) => { if (x >= 0 && y >= 0 && x < TS && y < TS) vol.set(x, y, z, c, l); };
  const box = (x0, y0, x1, y1, z0, z1, c, l = 0) => {
    for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const v = typeof c === 'function' ? c(x, y, z) : c; if (v !== undefined) S(x, y, z, v, l);
    }
  };
  const grass = (x, y) => { const gx = ox + x, gy = oy + y, h = hash3(gx, gy, 1), n = vnoise(gx / 14, gy / 14, 5); return n > 0.62 ? jit(0x3b3328, 0.3, h) : jit(0x2c3a24, 0.32, h); };
  const addLight = (x, y, z, r, c, i, type) => ctx.add('light', { x: ox + x, y: oy + y, z, r, c, i, type, seed: rng() * 100 });
  const addCont = (x, y, name, kind, r) => ctx.add('cont', { x: ox + x, y: oy + y, name, kind, r: r ? [ox + r[0], oy + r[1], ox + r[2] + 1, oy + r[3] + 1] : null });
  const addFlame = (x, y, bz) => ctx.add('flame', { x: ox + x, y: oy + y, bz });
  const addDoor = (x, y, v, swing, opt) => {
    const r = rng(), idx = tileDoors.length, st = doorState[idx];
    const dr = { x: ox + x, y: oy + y, v, swing, open: st ? st[0] : r < (opt.openP ?? 0.55), broken: st ? st[1] : r > 0.93, hp: st ? st[2] : 6, glass: !!opt.glass, col: opt.col ?? 0x6a4a2e, idx };
    tileDoors.push(dr); ctx.add('door', dr);
  };
  const t = TILES[grid[key]];

  // ---------- Straßenmöbel ----------
  function lamp(x, y, tx2, ty2) {
    const top = SCALE.laterne;
    for (let z = 1; z <= top; z++) S(x, y, z, C(0x3d4048));
    const dx = Math.sign(Math.round(tx2 - x)), dy = Math.sign(Math.round(ty2 - y));
    for (let k = 1; k <= 5; k++) S(x + dx * k, y + dy * k, top, C(0x3d4048));
    const hx = x + dx * 5, hy = y + dy * 5, r = rng();
    if (r < 0.15) { S(hx, hy, top - 1, C(0x2a2a2a)); return; }
    S(hx, hy, top - 1, E(0xffd9a0)); S(hx + (dy ? 1 : 0), hy + (dx ? 1 : 0), top - 1, E(0xffd9a0));
    addLight(hx + 0.5, hy + 0.5, top - 2, 60, [1.0, 0.72, 0.42], 1.4, r < 0.35 ? 'flicker' : 'lamp');
  }
  const CAR_COL = [0x8a2a24, 0x2c4a78, 0xb8b4aa, 0x2d2f33, 0x4e6b3a, 0xc29a2a, 0x6a6e74];
  function car(cx, cy, horiz, burning) {
    const L = SCALE.auto.l, Wd = SCALE.auto.b, col = pick(rng, CAR_COL);
    const x0 = Math.round(cx - (horiz ? L : Wd) / 2), y0 = Math.round(cy - (horiz ? Wd : L) / 2);
    const flip = rng() < 0.5;
    for (let a = 0; a < L; a++) for (let b = 0; b < Wd; b++) {
      const x = x0 + (horiz ? a : b), y = y0 + (horiz ? b : a), hh = hash3(ox + x, oy + y, 7), fa = flip ? L - 1 - a : a;
      const wheel = (fa >= 3 && fa <= 6 || fa >= L - 7 && fa <= L - 4) && (b === 0 || b === Wd - 1);
      for (let z = 1; z <= 8; z++) {
        let c = 0;
        if (z <= 4 && wheel) c = C(z === 2 || z === 3 ? 0x2a2c30 : 0x141518);
        else if (z >= 2 && z <= 5 && b > 0 && b < Wd - 1) c = C(burning ? jit(0x2b2725, 0.5, hh) : jit(col, 0.12, hh));
        else if (z >= 6 && fa >= 6 && fa <= L - 8 && b > 0 && b < Wd - 1) {
          const rim = fa === 6 || fa === L - 8 || b === 1 || b === Wd - 2;
          c = z === 8 ? C(burning ? 0x221f1d : jit(col, 0.12, hh)) : rim ? C(burning ? 0x111111 : 0x1e2838) : C(0x15171c);
        }
        if (z === 4 && fa === L - 1 && (b === 1 || b === 2 || b === Wd - 2 || b === Wd - 3) && !burning) c = C(0xd8d0a0);
        if (z === 4 && fa === 0 && (b === 1 || b === Wd - 2) && !burning) c = C(0x8a1a14);
        if (c) S(x, y, z, c);
      }
    }
    addCont(cx, cy, burning ? 'Ausgebranntes Auto' : 'Kofferraum', 'auto', [x0, y0, x0 + (horiz ? L : Wd) - 1, y0 + (horiz ? Wd : L) - 1]);
    if (burning) { addFlame(cx, cy, 9); addLight(cx, cy, 12, 50, [1.0, 0.5, 0.18], 2.2, 'fire'); }
  }
  function tree(x, y) {
    const th = ri(rng, 10, 13);
    for (let z = 1; z <= th; z++) for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) if (dx === 1 || dy === 1) S(x + dx, y + dy, z, C(jit(0x3a2a1e, 0.2, hash3(ox + x + dx, oy + y + dy, z))));
    const r = 6 + rng() * 2.5, cz = th + r - 2, leaf = pick(rng, [0x2f4a22, 0x3d5a26, 0x6a4a1e, 0x7a3a1a, 0x4a5a22]);
    for (let z = Math.floor(cz - r); z <= cz + r && z < H; z++) for (let dy = -10; dy <= 10; dy++) for (let dx = -10; dx <= 10; dx++) {
      const d = Math.hypot(dx, dy, (z - cz) * 1.25);
      if (d < r - hash3(ox + x + dx, oy + y + dy, z) * 1.5) S(x + 1 + dx, y + 1 + dy, z, C(jit(leaf, 0.45, hash3(ox + x + dx, oy + y + dy, z + 3))));
    }
  }
  function barrel(x, y) {
    for (let z = 1; z <= 5; z++) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      if (Math.hypot(dx, dy) > 2.2) continue;
      S(x + dx, y + dy, z, z === 5 && Math.hypot(dx, dy) < 1.5 ? E(jit(0xff7a2a, 0.5, hash3(dx, dy, z))) : C(jit(z === 2 || z === 4 ? 0x2a2e36 : 0x5a3424, 0.4, hash3(ox + x + dx, oy + y + dy, z))));
    }
    addFlame(x + 0.5, y + 0.5, 6);
    addLight(x + 0.5, y + 0.5, 9, 45, [1.0, 0.52, 0.2], 1.9, 'fire');
  }
  function crate(x, y, s, name, kind) {
    box(x, y, x + s - 1, y + s - 1, 1, s, (cx, cy, cz) => {
      const e = (cx === x || cx === x + s - 1) + (cy === y || cy === y + s - 1) + (cz === 1 || cz === s) >= 2;
      return C(e ? 0x56401f : jit(0x7d5a34, 0.25, hash3(ox + cx, oy + cy, cz)));
    });
    addCont(x + s / 2, y + s / 2, name, kind, [x, y, x + s - 1, y + s - 1]);
  }

  // ---------- Straße: 2 Spuren à 3 m, Gehweg 2 m ----------
  function road(m) {
    const lo0 = Math.round((TS - 2 * SCALE.fahrspur) / 2), hi0 = lo0 + 2 * SCALE.fahrspur - 1, mid = (lo0 + hi0) / 2;
    const band = (x, y, p) => {
      const lo = lo0 - p, hi = hi0 + p;
      return (x >= lo && x <= hi && y >= lo && y <= hi) || ((m & 1) && x >= lo && x <= hi && y < lo) || ((m & 2) && y >= lo && y <= hi && x > hi)
        || ((m & 4) && x >= lo && x <= hi && y > hi) || ((m & 8) && y >= lo && y <= hi && x < lo);
    };
    const deg = t.deg;
    for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
      const gx = ox + x, gy = oy + y, h = hash3(gx, gy, 1);
      let c;
      if (band(x, y, 0)) {
        c = jit(0x2a2c31, 0.22, h);
        if (vnoise(gx / 6, gy / 6, 8) > 0.74) c = jit(0x1f2126, 0.2, h);
        const ns = (y < lo0 || y > hi0) && Math.abs(x - mid) < 0.6 && (gy / 6 | 0) % 2 === 0;
        const ew = (x < lo0 || x > hi0) && Math.abs(y - mid) < 0.6 && (gx / 6 | 0) % 2 === 0;
        if (ns || ew) c = jit(0x9a8a3a, 0.2, h);
        if (deg >= 3) {
          const zN = (m & 1) && y >= lo0 - 7 && y <= lo0 - 2, zS = (m & 4) && y >= hi0 + 2 && y <= hi0 + 7;
          const zW = (m & 8) && x >= lo0 - 7 && x <= lo0 - 2, zE = (m & 2) && x >= hi0 + 2 && x <= hi0 + 7;
          if (((zN || zS) && x >= lo0 && x <= hi0 && (x >> 1) % 2 === 0) || ((zW || zE) && y >= lo0 && y <= hi0 && (y >> 1) % 2 === 0)) c = jit(0x9a9a92, 0.15, h);
        }
      } else if (band(x, y, 1)) c = jit(0x7a7c82, 0.1, h);
      else if (band(x, y, SCALE.gehweg)) c = (gx % 5 === 0 || gy % 5 === 0) ? jit(0x45474c, 0.15, h) : jit(0x55575c, 0.15, h);
      else c = grass(x, y);
      S(x, y, 0, C(c));
    }
    const p = lo0 - SCALE.gehweg + 2, q = hi0 + SCALE.gehweg - 2;
    for (const [x, y] of [[p, p], [q, p], [p, q], [q, q]]) if (band(x, y, SCALE.gehweg) && !band(x, y, 1) && rng() < 0.5) lamp(x, y, mid, mid);
    for (let d = 0; d < 4; d++) if ((m >> d & 1) && rng() < 0.35) {
      const horiz = d === 1 || d === 3, lane = (rng() < 0.5 ? -1 : 1) * (SCALE.fahrspur / 2);
      const along = d === 0 || d === 3 ? lo0 / 2 : (hi0 + TS) / 2;
      car(horiz ? along : mid + lane, horiz ? mid + lane : along, horiz, rng() < 0.15);
    }
    for (let k = 0; k < 5; k++) if (rng() < 0.35) {
      const bx = 10 + Math.floor(rng() * 60), by = 10 + Math.floor(rng() * 60), r = 2 + rng() * 4;
      for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) if (Math.hypot(dx, dy) < r && hash3(ox + bx + dx, oy + by + dy, 9) < 0.8) S(bx + dx, by + dy, 0, C(jit(0x4a1612, 0.4, hash3(dx, dy, k))));
    }
  }

  // ---------- Möbel: Maße in Voxeln (5 pro Meter) ----------
  const isBack = (r, ws, x, y) => ws === 0 ? y === r.y0 : ws === 2 ? y === r.y1 : ws === 3 ? x === r.x0 : x === r.x1;
  const FUR = {
    sofa: { L: 10, Dp: 5, draw: (r, ws) => { const col = pick(rng, [0x5a3a2a, 0x3a4a5a, 0x4a5a3a, 0x6a6a6a]); box(r.x0, r.y0, r.x1, r.y1, 1, 4, (x, y, z) => z <= 2 || isBack(r, ws, x, y) || (((ws === 0 || ws === 2) ? (x === r.x0 || x === r.x1) : (y === r.y0 || y === r.y1)) && z === 3) ? C(jit(col, 0.15, hash3(x, y, z))) : undefined); } },
    tv: { L: 7, Dp: 3, draw: (r, ws) => box(r.x0, r.y0, r.x1, r.y1, 1, 8, (x, y, z) => z <= 3 ? C(0x4a3826) : isBack(r, ws, x, y) ? C(z === 8 ? 0x111111 : 0x1a1c22) : undefined) },
    buecher: { L: 6, Dp: 2, cont: ['Bücherregal', 'buecher'], draw: r => box(r.x0, r.y0, r.x1, r.y1, 1, 10, (x, y, z) => C(z % 3 === 1 ? 0x4a3420 : jit(pick(rng, [0x8a2a22, 0x2a4a6a, 0xa08a4a, 0x3a5a3a]), 0.3, hash3(x, y, z)))) },
    sessel: { L: 5, Dp: 5, draw: (r, ws) => box(r.x0, r.y0, r.x1, r.y1, 1, 4, (x, y, z) => z <= 2 || isBack(r, ws, x, y) ? C(jit(0x6a4a3a, 0.15, hash3(x, y, z))) : undefined) },
    zeile: { L: 12, Dp: 3, cont: ['Küchenschrank', 'kuechenschrank'], draw: r => box(r.x0, r.y0, r.x1, r.y1, 1, 5, (x, y, z) => C(z === 5 ? 0x8a8a84 : jit(0xd0c8b8, 0.08, hash3(x, y, z)))) },
    kuehl: { L: 3, Dp: 3, cont: ['Kühlschrank', 'kuehl'], draw: r => box(r.x0, r.y0, r.x1, r.y1, 1, 9, (x, y, z) => C(z === 9 ? 0xc8ccd0 : z === 6 ? 0xa8acb0 : jit(0xdadde0, 0.05, hash3(x, y, z)))) },
    herd: { L: 3, Dp: 3, draw: r => box(r.x0, r.y0, r.x1, r.y1, 1, 5, (x, y, z) => C(z === 5 ? ((x + y) % 2 ? 0x222222 : 0x3a3a3a) : 0xb8bcc0)) },
    bett: { L: 7, Dp: 10, draw: (r, ws) => { const bl = pick(rng, [0x5a2a2a, 0x2a3a5a, 0x4a5a3a, 0x6a5a3a]); box(r.x0, r.y0, r.x1, r.y1, 1, 4, (x, y, z) => { if (isBack(r, ws, x, y)) return C(0x5a4430); if (z === 1) return C(0x4a3826); if (z === 2) return C(0xd8d4c8); if (z === 3) { const near = ws === 0 ? y <= r.y0 + 2 : ws === 2 ? y >= r.y1 - 2 : ws === 3 ? x <= r.x0 + 2 : x >= r.x1 - 2; return C(near ? 0xe8e4d8 : jit(bl, 0.2, hash3(x, y, z))); } return undefined; }); } },
    kinderbett: { L: 5, Dp: 8, draw: (r, ws) => box(r.x0, r.y0, r.x1, r.y1, 1, 3, (x, y, z) => z === 1 ? C(0x7a5a3a) : isBack(r, ws, x, y) ? C(0x8a6a4a) : z === 2 ? C(0xe8e4d8) : C(jit(0x5a8ac0, 0.2, hash3(x, y, z)))) },
    schrank: { L: 8, Dp: 3, cont: ['Kleiderschrank', 'schrank'], draw: r => box(r.x0, r.y0, r.x1, r.y1, 1, 10, (x, y, z) => C(z === 10 ? 0x4a3420 : jit(0x6a4a2e, 0.15, hash3(x, y, z)))) },
    nacht: { L: 2, Dp: 2, draw: r => box(r.x0, r.y0, r.x1, r.y1, 1, 3, C(0x5a4430)) },
    wanne: { L: 9, Dp: 4, draw: r => box(r.x0, r.y0, r.x1, r.y1, 1, 3, (x, y, z) => x === r.x0 || x === r.x1 || y === r.y0 || y === r.y1 || z === 1 ? C(0xe8ecee) : z === 2 ? C(0x9ab8c8) : undefined) },
    wc: { L: 2, Dp: 4, draw: r => box(r.x0, r.y0, r.x1, r.y1, 1, 2, C(0xe8ecee)) },
    becken: { L: 3, Dp: 2, draw: r => box(r.x0, r.y0, r.x1, r.y1, 4, 5, C(0xe0e4e6)) },
    badschrank: { L: 3, Dp: 2, cont: ['Badschrank', 'bad'], draw: r => box(r.x0, r.y0, r.x1, r.y1, 1, 8, (x, y, z) => C(z >= 7 ? 0x9ab0c0 : 0xd8d8d0)) },
    tisch: { L: 8, Dp: 5, draw: r => box(r.x0, r.y0, r.x1, r.y1, 1, 4, (x, y, z) => z === 4 ? C(jit(0x6e5236, 0.2, hash3(x, y, 3))) : ((x === r.x0 || x === r.x1) && (y === r.y0 || y === r.y1)) ? C(0x4a3826) : undefined) },
    schreibtisch: { L: 7, Dp: 4, cont: ['Schreibtisch', 'schreibtisch'], draw: r => box(r.x0, r.y0, r.x1, r.y1, 1, 4, (x, y, z) => z === 4 ? C(0x5a4430) : (x === r.x0 || x === r.x1 || y === r.y0 || y === r.y1) ? C(0x4a3826) : undefined) },
    spielkiste: { L: 4, Dp: 3, cont: ['Spielzeugkiste', 'kiste'], draw: r => box(r.x0, r.y0, r.x1, r.y1, 1, 3, (x, y, z) => C(jit(pick(rng, [0xc04a3a, 0x3a7ac0, 0xd8c04a]), 0.2, hash3(x, y, z)))) },
    regal_lager: { L: 10, Dp: 3, cont: ['Lagerregal', 'lager'], draw: r => box(r.x0, r.y0, r.x1, r.y1, 1, 10, (x, y, z) => C(z % 3 === 1 ? 0x7a7c80 : jit(0x8a6a42, 0.3, hash3(x, y, z)))) },
  };
  const ROOMFUR = {
    wohn: ['sofa', 'tv', 'buecher', 'sessel'], kueche: ['zeile', 'kuehl', 'herd', '*tisch'], schlaf: ['bett', 'schrank', 'nacht'],
    bad: ['wanne', 'wc', 'badschrank', 'becken'], buero: ['schreibtisch', 'buecher'], kinder: ['kinderbett', 'spielkiste', 'schrank'],
    lager: ['regal_lager', 'regal_lager', 'regal_lager'], verkauf: [],
  };
  const FLOOR = { kueche: 'fliese', bad: 'fliese', lager: 'beton', verkauf: 'fliese' };
  const SIDING = [0xcfc8b8, 0xa8b4b8, 0xb8a888, 0x8fa088, 0xc0a8a0, 0x9a9488];
  const ROOFC = [0x6a2a22, 0x3a3e46, 0x4a3426, 0x2c3a4a, 0x5a4a3a];

  // Plan → Voxel; gx, gy = lokale Lage der Ecke (0,0) des Plans in der Kachel
  function buildPlan(plan, gx, gy, style) {
    const { w, d, rooms } = plan;
    const wallAt = new Uint8Array(w * d), keep = new Uint8Array(w * d), fur = new Uint8Array(w * d);
    for (const r of rooms) for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) if (x === r.x0 || x === r.x1 || y === r.y0 || y === r.y1) wallAt[y * w + x] = 1;
    for (const r of rooms) {
      const f = FLOOR[r.type] || 'holz', tint = r.type === 'bad' ? 0xb8c8d0 : 0xc8c0b0;
      for (let y = r.y0 + 1; y < r.y1; y++) for (let x = r.x0 + 1; x < r.x1; x++) {
        const X = ox + gx + x, Y = oy + gy + y;
        const c = f === 'holz' ? (X % 4 === 0 ? 0x3e3024 : jit(0x5e4833, 0.3, hash3(X / 4 | 0, Y / 9 | 0, 12)))
          : f === 'fliese' ? (((X / 3 | 0) + (Y / 3 | 0)) % 2 ? tint : shade(tint, 0.82)) : jit(0x6a6a66, 0.15, hash3(X, Y, 12));
        S(gx + x, gy + y, 0, C(c));
      }
    }
    for (let y = 0; y < d; y++) for (let x = 0; x < w; x++) {
      if (!wallAt[y * w + x]) continue;
      const outer = x === 0 || y === 0 || x === w - 1 || y === d - 1, corner = (x === 0 || x === w - 1) && (y === 0 || y === d - 1);
      for (let z = 1; z <= WALL_H; z++) {
        const X = ox + gx + x, Y = oy + gy + y;
        S(gx + x, gy + y, z, C(corner ? style.trim : outer ? style.wall(X, Y, z) : jit(0xb8b0a0, 0.06, hash3(X, Y, z))), z >= 5 ? WALLTOP : 0);
      }
    }
    for (const wn of plan.windows) {
      const big = style.shopfront && wn.room.type === 'verkauf', z0 = big ? 2 : SCALE.fenster.unten, z1 = big ? 12 : SCALE.fenster.oben;
      const broken = rng() < 0.2, glow = style.lit && wn.room.lit && rng() < 0.8;
      for (let k = 0; k < wn.len; k++) for (let z = z0; z <= z1; z++) {
        const x = wn.hz ? wn.x + k : wn.x, y = wn.hz ? wn.y : wn.y + k;
        if (!wallAt[y * w + x]) continue;
        const X = ox + gx + x, Y = oy + gy + y;
        S(gx + x, gy + y, z, broken ? 0 : glow ? E(jit(0xe8b060, 0.2, hash3(X, Y, z))) : C(jit(0x1f2a3a, 0.3, hash3(X, Y, z))), WALLTOP);
      }
    }
    // Türen: Lücke, Freiraum CLEAR auf beiden Seiten, Türblatt-Objekt
    const allDoors = [...plan.doors.map(d0 => ({ ...d0, front: false })), { ...plan.frontDoor, front: true }];
    for (const dr of allDoors) {
      for (let k = 0; k < DOOR_W; k++) {
        const x = dr.v ? dr.x : dr.x + k, y = dr.v ? dr.y + k : dr.y;
        for (let z = 1; z <= DOOR_H; z++) S(gx + x, gy + y, z, 0);
        for (let s = -CLEAR; s <= CLEAR; s++) { const kx = dr.v ? x + s : x, ky = dr.v ? y : y + s; if (kx >= 0 && ky >= 0 && kx < w && ky < d) keep[ky * w + kx] = 1; }
      }
      for (let k = -1; k <= DOOR_W; k++) { const x = dr.v ? dr.x : dr.x + k, y = dr.v ? dr.y + k : dr.y; S(gx + x, gy + y, DOOR_H + 1, C(style.trim), WALLTOP); }
      let swing = rng() < 0.5 ? 1 : -1;
      if (dr.front) swing = (plan.front === 0 || plan.front === 3) ? 1 : -1;
      addDoor(gx + dr.x, gy + dr.y, dr.v, swing, { glass: style.shopfront && dr.front, openP: dr.front ? 0.3 : 0.6, col: dr.front ? style.doorC : 0x7a5a3a });
    }
    // Möbel nur, wenn danach alle Türen des Zimmers und alle Behälter erreichbar bleiben (Weg ≥ 3 Voxel breit)
    const free = (x, y) => x > 0 && y > 0 && x < w - 1 && y < d - 1 && !wallAt[y * w + x] && !fur[y * w + x];
    const block = (x, y) => free(x, y) && free(x + 1, y) && free(x + 2, y) && free(x, y + 1) && free(x + 1, y + 1) && free(x + 2, y + 1) && free(x, y + 2) && free(x + 1, y + 2) && free(x + 2, y + 2);
    const roomDoorSeeds = r => {
      const seeds = [];
      for (const dr of allDoors) {
        if (dr.v) {
          if (dr.y < r.y0 || dr.y + DOOR_W - 1 > r.y1) continue;
          if (dr.x === r.x0) seeds.push([r.x0 + 1, dr.y + 1]); else if (dr.x === r.x1) seeds.push([r.x1 - 3, dr.y + 1]);
        } else {
          if (dr.x < r.x0 || dr.x + DOOR_W - 1 > r.x1) continue;
          if (dr.y === r.y0) seeds.push([dr.x + 1, r.y0 + 1]); else if (dr.y === r.y1) seeds.push([dr.x + 1, r.y1 - 3]);
        }
      }
      return seeds;
    };
    const reachableOk = (r, conts) => {
      const seeds = roomDoorSeeds(r); if (!seeds.length) return true;
      const W2 = r.x1 - r.x0 + 1, seen = new Uint8Array(W2 * (r.y1 - r.y0 + 1));
      const id = (x, y) => (y - r.y0) * W2 + (x - r.x0);
      if (!block(seeds[0][0], seeds[0][1])) return false;
      const st = [seeds[0]]; seen[id(...seeds[0])] = 1;
      while (st.length) {
        const [x, y] = st.pop();
        for (const [dx, dy] of DIRS) {
          const nx = x + dx, ny = y + dy;
          if (nx <= r.x0 || ny <= r.y0 || nx + 2 >= r.x1 || ny + 2 >= r.y1 || seen[id(nx, ny)] || !block(nx, ny)) continue;
          seen[id(nx, ny)] = 1; st.push([nx, ny]);
        }
      }
      if (!seeds.every(([x, y]) => seen[id(x, y)])) return false;
      for (const c of conts) {
        let ok = false;
        for (let y = c.y0 - 3; y <= c.y1 + 1 && !ok; y++) for (let x = c.x0 - 3; x <= c.x1 + 1 && !ok; x++) {
          if (x <= r.x0 || y <= r.y0 || x + 2 >= r.x1 || y + 2 >= r.y1) continue;
          const touch = x + 2 >= c.x0 - 1 && x <= c.x1 + 1 && y + 2 >= c.y0 - 1 && y <= c.y1 + 1;
          if (touch && seen[id(x, y)]) ok = true;
        }
        if (!ok) return false;
      }
      return true;
    };
    for (const r of rooms) {
      const conts = [];
      for (const name of ROOMFUR[r.type] || []) {
        const center = name[0] === '*', it = FUR[center ? name.slice(1) : name];
        for (let tr = 0; tr < 40; tr++) {
          let x0, y0, x1, y1, ws = 0;
          if (center) {
            x0 = Math.round((r.x0 + r.x1) / 2 - it.L / 2) + ri(rng, -2, 2); y0 = Math.round((r.y0 + r.y1) / 2 - it.Dp / 2) + ri(rng, -2, 2);
            x1 = x0 + it.L - 1; y1 = y0 + it.Dp - 1;
          } else {
            ws = ri(rng, 0, 3);
            const hz = ws === 0 || ws === 2, a = hz ? r.x0 + 1 : r.y0 + 1, b = hz ? r.x1 - 1 : r.y1 - 1;
            if (b - a + 1 < it.L) continue;
            const s = a + Math.floor(rng() * (b - a + 2 - it.L));
            if (hz) { x0 = s; x1 = s + it.L - 1; y0 = ws === 0 ? r.y0 + 1 : r.y1 - it.Dp; y1 = y0 + it.Dp - 1; }
            else { y0 = s; y1 = s + it.L - 1; x0 = ws === 3 ? r.x0 + 1 : r.x1 - it.Dp; x1 = x0 + it.Dp - 1; }
          }
          if (x0 <= r.x0 || y0 <= r.y0 || x1 >= r.x1 || y1 >= r.y1) continue;
          let clash = false;
          for (let y = y0; y <= y1 && !clash; y++) for (let x = x0; x <= x1; x++) if (fur[y * w + x] || keep[y * w + x] || wallAt[y * w + x]) { clash = true; break; }
          if (clash) continue;
          for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) fur[y * w + x] = 1;
          const rect = { x0, y0, x1, y1 };
          if (!reachableOk(r, it.cont ? [...conts, rect] : conts)) { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) fur[y * w + x] = 0; continue; }
          if (it.cont) conts.push(rect);
          it.draw({ x0: gx + x0, y0: gy + y0, x1: gx + x1, y1: gy + y1 }, ws);
          if (it.cont) addCont(gx + (x0 + x1 + 1) / 2, gy + (y0 + y1 + 1) / 2, it.cont[0], it.cont[1] === 'lager' ? 'lager_' + style.shopKind : it.cont[1], [gx + x0, gy + y0, gx + x1, gy + y1]);
          break;
        }
      }
      if (r.lit) addLight(gx + (r.x0 + r.x1) / 2 + 0.5, gy + (r.y0 + r.y1) / 2 + 0.5, 13, style.shopfront ? 42 : 30, style.lightC, 1.35, rng() < 0.35 ? 'flicker' : 'lamp');
    }
    return { wallAt, fur };
  }
  function hipRoof(x0, y0, x1, y1, z0, col) {
    for (let k = 0; ; k++) {
      const ax = x0 - 1 + 2 * k, bx = x1 + 1 - 2 * k, ay = y0 - 1 + 2 * k, by = y1 + 1 - 2 * k, z = z0 + k;
      if (bx - ax < 1 || by - ay < 1 || z >= H) break;
      box(ax, ay, bx, by, z, z, (x, y) => C(x === ax || x === bx || y === ay || y === by ? shade(col, 0.72) : jit(col, 0.25, hash3(ox + x, (oy + y + k) >> 1, 77))), ROOF);
    }
  }

  // ---------- Wohnhaus: 8–11 m × 8–11 m ----------
  function house() {
    const rd = roadDirs(tx, ty), front = rd.length ? pick(rng, rd) : 2;
    const w = SCALE.haus.min + 2 * ri(rng, 0, 7), d = SCALE.haus.min + 2 * ri(rng, 0, 7);
    for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) S(x, y, 0, C(grass(x, y)));
    const set = 12;
    let gx = Math.floor((TS - w) / 2) + ri(rng, -3, 3), gy = Math.floor((TS - d) / 2) + ri(rng, -3, 3);
    if (front === 0) gy = set; if (front === 2) gy = TS - set - d; if (front === 3) gx = set; if (front === 1) gx = TS - set - w;
    const plan = planRooms(rng, w, d, front, PLAN_OPT);
    const lit = rng() < 0.5;
    for (const r of plan.rooms) r.lit = lit && rng() < 0.55;
    const sid = pick(rng, SIDING);
    buildPlan(plan, gx, gy, { trim: 0xe0dcd0, lit, lightC: [1.0, 0.78, 0.5], doorC: pick(rng, [0x6a2a22, 0x2a3a4a, 0x4a3a2a, 0x3a4a3a]), wall: (X, Y, z) => z % 3 === 0 ? shade(sid, 0.82) : jit(sid, 0.08, hash3(X, Y, z)) });
    hipRoof(gx, gy, gx + w - 1, gy + d - 1, WALL_H + 1, pick(rng, ROOFC));
    const fd = plan.frontDoor;
    for (let k = 0; k < DOOR_W; k++) for (let s = 1; s <= set; s++) {
      const x = gx + (fd.v ? fd.x + (front === 1 ? s : -s) : fd.x + k), y = gy + (fd.v ? fd.y + k : fd.y + (front === 2 ? s : -s));
      S(x, y, 0, C(jit(0x6a6458, 0.15, hash3(ox + x, oy + y, 5))));
    }
    const doorAlong = fd.v ? gy + fd.y : gx + fd.x;
    if (rng() < 0.7) for (let i = 0; i < TS; i++) for (const [x, y, sd] of [[i, 0, 0], [TS - 1, i, 1], [i, TS - 1, 2], [0, i, 3]]) {
      const along = sd === 0 || sd === 2 ? x : y;
      if (sd === front && along >= doorAlong - 1 && along <= doorAlong + DOOR_W) continue;
      if (hash3(ox + x, oy + y, 33) < 0.08) continue;
      for (let z = 1; z <= 5; z++) if (along % 5 === 0 || z === 2 || z === 4) S(x, y, z, C(along % 5 === 0 ? 0x7a6a52 : 0x6b5a45));
    }
    for (const [x, y] of [[4, 4], [TS - 8, 4], [4, TS - 8], [TS - 8, TS - 8]]) {
      if (x + 13 > gx && x - 10 < gx + w && y + 13 > gy && y - 10 < gy + d) continue;
      if (rng() < 0.5) tree(x, y);
    }
    ctx.add('building', { x0: ox + gx, y0: oy + gy, x1: ox + gx + w - 1, y1: oy + gy + d - 1, kind: 'Haus', rooms: plan.rooms.length, area: (w - 2) * (d - 2) / (VPM * VPM) });
  }

  // ---------- Laden: Verkauf vorn, dahinter Lager und Büro ----------
  const SHOPS = [['Supermarkt', 0x4ae0e0, 'regal_s', 0.5], ['Apotheke', 0x5aff7a, 'regal_a', 0.3], ['Waffenladen', 0xff4a3a, 'regal_w', 0.2]];
  function shop() {
    const rd = roadDirs(tx, ty), front = rd.length ? pick(rng, rd) : 2;
    let r = rng(), sh = SHOPS[0]; for (const s of SHOPS) { r -= s[3]; if (r <= 0) { sh = s; break; } }
    for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) S(x, y, 0, C(jit(0x4a4c50, 0.15, hash3(ox + x, oy + y, 2))));
    const horizF = front === 0 || front === 2, along = 70, depth = 62;
    const w = horizF ? along : depth, d = horizF ? depth : along;
    const gx = horizF ? 5 : (front === 3 ? 10 : TS - 10 - w), gy = horizF ? (front === 0 ? 10 : TS - 10 - d) : 5;
    const nearFront = front === 0 || front === 3;
    const cut = nearFront ? 38 : depth - 1 - 38, cut2 = Math.floor(along * 0.6);
    const R = (a0, a1, b0, b1) => horizF ? { x0: a0, x1: a1, y0: b0, y1: b1 } : { x0: b0, x1: b1, y0: a0, y1: a1 };
    const rooms = nearFront
      ? [{ ...R(0, along - 1, 0, cut), type: 'verkauf' }, { ...R(0, cut2, cut, depth - 1), type: 'lager' }, { ...R(cut2, along - 1, cut, depth - 1), type: 'buero' }]
      : [{ ...R(0, along - 1, cut, depth - 1), type: 'verkauf' }, { ...R(0, cut2, 0, cut), type: 'lager' }, { ...R(cut2, along - 1, 0, cut), type: 'buero' }];
    const sale = rooms[0], backLo = nearFront ? cut : 0;
    const dSL = horizF ? { x: Math.floor(cut2 / 2) - 2, y: cut, v: false } : { x: cut, y: Math.floor(cut2 / 2) - 2, v: true };
    const dLO = horizF ? { x: cut2, y: backLo + 6, v: true } : { x: backLo + 6, y: cut2, v: false };
    const mid = Math.floor(along / 2) - 2;
    const frontDoor = horizF ? { x: mid, y: front === 0 ? 0 : d - 1, v: false } : { x: front === 3 ? 0 : w - 1, y: mid, v: true };
    const windows = [];
    for (const [a, b] of [[4, mid - 3], [mid + DOOR_W + 2, along - 5]]) {
      const pos = horizF ? { x: a, y: front === 0 ? 0 : d - 1 } : { x: front === 3 ? 0 : w - 1, y: a };
      windows.push({ ...pos, len: b - a + 1, hz: horizF, room: sale });
    }
    for (const rm of rooms) rm.lit = rng() < 0.7;
    const wallC = rng() < 0.5 ? 0x7a7c82 : 0x8f4a34;
    buildPlan({ w, d, rooms, doors: [dSL, dLO], frontDoor, windows, front }, gx, gy, {
      trim: 0x5a5c62, lit: true, shopfront: true, shopKind: sh[2], lightC: [0.75, 0.9, 1.0], doorC: 0x3a3c42,
      wall: (X, Y, z) => wallC === 0x8f4a34 ? (z % 3 === 2 ? 0x4a403b : jit(wallC, 0.35, hash3((X + Y + (z / 3 | 0) * 3) / 6 | 0, z / 3 | 0, 11))) : jit(wallC, 0.12, hash3(X, Y, z)),
    });
    box(gx, gy, gx + w - 1, gy + d - 1, WALL_H + 1, WALL_H + 1, (x, y) => C(jit(0x5a5c62, 0.14, hash3(ox + x, oy + y, 10))), ROOF);
    box(gx, gy, gx + w - 1, gy + d - 1, WALL_H + 2, WALL_H + 3, (x, y) => (x === gx || y === gy || x === gx + w - 1 || y === gy + d - 1) ? C(0x6a6c72) : undefined, ROOF);
    const sa0 = horizF ? sale.y0 : sale.x0, sa1 = horizF ? sale.y1 : sale.x1;
    for (let p = 8; p + 3 < along - 6; p += 11) {
      if (p + 3 >= mid - 2 && p <= mid + DOOR_W + 2) continue;
      for (let q = sa0 + 9; q <= sa1 - 6; q++) {
        if (Math.abs(q - (sa0 + sa1 + 3) / 2) < 3.5) continue;
        for (let k = 0; k < 3; k++) for (let z = 1; z <= 9; z++) {
          const x = horizF ? gx + p + k : gx + q, y = horizF ? gy + q : gy + p + k;
          S(x, y, z, C(z % 3 === 0 ? 0x7a7c80 : jit(pick(rng, [0xa03a2a, 0x3a6aa0, 0xd8c060, 0x5a8a4a, 0xd8d4c8]), 0.3, hash3(ox + x, oy + y, z))));
        }
      }
      const cq = sa0 + 12, cx = horizF ? gx + p + 1.5 : gx + cq, cy = horizF ? gy + cq : gy + p + 1.5;
      addCont(cx, cy, sh[0] + ': Regal', sh[2], horizF ? [gx + p, gy + sa0 + 9, gx + p + 2, gy + sa1 - 6] : [gx + sa0 + 9, gy + p, gx + sa1 - 6, gy + p + 2]);
    }
    const sgn = (a, z) => {
      if (front === 0) S(gx + a, gy - 1, z, E(sh[1])); else if (front === 2) S(gx + a, gy + d, z, E(sh[1]));
      else if (front === 1) S(gx + w, gy + a, z, E(sh[1])); else S(gx - 1, gy + a, z, E(sh[1]));
    };
    for (let a = mid - 10; a <= mid + 14; a++) { sgn(a, 14); if (a % 2 === 0) sgn(a, 13); }
    const fx = front === 1 ? gx + w + 4 : front === 3 ? gx - 4 : gx + mid + 2.5, fy = front === 0 ? gy - 4 : front === 2 ? gy + d + 4 : gy + mid + 2.5;
    addLight(fx, fy, 13, 40, [((sh[1] >> 16) & 255) / 255, ((sh[1] >> 8) & 255) / 255, (sh[1] & 255) / 255], 1.5, 'neon');
    ctx.add('building', { x0: ox + gx, y0: oy + gy, x1: ox + gx + w - 1, y1: oy + gy + d - 1, kind: sh[0], rooms: 3, area: (w - 2) * (d - 2) / (VPM * VPM) });
  }

  // ---------- Park, Parkplatz, Brache ----------
  function park() {
    for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
      const gx = ox + x, gy = oy + y, h = hash3(gx, gy, 1);
      const path = (Math.abs(x - 39.5) < 3 || Math.abs(y - 39.5) < 3) && vnoise(gx / 9, gy / 9, 3) > 0.2;
      const pond = Math.hypot((x - 58) / 11, (y - 18) / 7) < 1;
      S(x, y, 0, C(pond ? jit(0x1a2a3a, 0.2, h) : path ? jit(0x5a5040, 0.2, h) : jit(0x2a3c22, 0.35, h)));
    }
    for (const [x, y] of [[12, 12], [14, 58], [58, 58], [26, 26], [50, 44]]) if (rng() < 0.7) tree(x, y);
    for (const [x, y, hz] of [[22, 34, true], [48, 45, true], [34, 50, false]]) if (rng() < 0.6) {
      for (let a = 0; a < 9; a++) { const bx = x + (hz ? a : 0), by = y + (hz ? 0 : a); S(bx, by, 2, C(0x6a4a2e)); S(bx + (hz ? 0 : 1), by + (hz ? 1 : 0), 2, C(0x6a4a2e)); S(bx, by, 3, C(0x5a3e26)); S(bx, by, 4, C(0x5a3e26)); if (a === 0 || a === 8) S(bx, by, 1, C(0x2a2a2a)); }
    }
    if (rng() < 0.3) barrel(20, 52);
  }
  function parking() {
    for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
      const gx = ox + x, gy = oy + y, h = hash3(gx, gy, 1);
      const line = x % 13 === 1 && (y < 28 || y > 51);
      S(x, y, 0, C(line ? jit(0x9a9a90, 0.2, h) : jit(0x303236, 0.2, h)));
    }
    for (const cx of [8, 21, 34, 47, 60]) { if (rng() < 0.5) car(cx, 15, false, rng() < 0.1); if (rng() < 0.5) car(cx, 64, false, rng() < 0.1); }
    if (rng() < 0.7) lamp(74, 40, 68, 40);
  }
  function lot() {
    for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
      const gx = ox + x, gy = oy + y, h = hash3(gx, gy, 1);
      S(x, y, 0, C(h > 0.85 ? jit(0x5a5650, 0.3, h) : jit(0x3e362c, 0.3, h)));
      const rb = vnoise(gx / 7, gy / 7, 60);
      if (rb > 0.64 && x > 3 && y > 3 && x < TS - 4 && y < TS - 4) for (let z = 1; z <= (rb - 0.64) * 22; z++) S(x, y, z, C(hash3(gx, gy, z) < 0.5 ? jit(0x8f4a34, 0.4, h) : jit(0x7a7d86, 0.3, h)));
    }
    if (rng() < 0.7) barrel(40, 40);
    crate(12 + ri(rng, 0, 10), 12, 5, 'Holzkiste', 'kiste');
    if (rng() < 0.6) crate(56, 58 + ri(rng, 0, 6), 5, 'Holzkiste', 'kiste');
    if (rng() < 0.5) crate(64, 58, 5, 'Holzkiste', 'kiste');
  }

  // =====================================================================
  //  Weltplan-Kacheln (Generator v5): Wirtschaftsweg, Garten, Wiese/Hecke, Feld, Wald, Hof
  // =====================================================================
  const kindAt = (dx, dy) => { const k = tileKind(tx + dx, ty + dy); return k ? k.kind : null; };
  const nbKind = d => kindAt(DIRS[d][0], DIRS[d][1]);
  const lawn = (x, y, pal = bio.gras) => { const gx = ox + x, gy = oy + y, h = hash3(gx, gy, 1); return jit(vnoise(gx / 9, gy / 9, 5) > 0.55 ? pal[1] : pal[0], 0.3, h); };
  // Schotterweg 3 m breit mit Fahrspuren und Grasnarbe in der Mitte
  function weg(m) {
    const lo = 32, hi = 47, mid = 39.5;
    const on = (x, y) => (x >= lo && x <= hi && y >= lo && y <= hi) || ((m & 1) && x >= lo && x <= hi && y < lo) || ((m & 2) && y >= lo && y <= hi && x > hi)
      || ((m & 4) && x >= lo && x <= hi && y > hi) || ((m & 8) && y >= lo && y <= hi && x < lo);
    for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
      const gx = ox + x, gy = oy + y, h = hash3(gx, gy, 3);
      if (!on(x, y)) { S(x, y, 0, C(lawn(x, y, bio.wiese))); if (h < 0.05) S(x, y, 1, C(jit(bio.wiese[2], 0.3, h))); continue; }
      const across = (m & 5) && x >= lo && x <= hi && (y < lo || y > hi) ? x : y;
      const t = Math.abs(across - mid);
      const c = t < 1.6 ? jit(bio.wiese[0], 0.3, h) : t < 4.5 ? jit(shade(bio.schotter, 0.78), 0.2, h) : jit(bio.schotter, 0.25, h);
      S(x, y, 0, C(c));
    }
  }
  // Hecke entlang einer Kachelseite (Feldrain, Gartengrenze)
  function hedge(d, hgt = 6, gap = 0.06) {
    for (let k = 0; k < TS; k++) for (let w = 0; w < 3; w++) {
      const x = d === 1 ? TS - 1 - w : d === 3 ? w : k, y = d === 0 ? w : d === 2 ? TS - 1 - w : k, gx = ox + x, gy = oy + y;
      if (vnoise(gx / 5, gy / 5, 41) < gap * 4 && hash3(gx, gy, 42) < 0.8) continue;
      const top = hgt - (w === 1 ? 0 : 1) + Math.round(vnoise(gx / 3, gy / 3, 43) * 2);
      for (let z = 1; z <= top; z++) S(x, y, z, C(jit(z < 2 ? bio.stamm : (hash3(gx, gy, z) < 0.5 ? bio.hecke[0] : bio.hecke[1]), 0.3, hash3(gx, gy, z + 5))));
    }
  }
  function wiese() {
    for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
      const gx = ox + x, gy = oy + y, h = hash3(gx, gy, 6);
      S(x, y, 0, C(lawn(x, y, bio.wiese)));
      if (h < 0.2) S(x, y, 1, C(jit(bio.wiese[h < 0.1 ? 1 : 2], 0.35, h)));
      if (h > 0.985) S(x, y, 1, C(bio.blumen[(h * 1000 | 0) % bio.blumen.length]));
    }
    // Hecke dort, wo Feld und Wald an diese Wiese stoßen (Feldrain → Hecke → Waldrand)
    const sides = [0, 1, 2, 3].map(nbKind);
    if (sides.includes('wald')) sides.forEach((k, d) => { if (k === 'feld') hedge(d); });
    if (rng() < 0.25) tree(10 + ri(rng, 0, 55), 10 + ri(rng, 0, 55));
  }
  function garten() {
    for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
      const gx = ox + x, gy = oy + y, h = hash3(gx, gy, 7);
      const beet = x > 46 && x < 70 && y > 12 && y < 30 && (y % 4 < 2);
      S(x, y, 0, C(beet ? jit(0x4a3626, 0.2, h) : lawn(x, y)));
      if (beet && h < 0.5) S(x, y, 1, C(jit(0x4a6a2a, 0.35, h)));
    }
    // Gartenhecke zu Feld, Wiese und Weg hin
    [0, 1, 2, 3].forEach(d => { const k = nbKind(d); if (k === 'feld' || k === 'wiese' || k === 'weg') hedge(d, 5, 0.03); });
    if (rng() < 0.6) {   // Gartenhaus 3 × 2,4 m mit Werkzeugkiste
      const x0 = 14 + ri(rng, 0, 30), y0 = 46 + ri(rng, 0, 14), wx = 15, wy = 12, col = pick(rng, [0x6a4a2e, 0x4a5a3a, 0x7a3a2a]);
      box(x0, y0, x0 + wx - 1, y0 + wy - 1, 1, 11, (x, y, z) => (x === x0 || x === x0 + wx - 1 || y === y0 || y === y0 + wy - 1) && !(y === y0 && x > x0 + 4 && x < x0 + 10 && z < 10) ? C(jit(col, 0.15, hash3(ox + x, oy + y, z))) : undefined);
      hipRoof(x0, y0, x0 + wx - 1, y0 + wy - 1, 12, 0x3a3e46);
      crate(x0 + 3, y0 + 4, 4, 'Werkzeugkiste', 'kiste');
      ctx.add('building', { x0: ox + x0, y0: oy + y0, x1: ox + x0 + wx - 1, y1: oy + y0 + wy - 1, kind: 'Gartenhaus', rooms: 1, area: (wx - 2) * (wy - 2) / (VPM * VPM) });
    }
    for (const [x, y] of [[8, 8], [60, 52], [30, 30]]) if (rng() < 0.45) tree(x, y);
  }
  // Feld: Frucht und Reihenrichtung aus großräumigem Rauschen, damit ein Schlag über mehrere Kacheln gleich aussieht
  function feld() {
    const sc = plan.seed % 997, fi = Math.floor(vnoise(tx / 4.5, ty / 4.5, sc) * bio.feld.length * 0.999), fr = bio.feld[Math.min(bio.feld.length - 1, fi)];
    const rowsX = vnoise(tx / 6, ty / 6, sc + 3) > 0.5;
    const rand = [0, 1, 2, 3].map(d => nbKind(d) !== 'feld');
    for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
      const gx = ox + x, gy = oy + y, h = hash3(gx, gy, 8);
      const edge = (rand[0] && y < 3) || (rand[2] && y > TS - 4) || (rand[3] && x < 3) || (rand[1] && x > TS - 4);
      if (edge) { S(x, y, 0, C(lawn(x, y, bio.wiese))); if (h < 0.3) S(x, y, 1, C(jit(bio.wiese[1], 0.3, h))); continue; }
      const row = (rowsX ? gy : gx) % 3 === 0;
      S(x, y, 0, C(jit(row ? shade(fr.boden, 0.85) : fr.boden, 0.18, h)));
      if (fr.hoch && !row) for (let z = 1; z <= fr.hoch - (h < 0.3 ? 1 : 0); z++) S(x, y, z, C(jit(fr.pflanze, 0.22, hash3(gx, gy, z + 8))));
    }
    if (rng() < 0.08) crate(ri(rng, 10, 60), ri(rng, 10, 60), 6, 'Strohballen', 'kiste');
  }
  // Wald: Bäume auf einem Raster in Weltkoordinaten; Kronen aus Nachbar-Waldkacheln ragen herein (keine Schnittkanten)
  const TREE_STEP = 13;
  function waldBaum(px, py) {
    const h = hash3(px, py, 51), th = 12 + Math.floor(h * 6), r = 5.5 + hash3(px, py, 52) * 3, cz = th + r - 2;
    const leaf = bio.laub[Math.floor(hash3(px, py, 53) * bio.laub.length)];
    const lx = px - ox, ly = py - oy;
    if (lx >= -1 && ly >= -1 && lx < TS + 1 && ly < TS + 1) for (let z = 1; z <= th; z++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) S(lx + dx, ly + dy, z, C(jit(bio.stamm, 0.2, hash3(px + dx, py + dy, z))));
    const R = Math.ceil(r) + 1;
    for (let z = Math.max(th - 2, Math.floor(cz - r)); z <= cz + r && z < H; z++) for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const x = lx + dx, y = ly + dy; if (x < 0 || y < 0 || x >= TS || y >= TS) continue;
      const d = Math.hypot(dx - 0.5, dy - 0.5, (z - cz) * 1.3);
      if (d < r - hash3(px + dx, py + dy, z) * 1.6 && vol.get(x, y, z) === 0) S(x, y, z, C(jit(leaf, 0.4, hash3(px + dx, py + dy, z + 3))));
    }
  }
  function wald() {
    for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
      const gx = ox + x, gy = oy + y, h = hash3(gx, gy, 9);
      S(x, y, 0, C(jit(vnoise(gx / 6, gy / 6, 31) > 0.5 ? bio.waldboden[0] : bio.waldboden[1], 0.3, h)));
      if (h < 0.06) for (let z = 1; z <= 1 + (h < 0.02 ? 1 : 0); z++) S(x, y, z, C(jit(bio.hecke[1], 0.35, h)));   // Unterholz
    }
    const g0x = Math.floor((ox - 10) / TREE_STEP), g1x = Math.floor((ox + TS + 10) / TREE_STEP), g0y = Math.floor((oy - 10) / TREE_STEP), g1y = Math.floor((oy + TS + 10) / TREE_STEP);
    for (let gy = g0y; gy <= g1y; gy++) for (let gx = g0x; gx <= g1x; gx++) {
      const px = gx * TREE_STEP + Math.floor(hash3(gx, gy, 54) * (TREE_STEP - 4)) + 2, py = gy * TREE_STEP + Math.floor(hash3(gx, gy, 55) * (TREE_STEP - 4)) + 2;
      const owner = tileKind(Math.floor(px / TS), Math.floor(py / TS));
      if (!owner || owner.kind !== 'wald' || hash3(gx, gy, 56) < 0.12) continue;
      const lx = px % TS, ly = py % TS;   // Bäume nicht direkt an den Rand zu Nicht-Wald setzen
      if (owner === t && ((lx < 6 && nbKind(3) !== 'wald') || (lx > TS - 7 && nbKind(1) !== 'wald') || (ly < 6 && nbKind(0) !== 'wald') || (ly > TS - 7 && nbKind(2) !== 'wald'))) continue;
      if (owner !== t) {
        const otx = Math.floor(px / TS), oty = Math.floor(py / TS), ok2 = (dx, dy) => { const k = tileKind(otx + dx, oty + dy); return k && k.kind === 'wald'; };
        if ((lx < 6 && !ok2(-1, 0)) || (lx > TS - 7 && !ok2(1, 0)) || (ly < 6 && !ok2(0, -1)) || (ly > TS - 7 && !ok2(0, 1))) continue;
      }
      waldBaum(px, py);
    }
    if (rng() < 0.12) crate(ri(rng, 10, 60), ri(rng, 10, 60), 5, 'Holzstapel', 'kiste');
  }
  // Hof: Wohnhaus zur Zufahrt, Scheune dahinter, Schotterhof
  function hof(m) {
    const front = [0, 1, 2, 3].find(d => m >> d & 1) ?? 2;
    for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) S(x, y, 0, C(lawn(x, y)));
    const w = SCALE.haus.min, d = SCALE.haus.min, set = 8;
    // Wohnhaus an der Zufahrtsseite, links davon; Scheune an der Gegenseite
    let gx = 6, gy = 6;
    if (front === 0) gy = set; if (front === 2) gy = TS - set - d; if (front === 3) gx = set; if (front === 1) gx = TS - set - w;
    if (front === 0 || front === 2) gx = 4; else gy = 4;
    for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {   // Schotterhof zwischen Zufahrt, Haus und Scheune
      const along = front === 0 || front === 2 ? x : y, across = front === 0 ? y : front === 2 ? TS - 1 - y : front === 3 ? x : TS - 1 - x;
      if ((along >= 32 && along <= 47 && across < 40) || (along > 40 && across > 6 && across < 48)) S(x, y, 0, C(jit(bio.schotter, 0.25, hash3(ox + x, oy + y, 12))));
    }
    const plan2 = planRooms(rng, w, d, front, PLAN_OPT);
    const lit = rng() < 0.5; for (const r of plan2.rooms) r.lit = lit && rng() < 0.5;
    const sid = pick(rng, [0xd8d0c0, 0xc8b8a0, 0xe0d8c8]);
    buildPlan(plan2, gx, gy, { trim: 0x6a4a2e, lit, lightC: [1.0, 0.78, 0.5], doorC: 0x5a3a22, wall: (X, Y, z) => z % 3 === 0 ? shade(sid, 0.85) : jit(sid, 0.06, hash3(X, Y, z)) });
    hipRoof(gx, gy, gx + w - 1, gy + d - 1, WALL_H + 1, 0x7a2a22);
    ctx.add('building', { x0: ox + gx, y0: oy + gy, x1: ox + gx + w - 1, y1: oy + gy + d - 1, kind: 'Hof', rooms: plan2.rooms.length, area: (w - 2) * (d - 2) / (VPM * VPM) });
    // Scheune 6 × 7 m, Holz, offenes Tor zum Hof
    const bw = 30, bd = 34;
    const back = (front + 2) % 4;
    let sx = TS - 4 - bw, sy = TS - 4 - bd;
    if (back === 0) sy = 4; if (back === 3) sx = 4;
    if (front === 0 || front === 2) sx = TS - 4 - bw; else sy = TS - 4 - bd;
    const tor = (x, y) => { const c = back === 0 ? y === sy + bd - 1 : back === 2 ? y === sy : back === 3 ? x === sx + bw - 1 : x === sx; const a = back === 0 || back === 2 ? x - sx : y - sy; return c && a > 8 && a < 21; };
    box(sx, sy, sx + bw - 1, sy + bd - 1, 1, WALL_H + 2, (x, y, z) => {
      const wall = x === sx || x === sx + bw - 1 || y === sy || y === sy + bd - 1;
      if (!wall) return z === 1 && hash3(ox + x, oy + y, 13) < 0.25 ? C(jit(0xb09a4a, 0.3, hash3(ox + x, oy + y, 14))) : undefined;
      if (tor(x, y) && z < WALL_H) return undefined;
      return C(jit((x + y) % 4 === 0 ? 0x5a2018 : 0x7a2a20, 0.12, hash3(ox + x, oy + y, z))) ;
    }, 0);
    hipRoof(sx, sy, sx + bw - 1, sy + bd - 1, WALL_H + 3, 0x4a4c50);
    crate(sx + 4, sy + 4, 6, 'Futterkiste', 'kiste'); if (rng() < 0.6) crate(sx + bw - 10, sy + bd - 10, 6, 'Werkzeugkiste', 'kiste');
    ctx.add('building', { x0: ox + sx, y0: oy + sy, x1: ox + sx + bw - 1, y1: oy + sy + bd - 1, kind: 'Scheune', rooms: 1, area: (bw - 2) * (bd - 2) / (VPM * VPM) });
    if (rng() < 0.7) lamp(front === 1 ? TS - 6 : front === 3 ? 5 : 30, front === 0 ? 5 : front === 2 ? TS - 6 : 30, 40, 40);
  }

  if (t.kind === 'road') road(t.mask);
  else if (t.kind === 'haus') house();
  else if (t.kind === 'laden') shop();
  else if (t.kind === 'park') park();
  else if (t.kind === 'parkplatz') parking();
  else if (t.kind === 'weg') weg(t.mask);
  else if (t.kind === 'wiese') wiese();
  else if (t.kind === 'garten') garten();
  else if (t.kind === 'feld') feld();
  else if (t.kind === 'wald') wald();
  else if (t.kind === 'hof') hof(t.mask);
  else lot();

  // Türen im (gespeicherten) Zustand einsetzen, lokale Koordinaten
  const lset = (x, y, z, c, l = 0) => vol.set(x - ox, y - oy, z, c, l), lget = (x, y, z) => vol.getLay(x - ox, y - oy, z);
  for (const dr of tileDoors) doorVoxels(dr, lset, lget);
  }
}
