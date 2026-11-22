// Kamera und Backen (DOM-frei)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Camera, Mat2D } from '../engine/render/camera.js';
import { bakeBox, octEnc, octDec, sliceBounds } from '../engine/render/bake.js';
import { Volume, C, E, FLAG } from '../engine/core/voxel.js';

const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;

test('Mat2D: Inverse und Reihenfolge wie DOMMatrix', () => {
  const m = new Mat2D().translate(10, 20).scale(2, 3).rotate(0.7).translate(-5, 4);
  const [x, y] = m.apply(3, -2), [u, v] = m.inverse().apply(x, y);
  assert.ok(near(u, 3) && near(v, -2));
});

test('Freie Kamera: project/unproject sind invers für viele Drehungen und Neigungen', () => {
  for (const yaw of [0, 0.7, 2, 4.4]) for (const deg of [30, 52, 75, 88]) {
    const c = new Camera({ x: 50, y: 60, yaw, pitch: deg * Math.PI / 180, zoom: 7 }); c.setSize(800, 600);
    for (const z of [0, 5, 20]) {
      const [sx, sy] = c.project(57, 41, z), [x, y] = c.unproject(sx, sy, z);
      assert.ok(near(x, 57, 1e-6) && near(y, 41, 1e-6), `yaw ${yaw} pitch ${deg} z ${z}`);
    }
    const [dx, dy] = c.dirToWorld(0, -1);
    assert.ok(near(Math.hypot(dx, dy), 1));
  }
});

test('Tiefe nur aus z ist korrekt: an derselben Bildschirmstelle hat das vordere Objekt das größere z', () => {
  for (const deg of [30, 52, 80]) {
    const c = new Camera({ yaw: 1.1, pitch: deg * Math.PI / 180, zoom: 6 }); c.setSize(800, 600);
    // Zwei Punkte an derselben Bildschirmstelle: einer weiter hinten (oben auf dem Bild) und höher
    const [sx, sy] = c.project(10, 10, 0);
    const back = c.unproject(sx, sy, 8), front = c.unproject(sx, sy, 2);
    // "vorn" = näher an der Kamera = größeres Boden-sy
    const syBack = c.M.apply(...back)[1], syFront = c.M.apply(...front)[1];
    assert.ok(syBack > syFront, 'der höhere Punkt liegt am Boden weiter vorn');
  }
});

test('Oktaeder-Normalen: Kodieren und Dekodieren', () => {
  for (const n of [[0, 0, 1], [1, 0, 0], [0, -1, 0], [0.5, 0.5, -0.7], [-0.3, 0.8, 0.2]]) {
    const l = Math.hypot(...n), v = n.map(a => a / l), d = octDec(...octEnc(...v));
    assert.ok(v[0] * d[0] + v[1] * d[1] + v[2] * d[2] > 0.995, JSON.stringify(n));
  }
});

test('Backen: Belegung, Flags, Leuchten, Verdeckung, Schatten', () => {
  const v = new Volume(8, 8, 8);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) v.set(x, y, 0, C(0x204060));
  v.set(4, 4, 1, C(0xff0000), FLAG.ROOF); v.set(4, 4, 2, E(0x00ff00), FLAG.WALLTOP);
  for (let z = 1; z < 8; z++) v.set(1, 4, z, C(0x888888));            // Säule, wirft Schatten
  const n = 8 * 8 * 8 * 4, A = new Uint8Array(n), B = new Uint8Array(n);
  bakeBox((x, y, z) => v.get(x, y, z), (x, y, z) => v.getLay(x, y, z), 0, 0, 8, 8, 8, true, A, B, [0, 0, 1]);
  const q = (x, y, z) => ((z * 8 + y) * 8 + x) * 4;
  assert.equal(A[q(4, 4, 1) + 3], 255); assert.equal(A[q(4, 4, 3) + 3], 0);
  assert.deepEqual([...A.subarray(q(4, 4, 1), q(4, 4, 1) + 3)], [255, 0, 0]);
  assert.equal(B[q(4, 4, 1) + 3], 1, 'Dach-Flag'); assert.equal(B[q(4, 4, 2) + 3], 2 | 4, 'Wand-Flag und Leuchten');
  const ao = (x, y, z) => B[q(x, y, z) + 2] & 127;
  assert.ok(ao(6, 6, 0) > ao(2, 4, 0), 'Boden neben der Säule ist stärker verdeckt');
  assert.equal(B[q(6, 6, 0) + 2] >> 7, 1, 'freier Boden im Licht');
  assert.equal(B[q(4, 4, 0) + 2] >> 7, 0, 'Boden unter dem Würfelturm im Schatten');
  const bb = sliceBounds(v.col, 8, 8, 8);
  assert.deepEqual([...bb.subarray(0, 4)], [0, 0, 7, 7]); assert.deepEqual([...bb.subarray(4, 8)], [1, 4, 4, 4]); assert.equal(bb[7 * 4], 1);
});
