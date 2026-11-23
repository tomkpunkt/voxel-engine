// Etappe 5: Weltplaner (Flächen und Netze vor WFC, Ecken → Kanten → Flächen), alter Stadtplan unverändert
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wfcRegion } from '../engine/gen/wfc.js';
import { sectorPieces, planSectors } from '../engine/gen/sektoren.js';
import { weltPlan } from '../games/totenstadt/weltplan.js';
import { pruefePlan } from '../games/totenstadt/pruefung.js';
import { createCity } from '../games/totenstadt/stadt.js';
import { fingerprintV4 } from './fingerabdruck-v4.mjs';

const SAATEN = [1, 2, 3, 7, 8, 9, 99, 4711];

test('alter Stadtplan (Generator v4) bleibt bitgleich – alte Spielstände passen weiter', () => {
  assert.deepEqual([1, 4711, 99].map(fingerprintV4), [1304136516, 3746148592, 3549988209]);
});

test('Sektorstücke decken jede Zelle genau einmal ab (Ecken 4 × 4)', () => {
  const { stages } = sectorPieces(64, 16), c = new Int32Array(64 * 64);
  for (const st of stages) for (const p of st) for (let y = p.y0; y < p.y1; y++) for (let x = p.x0; x < p.x1; x++) if (!p.has || p.has(x, y)) c[y * 64 + x]++;
  assert.equal(Math.min(...c), 1); assert.equal(Math.max(...c), 1);
});

test('Rand-Prüfung: unvereinbare Vorgaben an einer Zelle werden als „rand“ gemeldet', () => {
  // zwei Kacheln: 0 hat überall Sockel 0, 1 überall Sockel 1; 0 passt nur zu 0, 1 nur zu 1
  const o = { weights: [1, 1], sockets: [[0, 0, 0, 0], [1, 1, 1, 1]], compat: [[1, 0], [0, 1]] };
  const r = wfcRegion(1, 1, Math.random, { ...o, outside: (x, y, d) => d === 0 ? 0 : d === 2 ? 1 : -1 });
  assert.equal(r.error, 'rand');
  assert.deepEqual(r.need.slice(0, 3), [0, -1, 1]);
});

test('Sektorplan ist unabhängig von der Reihenfolge der Stücke', () => {
  const o = { N: 32, S: 16, seed: 5, tiles: { weights: [1, 1], sockets: [[0, 0, 0, 0], [1, 1, 1, 1]], compat: [[1, 1], [1, 1]] },
    allowedAt: () => [0, 1], fixedAt: () => -1 };
  assert.deepEqual(Array.from(planSectors(o).grid), Array.from(planSectors({ ...o, reverse: true }).grid));
});

for (const seed of SAATEN) test(`Weltplan Saat ${seed}: Hofzufahrt, Felder, Gebäude, Straßennetz, Waldrand`, () => {
  const p = weltPlan(seed), r = pruefePlan(p);
  assert.ok(r.hof, `Hof über verbundene Äste erreichbar, Zufahrt über Sektorgrenze (${r.hofGrenzen})`);
  assert.ok(r.felder, `Felder: ${JSON.stringify(r.felderListe)}`);
  assert.ok(r.gebaeudeOk, `${r.ohneStrasse} von ${r.gebaeude} Gebäuden ohne verbundene Straße`);
  assert.ok(r.sticheOk, `kurze Abzweigungen ${r.stiche}, ungeplante Straßenzellen ${r.ungeplant}`);
  assert.ok(r.wald, `Waldrand: ${r.waldKreuz} Kreuzungen, ${r.waldVersatz} Versatz`);
  assert.equal(p.pieces.filter(x => x.filler).length, 0, 'ohne Füllkacheln');
  assert.equal(p.issues.length, 0, 'keine unvereinbaren Randvorgaben');
});

test('Weltplan: Sektoren in umgekehrter Reihenfolge erzeugen ergibt denselben Plan', () => {
  assert.deepEqual(weltPlan(4711, { reverse: true }).grid, weltPlan(4711).grid);
});

test('Generatorversion getrennt vom Speicherformat: Stadt v4, Weltplan v5, Deltas nur zur eigenen Version', () => {
  const stadt = createCity(4711, { workers: false }), welt = createCity(4711, { workers: false, welt: { setting: 'suburban', biom: 'gemaessigt' } });
  assert.equal(stadt.world.version, 4); assert.equal(welt.world.version, 5);
  const t = welt.world;
  t.ensure(welt.plan.spawn.tx, welt.plan.spawn.ty);
  const ex = t.exportDeltas();
  assert.throws(() => stadt.world.importDeltas(ex), 'Deltas einer v5-Welt passen nicht in die v4-Stadt');
  createCity(4711, { workers: false, welt: { setting: 'suburban', biom: 'gemaessigt' } }).world.importDeltas(ex);
  assert.throws(() => weltPlan(1, { setting: 'urban' }), /noch nicht ausgearbeitet/);
});
