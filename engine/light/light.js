// Licht: Tageszeit mit Sonnen- und Mondstand, Flackermuster, Lichtlisten pro Bildschirmkachel. DOM-frei.
// Der Renderer verteilt bis zu MAX_LIGHTS Punktlichter auf Kacheln von TILE × TILE Pixeln; jedes Pixel rechnet nur
// die Lichter seiner Kachel (höchstens PER_TILE). Ein Spot (Taschenlampe) läuft getrennt davon.
import { vnoise, hash3 } from '../core/rand.js';

export const MAX_LIGHTS = 256, TILE = 16, PER_TILE = 48;

const lerp = (a, b, t) => a + (b - a) * t;
const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
// Stützstellen über den Tag (Stunde → Umgebung, Hauptlicht-Farbe)
const KEYS = [
  [0, [0.085, 0.095, 0.13], [0.15, 0.17, 0.26]],     // Mitternacht (Mond)
  [5, [0.09, 0.1, 0.14], [0.16, 0.17, 0.25]],
  [7, [0.32, 0.27, 0.26], [0.85, 0.55, 0.38]],       // Morgenrot
  [10, [0.42, 0.44, 0.48], [1.05, 0.98, 0.9]],
  [15, [0.44, 0.45, 0.48], [1.05, 1.0, 0.92]],
  [19, [0.3, 0.24, 0.26], [0.95, 0.5, 0.32]],        // Abendrot
  [21, [0.1, 0.1, 0.15], [0.18, 0.18, 0.28]],
  [24, [0.085, 0.095, 0.13], [0.15, 0.17, 0.26]],
];
/** Umgebung und Hauptlicht für eine Uhrzeit 0…24. night: 0 Tag … 1 Nacht (für Laternen und Fenster). */
export function skyAt(hour) {
  const h = ((hour % 24) + 24) % 24;
  let i = 0; while (KEYS[i + 1][0] < h) i++;
  const [h0, a0, s0] = KEYS[i], [h1, a1, s1] = KEYS[i + 1], t = (h - h0) / (h1 - h0);
  const ambient = mix3(a0, a1, t), sun = mix3(s0, s1, t);
  const night = 1 - Math.min(1, Math.max(0, (ambient[0] - 0.1) / 0.25));
  return { ambient, sun, night, dir: lightDir(h) };
}
/**
 * Richtung zum Hauptlicht (Einheitsvektor, z nach oben): Sonne geht im Osten (+x) auf, steht mittags im Süden (+y),
 * geht im Westen unter; höchstens 62° hoch. Nachts der Mond, fest aus Südwesten 45° hoch.
 */
export function lightDir(hour) {
  const h = ((hour % 24) + 24) % 24, a = (h - 6) / 12 * Math.PI;      // 0 bei 6 Uhr, π bei 18 Uhr
  const el = Math.sin(a) * 62 * Math.PI / 180;
  if (el < 8 * Math.PI / 180) { const e = Math.PI / 4, l = Math.SQRT1_2; return [-Math.cos(e) * l, Math.cos(e) * l, Math.sin(e)]; }
  const ax = Math.cos(a), ay = Math.sin(a), c = Math.cos(el);
  return [ax * c, ay * c, Math.sin(el)];
}

/** Helligkeitsfaktor für ein Licht nach Typ (lamp, fire, flicker, neon). */
export function flicker(L, t) {
  if (L.type === 'fire') return 0.7 + 0.55 * vnoise(t * 8 + L.seed, 0, 3);
  if (L.type === 'flicker') return vnoise(t * 2.5 + L.seed, 1, 4) > 0.28 ? 1 : 0.12;
  if (L.type === 'neon') return hash3(Math.floor(t * 14 + L.seed), 3, 5) > 0.05 ? 1 : 0.25;
  return 1;
}

/** Die n Lichter, deren Reichweite dem Punkt am nächsten kommt (nur innerhalb von maxDist). */
export function nearestLights(lights, x, y, n, maxDist = 70, filter = null) {
  const out = [];
  for (const L of lights) {
    if (filter && !filter(L)) continue;
    const d = Math.hypot(L.x - x, L.y - y) - L.r;
    if (d < maxDist) out.push([d, L]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out.slice(0, n).map(a => a[1]);
}

/**
 * Lichter auf Bildschirmkacheln verteilen. Jedes Licht wirkt im Quader [x±r, y±r, z−r … z+r] (geschnitten mit 0 … zTop);
 * dessen 8 Ecken auf den Bildschirm projiziert ergeben das Rechteck der betroffenen Kacheln (konservativ).
 * @returns {{ cols, rows, header: Float32Array (Kachel → [Anfang, Anzahl, 0, 0]), list: Float32Array (Lichtindizes), dropped }}
 */
export function binLights(lights, cam, W, H, zTop, tile = TILE, perTile = PER_TILE) {
  const cols = Math.ceil(W / tile), rows = Math.ceil(H / tile), nt = cols * rows;
  const counts = new Uint16Array(nt), rects = [];
  let dropped = 0;
  // Stärkste Lichter zuerst: läuft eine Kachel voll, fallen die schwächsten weg (weniger sichtbare Kachelkanten)
  const order = lights.map((L, i) => [i, (L.color ? L.color[0] + L.color[1] + L.color[2] : 1) * L.r]).sort((a, b) => b[1] - a[1]).map(a => a[0]);
  order.forEach(i => { const L = lights[i];
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    const za = Math.max(0, L.z - L.r), zb = Math.min(zTop, L.z + L.r);
    for (const dx of [-L.r, L.r]) for (const dy of [-L.r, L.r]) for (const z of [za, zb]) {
      const [sx, sy] = cam.project(L.x + dx, L.y + dy, z);
      x0 = Math.min(x0, sx); y0 = Math.min(y0, sy); x1 = Math.max(x1, sx); y1 = Math.max(y1, sy);
    }
    // Bildschirm-y wächst nach unten; die Kacheln zählen wie gl_FragCoord von unten
    const c0 = Math.max(0, Math.floor(x0 / tile)), c1 = Math.min(cols - 1, Math.floor(x1 / tile));
    const r0 = Math.max(0, Math.floor((H - y1) / tile)), r1 = Math.min(rows - 1, Math.floor((H - y0) / tile));
    if (c0 > c1 || r0 > r1) return;
    rects.push([i, c0, c1, r0, r1]);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) { const k = r * cols + c; if (counts[k] < perTile) counts[k]++; else dropped++; }
  });
  const header = new Float32Array(nt * 4);
  let off = 0;
  for (let k = 0; k < nt; k++) { header[k * 4] = off; off += counts[k]; }
  const list = new Float32Array(Math.max(1, off)), fill = new Uint16Array(nt);
  for (const [i, c0, c1, r0, r1] of rects) for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    const k = r * cols + c;
    if (fill[k] < counts[k]) { list[header[k * 4] + fill[k]] = i; fill[k]++; }
  }
  for (let k = 0; k < nt; k++) header[k * 4 + 1] = fill[k];
  return { cols, rows, header, list, dropped };
}
