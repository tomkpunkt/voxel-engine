// Ragdolls: Verlet-Backend (Rapier braucht Netz und WASM, im Test nicht verfügbar), Voxelisierung
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, loadAll } from './hilfe.mjs';
import { C, buildStack } from '../engine/core/voxel.js';
import { humanoid, RagdollModel, makeGrid, cropGrid, createVerletWorld, createRagdollWorld } from '../engine/physics/ragdoll.js';

/** 2 × 2 Kacheln à 16, Boden z = 0, Wand bei x = 20 (y 0…31, z 1…10). */
function welt() {
  return loadAll(makeWorld({
    tileSize: 16, tilesX: 2, tilesY: 2, height: 16, voxelSize: 0.2,
    generate: (t, vol, { ox }) => {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        vol.set(x, y, 0, C(0x404040));
        if (ox + x === 20) for (let z = 1; z <= 10; z++) vol.set(x, y, z, C(0xa0a0a0));
      }
    },
  }));
}
// Testfigur: Kapselmännchen im Maß des Skeletts, 4 Voxel je Block
const skel = humanoid();
function figur() {
  const P = skel.points, D = 4;
  return buildStack(48, 48, 40, (x, y, z) => {
    const q = [x / D, y / D, (z + 0.5) / D];
    for (const p of skel.parts) {
      const a = P[p.a], b = P[p.b], ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], aq = [q[0] - a[0], q[1] - a[1], q[2] - a[2]];
      const t = Math.max(0, Math.min(1, (aq[0] * ab[0] + aq[1] * ab[1] + aq[2] * ab[2]) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2)));
      if (Math.hypot(aq[0] - ab[0] * t, aq[1] - ab[1] * t, aq[2] - ab[2] * t) < p.r * 0.8) return C(p.name === 'head' ? 0xd0a080 : 0x406080);
    }
    return 0;
  });
}
const len = (pt, a, b) => Math.hypot(pt[a].x - pt[b].x, pt[a].y - pt[b].y, pt[a].z - pt[b].z);

test('Ruhe-Pose voxelisiert ergibt das Ruhevolumen', () => {
  const rest = figur(), m = new RagdollModel(rest, skel, 4), g = makeGrid(56, 56, 48);
  let n0 = 0; for (const v of rest.data) if (v) n0++;
  const b = m.voxelize(m.restPose(10, 10, 1, 0), g);
  let n1 = 0; for (const v of g.c) if (v) n1++;
  assert.ok(Math.abs(n1 - n0) / n0 < 0.02, `Voxelzahl ${n1} statt ${n0}`);
  assert.ok(b.z <= 1 && b.z >= 0.5, 'Unterkante am Boden');
  const { grid } = cropGrid(g, b);
  assert.ok(grid.w < 56 && grid.h <= 48);
  // gedreht: gleiche Zahl (bis auf Rasterung)
  m.voxelize(m.restPose(10, 10, 1, 0.7), g);
  let n2 = 0; for (const v of g.c) if (v) n2++;
  assert.ok(Math.abs(n2 - n0) / n0 < 0.08, `gedreht ${n2} statt ${n0}`);
});

test('Verlet-Ragdoll fällt um, kommt zur Ruhe, Knochen behalten ihre Länge', () => {
  const w = welt(), phys = createVerletWorld(w);
  const rd = phys.spawn(skel, { x: 8, y: 16, z: 1, rot: 0, vel: [6, 0, 0], hit: 'head', hitVel: [14, 0, 3] });
  rd.keep = true;
  for (let i = 0; i < 60 * 9 && !rd.sleeping; i++) phys.step(1 / 60);
  assert.ok(rd.sleeping, 'schläft');
  const I = rd.idx, pt = rd.pt;
  for (const p of pt) assert.ok(p.z - p.r >= 0.95, `nicht im Boden (${p.z.toFixed(2)})`);
  const head = pt[I.head];
  assert.ok(head.z < 4, `liegt (Kopf auf ${head.z.toFixed(2)})`);
  for (const p of skel.parts) {
    const P = skel.points, L0 = Math.hypot(P[p.a][0] - P[p.b][0], P[p.a][1] - P[p.b][1], P[p.a][2] - P[p.b][2]);
    assert.ok(Math.abs(len(pt, I[p.a], I[p.b]) - L0) / L0 < 0.1, `${p.name} behält Länge`);
  }
  // Pose: Drehmatrizen orthonormal
  for (const { R } of rd.pose()) {
    const det = R[0] * (R[4] * R[8] - R[5] * R[7]) - R[1] * (R[3] * R[8] - R[5] * R[6]) + R[2] * (R[3] * R[7] - R[4] * R[6]);
    assert.ok(Math.abs(det - 1) < 1e-3);
  }
});

test('Verlet-Ragdoll geht nicht durch Wände', () => {
  const w = welt(), phys = createVerletWorld(w);
  const rd = phys.spawn(skel, { x: 16, y: 16, z: 1, rot: 0, vel: [25, 0, 2], hit: 'torso', hitVel: [40, 0, 4] });
  rd.keep = true;
  for (let i = 0; i < 60 * 9 && !rd.sleeping; i++) phys.step(1 / 60);
  for (const p of rd.pt) assert.ok(p.x < 20, `vor der Wand (x ${p.x.toFixed(2)})`);
});

test('auto ohne Rapier fällt auf Verlet zurück', async () => {
  const phys = await createRagdollWorld(welt(), { rapierUrl: 'data:text/javascript,throw new Error("kein Netz")', timeout: 500 });
  assert.equal(phys.backend, 'verlet');
});
