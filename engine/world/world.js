// Welt: Kacheln aus Voxeln, versionierte Deltas und Abfragen für Höhe, Kollision und Sichtlinie.
// DOM-frei. Der Renderer und das Streaming hängen sich über Ereignisse an.
//
// Koordinaten: x nach rechts, y nach unten (Kartenrichtung), z nach oben. Eine Einheit = ein Voxel.
// Kachel (tx, ty) deckt [tx·TS, tx·TS + TS) × [ty·TS, ty·TS + TS) × [0, H) ab.
//
// Eine Kachel ist immer reproduzierbar: Welt-Saat + Lage + Generatorversion + Spielzustand (tile.state)
// → Ausgangszustand, darauf die gespeicherten Deltas. Darum darf das Streaming Voxel jederzeit wegwerfen.
// Speicher bleibt nur für geladene Kacheln belegt: Volumen (Palette, 2 Byte/Voxel) und drei Karten je TS × TS
// (Säulenhöhe, Kollision, verdickte Wegkarte). Entladene Kacheln behalten nur Deltas, Zustand und Decals.

import { FLAG } from '../core/voxel.js';

export const defaultBlocks = (x, y, z, l) => !(l & FLAG.ROOF);

export class World {
  /**
   * @param {object} o
   * @param {number} o.tileSize    Kantenlänge einer Kachel in Voxeln
   * @param {number} o.tilesX      Kacheln in x
   * @param {number} o.tilesY      Kacheln in y
   * @param {number} o.height      Höhe in Voxeln (≤ 255, die Höhenkarte ist 8 Bit)
   * @param {number} o.seed        Welt-Saat
   * @param {number} [o.version]   Generatorversion (Spielstände merken sie sich)
   * @param {(x, y, z, lay) => boolean} [o.blocks]  blockiert ein belegter Voxel die Bewegung? (Standard: alles außer ROOF)
   * @param {[number, number]} [o.blockZ]  z-Bereich, der für Kollision zählt (Standard 1…7)
   */
  constructor(o) {
    this.TS = o.tileSize; this.tilesX = o.tilesX; this.tilesY = o.tilesY; this.H = o.height;
    this.W = this.TS * this.tilesX; this.D = this.TS * this.tilesY;
    this.seed = o.seed | 0; this.version = o.version ?? 1;
    this.blocks = o.blocks || defaultBlocks;
    this.blockZ = o.blockZ || [1, 7];
    this.grid = new Array(this.tilesX * this.tilesY).fill(null);
    this.tiles = new Map();
    this.builder = null;          // optional: synchroner Builder für ensure() (Tests, kleine Welten)
    this.listeners = { tileLoaded: [], tileUnloaded: [], regionChanged: [], entities: [] };
  }

  on(ev, fn) { this.listeners[ev].push(fn); return this; }
  emit(ev, ...a) { for (const fn of this.listeners[ev]) fn(...a); }

  // ---------------------------------------------------------------- Kacheln
  key(tx, ty) { return ty * this.tilesX + tx; }
  inTiles(tx, ty) { return tx >= 0 && ty >= 0 && tx < this.tilesX && ty < this.tilesY; }
  inside(x, y) { return x >= 0 && y >= 0 && x < this.W && y < this.D; }
  tileAt(x, y) { return (x >= 0 && y >= 0 && x < this.W && y < this.D) ? this.grid[((y / this.TS) | 0) * this.tilesX + ((x / this.TS) | 0)] : null; }
  tileOf(tx, ty) { return this.inTiles(tx, ty) ? this.grid[ty * this.tilesX + tx] : null; }
  loaded(tx, ty) { const t = this.tileOf(tx, ty); return !!(t && t.vol); }

  /** Kachel-Datensatz (ohne Voxel), legt ihn bei Bedarf an. */
  record(tx, ty) {
    const key = this.key(tx, ty);
    let t = this.grid[key];
    if (!t) {
      t = { key, tx, ty, vol: null, colH: null, blocked: null, path: null, rev: 0, deltas: new Map(), state: null, data: {}, decals: [], generated: false };
      this.grid[key] = t; this.tiles.set(key, t);
    }
    return t;
  }
  /** Deltas einer Kachel als Liste [[i, c, l], …] (für Aufträge an Builder/Worker). */
  deltaList(t) { const out = []; for (const [i, d] of t.deltas) out.push([i, d.c, d.l]); return out; }
  /** Spielzustand der Kachel geändert (z. B. Tür): Revision erhöhen, damit ältere Aufträge verworfen werden. */
  touch(t) { t.rev++; }

  /**
   * Ergebnis eines Builders übernehmen (Volumen, Karten, Entities). Liefert false, wenn die Revision veraltet ist.
   * r = { tx, ty, rev, vol: Volume, colH, blocked, path, entities }
   */
  install(r) {
    const t = this.record(r.tx, r.ty);
    if (r.rev !== t.rev) return false;
    t.vol = r.vol; t.colH = r.colH; t.blocked = r.blocked; t.path = r.path;
    if (!t.generated) { t.generated = true; this.emit('entities', t, r.entities || []); }
    // Wegkarte an den Rändern der Nachbarn hängt von dieser Kachel ab
    const TS = this.TS, ox = r.tx * TS, oy = r.ty * TS;
    this.updatePath(ox - 1, oy - 1, ox + TS, oy - 1); this.updatePath(ox - 1, oy + TS, ox + TS, oy + TS);
    this.updatePath(ox - 1, oy, ox - 1, oy + TS - 1); this.updatePath(ox + TS, oy, ox + TS, oy + TS - 1);
    this.updatePath(ox, oy, ox + TS - 1, oy); this.updatePath(ox, oy + TS - 1, ox + TS - 1, oy + TS - 1);
    this.updatePath(ox, oy, ox, oy + TS - 1); this.updatePath(ox + TS - 1, oy, ox + TS - 1, oy + TS - 1);
    this.emit('tileLoaded', t);
    return true;
  }
  /** Synchron erzeugen (nur mit world.builder, z. B. in Tests). Liefert true, wenn neu geladen. */
  ensure(tx, ty) {
    if (!this.inTiles(tx, ty) || this.loaded(tx, ty)) return false;
    if (!this.builder) throw new Error('ensure() braucht world.builder');
    const t = this.record(tx, ty);
    const r = this.builder.build(this.request(tx, ty, { bake: false, entities: !t.generated }));
    return this.install(r);
  }
  /** Auftrag für einen Builder: Mitte plus 3 × 3 Nachbarn mit Revision, Zustand und Deltas. */
  request(tx, ty, o = {}) {
    const tiles = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = tx + dx, y = ty + dy; if (!this.inTiles(x, y)) continue;
      const t = this.record(x, y);
      tiles.push({ tx: x, ty: y, rev: t.rev, state: t.state, deltas: t.deltas.size ? this.deltaList(t) : null });
    }
    return { tx, ty, rev: this.record(tx, ty).rev, tiles, bake: !!o.bake, entities: !!o.entities };
  }

  /** Voxel außerhalb des Quadrats ±keep um (ctx, cty) freigeben. Deltas, Zustand und Decals bleiben. */
  evict(ctx, cty, keep) {
    const out = [];
    for (const t of this.tiles.values()) if (t.vol && (Math.abs(t.tx - ctx) > keep || Math.abs(t.ty - cty) > keep)) {
      t.vol = null; t.colH = null; t.blocked = null; t.path = null; out.push(t);
      this.emit('tileUnloaded', t);
    }
    return out;
  }
  /** Geladene Bytes (Volumen und Karten). */
  bytes() {
    let b = 0;
    for (const t of this.tiles.values()) if (t.vol) b += t.vol.bytes() + 3 * this.TS * this.TS;
    return b;
  }

  // ---------------------------------------------------------------- Voxelzugriff
  getC(x, y, z) {
    if (z < 0 || z >= this.H) return 0;
    const t = this.tileAt(x, y); if (!t || !t.vol) return 0;
    const TS = this.TS; return t.vol.palC[t.vol.data[(z * TS + (y % TS)) * TS + (x % TS)]];
  }
  getL(x, y, z) {
    if (z < 0 || z >= this.H) return 0;
    const t = this.tileAt(x, y); if (!t || !t.vol) return 0;
    const TS = this.TS; return t.vol.palL[t.vol.data[(z * TS + (y % TS)) * TS + (x % TS)]];
  }
  /** Voxel setzen, ohne Delta (für Zustand, den das Spiel selbst verwaltet und über tile.state reproduziert). */
  setV(x, y, z, c, l = 0) {
    if (z < 0 || z >= this.H) return;
    const t = this.tileAt(x, y);
    if (t && t.vol) t.vol.set(x % this.TS, y % this.TS, z, c, l);
  }
  /**
   * Bleibende Änderung: wird als Delta gespeichert und überlebt Entladen und Neuerzeugen.
   * Erhöht die Revision der Kachel. Die Abfragen werden erst mit commit() bzw. updateRegion() aktuell.
   */
  edit(x, y, z, c, l = 0) {
    if (!this.inside(x, y) || z < 0 || z >= this.H) return;
    const t = this.record((x / this.TS) | 0, (y / this.TS) | 0), TS = this.TS;
    const i = (z * TS + (y % TS)) * TS + (x % TS);
    t.rev++;
    t.deltas.set(i, { c, l: c ? l : 0, rev: t.rev });
    if (t.vol) t.vol.setAt(i, c, l);
  }
  /** Mehrere edit()-Aufrufe abschließen: Abfragen im Rechteck aktualisieren und Ereignis senden. */
  commit(x0, y0, x1, y1) { this.updateRegion(x0, y0, x1, y1); }

  // ---------------------------------------------------------------- Abgeleitete Karten
  updateColumn(x, y) {
    const t = this.tileAt(x, y); if (!t || !t.vol) return;
    const i = (y % this.TS) * this.TS + (x % this.TS);
    columnInfo(t.vol, x % this.TS, y % this.TS, this.H, this.blocks, this.blockZ, x, y, t.colH, t.blocked, i);
  }
  /** Verdickung um eine Zelle (8 Nachbarn): ein Kreis mit Radius ≤ 1,2 passt durch jede Lücke ≥ 3. */
  updatePath(x0, y0, x1, y1) {
    const TS = this.TS;
    for (let y = Math.max(0, y0); y <= Math.min(this.D - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(this.W - 1, x1); x++) {
      const t = this.tileAt(x, y); if (!t || !t.path) continue;
      let b = 0;
      for (let dy = -1; dy <= 1 && !b; dy++) for (let dx = -1; dx <= 1; dx++) if (this.blockedAt(x + dx, y + dy)) { b = 1; break; }
      t.path[(y % TS) * TS + (x % TS)] = b;
    }
  }
  updateRegion(x0, y0, x1, y1) {
    x0 = Math.max(0, x0 | 0); y0 = Math.max(0, y0 | 0); x1 = Math.min(this.W - 1, x1 | 0); y1 = Math.min(this.D - 1, y1 | 0);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.updateColumn(x, y);
    this.updatePath(x0 - 1, y0 - 1, x1 + 1, y1 + 1);
    this.emit('regionChanged', x0, y0, x1, y1);
  }

  // ---------------------------------------------------------------- Abfragen
  /** Höhe der Säule ab z = 1 (+1), 0 = frei oder nicht geladen. */
  height(x, y) {
    const t = this.tileAt(x, y); if (!t || !t.colH) return 0;
    const TS = this.TS; return t.colH[((y | 0) % TS) * TS + ((x | 0) % TS)];
  }
  /** Kollision; außerhalb der Welt und in nicht geladenen Kacheln gilt alles als blockiert. */
  blockedAt(x, y) {
    const t = this.tileAt(x, y); if (!t || !t.blocked) return true;
    const TS = this.TS; return t.blocked[((y | 0) % TS) * TS + ((x | 0) % TS)] === 1;
  }
  pathBlockedAt(x, y) {
    const t = this.tileAt(x, y); if (!t || !t.path) return true;
    const TS = this.TS; return t.path[((y | 0) % TS) * TS + ((x | 0) % TS)] === 1;
  }
  isBlocked(x, y) { return this.blockedAt(Math.floor(x), Math.floor(y)); }
  /** Kreis mit Radius r frei? (8 Randpunkte) */
  free(x, y, r) {
    for (const [ox, oy] of [[-r, -r], [r, -r], [-r, r], [r, r], [0, -r], [0, r], [-r, 0], [r, 0]]) if (this.isBlocked(x + ox, y + oy)) return false;
    return true;
  }
  /** Bewegung mit Gleiten an Wänden (Achsen getrennt). Liefert die zurückgelegte Strecke. */
  move(e, dx, dy, r) {
    let m = 0;
    if (this.free(e.x + dx, e.y, r)) { e.x += dx; m += Math.abs(dx); }
    if (this.free(e.x, e.y + dy, r)) { e.y += dy; m += Math.abs(dy); }
    return m;
  }
  /** Sichtlinie über die Höhenkarte: frei, solange keine Säule ≥ hmin dazwischen ist. skipEnd: letzte Strecke ignorieren. */
  los(ax, ay, bx, by, hmin = 9, skipEnd = 0) {
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy), n = Math.ceil(len / 0.7);
    for (let k = 1; k < n; k++) {
      if (len * (1 - k / n) < skipEnd) break;
      if (this.height(ax + dx * k / n, ay + dy * k / n) >= hmin) return false;
    }
    return true;
  }
  /** Strahl bis zur ersten Säule ≥ hmin; liefert die Entfernung (höchstens max). */
  ray(x, y, dx, dy, max, hmin = 6) {
    for (let t = 1.5; t < max; t += 0.4) {
      const cx = x + dx * t, cy = y + dy * t;
      if (!this.inside(cx, cy) || this.height(cx, cy) >= hmin) return t;
    }
    return max;
  }

  // ---------------------------------------------------------------- Deltas (Spielstand)
  /** Alle Änderungen und Spielzustände als JSON-taugliches Objekt. */
  exportDeltas() {
    const tiles = [];
    for (const t of this.tiles.values()) if (t.deltas.size || t.state) {
      tiles.push({ tx: t.tx, ty: t.ty, rev: t.rev, state: t.state, d: [...t.deltas].map(([i, v]) => [i, v.c, v.l, v.rev]) });
    }
    return { seed: this.seed, version: this.version, tileSize: this.TS, height: this.H, tiles };
  }
  /** Änderungen übernehmen. Geladene Kacheln werden verworfen und neu gebaut (Streaming oder ensure()). */
  importDeltas(s) {
    if (s.seed !== this.seed || s.version !== this.version || s.tileSize !== this.TS || s.height !== this.H)
      throw new Error('Spielstand passt nicht zu dieser Welt (Saat, Generatorversion oder Maße)');
    for (const e of s.tiles) {
      const t = this.record(e.tx, e.ty);
      t.rev = Math.max(t.rev, e.rev) + 1; t.state = e.state ?? t.state;
      for (const [i, c, l, rev] of e.d) t.deltas.set(i, { c, l, rev });
      if (t.vol) { t.vol = null; t.colH = t.blocked = t.path = null; this.emit('tileUnloaded', t); }
    }
  }
}

/** Säulenhöhe und Kollision einer Spalte (gemeinsam für Welt und Builder). */
export function columnInfo(vol, lx, ly, H, blocks, blockZ, x, y, colH, blocked, i) {
  let h = 0;
  for (let z = 1; z < H; z++) { if (!vol.palC[vol.data[vol.idx(lx, ly, z)]]) break; h = z; }
  colH[i] = h ? h + 1 : 0;
  let b = 0;
  for (let z = blockZ[0]; z <= blockZ[1]; z++) {
    const p = vol.data[vol.idx(lx, ly, z)];
    if (p && blocks(x, y, z, vol.palL[p])) { b = 1; break; }
  }
  blocked[i] = b;
}
