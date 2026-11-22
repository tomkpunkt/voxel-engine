// Maßstab von Totenstadt – alles bezogen auf die Spielfigur (≈ 2 m hoch).
// 1 Voxel = 20 cm (5 Voxel pro Meter), senkrecht wie waagerecht. Stadt: 64 × 64 Grundstücke à 16 m = 1024 m.
import { FLAG } from '../../engine/core/voxel.js';

export const VPM = 5, M = m => Math.round(m * VPM);
export const SCALE = {
  figur: { hoehe: 10.5, breite: 2.7, radius: 1.2 },   // ≈ 2,1 m (stilisiert, großer Kopf), Schultern 0,55 m
  tuer: { breite: M(1.0), hoehe: M(2.2) },           // 5 × 11
  raumhoehe: M(2.8),                                 // 14
  fenster: { breite: M(1.2), unten: M(1.0), oben: M(2.1) },
  durchgang: M(1.0),                                 // 5 → freier Weg zwischen Türen
  zimmerMin: M(2.4),                                 // 12 Innenmaß
  haus: { min: M(8.4), max: M(11) },                 // 42–56 → 64–115 m² Wohnfläche
  grundstueck: M(16),                                // 80 = eine Kachel
  fahrspur: M(3), gehweg: M(2),                      // 15 / 10
  auto: { l: M(4.6), b: M(1.8), h: 8 },              // 23 × 9 × 8
  laterne: M(5.6), baum: M(5.5),                     // 28 / 27
};
export const TS = SCALE.grundstueck, GN = 64, W = TS * GN, D = TS * GN, H = 32;
export const WALL_H = SCALE.raumhoehe, DOOR_H = SCALE.tuer.hoehe, DOOR_W = SCALE.tuer.breite, CLEAR = SCALE.durchgang;
export const ROOF = FLAG.ROOF, WALLTOP = FLAG.WALLTOP, DOORLEAF = FLAG.GAME0, DOOROPEN = FLAG.GAME1;
export const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
export const GEN_VERSION = 4;
