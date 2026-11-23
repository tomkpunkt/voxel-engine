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
| 3 · Zerstörung | Wände und Möbel lassen sich beschädigen. Abgetrennte Teile werden zu Trümmern. Grunddichte pro Welt (20, 10 oder 5 cm), einzelne Blöcke fein unterteilbar, Block-Partikel mit Emittern. | Ein Durchbruch aktualisiert Darstellung, Kollision und Sicht auch an einer Kachelgrenze. Eine Testszene prüft ein Dach mit intakter und entfernter Stütze. |
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

### Etappe 3 – erledigt (2026-11-22)

Erweitert um die Wünsche „Dichte einstellbar (20, 10, 5 cm)“, „Unterteilung eines Blocks in 10- oder 5-cm-Blöcke“ und „Partikel-Emitter für Blöcke“ (Entscheidungen: Grunddichte + Unterteilung; Partikel je Emitter liegen bleiben oder verschwinden; alles in Etappe 3).

- **Grunddichte** (`World.voxelSize`, `world.m(meter)`): Die Engine rechnet weiter in Blöcken; Inhalte werden in Metern beschrieben und umgerechnet. Kleine Welt mit `?dichte=20|10|5` (gleiche Szene, gleiche Größe in Metern; bei 5 cm eine kleinere Fläche, weil das GPU-Fenster mit der Dichte hoch drei wächst). Figuren werden in Metern bei 5 cm modelliert, ihre Sprite-Dichte ist `voxelSize / 0,05`. Totenstadt bleibt bei 20 cm (ihr Generator rechnet in festen Blockmaßen).
- **Unterteilung** (`World.sub` = S, `Volume.bricks`): Ein Block kann zu S³ feinen Blöcken werden (S = 2 oder 4). Gespeichert nur dort, als Uint16-Indizes in dieselbe Palette. Im groben Gitter steht ein Stellvertreter mit Flag `SUB` (häufigste Farbe), wenn mindestens die Hälfte gefüllt ist, sonst leer; Höhe, Kollision und Sicht arbeiten damit weiter grob. `world.getFine/editFine`, Brick-Deltas überstehen Entladen und Spielstand.
- **Darstellung der Bricks**: eigener Textur-Atlas (S = 4: 128 × 128 Plätze, 8 MB), gebacken im Worker (Normalen und Verdeckung im feinen Gitter, Schatten über das grobe), gezeichnet im feinen Raum (Matrix · 1/S) mit derselben Tiefe aus z. Neubacken nach Änderungen auch über Kachelgrenzen.
- **Block-Partikel** (`engine/destruct/debris.js`): Würfel mit Schwerkraft (9,81 m/s² umgerechnet), Abprallen, Reibung, Kollision im feinen Gitter. `settle` je Partikel bzw. Emitter: liegen bleiben (wird als feine Blöcke in die Welt geschrieben, ein Commit pro Bild) oder verschwinden. `Emitter` mit Rate, Stoß, Form (Punkt, Quader, Kugel), Richtung mit Streukegel, Geschwindigkeit, Farben, Dauer. Gezeichnet mit `renderer.drawDebris` in einem Draw-Call (Farbatlas mit 1 024 Farben).
- **Zerstörung** (`engine/destruct/destruct.js`): `carve` schneidet eine Kugel aus (ganz innen liegende Blöcke grob, angeschnittene fein), `shatter` macht Trümmer daraus, `checkSupport` sucht lose Gruppen (keine Verbindung zum Boden oder zum Rand des Prüfquaders), `drop` lässt eine große Gruppe als Ganzes fallen, bis sie aufliegt.
- **Szenen**: Kleine Welt mit Carport (Dachplatte auf zwei Stützen), Glut-Emitter (verschwindet), Sand-Emitter (bleibt liegen), Schalter „Trümmer bleiben liegen“. Totenstadt: Einschüsse und Axt-/Schlägertreffer schlagen Stücke aus Wänden (Türen ausgenommen), Zombies splittern Türen.
- **Abnahme**:
  - Durchbruch an einer Kachelgrenze: Kollision, Höhe und Sicht auf beiden Seiten aktualisiert, ein Ereignis überspannt die Grenze (Renderer backt beide Kacheln neu) – `tests/zerstoerung.test.mjs`.
  - Dach mit intakter Stütze bleibt stehen; Stütze durchschlagen → genau eine lose Gruppe, Platte entfernt, unterer Stützenrest steht; als Ganzes fallen gelassen liegt die Platte danach stabil. Im Browser: Carport bleibt nach der ersten Stütze stehen und fällt nach der zweiten, bei 20, 10 und 5 cm.
  - `npm test`: 25 Tests. `tools/screenshots.py`: 11 Szenen (neu: 10 cm, 5 cm, Carport nach dem Einsturz). `tools/rundgang.py`: unverändert (785 Kacheln, 0 verworfen, Zustand nach Entladen stimmt).

Offen aus Etappe 3:
- Große Gruppen fallen sofort an ihre Endlage (mit Staubwolke), nicht sichtbar animiert.
- Zerstörung prüft die Tragfähigkeit nur im groben Gitter; Bricks mit weniger als halber Füllung tragen nicht.
- Totenstadt-Möbel sind noch nicht einzeln zerstörbar (nur über die Wand-Logik, wenn man sie trifft).

### Etappe 4 – erledigt (2026-11-22)

Erweitert um den Wunsch „Optimierungen wie Grid Culling für bessere FPS“.

- **Grid Culling** (`bake.chunkBounds`, `CHUNK = 16`): Jede Kachel ist in 16 × 16-Block-Stücke geteilt, je Stück wird die Höhe und pro z-Stufe das belegte Rechteck gebacken. Der Renderer zeichnet nur Stücke, deren Bildschirm-Rechteck sichtbar ist, und den Boden (z = 0) einmal pro Kachel. Kleine Welt: 190 → 117 ms pro Bild (Software-Rendering im Container, auf echter GPU entsprechend schneller).
- **Viele Lichter** (`engine/light/light.js`, `renderer.light`): Bis 256 Lichter, in Bildschirm-Kacheln von 16 px einsortiert (48 je Kachel, hellste zuerst) und als Float-Texturen an den Licht-Shader gegeben. Statt Strahlen pro Pixel gibt es einen **Schwellen-Atlas**: Für Augen-Sicht, Taschenlampe und bis zu 14 Schatten werfende Lichter wird je eine 256²-Karte „ab welcher Höhe ist dieser Punkt sichtbar“ gerendert; der Licht-Shader liest nur noch einen Wert. Totenstadt: 116 → 70 ms.
- **Sonne mit Richtung** (`lightDir(stunde)`, `sunDir`): Sonnenschatten als dynamische Schwellenkarte über dem Fenster, neu nur bei geänderter Richtung oder wenn sich das Fenster um 16 Blöcke verschiebt. Totenstadt und Kleine Welt drehen die Schatten mit der Uhrzeit (6:30–19:30).
- **Spielstände** (`engine/platform/storage.js`): `saveGame/loadGame/deleteGame` über IndexedDB, Ausweichweg localStorage. Gespeichert werden Saat, Generatorversion, Unterteilung, Deltas, Brick-Deltas, Kachelzustand und Spieldaten; die Welt entsteht beim Laden neu aus dem Generator. Totenstadt: F5, automatisch alle 60 s und beim Verlassen der Seite, „Fortsetzen“ im Startbildschirm, gelöscht beim Tod.
- **Plattform**: `Profiler` und `DebugOverlay` (F3 oder `?debug`: Bildzeit p50/p95, Abschnitte, Draw-Calls, Instanzen, verworfene Stücke, GPU-Speicher), Gamepad (`input.pollPad`, Totenstadt mit linkem/rechtem Stick und Tasten).
- **Abnahme**:
  - Lichter-Stressszene `examples/lichter/` (`?n=`, `?schatten=`) mit `tools/lichter.py`. p50 in ms (Software-Rendering), ohne / mit 8 Schattenlichtern: 8 Lichter 50 / 73, 32: 68 / 87, 64: 82 / 106, 128: 121 / 141, 256: 170 / 187. Bei 256 Lichtern fallen in vollen Bildschirm-Kacheln die schwächsten weg.
  - `tests/spielstand.test.mjs`: Welt mit Durchbrüchen, Bricks und Türzustand speichern, neue Welt aus Saat + Generatorversion + Deltas aufbauen, Voxel für Voxel gleich; falsche Version oder Unterteilung wird abgelehnt. Im Browser: Tür, Kisten, Gesundheit, Lage, feine Blöcke nach Neuladen und „Fortsetzen“ gleich.
  - `npm test`: 28 Tests. `tools/screenshots.py`: 11 Szenen ohne Fehler.

Offen aus Etappe 4:
- Lichter ohne Schatten scheinen durch Wände (nur die 14 nächsten werfen Schatten).
- Bei sehr vielen Lichtern auf einer Stelle reicht die Kachelliste (48) nicht.

### Ragdolls – erledigt (2026-11-22)

Wunsch: „Für die Figuren, high-performance Rapier.js engine, based on the rapierjs-ragdoll repository.“

- **`engine/physics/ragdoll.js`** mit einer Schnittstelle und zwei Backends: `createRagdollWorld(world, { backend: 'auto' | 'rapier' | 'verlet' })`, `spawn(skelett, { x, y, z, rot, vel, hit, hitVel })`, `step(dt)`, `pose()` → Mittelpunkt und Drehmatrix je Teil.
  - **Rapier** (`@dimforge/rapier3d-compat@0.19`, per `import()` vom CDN, nur wenn angefordert): ein Körper je Teil (Quader für den Rumpf, Kapseln für Kopf und Glieder), Kugelgelenke an Hals, Schultern, Hüften, Scharniere mit Grenzen an Ellbogen und Knien, wie in rapierjs-ragdoll. Die Welt kommt als feste Quader je Säule (aus `world.height`) um den Ragdoll dazu. **Im Container nicht getestet** (kein Netz); fällt bei einem Fehler oder nach 6 s auf Verlet zurück.
  - **Verlet**: 15 Gelenkpunkte, Abstandsbedingungen für Knochen, starrer Rumpf, Mindestabstände gegen Zusammenklappen, Kollision gegen das grobe Voxelgitter (von oben aufsetzen, von der Seite zurück), Reibung am Boden, Schlafen nach 0,5 s Ruhe.
- **Revoxelisierung** (`RagdollModel`): Jeder Voxel des Ruhe-Sprites wird einmal einem Teil zugeordnet (nächster Knochen relativ zum Radius). Pro Bild wird jeder Zielvoxel in die Ruhelage seines Teils zurückgerechnet und dort nachgeschlagen – keine Löcher, Farben und Details bleiben. Ein Raster von 60 × 60 × 48 bei 4 Voxeln je Block; gebacken nur im belegten Bereich (`bakeRegion`) und hochgeladen in einen veränderlichen Sprite (`renderer.createDynamicSprite/updateSprite`). Liegt der Ragdoll still, wird er zugeschnitten und als fester Sprite behalten (`spriteFromGrid`).
- **Totenstadt** (`games/totenstadt/leichen.js`): Zombies fallen als Ragdoll in Schussrichtung, höchstens 4 gleichzeitig (ältere werden festgehalten). Die Pose wird im Spielstand gespeichert und beim Laden wieder voxelisiert. `?ragdoll=rapier|verlet|aus`.
- **Abnahme**: `tests/ragdoll.test.mjs` (Ruhe-Pose ergibt das Ruhevolumen, auch gedreht; Ragdoll fällt, ruht, Knochenlängen bleiben; nicht durch Wände; Rückfall auf Verlet). Im Browser: Fall sichtbar, Leichen bleiben liegen, Spielstand stellt Lage und Pose exakt wieder her. `tools/screenshots.py`: neue Szene `totenstadt-ragdoll`.
- **Kosten** (Node, Software): Voxelisieren stehend 1,9 ms, liegend deutlich weniger; Backen 1,2 ms. Ein Ragdoll kostet nur während des Fallens (unter einer Sekunde).

Offen:
- Rapier im Browser mit Netz ausprobieren (`?ragdoll=rapier` erzwingt es und zeigt Fehler in der Konsole).
- Ragdolls stoßen nicht gegeneinander; Möbel und Fahrzeuge zählen über die Säulenhöhe.

### Etappe 5 – Weltplaner (in Arbeit)

`cityPlan` wird zu einem Weltplaner; WFC bleibt der lokale Generator. Setting (Dichte, Straßennetz, Landnutzung) und Biom (Boden, Bewuchs, Gewässer) sind getrennt. Ablauf: Kartennetze → Ecken → Kanten (Grenzstreifen) → Sektorflächen; fertige Ränder bleiben fest, ein Sektor darf nur mit einer abgeleiteten Teilsaat neu starten. Erster Durchlauf: suburbaner Ortsrand, gemäßigtes Biom, 4 × 4 Sektoren à 16 × 16 Grundstücke, flaches Gelände, Ausgabe im bestehenden Kachelraster.

Abnahme: Hofzufahrt, zusammenhängendes Feld und durchgehender Waldrand liegen gezielt über Sektorgrenzen; ein Node-Test prüft alle drei für eine feste Liste von Saaten und vergleicht für eine Saat die Erzeugung in umgekehrter Sektorreihenfolge; Kartenansicht mit einblendbaren Sektorgrenzen. Alte Spielstände (Generator v4) bleiben gültig, der alte Stadtplan bleibt unverändert erhalten (Fingerabdruck-Test).
