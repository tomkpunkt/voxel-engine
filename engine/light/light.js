// Licht: Tageszeit, Auswahl der Lichter pro Bild und Flackermuster. DOM-frei.
// Der Renderer rechnet pro Pixel bis zu MAX_LIGHTS Punktlichter, Lichtquelle 0 darf ein Spot sein.
// (Etappe 4: Lichtlisten pro Bildschirmkachel statt fester Höchstzahl.)
import { vnoise, hash3 } from '../core/rand.js';

export const MAX_LIGHTS = 8;

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
  return { ambient, sun, night };
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
