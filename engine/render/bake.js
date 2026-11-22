// Backen: Voxel → zwei RGBA8-Texturebenen pro Höhe (DOM-frei, in Node testbar).
//   A = Albedo rgb, a = belegt (255) oder leer (0)
//   B = Normale oktaedrisch (r, g), b = Verdeckung (7 Bit) + Schatten des Hauptlichts (Bit 7),
//       a = Flags: 1 Dach, 2 obere Wandhälfte (beide werden gekappt), 4 leuchtet
import { EMIT, FLAG } from '../core/voxel.js';

export const DEFAULT_SUN = (() => { const v = [-0.4, 0.55, 0.73], l = Math.hypot(...v); return v.map(a => a / l); })();

export function octEnc(nx, ny, nz) {
  const s = Math.abs(nx) + Math.abs(ny) + Math.abs(nz) || 1; let x = nx / s, y = ny / s;
  if (nz < 0) { const ax = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1), ay = (1 - Math.abs(x)) * (y >= 0 ? 1 : -1); x = ax; y = ay; }
  return [Math.round((x * 0.5 + 0.5) * 255), Math.round((y * 0.5 + 0.5) * 255)];
}
export function octDec(ex, ey) {
  let x = ex / 255 * 2 - 1, y = ey / 255 * 2 - 1; const z = 1 - Math.abs(x) - Math.abs(y);
  const t = Math.max(-z, 0); x += x >= 0 ? -t : t; y += y >= 0 ? -t : t;
  const l = Math.hypot(x, y, z); return [x / l, y / l, z / l];
}

/**
 * Backt den Quader [x0, x0+w) × [y0, y0+d) × [0, h) über Zugriffsfunktionen.
 * get(x,y,z) → Farbe, lay(x,y,z) → Flags. Nachbarn außerhalb des Quaders werden mit get abgefragt,
 * darum stimmen Normalen und Verdeckung an Kachelgrenzen, solange die Nachbarn geladen sind.
 * shadow: Boden unter z = 0 gilt als belegt, und der Schatten des Hauptlichts wird gerechnet (für die Welt).
 */
export function bakeBox(get, lay, x0, y0, w, d, h, shadow, A, B, sun = DEFAULT_SUN) {
  const solid = (x, y, z) => z < 0 ? shadow : get(x, y, z) !== 0;
  const march = (px, py, pz) => {
    for (let t = 1.2; t < 50; t += 0.8) {
      const qz = Math.floor(pz + sun[2] * t); if (qz >= h) return 1;
      if (qz >= 0 && get(Math.floor(px + sun[0] * t), Math.floor(py + sun[1] * t), qz)) return 0;
    }
    return 1;
  };
  for (let z = 0; z < h; z++) for (let ly = 0; ly < d; ly++) for (let lx = 0; lx < w; lx++) {
    const x = x0 + lx, y = y0 + ly, c = get(x, y, z), q = ((z * d + ly) * w + lx) * 4;
    if (!c) { A[q + 3] = 0; continue; }
    let nx = 0, ny = 0, nz = 0, empty = 0;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let e = -1; e <= 1; e++) {
      if (!a && !b && !e) continue;
      if (!solid(x + e, y + b, z + a)) { nx += e; ny += b; nz += a; empty++; }
    }
    const L = Math.hypot(nx, ny, nz);
    if (L < 1e-6) { nx = 0; ny = 0; nz = 1; } else { nx /= L; ny /= L; nz /= L; }
    let sh = 1;
    if (shadow && empty && !(c & EMIT) && nx * sun[0] + ny * sun[1] + nz * sun[2] > 0) sh = march(x + 0.5 + nx * 0.6, y + 0.5 + ny * 0.6, z + 0.5 + nz * 0.6);
    const ao = Math.round((0.4 + 0.6 * Math.min(1, empty / 10)) * 127), l = lay(x, y, z), [ex, ey] = octEnc(nx, ny, nz);
    A[q] = (c >> 16) & 255; A[q + 1] = (c >> 8) & 255; A[q + 2] = c & 255; A[q + 3] = 255;
    B[q] = ex; B[q + 1] = ey; B[q + 2] = ao | (sh << 7);
    B[q + 3] = (l & FLAG.ROOF ? 1 : 0) | (l & FLAG.WALLTOP ? 2 : 0) | (c & EMIT ? 4 : 0);
  }
}

/** Belegtes Rechteck je Höhe (lokale Koordinaten), -1 = leer. Spart beim Zeichnen leere Fläche. */
export function sliceBounds(col, w, d, h) {
  const bb = new Int16Array(h * 4).fill(-1);
  for (let z = 0; z < h; z++) for (let y = 0; y < d; y++) for (let x = 0; x < w; x++) {
    if (!col[(z * d + y) * w + x]) continue;
    const k = z * 4;
    if (bb[k] < 0) { bb[k] = x; bb[k + 1] = y; bb[k + 2] = x; bb[k + 3] = y; }
    else { if (x < bb[k]) bb[k] = x; if (y < bb[k + 1]) bb[k + 1] = y; if (x > bb[k + 2]) bb[k + 2] = x; if (y > bb[k + 3]) bb[k + 3] = y; }
  }
  return bb;
}
