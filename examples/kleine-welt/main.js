// Kleine Welt: zweite Szene über dieselbe Engine-API wie Totenstadt.
// Zeigt: Grunddichte 20/10/5 cm (?dichte=), Unterteilung (?sub=), Generator im Worker, freie Kamera, Tageszeit,
// ECS mit Flow Field, Zerstörung mit Block-Partikeln und Tragfähigkeit (Carport), Emitter (Glut, Sand).
import {
  World, Renderer, Camera, Streamer, LocalBackend, WorkerBackend, Particles, ECS, movementSystem, FlowField, Input,
  Debris, carve, shatter, checkSupport, drop, skyAt, flicker, nearestLights, buildStack, C, jit, hash3,
} from '../../engine/index.js';
import { createGenerator, layout } from './welt.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const CM = [20, 10, 5].includes(+params.get('dichte')) ? +params.get('dichte') : 20;
const vs = CM / 100, SUB = params.has('sub') ? +params.get('sub') : (CM === 20 ? 4 : CM === 10 ? 2 : 1);
const { TS, N, H, L } = layout(vs), M = m => m / vs;
const SEED = 77;
$('dichte').value = String(CM);
$('dichte').onchange = e => { params.set('dichte', e.target.value); params.delete('sub'); location.search = params.toString(); };

// ---------------------------------------------------------------- Welt und Streaming (Worker, sonst synchron)
const world = new World({ tileSize: TS, tilesX: N, tilesY: N, height: H, seed: SEED, version: 2, voxelSize: vs, sub: SUB });
const config = { seed: SEED, vs, sub: SUB };
let backend;
const local = () => { backend = new LocalBackend(createGenerator(config), SEED); world.builder = backend.builder; };
if (typeof Worker !== 'undefined' && !params.has('ohneWorker')) {
  try { backend = new WorkerBackend(new URL('./welt.js', import.meta.url), config); } catch (e) { local(); }
} else local();

const lamps = [], fires = [];
let house = null, carport = null, sand = null;
world.on('entities', (t, list) => {
  for (const { type, data } of list) {
    if (type === 'lamp') lamps.push(data); else if (type === 'fire') fires.push(data);
    else if (type === 'house') house = data; else if (type === 'carport') carport = data; else if (type === 'sand') sand = data;
  }
});

const R = new Renderer($('gl'), { zMax: H + 2 });
R.attachWorld(world, N);
const cam = new Camera({ x: M(L / 2), y: M(L / 2), zoom: 5 * vs / 0.2, pitch: 0.9, yaw: 0.6, minZoom: 2 * vs / 0.2, maxZoom: 20 * vs / 0.2, lift: M(1) });
const parts = new Particles();
const debris = new Debris(world, { max: 3000 });
const ov = $('ov'), octx = ov.getContext('2d');
const DPR = Math.min(devicePixelRatio || 1, 2) / 1.5;
function resize() {
  const w = Math.ceil(innerWidth * DPR), h = Math.ceil(innerHeight * DPR);
  R.resize(w, h); ov.width = w; ov.height = h; cam.setSize(w, h);
}
addEventListener('resize', resize); resize();

// Figur in Metern bei 5 cm Auflösung; Dichte relativ zur Welt
const FIG = 0.05, dens = vs / FIG;
const cap = (u, v, s, ax, ay, az, bx, by, bz, r) => {
  const dx = bx - ax, dy = by - ay, dz = bz - az, px = u - ax, py = v - ay, pz = s - az;
  const t = Math.max(0, Math.min(1, (px * dx + py * dy + pz * dz) / (dx * dx + dy * dy + dz * dz)));
  return Math.hypot(px - dx * t, py - dy * t, pz - dz * t) - r;
};
const figure = (sw, shirt) => buildStack(16, 16, 38, (x, y, z) => {
  const u = x * FIG, v = y * FIG, s = (z + 0.5) * FIG;     // Meter
  if (Math.hypot(u, v, s - 1.62) < 0.15) return C(s > 1.7 ? 0x3a2a1a : 0xd0a080);
  if (Math.abs(u) < 0.13 && Math.abs(v) < 0.22 && s > 0.9 && s < 1.45) return C(jit(shirt, 0.1, hash3(x, y, z)));
  for (const k of [-1, 1]) {
    if (cap(u, v, s, 0, k * 0.1, 0.9, sw * k * 0.2, k * 0.1, 0.08, 0.075) < 0) return C(0x2a3a5a);
    if (cap(u, v, s, 0, k * 0.27, 1.4, -sw * k * 0.15, k * 0.29, 0.95, 0.06) < 0) return C(jit(shirt, 0.1, 0.5));
  }
  return 0;
});
const WALK = [0, 0.9, 0.1, -0.9, -0.1];
const SPR = [0x8a3a2a, 0x2a6a8a].map(col => R.createSprite(WALK.map(sw => figure(sw, col))));

// ---------------------------------------------------------------- ECS: zwei Bewohner gehen zwischen Zielen hin und her
const ecs = new ECS();
const targets = [[0.15, 0.85], [0.5, 0.2], [0.85, 0.85], [0.8, 0.1], [0.5, 0.65]].map(([a, b]) => [M(L * a), M(L * b)]);
for (let i = 0; i < 2; i++) ecs.create({ pos: { x: M(L * 0.5) + i * M(1.5), y: M(L * 0.7) }, vel: { x: 0, y: 0 }, body: { r: M(0.22) }, walker: { goal: i, field: new FlowField(world, M(L * 1.2)), t: 0, walk: 0, rot: 0, spr: SPR[i] } });
ecs.addSystem((e, dt) => {
  for (const [, pos, vel, , w] of e.query('pos', 'vel', 'body', 'walker')) {
    const [gx, gy] = targets[w.goal];
    w.t -= dt;
    if (w.t <= 0) { w.field.compute(gx, gy); w.t = 1; }
    if (Math.hypot(gx - pos.x, gy - pos.y) < M(0.6)) { w.goal = (w.goal + 1 + (hash3(w.goal, pos.x | 0, 1) * 3 | 0)) % targets.length; w.t = 0; }
    const d = w.field.dir(pos.x, pos.y) || [0, 0];
    vel.x = d[0] * M(1.2); vel.y = d[1] * M(1.2);
    if (d[0] || d[1]) { let da = Math.atan2(d[1], d[0]) - w.rot; da = Math.atan2(Math.sin(da), Math.cos(da)); w.rot += da * Math.min(1, dt * 6); }
  }
});
ecs.addSystem(movementSystem(world));
ecs.addSystem((e) => { for (const [, , body, w] of e.query('pos', 'body', 'walker')) w.walk += (body.moved || 0) * vs / 0.2; });

// ---------------------------------------------------------------- Eingabe
let hour = params.has('zeit') ? +params.get('zeit') : 17;
$('zeit').value = hour; $('zeit').oninput = e => { hour = +e.target.value; };
let settle = true;
$('liegen').checked = settle; $('liegen').onchange = e => { settle = e.target.checked; };
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
/** Oberste belegte Stelle unter dem Bildschirmpunkt suchen, eine Kugel ausschneiden, Trümmer, Tragfähigkeit. */
function smash(sx, sy) {
  for (let z = H - 1; z >= 1; z--) {
    const [x, y] = cam.unproject(sx, sy, z + 0.5);
    if (!world.getC(x | 0, y | 0, z) && !world.getFine(Math.floor(x * SUB), Math.floor(y * SUB), Math.floor((z + 0.5) * SUB))) continue;
    return smashAt(x, y, z + 0.5);
  }
  return null;
}
function smashAt(x, y, z) {
  const r = M(0.45);
  const { removed } = carve(world, x, y, z, r);
  shatter(debris, removed, { settle, from: [x, y, z - r * 0.5], speed: M(2.5), max: 300, lift: M(1) });
  const sup = checkSupport(world, Math.floor(x - M(4)), Math.floor(y - M(4)), Math.floor(x + M(4)), Math.floor(y + M(4)));
  for (const g of sup.groups) {
    // kleine Gruppen zerfallen in Partikel, große fallen als Ganzes und stauben beim Aufschlag
    if (g.length <= 300) shatter(debris, g, { settle, speed: M(0.8), max: 300, lift: 0 });
    else { const { pieces } = drop(world, g); shatter(debris, pieces.filter((p, k) => k % Math.ceil(pieces.length / 120) === 0), { settle: false, speed: M(1.5), lift: M(1.5), life: 1.2 }); }
  }
  return { removed: removed.length, detached: sup.detached.length };
}
// Emitter: Glut am Feuer (verschwindet), Sand über dem Sandkasten (bleibt liegen, an/aus)
let embers = null, sandE = null;
$('sand').onclick = () => {
  if (!sand) return;
  if (sandE) { sandE.active = !sandE.active; } else sandE = debris.emitter({ x: sand.x, y: sand.y, z: M(2.2), rate: CM === 5 ? 60 : 25, shape: 'sphere', extent: M(0.15), dir: [0, 0, -1], spread: 0.25, speed: [M(0.2), M(0.6)], colors: [0xd8c080, 0xc8b070, 0xe0cc90], settle: true, size: 1 / SUB, life: [20, 20] });
  $('sand').textContent = sandE.active ? 'Sand aus' : 'Sand an';
};

// ---------------------------------------------------------------- Schleife
const stream = new Streamer(world, R, { backend, radius: Math.floor(N / 2), keep: N });
let last = performance.now();
function step(now) {
  requestAnimationFrame(step);
  const dt = Math.min(0.05, (now - last) / 1000); last = now; const t = now / 1000;
  stream.update(M(L / 2), M(L / 2)); stream.run(8);
  if (!embers && fires.length) embers = debris.emitter({ x: fires[0].x, y: fires[0].y, z: M(0.15), rate: 14, shape: 'box', extent: [M(0.3), M(0.3), 0], dir: [0, 0, 1], spread: 0.5, speed: [M(0.6), M(1.4)], colors: [0xffa030, 0xff7020, 0xffd060], size: 1 / Math.max(2, SUB), life: [0.6, 1.4], settle: false, bounce: 0.1 });
  ecs.update(dt);
  debris.update(dt); debris.commit();
  parts.update(dt);
  cam.update(dt);
  const sky = skyAt(hour);
  R.begin(cam);
  const inside = house && [...ecs.query('pos', 'walker')].some(([, p]) => p.x >= house.x0 && p.x <= house.x1 && p.y >= house.y0 && p.y <= house.y1);
  R.drawWorld({ cut: inside ? [house.x0 - 1, house.y0 - 1, house.x1 + 2, house.y1 + 2] : null });
  R.drawDebris(debris.list);
  const lights = [null];
  for (const [, pos, w] of ecs.query('pos', 'walker')) {
    R.drawSprite(w.spr, w.walk > 0 ? 1 + (Math.floor(w.walk / 2.4) % 4) : 0, pos.x, pos.y, w.rot, { dens, shadow: 1, xray: true });
    if (sky.night > 0.4) lights.push({ x: pos.x, y: pos.y, z: M(1.2), r: M(4.4), color: [0.9, 0.7, 0.4] });
  }
  for (const Lt of nearestLights([...fires, ...(sky.night > 0.3 ? lamps : [])], cam.x, cam.y, 64, M(40))) {
    const f = flicker(Lt, t) * Lt.i; lights.push({ x: Lt.x, y: Lt.y, z: Lt.z, r: Lt.r, color: Lt.c.map(c => c * f) });
  }
  R.light({ ambient: sky.ambient, sunColor: sky.sun, sunDir: sky.night < 0.6 ? sky.dir : null, lights, eye: [cam.x, cam.y, M(1.8)], los: false, quant: 28, time: t });
  octx.clearRect(0, 0, ov.width, ov.height);
  parts.draw(octx, cam);
  $('zeitTxt').textContent = `${String(Math.floor(hour)).padStart(2, '0')}:${String(Math.round(hour % 1 * 60)).padStart(2, '0')}`;
  let deltas = 0, bricks = 0; for (const tl of world.tiles.values()) { deltas += tl.deltas.size + tl.brickDeltas.size; if (tl.vol) bricks += tl.vol.bricks.size; }
  $('info').textContent = `${CM} cm, Unterteilung ${SUB}×${SUB}×${SUB} · Deltas ${deltas} · Bricks ${bricks} · Partikel ${debris.list.length} · Instanzen ${R.stats.insts}`;
}

(async () => {
  if (backend.ready) {
    try { await Promise.race([backend.ready, new Promise((_, r) => setTimeout(() => r(new Error('Zeit')), 8000))]); }
    catch (e) { backend.terminate(); local(); stream.backend = backend; }
  }
  await stream.fill(M(L / 2), M(L / 2), (a, n) => { $('info').textContent = `Baue Kacheln ${a} / ${n} …`; });
  cam.follow(M(L / 2), M(L / 2)); cam.snap();
  window.VE_READY = true;
  requestAnimationFrame(step);
})();
window.VE_DEMO = { cam, R, world, ecs, debris, smash, smashAt, get carport() { return carport; }, get sand() { return sand; }, get sandE() { return sandE; }, checkSupport, SUB, vs, M };
