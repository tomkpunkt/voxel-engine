// Testhilfe: Welt mit synchronem Builder aus einer Generator-Beschreibung.
import { World } from '../engine/world/world.js';
import { Builder } from '../engine/stream/builder.js';

export function makeWorld(gen, seed = 1) {
  const w = new World({ tileSize: gen.tileSize, tilesX: gen.tilesX, tilesY: gen.tilesY, height: gen.height, seed, version: gen.version, blocks: gen.blocks });
  w.builder = new Builder(gen, seed);
  return w;
}
export function loadAll(w) { for (let ty = 0; ty < w.tilesY; ty++) for (let tx = 0; tx < w.tilesX; tx++) w.ensure(tx, ty); return w; }
