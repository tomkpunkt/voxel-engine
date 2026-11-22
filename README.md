# Voxel-Engine

Sprite-Stacking-Voxel-Engine für den Browser. Die Welt besteht aus Voxeln (in Totenstadt 20 cm), gezeichnet als gestapelte Scheiben mit einem G-Buffer und Licht pro Pixel. Die Kamera ist frei drehbar und neigbar. Alles sind ES-Module ohne Build-Schritt: Dateien ausliefern, im Browser öffnen.

Entstanden aus dem Spiel [Totenstadt](games/totenstadt/), einem Zombie-Shooter à la Project Zomboid. Den Plan mit Modulen und Etappen beschreibt [docs/plan.md](docs/plan.md).

## Ausprobieren

```sh
python3 -m http.server 8765
# dann im Browser:
#   http://localhost:8765/                                  Übersicht
#   http://localhost:8765/games/totenstadt/index.html       das Spiel
#   http://localhost:8765/examples/kleine-welt/index.html   kleine Beispielwelt
#   http://localhost:8765/examples/lichter/index.html       Lichter-Stressszene
```

ES-Module laden nicht über `file://`, darum braucht es einen lokalen Server.

URL-Parameter für reproduzierbare Bilder: `?saat=4711` (Stadt), `?zeit=12` (Uhrzeit 0–24), `?leer` (Totenstadt ohne Zombies), `?dichte=20|10|5` und `?sub=1|2|4` (Kleine Welt), `?ohneWorker`, `?debug` (Leistungsanzeige, auch F3), `?n=` und `?schatten=` (Lichter-Stressszene).

## Aufbau

```
engine/
  core/       rand.js (Hash, Rauschen, PRNG, Kachel-Saat), voxel.js (Farben, Flags, Volume)
  world/      world.js – Kacheln, Deltas, Abfragen (Höhe, Kollision, Sichtlinie)
  stream/     streamer.js (Fenster, Aufträge, Backends), builder.js (erzeugen + backen), worker.js
  render/     camera.js (freie Kamera), bake.js (Voxel → Texturen), renderer.js (WebGL2), shaders.js, particles.js
  light/      light.js – Tageszeit, Flackern, Lichtauswahl
  ecs/        ecs.js (Entities, Systeme), flowfield.js (Wegfindung)
  destruct/   debris.js (Block-Partikel, Emitter), destruct.js (carve, shatter, checkSupport, drop)
  gen/        wfc.js (Wave Function Collapse mit Sockeln), floorplan.js (Split-Grammatik)
  platform/   input.js (Tastatur, Maus, Touch, Gamepad, Kamera-Gesten), audio.js (Synth),
              debug.js (Profiler, F3-Anzeige), storage.js (Spielstände in IndexedDB)
  index.js    öffentliche API
games/totenstadt/      das Spiel: Stadt-Generator, Figuren, Waffen, Spiellogik
examples/kleine-welt/  zweite Szene über dieselbe API
examples/lichter/      Stressszene mit bis zu 256 Lichtern
tests/                 Node-Tests (DOM-frei)
tools/screenshots.py   Headless-Screenshots mit fester Saat, Kamera, Tageszeit
tools/lichter.py       Bildzeiten der Lichter-Stressszene
```

## Kleinstes Beispiel

```js
import { World, Renderer, Camera, Streamer, LocalBackend, C, skyAt } from './engine/index.js';

// Generator: beschreibt, wie eine Kachel aussieht (rein, damit er auch im Worker laufen kann)
const GEN = {
  tileSize: 32, tilesX: 2, tilesY: 2, height: 16,
  generate: (tile, vol, { rng, ox, oy, add }) => {
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) vol.set(x, y, 0, C(0x406030));
    for (let z = 1; z < 8; z++) vol.set(16, 16, z, C(0xc0a080));
  },
};
const world = new World({ tileSize: 32, tilesX: 2, tilesY: 2, height: 16, seed: 1 });
const R = new Renderer(document.querySelector('canvas'));
R.attachWorld(world, 2);
const stream = new Streamer(world, R, { backend: new LocalBackend(GEN, 1), radius: 1 });
const cam = new Camera({ x: 32, y: 32, zoom: 6 });
R.resize(innerWidth, innerHeight); cam.setSize(innerWidth, innerHeight);
stream.update(32, 32); stream.run(1e9);

function frame(t) {
  requestAnimationFrame(frame);
  cam.update(1 / 60);
  const sky = skyAt(12);
  R.begin(cam);
  R.drawWorld();
  R.light({ ambient: sky.ambient, sunColor: sky.sun, lights: [] });
}
requestAnimationFrame(frame);
```

Für große Welten steht der Generator in einem eigenen Modul mit `export function createGenerator(config)` und wird über `new WorkerBackend(url, config)` in Workern ausgeführt (siehe `games/totenstadt/city.js` und `stadt.js`). Entities meldet der Generator über `ctx.add(typ, daten)`; die Welt sendet sie einmal pro Kachel als Ereignis `entities`.

## Dichte, Unterteilung, Zerstörung

```js
const world = new World({ ..., voxelSize: 0.1, sub: 2 });   // Grunddichte 10 cm, Blöcke teilbar in 2×2×2 à 5 cm
world.m(1.8);                                              // 18 Blöcke
world.editFine(fx, fy, fz, 0);                             // feinen Block entfernen (teilt bei Bedarf), dann world.commit(…)

const debris = new Debris(world);
const { removed } = carve(world, x, y, z, world.m(0.4));   // Kugel ausschneiden, Ränder fein
shatter(debris, removed, { settle: true });                 // Trümmer bleiben liegen
const { groups } = checkSupport(world, x - 20, y - 20, x + 20, y + 20);
for (const g of groups) g.length > 300 ? drop(world, g) : shatter(debris, g, { settle: true });
debris.emitter({ x, y, z, rate: 20, colors: [0xffa030], settle: false });   // z. B. Glut
// pro Bild: debris.update(dt); debris.commit(); … renderer.drawDebris(debris.list)
```

## Licht und Spielstände

```js
renderer.light({
  ambient, sunColor, sunDir: lightDir(stunde),         // Sonnenschatten mit Richtung
  eye: { x, y, z }, los: true,                          // Sichtkegel-Verdeckung vom Auge
  spot: { x, y, z, r, color, dir, cos, shadow: true },  // Taschenlampe
  lights,                                               // bis 256 Punktlichter { x, y, z, r, color, shadow? }
  maxShadowed: 8,                                       // so viele der nächsten werfen Schatten (≤ 14)
});

await saveGame('slot1', { seed, version, sub, world: world.exportDeltas(), spiel: { … } });
const s = await loadGame('slot1');   // Welt neu aus dem Generator, dann world.importDeltas(s.world)
```

Gezeichnet werden nur die 16 × 16-Stücke einer Kachel, die im Bild liegen (Grid Culling). F3 zeigt, wie viele verworfen wurden.

## Wichtige Begriffe

- **Kachel**: quadratischer Weltausschnitt (Totenstadt 80 × 80 × 32 Voxel). Wird aus Saat, Lage, Generatorversion und Spielzustand (`tile.state`) erzeugt; bleibende Änderungen liegen als **Deltas** daneben. Darum darf das Streaming Voxel jederzeit wegwerfen.
- **Revision**: zählt jede Änderung einer Kachel (`edit`, `touch`). Aufträge an Worker tragen sie; ein Ergebnis zu einer älteren Revision wird verworfen.
- **Flags** (`FLAG`): 1 Dach, 2 obere Wandhälfte – beide kappt der Renderer im Rechteck `cut` (Gebäude, in dem man steht). 4 = Stellvertreter eines unterteilten Blocks. Ab 8 gehören die Bits dem Spiel (Totenstadt: Türblatt).
- **Brick**: ein unterteilter Block, S³ feine Blöcke in derselben Palette. Grob steht ein Stellvertreter (Flag 4), damit Höhe, Kollision und Sicht weiter im groben Gitter rechnen.
- **Tiefe aus z**: Der Renderer schreibt als Tiefe nur die Höhe der Scheibe. Das ist für jede Drehung und Neigung korrekt, weil an derselben Bildschirmstelle das vordere Objekt immer die höhere Scheibe zeigt (Test in `tests/render-mathe.test.mjs`).

## Tests

```sh
npm test                          # Node, ohne Browser
python3 -m http.server 8765 &
python3 tools/screenshots.py out  # braucht Playwright und Chrome
python3 tools/rundgang.py bericht.json   # Rundgang über 2,4 km: Bildzeiten, Streaming, Speicher, Zustand nach Entladen
python3 tools/lichter.py lichter.json    # Lichter-Stressszene: 8 bis 256 Lichter, mit und ohne Schatten
```

## Wissensbasis

Techniken und Erfahrungen fließen in [tomkpunkt/gamedev](https://github.com/tomkpunkt/gamedev), besonders *Sprite-Stacking mit G-Buffer* und *Rasterstadt: WFC und Split-Grammatik*.
