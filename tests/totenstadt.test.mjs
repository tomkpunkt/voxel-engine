// Totenstadt auf der Engine: Kacheln, Türen, Maßstab, Zustand nach Entladen
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCity } from '../games/totenstadt/stadt.js';
import { doorCells } from '../games/totenstadt/city.js';
import { VPM, GN, TS } from '../games/totenstadt/scale.js';

test('Stadt über 1 km, Häuser ≥ 60 m², Tür offen/zu ändert Kollision, Zustand bleibt nach Entladen', () => {
  const c = createCity(4711, { workers: false }), w = c.world;
  assert.ok(GN * TS / VPM >= 1000, 'Kantenlänge ≥ 1 km');
  for (let ty = 30; ty < 34; ty++) for (let tx = 30; tx < 34; tx++) w.ensure(tx, ty);
  const houses = c.buildings.filter(b => b.kind === 'Haus');
  assert.ok(houses.length > 0);
  for (const h of houses) assert.ok(h.area >= 60, `Haus ${h.area} m²`);
  assert.equal(c.inBuilding((houses[0].x0 + houses[0].x1) / 2, (houses[0].y0 + houses[0].y1) / 2), houses[0].index);
  const dr = c.doors.find(d => !d.broken && w.tileAt(d.x, d.y).vol && w.tileAt(d.x, d.y).tx > 30 && w.tileAt(d.x, d.y).tx < 33 && w.tileAt(d.x, d.y).ty > 30 && w.tileAt(d.x, d.y).ty < 33);
  const [gx, gy] = doorCells(dr).gap[2];
  dr.open = false; c.applyDoor(dr);
  assert.ok(w.isBlocked(gx, gy), 'geschlossene Tür blockiert');
  dr.open = true; c.applyDoor(dr);
  assert.ok(!w.isBlocked(gx, gy), 'offene Tür lässt durch');
  dr.open = false; c.applyDoor(dr);
  // Loch in eine Wand schlagen (Delta), dann alles entladen und neu laden
  const t = w.tileAt(dr.x, dr.y), rev = t.rev;
  w.edit(gx, gy - 8, 3, 0); w.commit(gx - 1, gy - 9, gx + 1, gy - 7);
  assert.ok(t.rev > rev);
  w.evict(-99, -99, 0); w.builder.cache.clear();
  assert.equal(t.vol, null);
  w.ensure(t.tx, t.ty);
  assert.ok(w.isBlocked(gx, gy), 'Tür nach Neuerzeugen weiter zu');
  assert.equal(w.getC(gx, gy - 8, 3), 0, 'Loch nach Neuerzeugen noch da');
  const entities = c.doors.length;
  w.evict(-99, -99, 0); w.ensure(t.tx, t.ty);
  assert.equal(c.doors.length, entities, 'Entities werden beim Neuerzeugen nicht doppelt gemeldet');
});
