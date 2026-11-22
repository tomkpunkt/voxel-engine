// Wave Function Collapse (Simple Tiled Model) mit Kanten-Sockeln.
// Jede Kachel hat pro Richtung (N, O, S, W) einen Sockeltyp; compat[a][b] sagt, ob a an b grenzen darf.
// Nach Maxim Gumin (WaveFunctionCollapse), nur sinngemäß umgesetzt.

export const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];   // N, O, S, W

/**
 * @param {number} n  Kantenlänge des Rasters
 * @param {() => number} rng
 * @param {object} o
 * @param {number[]} o.weights           Gewicht je Kachel
 * @param {number[][]} o.sockets         sockets[t][d] = Sockeltyp der Kachel t in Richtung d
 * @param {number[][]} o.compat          compat[a][b] = 1, wenn Sockel a an Sockel b passt
 * @param {(socket:number) => boolean} [o.border]  darf dieser Sockel am Rand liegen?
 * @param {{cell:number, tile:number}} [o.seed]   vorab festgelegte Zelle
 * @returns {{grid:number[], order:number[]} | null}  null bei Widerspruch
 */
export function wfc(n, rng, o) {
  const { weights, sockets, compat } = o, T = weights.length, S = compat.length;
  const poss = [], order = [], cnt = new Int32Array(n * n).fill(T);   // cnt: verbliebene Möglichkeiten je Zelle
  for (let i = 0; i < n * n; i++) poss.push(new Uint8Array(T).fill(1));
  const count = i => cnt[i];
  if (o.border) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) for (let d = 0; d < 4; d++) {
    const nx = x + DIRS[d][0], ny = y + DIRS[d][1];
    if (nx < 0 || ny < 0 || nx >= n || ny >= n) for (let t = 0; t < T; t++) if (poss[y * n + x][t] && !o.border(sockets[t][d])) { poss[y * n + x][t] = 0; cnt[y * n + x]--; }
  }
  const stack = [], have = new Uint8Array(S);
  const propagate = () => {
    while (stack.length) {
      const i = stack.pop(), x = i % n, y = (i / n) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = x + DIRS[d][0], ny = y + DIRS[d][1];
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        const j = ny * n + nx, od = (d + 2) % 4;
        have.fill(0);
        for (let t = 0; t < T; t++) if (poss[i][t]) have[sockets[t][d]] = 1;
        let changed = false;
        for (let t = 0; t < T; t++) if (poss[j][t]) {
          const s = sockets[t][od];
          let ok = false;
          for (let a = 0; a < S && !ok; a++) if (have[a] && compat[a][s]) ok = true;
          if (!ok) { poss[j][t] = 0; cnt[j]--; changed = true; }
        }
        if (changed) { if (!count(j)) return false; stack.push(j); }
      }
    }
    return true;
  };
  const collapse = (i, forced) => {
    let t = forced;
    if (t === undefined) {
      let sum = 0; for (let k = 0; k < T; k++) if (poss[i][k]) sum += weights[k];
      let r = rng() * sum;
      for (let k = 0; k < T; k++) if (poss[i][k]) { t = k; r -= weights[k]; if (r <= 0) break; }
    }
    poss[i].fill(0); poss[i][t] = 1; cnt[i] = 1; order.push(i); stack.push(i);
    return propagate();
  };
  if (o.seed && !collapse(o.seed.cell, o.seed.tile)) return null;
  for (;;) {
    let best = -1, bv = 1e9;
    for (let i = 0; i < n * n; i++) { const k = cnt[i]; if (k > 1 && k < bv) { const e = k + rng() * 0.9; if (e < bv) { bv = e; best = i; } } }
    if (best < 0) break;
    if (!collapse(best)) return null;
  }
  const grid = poss.map(p => p.indexOf(1));
  const seen = new Set(order);
  for (let i = 0; i < n * n; i++) if (!seen.has(i)) order.push(i);
  return { grid, order };
}
