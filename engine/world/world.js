// Welt: Kacheln aus Voxeln, versionierte Deltas und Abfragen für Höhe, Kollision und Sichtlinie.
// DOM-frei. Der Renderer und das Streaming hängen sich über Ereignisse an (onTileLoaded, onRegionChanged).
//
// Koordinaten: x nach rechts, y nach unten (Kartenrichtung), z nach oben. Eine Einheit = ein Voxel.
// Kachel (tx, ty) deckt [tx·TS, tx·TS + TS) × [ty·TS, ty·TS + TS) × [0, H) ab.
//
// Eine Kachel ist immer reproduzierbar: Welt-Saat + Lage + Generatorversion → Ausgangszustand,
// darauf werden die gespeicherten Deltas angewandt. Darum darf das Streaming Voxel jederzeit wegwerfen.

import { Volume, FLAG } from '../core/voxel.js';
import { mulberry32, tileSeed } from '../core/rand.js';

const DIRS8 = [[0, -1], [1, 0], [0, 1], [-1, 0], [1, -1], [1, 1], [-1, 1], [-1, -1]];

export class World {
  /**
   * @param {object} o
   * @param {number} o.tileSize    Kantenlänge einer Kachel in Voxeln
   * @param {number} o.tilesX      Kacheln in x
   * @param {number} o.tilesY      Kacheln in y
   * @param {number} o.height      Höhe in Voxeln (≤ 255, die Höhenkarte ist 8 Bit)
   * @param {number} o.seed        Welt-Saat
   * @param {number} [o.version]   Generatorversion; ändert die Kachel-Saat, damit alte Spielstände erkennbar sind
   * @param {(tile, vol, ctx) => void} o.generate  füllt vol (lokale Koordinaten)
   * @param {(x, y, z, lay) => boolean} [o.blocks] blockiert der Voxel die Bewegung? (Standard: alles außer ROOF)
   * @param {[number, number]} [o.blockZ]  z-Bereich, der für Kollision zählt (Standard 1…7)
   */
  constructor(o) {
    this.TS = o.tileSize; this.tilesX = o.tilesX; this.tilesY = o.tilesY; this.H = o.height;
    this.W = this.TS * this.tilesX; this.D = this.TS * this.tilesY;
    this.seed = o.seed | 0; this.version = o.version ?? 1;
    this.generate = o.generate;
    this.blocks = o.blocks || ((x, y, z, l) => !(l & FLAG.ROOF));
    this.blockZ = o.blockZ || [1, 7];
    this.tiles = new Map();
    this.colH = new Uint8Array(this.W * this.D);         // Höhe der zusammenhängenden Säule ab z = 1 (+1), 0 = frei
    this.blocked = new Uint8Array(this.W * this.D);      // Kollision für Figuren
    this.pathBlocked = new Uint8Array(this.W * this.D);  // um 1 Zelle verdickt, für Wegfindung
    this.listeners = { tileLoaded: [], regionChanged: [] };
  }

  on(ev, fn) { this.listeners[ev].push(fn); return this; }
  emit(ev, ...a) { for (const fn of this.listeners[ev]) fn(...a); }

  // ---------------------------------------------------------------- Kacheln
  key(tx, ty) { return ty * this.tilesX + tx; }
  inTiles(tx, ty) { return tx >= 0 && ty >= 0 && tx < this.tilesX && ty < this.tilesY; }
  inside(x, y) { return x >= 0 && y >= 0 && x < this.W && y < this.D; }
  tileAt(x, y) { return this.tiles.get(this.key((x / this.TS) | 0, (y / this.TS) | 0)); }
  tileOf(tx, ty) { return this.tiles.get(this.key(tx, ty)); }

  /** Kachel-Datensatz (ohne Voxel), legt ihn bei Bedarf an. */
  record(tx, ty) {
    const key = this.key(tx, ty);
    let t = this.tiles.get(key);
    if (!t) { t = { key, tx, ty, vol: null, rev: 0, deltas: new Map(), data: {}, decals: [], generated: false }; this.tiles.set(key, t); }
    return t;
  }

  /** Voxel einer Kachel erzeugen, falls nicht geladen. Liefert true, wenn neu erzeugt. */
  ensure(tx, ty) {
    if (!this.inTiles(tx, ty)) return false;
    const t = this.record(tx, ty);
    if (t.vol) return false;
    const vol = new Volume(this.TS, this.TS, this.H);
    const first = !t.generated;
    this.generate(t, vol, { first, rng: mulberry32(tileSeed(this.seed, tx, ty, this.version)), ox: tx * this.TS, oy: ty * this.TS, world: this });
    t.generated = true;
    for (const [i, d] of t.deltas) { vol.col[i] = d.c; vol.lay[i] = d.c ? d.l : 0; }
    t.vol = vol;
    const ox = tx * this.TS, oy = ty * this.TS;
    for (let y = 0; y < this.TS; y++) for (let x = 0; x < this.TS; x++) this.updateColumn(ox + x, oy + y);
    this.updatePath(ox - 1, oy - 1, ox + this.TS, oy + this.TS);
    this.emit('tileLoaded', t);
    return true;
  }

  /** Voxel außerhalb des Quadrats ±keep um (ctx, cty) freigeben. Deltas und Spielzustand bleiben. */
  evict(ctx, cty, keep) {
    const out = [];
    for (const t of this.tiles.values()) if (t.vol && (Math.abs(t.tx - ctx) > keep || Math.abs(t.ty - cty) > keep)) { t.vol = null; out.push(t); }
    return out;
  }

  // ---------------------------------------------------------------- Voxelzugriff
  getC(x, y, z) {
    if (x < 0 || y < 0 || x >= this.W || y >= this.D || z < 0 || z >= this.H) return 0;
    const t = this.tileAt(x, y), TS = this.TS;
    return t && t.vol ? t.vol.col[(z * TS + (y % TS)) * TS + (x % TS)] : 0;
  }
  getL(x, y, z) {
    if (x < 0 || y < 0 || x >= this.W || y >= this.D || z < 0 || z >= this.H) return 0;
    const t = this.tileAt(x, y), TS = this.TS;
    return t && t.vol ? t.vol.lay[(z * TS + (y % TS)) * TS + (x % TS)] : 0;
  }
  /** Voxel setzen, ohne Delta (für Zustand, den das Spiel selbst verwaltet, z. B. Türen). */
  setV(x, y, z, c, l = 0) {
    if (!this.inside(x, y)) return;
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
    if (t.vol) { t.vol.col[i] = c; t.vol.lay[i] = c ? l : 0; }
  }
  /** Mehrere edit()-Aufrufe abschließen: Abfragen im Rechteck aktualisieren und Ereignis senden. */
  commit(x0, y0, x1, y1) { this.updateRegion(x0, y0, x1, y1); }

  // ---------------------------------------------------------------- Abgeleitete Karten
  updateColumn(x, y) {
    let h = 0;
    for (let z = 1; z < this.H; z++) { if (!this.getC(x, y, z)) break; h = z; }
    this.colH[y * this.W + x] = h ? h + 1 : 0;
    let b = 0;
    for (let z = this.blockZ[0]; z <= this.blockZ[1]; z++) {
      if (this.getC(x, y, z) && this.blocks(x, y, z, this.getL(x, y, z))) { b = 1; break; }
    }
    this.blocked[y * this.W + x] = b;
  }
  /** Verdickung um eine Zelle (8 Nachbarn): ein Kreis mit Radius ≤ 1,2 passt durch jede Lücke ≥ 3. */
  updatePath(x0, y0, x1, y1) {
    const { W, D, blocked } = this;
    for (let y = Math.max(0, y0); y <= Math.min(D - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(W - 1, x1); x++) {
      let b = blocked[y * W + x];
      if (!b) for (let dy = -1; dy <= 1 && !b; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= D || blocked[ny * W + nx]) { b = 1; break; }
      }
      this.pathBlocked[y * W + x] = b;
    }
  }
  updateRegion(x0, y0, x1, y1) {
    x0 = Math.max(0, x0 | 0); y0 = Math.max(0, y0 | 0); x1 = Math.min(this.W - 1, x1 | 0); y1 = Math.min(this.D - 1, y1 | 0);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.updateColumn(x, y);
    this.updatePath(x0 - 1, y0 - 1, x1 + 1, y1 + 1);
    this.emit('regionChanged', x0, y0, x1, y1);
  }

  // ---------------------------------------------------------------- Abfragen
  height(x, y) { x |= 0; y |= 0; return this.inside(x, y) ? this.colH[y * this.W + x] : 0; }
  isBlocked(x, y) { x = Math.floor(x); y = Math.floor(y); return !this.inside(x, y) || this.blocked[y * this.W + x] === 1; }
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
  /** Alle Änderungen als JSON-taugliches Objekt. */
  exportDeltas() {
    const tiles = [];
    for (const t of this.tiles.values()) if (t.deltas.size) {
      tiles.push({ tx: t.tx, ty: t.ty, rev: t.rev, d: [...t.deltas].map(([i, v]) => [i, v.c, v.l, v.rev]) });
    }
    return { seed: this.seed, version: this.version, tileSize: this.TS, height: this.H, tiles };
  }
  /** Änderungen übernehmen; geladene Kacheln werden sofort aktualisiert. */
  importDeltas(s) {
    if (s.seed !== this.seed || s.version !== this.version || s.tileSize !== this.TS || s.height !== this.H)
      throw new Error('Spielstand passt nicht zu dieser Welt (Saat, Generatorversion oder Maße)');
    for (const e of s.tiles) {
      const t = this.record(e.tx, e.ty);
      t.rev = Math.max(t.rev, e.rev);
      for (const [i, c, l, rev] of e.d) {
        t.deltas.set(i, { c, l, rev });
        if (t.vol) { t.vol.col[i] = c; t.vol.lay[i] = c ? l : 0; }
      }
      if (t.vol) this.updateRegion(t.tx * this.TS, t.ty * this.TS, t.tx * this.TS + this.TS - 1, t.ty * this.TS + this.TS - 1);
    }
  }
}

export { DIRS8 };
