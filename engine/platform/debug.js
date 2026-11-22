// Debug-Overlay und Profiler. Einblenden mit F3 oder URL-Parameter ?debug.
// Profiler: prof.begin('Name') … prof.end('Name') pro Bild; prof.frame() am Ende des Bildes.

export class Profiler {
  constructor() { this.cur = new Map(); this.avg = new Map(); this.frames = []; this.last = 0; }
  begin(name) { this.cur.set(name, performance.now() - (this.cur.get(name) || 0)); }
  end(name) { const t0 = this.cur.get(name); this.cur.set(name, performance.now() - t0); }
  /** Bild abschließen: Abschnittszeiten glätten, Bildabstand merken. */
  frame() {
    const now = performance.now();
    if (this.last) { this.frames.push(now - this.last); if (this.frames.length > 240) this.frames.shift(); }
    this.last = now;
    for (const [k, v] of this.cur) this.avg.set(k, (this.avg.get(k) ?? v) * 0.9 + v * 0.1);
    this.cur.clear();
  }
  stats() {
    const f = [...this.frames].sort((a, b) => a - b), q = p => f.length ? f[Math.min(f.length - 1, Math.floor(f.length * p))] : 0;
    return { fps: f.length ? 1000 / (this.frames.reduce((a, b) => a + b, 0) / f.length) : 0, p50: q(0.5), p95: q(0.95), max: q(1) };
  }
}

export class DebugOverlay {
  /** @param {Profiler} prof @param {() => object} info  liefert weitere Zeilen { Name: Wert } */
  constructor(prof, info) {
    this.prof = prof; this.info = info;
    this.el = document.createElement('div');
    this.el.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:50;background:#05070bd8;color:#cfe;font:11px/1.4 ui-monospace,Menlo,monospace;padding:6px 8px;border:1px solid #2a3140;pointer-events:none;white-space:pre;display:none';
    this.cv = document.createElement('canvas'); this.cv.width = 200; this.cv.height = 40; this.cv.style.cssText = 'display:block;margin-top:4px;width:200px;height:40px';
    this.txt = document.createElement('div');
    this.el.append(this.txt, this.cv); document.body.append(this.el);
    this.visible = new URLSearchParams(location.search).has('debug');
    this.el.style.display = this.visible ? 'block' : 'none';
    addEventListener('keydown', e => { if (e.key === 'F3') { e.preventDefault(); this.toggle(); } });
    this.t = 0;
  }
  toggle() { this.visible = !this.visible; this.el.style.display = this.visible ? 'block' : 'none'; }
  update(dt) {
    if (!this.visible) return;
    this.t -= dt; if (this.t > 0) return; this.t = 0.25;
    const s = this.prof.stats(), lines = [`${s.fps.toFixed(0)} fps · p50 ${s.p50.toFixed(1)} ms · p95 ${s.p95.toFixed(1)} · max ${s.max.toFixed(0)}`];
    for (const [k, v] of this.prof.avg) lines.push(`${k.padEnd(10)} ${v.toFixed(2)} ms`);
    const extra = this.info ? this.info() : {};
    for (const k in extra) lines.push(`${k.padEnd(10)} ${extra[k]}`);
    this.txt.textContent = lines.join('\n');
    const g = this.cv.getContext('2d'), F = this.prof.frames;
    g.clearRect(0, 0, 200, 40); g.fillStyle = '#1a2230'; g.fillRect(0, 40 - 16.7 * 40 / 50, 200, 1);
    for (let i = 0; i < Math.min(200, F.length); i++) {
      const v = F[F.length - 1 - i], h = Math.min(40, v * 40 / 50);
      g.fillStyle = v > 33 ? '#e05040' : v > 17 ? '#e0c040' : '#50c070'; g.fillRect(199 - i, 40 - h, 1, h);
    }
  }
}
