// Weltabfragen und Deltas (Abnahme Etappe 1)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, loadAll } from './hilfe.mjs';
import { C, FLAG } from '../engine/core/voxel.js';

/** Testwelt: 2 × 2 Kacheln à 16, Boden überall, eine Wand bei x = 20 (y 4…27), Dach über (2…6, 2…6). */
function testWelt(seed = 1) {
  let gens = 0;
  const w = makeWorld({
    tileSize: 16, tilesX: 2, tilesY: 2, height: 16,
    generate: (tile, vol, { ox, oy, rng }) => {
      gens++;
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const X = ox + x, Y = oy + y;
        vol.set(x, y, 0, C(0x404040 + (rng() * 16 | 0)));
        if (X === 20 && Y >= 4 && Y <= 27) for (let z = 1; z <= 10; z++) vol.set(x, y, z, C(0x808080));
        if (X >= 2 && X <= 6 && Y >= 2 && Y <= 6) vol.set(x, y, 9, C(0x803020), FLAG.ROOF);
      }
    },
  }, seed);
  loadAll(w);
  return { w, gens: () => gens };
}

test('Höhe, Kollision und Wegkarte', () => {
  const { w } = testWelt();
  assert.equal(w.height(20, 10), 11);           // Säule z 1…10 → 11
  assert.equal(w.height(10, 10), 0);
  assert.equal(w.height(4, 4), 0);              // Dach schwebt, keine zusammenhängende Säule ab z = 1
  assert.ok(w.isBlocked(20, 10));
  assert.ok(!w.isBlocked(4, 4), 'Dach blockiert nicht');
  assert.ok(w.pathBlockedAt(19, 10) && w.pathBlockedAt(21, 10), 'Wegkarte ist um 1 verdickt');
  assert.ok(!w.pathBlockedAt(18, 10));
  assert.ok(w.isBlocked(-1, 5), 'außerhalb gilt als blockiert');
});

test('Sichtlinie, Strahl und Bewegung', () => {
  const { w } = testWelt();
  assert.ok(!w.los(15, 10, 25, 10), 'Wand verdeckt');
  assert.ok(w.los(15, 2, 25, 2), 'über der Wand frei');
  assert.ok(w.los(15, 10, 25, 10, 12), 'niedrige Wand zählt nicht, wenn hmin höher ist');
  const t = w.ray(10, 10.5, 1, 0, 50);
  assert.ok(t > 9.5 && t < 10.5, `Strahl trifft bei x = 20 (t = ${t})`);
  const e = { x: 17, y: 10.5 };
  w.move(e, 5, 0, 1.2);
  assert.equal(e.x, 17, 'Bewegung in die Wand wird verhindert');
  w.move(e, 0, 3, 1.2);
  assert.equal(e.y, 13.5, 'Gleiten entlang der Wand');
});

test('Deltas überleben Entladen und Neuerzeugen', () => {
  const { w, gens } = testWelt();
  const before = w.getC(5, 5, 0);
  w.edit(5, 5, 0, 0);                 // Loch in den Boden
  w.edit(20, 10, 3, 0);               // Loch in die Wand (z 3)
  w.edit(8, 8, 4, C(0xff0000));       // neuer Voxel
  w.commit(0, 0, 31, 31);
  assert.equal(w.height(20, 10), 3, 'Säule endet unter dem Loch');
  const t = w.tileOf(0, 0);
  assert.equal(t.rev, 2); assert.equal(w.tileOf(1, 0).rev, 1);
  // Alles entladen (Mitte weit weg), dann neu erzeugen
  const out = w.evict(99, 99, 0);
  assert.equal(out.length, 4);
  assert.equal(w.getC(5, 5, 0), 0, 'nicht geladen → leer');
  w.builder.cache.clear();                     // auch der Cache des Builders ist weg (wie bei einem neuen Worker)
  const g0 = gens();
  loadAll(w);
  assert.equal(gens(), g0 + 4);
  assert.equal(w.getC(5, 5, 0), 0, 'Loch ist wieder da');
  assert.equal(w.getC(8, 8, 4), C(0xff0000), 'neuer Voxel ist wieder da');
  assert.equal(w.getC(20, 10, 3), 0);
  assert.equal(w.getC(5, 6, 0) !== 0, true);
  assert.equal(w.height(20, 10), 3, 'Abfragen werden beim Neuerzeugen aus den Deltas aufgebaut');
  assert.notEqual(before, 0);
});

test('Erzeugung ist deterministisch (Saat, Lage, Version)', () => {
  const a = testWelt(5).w, b = testWelt(5).w, c = testWelt(6).w;
  const sum = w => { let s = 0; for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) s = (s * 31 + w.getC(x, y, 0)) | 0; return s; };
  assert.equal(sum(a), sum(b));
  assert.notEqual(sum(a), sum(c));
});

test('Spielstand: export → import rekonstruiert die Welt, falsche Saat wird abgelehnt', () => {
  const a = testWelt(3).w;
  a.edit(1, 1, 0, 0); a.edit(30, 30, 2, C(0x00ff00)); a.edit(1, 1, 0, C(0x0000ff));   // überschreibt die erste Änderung
  a.commit(0, 0, 31, 31);
  const save = JSON.parse(JSON.stringify(a.exportDeltas()));
  const b = testWelt(3).w;
  b.importDeltas(save);
  assert.equal(b.getC(5, 5, 0), 0, 'Import entlädt betroffene Kacheln');
  loadAll(b);
  for (const [x, y, z] of [[1, 1, 0], [30, 30, 2], [5, 5, 0]]) assert.equal(b.getC(x, y, z), a.getC(x, y, z));
  assert.ok(b.tileOf(0, 0).rev > a.tileOf(0, 0).rev - 1, "Revision mindestens so hoch wie im Spielstand (laufende Aufträge werden ungültig)");
  assert.equal(b.height(30, 30), 0, 'schwebender Voxel bei z 2 ändert die Säule ab z 1 nicht');
  assert.throws(() => testWelt(4).w.importDeltas(save), /passt nicht/);
});

test('Ereignis regionChanged meldet geänderte Bereiche', () => {
  const { w } = testWelt();
  const seen = [];
  w.on('regionChanged', (...r) => seen.push(r));
  w.edit(3, 3, 1, C(1)); w.commit(2, 2, 4, 4);
  assert.deepEqual(seen, [[2, 2, 4, 4]]);
});
