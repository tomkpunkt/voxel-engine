# Plan

Die Engine entsteht aus [Totenstadt](../games/totenstadt/) heraus, in spielbaren Etappen. Jede Etappe endet mit einem Stand, den man im Browser ausprobieren kann, und mit einer Abnahme, die sich wiederholen lässt.

## Module

| Modul | Verantwortung | Ordner |
|---|---|---|
| Welt | Regionen und Voxel-Kacheln, Paletten-Kompression, versionierte Deltas sowie Abfragen für Höhe, Kollision und Sichtlinie. | `engine/world/`, `engine/core/` |
| Streaming | Priorisierte Worker-Aufträge für Generierung und Baking. Ergebnisse tragen eine Kachelrevision, damit ein verspäteter Worker-Auftrag keine neuere Änderung überschreibt. | `engine/stream/` |
| Renderer | Sprite-Stack-G-Buffer, Materialien, Figuren-Atlas, Umrisse, Decals und Partikel. WebGL2 ist das erste Backend. | `engine/render/` |
| Licht | Lichtlisten pro Bildschirmkachel, Schatten über Höhenkarten, Emissives und Tag-Nacht-Zyklus. | `engine/light/` |
| Zerstörung und Physik | Voxel entfernen, betroffene Kacheln für das erneute Baking markieren, Tragfähigkeit prüfen und gelöste Teile als Trümmer simulieren. | `engine/destruct/` (Etappe 3) |
| Entities und Systeme | Schlankes ECS mit wiederverwendbaren Systemen für Bewegung, Flow-Fields und Sicht. KI-Verhalten, Gesundheit und Inventar definiert das jeweilige Spiel. | `engine/ecs/` |
| Generierung | WFC und Baugrammatik als Plugins. Kachelkoordinaten, Welt-Seed und Generatorversion bestimmen die Ausgangskachel. | `engine/gen/` |
| Plattform | Tastatur, Touch und Gamepad, Audio, IndexedDB sowie Debug-Overlay und Profiler. | `engine/platform/` |

## Etappen

| Etappe | Spielbarer Stand | Abnahme |
|---|---|---|
| 1 · Extraktion | Totenstadt läuft mit ausgelagerten Modulen. Eine zweite Szene lädt eine kleine Voxelwelt über dieselbe API. | Node-Tests für Weltabfragen und Deltas. Headless-Screenshots mit fester Saat, Kamera und Tageszeit sichern die Darstellung ab. |
| 2 · Streaming | Man kann eine Stadt von über 1 km Ausdehnung durchqueren. Worker erzeugen, backen und entladen Kacheln entlang der Route. | Ein reproduzierbarer Rundgang misst Framezeiten und Speicher. Geänderte Kacheln behalten beim Entladen und erneuten Laden ihren Zustand. |
| 3 · Zerstörung | Wände und Möbel lassen sich beschädigen. Abgetrennte Teile werden zu Trümmern. | Ein Durchbruch aktualisiert Darstellung, Kollision und Sicht auch an einer Kachelgrenze. Eine Testszene prüft ein Dach mit intakter und entfernter Stütze. |
| 4 · Licht und Spielstände | Viele dynamische Lichter laufen zusammen. Eine beschädigte Szene lässt sich speichern und fortsetzen. | Eine Lichter-Stressszene liefert vergleichbare Framezeiten. Der Lade-Test rekonstruiert die Welt aus Seed, Generatorversion und Deltas. |
| 5 · Optionale Erweiterungen | Ein WebGPU-Backend oder Mehrspieler ergänzt den spielbaren Stand. | Für WebGPU rendert dieselbe Beispielszene über beide Backends. Für Mehrspieler führen dieselben Änderungen bei zwei Clients zum selben Weltzustand. |

## Stand

### Etappe 1 – erledigt (2026-11-22)

- **Welt** (`engine/world/world.js`): Kacheln mit Erzeugung bei Bedarf, `edit()` speichert versionierte Deltas (Revision pro Kachel), die beim Entladen und Neuerzeugen erhalten bleiben; `exportDeltas()`/`importDeltas()` prüfen Saat, Generatorversion und Maße. Abfragen: `height`, `isBlocked`, `free`, `move`, `los`, `ray`. Ereignisse `tileLoaded` und `regionChanged`.
- **Streaming** (`engine/stream/streamer.js`): Fenster um einen Punkt, Aufträge nach Abstand sortiert, Zeitbudget pro Bild. Noch auf dem Haupt-Thread; die Revision steht schon im Auftrag (`gpu.rev`).
- **Renderer** (`engine/render/`): G-Buffer, Welt-Fenster im Ringpuffer, Sprites, Umrisse, Decals (überstehen Neubacken), Partikel. `rebake()` arbeitet über Kachelgrenzen und wird bei `regionChanged` automatisch ausgelöst.
- **Freie Kamera** (`engine/render/camera.js`): Drehung beliebig, Neigung 30–88°, Zoom, weiches Nachführen, Kamerawackeln. Maus: rechte Taste ziehen, Rad. Touch: Kamera-Knopf ziehen.
- **Licht** (`engine/light/light.js`): Tageszeit (`skyAt`), Flackern, Auswahl der nächsten Lichter. Noch feste Höchstzahl von 8 Lichtern pro Bild.
- **ECS** (`engine/ecs/`): `ECS` mit Abfragen und Systemen, `movementSystem`, `FlowField`.
- **Generierung** (`engine/gen/`): `wfc` mit Sockeln, `planRooms` (Split-Grammatik).
- **Plattform** (`engine/platform/`): `Input` (Tastatur, Maus, Touch-Sticks, Kamera-Gesten), `Synth`.
- **Spiele**: `games/totenstadt/` (gleiches Verhalten wie vorher, jetzt mit freier Kamera), `examples/kleine-welt/` (Haus aus der Grammatik, Bewohner per ECS und Flow Field, Uhrzeit-Regler, Voxel wegschlagen als Delta).
- **Abnahme**: `npm test` (17 Tests), `tools/screenshots.py` (8 Szenen mit fester Saat, Kamera und Tageszeit).

Offen aus Etappe 1, verschoben:
- ~~Paletten-Kompression der Kacheln → Etappe 2~~ (erledigt in Etappe 2).
- Totenstadt nutzt das ECS noch nicht; Zombies und Spieler sind weiterhin einfache Objekte. Umstellung, wenn Etappe 3 Trümmer als Entities braucht.
- Gamepad, IndexedDB, Debug-Overlay → mit Etappe 2 und 4.
- Der Hauptlicht-Schatten ist gebacken; bei anderer Tageszeit ändert sich Farbe und Stärke, nicht die Richtung. Dynamische Richtung über die Höhenkarte → Etappe 4.

### Etappe 2 – erledigt (2026-11-22)

- **Paletten-Volumen** (`engine/core/voxel.js`): pro Voxel ein Uint16-Index auf (Farbe, Flags). Totenstadt-Kacheln: im Mittel 576 Paletteneinträge (höchstens 1 093), 402 KB statt 1 000 KB pro Kachel. Ab 64 000 Einträgen wird vergröbert, nie gescheitert.
- **Karten pro Kachel** (`engine/world/world.js`): Säulenhöhe, Kollision und verdickte Wegkarte liegen in der Kachel (je TS × TS) statt für die ganze Welt; nicht geladene Kacheln gelten als blockiert. Bei 5 120 × 5 120 Voxeln hätten die globalen Karten 75 MB gekostet.
- **Builder und Worker** (`engine/stream/builder.js`, `worker.js`, `streamer.js`): Das Spiel liefert ein reines Generator-Modul (`createGenerator(config)`), das im Worker läuft. Ein Auftrag enthält die Kachel und ihre 8 Nachbarn mit Revision, Spielzustand (`tile.state`) und Deltas; der Worker hält einen Cache, erzeugt nur Veraltetes neu, rechnet Karten und backt. Ergebnisse mit älterer Revision verwirft die Hauptseite und beauftragt neu. `LocalBackend` macht dasselbe synchron (Node, kleine Welten, Rückfall, wenn Worker nicht starten).
- **Fenster statt Welt auf der GPU und in der Wegfindung**: Höhenkarte nur noch WIN × WIN mit REPEAT-Adressierung (gleiche Plätze wie die Voxel), `FlowField` rechnet ein Quadrat um das Ziel (283 × 283 bei 140 Voxeln Reichweite).
- **Totenstadt 1 km**: 64 × 64 Grundstücke à 16 m (1 024 m). WFC mit Zähler je Zelle statt Neuzählen (Plan 64 × 64 in etwa 0,5 s). Türzustand über `tile.state`, Kollision rein aus Flags (`DOOROPEN`), Gebäude pro Kachel statt globaler Gebäudekarte, Minikarte zeigt 16 × 16 Grundstücke um die Figur.
- **Abnahme**:
  - `tools/rundgang.py`: feste Saat, Route über 12 160 Voxel (2,4 km) mit 3 Voxeln pro Bild. Ergebnis (Container, 2 Kerne, Software-Rendering, 1 Worker): 785 Kacheln gebacken, 0 verworfen, in keinem Bild fehlte die eigene Kachel; höchstens 35 Kacheln geladen, Welt 15 MB, GPU 41 MB, JS-Heap 61 MB. Bildzeit p50 95 ms – auf dieser Maschine liegt schon der Stand von Etappe 1 im Stehen bei 244 ms (p50), die Werte taugen also nur zum Vergleich auf derselben Maschine.
  - Zustand nach Entladen: Tür umgelegt und Loch in die Wand geschlagen, 2,4 km weggefahren (Kachel entladen), zurück: Tür, Loch und Kollision stimmen, Entities nicht doppelt (`tools/rundgang.py` prüft das und endet sonst mit Fehlercode).
  - `npm test`: 20 Tests, neu u. a. veraltete Revision wird verworfen, Fenster entlädt, Palette läuft über.

Offen aus Etappe 2:
- Echte Bildzeiten auf Handy und Desktop-GPU messen (der Rundgang läuft auch dort, wenn man ihn im Browser von Hand startet).
- Speicher der Worker-Caches (je bis zu 40 Kacheln, etwa 16 MB) zählt der Rundgang nicht mit.
- Zombies verschwinden weiterhin am Fensterrand.
