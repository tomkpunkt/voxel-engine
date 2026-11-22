// Partikel in Weltkoordinaten, gezeichnet auf eine 2D-Leinwand über dem WebGL-Bild.
// Typen: blood (fällt, wird beim Aufprall zum Decal), spark, ember, shell, smoke, tracer (Linie), swing (Bogen).

export class Particles {
  constructor(max = 900) { this.list = []; this.max = max; }
  emit(type, x, y, z, n, o = {}) {
    for (let i = 0; i < n; i++) {
      const a = (o.dir ?? Math.random() * 6.283) + (Math.random() - 0.5) * (o.spread ?? 6.283), sp = (o.speed ?? 8) * (0.4 + Math.random() * 0.8);
      this.list.push({ type, x, y, z, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, vz: (o.vz ?? 5) * (0.5 + Math.random()), life: (o.life ?? 0.8) * (0.6 + Math.random() * 0.6), t: 0 });
    }
  }
  add(p) { this.list.push({ t: 0, ...p }); }
  /** onLand(p) wird für Blut am Boden aufgerufen (z. B. renderer.decal). */
  update(dt, onLand) {
    const L = this.list;
    for (let i = L.length - 1; i >= 0; i--) {
      const p = L[i]; p.t += dt;
      if (p.t >= p.life) { L.splice(i, 1); continue; }
      if (p.type === 'tracer' || p.type === 'swing') continue;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.type === 'smoke') { p.vz = 3; p.vx *= 0.98; p.vy *= 0.98; continue; }
      if (p.type === 'ember') { p.vz *= 0.99; continue; }
      p.vz -= 40 * dt;
      if (p.z <= 0.5) {
        if (p.type === 'blood') { if (onLand) onLand(p); L.splice(i, 1); continue; }
        p.z = 0.5; p.vz *= -0.3; p.vx *= 0.5; p.vy *= 0.5;
      }
    }
    if (L.length > this.max) L.splice(0, L.length - this.max);
  }
  draw(ctx, cam) {
    const ps = Math.max(1, Math.round(cam.zoom / 7));
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.list) {
      const a = 1 - p.t / p.life;
      if (p.type === 'tracer') {
        const [x1, y1] = cam.project(p.x, p.y, p.z), [x2, y2] = cam.project(p.x2, p.y2, p.z);
        ctx.strokeStyle = `rgba(255,220,150,${a})`; ctx.lineWidth = ps; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      } else if (p.type === 'swing') {
        ctx.strokeStyle = `rgba(230,230,220,${a * 0.6})`; ctx.lineWidth = 2 * ps; ctx.beginPath();
        for (let k = 0; k <= 8; k++) { const ang = p.a - p.arc / 2 + p.arc * k / 8, [x, y] = cam.project(p.x + Math.cos(ang) * p.r, p.y + Math.sin(ang) * p.r, p.z); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
        ctx.stroke();
      } else if (p.type === 'spark' || p.type === 'ember') {
        const [x, y] = cam.project(p.x, p.y, p.z); ctx.fillStyle = `rgba(255,${150 + a * 90 | 0},60,${a})`; ctx.fillRect(Math.round(x), Math.round(y), ps, ps);
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    for (const p of this.list) {
      const a = 1 - p.t / p.life;
      if (p.type === 'blood') { const [x, y] = cam.project(p.x, p.y, p.z); ctx.fillStyle = `rgba(110,10,8,${Math.min(1, a * 2)})`; ctx.fillRect(Math.round(x), Math.round(y), ps + 1, ps + 1); }
      else if (p.type === 'shell') { const [x, y] = cam.project(p.x, p.y, p.z); ctx.fillStyle = `rgba(200,160,60,${Math.min(1, a * 3)})`; ctx.fillRect(Math.round(x), Math.round(y), ps, ps); }
      else if (p.type === 'smoke') { const [x, y] = cam.project(p.x, p.y, p.z), r = (1 + p.t * 3) * cam.zoom * 0.7; ctx.fillStyle = `rgba(120,120,130,${a * 0.18})`; ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.fill(); }
    }
  }
}
