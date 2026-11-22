// Generator der Kleinen Welt, in Metern beschrieben und damit für jede Grunddichte gleich groß.
// Reines Modul: läuft im Worker (WorkerBackend) oder synchron (LocalBackend).
// config = { seed, vs (Meter pro Block), sub (Unterteilung) }
import { C, E, FLAG, jit } from '../../engine/core/voxel.js';
import { hash3, vnoise, mulberry32 } from '../../engine/core/rand.js';
import { planRooms } from '../../engine/gen/floorplan.js';

/** Weltmaße je Dichte: Kachelgröße in Blöcken, Kacheln, Höhe. 5 cm hält den GPU-Speicher mit einer kleineren Fläche in Grenzen. */
export function layout(vs) {
  if (vs >= 0.2) return { TS: 48, N: 3, H: 32, L: 28.8 };
  if (vs >= 0.1) return { TS: 96, N: 3, H: 64, L: 28.8 };
  return { TS: 96, N: 3, H: 96, L: 14.4 };
}

export function createGenerator(config) {
  const vs = config.vs ?? 0.2, sub = config.sub ?? 1, { TS, N, H, L } = layout(vs);
  const M = m => Math.round(m / vs);                     // Meter → Blöcke
  const rng = mulberry32(config.seed ^ 0x5eed);
  const small = L < 20;
  // ---- Merkmale der ganzen Welt (in Blöcken), einmal aus der Saat
  const house = { x: M(small ? 1.2 : 9), y: M(small ? 1.2 : 7.5), w: M(6), d: M(4.8) };
  house.plan = planRooms(rng, house.w, house.d, 2, { min: M(1.8), doorW: M(0.9), windowW: M(1) });
  const carport = { x: M(small ? 8.6 : 18.5), y: M(small ? 8.2 : 16.5), w: M(3.4), d: M(3.4), h: M(2.4) };
  const fire = { x: M(small ? 3.5 : 5), y: M(small ? 11 : 22) };
  const sand = { x: M(small ? 11.5 : 23), y: M(small ? 3 : 6), w: M(2.4) };
  const trees = [], lamps = [];
  const nT = small ? 4 : 14;
  for (let k = 0; k < nT * 4 && trees.length < nT; k++) {
    const x = rng() * (L - 3) + 1.5, y = rng() * (L - 3) + 1.5;
    const bad = (x > house.x * vs - 2 && x < (house.x + house.w) * vs + 2 && y > house.y * vs - 2 && y < (house.y + house.d) * vs + 3)
      || (x > carport.x * vs - 1.5 && x < (carport.x + carport.w) * vs + 1.5 && y > carport.y * vs - 1.5 && y < (carport.y + carport.d) * vs + 1.5)
      || Math.hypot(x - fire.x * vs, y - fire.y * vs) < 3 || (x > sand.x * vs - 1.5 && x < (sand.x + sand.w) * vs + 1.5 && y > sand.y * vs - 1.5 && y < (sand.y + sand.w) * vs + 1.5)
      || trees.some(t => Math.hypot(t.x * vs - x, t.y * vs - y) < 3);
    if (!bad) trees.push({ x: M(x), y: M(y), h: M(1.6 + rng() * 0.8), r: M(1 + rng() * 0.5), leaf: [0x3a6a2a, 0x4a7a2a, 0x2e5a2a][k % 3], s: k });
  }
  for (const [x, y] of small ? [[7, 7]] : [[14, 14], [4, 15], [24, 26]]) lamps.push({ x: M(x), y: M(y) });
  const path = (X, Y) => {   // Weg in Metern: zwei geschwungene Linien
    const xm = X * vs, ym = Y * vs, a = Math.abs(xm - L * 0.48 + Math.sin(ym / 2.6) * 1.2), b = Math.abs(ym - L * 0.68 + Math.sin(xm / 2.2) * 1);
    return a < 0.6 || b < 0.6;
  };

  return { tileSize: TS, tilesX: N, tilesY: N, height: H, version: 2, sub, voxelSize: vs, generate };

  function generate(tile, vol, ctx) {
    const ox = ctx.ox, oy = ctx.oy, add = ctx.add;
    const inT = (X, Y) => X >= ox && Y >= oy && X < ox + TS && Y < oy + TS;
    const S = (X, Y, z, c, l = 0) => { if (inT(X, Y) && z >= 0 && z < H) vol.set(X - ox, Y - oy, z, c, l); };
    const box = (x0, y0, z0, x1, y1, z1, fn, l = 0) => {
      for (let z = Math.max(0, z0); z <= Math.min(H - 1, z1); z++) for (let Y = Math.max(y0, oy); Y <= Math.min(y1, oy + TS - 1); Y++) for (let X = Math.max(x0, ox); X <= Math.min(x1, ox + TS - 1); X++) {
        const c = typeof fn === 'function' ? fn(X, Y, z) : fn; if (c !== undefined) vol.set(X - ox, Y - oy, z, c, l);
      }
    };
    // Boden
    const g = M(0.2);   // Fliesen- und Fleckengröße
    for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
      const X = ox + x, Y = oy + y, h = hash3(Math.floor(X / Math.max(1, M(0.2))), Math.floor(Y / Math.max(1, M(0.2))), 1);
      vol.set(x, y, 0, C(path(X, Y) ? jit(0x7a6a50, 0.25, h) : vnoise(X * vs / 1.8, Y * vs / 1.8, 2) > 0.6 ? jit(0x4a6a2a, 0.3, h) : jit(0x3a5a26, 0.3, h)));
    }
    // Haus aus der Grundriss-Grammatik
    { const { x: hx, y: hy, w, d, plan } = house, WALL = M(2.4), DOORH = M(2);
      const wall = new Uint8Array(w * d);
      for (const r of plan.rooms) for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) if (x === r.x0 || x === r.x1 || y === r.y0 || y === r.y1) wall[y * w + x] = 1;
      const brick = M(0.2) || 1;
      box(hx, hy, 0, hx + w - 1, hy + d - 1, 0, (X, Y) => C(jit(0x6e5236, 0.25, hash3(Math.floor((X - hx) / (brick * 3)), Y - hy, 4))));
      box(hx, hy, 1, hx + w - 1, hy + d - 1, WALL, (X, Y, z) => wall[(Y - hy) * w + (X - hx)] ? C(Math.floor(z / brick) % 4 === 0 ? 0xb8ae98 : jit(0xd8ceb8, 0.08, hash3(Math.floor(X / brick), Math.floor(Y / brick), Math.floor(z / brick)))) : undefined, FLAG.WALLTOP * 0);
      // obere Wandhälfte als WALLTOP (für Kappen), dann Fenster und Türen
      box(hx, hy, M(1), hx + w - 1, hy + d - 1, WALL, (X, Y, z) => wall[(Y - hy) * w + (X - hx)] ? C(Math.floor(z / brick) % 4 === 0 ? 0xb8ae98 : jit(0xd8ceb8, 0.08, hash3(Math.floor(X / brick), Math.floor(Y / brick), Math.floor(z / brick)))) : undefined, FLAG.WALLTOP);
      for (const wn of plan.windows) for (let k = 0; k < wn.len; k++) for (let z = M(0.9); z <= M(1.8); z++) S(hx + (wn.hz ? wn.x + k : wn.x), hy + (wn.hz ? wn.y : wn.y + k), z, E(0xf0c070), FLAG.WALLTOP);
      for (const dr of [...plan.doors, plan.frontDoor]) for (let k = 0; k < M(0.9); k++) for (let z = 1; z <= DOORH; z++) S(hx + (dr.v ? dr.x : dr.x + k), hy + (dr.v ? dr.y + k : dr.y), z, 0);
      for (let k = 0; ; k++) {   // Walmdach
        const ax = hx - 1 + k, bx = hx + w - k, ay = hy - 1 + k, by = hy + d - k, z = WALL + 1 + Math.floor(k * 0.7);
        if (bx - ax < 1 || by - ay < 1 || z >= H) break;
        box(ax, ay, z, bx, by, z, (X, Y) => C(jit(0x7a3426, 0.2, hash3(Math.floor(X / brick), Math.floor(Y / (2 * brick)), z))), FLAG.ROOF);
      }
      if (inT(hx, hy)) add('house', { x0: hx, y0: hy, x1: hx + w - 1, y1: hy + d - 1 });
    }
    // Carport: Dachplatte auf zwei Stützen (Testszene Tragfähigkeit)
    { const { x, y, w, d, h } = carport, p = Math.max(1, M(0.3));
      for (const [px, py] of [[x, y + (d >> 1)], [x + w - p, y + (d >> 1)]]) box(px, py, 1, px + p - 1, py + p - 1, h - 1, (X, Y, z) => C(jit(0x8a7a6a, 0.1, hash3(X, Y, z))));
      box(x, y, h, x + w - 1, y + d - 1, h + Math.max(0, M(0.2) - 1), (X, Y) => C(jit(0x5a6a7a, 0.12, hash3(Math.floor(X / 2), Y, 9))));
      if (inT(x, y)) add('carport', { x0: x, y0: y, x1: x + w - 1, y1: y + d - 1, z: h });
    }
    // Sandkasten mit Rand
    { const { x, y, w } = sand, r = Math.max(1, M(0.15));
      box(x, y, 0, x + w - 1, y + w - 1, 0, (X, Y) => C(jit(0xd8c080, 0.2, hash3(X, Y, 3))));
      box(x - r, y - r, 1, x + w - 1 + r, y + w - 1 + r, Math.max(1, M(0.25)), (X, Y) => (X < x || Y < y || X >= x + w || Y >= y + w) ? C(0x7a5a3a) : undefined);
      if (inT(x, y)) add('sand', { x: x + w / 2, y: y + w / 2, w });
    }
    // Bäume
    for (const t of trees) {
      if (t.x + t.r + 2 < ox || t.y + t.r + 2 < oy || t.x - t.r - 2 > ox + TS || t.y - t.r - 2 > oy + TS) continue;
      const tw = Math.max(1, M(0.3));
      box(t.x, t.y, 1, t.x + tw - 1, t.y + tw - 1, t.h, (X, Y, z) => C(jit(0x5a3e26, 0.2, hash3(X, Y, z))));
      const cz = t.h + t.r * 0.7, R = t.r;
      box(t.x - R - 1, t.y - R - 1, Math.floor(cz - R), t.x + R + 1, t.y + R + 1, Math.ceil(cz + R), (X, Y, z) => {
        const n = hash3(Math.floor(X / Math.max(1, M(0.2))), Math.floor(Y / Math.max(1, M(0.2))), Math.floor(z / Math.max(1, M(0.2))) + t.s * 7);
        return Math.hypot(X - t.x, Y - t.y, (z - cz) * 1.2) < R - n * M(0.25) ? C(jit(t.leaf, 0.4, n)) : undefined;
      });
    }
    // Laternen
    for (const lp of lamps) {
      const p = Math.max(1, M(0.15)), top = M(2.8);
      box(lp.x, lp.y, 1, lp.x + p - 1, lp.y + p - 1, top, C(0x3a3c42));
      box(lp.x - p, lp.y - p, top + 1, lp.x + 2 * p - 1, lp.y + 2 * p - 1, top + Math.max(1, M(0.15)), E(0xffd9a0));
      if (inT(lp.x, lp.y)) add('lamp', { x: lp.x + p / 2, y: lp.y + p / 2, z: top + 1, r: M(8), c: [1, 0.75, 0.45], i: 1.4, type: 'lamp', seed: lp.x });
    }
    // Lagerfeuer: Steinkreis und Glut
    { const R = M(0.6), st = Math.max(1, M(0.15));
      for (let a = 0; a < 12; a++) { const x = fire.x + Math.round(Math.cos(a / 12 * 6.283) * R), y = fire.y + Math.round(Math.sin(a / 12 * 6.283) * R); box(x, y, 1, x + st - 1, y + st - 1, st, C(0x6a6a66)); }
      box(fire.x - st, fire.y - st, 1, fire.x + st, fire.y + st, st, (X, Y, z) => E(hash3(X, Y, z) > 0.5 ? 0xff8a2a : 0xffb040));
      if (inT(fire.x, fire.y)) add('fire', { x: fire.x + 0.5, y: fire.y + 0.5, z: M(0.8), r: M(11), c: [1, 0.55, 0.2], i: 2, type: 'fire', seed: 3 });
    }
  }
}
