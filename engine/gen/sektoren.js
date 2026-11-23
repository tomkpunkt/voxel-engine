// Sektor-Ablauf für Weltpläne: Kartennetze → Ecken → Kanten → Flächen.
//
// Die Karte (N × N Zellen) ist in K × K Sektoren à S Zellen geteilt. Jede Sektorgrenze hat einen zwei Zellen breiten
// Grenzstreifen (je eine Zelle pro Seite), wo sich Grenzen kreuzen, liegt ein Eckblock (siehe sectorPieces). Erzeugt wird in Stufen:
//   0  feste Vorgaben des Planers (Straßen, Wege, reservierte Flächen)    – fixedAt
//   1  Ecken      – sehen nur Stufe 0
//   2  Kanten     – sehen Stufe 0 + alle Ecken
//   3  Flächen    – sehen Stufe 0 + Ecken + Kanten
// Ein Stück sieht nie andere Stücke seiner eigenen Stufe. Darum ist das Ergebnis unabhängig von der Reihenfolge,
// und jedes Stück lässt sich allein (etwa im Worker) erzeugen. Ecken und Kanten schauen eine Zelle weit in die
// Nachbarflächen (Halo), damit die Flächen später lösbar bleiben; übernommen wird nur das eigene Stück.
// Scheitert ein Stück, startet es mit einer abgeleiteten Teilsaat neu; was vorher festgelegt wurde, bleibt fest.
// Als letzter Ausweg dürfen Füllkacheln einspringen – nur dort, wo sie zu allen vorgegebenen Sockeln passen.
import { wfcRegion, DIRS } from './wfc.js';
import { mulberry32 } from '../core/rand.js';

/** Teilsaat aus Saat, Stufe, Stück und Versuch (deterministisch, unabhängig von der Reihenfolge). */
export function subSeed(seed, ...k) {
  let h = (seed >>> 0) ^ 0x9e3779b9;
  for (const v of k) { h = Math.imul(h ^ (v >>> 0), 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; }
  return h >>> 0;
}

/**
 * Stücke eines N × N-Rasters mit Sektorgröße S. Ecken sind 4 × 4 groß: der 2 × 2-Kreuzungsblock plus die Zellen,
 * die an zwei Grenzstreifen zugleich grenzen. Sonst könnten ein senkrechter und ein waagrechter Streifen, die sich
 * nicht sehen, eine gemeinsame Nachbarzelle unlösbar machen. Flächen sind Rechtecke ohne diese Eckzellen.
 */
export function sectorPieces(N, S) {
  const K = N / S, corners = [], edges = [], faces = [];
  const near = v => { const r = v % S; return r === S - 2 || r === S - 1 || r === 0 || r === 1; };     // ±2 um eine innere Grenze
  const inner = v => v >= S - 2 && v <= N - S + 1;
  const cornerCell = (x, y) => near(x) && near(y) && inner(x) && inner(y);
  const espan = r => [r === 0 ? 0 : r * S + 2, r === K - 1 ? N : (r + 1) * S - 2];
  const fspan = r => [r === 0 ? 0 : r * S + 1, r === K - 1 ? N : (r + 1) * S - 1];
  for (let vy = 1; vy < K; vy++) for (let vx = 1; vx < K; vx++)
    corners.push({ kind: 'ecke', vx, vy, x0: vx * S - 2, x1: vx * S + 2, y0: vy * S - 2, y1: vy * S + 2 });
  for (let r = 0; r < K; r++) for (let v = 1; v < K; v++) {
    const [a, b] = espan(r);
    edges.push({ kind: 'kante', dir: 'senkrecht', v, r, x0: v * S - 1, x1: v * S + 1, y0: a, y1: b, sectors: [[v - 1, r], [v, r]] });
    edges.push({ kind: 'kante', dir: 'waagrecht', v, r, x0: a, x1: b, y0: v * S - 1, y1: v * S + 1, sectors: [[r, v - 1], [r, v]] });
  }
  for (let sy = 0; sy < K; sy++) for (let sx = 0; sx < K; sx++) {
    const [x0, x1] = fspan(sx), [y0, y1] = fspan(sy);
    faces.push({ kind: 'flaeche', sx, sy, x0, x1, y0, y1, has: (x, y) => !cornerCell(x, y) });
  }
  return { K, stages: [corners, edges, faces], cornerCell };
}

/**
 * @param {object} o
 * @param {number} o.N  @param {number} o.S  @param {number} o.seed
 * @param {{weights:number[], sockets:number[][], compat:number[][], border:(s:number)=>boolean}} o.tiles
 * @param {(x:number, y:number) => number[]} o.allowedAt   Kacheln der Zelle (aus ihrem Sektortyp)
 * @param {(x:number, y:number) => ArrayLike<number>} [o.weightsAt] Gewichte der Zelle (aus ihrem Sektortyp)
 * @param {(x:number, y:number) => number} o.fixedAt       Vorgabe des Planers oder -1
 * @param {(x:number, y:number, d:number) => number} [o.mapEdge]  Sockel jenseits des Kartenrands (z. B. Straße
 *        verlässt die Karte) oder -2 (Kartenrand, o.tiles.border gilt)
 * @param {(piece, get:(x,y)=>number) => number} [o.accept]  Bewertung eines fertigen Stücks, 0 = gut (sonst Neustart,
 *        am Ende gewinnt der beste Versuch)
 * @param {number[]} [o.filler]  Füllkacheln für den letzten Ausweg
 * @param {number} [o.tries]     Versuche je Stück (Standard 8)
 * @param {boolean} [o.reverse]  Stücke jeder Stufe in umgekehrter Reihenfolge erzeugen (für den Test)
 * @returns {{grid:Int32Array, order:number[], pieces:object[], issues:object[]}}
 */
export function planSectors(o) {
  const { N, S, seed, tiles } = o, tries = o.tries ?? 8, HALO = 1;
  const { stages } = sectorPieces(N, S);
  const grid = new Int32Array(N * N).fill(-1), order = [], issues = [];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const f = o.fixedAt(x, y); if (f >= 0) { grid[y * N + x] = f; order.push(y * N + x); } }
  const opp = d => (d + 2) % 4;
  stages.forEach((list, stage) => {
    const view = grid.slice();                       // eingefroren: nur frühere Stufen
    const todo = o.reverse ? [...list].reverse() : list;
    for (const p of todo) {
      const pi = list.indexOf(p);
      const X0 = Math.max(0, p.x0 - HALO), Y0 = Math.max(0, p.y0 - HALO), X1 = Math.min(N, p.x1 + HALO), Y1 = Math.min(N, p.y1 + HALO);
      const w = X1 - X0, h = Y1 - Y0;
      const inP = (x, y) => x >= p.x0 && x < p.x1 && y >= p.y0 && y < p.y1 && (!p.has || p.has(x, y));
      const run = (rng, fill) => wfcRegion(w, h, rng, {
        weights: tiles.weights, sockets: tiles.sockets, compat: tiles.compat, border: tiles.border,
        fixed: (lx, ly) => view[(Y0 + ly) * N + X0 + lx],
        weightsAt: o.weightsAt ? (lx, ly) => {
          const x = X0 + lx, y = Y0 + ly, wt = o.weightsAt(x, y);
          if (!(fill && inP(x, y))) return wt;
          const c = Float64Array.from(wt); for (const t of o.filler) if (!(c[t] > 0)) c[t] = 0.05; return c;
        } : null,
        allowed: (lx, ly) => {
          const x = X0 + lx, y = Y0 + ly, a = o.allowedAt(x, y);
          return fill && inP(x, y) ? [...new Set([...a, ...o.filler])] : a;
        },
        outside: (lx, ly, d) => {
          const x = X0 + lx + DIRS[d][0], y = Y0 + ly + DIRS[d][1];
          if (x < 0 || y < 0 || x >= N || y >= N) return o.mapEdge ? o.mapEdge(X0 + lx, Y0 + ly, d) : -2;
          const t = view[y * N + x];
          return t >= 0 ? tiles.sockets[t][opp(d)] : -1;
        },
      });
      let best = null, bestScore = Infinity, used = 0, fillUsed = false, lastErr = null;
      const attempt = (a, fill) => {
        used++;
        const res = run(mulberry32(subSeed(seed, stage, pi, a)), fill);
        if (res.error) { lastErr = { ...res, x: X0 + res.x, y: Y0 + res.y, fill }; if (res.error === 'rand') issues.push({ stage, piece: pi, kind: p.kind, x: X0 + res.x, y: Y0 + res.y, need: res.need, fill }); return res.error; }
        const get = (x, y) => (x >= X0 && x < X1 && y >= Y0 && y < Y1) ? res.grid[(y - Y0) * w + x - X0] : grid[y * N + x];
        const sc = o.accept ? o.accept(p, get) : 0;
        if (sc < bestScore) { bestScore = sc; best = res; fillUsed = fill; }
        return sc;
      };
      for (let a = 0; a < tries; a++) { const r = attempt(a, false); if (r === 'rand' || r === 0) break; }
      if (!best) for (let a = 0; a < tries; a++) { const r = attempt(1000 + a, true); if (r === 'rand' || r === 0) break; }
      if (!best) {
        const e = lastErr;
        throw Object.assign(new Error(`Weltplan: ${p.kind} ${pi} (Stufe ${stage}) nicht lösbar` + (e ? ` – ${e.error}${e.start ? ' (schon die Vorgaben)' : ''} bei Zelle ${e.x},${e.y}` + (e.need ? `, verlangt Sockel ${JSON.stringify(e.need)}` : '') : '')), { piece: p, detail: e, grid });
      }
      const wo = [];
      for (const li of best.order) { const x = X0 + li % w, y = Y0 + ((li / w) | 0); if (inP(x, y) && view[y * N + x] < 0) wo.push(y * N + x); }
      for (let y = p.y0; y < p.y1; y++) for (let x = p.x0; x < p.x1; x++) {
        const i = y * N + x;
        if (view[i] >= 0 || !inP(x, y)) continue;
        grid[i] = best.grid[(y - Y0) * w + x - X0];
        if (!wo.includes(i)) wo.push(i);
      }
      p.tries = used; p.score = bestScore; p.filler = fillUsed; p.stage = stage; p.cells = wo.length;
      order.push(...wo);
    }
  });
  return { grid, order, pieces: stages.flat(), issues };
}
