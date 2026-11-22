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

/** Dichtes Volumen w × d × h (x schnell, dann y, dann z). */
export class Volume {
  constructor(w, d, h) {
    this.w = w; this.d = d; this.h = h;
    this.col = new Uint32Array(w * d * h);
    this.lay = new Uint8Array(w * d * h);
  }
  idx(x, y, z) { return (z * this.d + y) * this.w + x; }
  ok(x, y, z) { return x >= 0 && y >= 0 && z >= 0 && x < this.w && y < this.d && z < this.h; }
  set(x, y, z, c, l = 0) { if (this.ok(x, y, z)) { const i = this.idx(x, y, z); this.col[i] = c; this.lay[i] = c ? l : 0; } }
  get(x, y, z) { return this.ok(x, y, z) ? this.col[this.idx(x, y, z)] : 0; }
  getLay(x, y, z) { return this.ok(x, y, z) ? this.lay[this.idx(x, y, z)] : 0; }
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
