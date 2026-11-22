// Split-Grammatik für Grundrisse (nach Müller et al. 2006, sinngemäß).
// Ein Rechteck w × d (Außenwände auf dem Rand) wird rekursiv geteilt. Jede Trennwand bekommt ihre Tür
// erst nach der Rekursion, und zwar dort, wo die beiden Seiten die längste gemeinsame Kante haben.
// Danach: Zimmertypen, Haustür an der Straßenseite, Fenster je Außenseite.

/**
 * @param {() => number} rng
 * @param {number} w @param {number} d   Außenmaße in Voxeln
 * @param {number} front                 Straßenseite 0 N, 1 O, 2 S, 3 W
 * @param {object} o
 * @param {number} o.min                 Mindest-Innenmaß eines Zimmers
 * @param {number} o.doorW               Türbreite
 * @param {number} o.windowW             Fensterbreite
 * @param {number} [o.bigWindowW]        Fensterbreite im Hauptzimmer
 * @param {string[]} [o.types]           Zimmertypen, erster = Hauptzimmer
 * @param {number} [o.maxDepth]
 */
export function planRooms(rng, w, d, front, o) {
  const MIN = o.min, maxDepth = o.maxDepth ?? 3, DW = o.doorW;
  const doors = [];
  const inner = r => [r.x1 - r.x0 - 1, r.y1 - r.y0 - 1];
  function split(r, depth) {
    const [iw, ih] = inner(r);
    const canV = iw >= 2 * MIN + 1, canH = ih >= 2 * MIN + 1;
    const stop = (!canV && !canH) || depth >= maxDepth || (depth >= 1 && iw * ih < 520 && rng() < 0.6) || (depth >= 2 && rng() < 0.35);
    if (stop) return [r];
    const vert = canV && (!canH || (iw >= ih ? rng() < 0.8 : rng() < 0.2));
    const len = vert ? iw : ih;
    const s = (vert ? r.x0 : r.y0) + MIN + 1 + Math.floor(rng() * (len - 2 * MIN));
    const A = split(vert ? { ...r, x1: s } : { ...r, y1: s }, depth + 1);
    const B = split(vert ? { ...r, x0: s } : { ...r, y0: s }, depth + 1);
    let best = null, bl = 0;
    for (const a of A) for (const b of B) {
      const touch = vert ? a.x1 === s && b.x0 === s : a.y1 === s && b.y0 === s;
      if (!touch) continue;
      const lo = vert ? Math.max(a.y0, b.y0) + 1 : Math.max(a.x0, b.x0) + 1;
      const hi = vert ? Math.min(a.y1, b.y1) - 1 : Math.min(a.x1, b.x1) - 1;
      if (hi - lo + 1 > bl) { bl = hi - lo + 1; best = [lo, hi]; }
    }
    if (best && bl >= DW + 2) {
      const p = best[0] + 1 + Math.floor(rng() * (bl - DW - 1));
      doors.push(vert ? { x: s, y: p, v: true } : { x: p, y: s, v: false });
    }
    return [...A, ...B];
  }
  const rooms = split({ x0: 0, y0: 0, x1: w - 1, y1: d - 1 }, 0);
  const touches = (r, side) => side === 0 ? r.y0 === 0 : side === 2 ? r.y1 === d - 1 : side === 3 ? r.x0 === 0 : r.x1 === w - 1;
  const area = r => { const [a, b] = inner(r); return a * b; };
  const adjacent = (a, b) => (a.x1 === b.x0 || b.x1 === a.x0) && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 2
    || (a.y1 === b.y0 || b.y1 === a.y0) && Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 2;
  const types = o.types || ['wohn', 'kueche', 'schlaf', 'bad', 'schlaf', 'buero', 'kinder'];
  const main = rooms.filter(r => touches(r, front)).sort((a, b) => area(b) - area(a))[0];
  main.type = types[0];
  const rest = rooms.filter(r => r !== main).sort((a, b) => area(a) - area(b));
  if (rest.length >= 2 && types.includes('bad')) rest.shift().type = 'bad';
  const kit = rest.filter(r => !r.type).sort((a, b) => (adjacent(b, main) - adjacent(a, main)) || area(b) - area(a))[0];
  if (kit && types.includes('kueche')) kit.type = 'kueche';
  const others = types.filter(t => !['wohn', 'kueche', 'bad'].includes(t));
  let oi = 0;
  for (const r of rest.filter(r => !r.type).sort((a, b) => area(b) - area(a))) r.type = others[oi++ % others.length];
  const horizF = front === 0 || front === 2;
  const lo = (horizF ? main.x0 : main.y0) + 2, hi = (horizF ? main.x1 : main.y1) - 2 - DW;
  const fp = lo + Math.floor(rng() * Math.max(1, hi - lo + 1));
  const frontDoor = horizF ? { x: fp, y: front === 0 ? 0 : d - 1, v: false } : { x: front === 3 ? 0 : w - 1, y: fp, v: true };
  const windows = [];
  for (const r of rooms) for (let side = 0; side < 4; side++) {
    if (!touches(r, side)) continue;
    const hz = side === 0 || side === 2;
    const a = hz ? r.x0 + 1 : r.y0 + 1, b = hz ? r.x1 - 1 : r.y1 - 1, L = b - a + 1;
    if (L < 9) continue;
    const ww = Math.min(r === main && o.bigWindowW ? o.bigWindowW : o.windowW, L - 4);
    let s = a + Math.floor((L - ww) / 2);
    if (side === front && r === main) {
      const dl = fp, dh = fp + DW - 1;
      if (s <= dh + 1 && s + ww - 1 >= dl - 1) { s = dh + 2 + ww - 1 <= b - 1 ? dh + 2 : dl - 1 - ww; if (s < a + 1) continue; }
    }
    const pos = hz ? { x: s, y: side === 0 ? 0 : d - 1 } : { x: side === 3 ? 0 : w - 1, y: s };
    windows.push({ ...pos, len: ww, hz, room: r });
  }
  return { w, d, rooms, doors, frontDoor, windows, front };
}
