#!/usr/bin/env python3
"""Lichter-Stressszene messen (Abnahme Etappe 4): Bildzeiten für 8 … 256 Lichter, mit 0 und 8 Schattenwerfern.
Aufruf: python3 -m http.server 8765 &  python3 tools/lichter.py
Werte nur auf derselben Maschine vergleichen (headless ohne GPU: Software-Rendering)."""
import asyncio, json, os, sys
from playwright.async_api import async_playwright
BASE = os.environ.get('VE_BASE', 'http://localhost:8765'); CHROME = os.environ.get('VE_CHROME', '/usr/bin/google-chrome')
MESS = """() => new Promise(done => { const t = []; let l = performance.now(); const f = () => { const n = performance.now(); t.push(n - l); l = n;
  if (t.length < 90) requestAnimationFrame(f); else { t.shift(); t.sort((a, b) => a - b); const R = VE_DEMO.R;
  done({ p50: +t[44].toFixed(1), p90: +t[80].toFixed(1), refs: R.stats.lightRefs, dropped: R.stats.lightsDropped }); } }; requestAnimationFrame(f); })"""
async def main():
    rows = []
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=CHROME, args=['--no-sandbox'])
        for sh in [0, 8]:
            for n in [8, 32, 64, 128, 256]:
                pg = await b.new_page(viewport={'width': 1000, 'height': 640}); errs = []
                pg.on('pageerror', lambda e: errs.append(str(e)))
                await pg.goto(f'{BASE}/examples/lichter/index.html?n={n}&schatten={sh}')
                await pg.wait_for_function('window.VE_READY === true', timeout=60000); await pg.wait_for_timeout(800)
                r = await pg.evaluate(MESS); r.update({'lichter': n, 'schatten': sh, 'fehler': errs[:2]}); rows.append(r)
                print(json.dumps(r, ensure_ascii=False))
                if n == 256 and sh == 8: await pg.screenshot(path=sys.argv[1] if len(sys.argv) > 1 else 'lichter.png')
                await pg.close()
        await b.close()
asyncio.run(main())
