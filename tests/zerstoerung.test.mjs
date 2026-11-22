// Etappe 3: Unterteilung, Zerstörung über Kachelgrenzen, Tragfähigkeit, Block-Partikel
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, loadAll } from './hilfe.mjs';
import { C } from '../engine/core/voxel.js';
import { carve, checkSupport, shatter, drop } from '../engine/destruct/destruct.js';
import { Debris } from '../engine/destruct/debris.js';

/** 2 × 1 Kacheln à 16, Boden, Wand quer über die Kachelgrenze bei y = 8 (x 10…21), Unterteilung S. */
function wandWelt(S = 4) {
  return loadAll(makeWorld({
    tileSize: 16, tilesX: 2, tilesY: 1, height: 16, sub: S,
    generate: (t, vol, { ox }) => {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        vol.set(x, y, 0, C(0x404040));
        const X = ox + x;
        if (y === 8 && X >= 10 && X <= 21) for (let z = 1; z <= 10; z++) vol.set(x, y, z, C(0xa0a0a0));
      }
    },
  }));
}

test('Feine Blöcke: Teilen, Stellvertreter, Deltas überleben Entladen', () => {
  const w = wandWelt(4);
  assert.equal(w.getFine(12 * 4 + 1, 8 * 4 + 1, 5 * 4 + 1), C(0xa0a0a0), 'ungeteilter Block gilt fein überall');
  w.editFine(12 * 4, 8 * 4, 5 * 4, 0); w.commit(11, 7, 13, 9);
  const t = w.tileAt(12, 8), i = (5 * 16 + 8) * 16 + 12;
  assert.ok(t.vol.bricks.has(i)); assert.ok(w.getL(12, 8, 5) & 4, 'Stellvertreter trägt SUB');
  assert.equal(w.getFine(12 * 4, 8 * 4, 5 * 4), 0); assert.equal(w.getFine(12 * 4 + 1, 8 * 4, 5 * 4), C(0xa0a0a0));
  assert.ok(w.isBlocked(12, 8), 'zu mehr als der Hälfte gefüllt: blockiert weiter');
  for (let k = 0; k < 40; k++) w.editFine(12 * 4 + k % 4, 8 * 4 + ((k >> 2) % 4), 5 * 4 + (k >> 4), 0);
  assert.equal(w.getC(12, 8, 5), 0, 'weniger als halb gefüllt: grob leer');
  w.evict(-9, -9, 0); w.builder.cache.clear(); loadAll(w);
  assert.equal(w.getFine(12 * 4, 8 * 4, 5 * 4), 0, 'feine Änderung nach Neuerzeugen da');
  assert.equal(w.getFine(12 * 4 + 3, 8 * 4 + 3, 5 * 4 + 3), C(0xa0a0a0));
  const save = JSON.parse(JSON.stringify(w.exportDeltas()));
  assert.ok(save.tiles[0].b.length >= 1, 'Bricks im Spielstand');
});

test('Durchbruch an der Kachelgrenze aktualisiert Kollision, Höhe und Sicht in beiden Kacheln', () => {
  const w = wandWelt(4), events = [];
  w.on('regionChanged', (...r) => events.push(r));
  assert.ok(!w.los(16, 4, 16, 12) && w.isBlocked(15, 8) && w.isBlocked(16, 8));
  const { removed } = carve(w, 16, 8.5, 4, 4.6);   // Loch vom Boden bis über Kopfhöhe (Kollision zählt z 1…7)
  assert.ok(removed.length > 0);
  assert.ok(!w.isBlocked(15, 8) && !w.isBlocked(16, 8), 'Loch auf beiden Seiten der Grenze begehbar');
  assert.equal(w.height(15, 8), 0); assert.equal(w.height(16, 8), 0);
  assert.ok(w.los(16, 4, 16, 12, 5), 'Sicht durch das Loch');
  assert.ok(events.some(([x0, , x1]) => x0 <= 15 && x1 >= 16), 'ein Ereignis überspannt die Grenze (Renderer backt beide Kacheln neu)');
  assert.ok(removed.some(p => p.size === 0.25), 'Ränder fein ausgeschnitten');
  assert.ok(w.tileAt(13, 8).vol.bricks.size + w.tileAt(18, 8).vol.bricks.size > 0, 'angeschnittene Blöcke sind unterteilt');
});

function dachWelt() {
  // Boden, eine Stütze (x 16, y 16, z 1…9), darauf eine Platte (z 10, x 10…22, y 10…22)
  return loadAll(makeWorld({
    tileSize: 32, tilesX: 1, tilesY: 1, height: 16, sub: 2,
    generate: (t, vol) => {
      for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) vol.set(x, y, 0, C(0x303030));
      for (let z = 1; z <= 9; z++) vol.set(16, 16, z, C(0x806040));
      for (let y = 10; y <= 22; y++) for (let x = 10; x <= 22; x++) vol.set(x, y, 10, C(0x603020));
    },
  }));
}

test('Tragfähigkeit: Dach mit intakter Stütze bleibt, ohne Stütze fällt es', () => {
  const w = dachWelt();
  let r = checkSupport(w, 6, 6, 26, 26);
  assert.equal(r.detached.length, 0, 'intakt: nichts lose');
  assert.equal(w.getC(12, 12, 10), C(0x603020));
  carve(w, 16.5, 16.5, 5.5, 1.2);                  // Stütze in der Mitte durchschlagen
  r = checkSupport(w, 6, 6, 26, 26);
  assert.equal(r.components, 1, 'eine lose Gruppe (Platte + oberer Stützenteil)');
  assert.ok(r.detached.length >= 169, `Platte gelöst (${r.detached.length} Blöcke)`);
  assert.equal(w.getC(12, 12, 10), 0, 'Platte entfernt');
  assert.equal(w.getC(16, 16, 2), C(0x806040), 'unterer Stützenteil steht noch');
});

test('Block-Partikel: fallen, prallen, verschwinden oder bleiben als feine Blöcke liegen', () => {
  const w = dachWelt(), d = new Debris(w);
  const a = d.emit({ x: 5.5, y: 5.5, z: 8, vx: 2, size: 0.5, color: 0xff0000, settle: true });
  const b = d.emit({ x: 25.5, y: 25.5, z: 8, size: 0.5, color: 0x00ff00, settle: false, life: 1 });
  for (let k = 0; k < 300; k++) { d.update(1 / 60); d.commit(); }
  assert.equal(d.list.length, 0, 'beide weg aus der Liste');
  assert.equal(d.stats.settled, 1); assert.equal(d.stats.faded, 1);
  // liegen gebliebener Block: irgendwo auf z = 1 rechts von x = 5
  let found = null;
  for (let fy = 8; fy < 16; fy++) for (let fx = 10; fx < 40; fx++) if (w.getFine(fx, fy, 2) === (0xff0000 | 0x1000000)) found = [fx, fy];
  assert.ok(found, 'roter feiner Block liegt auf dem Boden (feine Ebene z = 2 = Block-z 1)');
  assert.equal(w.getFine(51, 51, 2), 0, 'grüner verschwunden, nichts geschrieben');
  assert.ok(a.x > 5.5, 'Bewegung in x');
  // Emitter mit Dauer
  const e = d.emitter({ x: 16, y: 16, z: 12, rate: 100, duration: 0.5, colors: [0x123456], speed: [1, 2], life: [0.2, 0.3] });
  for (let k = 0; k < 120; k++) d.update(1 / 60);
  assert.ok(e.done && d.stats.emitted > 40, `Emitter lief und endete (${d.stats.emitted})`);
  shatter(d, [{ x: 16, y: 16, z: 3, size: 0.5, color: 0xabcdef }], { settle: false });
  assert.equal(d.list.at(-1).color, 0xabcdef);
});

test('Große lose Gruppe fällt als Ganzes, bis sie aufliegt', () => {
  const w = dachWelt();
  carve(w, 16.5, 16.5, 5.5, 1.2);
  const r = checkSupport(w, 6, 6, 26, 26);
  const { fall } = drop(w, r.groups[0]);
  assert.ok(fall >= 1, `Fallhöhe ${fall}`);
  assert.equal(w.getC(12, 12, 10), 0);
  assert.equal(w.getC(12, 12, 10 - fall), C(0x603020), 'Platte als Ganzes tiefer: der obere Stützenrest sitzt jetzt auf dem unteren');
  assert.equal(checkSupport(w, 6, 6, 26, 26).detached.length, 0, 'danach stabil');
});
