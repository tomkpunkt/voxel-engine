// Flow Field: Entfernungsfeld vom Ziel über die Wegkarte der Welt (8 Nachbarn, keine Ecken schneiden).
// Viele Verfolger teilen sich ein Feld; jeder geht zur Nachbarzelle mit dem kleinsten Wert.

export class FlowField {
  constructor(world) {
    this.world = world;
    const N = world.W * world.D;
    this.field = new Float32Array(N).fill(1e9);
    this.queue = new Int32Array(N);
  }
  /** Feld vom Ziel (x, y) aus bis zur Entfernung maxD neu rechnen. */
  compute(x, y, maxD = 140) {
    const { W, D, pathBlocked } = this.world, f = this.field, q = this.queue, N = W * D;
    f.fill(1e9);
    if (!this.world.inside(x, y)) return;
    const s = (y | 0) * W + (x | 0);
    let head = 0, tail = 0, size = 0;
    f[s] = 0; q[tail] = s; tail = (tail + 1) % N; size++;
    while (size > 0) {
      const i = q[head]; head = (head + 1) % N; size--;
      const d0 = f[i]; if (d0 > maxD) continue;
      const cx = i % W, cy = (i / W) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= D) continue;
        const j = ny * W + nx; if (pathBlocked[j]) continue;
        const diag = dx && dy;
        if (diag && (pathBlocked[cy * W + nx] || pathBlocked[ny * W + cx])) continue;
        const nd = d0 + (diag ? 1.414 : 1);
        if (nd < f[j]) { f[j] = nd; if (size < N) { q[tail] = j; tail = (tail + 1) % N; size++; } }
      }
    }
  }
  value(x, y) { return this.world.inside(x, y) ? this.field[(y | 0) * this.world.W + (x | 0)] : 1e9; }
  /** Einheitsvektor Richtung Ziel oder null, wenn kein Weg bekannt ist. */
  dir(x, y) {
    const { W, D, pathBlocked } = this.world, f = this.field, cx = x | 0, cy = y | 0;
    if (!this.world.inside(cx, cy)) return null;
    let best = f[cy * W + cx], bx = -1, by = -1;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = cx + dx, ny = cy + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= D) continue;
      if (dx && dy && (pathBlocked[cy * W + nx] || pathBlocked[ny * W + cx])) continue;
      const v = f[ny * W + nx];
      if (v < best) { best = v; bx = nx; by = ny; }
    }
    if (bx < 0 || best > 1e8) return null;
    const ex = bx + 0.5 - x, ey = by + 0.5 - y, l = Math.hypot(ex, ey) || 1;
    return [ex / l, ey / l];
  }
}
