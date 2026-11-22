// Streaming: hält ein Fenster aus Kacheln um einen Punkt erzeugt und gebacken.
// Etappe 1 arbeitet in Zeitscheiben auf dem Haupt-Thread; Etappe 2 verlegt Erzeugen und Backen in Worker.
// Jeder Auftrag merkt sich die Kachelrevision; ein Ergebnis zu einer älteren Revision wird verworfen.

export class Streamer {
  /**
   * @param {World} world
   * @param {Renderer} renderer   mit attachWorld(world, 2·radius + 1)
   * @param {object} [o]
   * @param {number} [o.radius]   gebackene Kacheln um die Mitte (2 → 5 × 5)
   * @param {number} [o.keep]     erzeugte Kacheln um die Mitte, darüber hinaus werden Voxel freigegeben
   */
  constructor(world, renderer, o = {}) {
    this.world = world; this.renderer = renderer;
    this.radius = o.radius ?? 2; this.keep = o.keep ?? this.radius + 1;
    this.center = null; this.jobs = [];
  }
  get pending() { return this.jobs.length; }
  /** Mitte setzen (Weltkoordinaten). Plant neu, wenn sich die Mittelkachel ändert. */
  update(x, y, force = false) {
    const w = this.world, ctx = Math.floor(x / w.TS), cty = Math.floor(y / w.TS), key = cty * w.tilesX + ctx;
    if (key === this.center && !force) return;
    this.center = key; this.ctx = ctx; this.cty = cty;
    for (const t of w.evict(ctx, cty, this.keep)) t.gpu = null;
    this.jobs = [];
    const R = this.radius;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const tx = ctx + dx, ty = cty + dy; if (!w.inTiles(tx, ty)) continue;
      const t = w.tileOf(tx, ty);
      if (t && t.vol && this.renderer.resident(t) && t.gpu.rev === t.rev) continue;
      this.jobs.push({ tx, ty, prio: Math.max(Math.abs(dx), Math.abs(dy)) * 10 + Math.abs(dx) + Math.abs(dy) });
    }
    this.jobs.sort((a, b) => a.prio - b.prio);
  }
  /** Bereich (Weltkoordinaten) liegt im gebackenen Fenster? */
  inWindow(x, y) {
    const w = this.world, tx = Math.floor(x / w.TS), ty = Math.floor(y / w.TS);
    return Math.abs(tx - this.ctx) <= this.radius && Math.abs(ty - this.cty) <= this.radius;
  }
  /** Fensterrechteck in Weltkoordinaten [x0, y0, x1, y1). */
  bounds() {
    const w = this.world, R = this.radius;
    return [Math.max(0, (this.ctx - R) * w.TS), Math.max(0, (this.cty - R) * w.TS), Math.min(w.W, (this.ctx + R + 1) * w.TS), Math.min(w.D, (this.cty + R + 1) * w.TS)];
  }
  runJob(j) {
    const w = this.world;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) w.ensure(j.tx + dx, j.ty + dy);   // Nachbarn für Normalen am Rand
    const t = w.tileOf(j.tx, j.ty);
    if (t && t.vol) this.renderer.bakeTile(t);
  }
  /** Aufträge abarbeiten, bis das Zeitbudget (ms) aufgebraucht ist. Liefert die Zahl erledigter Aufträge. */
  run(budgetMs = 6) {
    const t0 = performance.now(); let n = 0;
    while (this.jobs.length && performance.now() - t0 < budgetMs) { this.runJob(this.jobs.shift()); n++; }
    return n;
  }
}
