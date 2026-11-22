// Generierung (WFC, Grundriss), Flow Field und ECS
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wfc, DIRS } from '../engine/gen/wfc.js';
import { planRooms } from '../engine/gen/floorplan.js';
import { FlowField } from '../engine/ecs/flowfield.js';
import { ECS, movementSystem } from '../engine/ecs/ecs.js';
import { World } from '../engine/world/world.js';
import { mulberry32 } from '../engine/core/rand.js';
import { C } from '../engine/core/voxel.js';
import { cityPlan, TILES, SOCK, SJ, SF } from '../games/totenstadt/city.js';

test('WFC mit Sockeln: Totenstadt-Pläne ohne Kreuzung an Kreuzung und ohne Doppelstraße', () => {
  for (let s = 1; s <= 30; s++) {
    const r = cityPlan(s), n = 12;
    assert.ok(r, `Saat ${s}`);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) for (let d = 0; d < 4; d++) {
      const nx = x + DIRS[d][0], ny = y + DIRS[d][1];
      const a = SOCK[r.grid[y * n + x]][d];
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) { assert.ok(a >= SF, 'keine Straße aus der Karte'); continue; }
      const b = SOCK[r.grid[ny * n + nx]][(d + 2) % 4];
      assert.ok(!(a === SJ && b === SJ) && !(a === SF && b === SF));
      assert.equal(TILES[r.grid[y * n + x]].mask >> d & 1, TILES[r.grid[ny * n + nx]].mask >> ((d + 2) % 4) & 1, 'Straßen setzen sich fort');
    }
  }
});

test('WFC allgemein: unverträgliche Sockel führen zu null', () => {
  const r = wfc(4, mulberry32(1), { weights: [1, 1], sockets: [[0, 0, 0, 0], [1, 1, 1, 1]], compat: [[0, 0], [0, 0]] });
  assert.equal(r, null);
  const ok = wfc(4, mulberry32(1), { weights: [1, 1], sockets: [[0, 0, 0, 0], [0, 0, 0, 0]], compat: [[1]] });
  assert.equal(ok.grid.length, 16); assert.equal(ok.order.length, 16);
});

test('Grundriss: jedes Zimmer über Türen erreichbar, Haustür an der Straßenseite', () => {
  for (let s = 1; s <= 200; s++) {
    const rng = mulberry32(s), w = 42 + 2 * (s % 8), d = 42 + 2 * ((s >> 3) % 8), front = s % 4;
    const p = planRooms(rng, w, d, front, { min: 12, doorW: 5, windowW: 6, bigWindowW: 10 });
    const g = new Uint8Array(w * d);
    for (const r of p.rooms) for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) if (x === r.x0 || x === r.x1 || y === r.y0 || y === r.y1) g[y * w + x] = 1;
    for (const dr of p.doors) for (let k = 0; k < 5; k++) g[(dr.v ? dr.y + k : dr.y) * w + (dr.v ? dr.x : dr.x + k)] = 0;
    const seen = new Uint8Array(w * d), st = [[p.rooms[0].x0 + 1, p.rooms[0].y0 + 1]]; seen[st[0][1] * w + st[0][0]] = 1;
    while (st.length) { const [x, y] = st.pop(); for (const [dx, dy] of DIRS) { const nx = x + dx, ny = y + dy, i = ny * w + nx; if (nx < 0 || ny < 0 || nx >= w || ny >= d || g[i] || seen[i]) continue; seen[i] = 1; st.push([nx, ny]); } }
    assert.ok(p.rooms.every(r => seen[(r.y0 + 1) * w + r.x0 + 1]), `Saat ${s}`);
    const fd = p.frontDoor;
    assert.ok(front === 0 ? fd.y === 0 : front === 2 ? fd.y === d - 1 : front === 3 ? fd.x === 0 : fd.x === w - 1);
  }
});

function wandWelt() {
  return new World({
    tileSize: 32, tilesX: 1, tilesY: 1, height: 8, seed: 1,
    generate: (t, vol) => { for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) { vol.set(x, y, 0, C(1)); if (x === 16 && y < 26) for (let z = 1; z < 6; z++) vol.set(x, y, z, C(2)); } },
  });
}

test('Flow Field führt um die Wand herum', () => {
  const w = wandWelt(); w.ensure(0, 0);
  const f = new FlowField(w); f.compute(24, 5, 200);
  const e = { x: 8, y: 5 };
  for (let i = 0; i < 400 && Math.hypot(e.x - 24, e.y - 5) > 1.5; i++) { const d = f.dir(e.x, e.y); assert.ok(d); w.move(e, d[0] * 0.5, d[1] * 0.5, 1); }
  assert.ok(Math.hypot(e.x - 24, e.y - 5) <= 1.5, `angekommen bei ${e.x.toFixed(1)}, ${e.y.toFixed(1)}`);
  assert.ok(f.value(8, 5) > 40, 'Umweg ist länger als die Luftlinie');
});

test('ECS: Abfragen, Entfernen am Bildende, Bewegungssystem mit Kollision', () => {
  const w = wandWelt(); w.ensure(0, 0);
  const ecs = new ECS().addSystem(movementSystem(w));
  const a = ecs.create({ pos: { x: 10, y: 5 }, vel: { x: 20, y: 0 }, body: { r: 1 } });
  const b = ecs.create({ pos: { x: 3, y: 3 } });
  assert.equal([...ecs.query('pos')].length, 2); assert.equal([...ecs.query('pos', 'vel')].length, 1);
  for (let i = 0; i < 20; i++) ecs.update(0.05);
  assert.ok(ecs.get(a, 'pos').x < 15, 'Wand bei x = 16 hält auf');
  ecs.destroy(b); assert.ok(ecs.has(b, 'pos')); ecs.update(0); assert.ok(!ecs.has(b, 'pos'));
});
