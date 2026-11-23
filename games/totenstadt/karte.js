// Kartenansicht des Weltplans: Kacheln, Netze, Sektorgrenzen und die drei Prüfstellen der Abnahme.
import { weltPlan, hofErreichbar } from './weltplan.js';
import { pruefePlan } from './pruefung.js';
import { TILES } from './city.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
if (params.has('saat')) $('saat').value = params.get('saat');
if (params.has('stuecke')) $('stuecke').checked = true;
const FARBE = { road: '#2a2c31', weg: '#7a6a4a', haus: '#b08a6a', laden: '#5a8ac0', parkplatz: '#3a3c40', garten: '#5a8a3a', park: '#3a6a2a',
  brache: '#5a4e3e', wiese: '#7a9a4a', feld: '#c0a84a', wald: '#1f4a24', hof: '#d06a3a', hecke: '#3e6a2a' };
const NAMEN = { road: 'Straße', weg: 'Wirtschaftsweg', haus: 'Haus', laden: 'Laden', parkplatz: 'Parkplatz', garten: 'Garten', park: 'Park', brache: 'Brache',
  wiese: 'Wiese', feld: 'Feld', wald: 'Wald', hof: 'Hof', hecke: 'Rain mit Hecke' };
const TYP = { wohn: 'Wohngebiet', acker: 'Acker', wald: 'Wald' };
$('leg').innerHTML = Object.keys(FARBE).map(k => `<i style="background:${FARBE[k]}"></i><span>${NAMEN[k]}</span>`).join('');

function draw() {
  const seed = +$('saat').value | 0, cv = $('k'), g = cv.getContext('2d');
  $('spiel').href = `index.html?welt=ortsrand&saat=${seed}`;
  let plan;
  try { plan = weltPlan(seed); } catch (e) { $('info').innerHTML = `<div class="bad">${e.message}</div>`; return; }
  const N = plan.N, C = cv.width / N;
  g.fillStyle = '#000'; g.fillRect(0, 0, cv.width, cv.height);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const t = TILES[plan.grid[y * N + x]];
    g.fillStyle = t.kind === 'road' || t.kind === 'weg' ? (t.kind === 'road' ? '#55606a' : '#6a7a40') : FARBE[t.kind];
    if (t.kind === 'road' || t.kind === 'weg') {
      const base = TILES[plan.grid[y * N + x]].kind === 'road' ? '#55606a' : null;
      g.fillStyle = base || (plan.types[((y / plan.S) | 0) * plan.K + ((x / plan.S) | 0)] === 'wald' ? '#2f5a2a' : '#9a9a50');
      g.fillRect(x * C, y * C, C, C);
      g.fillStyle = FARBE[t.kind]; const m = C / 2, w = t.kind === 'road' ? C * 0.5 : C * 0.28;
      g.fillRect(x * C + m - w / 2, y * C + m - w / 2, w, w);
      if (t.mask & 1) g.fillRect(x * C + m - w / 2, y * C, w, m); if (t.mask & 4) g.fillRect(x * C + m - w / 2, y * C + m, w, m);
      if (t.mask & 8) g.fillRect(x * C, y * C + m - w / 2, m, w); if (t.mask & 2) g.fillRect(x * C + m, y * C + m - w / 2, m, w);
    } else g.fillRect(x * C, y * C, C, C);
    if (t.kind === 'hof') { g.fillStyle = '#fff'; g.fillRect(x * C + C * 0.3, y * C + C * 0.3, C * 0.4, C * 0.4); }
  }
  if ($('stuecke').checked) for (const p of plan.pieces) if (p.kind !== 'flaeche') {
    g.strokeStyle = p.kind === 'ecke' ? '#ff4ad8' : '#4ad8ff'; g.lineWidth = 1;
    g.strokeRect(p.x0 * C + 0.5, p.y0 * C + 0.5, (p.x1 - p.x0) * C - 1, (p.y1 - p.y0) * C - 1);
  }
  if ($('grenzen').checked) {
    g.strokeStyle = '#ffffffcc'; g.lineWidth = 2; g.setLineDash([6, 4]);
    for (let k = 1; k < plan.K; k++) { const v = k * plan.S * C; g.beginPath(); g.moveTo(v, 0); g.lineTo(v, cv.height); g.moveTo(0, v); g.lineTo(cv.width, v); g.stroke(); }
    g.setLineDash([]); g.font = 'bold 12px ui-monospace, monospace'; g.textBaseline = 'top';
    plan.types.forEach((t, s) => {
      const x = (s % plan.K) * plan.S * C + 5, y = ((s / plan.K) | 0) * plan.S * C + 5;
      g.fillStyle = '#000a'; g.fillRect(x - 3, y - 2, g.measureText(TYP[t]).width + 6, 16); g.fillStyle = '#fff'; g.fillText(TYP[t], x, y);
    });
  }
  const r = pruefePlan(plan);
  if ($('pruef').checked) {
    if (r.hofWeg) { g.strokeStyle = '#ffe24a'; g.lineWidth = 3; g.beginPath(); r.hofWeg.forEach((c, k) => { const x = (c % N + 0.5) * C, y = (((c / N) | 0) + 0.5) * C; k ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke(); }
    g.strokeStyle = '#ff8a2a'; g.lineWidth = 2;
    for (const f of plan.fields) for (const c of f.cells) {   // Umriss je Feld
      const x = c % N, y = (c / N) | 0, set = new Set(f.cells);
      g.beginPath();
      if (!set.has(c - N)) { g.moveTo(x * C, y * C); g.lineTo((x + 1) * C, y * C); }
      if (!set.has(c + N)) { g.moveTo(x * C, (y + 1) * C); g.lineTo((x + 1) * C, (y + 1) * C); }
      if (x === 0 || !set.has(c - 1)) { g.moveTo(x * C, y * C); g.lineTo(x * C, (y + 1) * C); }
      if (x === N - 1 || !set.has(c + 1)) { g.moveTo((x + 1) * C, y * C); g.lineTo((x + 1) * C, (y + 1) * C); }
      g.stroke();
    }
    const e = plan.forestEdge; g.strokeStyle = '#4affa0'; g.lineWidth = 4; g.beginPath();
    if (e.v) { g.moveTo(e.b * C, e.lo * C); g.lineTo(e.b * C, e.hi * C); } else { g.moveTo(e.lo * C, e.b * C); g.lineTo(e.hi * C, e.b * C); } g.stroke();
  }
  const cnt = {}; for (const t of plan.grid) cnt[TILES[t].kind] = (cnt[TILES[t].kind] || 0) + 1;
  const ok = (b, s) => `<div class="${b ? 'ok' : 'bad'}">${b ? '✓' : '✗'} ${s}</div>`;
  const pc = k => ((cnt[k] || 0) / N / N * 100).toFixed(0) + ' %';
  $('info').innerHTML = ok(r.hof, `Hofzufahrt über verbundene Äste (${r.hofWeg ? r.hofWeg.length : 0} Zellen, Zufahrt quert ${r.hofGrenzen} Sektorgrenzen)`)
    + ok(r.felder, `${r.felderListe.length} Felder behalten ihre Fläche und sind erschlossen (${r.felderListe.map(f => f.zellen).join(', ')} Zellen; über Sektorgrenzen: ${r.felderListe.filter(f => f.sektoren > 1).length})`)
    + ok(r.gebaeudeOk, `${r.gebaeude} Gebäude an verbundenen Straßen (${r.ohneStrasse} ohne)`)
    + ok(r.sticheOk, `Kurze Abzweigungen: ${r.stiche}, ungeplante Straßenzellen: ${r.ungeplant}`)
    + ok(r.wald, `Waldrand kreuzt eine Sektorgrenze (${r.waldKreuz} Kreuzungen, ${r.waldVersatz} Versatz)`)
    + `<div>Straßen: ${plan.net.roads.map(x => x.name).filter((v, i, a) => a.indexOf(v) === i).map(n => `${plan.net.roads.filter(x => x.name === n).length}× ${n}`).join(', ')}</div>`
    + `<div>Wege: ${plan.net.wege.length} (${plan.net.wege.map(w => w.name).join(', ')})</div>`
    + `<div>Flächen: Feld ${pc('feld')}, Wald ${pc('wald')}, Häuser ${pc('haus')}, Gärten ${pc('garten')}, Straßen ${pc('road')}, Wege ${pc('weg')}, Raine ${pc('hecke')}</div>`
    + `<div>Stücke: ${plan.pieces.length}, Neustarts: ${plan.pieces.reduce((a, p) => a + p.tries - 1, 0)}, mit Füllkacheln: ${plan.pieces.filter(p => p.filler).length}</div>`;
  window.KARTE = { plan, pruefung: r };
}
for (const id of ['saat', 'grenzen', 'stuecke', 'pruef']) $(id).addEventListener('input', draw);
$('neu').addEventListener('click', () => { $('saat').value = (Math.random() * 1e6) | 0; draw(); });
draw();
window.KARTE_READY = true;
