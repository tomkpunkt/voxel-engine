// Stadt auf der Hauptseite: Welt, Streaming-Backend und Spielzustand (Türen, Behälter, Lichter, Gebäude).
// Die Voxel entstehen im Generator-Modul city.js (im Worker); hier kommen nur die Ergebnisse an.
import { World } from '../../engine/world/world.js';
import { LocalBackend, WorkerBackend } from '../../engine/stream/streamer.js';
import { cityPlan, createGenerator, blocks, doorCells, doorVoxels } from './city.js';
import { TS, GN, H, GEN_VERSION, SUB, VPM } from './scale.js';

/**
 * @param {number} seed
 * @param {object} [o]  { workers: true|false|Zahl }  false = synchron (Tests, Node)
 */
export function createCity(seed, o = {}) {
  const plan = cityPlan(seed);
  const world = new World({ tileSize: TS, tilesX: GN, tilesY: GN, height: H, seed, version: GEN_VERSION, blocks, sub: SUB, voxelSize: 1 / VPM });
  const city = { seed, world, grid: plan.grid, order: plan.order, buildings: [], lights: [], containers: [], flames: [], doors: [] };
  const c0 = (GN >> 1) * TS + TS / 2;
  city.spawn = { x: c0 + 0.5, y: c0 + 0.5 };

  const local = () => { city.backend = new LocalBackend(createGenerator({ seed, plan }), seed); world.builder = city.backend.builder; city.workers = false; };
  city.workers = o.workers !== false && typeof Worker !== 'undefined';
  if (city.workers) {
    try { city.backend = new WorkerBackend(new URL('./city.js', import.meta.url), { seed, plan }, { workers: typeof o.workers === 'number' ? o.workers : undefined }); }
    catch (e) { console.warn('Worker nicht möglich, baue im Haupt-Thread:', e.message); local(); }
  } else local();
  /** Wartet auf die Worker (höchstens ms); klappt es nicht, wird auf den Haupt-Thread umgeschaltet. */
  city.whenReady = async (ms = 8000) => {
    if (!city.workers) return false;
    try { await Promise.race([city.backend.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('Zeitüberschreitung')), ms))]); return true; }
    catch (e) { console.warn('Worker nicht bereit, baue im Haupt-Thread:', e.message); city.backend.terminate(); local(); return false; }
  };

  // Entities kommen genau einmal pro Kachel (beim ersten Erzeugen)
  city.savedContainers = null;    // beim Laden: Behälter-Inhalte nach id
  world.on('entities', (t, list) => {
    t.data.buildings = []; t.data.doors = [];
    let nc = 0;
    for (const { type: kind, data } of list) {
      const d = { ...data, tile: t.key };
      if (kind === 'light') city.lights.push(d);
      else if (kind === 'cont') {
        d.id = t.key + ':' + (nc++);                         // stabil: gleiche Saat und Version → gleiche Reihenfolge
        d.items = city.savedContainers && city.savedContainers[d.id] !== undefined ? city.savedContainers[d.id] : null;
        city.containers.push(d);
      }
      else if (kind === 'flame') city.flames.push(d);
      else if (kind === 'door') { city.doors.push(d); t.data.doors[d.idx] = d; }
      else if (kind === 'building') { d.index = city.buildings.length; city.buildings.push(d); t.data.buildings.push(d); }
    }
  });

  /** Index des Gebäudes an (x, y) oder -1. */
  city.inBuilding = (x, y) => {
    const t = world.tileAt(x, y);
    if (!t || !t.data.buildings) return -1;
    for (const b of t.data.buildings) if (x >= b.x0 && x <= b.x1 + 0.99 && y >= b.y0 && y <= b.y1 + 0.99) return b.index;
    return -1;
  };

  /** Türzustand ändern: Voxel, Kachelzustand (für Neuerzeugen), Revision, Abfragen. */
  city.applyDoor = dr => {
    const t = world.tiles.get(dr.tile);
    t.state = t.state || { doors: [] };
    t.state.doors[dr.idx] = [dr.open, dr.broken, dr.hp];
    world.touch(t);
    if (!t.vol) return;
    doorVoxels(dr, (x, y, z, c, l) => world.setV(x, y, z, c, l), (x, y, z) => world.getL(x, y, z));
    const { gap, leaf } = doorCells(dr), cells = [...gap, ...leaf];
    const xs = cells.map(c => c[0]), ys = cells.map(c => c[1]);
    world.updateRegion(Math.min(...xs) - 2, Math.min(...ys) - 2, Math.max(...xs) + 2, Math.max(...ys) + 2);
  };
  return city;
}
