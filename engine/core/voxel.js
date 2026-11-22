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
  constructor(w, d, h) {
    this.w = w; this.d = d; this.h = h;
    this.data = new Uint16Array(w * d * h);
    this.palC = new Uint32Array(256); this.palL = new Uint8Array(256); this.n = 1;
    this.map = null;
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
  set(x, y, z, c, l = 0) { if (this.ok(x, y, z)) this.data[this.idx(x, y, z)] = this.index(c, l); }
  setAt(i, c, l = 0) { this.data[i] = this.index(c, l); }
  get(x, y, z) { return this.ok(x, y, z) ? this.palC[this.data[this.idx(x, y, z)]] : 0; }
  getLay(x, y, z) { return this.ok(x, y, z) ? this.palL[this.data[this.idx(x, y, z)]] : 0; }
  colAt(i) { return this.palC[this.data[i]]; }
  layAt(i) { return this.palL[this.data[i]]; }
  /** Speicherbedarf in Byte. */
  bytes() { return this.data.byteLength + this.n * 5; }
  /** Als übertragbares Objekt (für postMessage); copy = false gibt die eigenen Puffer ab. */
  pack(copy = true) {
    const o = { w: this.w, d: this.d, h: this.h, n: this.n, data: copy ? this.data.slice() : this.data, palC: this.palC.slice(0, this.n), palL: this.palL.slice(0, this.n) };
    return o;
  }
  static transfer(o) { return [o.data.buffer, o.palC.buffer, o.palL.buffer]; }
  static unpack(o) {
    const v = Object.create(Volume.prototype);
    Object.assign(v, { w: o.w, d: o.d, h: o.h, data: o.data, palC: o.palC, palL: o.palL, n: o.n, map: null });
    if (v.palC.length < v.n + 1) { /* wächst bei Bedarf in index() */ }
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
