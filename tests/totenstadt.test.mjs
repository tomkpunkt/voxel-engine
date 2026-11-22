// Totenstadt auf der Engine: Kacheln, Türen, Maßstab
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCity, doorVoxels, doorCells } from '../games/totenstadt/city.js';
import { VPM } from '../games/totenstadt/scale.js';

test('Stadt: Häuser ≥ 60 m², Türen offen/zu ändern Kollision, Zustand bleibt beim Neuerzeugen', () => {
  const c = createCity(4711), w = c.world;
  for (let ty = 4; ty < 8; ty++) for (let tx = 4; tx < 8; tx++) w.ensure(tx, ty);
  const houses = c.buildings.filter(b => b.kind === 'Haus');
  assert.ok(houses.length > 0);
  for (const h of houses) assert.ok(h.area >= 60, `Haus ${h.area} m²`);
  const dr = c.doors.find(d => !d.broken && w.tileOf(Math.floor(d.x / w.TS), Math.floor(d.y / w.TS))?.vol);
  const [gx, gy] = doorCells(dr).gap[2];
  const set = (x, y, z, col, l) => w.setV(x, y, z, col, l), get = (x, y, z) => w.getL(x, y, z);
  dr.open = false; doorVoxels(dr, set, get); c.indexDoorGaps(); w.updateRegion(gx - 6, gy - 6, gx + 6, gy + 6);
  assert.ok(w.isBlocked(gx, gy), 'geschlossene Tür blockiert');
  dr.open = true; doorVoxels(dr, set, get); c.indexDoorGaps(); w.updateRegion(gx - 6, gy - 6, gx + 6, gy + 6);
  assert.ok(!w.isBlocked(gx, gy), 'offene Tür lässt durch');
  // Kachel entladen und neu erzeugen: Tür bleibt offen
  const tx = Math.floor(dr.x / w.TS), ty = Math.floor(dr.y / w.TS);
  w.evict(-99, -99, 0); w.ensure(tx, ty);
  assert.ok(!w.isBlocked(gx, gy), 'offene Tür nach Neuerzeugen');
  assert.equal(VPM, 5);
});
