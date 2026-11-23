// Fingerabdruck des Stadtgenerators v4 (Plan + Voxel einiger Kacheln). Alte Spielstände bauen die Welt
// aus Saat und Generatorversion neu – dieser Wert darf sich für v4 nie ändern.
import { cityPlan, createGenerator } from '../games/totenstadt/city.js';
import { makeWorld } from './hilfe.mjs';
const h32 = (h, v) => Math.imul(h ^ v, 16777619) >>> 0;
export function fingerprintV4(seed) {
  const plan = cityPlan(seed);
  let h = 2166136261;
  for (const t of plan.grid) h = h32(h, t);
  const w = makeWorld(createGenerator({ seed, plan }), seed);
  for (const [tx, ty] of [[32, 32], [31, 32], [10, 20], [50, 7], [33, 40]]) {
    w.ensure(tx, ty);
    const t = w.tileAt(tx * w.TS, ty * w.TS), v = t.vol;
    for (let i = 0; i < v.data.length; i += 7) { const k = v.data[i]; h = h32(h, v.palC[k]); h = h32(h, v.palL[k] | 0); }
  }
  return h;
}
if (process.argv[1] && process.argv[1].endsWith('fingerabdruck-v4.mjs')) console.log(JSON.stringify([1, 4711, 99].map(fingerprintV4)));
