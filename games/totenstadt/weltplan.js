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
const LAND = { haus: B, laden: B, parkplatz: B, garten: G, wiese: O, park: O, brache: O, hecke: O, feld: A, wald: D };
export const SOCK2 = TILES.map(t => [0, 1, 2, 3].map(d => {
  if (t.kind === 'road') return (t.mask >> d & 1) ? (t.deg >= 3 ? J : R) : F;
  if (t.kind === 'weg') return (t.mask >> d & 1) ? W : V;
  if (t.kind === 'hof') return (t.mask >> d & 1) ? W : H;
  return LAND[t.kind];
}));
const BORDER_OK = s => s !== R && s !== J && s !== W;   // nichts läuft ohne Plan aus der Karte

const idx = (kind, mask = 0) => TILES.findIndex(t => t.kind === kind && (t.mask || 0) === mask);
const ROAD = m => idx('road', m), WEG = m => idx('weg', m), HOF = m => idx('hof', m);

/**
 * Gewichte je Fläche (Index = Kacheltyp). Straßen, Wege, Felder und der Waldkern sind vorab geplant; WFC gestaltet
 * nur noch die Wohnblöcke zwischen den Straßen und die Säume an den Flächengrenzen.
 */
function weightsFor(use) {
  const w = new Float64Array(TILES.length);
  TILES.forEach((t, i) => {
    if (use === 'wohn') w[i] = { haus: 18, garten: 7, laden: 0.8, park: 1.0, parkplatz: 0.2, wiese: 0.6 }[t.kind] || 0;
    else if (use === 'acker') w[i] = { feld: 6, wiese: 2 }[t.kind] || 0;          // Saum am Rand des Ackers
    else if (use === 'wald') w[i] = { wald: 5, wiese: 1.2 }[t.kind] || 0;         // unregelmäßiger Waldsaum
  });
  return w;
}

// ---------------------------------------------------------------- Hilfen
const N = GN, K = N / SEKTOR;
const inMap = (x, y) => x >= 0 && y >= 0 && x < N && y < N;
const XY = i => [i % N, (i / N) | 0];
const secKey = i => `${((i % N) / SEKTOR) | 0},${(((i / N) | 0) / SEKTOR) | 0}`;
const dirTo = (i, j) => { const dx = (j % N) - (i % N), dy = ((j / N) | 0) - ((i / N) | 0); return DIRS.findIndex(([a, b]) => a === dx && b === dy); };
const n4 = i => { const x = i % N, y = (i / N) | 0, r = []; for (const [dx, dy] of DIRS) if (inMap(x + dx, y + dy)) r.push((y + dy) * N + x + dx); return r; };
function countBits(m) { return (m & 1) + (m >> 1 & 1) + (m >> 2 & 1) + (m >> 3 & 1); }
/** Dijkstra auf dem Zellraster. step(from, to, prevOfFrom) → Kosten oder Infinity; goal(i) → true. */
function shortest(starts, step, goal) {
  const dist = new Float64Array(N * N).fill(Infinity), prev = new Int32Array(N * N).fill(-1), heap = [];
  const push = (d, i) => { heap.push([d, i]); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
  for (const s of starts) { dist[s] = 0; push(0, s); }
  while (heap.length) {
    const [d, i] = pop();
    if (d > dist[i]) continue;
    if (goal(i)) { const path = []; for (let k = i; k >= 0; k = prev[k]) path.push(k); return path.reverse(); }
    for (const j of n4(i)) {
      const c = step(i, j, prev[i]);
      if (c === Infinity) continue;
      if (d + c < dist[j]) { dist[j] = d + c; prev[j] = i; push(d + c, j); }
    }
  }
  return null;
}
/** Abstand (Zellen, 4er-Nachbarschaft) jeder Zelle zur nächsten Zelle, für die is() nicht gilt (begrenzt). */
function distInside(is, max = 8) {
  const d = new Uint8Array(N * N).fill(max), q = [];
  for (let i = 0; i < N * N; i++) if (!is(i)) { d[i] = 0; q.push(i); }
  for (let k = 0; k < q.length; k++) for (const j of n4(q[k])) if (d[j] > d[q[k]] + 1) { d[j] = d[q[k]] + 1; q.push(j); }
  return d;
}
function largestComponent(set) {
  const seen = new Uint8Array(N * N); let best = [];
  for (let i = 0; i < N * N; i++) if (set[i] && !seen[i]) {
    const c = [i]; seen[i] = 1;
    for (let k = 0; k < c.length; k++) for (const j of n4(c[k])) if (set[j] && !seen[j]) { seen[j] = 1; c.push(j); }
    if (c.length > best.length) best = c;
  }
  const out = new Uint8Array(N * N); for (const i of best) out[i] = 1; return out;
}

// ---------------------------------------------------------------- Netz (Straßen, Wege, Hof)
/**
 * Straßen und Wirtschaftswege als Graph auf dem Zellraster. Neue Stücke werden nur angenommen, wenn sie die
 * Kachelregeln einhalten: keine Berührung außer an Verbindungen (sonst F–F, F–V, V–V), keine zwei Kreuzungen
 * nebeneinander (J–J).
 */
class Netz {
  constructor() { this.kind = new Uint8Array(N * N); this.mask = new Uint8Array(N * N); this.exit = new Uint8Array(N * N); this.parts = []; }
  // 1 Straße, 2 Weg, 3 Hof
  /**
   * path: Zellen. join0: path[0] ist schon im Netz; joinEnd: das letzte Element ist schon im Netz.
   * ok(i): darf diese Zelle neu belegt werden?
   */
  add(path, kind, { join0 = false, joinEnd = false, ok = () => true, name = '' } = {}) {
    const n = path.length, isNew = k => !(join0 && k === 0) && !(joinEnd && k === n - 1);
    if (n < 2) return false;
    const pos = new Map(path.map((c, k) => [c, k]));
    if (pos.size !== n) return false;
    for (let k = 0; k < n; k++) {
      const c = path[k];
      if (!isNew(k)) { if (!this.kind[c]) return false; continue; }
      if (this.kind[c] || !ok(c)) return false;
      if (k > 0 && dirTo(path[k - 1], c) < 0) return false;
      for (const q of n4(c)) {
        if (pos.has(q)) { if (Math.abs(pos.get(q) - k) !== 1) return false; continue; }
        if (this.kind[q]) return false;                     // berührt das Netz außerhalb einer Verbindung
      }
    }
    if (dirTo(path[n - 2], path[n - 1]) < 0) return false;
    // Verbindungen: Straße an Straße/Weg, Weg an Straße/Weg/Hof
    for (const k of [0, n - 1]) if (!isNew(k)) {
      const c = path[k], kk = this.kind[c];
      if (kind === 1 && kk !== 1) return false;
      if (kind === 2 && kk === 3 && countBits(this.mask[c])) return false;   // Hof hat nur eine Zufahrt
      if (kk === 1 && this.exit[c]) return false;
    }
    // übernehmen (vorläufig) und J–J prüfen
    const old = [];
    const set = (c, b) => { old.push([c, this.mask[c]]); this.mask[c] |= b; };
    for (let k = 0; k < n; k++) {
      if (isNew(k)) this.kind[path[k]] = kind;
      if (k > 0) set(path[k], 1 << dirTo(path[k], path[k - 1]));
      if (k < n - 1) set(path[k], 1 << dirTo(path[k], path[k + 1]));
    }
    const bad = path.some(c => this.kind[c] === 1 && countBits(this.mask[c]) >= 3 && n4(c).some(q => this.kind[q] === 1 && (this.mask[c] >> dirTo(c, q) & 1) && countBits(this.mask[q]) >= 3));
    if (bad) {
      for (let k = old.length - 1; k >= 0; k--) this.mask[old[k][0]] = old[k][1];
      for (let k = 0; k < n; k++) if (isNew(k)) this.kind[path[k]] = 0;
      return false;
    }
    this.parts.push({ kind, name, cells: path.filter((_, k) => isNew(k)) });
    return true;
  }
  /** Darf an Zelle c ein neuer Ast ansetzen? */
  canBranch(c, kind) {
    const kk = this.kind[c];
    if (!kk || this.exit[c]) return false;
    if (kk === 3) return kind === 2 && !countBits(this.mask[c]);
    if (kind === 1 && kk !== 1) return false;
    if (kk === 1 && countBits(this.mask[c]) + 1 >= 3) return n4(c).every(q => !(this.kind[q] === 1 && (this.mask[c] >> dirTo(c, q) & 1)) || countBits(this.mask[q]) < 3);
    return true;
  }
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
  const why = {};
  for (let attempt = 0; attempt < 40; attempt++) {
    const p = tryPlan(seed, attempt, setting, o, why);
    if (p) return { kind: 'welt', setting: settingName, biom: biomName, seed, version: WELT_VERSION, ...p };
  }
  throw new Error('Weltplan: kein gültiger Rahmen gefunden ' + JSON.stringify(why));
}

function tryPlan(seed, attempt, setting, o, why) {
  const fail = r => { why[r] = (why[r] || 0) + 1; return null; };
  const rng = mulberry32(subSeed(seed, 77, attempt)), off = subSeed(seed, 78, attempt) % 1000;

  // ---- 1. Landnutzung als eigene Flächen (unabhängig vom Sektorraster)
  const side = Math.floor(rng() * 4), opp = (side + 2) % 4;
  // lokale Achsen: along entlang der Kartenseite, depth von der Seite ins Innere
  const toXY = (s, along, depth) => s === 0 ? [along, depth] : s === 1 ? [N - 1 - depth, along] : s === 2 ? [along, N - 1 - depth] : [depth, along];
  const c = toXY(side, 22 + Math.floor(rng() * 20), 15 + Math.floor(rng() * 4));
  const f = toXY(opp, 14 + Math.floor(rng() * 36), 10 + Math.floor(rng() * 5));
  const alongAxis = s => (s === 0 || s === 2) ? [1, 0] : [0, 1];
  const ell = (x, y, cx, cy, s, ra, rd) => { const [ax, ay] = alongAxis(s), dx = x - cx, dy = y - cy, a = dx * ax + dy * ay, d = dx * ay - dy * ax; return Math.hypot(a / ra, d / rd); };
  const wohn0 = new Uint8Array(N * N), wald0 = new Uint8Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x;
    if (ell(x, y, c[0], c[1], side, 15, 12.5) + (vnoise(x / 7, y / 7, off) - 0.5) * 0.45 < 1) wohn0[i] = 1;
    else if (ell(x, y, f[0], f[1], opp, 25, 13) + (vnoise(x / 8, y / 8, off + 5) - 0.5) * 0.6 + (vnoise(x / 3, y / 3, off + 6) - 0.5) * 0.15 < 1) wald0[i] = 1;
  }
  const wohnA = largestComponent(wohn0), waldA = largestComponent(wald0);
  const use = new Array(N * N);
  for (let i = 0; i < N * N; i++) use[i] = wohnA[i] ? 'wohn' : waldA[i] ? 'wald' : 'acker';
  let dWohn = distInside(i => use[i] === 'wohn'), dWald = distInside(i => use[i] === 'wald'), dAcker = distInside(i => use[i] === 'acker');
  const ci = c[1] * N + c[0];
  if (use[ci] !== 'wohn') return fail('ortskern');

  const net = new Netz();
  // ---- 2. Landstraße: Kartenrand → Ortskern → seitlicher Kartenrand (weg vom Wald)
  const edgeCells = s => { const r = []; for (let k = 3; k < N - 3; k++) r.push(s === 0 ? k : s === 1 ? k * N + N - 1 : s === 2 ? (N - 1) * N + k : k * N); return r; };
  const cost = j => (use[j] === 'wald' ? 7 : use[j] === 'wohn' ? 1 : 1.4) + vnoise((j % N) / 7, ((j / N) | 0) / 7, off + 9);
  const turn = (a, b, c2) => a >= 0 && dirTo(a, b) !== dirTo(b, c2) ? 4 : 0;
  const s1 = shortest(edgeCells(side), (i, j, pi) => cost(j) + turn(pi, i, j), i => i === ci);
  if (!s1) return fail('landstrasse');
  const fd = [(side + 1) % 4, (side + 3) % 4].map(s => { const e = edgeCells(s); const m = e[e.length >> 1]; return [s, Math.hypot(m % N - f[0], ((m / N) | 0) - f[1])]; });
  const exitSide = fd[0][1] > fd[1][1] ? fd[0][0] : fd[1][0], goalEdge = new Set(edgeCells(exitSide));
  const block = new Set(); for (const i of s1) if (i !== ci) { block.add(i); for (const j of n4(i)) if (j !== ci) block.add(j); }
  const s2 = shortest([ci], (i, j, pi) => block.has(j) ? Infinity : cost(j) + turn(pi, i, j), i => goalEdge.has(i));
  if (!s2) return fail('landstrasse');
  const land = [...s1, ...s2.slice(1)];
  if (!net.add(land, 1, { name: 'Landstraße' })) return fail('landstrasse-regeln');
  const e0 = land[0], e1 = land[land.length - 1];
  net.mask[e0] |= 1 << side; net.mask[e1] |= 1 << exitSide; net.exit[e0] = 1; net.exit[e1] = 1;
  const exits = [{ cell: e0, d: side }, { cell: e1, d: exitSide }];

  // ---- 3. Wohnquartier: Sammelstraße senkrecht zur Landstraße, Seitenstraßen im Abstand 3, Wohnschleifen
  const inWohn = (i, m = 1) => use[i] === 'wohn' && dWohn[i] >= m;
  const ray = (start, d, maxLen, ok) => { const r = []; let [x, y] = XY(start); for (let k = 0; k < maxLen; k++) { x += DIRS[d][0]; y += DIRS[d][1]; if (!inMap(x, y) || !ok(y * N + x)) break; r.push(y * N + x); } return r; };
  // Sammelstraßen: die längsten geraden Abzweigungen von der Landstraße ins Quartier (höchstens zwei)
  const sammelListe = [];
  for (let n = 0; n < 2; n++) {
    let best = null;
    for (const j of land) if (use[j] === 'wohn' && net.canBranch(j, 1)) for (let d = 0; d < 4; d++) {
      if (net.mask[j] >> d & 1) continue;
      const r = ray(j, d, 20, i => inWohn(i, 2) && !net.kind[i]);
      if (r.length >= 5 && (!best || r.length > best.r.length)) best = { j, d, r };
    }
    if (!best) break;
    let cells = null;
    for (let L = best.r.length; L >= 5 && !cells; L--) if (net.add([best.j, ...best.r.slice(0, L)], 1, { join0: true, name: 'Sammelstraße' })) cells = best.r.slice(0, L);
    if (cells) sammelListe.push({ cells, d: best.d });
    else break;
  }
  if (!sammelListe.length) return fail('sammelstrasse');
  // Seitenstraßen von Sammel- und Landstraße, alle 3 Zellen, beidseitig; Paare gleicher Länge werden zu Schleifen
  const seiten = [];
  const branchFrom = (line, d0) => {
    for (let k = 2; k < line.length; k += 3) for (const d of [(d0 + 1) % 4, (d0 + 3) % 4]) {
      const j = line[k], end = line[line.length - 1];
      if (k === line.length - 2 && countBits(net.mask[end]) === 1) continue;   // sonst bliebe ein Stummel von einer Zelle
      if (!net.canBranch(j, 1) || (net.mask[j] >> d & 1)) continue;
      const r = ray(j, d, 7, i => inWohn(i, 1) && !net.kind[i]);
      for (let L = r.length; L >= 2; L--) if (net.add([j, ...r.slice(0, L)], 1, { join0: true, name: 'Wohnstraße' })) { seiten.push({ j, d, cells: r.slice(0, L), k, line }); break; }
    }
  };
  for (const sm of sammelListe) branchFrom(sm.cells, sm.d);
  for (let k = 0; k < land.length - 1; k++) {   // gerade Stücke der Landstraße im Quartier
    let e = k; while (e + 1 < land.length && use[land[e + 1]] === 'wohn' && dirTo(land[e], land[e + 1]) === dirTo(land[k], land[k + 1])) e++;
    if (e - k >= 5 && use[land[k]] === 'wohn') branchFrom(land.slice(k, e + 1), dirTo(land[k], land[k + 1]));
    k = Math.max(k, e - 1);
  }
  // Schleifen: Enden benachbarter Seitenstraßen (gleiche Seite, gleiche Länge) verbinden
  let schleifen = 0;
  for (let a = 0; a < seiten.length; a++) for (let b = a + 1; b < seiten.length; b++) {
    const A = seiten[a], Bs = seiten[b];
    if (A.loop || Bs.loop || A.d !== Bs.d || A.line !== Bs.line || Math.abs(A.k - Bs.k) !== 3 || A.cells.length !== Bs.cells.length || A.cells.length < 3) continue;
    if (rng() < 0.3) continue;   // manche bleiben Sackgassen
    const ea = A.cells[A.cells.length - 1], eb = Bs.cells[Bs.cells.length - 1];
    const d = dirTo(ea, ea + (eb > ea ? (Math.abs(eb - ea) < N ? 1 : N) : (Math.abs(eb - ea) < N ? -1 : -N)));
    const mid = ray(ea, d, 2, () => true);
    if (mid.length === 2 && net.add([ea, ...mid, eb], 1, { join0: true, joinEnd: true, name: 'Wohnschleife' })) { A.loop = Bs.loop = true; schleifen++; }
  }

  // Quartier auf das Einzugsgebiet seiner Straßen zuschneiden (≤ 2 Zellen von einer Straße im Ort); der Rest wird
  // Acker – so endet der Ort dort, wo seine Straßen enden, und nicht an einer gedachten Linie
  {
    const dRoad = distInside(i => !(net.kind[i] === 1 && use[i] === 'wohn'), 4);
    let n = 0;
    for (let i = 0; i < N * N; i++) if (use[i] === 'wohn' && dRoad[i] > 2) { use[i] = 'acker'; n++; }
    const keep = largestComponent(Uint8Array.from(use, u => u === 'wohn' ? 1 : 0));
    for (let i = 0; i < N * N; i++) if (use[i] === 'wohn' && !keep[i]) use[i] = 'acker';
    dWohn = distInside(i => use[i] === 'wohn'); dAcker = distInside(i => use[i] === 'acker');
  }

  // ---- 4. Acker: Parzellen (Voronoi um 4 Saatpunkte, durch Straßen getrennt), Hofgrundstück, Wege an den Grenzen
  const ackerFrei = i => use[i] === 'acker' && !net.kind[i];
  const pool = []; for (let i = 0; i < N * N; i++) if (ackerFrei(i) && dAcker[i] >= 3) pool.push(i);
  if (pool.length < 300) return fail('acker-klein');
  const seeds = [pool[Math.floor(rng() * pool.length)]];
  while (seeds.length < 4) {   // weit auseinander
    let bi = -1, bd = -1;
    for (let t = 0; t < 200; t++) { const i = pool[Math.floor(rng() * pool.length)], d = Math.min(...seeds.map(s => Math.hypot(i % N - s % N, ((i / N) | 0) - ((s / N) | 0)))); if (d > bd) { bd = d; bi = i; } }
    seeds.push(bi);
  }
  const vor = new Int32Array(N * N).fill(-1);
  for (let i = 0; i < N * N; i++) if (ackerFrei(i)) {
    let bk = -1, bd = 1e9;
    seeds.forEach((s, k) => { const d = Math.abs(i % N - s % N) + Math.abs(((i / N) | 0) - ((s / N) | 0)) + vnoise((i % N) / 6, ((i / N) | 0) / 6, off + 20 + k) * 5; if (d < bd) { bd = d; bk = k; } });
    vor[i] = bk;
  }
  // Hof: an einer Parzellengrenze, abseits von Straße und Ort, mit Hofwiese ringsum
  let hof = -1;
  const hofCand = pool.filter(i => n4(i).some(j => vor[j] >= 0 && vor[j] !== vor[i]) && dWohn[i] >= 0 && Math.hypot(i % N - c[0], ((i / N) | 0) - c[1]) > 14);
  for (let t = 0; t < 40 && hof < 0 && hofCand.length; t++) {
    const h = hofCand[Math.floor(rng() * hofCand.length)];
    const ring = []; const [hx, hy] = XY(h);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) ring.push((hy + dy) * N + hx + dx);
    if (ring.every(i => ackerFrei(i) && n4(i).every(j => !net.kind[j]))) hof = h;
  }
  if (hof < 0) return fail('hof');
  const hofRing = []; { const [hx, hy] = XY(hof); for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) hofRing.push((hy + dy) * N + hx + dx); }
  net.kind[hof] = 3;
  const reserved = new Uint8Array(N * N); for (const i of hofRing) reserved[i] = 1;   // Hofwiese
  // Wege: vom Hof und von jeder Parzelle zum vorhandenen Netz, bevorzugt entlang der Parzellengrenzen
  const grenz = i => n4(i).some(j => vor[j] >= 0 && vor[j] !== vor[i]);
  const wegOk = i => use[i] !== 'wohn' && !reserved[i] && (use[i] === 'acker' || dWald[i] <= 2);
  const wegCost = (i, j) => (grenz(j) ? 1 : 5) + (use[j] === 'wald' ? 6 : 0) + vnoise((j % N) / 4, ((j / N) | 0) / 4, off + 30) * 0.5;
  const connect = (starts, startJoin, name) => {
    // Dijkstra von den Startzellen bis zu einer Zelle, an der ein Ast ans Netz darf
    const banned = new Set();
    for (let tr = 0; tr < 4; tr++) {
      const path = shortest(starts, (i, j) => {
        if (net.kind[j]) return net.canBranch(j, 2) && n4(i).filter(q => net.kind[q]).length === 1 ? 1 : Infinity;
        const durchHof = net.kind[i] === 3 && reserved[j];   // Zufahrt durch die Hofwiese
        if ((!wegOk(j) && !durchHof) || banned.has(j)) return Infinity;
        const nb = n4(j).filter(q => net.kind[q] && q !== i);
        if (nb.length > 1 || (nb.length === 1 && !net.canBranch(nb[0], 2))) return Infinity;
        return wegCost(i, j) + tr * rng();
      }, i => net.kind[i] && !starts.includes(i));
      if (!path) return null;
      const okC = i => wegOk(i) || (startJoin && reserved[i] && n4(i).includes(path[0]));
      const ok = startJoin ? net.add(path, 2, { join0: true, joinEnd: true, ok: okC, name }) : net.add(path, 2, { joinEnd: true, ok: okC, name });
      if (ok) { for (const i of path) if (net.kind[i] === 2) reserved[i] = 0; return path; }
      for (const i of path) if (!net.kind[i]) banned.add(i);
    }
    return null;
  };
  const hofWeg = connect([hof], true, 'Hofzufahrt');
  if (!hofWeg) return fail('hofzufahrt');
  if (new Set(hofWeg.map(secKey)).size < 2) return fail('hofzufahrt-ohne-grenze');   // Abnahme: Zufahrt über eine Sektorgrenze
  // Parzellen (nach Straßen getrennt) bestimmen und erschließen
  const parcelOf = new Int32Array(N * N).fill(-1), parcels = [];
  const fieldCell = i => vor[i] >= 0 && !net.kind[i] && !reserved[i];
  for (let i = 0; i < N * N; i++) if (fieldCell(i) && parcelOf[i] < 0) {
    const cells = [i]; parcelOf[i] = parcels.length;
    for (let k = 0; k < cells.length; k++) for (const j of n4(cells[k])) if (fieldCell(j) && parcelOf[j] < 0 && vor[j] === vor[i]) { parcelOf[j] = parcels.length; cells.push(j); }
    parcels.push({ id: parcels.length, cells });
  }
  const big = parcels.filter(p => p.cells.length >= 40).sort((a, b) => b.cells.length - a.cells.length);
  if (big.length < 4) return fail('parzellen');
  for (const p of big) {
    const touches = () => p.cells.some(i => n4(i).some(j => net.kind[j] === 1 || net.kind[j] === 2));
    if (touches()) continue;
    const border = p.cells.filter(i => n4(i).some(j => parcelOf[j] !== p.id));
    if (!connect(border, false, 'Feldweg')) return fail('feldweg');
  }
  // Parzellen nach den Wegen neu fassen; Raine (Hecken) zwischen Parzellen ohne Weg
  parcelOf.fill(-1); const fields = [];
  for (let i = 0; i < N * N; i++) if (fieldCell(i) && parcelOf[i] < 0) {
    const cells = [i]; parcelOf[i] = fields.length;
    for (let k = 0; k < cells.length; k++) for (const j of n4(cells[k])) if (fieldCell(j) && parcelOf[j] < 0 && vor[j] === vor[i]) { parcelOf[j] = fields.length; cells.push(j); }
    fields.push({ id: fields.length, cells });
  }
  const hecke = new Uint8Array(N * N);
  for (let i = 0; i < N * N; i++) if (parcelOf[i] >= 0 && n4(i).some(j => parcelOf[j] >= 0 && vor[j] !== vor[i] && vor[j] < vor[i])) hecke[i] = 1;

  // ---- 5. feste Vorgaben für WFC
  const fixed = new Int32Array(N * N).fill(-1);
  for (let i = 0; i < N * N; i++) {
    const k = net.kind[i];
    if (k === 1) fixed[i] = ROAD(net.mask[i] & 15);
    else if (k === 2) fixed[i] = WEG(net.mask[i]);
    else if (k === 3) fixed[i] = HOF(net.mask[i]);
    else if (reserved[i]) fixed[i] = idx('wiese');
    else if (hecke[i]) fixed[i] = idx('hecke');
    else if (parcelOf[i] >= 0 && dAcker[i] >= 2) fixed[i] = idx('feld');
    else if (use[i] === 'wald' && dWald[i] >= 2) fixed[i] = idx('wald');
  }
  for (const e of exits) fixed[e.cell] = ROAD(net.mask[e.cell]);
  // geplante Felder: größtes zusammenhängendes Stück je Parzelle; kleine Reste und kleine Parzellen werden Wiese
  const FELD = idx('feld'), WIESE = idx('wiese'), planned = [];
  for (const p of fields) {
    const cells = p.cells.filter(i => fixed[i] === FELD), set = new Set(cells), seen = new Set(), comps = [];
    for (const i of cells) if (!seen.has(i)) {
      const cc = [i]; seen.add(i);
      for (let k = 0; k < cc.length; k++) for (const j of n4(cc[k])) if (set.has(j) && !seen.has(j)) { seen.add(j); cc.push(j); }
      comps.push(cc);
    }
    comps.sort((a, b) => b.length - a.length);
    comps.forEach((cc, k) => {
      if (k === 0 && cc.length >= 60) planned.push({ id: p.id, cells: cc });
      else if (cc.length < 25 || k === 0) for (const i of cc) fixed[i] = WIESE;
    });
  }
  if (planned.length < 4) return fail('felder');

  // ---- 6. Waldrand über eine Sektorgrenze: Grenzabschnitt suchen, an dem der Rand die Grenze kreuzt
  const segs = [];
  for (let v = 1; v < K; v++) for (let r = 0; r < K; r++) {
    segs.push({ v: true, b: v * SEKTOR, lo: r * SEKTOR, hi: (r + 1) * SEKTOR });
    segs.push({ v: false, b: v * SEKTOR, lo: r * SEKTOR, hi: (r + 1) * SEKTOR });
  }
  const isW = i => fixed[i] === idx('wald') || use[i] === 'wald';
  let forestEdge = null, bestV = 99;
  for (const sg of segs) {
    let both = 0, none = 0, mism = 0, cross = 0, prev = null;
    for (let k = sg.lo; k < sg.hi; k++) {
      const a = isW(sg.v ? k * N + sg.b - 1 : (sg.b - 1) * N + k), b2 = isW(sg.v ? k * N + sg.b : sg.b * N + k);
      if (a !== b2) { mism++; continue; } if (a) both++; else none++;
      if (prev !== null && prev !== a) cross++; prev = a;
    }
    if (both >= 3 && none >= 2 && cross >= 1 && mism < bestV) { bestV = mism; forestEdge = sg; }
  }
  if (!forestEdge) return fail('waldrand');

  // ---- 7. Ecken → Kanten → Flächen
  const W8 = {}, AL = {};
  for (const u of ['wohn', 'acker', 'wald']) { W8[u] = weightsFor(u); AL[u] = [...W8[u].keys()].filter(i => W8[u][i] > 0); }
  const filler = [idx('wiese')];
  const exitAt = new Map(exits.map(e => [e.cell * 4 + e.d, R]));
  const ps = planSectors({
    N, S: SEKTOR, seed: subSeed(seed, 80, attempt), reverse: !!o.reverse, filler,
    tiles: { weights: TILES.map(() => 1), sockets: SOCK2, compat: COMPAT2, border: BORDER_OK },
    weightsAt: (x, y) => W8[use[y * N + x]], allowedAt: (x, y) => AL[use[y * N + x]], fixedAt: (x, y) => fixed[y * N + x],
    mapEdge: (x, y, d) => exitAt.get((y * N + x) * 4 + d) ?? -2,
  });
  const grid = Array.from(ps.grid);
  // Gebäude ohne Straße davor werden zu Gärten (B → G passt zu allen Nachbarn von B)
  let umgewandelt = 0;
  for (let i = 0; i < N * N; i++) {
    const k = TILES[grid[i]].kind;
    if ((k === 'haus' || k === 'laden' || k === 'parkplatz') && !n4(i).some(j => TILES[grid[j]].kind === 'road')) { grid[i] = idx('garten'); umgewandelt++; }
  }
  // Sektortyp = überwiegende Nutzung (nur Anzeige)
  const types = [];
  for (let sy = 0; sy < K; sy++) for (let sx = 0; sx < K; sx++) {
    const cnt = { wohn: 0, acker: 0, wald: 0 };
    for (let y = sy * SEKTOR; y < (sy + 1) * SEKTOR; y++) for (let x = sx * SEKTOR; x < (sx + 1) * SEKTOR; x++) cnt[use[y * N + x]]++;
    types.push(Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0]);
  }
  const spawnCell = land.reduce((b2, x) => Math.hypot(x % N - c[0], ((x / N) | 0) - c[1]) < Math.hypot(b2 % N - c[0], ((b2 / N) | 0) - c[1]) ? x : b2, land[0]);
  return {
    N, S: SEKTOR, K, grid, order: ps.order, types, use: use.map(u => u[0]).join(''), center: c, issues: ps.issues, attempt, umgewandelt,
    pieces: ps.pieces.map(p => ({ kind: p.kind, x0: p.x0, y0: p.y0, x1: p.x1, y1: p.y1, tries: p.tries, filler: p.filler })),
    net: { exits, hof, junction: hofWeg[hofWeg.length - 1], hofWeg, roads: net.parts.filter(p => p.kind === 1).map(p => ({ name: p.name, cells: p.cells })),
      wege: net.parts.filter(p => p.kind === 2).map(p => ({ name: p.name, cells: p.cells })), schleifen },
    fields: planned, parcelOf: Array.from(parcelOf), forestEdge, spawn: { tx: spawnCell % N, ty: (spawnCell / N) | 0 },
  };
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
