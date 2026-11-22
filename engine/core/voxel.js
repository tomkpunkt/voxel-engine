// Voxel-Farben und Volumen.
// Ein Voxel ist eine 32-Bit-Zahl: Bit 24 = belegt, Bit 25 = leuchtet, Bits 0–23 = RGB.
// Daneben gibt es pro Voxel ein Byte "lay" mit Flags (siehe FLAG).

export const SOLID = 0x1000000, EMIT = 0x2000000;
export const C = hex => SOLID | hex;            // normaler Voxel
export const E = hex => SOLID | EMIT | hex;     // leuchtender Voxel

/** Flags im lay-Byte. 1 und 2 wertet der Renderer aus (Kappen), der Rest gehört dem Spiel. */
export const FLAG = {
  ROOF: 1,      // wird gekappt, wenn die Kamera "im Gebäude" ist; blockiert nicht
  WALLTOP: 2,   // obere Wandhälfte, wird mit gekappt
  SUB: 4,       // Stellvertreter eines unterteilten Blocks (Brick): zählt für Abfragen, wird grob nicht gezeichnet
  GAME0: 8, GAME1: 16, GAME2: 32, GAME3: 64, GAME4: 128,
};

export function shade(hex, f) {
  const r = Math.min(255, Math.max(0, ((hex >> 16) & 255) * f | 0));
  const g = Math.min(255, Math.max(0, ((hex >> 8) & 255) * f | 0));
  const b = Math.min(255, Math.max(0, (hex & 255) * f | 0));
  return (r << 16) | (g << 8) | b;
}
/** Farbe um ±amt/2 aufhellen oder abdunkeln, gesteuert von h ∈ [0,1). */
export const jit = (hex, amt, h) => shade(hex, 1 + (h - 0.5) * amt);
export const rgbOf = hex => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];

/**
 * Volumen w × d × h (x schnell, dann y, dann z) mit Palette: pro Voxel ein Uint16-Index auf ein Paar (Farbe, Flags).
 * Index 0 = leer. 2 Byte pro Voxel statt 5 (Uint32 Farbe + Uint8 Flags). Ab 64 000 Einträgen werden neue Farben
 * auf 3 Bit pro Kanal vergröbert (die letzten Plätze sind dafür reserviert); bei normalem Inhalt kommt das nicht vor.
 */
export class Volume {
  /** @param {number} [sub] Unterteilungsfaktor S (1 = keine, 2 oder 4): ein Block kann zu S³ feinen Blöcken werden */
  constructor(w, d, h, sub = 1) {
    this.w = w; this.d = d; this.h = h; this.S = sub;
    this.data = new Uint16Array(w * d * h);
    this.palC = new Uint32Array(256); this.palL = new Uint8Array(256); this.n = 1;
    this.map = null;
    this.bricks = new Map();     // Blockindex → Uint16Array(S³) Palettenindizes (x schnell, dann y, dann z)
  }
  idx(x, y, z) { return (z * this.d + y) * this.w + x; }
  ok(x, y, z) { return x >= 0 && y >= 0 && z >= 0 && x < this.w && y < this.d && z < this.h; }
  /** Palettenindex für (Farbe, Flags), legt ihn bei Bedarf an. */
  index(c, l = 0) {
    if (!c) return 0;
    if (!this.map) { this.map = new Map(); for (let i = 1; i < this.n; i++) this.map.set(this.palC[i] * 256 + this.palL[i], i); }
    const k = c * 256 + (l & 255);
    let i = this.map.get(k);
    if (i !== undefined) return i;
    if (this.n >= 64000) {
      // Palette fast voll: grob auf 3 Bit pro Kanal (512 Farben je Flag-Kombination), die letzten Plätze dafür reserviert
      const q = (c & 0xff000000) | (c & 0xe0e0e0) | 0x101010;
      if (q !== c) { i = this.index(q, l); this.map.set(k, i); return i; }
      if (this.n >= 65535) {                                      // auch das voll: nächster vorhandener Eintrag (gemerkt)
        let best = 1, bd = 1e9;
        for (let j = 1; j < this.n; j++) { const e = this.palC[j], dd = Math.abs((e & 255) - (c & 255)) + Math.abs(((e >> 8) & 255) - ((c >> 8) & 255)) + Math.abs(((e >> 16) & 255) - ((c >> 16) & 255)); if (dd < bd) { bd = dd; best = j; } }
        this.map.set(k, best); return best;
      }
    }
    if (this.n >= this.palC.length) {
      const nc = new Uint32Array(this.palC.length * 2), nl = new Uint8Array(this.palC.length * 2);
      nc.set(this.palC); nl.set(this.palL); this.palC = nc; this.palL = nl;
    }
    i = this.n++; this.palC[i] = c; this.palL[i] = l & 255; this.map.set(k, i);
    return i;
  }
  set(x, y, z, c, l = 0) { if (this.ok(x, y, z)) this.setAt(this.idx(x, y, z), c, l); }
  /** Ganzen Block setzen; eine Unterteilung an dieser Stelle verschwindet. */
  setAt(i, c, l = 0) { if (this.bricks.size) this.bricks.delete(i); this.data[i] = this.index(c, l & ~FLAG.SUB); }

  // ---- Unterteilung
  /** Block i in S³ feine Blöcke teilen (alle mit seiner Farbe). Liefert den Brick. */
  subdivide(i) {
    let b = this.bricks.get(i);
    if (b) return b;
    const S = this.S, p = this.data[i];
    b = new Uint16Array(S * S * S);
    if (p) { b.fill(this.index(this.palC[p], this.palL[p] & ~FLAG.SUB)); this.data[i] = this.index(this.palC[p], this.palL[p] | FLAG.SUB); }
    this.bricks.set(i, b);
    return b;                     // updateRep() erst nach der Änderung (sonst fällt der einheitliche Brick sofort zusammen)
  }
  /** Feinen Block (sx, sy, sz) in Block i setzen; teilt bei Bedarf. */
  setFine(i, sx, sy, sz, c, l = 0) {
    const S = this.S, b = this.subdivide(i);
    b[(sz * S + sy) * S + sx] = this.index(c, l & ~FLAG.SUB);
    this.updateRep(i);
  }
  getFine(i, sx, sy, sz) {
    const b = this.bricks.size ? this.bricks.get(i) : undefined;
    if (b) return this.palC[b[(sz * this.S + sy) * this.S + sx]];
    return this.palC[this.data[i]];
  }
  getFineLay(i, sx, sy, sz) {
    const b = this.bricks.size ? this.bricks.get(i) : undefined;
    if (b) return this.palL[b[(sz * this.S + sy) * this.S + sx]];
    return this.palL[this.data[i]];
  }
  /**
   * Stellvertreter im groben Gitter nachführen: leer → Brick weg; einheitlich → wieder ein ganzer Block;
   * mindestens halb gefüllt → häufigste Farbe mit Flag SUB (zählt für Höhe, Kollision, Sicht); sonst grob leer.
   */
  updateRep(i) {
    const b = this.bricks.get(i); if (!b) return;
    let cnt = 0, first = b[0], same = true;
    const freq = new Map();
    for (let k = 0; k < b.length; k++) { const v = b[k]; if (v !== first) same = false; if (v) { cnt++; freq.set(v, (freq.get(v) || 0) + 1); } }
    if (!cnt) { this.bricks.delete(i); this.data[i] = 0; return; }
    if (same) { this.bricks.delete(i); this.data[i] = first; return; }
    if (cnt * 2 >= b.length) {
      let m = 0, mc = 0; for (const [v, n] of freq) if (n > mc) { mc = n; m = v; }
      this.data[i] = this.index(this.palC[m], this.palL[m] | FLAG.SUB);
    } else this.data[i] = 0;
  }
  /** Brick als Farben und Flags (für Deltas). */
  brickColors(i) {
    const b = this.bricks.get(i); if (!b) return null;
    const c = new Array(b.length), l = new Array(b.length);
    for (let k = 0; k < b.length; k++) { c[k] = this.palC[b[k]]; l[k] = this.palL[b[k]]; }
    return { c, l };
  }
  setBrickColors(i, bc) {
    const S = this.S, b = new Uint16Array(S * S * S);
    for (let k = 0; k < b.length; k++) b[k] = this.index(bc.c[k], bc.l[k]);
    this.bricks.set(i, b); this.updateRep(i);
  }
  get(x, y, z) { return this.ok(x, y, z) ? this.palC[this.data[this.idx(x, y, z)]] : 0; }
  getLay(x, y, z) { return this.ok(x, y, z) ? this.palL[this.data[this.idx(x, y, z)]] : 0; }
  colAt(i) { return this.palC[this.data[i]]; }
  layAt(i) { return this.palL[this.data[i]]; }
  /** Speicherbedarf in Byte. */
  bytes() { let b = this.data.byteLength + this.n * 5; for (const v of this.bricks.values()) b += v.byteLength + 16; return b; }
  /** Als übertragbares Objekt (für postMessage); copy = false gibt die eigenen Puffer ab. */
  pack(copy = true) {
    const S3 = this.S ** 3, keys = new Uint32Array(this.bricks.size), bd = new Uint16Array(this.bricks.size * S3);
    let k = 0; for (const [i, b] of this.bricks) { keys[k] = i; bd.set(b, k * S3); k++; }
    return { w: this.w, d: this.d, h: this.h, S: this.S, n: this.n, data: copy ? this.data.slice() : this.data,
      palC: this.palC.slice(0, this.n), palL: this.palL.slice(0, this.n), bKeys: keys, bData: bd };
  }
  static transfer(o) { return [o.data.buffer, o.palC.buffer, o.palL.buffer, o.bKeys.buffer, o.bData.buffer]; }
  static unpack(o) {
    const v = Object.create(Volume.prototype);
    Object.assign(v, { w: o.w, d: o.d, h: o.h, S: o.S || 1, data: o.data, palC: o.palC, palL: o.palL, n: o.n, map: null, bricks: new Map() });
    const S3 = v.S ** 3;
    if (o.bKeys) for (let k = 0; k < o.bKeys.length; k++) v.bricks.set(o.bKeys[k], o.bData.slice(k * S3, (k + 1) * S3));
    return v;
  }
}

/** Volumen aus einer Funktion fn(x, y, z) → Farbe; x und y sind um die Mitte zentriert. */
export function buildStack(w, d, h, fn) {
  const v = new Volume(w, d, h);
  for (let z = 0; z < h; z++) for (let y = 0; y < d; y++) for (let x = 0; x < w; x++) {
    const c = fn(x - (w - 1) / 2, y - (d - 1) / 2, z);
    if (c) v.set(x, y, z, c);
  }
  return v;
}
