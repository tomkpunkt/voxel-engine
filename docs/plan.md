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
- Paletten-Kompression der Kacheln → Etappe 2 (dort zählt der Speicher).
- Totenstadt nutzt das ECS noch nicht; Zombies und Spieler sind weiterhin einfache Objekte. Umstellung, wenn Etappe 3 Trümmer als Entities braucht.
- Gamepad, IndexedDB, Debug-Overlay → mit Etappe 2 und 4.
- Der Hauptlicht-Schatten ist gebacken; bei anderer Tageszeit ändert sich Farbe und Stärke, nicht die Richtung. Dynamische Richtung über die Höhenkarte → Etappe 4.
