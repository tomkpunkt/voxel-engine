// Deterministische Zufallsquellen. Alles hier ist DOM-frei und in Node testbar.

/** Ganzzahl-Hash von (x, y, z) → [0, 1). Gleiche Eingabe, gleiches Ergebnis auf jeder Plattform. */
export function hash3(x, y, z) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Wertrauschen mit glatter Interpolation, Saat s. */
export function vnoise(x, y, s) {
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy; fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = hash3(ix, iy, s), b = hash3(ix + 1, iy, s), c = hash3(ix, iy + 1, s), d = hash3(ix + 1, iy + 1, s);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** Kleiner, schneller PRNG mit 32-Bit-Zustand. */
export function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/** Saat für eine Kachel: hängt nur von Welt-Saat, Lage und Generatorversion ab. */
export const tileSeed = (seed, tx, ty, version = 1) =>
  (seed ^ Math.imul(tx + 1, 73856093) ^ Math.imul(ty + 1, 19349663) ^ Math.imul(version, 83492791)) | 0;

export const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
export const ri = (rng, a, b) => a + Math.floor(rng() * (b - a + 1));
