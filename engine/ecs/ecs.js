// Schlankes ECS: Entities sind Zahlen, Komponenten sind einfache Objekte in Maps je Typ.
// Systeme sind Funktionen (ecs, dt) => void. Das Spiel definiert Verhalten, Gesundheit, Inventar selbst.

export class ECS {
  constructor() { this.next = 1; this.stores = new Map(); this.systems = []; this.dead = new Set(); }
  create(components = {}) {
    const id = this.next++;
    for (const k in components) this.add(id, k, components[k]);
    return id;
  }
  add(id, type, data) {
    let s = this.stores.get(type); if (!s) { s = new Map(); this.stores.set(type, s); }
    s.set(id, data); return data;
  }
  get(id, type) { const s = this.stores.get(type); return s ? s.get(id) : undefined; }
  has(id, type) { const s = this.stores.get(type); return !!s && s.has(id); }
  remove(id, type) { const s = this.stores.get(type); if (s) s.delete(id); }
  /** Entity am Ende des Frames entfernen (sicher während einer Abfrage). */
  destroy(id) { this.dead.add(id); }
  /** Alle Entities mit allen genannten Komponenten: liefert [id, c1, c2, …]. */
  *query(...types) {
    const [first, ...rest] = types.map(t => this.stores.get(t) || new Map());
    for (const [id, c0] of first) {
      const cs = [c0];
      let ok = true;
      for (const s of rest) { const c = s.get(id); if (c === undefined) { ok = false; break; } cs.push(c); }
      if (ok) yield [id, ...cs];
    }
  }
  count(type) { const s = this.stores.get(type); return s ? s.size : 0; }
  addSystem(fn) { this.systems.push(fn); return this; }
  update(dt) {
    for (const fn of this.systems) fn(this, dt);
    for (const id of this.dead) for (const s of this.stores.values()) s.delete(id);
    this.dead.clear();
  }
}

/** Wiederverwendbares System: Bewegung mit Kollision gegen die Welt. Komponenten: pos {x,y}, vel {x,y}, body {r}. */
export const movementSystem = world => (ecs, dt) => {
  for (const [, pos, vel, body] of ecs.query('pos', 'vel', 'body')) {
    if (vel.x || vel.y) body.moved = world.move(pos, vel.x * dt, vel.y * dt, body.r);
  }
};
