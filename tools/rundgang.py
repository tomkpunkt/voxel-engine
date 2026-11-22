#!/usr/bin/env python3
"""Reproduzierbarer Rundgang durch Totenstadt (Abnahme Etappe 2).

Fährt mit fester Saat eine feste Route quer durch die Stadt (über 1 km), misst Bildzeiten, Streaming und Speicher
und prüft danach, ob eine geänderte Kachel (Tür umgelegt, Loch in der Wand) nach dem Entladen und Neuladen
ihren Zustand behalten hat.

Aufruf (Server im Repo-Wurzelverzeichnis):
    python3 -m http.server 8765 &
    python3 tools/rundgang.py [bericht.json]

Die Bildzeiten hängen stark von der Maschine ab (headless ohne GPU: Software-Rendering). Verglichen werden
sollten Läufe auf derselben Maschine. Beendet mit Code 1, wenn Seitenfehler auftreten oder der Zustand verloren geht.
"""
import asyncio, json, os, sys
from playwright.async_api import async_playwright

BASE = os.environ.get('VE_BASE', 'http://localhost:8765')
CHROME = os.environ.get('VE_CHROME', '/usr/bin/google-chrome')
OUT = sys.argv[1] if len(sys.argv) > 1 else None
SAAT = 4711
SCHRITT = 3.0          # Voxel pro Bild (bei 60 Bildern/s ≈ 36 m/s, also deutlich schneller als zu Fuß)
# Route in Grundstücken (80 Voxel = 16 m); Start ist die Mitte (32, 32)
ROUTE = [(32.5, 32.5), (58.5, 32.5), (58.5, 58.5), (8.5, 58.5), (8.5, 8.5)]

SETUP = """(()=>{
  const d = TS_DEBUG, P = d.P, c = d.city, w = d.world;
  // Zustand ändern: nächste Tür umlegen, Loch in eine Wand neben der Tür
  const dr = c.doors.filter(x => !x.broken && w.tileAt(x.x, x.y) && w.tileAt(x.x, x.y).vol).sort((a, b) => Math.hypot(a.x - P.x, a.y - P.y) - Math.hypot(b.x - P.x, b.y - P.y))[0];
  dr.open = !dr.open; d.applyDoor(dr);
  const t = w.tileAt(dr.x, dr.y);
  let hole = null;
  for (let r = 1; r < 40 && !hole; r++) for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r]]) {
    const x = dr.x + dx, y = dr.y + dy;
    if (w.tileAt(x, y) === t && w.getC(x, y, 3) && w.getC(x, y, 2)) { hole = [x, y]; break; }
  }
  w.edit(hole[0], hole[1], 3, 0); w.commit(hole[0] - 1, hole[1] - 1, hole[0] + 1, hole[1] + 1);
  window.__probe = { door: { x: dr.x, y: dr.y, tile: dr.tile, idx: dr.idx, open: dr.open }, hole, tile: t.key };
  return window.__probe;
})()"""

DRIVE = """([route, step]) => new Promise(done => {
  const d = TS_DEBUG, P = d.P, s = d.stream, w = d.world, R = d.R, TS = w.TS;
  const pts = route.map(([x, y]) => [x * TS, y * TS]);
  let seg = 0, f = 0, maxPending = 0, maxLoaded = 0, maxWorld = 0, maxHeap = 0, slow = 0;
  const t0 = performance.now(), times = [], unready = [];
  let last = performance.now();
  const tick = () => {
    const now = performance.now(); times.push(now - last); last = now; f++;
    const [ax, ay] = [P.x, P.y], [bx, by] = pts[seg + 1], dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy);
    if (l <= step) { P.x = bx; P.y = by; seg++; } else { P.x += dx / l * step; P.y += dy / l * step; }
    P.aim = Math.atan2(dy, dx);
    d.zombies = [];
    maxPending = Math.max(maxPending, s.pending);
    let loaded = 0; for (const t of w.tiles.values()) if (t.vol) loaded++;
    maxLoaded = Math.max(maxLoaded, loaded);
    if (f % 30 === 0) { maxWorld = Math.max(maxWorld, w.bytes()); if (performance.memory) maxHeap = Math.max(maxHeap, performance.memory.usedJSHeapSize); }
    const here = w.tileAt(P.x, P.y);
    if (!here || !R.resident(here)) unready.push(f);           // Bild, in dem die eigene Kachel noch nicht gebacken war
    if (seg >= pts.length - 1) {
      const sorted = times.slice(1).sort((a, b) => a - b), q = p => sorted[Math.floor(sorted.length * p)];
      done({ frames: f, seconds: (performance.now() - t0) / 1000, distanceVoxel: Math.round(pts.slice(1).reduce((a, p, i) => a + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0)),
        frameMs: { p50: q(0.5), p95: q(0.95), p99: q(0.99), max: sorted[sorted.length - 1] },
        stream: { ...s.stats, maxPending }, builder: s.backend.stats, unreadyFrames: unready.length,
        memory: { maxLoadedTiles: maxLoaded, worldMB: maxWorld / 1e6, gpuMB: R.gpuBytes() / 1e6, heapMB: maxHeap / 1e6 } });
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})"""

CHECK = """async () => {
  const d = TS_DEBUG, P = d.P, w = d.world, pr = window.__probe, t = w.tiles.get(pr.tile);
  const before = { loaded: !!t.vol };
  P.x = pr.door.x + 0.5; P.y = pr.door.y + 8.5;
  const t0 = performance.now();
  while ((!t.vol || !d.R.resident(t)) && performance.now() - t0 < 30000) await new Promise(r => setTimeout(r, 50));
  const dr = d.city.doors.find(x => x.tile === pr.tile && x.idx === pr.door.idx);
  return { unloadedDuringRoute: !before.loaded, reloaded: !!t.vol, resident: d.R.resident(t), reloadMs: performance.now() - t0,
    doorOpenAsSet: dr.open === pr.door.open, holeStillThere: w.getC(pr.hole[0], pr.hole[1], 3) === 0,
    doorCollisionMatches: (() => { const g = dr.v ? [dr.x, dr.y + 2] : [dr.x + 2, dr.y]; return w.isBlocked(g[0], g[1]) === !dr.open; })(),
    entitiesOnce: d.city.doors.filter(x => x.tile === pr.tile && x.idx === pr.door.idx).length === 1 };
}"""

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=CHROME, args=['--no-sandbox', '--enable-precise-memory-info'])
        pg = await b.new_page(viewport={'width': 1000, 'height': 640})
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' and 'favicon' not in m.text and '404' not in m.text else None)
        await pg.goto(f'{BASE}/games/totenstadt/index.html?saat={SAAT}&leer')
        await pg.wait_for_function("!document.getElementById('bPlay').disabled", timeout=120000)
        await pg.evaluate("document.getElementById('bPlay').click()")
        await pg.wait_for_timeout(500)
        probe = await pg.evaluate(SETUP)
        bericht = await pg.evaluate(DRIVE, [ROUTE, SCHRITT])
        bericht['zustand'] = await pg.evaluate(CHECK)
        bericht['probe'] = probe
        bericht['fehler'] = errs[:5]
        await pg.screenshot(path='/tmp/rundgang-ende.png')
        await b.close()
    txt = json.dumps(bericht, indent=2, ensure_ascii=False)
    print(txt)
    if OUT:
        with open(OUT, 'w') as f: f.write(txt)
    z = bericht['zustand']
    ok = not errs and z['unloadedDuringRoute'] and z['reloaded'] and z['doorOpenAsSet'] and z['holeStillThere'] and z['doorCollisionMatches'] and z['entitiesOnce']
    sys.exit(0 if ok else 1)

asyncio.run(main())
