# Regeln für Agenten und Mitwirkende

- **Sprache**: Doku, Kommentare, Commit-Nachrichten und Oberflächentexte auf Deutsch.
- **Kein Build-Schritt**: nur ES-Module mit relativen Imports, die direkt im Browser laufen. Keine Abhängigkeiten aus npm im Engine-Code.
- **DOM-frei, wo möglich**: `core/`, `world/`, `gen/`, `ecs/`, `light/`, `render/bake.js`, `render/camera.js` dürfen weder `document` noch `window` beim Import anfassen – sie werden in Node getestet und sollen später in Workern laufen.
- **Engine vs. Spiel**: Spielregeln, KI-Verhalten, Inventar, Inhalte gehören nach `games/<spiel>/`. Die Engine kennt keine Türen, Waffen oder Zombies. Spielspezifische Voxel-Flags ab `FLAG.GAME0`.
- **Reproduzierbarkeit**: Kachelinhalte hängen nur von Welt-Saat, Kachellage und Generatorversion ab (`tileSeed`). Bleibende Änderungen nur über `world.edit()` (Deltas). Ändert sich ein Generator so, dass alte Spielstände nicht mehr passen, Generatorversion erhöhen.
- **Tests**: `npm test` muss grün sein. Bei Änderungen am Renderer `tools/screenshots.py` laufen lassen und die Bilder ansehen.
- **Plan**: Fortschritt in `docs/plan.md` unter „Stand“ nachtragen.
- **Wissensbasis**: Neue Erkenntnisse (Technik, Fehlerursache, Messwert) als Branch + PR in [tomkpunkt/gamedev](https://github.com/tomkpunkt/gamedev) eintragen, dort nach deren AGENTS.md.
- **Git**: nicht direkt auf `main` arbeiten, sondern Branch und Pull Request.
