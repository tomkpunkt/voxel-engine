// Totenstadt – Zombie-Shooter auf der Voxel-Engine. Spielregeln, KI, Inventar und HUD stehen hier,
// Welt, Streaming, Darstellung, Licht, Wegfindung und Eingabe kommen aus der Engine.
import { Renderer } from '../../engine/render/renderer.js';
import { Camera } from '../../engine/render/camera.js';
import { Particles } from '../../engine/render/particles.js';
import { Streamer } from '../../engine/stream/streamer.js';
import { FlowField } from '../../engine/ecs/flowfield.js';
import { skyAt, flicker, nearestLights } from '../../engine/light/light.js';
import { vnoise } from '../../engine/core/rand.js';
import { Input } from '../../engine/platform/input.js';
import { Synth } from '../../engine/platform/audio.js';
import { SCALE, TS, GN, W, H, VPM, DOOR_H, DOOR_W } from './scale.js';
import { TILES, doorCells, doorCenter } from './city.js';
import { createCity } from './stadt.js';
import { SD, survivorFn, zombieFn, figureStack, flameStack, WALK } from './models.js';
import { WEAP, ITEMS, rollLoot } from './data.js';

const $ = id => document.getElementById(id);
const glc = $('gl'), ov = $('ov'), octx = ov.getContext('2d');
const params = new URLSearchParams(location.search);

// =====================================================================
//  ZUSTAND
// =====================================================================
const PR = SCALE.figur.radius, ZR = 1.2;
const SPEED = { walk: 9, run: 15, zWander: 2.5, zInvest: 4, zChase: 5.5, zFast: 11 };   // Voxel/s (5 = 1 m/s)
let seed = params.has('saat') ? +params.get('saat') : (Math.random() * 1e9) | 0;
const HOUR = params.has('zeit') ? +params.get('zeit') : 0;        // Tageszeit 0…24, Standard Mitternacht
let city, world, stream, field;
let running = false, paused = false, gameTime = 0, kills = 0;
let P, inv, zombies = [], corpses = [], drops = [];
let TPG, TPM, TZ = [], TFL;
let flash = 0, nextBolt = 25, thunderT = -1, muzzleT = 0, openCont = null, toastT = 0, fieldT = 0;
let RS = 1, frameAvg = 0.016, slowT = 0, lastAimT = -9;

const R = new Renderer(glc, { zMax: 34 });
const cam = new Camera({ pitch: 52 * Math.PI / 180, yaw: Math.PI / 4 });
const parts = new Particles();
const synth = new Synth();

function newPlayer() {
  return { x: city.spawn.x, y: city.spawn.y, rot: 0, aim: 0, hp: 100, bat: 100, st: 100, stRest: 0, winded: false, running: false, light: true, weapon: 'pistol', mags: { pistol: 12 },
    fireT: 0, reloadT: 0, reloading: null, walk: 0, frame: 0, hurtT: 0, swingT: 0, moving: false };
}
const invCount = id => inv.reduce((a, s) => a + (s.id === id ? s.n : 0), 0);
function addItem(id, n) {
  const st = ITEMS[id].st;
  for (const s of inv) if (s.id === id && s.n < st) { const k = Math.min(n, st - s.n); s.n += k; n -= k; if (!n) break; }
  while (n > 0 && inv.length < 16) { const k = Math.min(n, st); inv.push({ id, n: k }); n -= k; }
  if (ITEMS[id].t === 'w' && P.mags[id] === undefined) P.mags[id] = Math.floor(Math.random() * (WEAP[id].mag || 0));
  return n;
}
function removeItem(id, n) {
  for (let i = inv.length - 1; i >= 0 && n > 0; i--) if (inv[i].id === id) { const k = Math.min(n, inv[i].n); inv[i].n -= k; n -= k; if (!inv[i].n) inv.splice(i, 1); }
  if (ITEMS[id] && ITEMS[id].t === 'w' && P.weapon === id && !invCount(id)) P.weapon = 'fists';
}
const ownedWeapons = () => ['fists', ...Object.keys(WEAP).filter(k => k !== 'fists' && invCount(k))];
const tileOn = key => R.resident(world.tiles.get(key));

// =====================================================================
//  TÜREN
// =====================================================================
function applyDoor(dr) { city.applyDoor(dr); fieldT = 0; }
function toggleDoor(dr) {
  if (dr.broken) return;
  if (dr.open) {   // nicht schließen, wenn jemand in der Tür steht
    const g = doorCells(dr).gap, occ = e => g.some(([x, y]) => Math.abs(e.x - x - 0.5) < PR + 0.6 && Math.abs(e.y - y - 0.5) < PR + 0.6);
    if (occ(P) || zombies.some(z => !z.dead && occ(z))) { toast('Etwas steht in der Tür'); return; }
  }
  dr.open = !dr.open; applyDoor(dr);
  synth.tone(dr.open ? 240 : 180, dr.open ? 300 : 120, 0.18, 'triangle', 0.15, 0, 900);
  makeNoise(P.x, P.y, 12);
}

// =====================================================================
//  TON
// =====================================================================
const volAt = (x, y) => Math.max(0, 1 - Math.hypot(x - P.x, y - P.y) / 90);
const SND = {
  pistol: () => { synth.noise(0.18, 2200, 0.7, 0.9); synth.tone(180, 60, 0.12, 'square', 0.22); },
  shotgun: () => { synth.noise(0.35, 1400, 0.5, 1.2); synth.tone(120, 40, 0.25, 'sawtooth', 0.3); },
  rifle: () => { synth.noise(0.12, 2600, 0.8, 0.7); synth.tone(200, 80, 0.08, 'square', 0.18); },
  empty: () => synth.tone(1800, 1700, 0.03, 'square', 0.1),
  reload: () => { synth.tone(900, 600, 0.05, 'square', 0.12); synth.tone(700, 1100, 0.05, 'square', 0.12, 0.3); },
  swing: () => synth.noise(0.15, 800, 3, 0.35, 'bandpass'),
  hit: (v = 1) => { synth.noise(0.12, 500, 1, 0.6 * v); synth.tone(110, 60, 0.1, 'sine', 0.3 * v); },
  groan: v => synth.tone(80 + Math.random() * 40, 55, 0.9, 'sawtooth', 0.16 * v, 0, 420),
  hurt: () => synth.tone(300, 120, 0.25, 'sawtooth', 0.25, 0, 1200),
  pickup: () => { synth.tone(660, 660, 0.08, 'triangle', 0.2); synth.tone(880, 880, 0.1, 'triangle', 0.2, 0.08); },
  thunder: () => synth.noise(2.6, 160, 0.5, 1.3),
  bash: v => { synth.noise(0.2, 260, 1, 0.7 * v); synth.tone(90, 50, 0.15, 'sine', 0.3 * v); },
};
const decal = (x, y, c, a) => R.decal(x, y, c, a);
const emit = (...a) => parts.emit(...a);
const touchInput = () => input.touch;
const kick = (dx, dy, a) => cam.kick(dx, dy, a * (touchInput() ? 0.6 : 1));

// =====================================================================
//  KAMPF
// =====================================================================
function hurtZombie(z, dmg, dx, dy, x, y) {
  z.hp -= dmg; z.hurtT = 0.12; z.kx += dx * 12 * Math.min(2, dmg); z.ky += dy * 12 * Math.min(2, dmg);
  emit('blood', x, y, 7, 6 + dmg * 4, { dir: Math.atan2(dy, dx), spread: 1.4, speed: 10, vz: 6, life: 1.2 });
  for (let k = 0; k < 3; k++) decal(z.x + (Math.random() - 0.5) * 4, z.y + (Math.random() - 0.5) * 4, [80, 10, 8], 0.5);
  SND.hit(volAt(x, y));
  if (z.state !== 'chase') { z.state = 'chase'; z.lastSeen = gameTime; }
  if (z.hp <= 0) killZombie(z, dx, dy);
}
function killZombie(z, dx, dy) {
  z.dead = true; kills++;
  corpses.push({ x: z.x + dx, y: z.y + dy, rot: Math.atan2(dy, dx) + Math.PI, v: z.v, t: gameTime });
  if (corpses.length > 45) corpses.shift();
  for (let k = 0; k < 22; k++) decal(z.x + (Math.random() - 0.5) * 6, z.y + (Math.random() - 0.5) * 6, [70, 8, 6], 0.7);
  const loot = rollLoot('zombie');
  if (loot.length) drops.push({ x: z.x, y: z.y, name: 'Leiche', items: loot });
}
function makeNoise(x, y, r) {
  for (const z of zombies) if (!z.dead && z.state !== 'chase' && Math.hypot(z.x - x, z.y - y) < r) { z.state = 'investigate'; z.tx = x + (Math.random() - 0.5) * 8; z.ty = y + (Math.random() - 0.5) * 8; z.give = gameTime + 14; }
}
function fire() {
  const w = WEAP[P.weapon];
  if (P.fireT > 0 || P.reloading) return;
  const ca = Math.cos(P.aim), sa = Math.sin(P.aim);
  if (w.melee) {
    // Ausdauer: voller Schlag kostet w.st; reicht sie nicht, wird der Schlag schwach und langsam
    const tired = P.st < w.st;
    P.st = Math.max(0, P.st - w.st); P.stRest = 0.9;
    if (P.st <= 0) P.winded = true;
    P.fireT = w.cd * (tired ? 1.8 : 1); P.swingT = 0.22; SND.swing();
    parts.add({ type: 'swing', x: P.x, y: P.y, z: 7, a: P.aim, r: w.range, arc: w.arc, life: 0.18 });
    let hit = false;
    for (const z of zombies) {
      if (z.dead) continue;
      const dx = z.x - P.x, dy = z.y - P.y, d = Math.hypot(dx, dy);
      if (d > w.range + ZR) continue;
      let da = Math.atan2(dy, dx) - P.aim; da = Math.atan2(Math.sin(da), Math.cos(da));
      if (Math.abs(da) > w.arc / 2) continue;
      hurtZombie(z, w.dmg * (tired ? 0.4 : 1) * (0.85 + Math.random() * 0.3), dx / d, dy / d, z.x, z.y); hit = true;
    }
    if (hit) kick(ca, sa, 3);
    makeNoise(P.x, P.y, w.noise);
    return;
  }
  if ((P.mags[P.weapon] || 0) <= 0) { P.fireT = 0.3; SND.empty(); startReload(); return; }
  P.mags[P.weapon]--; P.fireT = w.rate;
  const mx = P.x + ca * 3, my = P.y + sa * 3;
  for (let k = 0; k < w.pellets; k++) {
    const a = P.aim + (Math.random() - 0.5) * 2 * w.spread, dx = Math.cos(a), dy = Math.sin(a);
    let tw = world.ray(P.x, P.y, dx, dy, w.range, 6), hz = null;
    for (const z of zombies) {
      if (z.dead) continue;
      const ox = z.x - P.x, oy = z.y - P.y, t = ox * dx + oy * dy;
      if (t < 0.5 || t > tw) continue;
      const px = ox - dx * t, py = oy - dy * t;
      if (px * px + py * py < 1.6 * 1.6) { tw = t; hz = z; }
    }
    const ex = P.x + dx * tw, ey = P.y + dy * tw;
    parts.add({ type: 'tracer', x: mx, y: my, z: 7, x2: ex, y2: ey, life: 0.07 });
    if (hz) hurtZombie(hz, w.dmg * (0.85 + Math.random() * 0.3), dx, dy, ex, ey);
    else if (tw < w.range) emit('spark', ex - dx * 0.6, ey - dy * 0.6, 7, 5, { dir: Math.atan2(-dy, -dx), spread: 2, speed: 12, vz: 6, life: 0.4 });
  }
  muzzleT = 0.06;
  emit('shell', P.x + Math.cos(P.aim + 1.57) * 1.2, P.y + Math.sin(P.aim + 1.57) * 1.2, 7, 1, { dir: P.aim + 1.57, spread: 0.6, speed: 6, vz: 6, life: 1.5 });
  emit('smoke', mx, my, 7, 2, { speed: 1.2, life: 0.8 });
  SND[P.weapon]();
  kick(-ca, -sa, P.weapon === 'shotgun' ? 5 : 2.2);
  makeNoise(P.x, P.y, w.noise);
}
function startReload() {
  const w = WEAP[P.weapon];
  if (!w.ammo || P.reloading || (P.mags[P.weapon] || 0) >= w.mag || !invCount(w.ammo)) return;
  P.reloading = P.weapon; P.reloadT = w.reload; SND.reload();
}
function hurtPlayer(dmg, dx, dy) {
  P.hp -= dmg; P.hurtT = 0.35; kick(dx, dy, 6); SND.hurt();
  emit('blood', P.x, P.y, 7, 8, { dir: Math.atan2(dy, dx), spread: 1.6, speed: 8, vz: 5 });
  if (navigator.vibrate) try { navigator.vibrate(40 + dmg * 4); } catch (e) { /* */ }
  if (P.hp <= 0) gameOver();
}

// =====================================================================
//  ZOMBIES (nur im geladenen Fenster)
// =====================================================================
function randomFreeCell(minD, maxD) {
  const [x0, y0, x1, y1] = stream.bounds();
  for (let k = 0; k < 400; k++) {
    const x = x0 + Math.random() * (x1 - x0), y = y0 + Math.random() * (y1 - y0);
    const t = world.tileAt(x, y); if (!t || !t.vol) continue;
    if (world.pathBlockedAt(x, y)) continue;
    const d = Math.hypot(x - P.x, y - P.y);
    if (d < minD || d > maxD) continue;
    if (d < 70 && world.los(P.x, P.y, x, y)) continue;
    return { x: (x | 0) + 0.5, y: (y | 0) + 0.5 };
  }
  return null;
}
function spawnZombie(minD = 60, maxD = 400) {
  const p = randomFreeCell(minD, maxD); if (!p) return;
  zombies.push({ x: p.x, y: p.y, rot: Math.random() * 6.28, hp: 2.6 + Math.random() * 1.2, v: (Math.random() * 3) | 0, state: 'wander', tx: p.x, ty: p.y,
    fast: Math.random() < 0.1, think: Math.random() * 0.3, attackT: 0.5, hurtT: 0, kx: 0, ky: 0, walk: Math.random() * 9, frame: 0, lastSeen: -99, give: 0,
    wT: 0, stuckT: 1, lx: p.x, ly: p.y, side: 0, sideT: 0, groanT: Math.random() * 10, bashT: 0 });
}
function updateZombie(z, dt) {
  if (Math.abs(z.kx) + Math.abs(z.ky) > 0.01) { world.move(z, z.kx * dt, z.ky * dt, ZR); const f = Math.pow(0.002, dt); z.kx *= f; z.ky *= f; }
  z.hurtT = Math.max(0, z.hurtT - dt);
  const dx = P.x - z.x, dy = P.y - z.y, d = Math.hypot(dx, dy);
  z.think -= dt;
  if (z.think <= 0) {
    z.think = 0.2 + Math.random() * 0.15;
    let lit = false;
    if (P.light && P.bat > 0) { let da = Math.atan2(-dy, -dx) - P.aim; da = Math.atan2(Math.sin(da), Math.cos(da)); lit = Math.abs(da) < 0.45; }
    const range = lit ? 34 : 26;                       // nie weiter als der Bildausschnitt
    const sees = d < range && world.los(z.x, z.y, P.x, P.y);
    if (sees || d < 7) {
      if (z.state !== 'chase') { z.state = 'chase'; if (gameTime - z.groanT > 4) { z.groanT = gameTime; SND.groan(volAt(z.x, z.y)); } }
      z.lastSeen = gameTime; z.tx = P.x; z.ty = P.y;
    } else if (z.state === 'chase' && gameTime - z.lastSeen > 5) { z.state = 'investigate'; z.give = gameTime + 10; }
    if (z.state === 'investigate' && (Math.hypot(z.tx - z.x, z.ty - z.y) < 3 || gameTime > z.give)) { z.state = 'wander'; z.wT = 0; }
  }
  let mx = 0, my = 0, sp = 0;
  if (z.state === 'chase') {
    sp = z.fast ? SPEED.zFast : SPEED.zChase;
    const fd = d < 140 ? field.dir(z.x, z.y) : null;
    if (fd && !(d < 6 && world.los(z.x, z.y, P.x, P.y, 3))) { mx = fd[0]; my = fd[1]; }
    else { mx = dx / (d || 1); my = dy / (d || 1); }
    if (d < 3.4) { sp = 0; z.attackT -= dt; if (z.attackT <= 0) { z.attackT = 1.0; hurtPlayer(7 + Math.random() * 6, dx / d, dy / d); } }
    else z.attackT = Math.max(z.attackT, 0.35);
  } else if (z.state === 'investigate') {
    sp = SPEED.zInvest; const ex = z.tx - z.x, ey = z.ty - z.y, l = Math.hypot(ex, ey) || 1; mx = ex / l; my = ey / l;
  } else {
    z.wT -= dt;
    if (z.wT <= 0) { z.wT = 3 + Math.random() * 5; if (Math.random() < 0.4) { z.tx = z.x; z.ty = z.y; } else { z.tx = z.x + (Math.random() - 0.5) * 40; z.ty = z.y + (Math.random() - 0.5) * 40; } }
    const ex = z.tx - z.x, ey = z.ty - z.y, l = Math.hypot(ex, ey);
    if (l > 1.5) { sp = SPEED.zWander; mx = ex / l; my = ey / l; }
  }
  if (z.sideT > 0) { z.sideT -= dt; const s = z.side; [mx, my] = [mx * 0.3 - my * s, my * 0.3 + mx * s]; }
  z.stuckT -= dt;
  if (z.stuckT <= 0) {
    if (sp > 0 && Math.hypot(z.x - z.lx, z.y - z.ly) < 0.2 * sp) {
      // geschlossene Tür im Weg? Dann dagegenschlagen statt ausweichen
      const dr = z.state !== 'wander' ? city.doors.find(dr => !dr.open && !dr.broken && Math.hypot(doorCenter(dr)[0] - z.x, doorCenter(dr)[1] - z.y) < 7) : null;
      if (dr) z.bashDoor = dr; else { z.side = Math.random() < 0.5 ? 1 : -1; z.sideT = 0.6; if (z.state === 'wander') z.wT = 0; }
    }
    z.lx = z.x; z.ly = z.y; z.stuckT = 1;
  }
  if (z.bashDoor) {
    const dr = z.bashDoor;
    if (dr.open || dr.broken) z.bashDoor = null;
    else {
      sp = 0; z.bashT -= dt;
      const [cx, cy] = doorCenter(dr); z.rot = Math.atan2(cy - z.y, cx - z.x);
      if (z.bashT <= 0) {
        z.bashT = 0.8; dr.hp -= 1; SND.bash(volAt(cx, cy)); emit('spark', cx, cy, 6, 3, { speed: 4, vz: 4, life: 0.3 });
        if (dr.hp <= 0) { dr.broken = true; applyDoor(dr); emit('smoke', cx, cy, 6, 6, { speed: 3, life: 1 }); z.bashDoor = null; }
      }
    }
  }
  if (sp > 0) {
    const m = world.move(z, mx * sp * dt, my * sp * dt, ZR);
    z.walk += m;
    let da = Math.atan2(my, mx) - z.rot; da = Math.atan2(Math.sin(da), Math.cos(da)); z.rot += da * Math.min(1, dt * 6);
    z.frame = 1 + (Math.floor(z.walk / 2.2) % 4);
  } else z.frame = 0;
}
function separate() {
  const all = zombies.filter(z => !z.dead), S2 = 2.8;
  for (let i = 0; i < all.length; i++) {
    const a = all[i];
    for (let j = i + 1; j < all.length; j++) {
      const b = all[j], dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
      if (d2 < S2 * S2 && d2 > 1e-4) { const d = Math.sqrt(d2), p = (S2 - d) * 0.5; world.move(a, -dx / d * p, -dy / d * p, ZR); world.move(b, dx / d * p, dy / d * p, ZR); }
    }
    const dx = P.x - a.x, dy = P.y - a.y, d = Math.hypot(dx, dy);
    if (d < 2.6 && d > 1e-3) world.move(a, -dx / d * (2.6 - d), -dy / d * (2.6 - d), ZR);
  }
}

// =====================================================================
//  EINGABE
// =====================================================================
const input = new Input(ov, {
  onFirstInput: () => synth.init(),
  onCamera: (dyaw, dpitch, zf) => { cam.rotate(dyaw); cam.tilt(dpitch); if (zf !== 1) cam.zoomBy(zf); },
  cameraHandle: $('tbCam'), onCameraTap: () => cam.rotate(Math.PI / 2),
});
if (input.touch) document.body.classList.add('touch');
addEventListener('keydown', e => {
  if (e.repeat) return;
  const k = e.key.toLowerCase();
  if ($('inv').classList.contains('show')) { if (k === 'escape' || k === 'i' || k === 'tab' || k === 'e') { e.preventDefault(); closeInv(); } return; }
  if (!running) return;
  if (k === 'r') startReload();
  if (k === 'e') interact();
  if (k === 'q') cycleWeapon();
  if (k === 'f') toggleLight();
  if (k === 'i' || k === 'tab') { e.preventDefault(); openInv(null); }
  if (k === 'z') cam.rotate(-Math.PI / 2);
  if (k === 'x') cam.rotate(Math.PI / 2);
  if (k === 'c') cam.tilt(-0.12);
  if (k === 'v') cam.tilt(0.12);
  if (k === 'h') quickHeal();
});
document.querySelectorAll('.tb[data-a]').forEach(b => b.addEventListener('pointerdown', e => {
  e.preventDefault(); e.stopPropagation(); synth.init();
  if (!running) return;
  const a = b.dataset.a;
  if (a === 'interact') interact(); else if (a === 'reload') startReload(); else if (a === 'weapon') cycleWeapon();
  else if (a === 'light') toggleLight(); else if (a === 'inv') openInv(null);
}));
$('prompt').addEventListener('pointerdown', e => { e.preventDefault(); synth.init(); interact(); });

function cycleWeapon() {
  const ws = ownedWeapons(), i = ws.indexOf(P.weapon);
  P.weapon = ws[(i + 1) % ws.length]; P.reloading = null; P.fireT = 0.2; toast(WEAP[P.weapon].name);
}
function toggleLight() { P.light = !P.light; $('tbLight').classList.toggle('on', P.light); synth.tone(1200, 1000, 0.03, 'square', 0.08); }
function quickHeal() { const id = ['bandage', 'food', 'choc', 'medkit'].find(k => invCount(k)); if (id && P.hp < 100) useItem(id); }
function useItem(id) {
  const it = ITEMS[id];
  if (it.t === 'h') { if (P.hp >= 100) { toast('Gesundheit ist voll'); return; } P.hp = Math.min(100, P.hp + it.heal); removeItem(id, 1); toast(`${it.n}: +${it.heal}`); SND.pickup(); }
  else if (it.t === 'b') { P.bat = 100; removeItem(id, 1); toast('Taschenlampe geladen'); SND.pickup(); }
  else if (it.t === 'w') { P.weapon = id; P.reloading = null; toast(WEAP[id].name + ' ausgerüstet'); }
}
function toast(t) { $('toast').textContent = t; toastT = 2.2; }

// =====================================================================
//  INTERAKTION UND INVENTAR
// =====================================================================
function nearestUsable() {
  let best = null, bd = 7;
  for (const c of city.containers) { const d = Math.hypot(c.x - P.x, c.y - P.y); if (d < bd && world.los(P.x, P.y, c.x, c.y, 12, 5)) { bd = d; best = { kind: 'cont', o: c }; } }
  for (const c of drops) { const d = Math.hypot(c.x - P.x, c.y - P.y); if (d < bd) { bd = d; best = { kind: 'cont', o: c }; } }
  for (const dr of city.doors) {
    if (dr.broken) continue;
    const [cx, cy] = doorCenter(dr), d = Math.hypot(cx - P.x, cy - P.y);
    if (d < Math.min(bd, 6)) { bd = d; best = { kind: 'door', o: dr }; }
  }
  return best;
}
function interact() { const u = nearestUsable(); if (!u) return; if (u.kind === 'door') toggleDoor(u.o); else openInv(u.o); }
function openInv(c) {
  if (c && !c.items) c.items = rollLoot(c.kind);
  openCont = c; paused = true;
  input.reset();
  $('inv').classList.add('show'); renderInv();
}
function closeInv() {
  $('inv').classList.remove('show'); paused = false;
  if (openCont && drops.includes(openCont) && !openCont.items.length) drops.splice(drops.indexOf(openCont), 1);
  openCont = null;
}
function renderInv() {
  const c = openCont;
  $('colC').style.display = c ? '' : 'none'; $('takeAll').style.display = c ? '' : 'none';
  $('invTitle').textContent = c ? 'DURCHSUCHEN' : 'INVENTAR';
  $('contName').textContent = c ? c.name : '';
  $('bagName').textContent = `Rucksack (${inv.length}/16)`;
  const row = (s, btns, eq) => `<div class="it${eq ? ' eq' : ''}"><span class="ic">${ITEMS[s.id].ic}</span><span class="nm">${ITEMS[s.id].n}${s.n > 1 ? ` <small>×${s.n}</small>` : ''}${ITEMS[s.id].t === 'w' && WEAP[s.id].mag ? ` <small>(${P.mags[s.id] ?? 0}/${WEAP[s.id].mag})</small>` : ''}</span>${btns}</div>`;
  if (c) $('listC').innerHTML = c.items.length ? c.items.map((s, i) => row(s, `<button data-take="${i}">Nehmen</button>`)).join('') : '<div class="empty">Leer.</div>';
  $('listB').innerHTML = inv.length ? inv.map((s, i) => {
    const it = ITEMS[s.id]; let b = '';
    if (it.t === 'w') b += P.weapon === s.id ? '<button disabled>Ausgerüstet</button>' : `<button data-use="${i}">Ausrüsten</button>`;
    if (it.t === 'h') b += `<button data-use="${i}">Benutzen</button>`;
    if (it.t === 'b') b += `<button data-use="${i}">Einlegen</button>`;
    b += `<button data-drop="${i}">Ablegen</button>`;
    return row(s, b, P.weapon === s.id);
  }).join('') : '<div class="empty">Nichts dabei.</div>';
}
$('inv').addEventListener('click', e => {
  const t = e.target;
  if (t.dataset.take !== undefined) {
    const s = openCont.items[+t.dataset.take], left = addItem(s.id, s.n);
    if (left === s.n) toast('Rucksack voll'); else SND.pickup();
    if (left) s.n = left; else openCont.items.splice(+t.dataset.take, 1);
  } else if (t.dataset.use !== undefined) useItem(inv[+t.dataset.use].id);
  else if (t.dataset.drop !== undefined) {
    const s = inv[+t.dataset.drop];
    let target = openCont;
    if (!target) { target = { x: P.x, y: P.y, name: 'Abgelegt', items: [] }; drops.push(target); }
    target.items.push({ id: s.id, n: s.n }); removeItem(s.id, s.n);
  }
  renderInv();
});
$('takeAll').addEventListener('click', () => {
  const c = openCont; if (!c) return;
  for (let i = c.items.length - 1; i >= 0; i--) { const s = c.items[i], left = addItem(s.id, s.n); if (left) s.n = left; else c.items.splice(i, 1); }
  SND.pickup(); renderInv();
});
$('invClose').addEventListener('click', closeInv);

// =====================================================================
//  RENDERN
// =====================================================================
/** Alles in Reichweite, womit man interagieren kann: Behälter (mit Sichtlinie), Türen. */
function highlights() {
  const list = [];
  for (const c of city.containers) {
    if (!c.r) continue;
    const d = Math.hypot(c.x - P.x, c.y - P.y);
    if (d < 7 && world.los(P.x, P.y, c.x, c.y, 12, 5)) list.push({ d, rect: c.r, z0: 1, z1: 31, kind: 1 });
  }
  for (const dr of city.doors) {
    if (dr.broken) continue;
    const [cx, cy] = doorCenter(dr), d = Math.hypot(cx - P.x, cy - P.y);
    if (d >= 6) continue;
    const { gap, leaf } = doorCells(dr), cs = [...gap, ...leaf], xs = cs.map(c => c[0]), ys = cs.map(c => c[1]);
    list.push({ d, rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs) + 1, Math.max(...ys) + 1], z0: 1, z1: DOOR_H, kind: 1 });
  }
  return list.sort((a, b) => a.d - b.d).slice(0, 6);
}
const sky = skyAt(HOUR);

function render(t) {
  R.begin(cam);
  const bi = city.inBuilding(P.x, P.y), bd = bi >= 0 ? city.buildings[bi] : null;
  R.drawWorld({ cut: bd ? [bd.x0 - 1, bd.y0 - 1, bd.x1 + 2, bd.y1 + 2] : null, highlights: highlights() });
  const TPp = WEAP[P.weapon].melee ? TPM : TPG;
  R.drawSprite(TPp, P.frame, P.x, P.y, P.rot, { dens: SD, shadow: bi >= 0 ? 0 : 1, ent: 1, xray: true, tint: P.hurtT > 0 ? [0.9, 0.1, 0.05, P.hurtT * 1.6] : null });
  for (const z of zombies) {
    if (z.dead || !cam.onScreen(z.x, z.y, 80)) continue;
    R.drawSprite(TZ[z.v], z.frame, z.x, z.y, z.rot, { dens: SD, shadow: city.inBuilding(z.x, z.y) >= 0 ? 0 : 1, ent: 2, tint: z.hurtT > 0 ? [1, 1, 1, 0.7] : null });
  }
  for (const k of corpses) {
    if (!cam.onScreen(k.x, k.y, 80)) continue;
    R.drawSprite(TZ[k.v], 5, k.x, k.y, k.rot, { dens: SD, z: 0.6, shadow: 1, ent: 2, tint: [0.25, 0.05, 0.03, 0.25], hi: Math.hypot(k.x - P.x, k.y - P.y) < 9 ? 0.5 : 0 });
  }
  for (const f of city.flames) {
    if (!tileOn(f.tile) || !cam.onScreen(f.x, f.y, 80)) continue;
    R.drawSprite(TFL, Math.floor(t * 9 + f.x) % TFL.n, f.x, f.y, 0, { dens: 2, z: f.bz, shadow: 1 });
  }
  // Lichter: 0 Taschenlampe (Spot), 1 Mündungsfeuer, 2 eigenes Restlicht, ab 3 die nächsten Lampen und Feuer
  const ca = Math.cos(P.aim), sa = Math.sin(P.aim), L = [null, null, null];
  if (P.light && P.bat > 0) {
    const low = P.bat < 15 ? (vnoise(t * 9, 0, 1) > 0.35 ? 1 : 0.2) : 1, k = (0.55 + 0.45 * Math.min(1, P.bat / 40)) * low * 3.2;
    L[0] = { x: P.x + ca * 1.5, y: P.y + sa * 1.5, z: 8.5, r: 85, color: [k, k * 0.96, k * 0.85] };
  }
  if (muzzleT > 0) { const k = 3.5 * muzzleT / 0.06; L[1] = { x: P.x + ca * 3, y: P.y + sa * 3, z: 7.5, r: 45, color: [k, k * 0.75, k * 0.4] }; }
  L[2] = { x: P.x, y: P.y, z: 11, r: 24, color: [0.42, 0.44, 0.52], shadow: false };
  for (const l of nearestLights(city.lights, P.x, P.y, 5, 70, l => tileOn(l.tile))) {
    const f = flicker(l, t) * l.i;
    L.push({ x: l.x, y: l.y, z: l.z, r: l.r, color: [l.c[0] * f, l.c[1] * f, l.c[2] * f] });
  }
  const sl = Math.hypot(ca, sa, 0.12);
  R.light({ ambient: sky.ambient, sunColor: sky.sun, flash, eye: [P.x, P.y, 9], los: true, lights: L, spot: [ca / sl, sa / sl, -0.12 / sl, 0.84], time: t });
}

// ---- 2D-Ebene: Markierungen, Partikel, Regen, Sticks
const rain = [];
function drawOverlay(t, dt) {
  const Wc = ov.width, Hc = ov.height;
  octx.setTransform(1, 0, 0, 1, 0, 0); octx.clearRect(0, 0, Wc, Hc);
  for (const c of city.containers) {
    if (Math.abs(c.x - P.x) > 30 || Math.abs(c.y - P.y) > 30) continue;
    if (!world.los(P.x, P.y, c.x, c.y, 12, 5)) continue;
    const [sx, sy] = cam.project(c.x, c.y, 12 + Math.sin(t * 3 + c.x) * 0.5);
    const empty = c.items && !c.items.length;
    octx.fillStyle = empty ? 'rgba(120,120,120,0.5)' : `rgba(240,210,110,${0.55 + 0.35 * Math.sin(t * 4)})`;
    octx.beginPath(); octx.moveTo(sx, sy + 4); octx.lineTo(sx - 3, sy); octx.lineTo(sx + 3, sy); octx.fill();
  }
  for (const c of drops) { const [sx, sy] = cam.project(c.x, c.y, 2); octx.fillStyle = `rgba(240,210,110,${0.6 + 0.3 * Math.sin(t * 5)})`; octx.fillRect(Math.round(sx) - 2, Math.round(sy) - 2, 4, 4); }
  parts.draw(octx, cam);
  for (const f of city.flames) if (Math.random() < dt * 6 && tileOn(f.tile) && Math.hypot(f.x - P.x, f.y - P.y) < 80) { emit('ember', f.x, f.y, f.bz + 4, 1, { speed: 1.5, vz: 8, life: 1.6 }); if (Math.random() < 0.4) emit('smoke', f.x, f.y, f.bz + 7, 1, { speed: 0.8, life: 2.5 }); }
  while (rain.length < 140) rain.push({ x: Math.random() * Wc, y: Math.random() * Hc, v: 260 + Math.random() * 160 });
  octx.strokeStyle = 'rgba(160,175,200,0.22)'; octx.lineWidth = 1; octx.beginPath();
  for (const r of rain) { r.y += r.v * dt; r.x -= r.v * 0.18 * dt; if (r.y > Hc) { r.y = -8; r.x = Math.random() * Wc * 1.2; } octx.moveTo(r.x, r.y); octx.lineTo(r.x + 2, r.y - 9); }
  octx.stroke();
  if (flash > 0.02) { octx.fillStyle = `rgba(190,205,255,${flash * 0.25})`; octx.fillRect(0, 0, Wc, Hc); }
  input.drawSticks(octx, RS);
}

// ---- HUD und Minikarte (aus dem Stadtplan, ohne Voxel)
const KCOL = { road: '#3a3c42', haus: '#8a5a3a', laden: '#3a7a8a', park: '#3a6a2a', parkplatz: '#5a5c60', brache: '#5a4a30' };
let miniBase = null;
const MS = 6;                    // Pixel pro Grundstück auf der Grundkarte; die Minikarte zeigt 16 × 16 Grundstücke um die Figur
function buildMini() {
  const c = document.createElement('canvas'); c.width = GN * MS; c.height = GN * MS; const g = c.getContext('2d');
  for (let ty = 0; ty < GN; ty++) for (let tx = 0; tx < GN; tx++) {
    const t = TILES[city.grid[ty * GN + tx]];
    g.fillStyle = t.kind === 'road' ? '#1e2a1c' : KCOL[t.kind]; g.fillRect(tx * MS, ty * MS, MS, MS);
    if (t.kind === 'road') {
      g.fillStyle = '#6a6c72'; const m = MS / 2 - 1;
      g.fillRect(tx * MS + m, ty * MS + m, 2, 2);
      if (t.mask & 1) g.fillRect(tx * MS + m, ty * MS, 2, m); if (t.mask & 4) g.fillRect(tx * MS + m, ty * MS + m, 2, MS - m);
      if (t.mask & 8) g.fillRect(tx * MS, ty * MS + m, m, 2); if (t.mask & 2) g.fillRect(tx * MS + m, ty * MS + m, MS - m, 2);
    }
  }
  miniBase = c;
}
function drawMini() {
  const m = $('mini'), c = m.getContext('2d'), k = MS / TS;
  const cx = P.x * k - 48, cy = P.y * k - 48;
  c.fillStyle = '#000'; c.fillRect(0, 0, 96, 96);
  c.drawImage(miniBase, -cx, -cy);
  c.fillStyle = '#e04030';
  for (const z of zombies) if (!z.dead && z.state === 'chase') c.fillRect(z.x * k - cx - 1, z.y * k - cy - 1, 2, 2);
  c.fillStyle = '#fff'; c.fillRect(46.5, 46.5, 3, 3);
  c.strokeStyle = '#fff'; c.beginPath(); c.moveTo(48, 48); c.lineTo(48 + Math.cos(P.aim) * 6, 48 + Math.sin(P.aim) * 6); c.stroke();
  m.style.transform = `rotate(${cam.yaw}rad)`; m.style.borderRadius = '50%';
}
function drawHud() {
  const w = WEAP[P.weapon];
  const ammo = w.ammo ? `${P.mags[P.weapon] || 0} | ${invCount(w.ammo)}` : '–';
  const min = Math.floor(gameTime / 60), sec = Math.floor(gameTime % 60).toString().padStart(2, '0');
  $('hud').innerHTML = `Gesundheit<div class="bar"><i style="width:${Math.max(0, P.hp)}%"></i></div>` +
    `Taschenlampe<div class="bar bat"><i style="width:${P.bat}%"></i></div>` +
    `Ausdauer<div class="bar st${P.winded ? ' low' : ''}"><i style="width:${P.st}%"></i></div>` +
    `<div class="w">${w.name} <span class="s">${P.reloading ? 'lädt …' : ammo}</span></div>` +
    `<div class="s">Kills ${kills} · ${min}:${sec} · ${zombies.filter(z => !z.dead && z.state === 'chase').length} jagen dich</div>`;
  const u = nearestUsable(), pr = $('prompt');
  if (u) {
    pr.style.display = 'block';
    const key = input.touch ? '✋' : '[E]';
    pr.textContent = u.kind === 'door' ? `${key} Tür ${u.o.open ? 'schließen' : 'öffnen'}` : `${key} ${u.o.items && !u.o.items.length ? u.o.name + ' (leer)' : u.o.name + ' durchsuchen'}`;
  } else pr.style.display = 'none';
}

// =====================================================================
//  SPIELSCHLEIFE
// =====================================================================
let last = 0, hudT = 0, last0 = 0;
const frameTimes = [];   // echte Abstände zwischen Bildern (ms), für den Rundgang
function step(now) {
  requestAnimationFrame(step);
  const dt = Math.min(0.05, (now - last) / 1000 || 0.016); last = now; const t = now / 1000;
  if (!running) return;
  frameAvg += (dt - frameAvg) * 0.05;
  if (frameTimes.length < 20000) frameTimes.push(now - last0); last0 = now;
  if (frameAvg > 0.027) { slowT += dt; if (slowT > 2 && RS < 2.4) { RS *= 1.25; resize(); slowT = 0; frameAvg = 0.016; } } else slowT = 0;
  stream.update(P.x, P.y);
  stream.run(6);                 // nur ohne Worker

  if (!paused) {
    gameTime += dt;
    let [mx, my] = input.keyDir();
    let mag = Math.min(1, Math.hypot(mx, my));
    const SL = input.sticks.L, SRt = input.sticks.R;
    if (SL.id !== null) { const l = Math.hypot(SL.dx, SL.dy); if (l > 0.15) { mx = SL.dx; my = SL.dy; mag = Math.min(1, l); } }
    P.moving = false;
    // Rennen: Shift (Tastatur) oder Stick ganz am Rand (Touch); verbraucht Ausdauer
    const wantRun = (input.keys.has('shift') || (SL.id !== null && Math.hypot(SL.dx, SL.dy) > 0.97)) && mag > 0.5;
    P.running = wantRun && !P.winded && P.st > 0 && !P.reloading;
    if (mag > 0.05) {
      const [wx, wy] = cam.dirToWorld(mx, my), sp = (P.running ? SPEED.run : SPEED.walk * mag) * (P.reloading ? 0.7 : 1) * (P.winded ? 0.8 : 1);
      P.walk += world.move(P, wx * sp * dt, wy * sp * dt, PR); P.moving = true;
      if (!input.mouse.active && gameTime - lastAimT > 0.5) P.aim = Math.atan2(wy, wx);
    }
    P.frame = P.moving ? 1 + (Math.floor(P.walk / (P.running ? 3.4 : 2.6)) % 4) : 0;
    if (P.running && P.moving) { P.st = Math.max(0, P.st - 16 * dt); P.stRest = 0.9; if (P.st <= 0) { P.winded = true; toast('Außer Atem'); } }
    else { P.stRest -= dt; if (P.stRest <= 0) P.st = Math.min(100, P.st + (P.moving ? 9 : 16) * dt); }
    if (P.winded && P.st >= 30) P.winded = false;
    if (P.running && P.moving && Math.random() < dt * 3) makeNoise(P.x, P.y, 22);   // Rennen ist lauter
    let firing = false;
    if (SRt.id !== null) {
      const l = Math.hypot(SRt.dx, SRt.dy);
      if (l > 0.2) {
        const [wx, wy] = cam.dirToWorld(SRt.dx, SRt.dy); P.aim = Math.atan2(wy, wx); lastAimT = gameTime; firing = l > 0.65;
        let best = 0.22, ba = null;    // Zielhilfe am Handy
        for (const z of zombies) {
          if (z.dead) continue; const dx = z.x - P.x, dy = z.y - P.y, d = Math.hypot(dx, dy); if (d > 40) continue;
          let da = Math.atan2(dy, dx) - P.aim; da = Math.atan2(Math.sin(da), Math.cos(da));
          if (Math.abs(da) < best && world.los(P.x, P.y, z.x, z.y, 6)) { best = Math.abs(da); ba = Math.atan2(dy, dx); }
        }
        if (ba !== null) P.aim = ba;
      }
    } else if (input.mouse.active) {
      const [ax, ay] = cam.unproject(input.mouse.x / RS, input.mouse.y / RS, 7);
      P.aim = Math.atan2(ay - P.y, ax - P.x); firing = input.mouse.down;
    }
    let dr = P.aim - P.rot; dr = Math.atan2(Math.sin(dr), Math.cos(dr)); P.rot += dr * Math.min(1, dt * 14);
    P.fireT -= dt; P.swingT -= dt; P.hurtT = Math.max(0, P.hurtT - dt); muzzleT = Math.max(0, muzzleT - dt);
    if (firing) fire();
    if (P.reloading) {
      P.reloadT -= dt;
      if (P.reloading !== P.weapon) P.reloading = null;
      else if (P.reloadT <= 0) { const w = WEAP[P.weapon], take = Math.min(w.mag - (P.mags[P.weapon] || 0), invCount(w.ammo)); removeItem(w.ammo, take); P.mags[P.weapon] = (P.mags[P.weapon] || 0) + take; P.reloading = null; }
    }
    if (P.light && P.bat > 0) P.bat = Math.max(0, P.bat - dt / 9);
    fieldT -= dt; if (fieldT <= 0) { field.compute(P.x, P.y, 140); fieldT = 0.35; }
    const [wx0, wy0, wx1, wy1] = stream.bounds();
    for (const z of zombies) {
      if (z.dead) continue;
      if (z.x < wx0 || z.y < wy0 || z.x >= wx1 || z.y >= wy1) { z.dead = true; continue; }   // außerhalb des Fensters: verschwinden
      updateZombie(z, dt);
    }
    separate();
    zombies = zombies.filter(z => !z.dead);
    const want = Math.min(110, 55 + Math.floor(gameTime / 60) * 5);
    if (zombies.length < want && Math.random() < dt * (zombies.length < want * 0.6 ? 12 : 2)) spawnZombie(70, 220);
    parts.update(dt, p => decal(p.x, p.y, [90, 12, 10], 0.65));
    nextBolt -= dt;
    if (nextBolt <= 0) { flash = 1; nextBolt = 20 + Math.random() * 30; thunderT = 0.8 + Math.random() * 1.5; }
    flash = Math.max(0, flash - dt * 2.2); if (flash < 0.6 && flash > 0.5 && Math.random() < 0.1) flash = 0.9;
    if (thunderT > 0) { thunderT -= dt; if (thunderT <= 0) SND.thunder(); }
    cam.follow(P.x + Math.cos(P.aim) * 9, P.y + Math.sin(P.aim) * 9);
  }
  cam.update(paused ? 0 : dt);
  render(t);
  drawOverlay(t, paused ? 0 : dt);
  hudT -= dt; toastT -= dt;
  if (toastT <= 0) $('toast').textContent = '';
  $('hurt').style.opacity = Math.max(P.hurtT * 2, P.hp < 30 ? 0.25 + 0.15 * Math.sin(t * 4) : 0);
  if (hudT <= 0) { hudT = 0.2; drawHud(); drawMini(); }
}

// =====================================================================
//  START, NEUE STADT, ENDE
// =====================================================================
function resize() {
  const w = Math.ceil(innerWidth / RS), h = Math.ceil(innerHeight / RS);
  R.resize(w, h); ov.width = w; ov.height = h; cam.setSize(w, h);
  // sichtbare Breite: ~60 Voxel (12 m) am Handy, bis 130 (26 m) am großen Bildschirm
  const span = Math.min(innerWidth, innerHeight * 1.3), vox = Math.max(56, Math.min(130, span / 6.5));
  cam.target.zoom = span / vox / RS; cam.minZoom = cam.target.zoom * 0.4; cam.maxZoom = cam.target.zoom * 3;
}
addEventListener('resize', resize);
function showWfc() {
  const cv = $('wfc'), c = cv.getContext('2d'); cv.width = GN; cv.height = GN; c.fillStyle = '#05070a'; c.fillRect(0, 0, GN, GN);
  let i = 0;
  const tick = () => {
    if (i >= city.order.length) return;
    const per = Math.ceil(city.order.length / 120);
    for (let k = 0; k < per && i < city.order.length; k++, i++) {
      const cell = city.order[i], t = TILES[city.grid[cell]];
      c.fillStyle = KCOL[t.kind]; c.fillRect(cell % GN, (cell / GN) | 0, 1, 1);
    }
    setTimeout(tick, 25);
  };
  tick();
}
function newGame(s) {
  seed = s; running = false;
  $('stTxt').textContent = `Stadt #${seed % 100000} – Wave Function Collapse …`;
  $('bPlay').disabled = true;
  setTimeout(async () => {
    if (city && city.backend.terminate) city.backend.terminate();
    city = createCity(seed, { workers: params.has('ohneWorker') ? false : true }); world = city.world;
    R.attachWorld(world, 5);
    await city.whenReady();
    stream = new Streamer(world, R, { backend: city.backend, radius: 2, keep: 3 });
    field = new FlowField(world, 140);
    showWfc(); buildMini();
    P = newPlayer(); inv = []; addItem('bat', 1); addItem('pistol', 1); P.mags.pistol = 12; addItem('a9', 24); addItem('bandage', 1);
    P.weapon = 'pistol'; zombies = []; corpses = []; drops = []; parts.list.length = 0; kills = 0; gameTime = 0;
    cam.follow(P.x, P.y); cam.snap();
    await stream.fill(P.x, P.y, (a, n) => { $('stTxt').textContent = `Baue Viertel: ${a} / ${n} Grundstücke …`; });
    if (!params.has('leer')) for (let k = 0; k < 55; k++) spawnZombie(60, 999);
    $('stTxt').textContent = `Stadt #${seed % 100000}: ${GN}×${GN} Grundstücke (${Math.round(W / VPM)} m). Es ist Nacht. Finde Waffen und Vorräte – und überlebe.`;
    $('bPlay').disabled = false;
  }, 30);
}
function gameOver() {
  running = false;
  const min = Math.floor(gameTime / 60), sec = Math.floor(gameTime % 60);
  $('deadTxt').textContent = `Überlebt: ${min} min ${sec} s · Zombies getötet: ${kills}`;
  $('dead').classList.add('show');
}
$('bPlay').addEventListener('click', () => { synth.init(); $('start').classList.remove('show'); running = true; paused = false; last = performance.now(); });
$('bNew').addEventListener('click', () => newGame((Math.random() * 1e9) | 0));
$('bAgain').addEventListener('click', () => { $('dead').classList.remove('show'); $('start').classList.add('show'); newGame((Math.random() * 1e9) | 0); });
$('help').innerHTML = input.touch
  ? 'Linker Daumen: laufen, ganz ausziehen = rennen · Rechter Daumen: zielen, weit ziehen = feuern<br>Kamera-Taste ziehen = drehen und neigen, antippen = 90° drehen'
  : 'WASD laufen · Shift rennen · Maus zielen · Linksklick feuern · R nachladen · E Tür/Behälter<br>Q Waffe · F Licht · I Inventar · H heilen · rechte Maustaste ziehen oder Z/X, C/V: Kamera drehen und neigen · Mausrad Zoom';

RS = input.touch ? 1 : (innerWidth > 1400 ? 2 : 1.5);
TPG = R.createSprite(WALK.map(s => figureStack(survivorFn(s, false), 36, 44)));
TPM = R.createSprite(WALK.map(s => figureStack(survivorFn(s, true), 36, 44)));
for (let v = 0; v < 3; v++) TZ.push(R.createSprite([...WALK.map(s => figureStack(zombieFn(s, v * 2 + 1, false), 48, 40)), figureStack(zombieFn(0, v * 2 + 1, true), 48, 40, true)]));
TFL = R.createSprite([0, 1, 2, 3, 4, 5].map(flameStack));
resize();
newGame(seed);
requestAnimationFrame(step);

// Für Tests und Debugging
window.TS_DEBUG = { get P() { return P; }, get world() { return world; }, get city() { return city; }, get zombies() { return zombies; }, set zombies(v) { zombies = v; },
  get corpses() { return corpses; }, cam, R, get stream() { return stream; }, get frameAvg() { return frameAvg; }, interact, toggleDoor, applyDoor, fire,
  get running() { return running; }, get gameTime() { return gameTime; }, highlights, doorCenter, nearestUsable, get frameTimes() { return frameTimes; } };
