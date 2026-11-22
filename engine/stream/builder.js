// Builder: erzeugt und backt Kacheln aus einem Generator-Modul. DOM-frei; läuft im Worker oder synchron.
//
// Generator-Modul (vom Spiel), Schnittstelle:
//   export function createGenerator(config) {
//     return {
//       tileSize, tilesX, tilesY, height, version,
//       generate(tile, vol, ctx),        // füllt vol in lokalen Koordinaten; tile = { tx, ty, key, state }
//       blocks(x, y, z, lay),            // optional, sonst alles außer ROOF
//       blockZ,                          // optional, z-Bereich für Kollision
//     };
//   }
//   ctx = { rng, ox, oy, seed, state, add(type, data) }: add meldet Entities (Lichter, Behälter …); der Empfänger bekommt
//   sie als [{ type, data }] genau einmal pro Kachel (Ereignis 'entities' der Welt).
//   state ist der Spielzustand der Kachel (z. B. Türen offen/zu); generate muss ihn anwenden.
//
// Ein Auftrag enthält die Mitte und ihre 8 Nachbarn mit Revision, Zustand und Deltas. Der Builder hält einen Cache
// erzeugter Kacheln und erzeugt nur neu, was fehlt oder eine andere Revision hat. Das Ergebnis trägt die Revision
// der Mitte; der Empfänger verwirft es, wenn sich die Kachel inzwischen geändert hat.

import { Volume } from '../core/voxel.js';
import { mulberry32, tileSeed } from '../core/rand.js';
import { bakeBox, bakeBricks, chunkBounds } from '../render/bake.js';
import { columnInfo, defaultBlocks } from '../world/world.js';

export class Builder {
  constructor(gen, seed, o = {}) {
    this.gen = gen; this.seed = seed | 0;
    this.TS = gen.tileSize; this.H = gen.height; this.tilesX = gen.tilesX; this.tilesY = gen.tilesY;
    this.version = gen.version ?? 1; this.S = gen.sub ?? 1;
    this.blocks = gen.blocks || defaultBlocks; this.blockZ = gen.blockZ || [1, 7];
    this.sun = o.sun;
    this.cache = new Map(); this.maxCache = o.maxCache ?? 48;
    this.stats = { generated: 0, baked: 0, genMs: 0, bakeMs: 0 };
  }
  key(tx, ty) { return ty * this.tilesX + tx; }
  /** Kachel im Cache auf den Stand der Anfrage bringen. */
  tile(info) {
    const key = this.key(info.tx, info.ty);
    let c = this.cache.get(key);
    if (c && c.rev === info.rev && c.stateKey === JSON.stringify(info.state ?? null)) { c.used = ++this.clock; return c; }
    const t0 = now();
    const vol = new Volume(this.TS, this.TS, this.H, this.S), entities = [];
    const ox = info.tx * this.TS, oy = info.ty * this.TS;
    this.gen.generate({ tx: info.tx, ty: info.ty, key, state: info.state ?? null }, vol, {
      rng: mulberry32(tileSeed(this.seed, info.tx, info.ty, this.version)), ox, oy, seed: this.seed, state: info.state ?? null,
      add: (type, data) => entities.push({ type, data }),
    });
    if (info.deltas) for (const [i, col, l] of info.deltas) vol.setAt(i, col, l);
    if (info.bricks) for (const [i, col, l] of info.bricks) vol.setBrickColors(i, { c: col, l });
    c = { key, tx: info.tx, ty: info.ty, rev: info.rev, stateKey: JSON.stringify(info.state ?? null), vol, entities, used: ++this.clock };
    this.cache.set(key, c);
    this.stats.generated++; this.stats.genMs += now() - t0;
    if (this.cache.size > this.maxCache) {
      let old = null; for (const v of this.cache.values()) if (!old || v.used < old.used) old = v;
      this.cache.delete(old.key);
    }
    return c;
  }
  clock = 0;
  getC(x, y, z) {
    if (z < 0 || z >= this.H || x < 0 || y < 0) return 0;
    const c = this.cache.get(this.key((x / this.TS) | 0, (y / this.TS) | 0));
    if (!c || x >= this.tilesX * this.TS || y >= this.tilesY * this.TS) return 0;
    const v = c.vol; return v.palC[v.data[(z * this.TS + (y % this.TS)) * this.TS + (x % this.TS)]];
  }
  getL(x, y, z) {
    if (z < 0 || z >= this.H || x < 0 || y < 0) return 0;
    const c = this.cache.get(this.key((x / this.TS) | 0, (y / this.TS) | 0));
    if (!c) return 0;
    const v = c.vol; return v.palL[v.data[(z * this.TS + (y % this.TS)) * this.TS + (x % this.TS)]];
  }
  getFine(fx, fy, fz) {
    const S = this.S, x = Math.floor(fx / S), y = Math.floor(fy / S), z = Math.floor(fz / S);
    if (z < 0 || z >= this.H || x < 0 || y < 0) return 0;
    const c = this.cache.get(this.key((x / this.TS) | 0, (y / this.TS) | 0)); if (!c || x >= this.tilesX * this.TS) return 0;
    return c.vol.getFine((z * this.TS + (y % this.TS)) * this.TS + (x % this.TS), fx - x * S, fy - y * S, fz - z * S);
  }
  getFineLay(fx, fy, fz) {
    const S = this.S, x = Math.floor(fx / S), y = Math.floor(fy / S), z = Math.floor(fz / S);
    if (z < 0 || z >= this.H || x < 0 || y < 0) return 0;
    const c = this.cache.get(this.key((x / this.TS) | 0, (y / this.TS) | 0)); if (!c || x >= this.tilesX * this.TS) return 0;
    return c.vol.getFineLay((z * this.TS + (y % this.TS)) * this.TS + (x % this.TS), fx - x * S, fy - y * S, fz - z * S);
  }
  blockedAt(x, y, own) {
    if (x < 0 || y < 0 || x >= this.tilesX * this.TS || y >= this.tilesY * this.TS) return 1;
    const c = this.cache.get(this.key((x / this.TS) | 0, (y / this.TS) | 0));
    if (!c) return 1;
    if (!c.blocked) this.maps(c);
    return c.blocked[(y % this.TS) * this.TS + (x % this.TS)];
  }
  maps(c) {
    const TS = this.TS, ox = c.tx * TS, oy = c.ty * TS;
    c.colH = new Uint8Array(TS * TS); c.blocked = new Uint8Array(TS * TS); c.colTop = new Uint8Array(TS * TS);
    for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) columnInfo(c.vol, x, y, this.H, this.blocks, this.blockZ, ox + x, oy + y, c.colH, c.blocked, y * TS + x, c.colTop);
  }
  /**
   * Auftrag ausführen. req = { tx, ty, rev, tiles: [{tx, ty, rev, state, deltas}], bake, entities }
   * Liefert { tx, ty, rev, vol (gepackt), colH, blocked, path, entities?, A?, B?, bb? }.
   */
  build(req, pack = false) {
    for (const info of req.tiles) this.tile(info);
    const c = this.cache.get(this.key(req.tx, req.ty)), TS = this.TS, H = this.H, ox = req.tx * TS, oy = req.ty * TS;
    if (!c.blocked) this.maps(c);
    const path = new Uint8Array(TS * TS);
    for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
      let b = 0;
      for (let dy = -1; dy <= 1 && !b; dy++) for (let dx = -1; dx <= 1; dx++) if (this.blockedAt(ox + x + dx, oy + y + dy)) { b = 1; break; }
      path[y * TS + x] = b;
    }
    const out = { tx: req.tx, ty: req.ty, rev: req.rev, vol: pack ? c.vol.pack(true) : copyVolume(c.vol), colH: c.colH.slice(), colTop: c.colTop.slice(), blocked: c.blocked.slice(), path };
    if (req.entities) out.entities = c.entities;
    if (req.bake) {
      const t0 = now(), n = TS * TS * H * 4, A = new Uint8Array(n), B = new Uint8Array(n);
      bakeBox((x, y, z) => this.getC(x, y, z), (x, y, z) => this.getL(x, y, z), ox, oy, TS, TS, H, true, A, B, this.sun);
      out.A = A; out.B = B; out.bb = chunkBounds(c.vol.data, TS, TS, H);
      if (c.vol.bricks.size) {
        const keys = Uint32Array.from(c.vol.bricks.keys());
        const bb = bakeBricks((x, y, z) => this.getFine(x, y, z), (x, y, z) => this.getFineLay(x, y, z), (x, y, z) => this.getC(x, y, z), [...keys], TS, ox, oy, H, this.S, this.sun);
        out.bricks = { keys, A: bb.A, B: bb.B };
      }
      this.stats.baked++; this.stats.bakeMs += now() - t0;
    }
    return out;
  }
}

function copyVolume(v) { const o = v.pack(true); return Volume.unpack(o); }
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Übertragbare Puffer eines gepackten Ergebnisses (für postMessage). */
export function transferList(r) {
  const l = [r.vol.data.buffer, r.vol.palC.buffer, r.vol.palL.buffer, r.vol.bKeys.buffer, r.vol.bData.buffer, r.colH.buffer, r.colTop.buffer, r.blocked.buffer, r.path.buffer];
  if (r.A) l.push(r.A.buffer, r.B.buffer, r.bb.buffer);
  if (r.bricks) l.push(r.bricks.keys.buffer, r.bricks.A.buffer, r.bricks.B.buffer);
  return l;
}
