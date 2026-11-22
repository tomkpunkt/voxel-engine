// Flow Field: Entfernungsfeld vom Ziel über die Wegkarte der Welt (8 Nachbarn, keine Ecken schneiden).
// Viele Verfolger teilen sich ein Feld; jeder geht zur Nachbarzelle mit dem kleinsten Wert.
// Das Feld deckt nur ein Quadrat um das Ziel ab (Kantenlänge 2·maxD + 3), nicht die ganze Welt:
// bei einer Stadt von 5000 × 5000 Voxeln wären das sonst 100 MB pro Feld.

export class FlowField {
  /** @param {World} world @param {number} [maxD] größte Entfernung (bestimmt die Feldgröße) */
  constructor(world, maxD = 140) {
    this.world = world; this.setSize(maxD);
  }
  setSize(maxD) {
    this.maxD = maxD; this.S = 2 * Math.ceil(maxD) + 3;
    const N = this.S * this.S;
    this.field = new Float32Array(N).fill(1e9);
    this.block = new Uint8Array(N);
    this.queue = new Int32Array(N);
    this.ox = 0; this.oy = 0;
  }
  /** Feld vom Ziel (x, y) aus neu rechnen. */
  compute(x, y, maxD = this.maxD) {
    if (maxD > this.maxD) this.setSize(maxD);
    const S = this.S, f = this.field, q = this.queue, bl = this.block, N = S * S, w = this.world;
    this.ox = Math.floor(x) - (S >> 1); this.oy = Math.floor(y) - (S >> 1);
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) bl[j * S + i] = w.pathBlockedAt(this.ox + i, this.oy + j) ? 1 : 0;
    f.fill(1e9);
    const s = (S >> 1) * S + (S >> 1);
    let head = 0, tail = 0, size = 0;
    f[s] = 0; q[tail] = s; tail = (tail + 1) % N; size++;
    while (size > 0) {
      const i = q[head]; head = (head + 1) % N; size--;
      const d0 = f[i]; if (d0 > maxD) continue;
      const cx = i % S, cy = (i / S) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= S || ny >= S) continue;
        const j = ny * S + nx; if (bl[j]) continue;
        const diag = dx && dy;
        if (diag && (bl[cy * S + nx] || bl[ny * S + cx])) continue;
        const nd = d0 + (diag ? 1.414 : 1);
        if (nd < f[j]) { f[j] = nd; if (size < N) { q[tail] = j; tail = (tail + 1) % N; size++; } }
      }
    }
  }
  value(x, y) {
    const i = Math.floor(x) - this.ox, j = Math.floor(y) - this.oy;
    return i < 0 || j < 0 || i >= this.S || j >= this.S ? 1e9 : this.field[j * this.S + i];
  }
  /** Einheitsvektor Richtung Ziel oder null, wenn kein Weg bekannt ist. */
  dir(x, y) {
    const S = this.S, f = this.field, bl = this.block, cx = Math.floor(x) - this.ox, cy = Math.floor(y) - this.oy;
    if (cx < 1 || cy < 1 || cx >= S - 1 || cy >= S - 1) return null;
    let best = f[cy * S + cx], bx = -1, by = -1;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = cx + dx, ny = cy + dy;
      if (dx && dy && (bl[cy * S + nx] || bl[ny * S + cx])) continue;
      const v = f[ny * S + nx];
      if (v < best) { best = v; bx = nx; by = ny; }
    }
    if (bx < 0 || best > 1e8) return null;
    const ex = bx + this.ox + 0.5 - x, ey = by + this.oy + 0.5 - y, l = Math.hypot(ex, ey) || 1;
    return [ex / l, ey / l];
  }
}
