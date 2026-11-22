// Ragdolls für Voxel-Figuren.
//
// Eine Figur besteht aus einem Ruhevolumen (Sprite-Volumen, stehend) und einem Skelett aus Punkten und Teilen.
// Die Physik bewegt die Teile; RagdollModel.voxelize setzt daraus pro Bild ein Volumen zusammen, indem jeder
// Zielvoxel in die Ruhelage seines Teils zurückgerechnet und dort nachgeschlagen wird (keine Löcher, Farben bleiben).
//
// Zwei Backends mit derselben Schnittstelle:
//   'rapier' – Rapier.js (WASM, per CDN geladen), Körper je Teil, Kugel- und Scharniergelenke
//              (Aufbau wie im Projekt rapierjs-ragdoll), Boden aus Säulen-Quadern der Welt.
//   'verlet' – eigener Verlet-Ragdoll: Gelenkpunkte mit Abstandsbedingungen, Kollision gegen das grobe Voxelgitter.
//              Läuft überall (auch in Node-Tests) und dient als Ersatz, wenn Rapier nicht lädt.
//
//   const phys = await createRagdollWorld(world, { backend: 'auto' });
//   const rd = phys.spawn(skel, { x, y, z, rot, vel: [vx, vy, vz], hit: 'head', hitVel: [...] });
//   phys.step(dt);  rd.pose() → [{ c: [x, y, z], R: Float32Array(9) }];  rd.sleeping
//
// Einheiten: Blöcke der Welt (wie world.height), Schwerkraft 9,81 m/s² über world.voxelSize umgerechnet.

export const RAPIER_URL = 'https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.19/+esm';

// ---------------------------------------------------------------- Skelett
/**
 * Menschliches Skelett in Modelleinheiten (Blöcke; Figur steht auf z = 0 und schaut nach +x, links = −y).
 * points überschreibt einzelne Punkte (z. B. Arme nach vorn für Zombies).
 */
export function humanoid(o = {}) {
  const points = {
    pelvis: [0, 0, 4.8], neck: [0.15, 0, 7.9], head: [0.45, 0, 8.7],
    shL: [0.1, -1.3, 7.5], shR: [0.1, 1.3, 7.5],
    elL: [0.45, -1.3, 6.2], elR: [0.45, 1.3, 6.2], haL: [1.1, -0.9, 5.4], haR: [1.1, 0.9, 5.4],
    hipL: [0, -0.6, 4.8], hipR: [0, 0.6, 4.8], knL: [0.1, -0.6, 2.8], knR: [0.1, 0.6, 2.8], ftL: [0.1, -0.6, 0.45], ftR: [0.1, 0.6, 0.45],
    ...(o.points || {}),
  };
  // r: Radius für Zuordnung und Kollision; w: Gewicht (Masse relativ)
  const parts = [
    { name: 'torso', a: 'pelvis', b: 'neck', r: 1.1, w: 4, box: [0.85, 1.35] },
    { name: 'head', a: 'neck', b: 'head', r: 0.85, w: 1, parent: 'torso', joint: 'neck' },
    { name: 'uarmL', a: 'shL', b: 'elL', r: 0.42, w: 0.6, parent: 'torso', joint: 'shL' },
    { name: 'larmL', a: 'elL', b: 'haL', r: 0.4, w: 0.5, parent: 'uarmL', joint: 'elL', hinge: true },
    { name: 'uarmR', a: 'shR', b: 'elR', r: 0.42, w: 0.6, parent: 'torso', joint: 'shR' },
    { name: 'larmR', a: 'elR', b: 'haR', r: 0.4, w: 0.5, parent: 'uarmR', joint: 'elR', hinge: true },
    { name: 'thighL', a: 'hipL', b: 'knL', r: 0.52, w: 1.2, parent: 'torso', joint: 'hipL' },
    { name: 'shinL', a: 'knL', b: 'ftL', r: 0.5, w: 1, parent: 'thighL', joint: 'knL', hinge: true },
    { name: 'thighR', a: 'hipR', b: 'knR', r: 0.52, w: 1.2, parent: 'torso', joint: 'hipR' },
    { name: 'shinR', a: 'knR', b: 'ftR', r: 0.5, w: 1, parent: 'thighR', joint: 'knR', hinge: true },
  ];
  // Rumpf als starrer Verbund dieser Punkte (Verlet)
  const torso = ['pelvis', 'neck', 'shL', 'shR', 'hipL', 'hipR'];
  return { points, parts, torso, side: ['shL', 'shR'] };
}

// ---------------------------------------------------------------- kleine Mathematik
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
/** Orthonormalbasis: z entlang axis, x aus side (senkrecht gemacht). Spalten [x y z] als Zeilen-Array (row-major 3×3). */
function frame(axis, side) {
  const z = norm(axis);
  let x = sub(side, z.map(v => v * dot(side, z)));
  if (Math.hypot(x[0], x[1], x[2]) < 1e-4) x = Math.abs(z[0]) < 0.9 ? cross(z, [1, 0, 0]) : cross(z, [0, 1, 0]);
  x = norm(x); const y = cross(z, x);
  return [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
}
/** A · Bᵀ (3×3 row-major) */
function mulT(A, B) {
  const R = new Float32Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) R[i * 3 + j] = A[i * 3] * B[j * 3] + A[i * 3 + 1] * B[j * 3 + 1] + A[i * 3 + 2] * B[j * 3 + 2];
  return R;
}
const rotZ = (r, p) => { const c = Math.cos(r), s = Math.sin(r); return [c * p[0] - s * p[1], s * p[0] + c * p[1], p[2]]; };
function quatToMat(q) {
  const { x, y, z, w } = q;
  return new Float32Array([1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]);
}
/** Quaternion, das (0,1,0) auf d dreht. */
function quatFromY(d) {
  d = norm(d); const c = d[1];
  if (c < -0.9999) return { x: 1, y: 0, z: 0, w: 0 };
  const ax = [d[2], 0, -d[0]], s = Math.sqrt((1 + c) * 2);
  return { x: ax[0] / s, y: ax[1] / s, z: ax[2] / s, w: s / 2 };
}

/** Ruhelage eines Teils in Modelleinheiten: Mittelpunkt und Basis (für Verlet). */
function restPart(skel, p) {
  const P = skel.points, a = P[p.a], b = P[p.b];
  const side = sub(P[skel.side[1]], P[skel.side[0]]);
  return { c: mid(a, b), F: frame(sub(b, a), side), len: Math.hypot(...sub(b, a)) };
}

// ---------------------------------------------------------------- Voxelisierung
/**
 * Verbindet Ruhevolumen und Skelett. rest: Volume (oder {w,d,h,get,getLay}), in dens Voxeln je Block,
 * mittig um (0,0) wie buildStack, z ab 0.
 */
export class RagdollModel {
  constructor(rest, skel, dens = 4) {
    this.rest = rest; this.skel = skel; this.dens = dens;
    const { w, d, h } = rest, P = skel.points;
    this.parts = skel.parts.map(p => ({ ...p, ...restPart(skel, p), bound: 0 }));
    this.lab = new Uint8Array(w * d * h);
    for (let z = 0; z < h; z++) for (let y = 0; y < d; y++) for (let x = 0; x < w; x++) {
      if (!rest.get(x, y, z)) continue;
      const q = [(x - (w - 1) / 2) / dens, (y - (d - 1) / 2) / dens, (z + 0.5) / dens];
      let best = -1, bd = 1e9;
      this.parts.forEach((p, i) => {
        const a = P[p.a], ab = sub(P[p.b], a), aq = sub(q, a);
        const t = Math.max(0, Math.min(1, dot(aq, ab) / dot(ab, ab)));
        const dd = Math.hypot(aq[0] - ab[0] * t, aq[1] - ab[1] * t, aq[2] - ab[2] * t) / p.r;
        if (dd < bd) { bd = dd; best = i; }
      });
      this.lab[(z * d + y) * w + x] = best + 1;
      const p = this.parts[best];
      p.bound = Math.max(p.bound, Math.hypot(...sub(q, p.c)) + 1 / dens);
    }
  }
  /** Ruhe-Pose in der Welt (zum Prüfen und als Start): Figur bei (x, y, z) mit Blickrichtung rot. */
  restPose(x, y, z, rot) {
    const Rz = frame([0, 0, 1], [Math.cos(rot), Math.sin(rot), 0]);   // Modell-x → Blickrichtung
    return this.parts.map(p => { const c = rotZ(rot, p.c); return { c: [c[0] + x, c[1] + y, c[2] + z], R: Float32Array.from(Rz) }; });
  }
  /**
   * Pose → Raster. out: { w, d, h, c: Uint32Array, l: Uint8Array } (wird gelöscht und gefüllt).
   * Liefert Lage für drawSprite: { x, y, z } (Mitte des Rasters, Unterkante) und used-Grenzen.
   */
  voxelize(pose, out) {
    const { w, d, h, c, l } = out, dens = this.dens, rest = this.rest;
    const RW = rest.w, RD = rest.d, RH = rest.h;
    const pv = out.prev;   // nur den zuletzt belegten Bereich löschen
    if (pv) { for (let z = 0; z < pv.zTop; z++) for (let y = pv.y0; y < pv.y1; y++) { const k = (z * d + y) * w; c.fill(0, k + pv.x0, k + pv.x1); l.fill(0, k + pv.x0, k + pv.x1); } }
    else { c.fill(0); l.fill(0); }
    // Anker: Mitte über dem Rumpf, Unterkante knapp unter dem tiefsten Teil
    const t = pose[0].c;
    let zmin = 1e9;
    pose.forEach((ps, i) => { zmin = Math.min(zmin, ps.c[2] - this.parts[i].bound); });
    const ax = Math.round(t[0] * dens) / dens, ay = Math.round(t[1] * dens) / dens;
    const az = Math.max(0, Math.floor(zmin * dens) / dens);
    let zTop = 0, x0 = w, x1 = 0, y0 = d, y1 = 0;
    for (let i = 0; i < pose.length; i++) {
      const p = this.parts[i], R = pose[i].R, pc = pose[i].c, B = p.bound, lab = i + 1;
      // Zielbereich (Rasterindizes)
      const gx0 = Math.max(0, Math.floor((pc[0] - B - ax) * dens + w / 2)), gx1 = Math.min(w - 1, Math.ceil((pc[0] + B - ax) * dens + w / 2));
      const gy0 = Math.max(0, Math.floor((pc[1] - B - ay) * dens + d / 2)), gy1 = Math.min(d - 1, Math.ceil((pc[1] + B - ay) * dens + d / 2));
      const gz0 = Math.max(0, Math.floor((pc[2] - B - az) * dens)), gz1 = Math.min(h - 1, Math.ceil((pc[2] + B - az) * dens));
      for (let gz = gz0; gz <= gz1; gz++) for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
        const k = (gz * d + gy) * w + gx;
        if (c[k]) continue;
        // Weltpunkt → Modellpunkt q = Rᵀ (P − c) + c_rest
        const px = ax + (gx + 0.5 - w / 2) / dens - pc[0], py = ay + (gy + 0.5 - d / 2) / dens - pc[1], pz = az + (gz + 0.5) / dens - pc[2];
        const qx = R[0] * px + R[3] * py + R[6] * pz + p.c[0];
        const qy = R[1] * px + R[4] * py + R[7] * pz + p.c[1];
        const qz = R[2] * px + R[5] * py + R[8] * pz + p.c[2];
        const rx = Math.round(qx * dens + (RW - 1) / 2), ry = Math.round(qy * dens + (RD - 1) / 2), rz = Math.floor(qz * dens);
        if (rx < 0 || ry < 0 || rz < 0 || rx >= RW || ry >= RD || rz >= RH) continue;
        const rk = (rz * RD + ry) * RW + rx;
        if (this.lab[rk] !== lab) continue;
        c[k] = rest.get(rx, ry, rz); l[k] = rest.getLay ? rest.getLay(rx, ry, rz) : 0;
        if (gz + 1 > zTop) zTop = gz + 1;
        if (gx < x0) x0 = gx; if (gx + 1 > x1) x1 = gx + 1; if (gy < y0) y0 = gy; if (gy + 1 > y1) y1 = gy + 1;
      }
    }
    out.prev = { zTop, x0, x1, y0, y1 };
    return { x: ax, y: ay, z: az, zTop, x0, x1, y0, y1 };
  }
}
/** Leeres Raster für voxelize. */
export function makeGrid(w, d, h) { return { w, d, h, c: new Uint32Array(w * d * h), l: new Uint8Array(w * d * h) }; }
/** Ausschnitt eines Rasters (für ruhende Leichen: kleinere Textur). Liefert { grid, dx, dy } (Verschiebung der Mitte in Rasterzellen). */
export function cropGrid(g, b) {
  const x0 = Math.max(0, b.x0 - 1), x1 = Math.min(g.w, b.x1 + 1), y0 = Math.max(0, b.y0 - 1), y1 = Math.min(g.d, b.y1 + 1), h = Math.max(1, b.zTop);
  const w = Math.max(1, x1 - x0), d = Math.max(1, y1 - y0), o = makeGrid(w, d, h);
  for (let z = 0; z < h; z++) for (let y = 0; y < d; y++) for (let x = 0; x < w; x++) {
    const s = (z * g.d + y + y0) * g.w + x + x0, k = (z * d + y) * w + x;
    o.c[k] = g.c[s]; o.l[k] = g.l[s];
  }
  return { grid: o, dx: (x0 + x1) / 2 - g.w / 2, dy: (y0 + y1) / 2 - g.d / 2 };
}

// ---------------------------------------------------------------- Verlet
class VerletRagdoll {
  constructor(sys, skel, o) {
    this.sys = sys; this.skel = skel; this.sleeping = false; this.calm = 0; this.age = 0;
    const P = skel.points, rot = o.rot || 0, dt = sys.dt;
    this.names = Object.keys(P);
    const idx = {}; this.names.forEach((n, i) => { idx[n] = i; });
    this.idx = idx;
    const torso = new Set(skel.torso);
    const rad = n => n === 'head' ? 0.75 : torso.has(n) ? 0.7 : n.startsWith('ft') || n.startsWith('ha') ? 0.35 : 0.45;
    this.pt = this.names.map(n => {
      const q = rotZ(rot, P[n]), x = q[0] + o.x, y = q[1] + o.y, z = q[2] + (o.z || 0);
      const v = o.vel || [0, 0, 0];
      return { x, y, z, px: x - v[0] * dt, py: y - v[1] * dt, pz: z - v[2] * dt, r: rad(n) };
    });
    if (o.hit && o.hitVel) {
      const part = skel.parts.find(p => p.name === o.hit) || skel.parts[0];
      for (const n of [part.a, part.b]) { const p = this.pt[idx[n]]; p.px -= o.hitVel[0] * dt; p.py -= o.hitVel[1] * dt; p.pz -= o.hitVel[2] * dt; }
    }
    // Bedingungen: Teile, starrer Rumpf, Kopf an Schultern, Mindestabstände gegen Zusammenklappen
    const C = this.cons = [];
    const add = (a, b, k = 1, min = false) => { const A = P[a], B = P[b]; C.push({ a: idx[a], b: idx[b], L: Math.hypot(...sub(A, B)), k, min }); };
    for (const p of skel.parts) add(p.a, p.b);
    const T = skel.torso;
    for (let i = 0; i < T.length; i++) for (let j = i + 1; j < T.length; j++) add(T[i], T[j]);
    add('head', 'shL', 0.6); add('head', 'shR', 0.6); add('head', 'pelvis', 0.5);
    for (const [a, b] of [['hipL', 'ftL'], ['hipR', 'ftR'], ['shL', 'haL'], ['shR', 'haR'], ['pelvis', 'knL'], ['pelvis', 'knR']])
      if (idx[a] !== undefined && idx[b] !== undefined) { C.push({ a: idx[a], b: idx[b], L: Math.hypot(...sub(P[a], P[b])) * 0.55, k: 1, min: true }); }
    this.rest = skel.parts.map(p => restPart(skel, p));
  }
  step(dt) {
    if (this.sleeping) return;
    const g = this.sys.g, pts = this.pt, w = this.sys.world;
    const solid = (x, y, z) => z < 0 || (w.getC(Math.floor(x), Math.floor(y), Math.floor(z)) !== 0);
    let vmax = 0;
    for (const p of pts) {
      const vx = (p.x - p.px) * 0.995, vy = (p.y - p.py) * 0.995, vz = (p.z - p.pz) * 0.995;
      vmax = Math.max(vmax, Math.hypot(vx, vy, vz) / dt);
      p.px = p.x; p.py = p.y; p.pz = p.z;
      p.x += vx; p.y += vy; p.z += vz - g * dt * dt;
      p.ground = false;
    }
    for (let it = 0; it < 10; it++) {
      for (const c of this.cons) {
        const a = pts[c.a], b = pts[c.b], dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, L = Math.hypot(dx, dy, dz) || 1e-6;
        if (c.min && L >= c.L) continue;
        const f = (L - c.L) / L * 0.5 * c.k;
        a.x += dx * f; a.y += dy * f; a.z += dz * f; b.x -= dx * f; b.y -= dy * f; b.z -= dz * f;
      }
      for (const p of pts) {
        if (!solid(p.x, p.y, p.z - p.r)) continue;
        if (!solid(p.x, p.y, p.pz - p.r)) { p.z = Math.floor(p.z - p.r) + 1 + p.r; p.ground = true; }   // von oben: aufsetzen
        else {   // von der Seite: zurück, ggf. obenauf
          p.x = p.px; p.y = p.py;
          if (solid(p.x, p.y, p.z - p.r)) { p.z = Math.floor(p.z - p.r) + 1 + p.r; p.ground = true; }
        }
      }
    }
    // Reibung am Boden
    for (const p of pts) if (p.ground) { p.px = p.x - (p.x - p.px) * 0.55; p.py = p.y - (p.y - p.py) * 0.55; if (p.pz < p.z) p.pz = p.z - (p.z - p.pz) * 0.3; }
    this.age += dt;
    this.calm = vmax < 0.6 ? this.calm + dt : 0;
    if (this.calm > 0.5 || this.age > 8) this.sleeping = true;
  }
  pose() {
    const P = i => { const p = this.pt[i]; return [p.x, p.y, p.z]; }, I = this.idx, sk = this.skel;
    const side = sub(P(I[sk.side[1]]), P(I[sk.side[0]]));
    return sk.parts.map((p, i) => {
      const a = P(I[p.a]), b = P(I[p.b]), r = this.rest[i];
      return { c: mid(a, b), R: mulT(frame(sub(b, a), side), r.F) };
    });
  }
}
class VerletWorld {
  constructor(world, o = {}) {
    this.world = world; this.backend = 'verlet'; this.dt = 1 / 60; this.acc = 0; this.list = [];
    this.g = 9.81 / (world.voxelSize || 0.2);
  }
  spawn(skel, o) { const r = new VerletRagdoll(this, skel, o); this.list.push(r); return r; }
  remove(r) { this.list = this.list.filter(x => x !== r); }
  step(dt) {
    this.acc = Math.min(this.acc + dt, 0.1);
    while (this.acc >= this.dt) { this.acc -= this.dt; for (const r of this.list) r.step(this.dt); }
    this.list = this.list.filter(r => !r.sleeping || r.keep);
  }
}

// ---------------------------------------------------------------- Rapier
class RapierRagdoll {
  constructor(sys, skel, o) {
    const R = sys.R, W = sys.W, vs = sys.vs, rot = o.rot || 0, P = skel.points;
    this.sys = sys; this.skel = skel; this.sleeping = false; this.age = 0; this.bodies = [];
    const q0 = { x: 0, y: 0, z: Math.sin(rot / 2), w: Math.cos(rot / 2) };
    const toW = p => { const q = rotZ(rot, p); return [q[0] + o.x, q[1] + o.y, q[2] + (o.z || 0)]; };
    const groups = (0x0002 << 16) | 0x0001;   // Teile stoßen nur mit der Welt zusammen
    const byName = {};
    for (const p of skel.parts) {
      const a = P[p.a], b = P[p.b], c = mid(a, b), cw = toW(c), len = Math.hypot(...sub(b, a));
      const desc = R.RigidBodyDesc.dynamic().setTranslation(cw[0] * vs, cw[1] * vs, cw[2] * vs).setRotation(q0)
        .setLinearDamping(0.2).setAngularDamping(1.5).setCcdEnabled(true);
      const body = W.createRigidBody(desc);
      const v = o.vel || [0, 0, 0];
      body.setLinvel({ x: v[0] * vs, y: v[1] * vs, z: v[2] * vs }, true);
      const col = p.box
        ? R.ColliderDesc.cuboid(p.box[0] * vs, p.box[1] * vs, Math.max(0.05, len / 2) * vs)
        : R.ColliderDesc.capsule(Math.max(0.02, len / 2 - p.r * 0.5) * vs, p.r * vs).setRotation(quatFromY(sub(b, a)));
      col.setDensity(p.w).setFriction(0.9).setRestitution(0.05).setCollisionGroups(groups);
      W.createCollider(col, body);
      this.bodies.push(body); byName[p.name] = { body, c };
    }
    if (o.hit && o.hitVel && byName[o.hit]) { const v = o.hitVel; byName[o.hit].body.setLinvel({ x: v[0] * vs, y: v[1] * vs, z: v[2] * vs }, true); }
    // Gelenke: Kugelgelenke, Ellbogen und Knie als Scharnier um die Querachse (wie rapierjs-ragdoll)
    for (const p of skel.parts) {
      if (!p.parent) continue;
      const A = byName[p.parent], B = byName[p.name], j = P[p.joint];
      const a1 = sub(j, A.c), a2 = sub(j, B.c), v3 = u => ({ x: u[0] * vs, y: u[1] * vs, z: u[2] * vs });
      let jd;
      if (p.hinge) {
        jd = R.JointData.revolute(v3(a1), v3(a2), { x: 0, y: 1, z: 0 });
        jd.limitsEnabled = true; jd.limits = p.name.startsWith('shin') ? [-2.4, 0.05] : [-0.05, 2.4];   // ältere Versionen
      } else jd = R.JointData.spherical(v3(a1), v3(a2));
      const jt = W.createImpulseJoint(jd, A.body, B.body, true);
      if (p.hinge && jt.setLimits) jt.setLimits(...jd.limits);
      if (jt.setContactsEnabled) jt.setContactsEnabled(false);
    }
    sys.ensureGround(o.x, o.y);
  }
  step(dt) {
    this.age += dt;
    if (this.bodies.every(b => b.isSleeping()) || this.age > 8) this.sleeping = true;
  }
  pose() {
    const vs = this.sys.vs;
    return this.bodies.map(b => { const t = b.translation(); return { c: [t.x / vs, t.y / vs, t.z / vs], R: quatToMat(b.rotation()) }; });
  }
  dispose() { for (const b of this.bodies) this.sys.W.removeRigidBody(b); this.bodies = []; }
}
class RapierWorld {
  constructor(R, world) {
    this.R = R; this.world = world; this.backend = 'rapier'; this.vs = world.voxelSize || 0.2; this.list = [];
    this.W = new R.World({ x: 0, y: 0, z: -9.81 });
    this.cols = new Map();
  }
  /** Feste Quader für die Säulen um (x, y) (Säulenhöhe aus world.height; Wände reichen bis oben). */
  ensureGround(x, y, rad = 14) {
    const R = this.R, vs = this.vs, w = this.world;
    for (let yy = Math.floor(y) - rad; yy <= Math.floor(y) + rad; yy++) for (let xx = Math.floor(x) - rad; xx <= Math.floor(x) + rad; xx++) {
      const h = w.height(xx, yy), key = xx + ',' + yy, old = this.cols.get(key);
      if (old && old.h === h) continue;
      if (old) this.W.removeCollider(old.c, false);
      if (h <= 0) { this.cols.delete(key); continue; }
      const c = this.W.createCollider(R.ColliderDesc.cuboid(0.5 * vs, 0.5 * vs, h / 2 * vs).setTranslation((xx + 0.5) * vs, (yy + 0.5) * vs, h / 2 * vs).setFriction(0.9));
      this.cols.set(key, { c, h });
    }
  }
  spawn(skel, o) { const r = new RapierRagdoll(this, skel, o); this.list.push(r); return r; }
  remove(r) { r.dispose?.(); this.list = this.list.filter(x => x !== r); }
  step(dt) {
    this.W.timestep = Math.min(dt, 1 / 30);
    this.W.step();
    for (const r of this.list) r.step(dt);
    for (const r of this.list) if (r.sleeping && !r.keep) r.dispose();
    this.list = this.list.filter(r => !r.sleeping || r.keep);
  }
}

// ---------------------------------------------------------------- Einstieg
let rapierPromise = null;
/** Rapier einmal laden (WASM ist im compat-Paket eingebettet). */
export function loadRapier(url = RAPIER_URL) {
  if (!rapierPromise) rapierPromise = import(url).then(async m => { const R = m.default?.World ? m.default : (m.World ? m : m.default); await R.init(); return R; });
  return rapierPromise;
}
/**
 * Physikwelt für Ragdolls. backend: 'auto' (Rapier versuchen, sonst Verlet), 'rapier' oder 'verlet'.
 * timeout: so lange (ms) wird auf Rapier gewartet.
 */
export async function createRagdollWorld(world, o = {}) {
  const want = o.backend || 'auto';
  if (want !== 'verlet') {
    try {
      const R = await Promise.race([loadRapier(o.rapierUrl), new Promise((_, rej) => setTimeout(() => rej(new Error('Zeitüberschreitung')), o.timeout ?? 6000))]);
      return new RapierWorld(R, world);
    } catch (e) {
      if (want === 'rapier') throw e;
      console.warn('Rapier nicht verfügbar, nutze Verlet-Ragdoll:', e.message || e);
    }
  }
  return new VerletWorld(world, o);
}
/** Sofort verfügbare Verlet-Welt (ohne await), z. B. für Tests. */
export function createVerletWorld(world, o) { return new VerletWorld(world, o); }
