// Lichter-Stressszene: viele bewegte farbige Punktlichter über einem Säulenwald (Abnahme Etappe 4).
// ?n=Anzahl&schatten=Anzahl, F3 = Debug-Overlay. Kamera fest, damit Bildzeiten vergleichbar sind.
import { World, Renderer, Camera, Streamer, LocalBackend, Input, Profiler, DebugOverlay, C, jit, hash3 } from '../../engine/index.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const N = +(params.get('n') || 64), SH = +(params.get('schatten') ?? 8);
$('n').value = String(N); $('s').value = String(SH);
for (const id of ['n', 's']) $(id).onchange = () => { params.set('n', $('n').value); params.set('schatten', $('s').value); location.search = params.toString(); };

const TS = 48, T = 4, H = 24;
const GEN = {
  tileSize: TS, tilesX: T, tilesY: T, height: H,
  generate: (tile, vol, { ox, oy }) => {
    for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
      const X = ox + x, Y = oy + y;
      vol.set(x, y, 0, C(((X >> 3) + (Y >> 3)) & 1 ? 0x5a5c62 : 0x4a4c52));
      if (X % 16 >= 6 && X % 16 <= 8 && Y % 16 >= 6 && Y % 16 <= 8) for (let z = 1; z <= 10 + (hash3(X >> 4, Y >> 4, 1) * 8 | 0); z++) vol.set(x, y, z, C(jit(0xb0a898, 0.1, hash3(X, Y, z))));
      if (Y % 32 === 0 && X % 32 > 4 && X % 32 < 20) for (let z = 1; z <= 3; z++) vol.set(x, y, z, C(0x8a6a4a));
    }
  },
};
const world = new World({ tileSize: TS, tilesX: T, tilesY: T, height: H, seed: 1 });
const backend = new LocalBackend(GEN, 1); world.builder = backend.builder;
const R = new Renderer($('gl'), { zMax: H + 2 });
R.attachWorld(world, T);
const stream = new Streamer(world, R, { backend, radius: 2, keep: 3 });
const W2 = TS * T / 2;
const cam = new Camera({ x: W2, y: W2, zoom: 4.2, pitch: 0.95, yaw: 0.7 });
new Input($('gl'), { onCamera: (a, b, z) => { cam.rotate(a); cam.tilt(b); if (z !== 1) cam.zoomBy(z); } });
const prof = new Profiler();
const dbg = new DebugOverlay(prof, () => ({ Lichter: `${R.stats.lights} (${R.stats.lightRefs} Bez., verworfen ${R.stats.lightsDropped})`, Plätze: R.stats.slots, Instanzen: R.stats.insts }));
function resize() { const w = Math.ceil(innerWidth / 1.5), h = Math.ceil(innerHeight / 1.5); R.resize(w, h); cam.setSize(w, h); }
addEventListener('resize', resize); resize();
stream.update(W2, W2); stream.run(1e9);

const lights = [];
for (let i = 0; i < N; i++) {
  const h = hash3(i, 7, 3), a = hash3(i, 1, 1) * 6.283, rr = 10 + hash3(i, 2, 2) * (W2 - 14);
  const col = [[1, 0.3, 0.2], [0.2, 0.6, 1], [0.3, 1, 0.4], [1, 0.8, 0.2], [0.8, 0.3, 1]][i % 5];
  lights.push({ a, rr, sp: (0.15 + h * 0.3) * (i % 2 ? 1 : -1), z: 4 + hash3(i, 4, 4) * 8, r: 14 + hash3(i, 5, 5) * 14, col });
}
const times = [];
let last = performance.now();
function step(now) {
  requestAnimationFrame(step);
  const dt = Math.min(0.05, (now - last) / 1000), t = now / 1000; times.push(now - last); last = now;
  cam.update(dt);
  prof.begin('Rendern');
  R.begin(cam); R.drawWorld();
  const L = lights.map(l => ({ x: W2 + Math.cos(l.a + t * l.sp) * l.rr, y: W2 + Math.sin(l.a + t * l.sp) * l.rr, z: l.z, r: l.r, color: l.col.map(c => c * 1.6) }));
  R.light({ ambient: [0.05, 0.05, 0.07], sunColor: [0.08, 0.08, 0.12], lights: L, maxShadowed: SH, eye: [W2, W2, 9], los: false, quant: 0, time: t });
  prof.end('Rendern'); prof.frame(); dbg.update(dt);
  const s = prof.stats();
  $('info').textContent = `${N} Lichter, ${SH} mit Schatten · ${s.fps.toFixed(0)} fps · p50 ${s.p50.toFixed(1)} ms · F3 Details`;
}
requestAnimationFrame(step);
window.VE_DEMO = { cam, R, times, prof };
window.VE_READY = true;
