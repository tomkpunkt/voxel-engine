// Leichen als Ragdolls: Zombies fallen physikalisch (Rapier.js, sonst Verlet) und bleiben als Voxel-Figur liegen.
import { humanoid, RagdollModel, makeGrid, cropGrid, createRagdollWorld } from '../../engine/physics/ragdoll.js';
import { SD, zombieFn, figureStack } from './models.js';

// Zombie-Skelett: Rumpf leicht nach vorn, Arme ausgestreckt (wie zombieFn mit Schritt 0)
export const ZSKEL = humanoid({ points: {
  neck: [0.35, 0, 7.9], head: [0.55, 0, 8.6],
  shL: [0.2, -1.3, 7.4], shR: [0.2, 1.3, 7.4], elL: [1.2, -1.15, 7.45], elR: [1.25, 1.1, 7.3], haL: [2.1, -0.95, 7.5], haR: [2.3, 0.85, 7.2],
  hipL: [0, -0.6, 4.9], hipR: [0, 0.55, 4.9], knL: [0, -0.6, 2.8], knR: [0, 0.55, 2.8], ftL: [0.1, -0.6, 0.4], ftR: [0.1, 0.55, 0.4],
} });
const GW = 60, GH = 48, ACTIVE = 4;   // höchstens so viele fallen gleichzeitig, ältere werden festgehalten

export class Leichen {
  /** mode: 'auto' | 'rapier' | 'verlet' | 'aus' */
  constructor(R, mode = 'auto') {
    this.R = R; this.mode = mode; this.phys = null; this.world = null;
    this.models = [0, 1, 2].map(v => new RagdollModel(figureStack(zombieFn(0, v * 2 + 1, false), 48, 40), ZSKEL, SD));
    this.pool = []; this.active = [];
    this.grid = makeGrid(GW, GW, GH);
  }
  get backend() { return this.phys ? this.phys.backend : this.mode === 'aus' ? 'aus' : 'lädt'; }
  async attach(world) {
    this.reset(); this.world = world; this.phys = null;
    if (this.mode === 'aus') return;
    const phys = await createRagdollWorld(world, { backend: this.mode });
    if (this.world === world) this.phys = phys;
  }
  reset() {
    for (const k of [...this.active]) this.drop(k);
    this.active = [];
  }
  /** Zombie stirbt: Ragdoll anlegen. Liefert false, wenn es keinen gibt (dann alte Liegend-Figur). */
  spawn(k, z, dx, dy, power) {
    if (!this.phys) return false;
    if (this.active.length >= ACTIVE) this.freeze(this.active[0]);
    const sp = 3 + power * 2.5;
    k.rd = this.phys.spawn(ZSKEL, { x: z.x, y: z.y, z: 1, rot: z.rot, vel: [dx * sp, dy * sp, 1],
      hit: Math.random() < 0.5 ? 'head' : 'torso', hitVel: [dx * sp * 2.2, dy * sp * 2.2, 3] });
    k.rd.keep = true;   // Physik behält ihn, bis freeze ihn entfernt
    k.spr = this.pool.pop() || this.R.createDynamicSprite(GW, GW, GH);
    k.dyn = true;
    this.active.push(k);
    this.sync(k);
    return true;
  }
  sync(k) {
    const pose = k.rd.pose(), b = this.models[k.v].voxelize(pose, this.grid);
    this.R.updateSprite(k.spr, this.grid, b);
    k.x = b.x; k.y = b.y; k.z = b.z; k.b = b; k.pose = pose;
  }
  update(dt) {
    if (!this.phys || !this.active.length) return;
    this.phys.step(dt);
    for (const k of [...this.active]) { this.sync(k); if (k.rd.sleeping) this.freeze(k); }
  }
  /** Ruhelage festhalten: kleiner fester Sprite, dynamischen zurück in den Vorrat. */
  freeze(k) {
    if (!k.dyn) return;
    this.sync(k);                       // Raster gehört gerade dieser Leiche
    this.pool.push(this.bake(k, this.grid, k.b));
    if (k.rd) { this.phys?.remove(k.rd); k.rd = null; }
    this.active = this.active.filter(x => x !== k);
  }
  bake(k, grid, b) {
    const { grid: g, dx, dy } = cropGrid(grid, b);
    const old = k.spr;
    k.spr = this.R.spriteFromGrid(g); k.x = b.x + dx / SD; k.y = b.y + dy / SD;
    k.dyn = false;
    return old;
  }
  /** Leiche entfernen (älteste bei zu vielen). */
  drop(k) {
    if (k.dyn) { this.active = this.active.filter(x => x !== k); if (k.rd) this.phys?.remove(k.rd); k.rd = null; this.pool.push(k.spr); }
    else if (k.spr) this.R.deleteSprite(k.spr);
    k.spr = null;
  }
  /** Für den Spielstand: Pose gerundet. */
  save(k) {
    const o = { x: k.x, y: k.y, rot: k.rot, v: k.v };
    if (k.pose) o.pose = k.pose.map(p => ({ c: p.c.map(v => +v.toFixed(2)), R: Array.from(p.R, v => +v.toFixed(3)) }));
    return o;
  }
  /** Aus dem Spielstand: Pose neu voxelisieren und als festen Sprite backen. */
  load(s) {
    const k = { ...s, t: 0 };
    if (s.pose) {
      const pose = s.pose.map(p => ({ c: p.c, R: Float32Array.from(p.R) }));
      const b = this.models[k.v].voxelize(pose, this.grid);
      k.pose = pose; k.z = b.z; this.bake(k, this.grid, b);
    }
    return k;
  }
}
