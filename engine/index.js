// Öffentliche API der Engine. Alles ist ein ES-Modul ohne Build-Schritt.
// DOM-freie Module (in Node testbar): core/*, world/*, gen/*, ecs/*, light/*, render/bake.js, render/camera.js
export { hash3, vnoise, mulberry32, tileSeed, pick, ri } from './core/rand.js';
export { SOLID, EMIT, C, E, FLAG, shade, jit, rgbOf, Volume, buildStack } from './core/voxel.js';
export { World, columnInfo } from './world/world.js';
export { Streamer, LocalBackend, WorkerBackend } from './stream/streamer.js';
export { Builder } from './stream/builder.js';
export { Camera, Mat2D } from './render/camera.js';
export { bakeBox, sliceBounds, octEnc, octDec, DEFAULT_SUN } from './render/bake.js';
export { Renderer } from './render/renderer.js';
export { Particles } from './render/particles.js';
export { skyAt, flicker, nearestLights, MAX_LIGHTS } from './light/light.js';
export { ECS, movementSystem } from './ecs/ecs.js';
export { FlowField } from './ecs/flowfield.js';
export { wfc, DIRS } from './gen/wfc.js';
export { planRooms } from './gen/floorplan.js';
export { Input } from './platform/input.js';
export { Synth } from './platform/audio.js';
export { Debris, Emitter } from './destruct/debris.js';
export { carve, shatter, checkSupport, drop } from './destruct/destruct.js';
