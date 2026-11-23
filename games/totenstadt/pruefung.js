// Abnahme-Prüfungen für einen Weltplan (Node-Test und Kartenansicht).
import { TILES } from './city.js';
import { hofErreichbar } from './weltplan.js';

/**
 * Prüft die drei Übergänge über Sektorgrenzen am fertigen Kachelraster:
 *  - Hofzufahrt: vom Kartenausgang der Landstraße bis zum Hof über tatsächlich verbundene Straßen- und Wegäste,
 *    mindestens eine Sektorgrenze unterwegs
 *  - Feld: das reservierte Feld ist ein zusammenhängendes Stück Acker auf beiden Seiten seiner Sektorgrenze
 *  - Waldrand: an der gewählten Wald-Wald-Grenze kreuzt der Rand die Grenze, ohne zu springen
 */
export function pruefePlan(plan) {
  const { N, S, grid } = plan, kind = (x, y) => TILES[grid[y * N + x]].kind, sec = c => `${((c % N) / S) | 0},${((c / N / S) | 0)}`;
  // Hof
  const hofWeg = hofErreichbar(plan);
  let hofGrenzen = 0;
  if (hofWeg) for (let k = 1; k < hofWeg.length; k++) if (sec(hofWeg[k]) !== sec(hofWeg[k - 1])) hofGrenzen++;
  const hofTeil = hofWeg ? hofWeg.slice(hofWeg.lastIndexOf(plan.net.junction)) : [];
  const hofGrenzenZufahrt = hofTeil.reduce((a, c, k) => a + (k && sec(c) !== sec(hofTeil[k - 1]) ? 1 : 0), 0);
  // Feld
  const f = plan.field;
  let alle = true;
  for (let y = f.y0; y < f.y1; y++) for (let x = f.x0; x < f.x1; x++) if (kind(x, y) !== 'feld') alle = false;
  const seen = new Set([f.y0 * N + f.x0]), q = [f.y0 * N + f.x0];
  for (let k = 0; k < q.length; k++) {
    const c = q[k], x = c % N, y = (c / N) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, j = ny * N + nx;
      if (nx < 0 || ny < 0 || nx >= N || ny >= N || seen.has(j) || kind(nx, ny) !== 'feld') continue;
      seen.add(j); q.push(j);
    }
  }
  const seiten = new Set([...seen].map(sec));
  const feld = alle && seiten.size >= 2;
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
  return { hof: !!hofWeg && hofGrenzenZufahrt >= 1, hofWeg, hofGrenzen: hofGrenzenZufahrt, feld, feldZellen: seen.size, wald, waldKreuz, waldVersatz };
}
