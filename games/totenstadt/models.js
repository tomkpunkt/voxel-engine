// Figuren von Totenstadt als Voxel-Funktionen (Kapseln und Kugeln), 4-fache Dichte.
import { C, E, jit, buildStack } from '../../engine/core/voxel.js';
import { hash3 } from '../../engine/core/rand.js';
// =====================================================================
//  FIGUREN mit 4-facher Voxeldichte (0,25 Welteinheiten pro Voxel)
// =====================================================================
export const SD = 4;
function cap(px, py, pz, ax, ay, az, bx, by, bz, r) {
  const bax = bx - ax, bay = by - ay, baz = bz - az, pax = px - ax, pay = py - ay, paz = pz - az;
  const t = Math.max(0, Math.min(1, (pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz)));
  return Math.hypot(pax - bax * t, pay - bay * t, paz - baz * t) - r;
}
// Überlebender: Mütze, Jacke, Jeans, Rucksack; hält Gewehr oder Schläger
export function survivorFn(sw, melee) {
  const LY = [0.6, -0.6], FX = [sw * 1.2, -sw * 1.2];
  return (u, v, s, hh) => {
    const J = (c, a = 0.14) => C(jit(c, a, hh));
    if (!melee) {
      if (cap(u, v, s, 0.3, 0.5, 6.7, 3.4, 0.45, 6.95, 0.24) < 0) return J(0x26282c, 0.2);
      if (u > 1.0 && u < 1.6 && v > 0.25 && v < 0.65 && s > 6.0 && s < 6.8) return J(0x5a3a22);
    } else if (cap(u, v, s, 1.0, 0.7, 6.8, -0.2, 1.0, 10.2, 0.26) < 0) return J(0x8a6a42, 0.2);
    if (s > 9.15 && Math.hypot(u, v, s - 9.2) < 1.0) return s < 9.4 && u > 0.5 ? J(0x5a1c18) : J(0x8a2a22);
    if (s > 9.0 && s <= 9.15 && u > 0 && u < 1.45 && Math.abs(v) < 0.8) return J(0x6a1e1a);
    if (Math.hypot(u - 0.12, v, s - 8.7) < 0.8) {
      if (u > 0.6 && s > 8.6 && s < 8.85 && Math.abs(v) > 0.12 && Math.abs(v) < 0.45) return C(0x1e1612);
      return J(0xd09a74, 0.1);
    }
    const hR = melee ? [1.0, 0.8, 7.0] : [1.3, 0.6, 6.7], hL = melee ? [1.1, 0.4, 7.4] : [2.2, 0.35, 6.9];
    if (Math.hypot(u - hR[0], v - hR[1], s - hR[2]) < 0.33 || Math.hypot(u - hL[0], v - hL[1], s - hL[2]) < 0.33) return J(0xc08a64);
    const armR = Math.min(cap(u, v, s, 0, 1.45, 7.8, 0.5, 1.25, 6.5, 0.4), cap(u, v, s, 0.5, 1.25, 6.5, hR[0], hR[1], hR[2], 0.36));
    const armL = Math.min(cap(u, v, s, 0, -1.45, 7.8, 0.9, -1.2, 6.8, 0.4), cap(u, v, s, 0.9, -1.2, 6.8, hL[0], hL[1], hL[2], 0.36));
    if (armR < 0 || armL < 0) return J(0x4a5a3a);
    if (u > -1.55 && u < -0.75 && Math.abs(v) < 0.95 && s > 5.6 && s < 8.0) return J(0x6a4a2a, 0.2);
    if (Math.abs(u) < 0.85 && Math.abs(v) < 1.3 && s > 5.1 && s < 8.25) {
      if (s > 7.95) return J(0x3a4a30);
      if (u > 0.6 && Math.abs(v) < 0.12) return C(0x26281e);
      return J(0x4f6040);
    }
    if (Math.abs(u) < 0.78 && Math.abs(v) < 1.25 && s > 4.75 && s <= 5.1) return J(0x3a2a1a);
    for (let k = 0; k < 2; k++) {
      const fx = FX[k], ly = LY[k];
      if (cap(u, v, s, fx - 0.15, ly, 0.38, fx + 0.55, ly, 0.38, 0.38) < 0) return J(0x3a2a1e);
      if (cap(u, v, s, 0, ly, 4.9, fx, ly, 0.8, 0.5) < 0) return J(0x34486a);
    }
    return 0;
  };
}
// Zombie: gebeugt, Arme nach vorn, zerrissene Kleidung, Blut
const ZSHIRT = [0x6b2f2f, 0x3e4f6b, 0xa8a090, 0x4a5a3a, 0x7a6a4a, 0x2e2e33];
const ZPANTS = [0x2f3440, 0x4a3b2a, 0x3a3a3a, 0x283a5a];
export function zombieFn(sw, vr, dead) {
  const shirt = ZSHIRT[vr % ZSHIRT.length], pants = ZPANTS[(vr * 7 + 1) % ZPANTS.length];
  const LY = [0.55, -0.6], FX = [sw * 0.85, -sw * 0.7];
  const sway = sw * 0.25;
  return (u, v, s, hh) => {
    const J = (c, a = 0.18) => C(jit(c, a, hh));
    const blood = hh < 0.16;
    // Kopf nach vorn gesenkt
    if (Math.hypot(u - 0.55, v - sway * 0.3, s - 8.25) < 0.8) {
      if (u > 1.1 && s > 8.15 && s < 8.4 && Math.abs(v) > 0.12 && Math.abs(v) < 0.45) return C(0x5a0c08);
      if (s > 8.75 && hh < 0.5) return J(0x2a2420);
      return blood ? C(0x5a1812) : J(0x7d8f6a, 0.2);
    }
    if (!dead) {
      const hR = [2.3, 0.85 + sway, 7.2], hL = [2.1, -0.95 + sway, 7.5];
      const armR = cap(u, v, s, 0.2, 1.3, 7.4, hR[0], hR[1], hR[2], 0.34), armL = cap(u, v, s, 0.2, -1.3, 7.4, hL[0], hL[1], hL[2], 0.34);
      if (armR < 0 || armL < 0) return (u > 1.6) ? J(0x7d8f6a) : (blood ? C(0x5a1812) : J(shirt));
    }
    // Oberkörper gebeugt (oben nach vorn versetzt)
    const lean = (s - 5) * 0.12;
    if (Math.abs(u - lean) < 0.8 && Math.abs(v) < 1.2 && s > 4.9 && s < 7.9) {
      if (hh > 0.93) return J(0x7d8f6a);
      return blood ? C(0x5a1812) : J(shirt);
    }
    for (let k = 0; k < 2; k++) {
      const fx = FX[k], ly = LY[k];
      if (cap(u, v, s, fx - 0.15, ly, 0.35, fx + 0.5, ly, 0.35, 0.35) < 0) return J(k ? 0x2a2420 : 0x5a5a50);
      if (cap(u, v, s, 0, ly, 4.9, fx, ly, 0.8, 0.48) < 0) return blood ? C(0x4a1410) : J(pants);
    }
    return 0;
  };
}
export function figureStack(fn, w, h, dead) {
  return buildStack(w, w, h, (x, y, z) => {
    const hh = hash3(x + 50, y + 50, z);
    if (!dead) return fn(x / SD, y / SD, (z + 0.5) / SD, hh);
    // liegend: Körperhöhe → Länge, Vorderseite nach oben
    const u = x / SD, v = y / SD, s = (z + 0.5) / SD;
    return fn(s - 1.2, v, u + 4.9, hh);
  });
}
export function flameStack(f) {
  return buildStack(10, 10, 14, (x, y, z) => {
    const u = x / 2, v = y / 2, s = (z + 0.5) / 2;
    const r = 2.3 * (1 - s / 7.2) + (hash3(x * 3 + f, y * 5 + f * 7, z + f * 13) - 0.5) * 1.1;
    if (Math.hypot(u + Math.sin(f * 1.7 + s) * 0.35, v) > r) return 0;
    return E(s < 1.6 ? 0xffe27a : s < 3.6 ? 0xffa040 : 0xe0502a);
  });
}
export const WALK = [0, 1.0, 0.15, -1.0, -0.15];
