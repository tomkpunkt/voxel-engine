// Weltplaner für Totenstadt: Setting und Biom bestimmen die Sektoren, die Sektoren legen ihre Übergänge gemeinsam
// fest, WFC füllt die Flächen in diesem Rahmen (engine/gen/sektoren.js).
//
// Ablauf:
//   1. Sektortypen aus dem Setting (Platzierungsregeln: Wohngebiet um den Ortskern, Wald am fernen Rand, Acker dazwischen)
//   2. Kartennetze: Landstraße von Kartenrand zu Kartenrand durch den Ort, Hof mit Wirtschaftsweg zur Landstraße
//   3. Reservierte Flächen: ein großes Feld und der Wald aus einem Landschaftsfeld (Rauschen) – beide über Sektorgrenzen
//   4. Ecken → Kanten → Flächen mit WFC; Kacheln, Gewichte und Übergänge je Sektortyp
// Das Ergebnis ist das gewohnte Kachelraster ({ grid }), dazu Netze, Reservierungen und Sektortypen für Tests und Karte.
import { TILES, OLD_TILES } from './city.js';
import { planSectors, subSeed } from '../../engine/gen/sektoren.js';
import { DIRS } from '../../engine/gen/wfc.js';
import { mulberry32, vnoise } from '../../engine/core/rand.js';
import { GN } from './scale.js';
import { BIOME } from './biome.js';

export const WELT_VERSION = 5;   // Generatorversion für Welten aus dem Weltplaner (Stadt: 4)
export const SEKTOR = 16;        // Sektorgröße in Grundstücken

// ---------------------------------------------------------------- Setting und Biom
/** Setting: Bebauungsdichte, Straßennetz, Landnutzung. Ausgearbeitet ist zunächst „suburban“. */
export const SETTINGS = {
  grossstadt: { name: 'Großstadt', sektoren: ['hochhaus', 'wohnblock', 'gewerbe', 'stadtpark', 'ufer'], fertig: false },
  urban: { name: 'Urban', sektoren: ['blockrand', 'mischnutzung', 'markt', 'werkstatt', 'gruenzug'], fertig: false },
  suburban: { name: 'Suburban', fertig: true,
    // Anteile der Sektortypen (von 16): Wohngebiet um den Ortskern, Wald am fernen Rand, Acker dazwischen
    anteile: { wohn: 5, wald: 4 } },
  laendlich: { name: 'Ländlich', sektoren: ['feld', 'weide', 'hof', 'dorfkern', 'wald', 'bachaue'], fertig: false },
};
export { BIOME };

// ---------------------------------------------------------------- Sockel
//  Straße: R (Ast, ≤ 2 Äste), J (Ast an Kreuzung/T), F (Seite).  Wirtschaftsweg: W (Ast), V (Seite).
//  Flächen: B bebaut (Haus, Laden, Parkplatz), G Garten, O offen (Wiese, Park, Brache), A Acker, D Wald, H Hof.
export const SK = { R: 0, J: 1, F: 2, W: 3, V: 4, B: 5, G: 6, O: 7, A: 8, D: 9, H: 10 };
const { R, J, F, W, V, B, G, O, A, D, H } = SK;
const PAIRS = [[R, R], [R, J], [R, W], [J, W], [W, W],
  [F, B], [F, G], [F, O], [F, A], [F, D], [F, H],
  [V, G], [V, O], [V, A], [V, D], [V, H],
  [B, B], [B, G], [B, O], [G, G], [G, O], [G, H], [O, O], [O, A], [O, D], [O, H], [A, A], [A, H], [D, D], [H, H]];
export const COMPAT2 = Array.from({ length: 11 }, () => new Array(11).fill(0));
for (const [a, b] of PAIRS) { COMPAT2[a][b] = 1; COMPAT2[b][a] = 1; }
const LAND = { haus: B, laden: B, parkplatz: B, garten: G, wiese: O, park: O, brache: O, feld: A, wald: D };
export const SOCK2 = TILES.map(t => [0, 1, 2, 3].map(d => {
  if (t.kind === 'road') return (t.mask >> d & 1) ? (t.deg >= 3 ? J : R) : F;
  if (t.kind === 'weg') return (t.mask >> d & 1) ? W : V;
  if (t.kind === 'hof') return (t.mask >> d & 1) ? W : H;
  return LAND[t.kind];
}));
const BORDER_OK = s => s !== R && s !== J && s !== W;   // nichts läuft ohne Plan aus der Karte

const idx = (kind, mask = 0) => TILES.findIndex(t => t.kind === kind && (t.mask || 0) === mask);
const ROAD = m => idx('road', m), WEG = m => idx('weg', m), HOF = m => idx('hof', m);

/** Gewichte je Sektortyp (Index = Kacheltyp). */
function weightsFor(typ) {
  const w = new Float64Array(TILES.length);
  TILES.forEach((t, i) => {
    const straight = t.mask === 5 || t.mask === 10;
    if (typ === 'wohn') {
      // Sammelstraßen: lang und gerade, wenige Kreuzungen, einzelne Stichstraßen
      if (t.kind === 'road') w[i] = t.deg === 1 ? 0.3 : t.deg === 2 ? (straight ? 3 : 0.35) : t.deg === 3 ? 0.45 : 0.1;
      else w[i] = { haus: 18, garten: 7, laden: 0.8, park: 1.2, parkplatz: 0.3, wiese: 0.8, brache: 0.2 }[t.kind] || 0;
      if (t.kind === 'weg') w[i] = t.deg === 2 && straight ? 0.05 : 0;
    } else if (typ === 'acker') {
      // große Schläge; Feldwege selten, kurz und gerade (der Hofweg kommt aus dem Netz)
      w[i] = { feld: 16, wiese: 1.6 }[t.kind] || 0;
      if (t.kind === 'weg') w[i] = t.deg === 1 ? 0.1 : t.deg === 2 ? (straight ? 0.18 : 0.02) : t.deg === 3 ? 0.01 : 0;
    } else if (typ === 'wald') {
      // Wald selbst kommt aus der Landschaftsmaske (fest); dazwischen Lichtungen, wenige Waldwege
      w[i] = { wiese: 3 }[t.kind] || 0;
      if (t.kind === 'weg') w[i] = t.deg === 2 ? (straight ? 0.12 : 0.04) : t.deg === 1 ? 0.05 : 0;
    }
  });
  return w;
}

// ---------------------------------------------------------------- Hilfen
const N = GN, K = N / SEKTOR;
const secOf = (x, y) => [(x / SEKTOR) | 0, (y / SEKTOR) | 0];
const inMap = (x, y) => x >= 0 && y >= 0 && x < N && y < N;
/** Dijkstra auf dem Zellraster. step(from, to) → Kosten oder Infinity; goal(i) → true. Liefert Zellpfad oder null. */
function shortest(starts, step, goal) {
  const dist = new Float64Array(N * N).fill(Infinity), prev = new Int32Array(N * N).fill(-1), heap = [];
  const push = (d, i) => { heap.push([d, i]); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
  for (const s of starts) { dist[s] = 0; push(0, s); }
  while (heap.length) {
    const [d, i] = pop();
    if (d > dist[i]) continue;
    if (goal(i)) { const path = []; for (let k = i; k >= 0; k = prev[k]) path.push(k); return path.reverse(); }
    const x = i % N, y = (i / N) | 0;
    for (let dd = 0; dd < 4; dd++) {
      const nx = x + DIRS[dd][0], ny = y + DIRS[dd][1];
      if (!inMap(nx, ny)) continue;
      const j = ny * N + nx, c = step(i, j, prev[i]);
      if (c === Infinity) continue;
      if (d + c < dist[j]) { dist[j] = d + c; prev[j] = i; push(d + c, j); }
    }
  }
  return null;
}
const dirTo = (i, j) => { const dx = (j % N) - (i % N), dy = ((j / N) | 0) - ((i / N) | 0); return DIRS.findIndex(([a, b]) => a === dx && b === dy); };
const n4 = i => { const x = i % N, y = (i / N) | 0, r = []; for (const [dx, dy] of DIRS) if (inMap(x + dx, y + dy)) r.push((y + dy) * N + x + dx); return r; };

// ---------------------------------------------------------------- 1. Sektortypen
function placeSectors(rng, setting) {
  const side = Math.floor(rng() * 4);                               // Ortskern an dieser Kartenseite
  const along = 1 + rng() * 2, depth = 0.9 + rng() * 0.4;
  const c = [[along, depth], [K - depth, along], [along, K - depth], [depth, along]][side];
  const types = new Array(K * K).fill('acker');
  const ctr = s => [(s % K) + 0.5, ((s / K) | 0) + 0.5];
  const byDist = [...types.keys()].sort((a, b) => Math.hypot(ctr(a)[0] - c[0], ctr(a)[1] - c[1]) - Math.hypot(ctr(b)[0] - c[0], ctr(b)[1] - c[1]));
  for (const s of byDist.slice(0, setting.anteile.wohn)) types[s] = 'wohn';
  // Wald: vom fernsten Sektor aus zusammenhängend wachsen, bevorzugt wo das Landschaftsrauschen hoch ist
  const off = rng() * 100, far = byDist[byDist.length - 1], wald = [far];
  while (wald.length < setting.anteile.wald) {
    const cand = [];
    for (const s of wald) for (const [dx, dy] of DIRS) {
      const x = (s % K) + dx, y = ((s / K) | 0) + dy, t = y * K + x;
      if (x < 0 || y < 0 || x >= K || y >= K || wald.includes(t) || types[t] === 'wohn' || cand.includes(t)) continue;
      cand.push(t);
    }
    if (!cand.length) break;
    cand.sort((a, b) => (vnoise(ctr(b)[0], ctr(b)[1], off) + Math.hypot(ctr(b)[0] - c[0], ctr(b)[1] - c[1]) * 0.3) - (vnoise(ctr(a)[0], ctr(a)[1], off) + Math.hypot(ctr(a)[0] - c[0], ctr(a)[1] - c[1]) * 0.3));
    wald.push(cand[0]);
  }
  for (const s of wald) types[s] = 'wald';
  return { types, center: c, side };
}

// ---------------------------------------------------------------- Plan
/**
 * Weltplan erzeugen.
 * @param {number} seed
 * @param {object} [o]  { setting: 'suburban', biom: 'gemaessigt', reverse: false }
 */
export function weltPlan(seed, o = {}) {
  const settingName = o.setting || 'suburban', biomName = o.biom || 'gemaessigt';
  const setting = SETTINGS[settingName];
  if (!setting || !setting.fertig) throw new Error(`Setting „${settingName}“ ist noch nicht ausgearbeitet`);
  if (!BIOME[biomName]) throw new Error(`Biom „${biomName}“ unbekannt`);
  for (let attempt = 0; attempt < 30; attempt++) {
    const p = tryPlan(seed, attempt, setting, o);
    if (p) return { kind: 'welt', setting: settingName, biom: biomName, seed, version: WELT_VERSION, ...p };
  }
  throw new Error('Weltplan: kein gültiger Rahmen gefunden');
}

function tryPlan(seed, attempt, setting, o) {
  const rng = mulberry32(subSeed(seed, 77, attempt));
  const { types, center, side } = placeSectors(rng, setting);
  const typeAt = (x, y) => { const [sx, sy] = secOf(x, y); return types[sy * K + sx]; };
  const fixed = new Int32Array(N * N).fill(-1);
  const road = new Uint8Array(N * N), weg = new Uint8Array(N * N);
  const exits = [];

  // ---- 2a. Landstraße: Kartenrand → Ortskern → gegenüberliegender Rand (keine Berührung mit sich selbst)
  const ci = Math.min(N - 1, Math.floor(center[1] * SEKTOR)) * N + Math.min(N - 1, Math.floor(center[0] * SEKTOR));
  const wiggle = subSeed(seed, 78, attempt) % 1000;
  const cost = j => { const t = typeAt(j % N, (j / N) | 0); return (t === 'wald' ? 5 : t === 'wohn' ? 1 : 1.6) + vnoise((j % N) / 6, ((j / N) | 0) / 6, wiggle) * 1.5; };
  const edgeCells = s => { const r = []; for (let k = 2; k < N - 2; k++) r.push(s === 0 ? k : s === 1 ? k * N + N - 1 : s === 2 ? (N - 1) * N + k : k * N); return r; };
  const turn = (a, b, c2) => a >= 0 && dirTo(a, b) !== dirTo(b, c2) ? 3 : 0;
  const near = (i, set) => n4(i).some(j => set.has(j));
  const seg1 = shortest(edgeCells(side), (i, j, pi) => cost(j) + turn(pi, i, j), i => i === ci);
  if (!seg1) return null;
  const s1 = new Set(seg1.slice(0, -1));
  const block = new Set([...s1]); for (const i of s1) for (const j of n4(i)) if (j !== ci) block.add(j);
  const exitSide = (side + 2) % 4, goalEdge = new Set(edgeCells(exitSide));
  const seg2 = shortest([ci], (i, j, pi) => block.has(j) ? Infinity : cost(j) + turn(pi, i, j), i => goalEdge.has(i));
  if (!seg2) return null;
  const roadPath = [...seg1, ...seg2.slice(1)];
  // Selbstberührung prüfen (nicht aufeinanderfolgende Zellen dürfen nicht benachbart sein)
  const pos = new Map(roadPath.map((c2, k) => [c2, k]));
  for (const [c2, k] of pos) for (const j of n4(c2)) if (pos.has(j) && Math.abs(pos.get(j) - k) > 1) return null;
  const mask = new Uint8Array(N * N);
  roadPath.forEach((c2, k) => {
    road[c2] = 1;
    if (k > 0) mask[c2] |= 1 << dirTo(c2, roadPath[k - 1]);
    if (k < roadPath.length - 1) mask[c2] |= 1 << dirTo(c2, roadPath[k + 1]);
  });
  const outDir = s => s;   // Kartenseite 0 N, 1 O, 2 S, 3 W = Richtung nach draußen
  mask[roadPath[0]] |= 1 << outDir(side); mask[roadPath[roadPath.length - 1]] |= 1 << outDir(exitSide);
  exits.push({ cell: roadPath[0], d: outDir(side) }, { cell: roadPath[roadPath.length - 1], d: outDir(exitSide) });

  // ---- 2b. Hof mit Zufahrt: Wirtschaftsweg zur Landstraße, über mindestens eine Sektorgrenze
  const roadSecs = new Set(roadPath.map(c2 => { const [sx, sy] = secOf(c2 % N, (c2 / N) | 0); return sy * K + sx; }));
  const roadN = i => n4(i).filter(j => road[j]);
  const goodJunction = j => road[j] && (mask[j] === 5 || mask[j] === 10) && !exits.some(e => e.cell === j) && roadN(j).every(k => countBits(mask[k]) === 2);
  const hofCand = [];
  for (let s = 0; s < K * K; s++) if (types[s] === 'acker' && !roadSecs.has(s)) {
    const sx = s % K, sy = (s / K) | 0;
    for (let k = 0; k < 6; k++) {
      const x = sx * SEKTOR + 3 + Math.floor(rng() * (SEKTOR - 6)), y = sy * SEKTOR + 3 + Math.floor(rng() * (SEKTOR - 6));
      hofCand.push(y * N + x);
    }
  }
  let hof = -1, wegPath = null;
  for (const h of hofCand) {
    if (road[h] || near(h, new Set(roadPath))) continue;
    const path = shortest([h], (i, j) => {
      if (road[j]) return (goodJunction(j) && roadN(i).length === 1) ? 1 : Infinity;
      if (roadN(j).length > 1) return Infinity;
      if (roadN(j).length === 1 && !goodJunction(roadN(j)[0])) return Infinity;
      const t = typeAt(j % N, (j / N) | 0);
      return t === 'wohn' ? 9 : t === 'wald' ? 3 : 1 + vnoise((j % N) / 5, ((j / N) | 0) / 5, wiggle + 3);
    }, i => road[i] === 1);
    if (!path || path.length < 4) continue;
    // über eine Sektorgrenze? keine Selbstberührung?
    const secs = new Set(path.slice(0, -1).map(c2 => secOf(c2 % N, (c2 / N) | 0).join(',')));
    if (secs.size < 2) continue;
    const pp = new Map(path.map((c2, k) => [c2, k]));
    let touch = false;
    for (const [c2, k] of pp) for (const j of n4(c2)) if (pp.has(j) && Math.abs(pp.get(j) - k) > 1) touch = true;
    if (touch) continue;
    hof = h; wegPath = path; break;
  }
  if (hof < 0) return null;
  const junction = wegPath[wegPath.length - 1];
  const wmask = new Uint8Array(N * N);
  for (let k = 1; k < wegPath.length - 1; k++) {
    const c2 = wegPath[k]; weg[c2] = 1;
    wmask[c2] |= 1 << dirTo(c2, wegPath[k - 1]); wmask[c2] |= 1 << dirTo(c2, wegPath[k + 1]);
  }
  mask[junction] |= 1 << dirTo(junction, wegPath[wegPath.length - 2]);
  const hofDir = dirTo(hof, wegPath[1]);
  // Kreuzungsabstand: kein J–J
  for (const c2 of roadPath) if (countBits(mask[c2]) >= 3) for (const j of roadN(c2)) if (countBits(mask[j]) >= 3) return null;

  for (const c2 of roadPath) fixed[c2] = ROAD(mask[c2]);
  for (let k = 1; k < wegPath.length - 1; k++) fixed[wegPath[k]] = WEG(wmask[wegPath[k]]);
  fixed[hof] = HOF(1 << hofDir);
  const net = new Set([...roadPath, ...wegPath]);

  // ---- 3a. Großes Feld über die Grenze zweier Acker-Sektoren
  let field = null;
  const pairs = [];
  for (let s = 0; s < K * K; s++) if (types[s] === 'acker') {
    const sx = s % K, sy = (s / K) | 0;
    if (sx + 1 < K && types[s + 1] === 'acker') pairs.push({ v: true, sx, sy });
    if (sy + 1 < K && types[s + K] === 'acker') pairs.push({ v: false, sx, sy });
  }
  for (let t = 0; t < 60 && !field && pairs.length; t++) {
    const pr = pairs[Math.floor(rng() * pairs.length)];
    const fw = 6 + Math.floor(rng() * 4), fh = 4 + Math.floor(rng() * 3);
    const [lw, lh] = pr.v ? [fw, fh] : [fh, fw];
    const bx = (pr.sx + (pr.v ? 1 : 0)) * SEKTOR, by = (pr.sy + (pr.v ? 0 : 1)) * SEKTOR;
    const x0 = pr.v ? bx - Math.floor(lw / 2) + Math.floor(rng() * 3) - 1 : pr.sx * SEKTOR + 2 + Math.floor(rng() * (SEKTOR - lw - 4));
    const y0 = pr.v ? pr.sy * SEKTOR + 2 + Math.floor(rng() * (SEKTOR - lh - 4)) : by - Math.floor(lh / 2) + Math.floor(rng() * 3) - 1;
    let ok = true;
    for (let y = y0; y < y0 + lh && ok; y++) for (let x = x0; x < x0 + lw && ok; x++) if (!inMap(x, y) || net.has(y * N + x) || typeAt(x, y) !== 'acker') ok = false;
    if (ok) field = { x0, y0, x1: x0 + lw, y1: y0 + lh, v: pr.v, boundary: pr.v ? bx : by };
  }
  if (!field) return null;
  for (let y = field.y0; y < field.y1; y++) for (let x = field.x0; x < field.x1; x++) fixed[y * N + x] = idx('feld');

  // ---- 3b. Wald aus dem Landschaftsfeld, mit Abstand zu Nicht-Wald-Sektoren; Waldrand muss eine Wald-Wald-Grenze kreuzen
  const waldPairs = [];
  for (let s = 0; s < K * K; s++) if (types[s] === 'wald') {
    const sx = s % K, sy = (s / K) | 0;
    if (sx + 1 < K && types[s + 1] === 'wald') waldPairs.push({ v: true, b: (sx + 1) * SEKTOR, lo: sy * SEKTOR, hi: (sy + 1) * SEKTOR });
    if (sy + 1 < K && types[s + K] === 'wald') waldPairs.push({ v: false, b: (sy + 1) * SEKTOR, lo: sx * SEKTOR, hi: (sx + 1) * SEKTOR });
  }
  if (!waldPairs.length) return null;
  // Vorzeichenbehafteter Abstand zur Waldgrenze (Zellen): positiv in Wald-Sektoren, negativ außerhalb (bis ±6)
  const sdist = (x, y) => {
    const inW = typeAt(x, y) === 'wald';
    for (let r = 1; r <= 6; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const nx = x + dx, ny = y + dy;
      if (inMap(nx, ny) && (typeAt(nx, ny) === 'wald') !== inW) return inW ? r - 0.5 : 0.5 - r;
    }
    return inW ? 6 : -6;
  };
  const nearWohn = (x, y) => { for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (inMap(x + dx, y + dy) && typeAt(x + dx, y + dy) === 'wohn') return true; return false; };
  let forest = null, forestEdge = null;
  for (let fa = 0; fa < 20 && !forest; fa++) {
    const off = subSeed(seed, 79, attempt, fa) % 1000;
    const val = (x, y) => vnoise(x / 7, y / 7, off) * 0.65 + vnoise(x / 3, y / 3, off + 9) * 0.35;
    const m = new Uint8Array(N * N);
    // Der Wald folgt dem Landschaftsfeld: tief im Wald-Sektor dicht, an der Grenze ein weicher Übergang, der in
    // die Nachbaräcker hineinreichen kann (Waldstücke) – so läuft der Rand nicht an der Sektorgrenze entlang.
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = y * N + x, t = typeAt(x, y);
      if (t === 'wohn' || net.has(i) || fixed[i] >= 0 || near(i, net) || nearWohn(x, y)) continue;
      if (field && x >= field.x0 - 1 && x <= field.x1 && y >= field.y0 - 1 && y <= field.y1) continue;
      const bias = Math.max(-0.3, Math.min(0.16, sdist(x, y) * 0.045));
      if (val(x, y) + bias > 0.5) m[i] = 1;
    }
    // Waldrand kreuzt eine Wald-Wald-Grenze: entlang der Grenze gibt es Wald und Lichtung auf beiden Seiten gleich
    for (const wp of waldPairs) {
      let both = 0, none = 0, mism = 0;
      for (let k = wp.lo + 2; k < wp.hi - 2; k++) {
        const a = wp.v ? m[k * N + wp.b - 1] : m[(wp.b - 1) * N + k], b = wp.v ? m[k * N + wp.b] : m[wp.b * N + k];
        if (a && b) both++; else if (!a && !b) none++; else mism++;
      }
      if (both >= 3 && none >= 2 && mism <= 3) { forest = m; forestEdge = wp; break; }
    }
  }
  if (!forest) return null;
  for (let i = 0; i < N * N; i++) if (forest[i]) fixed[i] = idx('wald');

  // ---- 4. Ecken → Kanten → Flächen
  const W8 = {}; for (const t of ['wohn', 'acker', 'wald']) W8[t] = weightsFor(t);
  const AL = {}; for (const t of Object.keys(W8)) AL[t] = [...W8[t].keys()].filter(i => W8[t][i] > 0);
  const filler = [idx('wiese'), idx('brache')];
  const exitAt = new Map(exits.map(e => [e.cell * 4 + e.d, R]));
  const ps = planSectors({
    N, S: SEKTOR, seed: subSeed(seed, 80, attempt), reverse: !!o.reverse, filler,
    tiles: { weights: TILES.map(() => 1), sockets: SOCK2, compat: COMPAT2, border: BORDER_OK },
    weightsAt: (x, y) => W8[typeAt(x, y)], allowedAt: (x, y) => AL[typeAt(x, y)], fixedAt: (x, y) => fixed[y * N + x],
    mapEdge: (x, y, d) => exitAt.get((y * N + x) * 4 + d) ?? -2,
    accept: (p, get) => p.kind === 'flaeche' ? strayRoads(p, get) : 0,
  });
  const grid = Array.from(ps.grid);
  const spawnCell = roadPath.reduce((b, c2) => Math.hypot(c2 % N - center[0] * SEKTOR, ((c2 / N) | 0) - center[1] * SEKTOR) < Math.hypot(b % N - center[0] * SEKTOR, ((b / N) | 0) - center[1] * SEKTOR) ? c2 : b, roadPath[0]);
  return {
    N, S: SEKTOR, K, grid, order: ps.order, types, center, issues: ps.issues,
    pieces: ps.pieces.map(p => ({ kind: p.kind, x0: p.x0, y0: p.y0, x1: p.x1, y1: p.y1, tries: p.tries, filler: p.filler })),
    net: { road: roadPath, weg: wegPath.slice(1, -1), exits, hof, hofDir, junction },
    field, forest: Array.from(forest), forestEdge, spawn: { tx: spawnCell % N, ty: (spawnCell / N) | 0 }, attempt,
  };
}
function countBits(m) { return (m & 1) + (m >> 1 & 1) + (m >> 2 & 1) + (m >> 3 & 1); }

/** Straßenstücke einer Fläche, die keinen Anschluss nach draußen haben (Zellen). 0 = alles angebunden. */
function strayRoads(p, get) {
  const isR = t => t >= 0 && (TILES[t].kind === 'road');
  const seen = new Set(); let stray = 0;
  for (let y = p.y0; y < p.y1; y++) for (let x = p.x0; x < p.x1; x++) {
    const i = y * N + x; if (seen.has(i) || !isR(get(x, y))) continue;
    const comp = [i]; seen.add(i); let out = false;
    for (let k = 0; k < comp.length; k++) {
      const c = comp[k], cx = c % N, cy = (c / N) | 0, m = TILES[get(cx, cy)].mask;
      for (let d = 0; d < 4; d++) if (m >> d & 1) {
        const nx = cx + DIRS[d][0], ny = cy + DIRS[d][1];
        if (nx < p.x0 || ny < p.y0 || nx >= p.x1 || ny >= p.y1) { out = true; continue; }
        const j = ny * N + nx; if (!seen.has(j)) { seen.add(j); comp.push(j); }
      }
    }
    if (!out) stray += comp.length;
  }
  return stray;
}

// ---------------------------------------------------------------- Prüfungen (Tests, Karte)
/**
 * Verbindung über tatsächlich zusammenpassende Straßen- und Wegäste: von den Kartenausgängen der Landstraße
 * bis zur Hofzufahrt. Liefert den Pfad (Zellen) oder null.
 */
export function hofErreichbar(plan) {
  const { grid, net } = plan, N2 = plan.N;
  const kind = i => TILES[grid[i]];
  const linked = (i, d) => {
    const t = kind(i); if (!(t.mask >> d & 1) || !['road', 'weg', 'hof'].includes(t.kind)) return -1;
    const x = i % N2 + DIRS[d][0], y = ((i / N2) | 0) + DIRS[d][1];
    if (x < 0 || y < 0 || x >= N2 || y >= N2) return -1;
    const j = y * N2 + x, u = kind(j);
    return ['road', 'weg', 'hof'].includes(u.kind) && (u.mask >> ((d + 2) % 4) & 1) ? j : -1;
  };
  const prev = new Map(), q = net.exits.map(e => e.cell);
  for (const s of q) prev.set(s, -1);
  for (let k = 0; k < q.length; k++) {
    const i = q[k];
    if (i === net.hof) { const p = []; for (let c = i; c >= 0; c = prev.get(c)) p.push(c); return p.reverse(); }
    for (let d = 0; d < 4; d++) { const j = linked(i, d); if (j >= 0 && !prev.has(j)) { prev.set(j, i); q.push(j); } }
  }
  return null;
}
