// Kleine Welt: zweite Szene über dieselbe Engine-API wie Totenstadt.
// Zeigt: eigene Kachel-Generierung, Grundriss-Grammatik, freie Kamera, Tageszeit, ECS mit Flow Field,
// und bleibende Änderungen (Deltas), die das Neubacken über Kachelgrenzen auslösen.
import {
  World, Renderer, Camera, Streamer, LocalBackend, Particles, ECS, movementSystem, FlowField, Input,
  skyAt, flicker, nearestLights, planRooms, buildStack, C, E, FLAG, jit, shade, hash3, vnoise, ri, pick,
} from '../../engine/index.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const TS = 48, N = 3, H = 32, WALL = 12, DOOR = 4;

// ---------------------------------------------------------------- Welt
const lamps = [], fires = [];
function generate(tile, vol, { rng, ox, oy, add }) {
  const S = (x, y, z, c, l = 0) => { if (x >= 0 && y >= 0 && x < TS && y < TS) vol.set(x, y, z, c, l); };
  // Boden: Wiese mit Weg
  for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
    const gx = ox + x, gy = oy + y, h = hash3(gx, gy, 1);
    const path = Math.abs(gx - 72 + Math.sin(gy / 13) * 6) < 2.5 || Math.abs(gy - 100 + Math.sin(gx / 11) * 5) < 2.5;
    S(x, y, 0, C(path ? jit(0x7a6a50, 0.25, h) : vnoise(gx / 9, gy / 9, 2) > 0.6 ? jit(0x4a6a2a, 0.3, h) : jit(0x3a5a26, 0.3, h)));
  }
  const tree = (x, y) => {
    const th = ri(rng, 7, 10);
    for (let z = 1; z <= th; z++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) S(x + dx, y + dy, z, C(jit(0x5a3e26, 0.2, hash3(x + dx, y + dy, z))));
    const r = 4 + rng() * 2, cz = th + r - 1, leaf = pick(rng, [0x3a6a2a, 0x4a7a2a, 0x2e5a2a]);
    for (let z = Math.floor(cz - r); z <= cz + r && z < H; z++) for (let dy = -7; dy <= 7; dy++) for (let dx = -7; dx <= 7; dx++)
      if (Math.hypot(dx, dy, (z - cz) * 1.2) < r - hash3(ox + x + dx, oy + y + dy, z)) S(x + dx, y + dy, z, C(jit(leaf, 0.4, hash3(ox + x + dx, oy + y + dy, z + 7))));
  };
  const lamp = (x, y) => {
    for (let z = 1; z <= 14; z++) S(x, y, z, C(0x3a3c42));
    S(x, y, 15, E(0xffd9a0));
    add('lamp', { x: ox + x + 0.5, y: oy + y + 0.5, z: 15, r: 40, c: [1, 0.75, 0.45], i: 1.4, type: 'lamp', seed: rng() * 100 });
  };
  if (tile.tx === 1 && tile.ty === 1) {
    // Haus aus der Grundriss-Grammatik der Engine
    const w = 30, d = 24, gx = 9, gy = 8, plan = planRooms(rng, w, d, 2, { min: 9, doorW: DOOR, windowW: 5 });
    const wall = new Uint8Array(w * d);
    for (const r of plan.rooms) for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) if (x === r.x0 || x === r.x1 || y === r.y0 || y === r.y1) wall[y * w + x] = 1;
    for (let y = 0; y < d; y++) for (let x = 0; x < w; x++) {
      S(gx + x, gy + y, 0, C(jit(0x6e5236, 0.25, hash3(x / 3 | 0, y, 4))));
      if (wall[y * w + x]) for (let z = 1; z <= WALL; z++) S(gx + x, gy + y, z, C(z % 4 === 0 ? 0xb8ae98 : jit(0xd8ceb8, 0.08, hash3(x, y, z))), z >= 5 ? FLAG.WALLTOP : 0);
    }
    for (const wn of plan.windows) for (let k = 0; k < wn.len; k++) for (let z = 5; z <= 9; z++) S(gx + (wn.hz ? wn.x + k : wn.x), gy + (wn.hz ? wn.y : wn.y + k), z, E(0xf0c070), FLAG.WALLTOP);
    for (const dr of [...plan.doors, plan.frontDoor]) for (let k = 0; k < DOOR; k++) for (let z = 1; z <= 9; z++) S(gx + (dr.v ? dr.x : dr.x + k), gy + (dr.v ? dr.y + k : dr.y), z, 0);
    for (let k = 0; ; k++) {   // Walmdach
      const ax = gx - 1 + k, bx = gx + w - k, ay = gy - 1 + k, by = gy + d - k, z = WALL + 1 + k;
      if (bx - ax < 1 || by - ay < 1 || z >= H) break;
      for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++)
        S(x, y, z, C(jit(0x7a3426, 0.2, hash3(x, y >> 1, z))), FLAG.ROOF);
    }
    add('house', { x0: ox + gx, y0: oy + gy, x1: ox + gx + w - 1, y1: oy + gy + d - 1 });
  } else {
    for (let k = 0; k < 4; k++) { const x = ri(rng, 4, TS - 6), y = ri(rng, 4, TS - 6); if (Math.abs(ox + x - 72) > 6 && Math.abs(oy + y - 100) > 6) tree(x, y); }
    if (rng() < 0.5) lamp(ri(rng, 6, TS - 6), ri(rng, 6, TS - 6));
    if (tile.tx === 0 && tile.ty === 2) {   // Lagerfeuer
      for (let a = 0; a < 10; a++) S(24 + Math.round(Math.cos(a / 10 * 6.28) * 3), 24 + Math.round(Math.sin(a / 10 * 6.28) * 3), 1, C(0x6a6a66));
      S(24, 24, 1, E(0xff8a2a)); S(25, 24, 1, E(0xffb040));
      add('fire', { x: ox + 24.5, y: oy + 24.5, z: 4, r: 55, c: [1, 0.55, 0.2], i: 2, type: 'fire', seed: 3 });
    }
  }
}
// Generator-Beschreibung wie für einen Worker; hier synchron über LocalBackend (die Welt ist klein)
const GEN = { tileSize: TS, tilesX: N, tilesY: N, height: H, version: 1, generate };
const world = new World({ tileSize: TS, tilesX: N, tilesY: N, height: H, seed: 77, version: 1 });
const backend = new LocalBackend(GEN, 77);
world.builder = backend.builder;
world.on('entities', (t, list) => {
  for (const { type, data } of list) {
    if (type === 'lamp') lamps.push(data); else if (type === 'fire') fires.push(data); else if (type === 'house') t.data.house = data;
  }
});

// ---------------------------------------------------------------- Darstellung
const R = new Renderer($('gl'), { zMax: H + 2 });
R.attachWorld(world, N);
const stream = new Streamer(world, R, { backend, radius: 1, keep: 2 });
const cam = new Camera({ x: 72, y: 72, zoom: 5, pitch: 0.9, yaw: 0.6, minZoom: 2, maxZoom: 16 });
const parts = new Particles();
const ov = $('ov'), octx = ov.getContext('2d');
const DPR = Math.min(devicePixelRatio || 1, 2) / 1.5;
function resize() {
  const w = Math.ceil(innerWidth * DPR), h = Math.ceil(innerHeight * DPR);
  R.resize(w, h); ov.width = w; ov.height = h; cam.setSize(w, h);
}
addEventListener('resize', resize); resize();
stream.update(72, 72); stream.run(1e9);

// Figur: einfache Kapselgestalt, 4-fache Dichte
const cap = (u, v, s, ax, ay, az, bx, by, bz, r) => {
  const dx = bx - ax, dy = by - ay, dz = bz - az, px = u - ax, py = v - ay, pz = s - az;
  const t = Math.max(0, Math.min(1, (px * dx + py * dy + pz * dz) / (dx * dx + dy * dy + dz * dz)));
  return Math.hypot(px - dx * t, py - dy * t, pz - dz * t) - r;
};
const figure = (sw, shirt) => buildStack(28, 28, 40, (x, y, z) => {
  const u = x / 4, v = y / 4, s = (z + 0.5) / 4;
  if (Math.hypot(u, v, s - 8.4) < 0.85) return C(s > 8.9 ? 0x3a2a1a : 0xd0a080);
  if (Math.abs(u) < 0.8 && Math.abs(v) < 1.2 && s > 4.8 && s < 7.7) return C(jit(shirt, 0.1, hash3(x, y, z)));
  for (const k of [-1, 1]) {
    if (cap(u, v, s, 0, k * 0.55, 4.8, sw * k, k * 0.55, 0.5, 0.45) < 0) return C(0x2a3a5a);
    if (cap(u, v, s, 0, k * 1.4, 7.4, -sw * k * 0.8, k * 1.5, 5.2, 0.35) < 0) return C(jit(shirt, 0.1, 0.5));
  }
  return 0;
});
const WALK = [0, 0.9, 0.1, -0.9, -0.1];
const SPR = [0x8a3a2a, 0x2a6a8a].map(col => R.createSprite(WALK.map(sw => figure(sw, col))));

// ---------------------------------------------------------------- ECS: zwei Bewohner gehen zwischen Zielen hin und her
const ecs = new ECS();
const targets = [[30, 120], [72, 50], [120, 120], [110, 30], [72, 100]];
for (let i = 0; i < 2; i++) ecs.create({ pos: { x: 72 + i * 8, y: 110 }, vel: { x: 0, y: 0 }, body: { r: 1 }, walker: { goal: i, field: new FlowField(world), t: 0, walk: 0, rot: 0, spr: SPR[i] } });
ecs.addSystem((e, dt) => {
  for (const [, pos, vel, , w] of e.query('pos', 'vel', 'body', 'walker')) {
    const [gx, gy] = targets[w.goal];
    w.t -= dt;
    if (w.t <= 0) { w.field.compute(gx, gy, 300); w.t = 1; }
    if (Math.hypot(gx - pos.x, gy - pos.y) < 3) { w.goal = (w.goal + 1 + (hash3(w.goal, pos.x | 0, 1) * 3 | 0)) % targets.length; w.t = 0; }
    const d = w.field.dir(pos.x, pos.y) || [0, 0];
    vel.x = d[0] * 6; vel.y = d[1] * 6;
    if (d[0] || d[1]) { let da = Math.atan2(d[1], d[0]) - w.rot; da = Math.atan2(Math.sin(da), Math.cos(da)); w.rot += da * Math.min(1, dt * 6); }
  }
});
ecs.addSystem(movementSystem(world));
ecs.addSystem((e, dt) => { for (const [, , body, w] of e.query('pos', 'body', 'walker')) w.walk += body.moved || 0; });

// ---------------------------------------------------------------- Eingabe: Kamera und Wegschlagen
let hour = params.has('zeit') ? +params.get('zeit') : 17;
$('zeit').value = hour; $('zeit').oninput = e => { hour = +e.target.value; };
const input = new Input(ov, {
  onCamera: (dy, dp, zf) => { cam.rotate(dy); cam.tilt(dp); if (zf !== 1) cam.zoomBy(zf); },
  cameraHandle: $('cam'), onCameraTap: () => cam.rotate(Math.PI / 2),
});
let down = null;
ov.addEventListener('pointerdown', e => { if (e.button === 0) down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
ov.addEventListener('pointerup', e => {
  if (!down || e.button !== 0) return;
  if (Math.hypot(e.clientX - down.x, e.clientY - down.y) < 8 && performance.now() - down.t < 400) smash(e.clientX * DPR, e.clientY * DPR);
  down = null;
});
/** Obersten Voxel unter dem Bildschirmpunkt suchen und eine Kugel wegschlagen. */
function smash(sx, sy) {
  for (let z = H - 1; z >= 1; z--) {
    const [x, y] = cam.unproject(sx, sy, z + 0.5);
    if (!world.getC(x | 0, y | 0, z)) continue;
    const cx = x | 0, cy = y | 0, r = 2.2;
    for (let dz = -3; dz <= 3; dz++) for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++)
      if (Math.hypot(dx, dy, dz) <= r && z + dz >= 1) {
        const c = world.getC(cx + dx, cy + dy, z + dz);
        if (c) { world.edit(cx + dx, cy + dy, z + dz, 0); if (Math.random() < 0.3) parts.emit('spark', cx + dx, cy + dy, z + dz, 1, { speed: 6, vz: 8, life: 0.6 }); }
      }
    world.commit(cx - 4, cy - 4, cx + 4, cy + 4);   // Abfragen, Höhenkarte und Neubacken (auch über Kachelgrenzen)
    return;
  }
}

// ---------------------------------------------------------------- Schleife
let last = performance.now();
function step(now) {
  requestAnimationFrame(step);
  const dt = Math.min(0.05, (now - last) / 1000); last = now; const t = now / 1000;
  ecs.update(dt);
  parts.update(dt);
  cam.update(dt);
  const sky = skyAt(hour);
  R.begin(cam);
  const house = world.tileOf(1, 1).data.house;
  const inside = [...ecs.query('pos', 'walker')].some(([, p]) => p.x >= house.x0 && p.x <= house.x1 && p.y >= house.y0 && p.y <= house.y1);
  R.drawWorld({ cut: inside ? [house.x0 - 1, house.y0 - 1, house.x1 + 2, house.y1 + 2] : null });
  const lights = [null];
  for (const [, pos, w] of ecs.query('pos', 'walker')) {
    R.drawSprite(w.spr, w.walk > 0 ? 1 + (Math.floor(w.walk / 2.4) % 4) : 0, pos.x, pos.y, w.rot, { dens: 4, shadow: 1, xray: true });
    if (sky.night > 0.4) lights.push({ x: pos.x, y: pos.y, z: 6, r: 22, color: [0.9, 0.7, 0.4] });
  }
  for (const L of nearestLights([...fires, ...(sky.night > 0.3 ? lamps : [])], cam.x, cam.y, 8 - lights.length, 200)) {
    const f = flicker(L, t) * L.i; lights.push({ x: L.x, y: L.y, z: L.z, r: L.r, color: L.c.map(c => c * f) });
  }
  R.light({ ambient: sky.ambient, sunColor: sky.sun, lights, eye: [cam.x, cam.y, 9], los: false, quant: 28, time: t });
  octx.clearRect(0, 0, ov.width, ov.height);
  parts.draw(octx, cam);
  $('zeitTxt').textContent = `${String(Math.floor(hour)).padStart(2, '0')}:${String(Math.round(hour % 1 * 60)).padStart(2, '0')}`;
  const deltas = [...world.tiles.values()].reduce((a, t) => a + t.deltas.size, 0);
  $('info').textContent = `Deltas: ${deltas} · Instanzen ${R.stats.insts} · Draw-Calls ${R.stats.calls}`;
}
requestAnimationFrame(step);
window.VE_DEMO = { cam, R, world, ecs };
window.VE_READY = true;
