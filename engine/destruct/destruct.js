// Zerstörung: Kugel ausschneiden (Ränder fein unterteilt), Trümmer erzeugen, Tragfähigkeit prüfen. DOM-frei.
// Alle Änderungen laufen über world.edit/editFine (Deltas) und world.commit, damit Darstellung, Kollision und
// Sicht auch an Kachelgrenzen nachziehen.

const EMPTY = 0;

/**
 * Kugel mit Radius r (in Blöcken) um (cx, cy, cz) entfernen.
 * Ganz innen liegende Blöcke fallen komplett weg; angeschnittene Blöcke werden unterteilt (world.sub > 1)
 * und nur ihre feinen Blöcke innerhalb der Kugel entfernt.
 * @param {object} [o]
 * @param {(x, y, z, lay) => boolean} [o.keep]   true = diesen Block nicht anfassen (z. B. Türen)
 * @param {number} [o.minZ]                       darunter nichts entfernen (Boden), Standard 1
 * @returns {{ removed: {x, y, z, size, color, lay}[], rect: number[] | null }}
 *   removed: entfernte Stücke (Mittelpunkt in Blöcken, Kantenlänge) – Rohstoff für Trümmer
 */
export function carve(world, cx, cy, cz, r, o = {}) {
  const S = world.sub, minZ = o.minZ ?? 1, removed = [];
  const x0 = Math.floor(cx - r), x1 = Math.floor(cx + r), y0 = Math.floor(cy - r), y1 = Math.floor(cy + r);
  const z0 = Math.max(minZ, Math.floor(cz - r)), z1 = Math.min(world.H - 1, Math.floor(cz + r));
  const half = Math.sqrt(3) / 2;
  for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const t = world.tileAt(x, y); if (!t || !t.vol) continue;
    const i = (z * world.TS + (y % world.TS)) * world.TS + (x % world.TS);
    const hasBrick = t.vol.bricks.size && t.vol.bricks.has(i), c = t.vol.colAt(i);
    if (!c && !hasBrick) continue;
    const lay = t.vol.layAt(i);
    if (o.keep && o.keep(x, y, z, lay)) continue;
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy, z + 0.5 - cz);
    if (d - half >= r) continue;
    if (d + half <= r || S === 1) {
      if (S === 1 && d > r) continue;
      if (hasBrick) collectFine(world, x, y, z, removed, () => true);
      else removed.push({ x: x + 0.5, y: y + 0.5, z, size: 1, color: c & 0xffffff, lay });
      world.edit(x, y, z, EMPTY);
    } else {
      // angeschnitten: nur feine Blöcke innerhalb
      for (let sz = 0; sz < S; sz++) for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const fx = x * S + sx, fy = y * S + sy, fz = z * S + sz;
        if (Math.hypot((fx + 0.5) / S - cx, (fy + 0.5) / S - cy, (fz + 0.5) / S - cz) >= r) continue;
        const fc = world.getFine(fx, fy, fz); if (!fc) continue;
        removed.push({ x: (fx + 0.5) / S, y: (fy + 0.5) / S, z: fz / S, size: 1 / S, color: fc & 0xffffff, lay: world.getFineLay(fx, fy, fz) });
        world.editFine(fx, fy, fz, EMPTY);
      }
    }
  }
  const rect = removed.length ? [x0, y0, x1, y1] : null;
  if (rect) world.commit(x0 - 1, y0 - 1, x1 + 1, y1 + 1);
  return { removed, rect };
}
function collectFine(world, x, y, z, out, f) {
  const S = world.sub;
  for (let sz = 0; sz < S; sz++) for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
    const fx = x * S + sx, fy = y * S + sy, fz = z * S + sz, c = world.getFine(fx, fy, fz);
    if (c && f(fx, fy, fz)) out.push({ x: (fx + 0.5) / S, y: (fy + 0.5) / S, z: fz / S, size: 1 / S, color: c & 0xffffff, lay: world.getFineLay(fx, fy, fz) });
  }
}

/**
 * Entfernte Stücke als Trümmer ausstoßen. Große Mengen werden ausgedünnt (max), damit es flüssig bleibt.
 * o = { settle, speed, max, from: [x, y, z] (Explosionsmitte, Stücke fliegen davon weg), size }
 */
export function shatter(debris, pieces, o = {}) {
  const max = o.max ?? 400, step = Math.max(1, pieces.length / max), sp = o.speed ?? 6;
  for (let k = 0; k < pieces.length; k += step) {
    const p = pieces[Math.floor(k)], f = o.from;
    let dx = (Math.random() - 0.5), dy = (Math.random() - 0.5), dz = Math.random() * 0.8 + 0.2;
    if (f) { dx = p.x - f[0] + dx * 0.6; dy = p.y - f[1] + dy * 0.6; dz = p.z - f[2] + 0.6; }
    const l = Math.hypot(dx, dy, dz) || 1, v = sp * (0.5 + Math.random());
    debris.emit({ x: p.x, y: p.y, z: p.z, vx: dx / l * v, vy: dy / l * v, vz: dz / l * v + (o.lift ?? 2),
      size: o.size ?? p.size, color: p.color, lay: 0, settle: o.settle, life: o.life ?? 2 + Math.random() * 2 });
  }
}

/**
 * Tragfähigkeit im Quader [x0, x1] × [y0, y1] (alle Höhen) prüfen: Blöcke ohne Verbindung (6 Nachbarn) zum Boden
 * (z = 0) oder zum Rand des Quaders gelten als lose. Am Rand wird angenommen, dass es draußen weitergeht.
 * Lose Blöcke werden entfernt und zurückgegeben (der Aufrufer macht Trümmer daraus).
 * @param {object} [o]  { keep(x, y, z, lay) → true = gilt als verankert, maxDetach (Sicherheitsgrenze) }
 * @returns {{ detached: {x, y, z, size, color, lay}[], groups: Array<Array<{x, y, z, size, color, lay}>>, components: number }}
 *   groups: die losen Gruppen einzeln (z. B. kleine als Partikel, große mit drop() fallen lassen)
 */
export function checkSupport(world, x0, y0, x1, y1, o = {}) {
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(world.W - 1, x1); y1 = Math.min(world.D - 1, y1);
  const W = x1 - x0 + 1, D = y1 - y0 + 1, H = world.H, N = W * D * H;
  const id = (x, y, z) => ((z * D + (y - y0)) * W + (x - x0));
  const solidC = new Uint8Array(N), seen = new Uint8Array(N), q = new Int32Array(N);
  let head = 0, tail = 0;
  for (let z = 0; z < H; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const t = world.tileAt(x, y); if (!t || !t.vol) continue;
    const i = (z * world.TS + (y % world.TS)) * world.TS + (x % world.TS);
    if (!t.vol.colAt(i) && !(t.vol.bricks.size && t.vol.bricks.has(i))) continue;
    const k = id(x, y, z); solidC[k] = 1;
    const anchored = z === 0 || x === x0 || x === x1 || y === y0 || y === y1 || (o.keep && o.keep(x, y, z, t.vol.layAt(i)));
    if (anchored) { seen[k] = 1; q[tail++] = k; }
  }
  while (head < tail) {
    const k = q[head++], x = k % W, y = ((k / W) | 0) % D, z = (k / (W * D)) | 0;
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      if (nx < 0 || ny < 0 || nz < 0 || nx >= W || ny >= D || nz >= H) continue;
      const j = (nz * D + ny) * W + nx;
      if (solidC[j] && !seen[j]) { seen[j] = 1; q[tail++] = j; }
    }
  }
  const detached = [], groups = [], max = o.maxDetach ?? 50000;
  let components = 0;
  for (let k = 0; k < N && detached.length < max; k++) if (solidC[k] && !seen[k]) {
    // eine lose Gruppe einsammeln (für die Zählung) und entfernen
    components++;
    const st = [k]; seen[k] = 1; const start = detached.length;
    while (st.length && detached.length < max) {
      const m = st.pop(), x = m % W + x0, y = ((m / W) | 0) % D + y0, z = (m / (W * D)) | 0;
      const t = world.tileAt(x, y), i = (z * world.TS + (y % world.TS)) * world.TS + (x % world.TS);
      if (t.vol.bricks.size && t.vol.bricks.has(i)) collectFine(world, x, y, z, detached, () => true);
      else detached.push({ x: x + 0.5, y: y + 0.5, z, size: 1, color: t.vol.colAt(i) & 0xffffff, lay: t.vol.layAt(i) });
      world.edit(x, y, z, EMPTY);
      const lx = x - x0, ly = y - y0;
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const nx = lx + dx, ny = ly + dy, nz = z + dz;
        if (nx < 0 || ny < 0 || nz < 0 || nx >= W || ny >= D || nz >= H) continue;
        const j = (nz * D + ny) * W + nx;
        if (solidC[j] && !seen[j]) { seen[j] = 1; st.push(j); }
      }
    }
    groups.push(detached.slice(start));
  }
  if (detached.length) world.commit(x0, y0, x1, y1);
  return { detached, groups, components };
}

/**
 * Eine lose Gruppe als Ganzes fallen lassen, bis sie aufliegt, und wieder in die Welt schreiben (bleibende Änderung).
 * Die Gruppe darf schon aus der Welt entfernt sein (wie nach checkSupport). Arbeitet im feinen Gitter, damit auch
 * unterteilte Stücke passen. Liefert die Fallhöhe in Blöcken und die Stücke an ihrer neuen Stelle.
 */
export function drop(world, pieces) {
  if (!pieces.length) return { fall: 0, pieces };
  const S = world.sub, low = new Map();
  for (const p of pieces) {
    const n = Math.max(1, Math.round(p.size * S)), fx0 = Math.round(p.x * S - n / 2), fy0 = Math.round(p.y * S - n / 2), fz = Math.round(p.z * S);
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) { const k = (fx0 + a) + ',' + (fy0 + b), v = low.get(k); if (v === undefined || fz < v) low.set(k, fz); }
  }
  let fall = 1e9;
  for (const [k, fz] of low) {
    const [fx, fy] = k.split(',').map(Number);
    let d = 0; while (fz - d - 1 >= 0 && !world.getFine(fx, fy, fz - d - 1) && d < fall) d++;
    if (fz - d - 1 < 0) d = Math.min(d, fz);
    fall = Math.min(fall, d);
  }
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  const out = [];
  for (const p of pieces) {
    const n = Math.max(1, Math.round(p.size * S)), fx0 = Math.round(p.x * S - n / 2), fy0 = Math.round(p.y * S - n / 2), fz0 = Math.round(p.z * S) - fall;
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) for (let c = 0; c < n; c++) world.editFine(fx0 + a, fy0 + b, fz0 + c, p.color | 0x1000000, p.lay & ~4);
    out.push({ ...p, z: fz0 / S });
    x0 = Math.min(x0, Math.floor(fx0 / S)); y0 = Math.min(y0, Math.floor(fy0 / S)); x1 = Math.max(x1, Math.floor((fx0 + n) / S)); y1 = Math.max(y1, Math.floor((fy0 + n) / S));
  }
  world.commit(x0 - 1, y0 - 1, x1 + 1, y1 + 1);
  return { fall: fall / S, pieces: out };
}
