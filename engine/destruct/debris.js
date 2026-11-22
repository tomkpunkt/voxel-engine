// Block-Partikel: kleine Würfel mit Schwerkraft, Abprallen und Kollision gegen die Welt (feines Gitter).
// Pro Partikel (und damit pro Emitter) wählbar: verschwinden oder liegen bleiben und Teil der Welt werden.
// DOM-frei; gezeichnet werden sie mit renderer.drawDebris(debris.list) in einem Draw-Call.
//
// Einheiten: Position in Blöcken (Weltkoordinaten), z = Unterkante des Würfels, size = Kantenlänge in Blöcken
// (≤ 1; bei Unterteilung S sind 1/S, 2/S … sinnvoll, weil liegen gebliebene Teile auf das feine Gitter einrasten).

export class Debris {
  /**
   * @param {World} world
   * @param {object} [o]
   * @param {number} [o.max]       höchstens so viele Partikel (älteste fallen weg)
   * @param {number} [o.gravity]   Blöcke/s² (Standard: 9,81 m/s² umgerechnet mit world.voxelSize)
   */
  constructor(world, o = {}) {
    this.world = world; this.list = []; this.max = o.max ?? 2500;
    this.g = o.gravity ?? 9.81 / world.voxelSize;
    this.slowV = 0.3 / world.voxelSize; this.bounceV = 0.4 / world.voxelSize;   // 0,3 m/s gilt als Ruhe, unter 0,4 m/s kein Abprallen
    this.dirty = null; this.emitters = new Set();
    this.onSettle = null;           // (p) => void, z. B. Geräusch
    this.stats = { emitted: 0, settled: 0, faded: 0 };
  }
  /** Einen Partikel hinzufügen. Fehlende Werte bekommen Standardwerte. */
  emit(p) {
    const q = {
      x: p.x, y: p.y, z: p.z, vx: p.vx || 0, vy: p.vy || 0, vz: p.vz || 0,
      size: Math.min(1, p.size ?? 1 / this.world.sub), color: p.color ?? 0x808080, lay: p.lay ?? 0,
      life: p.life ?? 3, settle: !!p.settle, bounce: p.bounce ?? 0.3, friction: p.friction ?? 0.6, rest: 0, t: 0,
    };
    this.list.push(q); this.stats.emitted++;
    if (this.list.length > this.max) this.list.splice(0, this.list.length - this.max);
    return q;
  }
  /** Neuen Emitter anlegen (siehe Emitter). */
  emitter(o) { const e = new Emitter(this, o); this.emitters.add(e); return e; }
  solid(x, y, z) {
    if (z < 0) return true;
    const S = this.world.sub;
    return this.world.getFine(Math.floor(x * S), Math.floor(y * S), Math.floor(z * S)) !== 0;
  }
  update(dt) {
    for (const e of this.emitters) { e.update(dt); if (e.done) this.emitters.delete(e); }
    const L = this.list, eps = 0.001;
    for (let i = L.length - 1; i >= 0; i--) {
      const p = L[i]; p.t += dt;
      const h = p.size / 2;
      p.vz -= this.g * dt;
      // Achsen getrennt: erst waagerecht (Mitte der Unterkante + ein wenig darüber), dann senkrecht
      const zc = p.z + Math.min(h, 0.25);
      const nx = p.x + p.vx * dt;
      if (this.solid(nx + Math.sign(p.vx) * h, p.y, zc)) p.vx = -p.vx * p.bounce; else p.x = nx;
      const ny = p.y + p.vy * dt;
      if (this.solid(p.x, ny + Math.sign(p.vy) * h, zc)) p.vy = -p.vy * p.bounce; else p.y = ny;
      const nz = p.z + p.vz * dt;
      let ground = false;
      if (p.vz <= 0 && this.solid(p.x, p.y, nz - eps)) {
        // auf die Oberkante der Zelle darunter setzen
        const S = this.world.sub; let top = Math.floor((nz - eps) * S + 1) / S;
        if (top > p.z + 0.5) top = p.z;                         // nicht nach oben teleportieren
        p.z = Math.max(0, top); ground = true;
        p.vz = Math.abs(p.vz) > this.bounceV ? -p.vz * p.bounce : 0;
        p.vx *= p.friction; p.vy *= p.friction;
      } else if (p.vz > 0 && this.solid(p.x, p.y, nz + p.size)) p.vz = 0;
      else p.z = nz;
      const slow = Math.hypot(p.vx, p.vy, p.vz) < this.slowV;
      if (ground && slow) p.rest += dt; else p.rest = 0;
      if (p.settle && p.rest > 0.25) { this.place(p); L.splice(i, 1); continue; }
      if (!p.settle && (p.t > p.life || p.z < -5)) { L.splice(i, 1); this.stats.faded++; continue; }
    }
  }
  /** Liegen gebliebenen Partikel als feine Blöcke in die Welt schreiben (bleibende Änderung). */
  place(p) {
    const w = this.world, S = w.sub, n = Math.max(1, Math.round(p.size * S));
    const fx0 = Math.round(p.x * S - n / 2), fy0 = Math.round(p.y * S - n / 2);
    let fz0 = Math.round(p.z * S);
    for (let k = 0; k < 6 && this.anySolid(fx0, fy0, fz0, n); k++) fz0++;   // nicht in Belegtes schreiben
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) for (let c = 0; c < n; c++) w.editFine(fx0 + a, fy0 + b, fz0 + c, p.color | 0x1000000, p.lay);
    const x0 = Math.floor(fx0 / S), y0 = Math.floor(fy0 / S), x1 = Math.floor((fx0 + n) / S), y1 = Math.floor((fy0 + n) / S);
    this.mark(x0, y0, x1, y1);
    this.stats.settled++;
    if (this.onSettle) this.onSettle(p);
  }
  anySolid(fx, fy, fz, n) {
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) for (let c = 0; c < n; c++) if (this.world.getFine(fx + a, fy + b, fz + c)) return true;
    return false;
  }
  mark(x0, y0, x1, y1) {
    const d = this.dirty;
    this.dirty = d ? [Math.min(d[0], x0), Math.min(d[1], y0), Math.max(d[2], x1), Math.max(d[3], y1)] : [x0, y0, x1, y1];
  }
  /** Gesammelte Änderungen einmal pro Bild übernehmen (Abfragen und Neubacken). */
  commit() {
    if (!this.dirty) return;
    const [x0, y0, x1, y1] = this.dirty; this.dirty = null;
    this.world.commit(x0, y0, x1, y1);
  }
}

/**
 * Emitter: erzeugt Partikel mit einer Rate oder als Stoß.
 * o = { x, y, z, rate (pro s), shape ('point' | 'box' | 'sphere'), extent [ex, ey, ez] bzw. Radius,
 *       dir [dx, dy, dz], spread (Kegel in rad, π = alle Richtungen), speed [min, max] Blöcke/s,
 *       colors [0xRRGGBB …] oder color(rng) → Farbe, size, life [min, max] s, settle (liegen bleiben),
 *       bounce, friction, duration (s, danach fertig; Standard unendlich) }
 */
export class Emitter {
  constructor(debris, o) {
    this.debris = debris; this.o = { shape: 'point', rate: 20, spread: Math.PI, speed: [3, 8], life: [1.5, 3], dir: [0, 0, 1], ...o };
    this.acc = 0; this.t = 0; this.active = true; this.done = false;
  }
  moveTo(x, y, z) { Object.assign(this.o, { x, y, z }); }
  update(dt) {
    if (!this.active) return;
    this.t += dt;
    if (this.o.duration !== undefined && this.t >= this.o.duration) { this.done = true; return; }
    this.acc += this.o.rate * dt;
    while (this.acc >= 1) { this.acc--; this.spawn(); }
  }
  burst(n) { for (let k = 0; k < n; k++) this.spawn(); }
  spawn() {
    const o = this.o, r = Math.random;
    let x = o.x, y = o.y, z = o.z;
    if (o.shape === 'box') { const [ex, ey, ez] = o.extent; x += (r() - 0.5) * ex; y += (r() - 0.5) * ey; z += r() * ez; }
    else if (o.shape === 'sphere') { const R = o.extent ?? 1, a = r() * 6.283, b = Math.acos(2 * r() - 1), q = R * Math.cbrt(r()); x += Math.sin(b) * Math.cos(a) * q; y += Math.sin(b) * Math.sin(a) * q; z += Math.cos(b) * q; }
    // Richtung: um dir gestreut (Kegel mit halbem Öffnungswinkel spread)
    const [dx, dy, dz] = o.dir, l = Math.hypot(dx, dy, dz) || 1;
    const ct = Math.cos(o.spread * r()), st = Math.sqrt(1 - ct * ct), ph = r() * 6.283;
    const ax = Math.abs(dz / l) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const ux = [dy / l * ax[2] - dz / l * ax[1], dz / l * ax[0] - dx / l * ax[2], dx / l * ax[1] - dy / l * ax[0]], ul = Math.hypot(...ux);
    const u = ux.map(v => v / ul), v = [dy / l * u[2] - dz / l * u[1], dz / l * u[0] - dx / l * u[2], dx / l * u[1] - dy / l * u[0]];
    const sp = o.speed[0] + r() * (o.speed[1] - o.speed[0]);
    const vx = (dx / l * ct + (u[0] * Math.cos(ph) + v[0] * Math.sin(ph)) * st) * sp;
    const vy = (dy / l * ct + (u[1] * Math.cos(ph) + v[1] * Math.sin(ph)) * st) * sp;
    const vz = (dz / l * ct + (u[2] * Math.cos(ph) + v[2] * Math.sin(ph)) * st) * sp;
    const color = o.color ? o.color(r) : o.colors ? o.colors[Math.floor(r() * o.colors.length)] : 0x808080;
    this.debris.emit({ x, y, z, vx, vy, vz, color, size: o.size, life: o.life[0] + r() * (o.life[1] - o.life[0]), settle: o.settle, bounce: o.bounce, friction: o.friction });
  }
}
