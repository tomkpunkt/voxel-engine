#!/usr/bin/env python3
"""Headless-Screenshots mit fester Saat, Kamera und Tageszeit (Abnahme Etappe 1).

Aufruf (aus dem Repo-Wurzelverzeichnis, ein lokaler Server muss laufen):
    python3 -m http.server 8765 &
    python3 tools/screenshots.py [ausgabeordner]

Braucht Playwright für Python und Chrome/Chromium. Gibt pro Szene eine PNG-Datei und
eine Zeile mit Kennzahlen aus; beendet mit Code 1, wenn Seitenfehler auftreten.
"""
import asyncio, json, os, sys
from playwright.async_api import async_playwright

BASE = os.environ.get('VE_BASE', 'http://localhost:8765')
CHROME = os.environ.get('VE_CHROME', '/usr/bin/google-chrome')
OUT = sys.argv[1] if len(sys.argv) > 1 else 'screenshots'

# (Name, URL, Kamera {yaw, pitch, zoom} in Grad bzw. Faktor, Aktion)
SZENEN = [
    ('totenstadt-nacht', '/games/totenstadt/index.html?saat=4711&leer', {'yaw': 45, 'pitch': 52}, None),
    ('totenstadt-flach', '/games/totenstadt/index.html?saat=4711&leer', {'yaw': 120, 'pitch': 32}, None),
    ('totenstadt-steil', '/games/totenstadt/index.html?saat=4711&leer', {'yaw': 200, 'pitch': 85}, None),
    ('totenstadt-mittag', '/games/totenstadt/index.html?saat=4711&leer&zeit=12', {'yaw': 45, 'pitch': 52}, None),
    ('totenstadt-haus', '/games/totenstadt/index.html?saat=4711&leer', {'yaw': 45, 'pitch': 60, 'zoom': 1.6}, 'haus'),
    ('kleine-welt-tag', '/examples/kleine-welt/index.html?zeit=11', {'yaw': 30, 'pitch': 50}, None),
    ('kleine-welt-abend', '/examples/kleine-welt/index.html?zeit=19.5', {'yaw': 160, 'pitch': 40}, None),
    ('kleine-welt-nacht', '/examples/kleine-welt/index.html?zeit=23', {'yaw': 250, 'pitch': 70}, None),
]

HAUS = """(()=>{const d=TS_DEBUG, P=d.P, c=d.city;
  const b=c.buildings.filter(b=>b.kind==='Haus').sort((a,e)=>Math.hypot((a.x0+a.x1)/2-P.x,(a.y0+a.y1)/2-P.y)-Math.hypot((e.x0+e.x1)/2-P.x,(e.y0+e.y1)/2-P.y))[0];
  for(const dr of c.doors) if(dr.x>=b.x0-1&&dr.x<=b.x1+1&&dr.y>=b.y0-1&&dr.y<=b.y1+1&&!dr.broken&&!dr.open){dr.open=true;d.applyDoor(dr);}
  P.x=(b.x0+b.x1)/2+0.5; P.y=(b.y0+b.y1)/2+0.5; for(let r=0;r<40&&!d.world.free(P.x,P.y,1.2);r++)P.x+=1;})()"""

async def main():
    os.makedirs(OUT, exist_ok=True)
    fehler = 0
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=CHROME, args=['--no-sandbox'])
        for name, url, camv, aktion in SZENEN:
            pg = await b.new_page(viewport={'width': 1000, 'height': 640})
            errs = []
            pg.on('pageerror', lambda e: errs.append(str(e)))
            pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' and 'favicon' not in m.text and '404' not in m.text else None)
            await pg.goto(BASE + url)
            await pg.wait_for_function('window.VE_READY === true || (document.getElementById("bPlay") && !document.getElementById("bPlay").disabled)', timeout=120000)
            if 'totenstadt' in url:
                await pg.evaluate("document.getElementById('bPlay').click()")
            if aktion == 'haus':
                await pg.evaluate(HAUS)
            cam = 'TS_DEBUG.cam' if 'totenstadt' in url else 'VE_DEMO.cam'
            js = f"(()=>{{const c={cam}, P=window.TS_DEBUG&&TS_DEBUG.P; if(P) c.follow(P.x,P.y); c.target.yaw={camv['yaw']}*Math.PI/180; c.target.pitch={camv['pitch']}*Math.PI/180; " \
                 f"{('c.target.zoom*=' + str(camv['zoom']) + ';') if 'zoom' in camv else ''} c.snap();}})()"
            await pg.evaluate(js)
            await pg.wait_for_timeout(1800)
            pfad = os.path.join(OUT, name + '.png')
            await pg.screenshot(path=pfad)
            info = await pg.evaluate(f"(()=>{{const r=(window.TS_DEBUG||window.VE_DEMO).R; return {{insts:r.stats.insts, calls:r.stats.calls}}}})()")
            print(json.dumps({'szene': name, **info, 'fehler': errs[:3]}, ensure_ascii=False))
            fehler += len(errs)
            await pg.close()
        await b.close()
    sys.exit(1 if fehler else 0)

asyncio.run(main())
