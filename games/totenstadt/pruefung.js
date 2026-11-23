// Abnahme-Prüfungen für einen Weltplan (Node-Test und Kartenansicht).
import { TILES } from './city.js';
import { hofErreichbar } from './weltplan.js';
import { DIRS } from '../../engine/gen/wfc.js';

/**
 * Prüft den fertigen Kachelplan:
 *  - hof:       Kartenausgang der Landstraße → Hof über tatsächlich verbundene Straßen- und Wegäste; die Zufahrt
 *               (ab der Landstraße) quert mindestens eine Sektorgrenze
 *  - felder:    jedes geplante Feld behält seine reservierte Fläche (alle Zellen Feld, zusammenhängend), ist über
 *               einen Weg oder eine Straße erschlossen, die mit dem Netz verbunden ist; mindestens 4 Felder,
 *               mindestens eines über eine Sektorgrenze
 *  - gebaeude:  jedes Haus, jeder Laden, jeder Parkplatz liegt an einer Straße, die mit dem Netz verbunden ist
 *  - stiche:    Zahl kurzer Abzweigungen (Sackgasse von höchstens einer Zelle an einer Kreuzung) und ungeplanter
 *               Straßenzellen – beide sollen 0 sein
 *  - wald:      an einem Grenzabschnitt kreuzt der Waldrand die Sektorgrenze, ohne zu springen
 */
export function pruefePlan(plan) {
  const { N, S, grid } = plan, T = i => TILES[grid[i]], kind = (x, y) => T(y * N + x).kind;
  const sec = c => `${((c % N) / S) | 0},${((c / N / S) | 0)}`;
  const n4 = i => { const x = i % N, y = (i / N) | 0, r = []; for (const [dx, dy] of DIRS) if (x + dx >= 0 && y + dy >= 0 && x + dx < N && y + dy < N) r.push((y + dy) * N + x + dx); return r; };
  // Netz-Erreichbarkeit über passende Äste von den Kartenausgängen
  const NETK = ['road', 'weg', 'hof'], reach = new Uint8Array(N * N), q = plan.net.exits.map(e => e.cell);
  for (const s of q) reach[s] = 1;
  for (let k = 0; k < q.length; k++) {
    const i = q[k], t = T(i);
    for (let d = 0; d < 4; d++) if (t.mask >> d & 1) {
      const x = i % N + DIRS[d][0], y = ((i / N) | 0) + DIRS[d][1];
      if (x < 0 || y < 0 || x >= N || y >= N) continue;
      const j = y * N + x, u = T(j);
      if (!reach[j] && NETK.includes(u.kind) && (u.mask >> ((d + 2) % 4) & 1)) { reach[j] = 1; q.push(j); }
    }
  }
  // Hof
  const hofWeg = hofErreichbar(plan);
  // Zufahrt = Abschnitt ab der letzten Straßenzelle (Wirtschaftswege bis zum Hof)
  let lastRoad = -1; if (hofWeg) hofWeg.forEach((c, k) => { if (T(c).kind === 'road') lastRoad = k; });
  const zuf = hofWeg ? hofWeg.slice(Math.max(0, lastRoad)) : [];
  const hofGrenzen = zuf.reduce((a, c, k) => a + (k && sec(c) !== sec(zuf[k - 1]) ? 1 : 0), 0);
  // Felder
  const felder = plan.fields.map(f => {
    const set = new Set(f.cells), behalten = f.cells.every(i => T(i).kind === 'feld');
    const seen = new Set([f.cells[0]]), qq = [f.cells[0]];
    for (let k = 0; k < qq.length; k++) for (const j of n4(qq[k])) if (set.has(j) && !seen.has(j)) { seen.add(j); qq.push(j); }
    const zusammen = seen.size === f.cells.length;
    // erschlossen: an das Feldstück (inkl. Saum/Rain derselben Parzelle) grenzt ein verbundener Weg oder eine Straße
    const parcel = []; for (let i = 0; i < N * N; i++) if (plan.parcelOf[i] === f.id) parcel.push(i);
    const erschlossen = parcel.some(i => n4(i).some(j => reach[j] && (T(j).kind === 'weg' || T(j).kind === 'road')));
    const sektoren = new Set(f.cells.map(sec)).size;
    return { id: f.id, zellen: f.cells.length, behalten, zusammen, erschlossen, sektoren };
  });
  const felderOk = felder.length >= 4 && felder.every(f => f.behalten && f.zusammen && f.erschlossen) && felder.some(f => f.sektoren >= 2);
  // Gebäude
  let gebaeude = 0, ohneStrasse = 0;
  for (let i = 0; i < N * N; i++) if (['haus', 'laden', 'parkplatz'].includes(T(i).kind)) {
    gebaeude++;
    if (!n4(i).some(j => T(j).kind === 'road' && reach[j])) ohneStrasse++;
  }
  // kurze Abzweigungen und ungeplante Straßen
  const geplant = new Set(); for (const r of plan.net.roads) for (const c of r.cells) geplant.add(c);
  let stiche = 0, ungeplant = 0;
  for (let i = 0; i < N * N; i++) {
    const t = T(i); if (t.kind !== 'road') continue;
    if (!geplant.has(i)) ungeplant++;
    if (t.deg === 1 && !plan.net.exits.some(e => e.cell === i)) {
      const d = [0, 1, 2, 3].find(k => t.mask >> k & 1), j = (((i / N) | 0) + DIRS[d][1]) * N + i % N + DIRS[d][0];
      if (T(j).deg >= 3) stiche++;
    }
  }
  // Waldrand
  const e = plan.forestEdge;
  let waldKreuz = 0, waldVersatz = 0, prev = null, wald1 = 0, frei = 0;
  for (let k = e.lo; k < e.hi; k++) {
    const a = e.v ? kind(e.b - 1, k) === 'wald' : kind(k, e.b - 1) === 'wald', b = e.v ? kind(e.b, k) === 'wald' : kind(k, e.b) === 'wald';
    if (a !== b) { waldVersatz++; continue; }
    if (a) wald1++; else frei++;
    if (prev !== null && prev !== a) waldKreuz++;
    prev = a;
  }
  const wald = waldKreuz >= 1 && wald1 >= 2 && frei >= 2 && waldVersatz <= 3;
  return {
    hof: !!hofWeg && hofGrenzen >= 1, hofWeg, hofGrenzen,
    felder: felderOk, felderListe: felder,
    gebaeudeOk: ohneStrasse === 0, gebaeude, ohneStrasse,
    sticheOk: stiche === 0 && ungeplant === 0, stiche, ungeplant,
    wald, waldKreuz, waldVersatz,
  };
}
