// Etappe 4: Spielstand rekonstruiert die Welt aus Saat, Generatorversion, Zustand und Deltas (grob und fein)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, loadAll } from './hilfe.mjs';
import { C } from '../engine/core/voxel.js';
import { carve } from '../engine/destruct/destruct.js';
import { binLights, lightDir, skyAt } from '../engine/light/light.js';
import { Camera } from '../engine/render/camera.js';

const GEN = {
  tileSize: 16, tilesX: 2, tilesY: 2, height: 12, sub: 4, version: 3,
  generate: (t, vol, { ox, oy, rng, state }) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      vol.set(x, y, 0, C(0x303030 + (rng() * 40 | 0)));
      if ((ox + x) % 9 === 4) for (let z = 1; z <= 6; z++) vol.set(x, y, z, C(0x907050));
    }
    if (state && state.flag) vol.set(1, 1, 8, C(0xff00ff));     // Spielzustand ändert Voxel
  },
};
const all = w => { let s = 0; for (let fz = 0; fz < 12 * 4; fz++) for (let fy = 0; fy < 32 * 4; fy++) for (let fx = 0; fx < 32 * 4; fx++) s = (s * 31 + w.getFine(fx, fy, fz)) | 0; return s; };

test('Laden rekonstruiert die beschädigte Welt exakt (grob, fein, Zustand)', () => {
  const a = loadAll(makeWorld(GEN, 42));
  carve(a, 13.2, 7.7, 3.3, 2.1);                         // fein angeschnittene Wand
  a.edit(20, 20, 5, C(0x00ff00)); a.commit(19, 19, 21, 21);
  const t = a.tileOf(0, 0); t.state = { flag: true }; a.touch(t);
  a.evict(-9, -9, 0); a.builder.cache.clear(); loadAll(a);    // Zustand wird beim Neuerzeugen angewandt
  const save = JSON.parse(JSON.stringify(a.exportDeltas()));
  const b = makeWorld(GEN, 42); b.importDeltas(save); loadAll(b);
  assert.equal(all(b), all(a), 'alle feinen Voxel gleich');
  assert.equal(b.getC(1, 1, 8), C(0xff00ff));
  const fresh = loadAll(makeWorld(GEN, 42));
  assert.notEqual(all(fresh), all(a), 'ohne Spielstand anders');
  assert.throws(() => makeWorld({ ...GEN, version: 4 }, 42).importDeltas(save), /Generatorversion/);
});

test('Lichter auf Bildschirmkacheln: jedes Licht landet in den Kacheln, die es abdeckt', () => {
  const cam = new Camera({ x: 50, y: 50, zoom: 4, yaw: 0.5, pitch: 0.9 }); cam.setSize(320, 240);
  const L = [{ x: 50, y: 50, z: 5, r: 6 }, { x: 500, y: 500, z: 5, r: 4 }, { x: 40, y: 60, z: 5, r: 30 }];
  const b = binLights(L, cam, 320, 240, 20, 16, 8);
  const inTile = (i, c, r) => { const k = r * b.cols + c, o = b.header[k * 4], n = b.header[k * 4 + 1]; return [...b.list.slice(o, o + n)].includes(i); };
  const [sx, sy] = cam.project(50, 50, 5);
  assert.ok(inTile(0, Math.floor(sx / 16), Math.floor((240 - sy) / 16)), 'Licht 0 in seiner Kachel');
  let any1 = false; for (let r = 0; r < b.rows; r++) for (let c = 0; c < b.cols; c++) if (inTile(1, c, r)) any1 = true;
  assert.ok(!any1, 'Licht außerhalb des Bildes in keiner Kachel');
  assert.equal(b.dropped, 0);
});

test('Sonnenstand: Osten morgens, Süden mittags, Westen abends, nachts Mond', () => {
  const m = lightDir(8), n = lightDir(12), a = lightDir(17), night = lightDir(1);
  assert.ok(m[0] > 0.3 && n[1] > 0.3 && a[0] < -0.3, JSON.stringify([m, n, a]));
  assert.ok(n[2] > m[2] && n[2] > a[2], 'mittags am höchsten');
  assert.ok(night[2] > 0.6 && skyAt(1).night > 0.9 && skyAt(12).night < 0.1);
});
