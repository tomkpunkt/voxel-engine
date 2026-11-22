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
 * Blöcke mit Flag SUB (unterteilt) werden grob nicht gezeichnet, zählen aber als Nachbarn; ihre feinen
 * Blöcke backt bakeBricks.
 */
export function bakeBox(get, lay, x0, y0, w, d, h, shadow, A, B, sun = DEFAULT_SUN) {
  const solid = (x, y, z) => z < 0 ? shadow : get(x, y, z) !== 0;
  const march = shadow ? marcher(get, h, sun) : null;
  for (let z = 0; z < h; z++) for (let ly = 0; ly < d; ly++) for (let lx = 0; lx < w; lx++) {
    const x = x0 + lx, y = y0 + ly, c = get(x, y, z), q = ((z * d + ly) * w + lx) * 4;
    if (!c) { A[q + 3] = 0; continue; }
    const l = lay(x, y, z);
    if (l & FLAG.SUB) { A[q + 3] = 0; continue; }
    bakeOne(solid, march, x, y, z, c, l, sun, A, B, q, 1);
  }
}
/** Wie bakeBox ohne Bodenschatten, aber nur im Bereich [x0,x1)×[y0,y1)×[0,z1) eines w×d-Rasters (Rest bleibt unverändert). */
export function bakeRegion(get, lay, w, d, x0, x1, y0, y1, z1, A, B, sun = DEFAULT_SUN) {
  const solid = (x, y, z) => z >= 0 && get(x, y, z) !== 0;
  for (let z = 0; z < z1; z++) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const c = get(x, y, z), q = ((z * d + y) * w + x) * 4;
    if (!c) { A[q + 3] = 0; continue; }
    bakeOne(solid, null, x, y, z, c, lay(x, y, z), sun, A, B, q, 1);
  }
}
/** Schattenstrahl zum Hauptlicht über das grobe Gitter (scale: Feinheit der Startkoordinaten). */
function marcher(get, h, sun) {
  return (px, py, pz) => {
    for (let t = 1.2; t < 50; t += 0.8) {
      const qz = Math.floor(pz + sun[2] * t); if (qz >= h) return 1;
      if (qz >= 0 && get(Math.floor(px + sun[0] * t), Math.floor(py + sun[1] * t), qz)) return 0;
    }
    return 1;
  };
}
function bakeOne(solid, march, x, y, z, c, l, sun, A, B, q, scale) {
  let nx = 0, ny = 0, nz = 0, empty = 0;
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let e = -1; e <= 1; e++) {
    if (!a && !b && !e) continue;
    if (!solid(x + e, y + b, z + a)) { nx += e; ny += b; nz += a; empty++; }
  }
  const L = Math.hypot(nx, ny, nz);
  if (L < 1e-6) { nx = 0; ny = 0; nz = 1; } else { nx /= L; ny /= L; nz /= L; }
  let sh = 1;
  if (march && empty && !(c & EMIT) && nx * sun[0] + ny * sun[1] + nz * sun[2] > 0)
    sh = march((x + 0.5 + nx * 0.6) / scale, (y + 0.5 + ny * 0.6) / scale, (z + 0.5 + nz * 0.6) / scale);
  const ao = Math.round((0.4 + 0.6 * Math.min(1, empty / 10)) * 127), [ex, ey] = octEnc(nx, ny, nz);
  A[q] = (c >> 16) & 255; A[q + 1] = (c >> 8) & 255; A[q + 2] = c & 255; A[q + 3] = 255;
  B[q] = ex; B[q + 1] = ey; B[q + 2] = ao | (sh << 7);
  B[q + 3] = (l & FLAG.ROOF ? 1 : 0) | (l & FLAG.WALLTOP ? 2 : 0) | (c & EMIT ? 4 : 0);
}

/**
 * Feine Blöcke (Bricks) backen. getFine(fx,fy,fz) / layFine in feinen Koordinaten (Block · S + Teil),
 * getCoarse für den Schatten über das grobe Gitter. keys = Blockindizes einer Kachel (ox, oy Ursprung in Blöcken).
 * Ergebnis: A, B mit je S³·4 Byte pro Brick, hintereinander; innerhalb eines Bricks x schnell, dann y, dann z.
 */
export function bakeBricks(getFine, layFine, getCoarse, keys, TS, ox, oy, h, S, sun = DEFAULT_SUN) {
  const S3 = S * S * S, A = new Uint8Array(keys.length * S3 * 4), B = new Uint8Array(keys.length * S3 * 4);
  const solid = (fx, fy, fz) => fz < 0 ? true : getFine(fx, fy, fz) !== 0;
  const march = marcher(getCoarse, h, sun);
  keys.forEach((i, k) => {
    const bx = ox + i % TS, by = oy + ((i / TS) | 0) % TS, bz = (i / (TS * TS)) | 0;
    for (let sz = 0; sz < S; sz++) for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const fx = bx * S + sx, fy = by * S + sy, fz = bz * S + sz, c = getFine(fx, fy, fz), q = (k * S3 + (sz * S + sy) * S + sx) * 4;
      if (!c) { A[q + 3] = 0; continue; }
      bakeOne(solid, march, fx, fy, fz, c, layFine(fx, fy, fz), sun, A, B, q, S);
    }
  });
  return { A, B };
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

/** Kantenlänge der Zeichen-Teilstücke (Gitter-Culling) in Blöcken. */
export const CHUNK = 16;
/**
 * Belegte Rechtecke je Teilstück (CHUNK × CHUNK) und Höhe einer Kachel, für Gitter-Culling.
 * Layout: pro Teilstück c = cy·n + cx ein Block aus 1 + 4·h Werten: [oberste Höhe + 1, dann je z: x0, y0, x1, y1 (−1 = leer)]
 * in Kachelkoordinaten. n = ceil(w / CHUNK).
 */
export function chunkBounds(data, w, d, h, CH = CHUNK) {
  const n = Math.ceil(w / CH), m = Math.ceil(d / CH), S = 1 + 4 * h, out = new Int16Array(n * m * S).fill(-1);
  for (let c = 0; c < n * m; c++) out[c * S] = 0;
  for (let z = 0; z < h; z++) for (let y = 0; y < d; y++) {
    const cy = (y / CH) | 0, row = (z * d + y) * w;
    for (let x = 0; x < w; x++) {
      if (!data[row + x]) continue;
      const c = cy * n + ((x / CH) | 0), b = c * S, k = b + 1 + z * 4;
      if (out[b] < z + 1) out[b] = z + 1;
      if (out[k] < 0) { out[k] = x; out[k + 1] = y; out[k + 2] = x; out[k + 3] = y; }
      else { if (x < out[k]) out[k] = x; if (y < out[k + 1]) out[k + 1] = y; if (x > out[k + 2]) out[k + 2] = x; if (y > out[k + 3]) out[k + 3] = y; }
    }
  }
  return out;
}
