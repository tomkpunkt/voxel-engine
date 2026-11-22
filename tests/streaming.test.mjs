// Streaming: Revisionen, Fenster, Entladen, Paletten-Volumen
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../engine/world/world.js';
import { Streamer, LocalBackend } from '../engine/stream/streamer.js';
import { Volume, C } from '../engine/core/voxel.js';

const GEN = {
  tileSize: 16, tilesX: 8, tilesY: 8, height: 8,
  generate: (t, vol, { ox, oy }) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { vol.set(x, y, 0, C(0x101010 + ((ox + oy) & 255))); if ((x + y) % 7 === 0) vol.set(x, y, 1, C(0x808080)); } },
};
function setup() {
  const w = new World({ tileSize: 16, tilesX: 8, tilesY: 8, height: 8, seed: 9 });
  const backend = new LocalBackend(GEN, 9);
  w.builder = backend.builder;
  return { w, s: new Streamer(w, null, { backend, radius: 1, keep: 2 }) };
}

test('Fenster laden, beim Wandern entladen, Speicher bleibt begrenzt', () => {
  const { w, s } = setup();
  s.update(40, 40); s.run(1e9);
  assert.equal(s.pending, 0);
  const loaded = () => [...w.tiles.values()].filter(t => t.vol).length;
  assert.equal(loaded(), 9);
  for (let x = 40; x < 120; x += 8) { s.update(x, 40); s.run(1e9); }
  assert.ok(loaded() <= 25, `höchstens (2·keep+1)² geladen, sind ${loaded()}`);
  assert.equal(w.tileOf(1, 2).vol, null, 'weit hinten entladen');
  assert.ok(w.bytes() < 25 * (16 * 16 * 8 * 2 + 4000));
});

test('Ergebnis mit veralteter Revision wird verworfen und neu beauftragt', () => {
  const { w, s } = setup();
  const req = w.request(3, 3, { entities: true });
  const old = s.backend.buildSync(req);
  w.edit(50, 50, 2, C(0xff0000));                  // Kachel (3, 3) ändert sich, während der Auftrag „läuft“
  s.receive(old);
  assert.equal(s.stats.stale, 1);
  assert.equal(w.tileOf(3, 3).vol, null, 'altes Ergebnis nicht übernommen');
  s.update(50, 50); s.run(1e9);
  assert.equal(w.getC(50, 50, 2), C(0xff0000), 'neues Ergebnis enthält die Änderung');
});

test('Paletten-Volumen: 2 Byte pro Voxel, Packen und Entpacken, Überlauf vergröbert statt zu scheitern', () => {
  const v = new Volume(64, 64, 32), N = 64 * 64 * 32;   // 131 072 verschiedene Farben: Palette läuft über
  for (let i = 0; i < N; i++) v.setAt(i, C(i * 97 & 0xffffff), i & 3);
  assert.equal(v.data.BYTES_PER_ELEMENT, 2);
  assert.ok(v.n <= 65535);
  const u = Volume.unpack(v.pack());
  for (const i of [0, 5, 1000, 32767, N - 1]) { assert.equal(u.colAt(i), v.colAt(i)); assert.equal(u.layAt(i), v.layAt(i)); }
  u.set(1, 1, 1, v.colAt(7), v.layAt(7)); assert.equal(u.get(1, 1, 1), v.colAt(7)); assert.equal(u.getLay(1, 1, 1), v.layAt(7));
  const exact = [...Array(N).keys()].filter(i => v.colAt(i) === C(i * 97 & 0xffffff)).length;
  assert.ok(exact >= 63999, 'die ersten 64 000 Farben bleiben exakt');
  const fine = new Volume(8, 8, 8); fine.set(1, 1, 1, C(0x123456), 2); assert.equal(fine.get(1, 1, 1), C(0x123456));
});
