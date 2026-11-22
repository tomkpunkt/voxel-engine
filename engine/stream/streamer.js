// Streaming: hält ein Fenster aus Kacheln um einen Punkt erzeugt und gebacken.
// Erzeugen und Backen laufen in Workern (WorkerBackend) oder synchron (LocalBackend, z. B. in Node).
// Jeder Auftrag trägt die Kachelrevision. Kommt ein Ergebnis zu einer älteren Revision zurück
// (die Kachel wurde inzwischen geändert), wird es verworfen und die Kachel neu beauftragt.

import { Volume } from '../core/voxel.js';
import { Builder } from './builder.js';

/** Synchrones Backend: baut im aufrufenden Thread. */
export class LocalBackend {
  constructor(gen, seed, o = {}) { this.builder = new Builder(gen, seed, o); this.slots = 1; }
  build(req) { return Promise.resolve(this.builder.build(req, false)); }
  buildSync(req) { return this.builder.build(req, false); }
  get stats() { return this.builder.stats; }
}

/** Mehrere Modul-Worker; Aufträge gehen nach Region an denselben Worker, damit sein Kachel-Cache trifft. */
export class WorkerBackend {
  /**
   * @param {string|URL} module   URL des Generator-Moduls (absolut oder relativ zur Seite)
   * @param {object} config       wird an createGenerator(config) übergeben, braucht seed
   * @param {object} [o]  { workers, sun, maxCache }
   */
  constructor(module, config, o = {}) {
    const n = o.workers ?? Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
    const url = new URL(module, location.href).href;
    this.workers = []; this.pending = new Map(); this.nextId = 1; this.slots = n * 2;
    this.workerStats = [];
    let readyCount = 0;
    /** Erfüllt, wenn alle Worker ihr Generator-Modul geladen haben; abgelehnt bei Fehler (z. B. CSP verbietet Worker). */
    this.ready = new Promise((res, rej) => { this.readyOk = () => { if (++readyCount === n) res(); }; this.readyFail = rej; });
    this.ready.catch(() => {});
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      w.onmessage = e => this.onMessage(i, e.data);
      w.onerror = e => { console.error('Worker-Fehler', e.message); this.readyFail(new Error(e.message || 'Worker-Fehler')); };
      w.postMessage({ type: 'init', module: url, config, sun: o.sun, maxCache: o.maxCache ?? 40 });
      this.workers.push(w);
    }
  }
  onMessage(i, m) {
    if (m.type === 'ready') { this.readyOk(); return; }
    if (m.type === 'error') { console.error('Builder:', m.message); if (m.id === -1) this.readyFail(new Error(m.message)); const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); p.reject(new Error(m.message)); } return; }
    this.workerStats[i] = m.stats;
    const p = this.pending.get(m.id); if (!p) return;
    this.pending.delete(m.id);
    p.resolve(m.r);
  }
  build(req) {
    const id = this.nextId++, region = (Math.floor(req.tx / 2) * 7 + Math.floor(req.ty / 2) * 13) >>> 0;
    const w = this.workers[region % this.workers.length];
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); w.postMessage({ type: 'build', id, req }); });
  }
  get stats() {
    const s = { generated: 0, baked: 0, genMs: 0, bakeMs: 0 };
    for (const w of this.workerStats) if (w) for (const k in s) s[k] += w[k];
    return s;
  }
  terminate() { for (const w of this.workers) w.terminate(); }
}

export class Streamer {
  /**
   * @param {World} world
   * @param {Renderer|null} renderer  mit attachWorld(world, 2·radius + 1); null = nur Voxel und Karten (Server, Tests)
   * @param {object} o
   * @param {LocalBackend|WorkerBackend} o.backend
   * @param {number} [o.radius]   geladene und gebackene Kacheln um die Mitte (2 → 5 × 5)
   * @param {number} [o.keep]     darüber hinaus bis zu diesem Abstand Voxel behalten, weiter weg freigeben
   */
  constructor(world, renderer, o) {
    this.world = world; this.renderer = renderer; this.backend = o.backend;
    this.radius = o.radius ?? 2; this.keep = o.keep ?? this.radius + 1;
    this.ctx = 0; this.cty = 0; this.center = null;
    this.inflight = new Map();      // key → rev
    this.queue = [];
    this.stats = { done: 0, stale: 0, uploaded: 0 };
  }
  /** Noch offene Kacheln im Fenster (wartend oder in Arbeit). */
  get pending() { return this.queue.length + this.inflight.size; }
  /** Mitte setzen (Weltkoordinaten) und fehlende Kacheln beauftragen. Jedes Bild aufrufen. */
  update(x, y) {
    const w = this.world, ctx = Math.floor(x / w.TS), cty = Math.floor(y / w.TS), key = w.key(ctx, cty);
    if (key !== this.center) {
      this.center = key; this.ctx = ctx; this.cty = cty;
      for (const t of w.evict(ctx, cty, this.keep)) t.gpu = null;
    }
    this.queue = [];
    const R = this.radius;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const tx = ctx + dx, ty = cty + dy; if (!w.inTiles(tx, ty)) continue;
      const t = w.record(tx, ty);
      if (this.ready(t) || this.inflight.has(t.key)) continue;
      this.queue.push({ tx, ty, prio: Math.max(Math.abs(dx), Math.abs(dy)) * 10 + Math.abs(dx) + Math.abs(dy) });
    }
    this.queue.sort((a, b) => a.prio - b.prio);
    this.pump();
  }
  /** Kachel ist geladen und (falls ein Renderer da ist) aktuell gebacken. */
  ready(t) { return !!t.vol && (!this.renderer || (this.renderer.resident(t) && t.gpu.rev === t.rev)); }
  pump() {
    if (this.backend.buildSync) return;          // LocalBackend: run() arbeitet synchron
    while (this.queue.length && this.inflight.size < this.backend.slots) {
      const j = this.queue.shift(), w = this.world, t = w.record(j.tx, j.ty);
      const req = w.request(j.tx, j.ty, { bake: !!this.renderer, entities: !t.generated });
      this.inflight.set(t.key, req.rev);
      this.backend.build(req).then(r => this.receive(r), err => { this.inflight.delete(t.key); console.error(err); });
    }
  }
  receive(r) {
    const w = this.world, t = w.record(r.tx, r.ty);
    this.inflight.delete(t.key); this.stats.done++;
    if (r.rev !== t.rev) { this.stats.stale++; return; }        // veraltet: nächstes update() beauftragt neu
    const vol = r.vol instanceof Volume ? r.vol : Volume.unpack(r.vol);
    if (!t.vol) { if (!w.install({ ...r, vol })) { this.stats.stale++; return; } }
    if (this.renderer && r.A && this.inWindow(r.tx, r.ty)) { this.renderer.uploadTile(t, r.A, r.B, r.bb, r.bricks); this.stats.uploaded++; }
  }
  /** Synchron abarbeiten (nur LocalBackend): bis zum Zeitbudget in ms. */
  run(budgetMs = 6) {
    if (!this.backend.buildSync) return 0;
    const t0 = now(); let n = 0;
    while (this.queue.length && now() - t0 < budgetMs) {
      const j = this.queue.shift(), w = this.world, t = w.record(j.tx, j.ty);
      const r = this.backend.buildSync(w.request(j.tx, j.ty, { bake: false, entities: !t.generated }));
      this.receive(r);
      if (this.renderer && t.vol && this.inWindow(j.tx, j.ty)) this.renderer.bakeTile(t);
      n++;
    }
    return n;
  }
  /** Liegt die Kachel im gebackenen Fenster? */
  inWindow(tx, ty) { return Math.abs(tx - this.ctx) <= this.radius && Math.abs(ty - this.cty) <= this.radius; }
  /** Fensterrechteck in Weltkoordinaten [x0, y0, x1, y1). */
  bounds() {
    const w = this.world, R = this.radius;
    return [Math.max(0, (this.ctx - R) * w.TS), Math.max(0, (this.cty - R) * w.TS), Math.min(w.W, (this.ctx + R + 1) * w.TS), Math.min(w.D, (this.cty + R + 1) * w.TS)];
  }
  /** Warten, bis das Fenster vollständig ist (für den Start). onProgress(fertig, gesamt). */
  async fill(x, y, onProgress) {
    this.update(x, y);
    const total = this.pending;
    while (this.pending) {
      if (this.backend.buildSync) this.run(30); else await new Promise(r => setTimeout(r, 16));
      this.update(x, y);
      if (onProgress) onProgress(total - this.pending, total);
      if (this.backend.buildSync) await new Promise(r => setTimeout(r, 0));
    }
  }
}
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
