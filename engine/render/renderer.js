// WebGL2-Backend: Sprite-Stack-G-Buffer, Welt-Fenster im Ringpuffer, Sprites, Umrisse, Decals, Lichtpass.
//
// Ablauf pro Bild:
//   r.begin(camera)                       G-Buffer leeren
//   r.drawWorld(world, opts)              geladene Kacheln im Bild
//   r.drawSprite(sprite, frame, x, y, rot, opts)   Figuren, Flammen …
//   r.light(params)                       Lichtpass auf den Bildschirm
//
// Die Welt liegt als Fenster aus win × win Kacheln auf der GPU (zwei RGBA8-Textur-Arrays A und B).
// Kachel (tx, ty) belegt den Platz (tx mod win, ty mod win). Instanzen tragen Welt- und Texturposition getrennt,
// darum muss beim Wandern nichts umkopiert werden.
import { VS_G, FS_G, VS_L, FS_L, FS_SLOT, FS_SUN } from './shaders.js';
import { bakeBox, bakeBricks, chunkBounds, CHUNK, DEFAULT_SUN } from './bake.js';
import { MAX_LIGHTS, TILE, PER_TILE, binLights } from '../light/light.js';

const MAX_INST = 120000;

export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} [o]
   * @param {number} [o.zMax]   größte Höhe, die gezeichnet wird (für die Tiefe), Standard 34
   * @param {number[]} [o.sun]  Richtung des Hauptlichts für gebackene Schatten
   */
  constructor(canvas, o = {}) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 nicht verfügbar');
    this.gl = gl;
    this.zMax = o.zMax ?? 34;
    this.sun = o.sun ?? DEFAULT_SUN;
    this.PG = this.program(VS_G, FS_G); this.PL = this.program(VS_L, FS_L);
    gl.useProgram(this.PG.p); gl.uniform1i(this.PG.u.uA, 0); gl.uniform1i(this.PG.u.uB, 1);
    gl.useProgram(this.PL.p); ['tA', 'tN', 'tX', 'tG', 'tH', 'tL', 'tT', 'tI', 'tS', 'tSun'].forEach((k, i) => gl.uniform1i(this.PL.u[k], i));
    // Schwellen-Atlas für Sicht und Lichtschatten (4 × 4 Plätze à 256²) und Sonnenschwellen (pro Fenster)
    this.PS = this.program(VS_L, FS_SLOT); this.PSun = this.program(VS_L, FS_SUN);
    gl.useProgram(this.PS.p); gl.uniform1i(this.PS.u.tH, 0); gl.useProgram(this.PSun.p); gl.uniform1i(this.PSun.u.tH, 0);
    this.ATL = 1024; this.tS = this.r8Target(this.ATL, this.ATL, false); this.slots = new Float32Array(64);
    // Lichtdaten als Float-Texturen (WebGL2 darf RGBA32F/R32F mit NEAREST lesen)
    this.tL = this.floatTex(MAX_LIGHTS * 2, 1, 4); this.LD = new Float32Array(MAX_LIGHTS * 8);
    this.tT = null; this.tI = this.floatTex(1024, 16, 1); this.tIrows = 16;
    this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.ibuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.ibuf);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 0); gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, 16); gl.vertexAttribDivisor(2, 1);
    this.vaoL = gl.createVertexArray();
    this.INST = new Float32Array(8 * MAX_INST);
    this.HIR = new Float32Array(24); this.HIZ = new Float32Array(24); this.HI0 = new Float32Array(24);
    this.stats = { insts: 0, calls: 0 };
    this.fbo = null; this.gtex = []; this.depthRb = null;
    this.world = null;
  }

  // ---------------------------------------------------------------- GL-Hilfen
  program(vs, fs) {
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name.replace('[0]', '')] = gl.getUniformLocation(p, info.name); }
    return { p, u };
  }
  /** R8-Ziel mit linearer Filterung (für Schwellen), mit eigenem Framebuffer. */
  r8Target(w, h, repeat) {
    const gl = this.gl, t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const wr = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wr); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wr);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, w, h);
    t.fbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return t;
  }
  floatTex(w, h, ch) {
    const gl = this.gl, t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(gl.TEXTURE_2D, 1, ch === 4 ? gl.RGBA32F : gl.R32F, w, h);
    t.w = w; t.h = h; t.ch = ch;
    return t;
  }
  texArray(w, d, layers, data) {
    const gl = this.gl, t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D_ARRAY, k, v);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, w, d, layers);
    if (data) gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, w, d, layers, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return t;
  }

  /** Zeichenpuffer-Größe setzen (Pixel). */
  resize(w, h) {
    const gl = this.gl;
    this.canvas.width = w; this.canvas.height = h;
    if (this.fbo) { gl.deleteFramebuffer(this.fbo); this.gtex.forEach(t => gl.deleteTexture(t)); gl.deleteRenderbuffer(this.depthRb); }
    this.fbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo); this.gtex = [];
    for (let i = 0; i < 4; i++) {
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0); this.gtex.push(t);
    }
    this.depthRb = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthRb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depthRb);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // ---------------------------------------------------------------- Welt auf der GPU
  /**
   * Welt anbinden: Fenster aus win × win Kacheln anlegen, Höhenkarte für die ganze Welt.
   * Danach werden geänderte Bereiche (world.updateRegion) automatisch neu gebacken.
   */
  attachWorld(world, win = 5) {
    const gl = this.gl;
    if (this.TWA) { gl.deleteTexture(this.TWA); gl.deleteTexture(this.TWB); gl.deleteTexture(this.hTex); }
    this.world = world; this.win = win; this.WIN = win * world.TS;
    this.TWA = this.texArray(this.WIN, this.WIN, world.H); this.TWB = this.texArray(this.WIN, this.WIN, world.H);
    this.slotOwner = new Int32Array(win * win).fill(-1);
    // Höhenkarte nur für das Fenster, gleiche Plätze wie die Voxel; REPEAT adressiert über Weltkoordinaten mod WIN
    this.hTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.hTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RG8, this.WIN, this.WIN);      // R: Säule ab z = 1, G: oberste Höhe
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.REPEAT], [gl.TEXTURE_WRAP_T, gl.REPEAT]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.WIN, this.WIN, gl.RG, gl.UNSIGNED_BYTE, new Uint8Array(this.WIN * this.WIN * 2));
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    if (this.tSun) gl.deleteTexture(this.tSun);
    this.tSun = this.r8Target(this.WIN, this.WIN, true); this.sunKey = '';
    world.on('regionChanged', (x0, y0, x1, y1) => {
      this.uploadHeight(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
      this.rebake(x0 - 1, y0 - 1, x1 + 1, y1 + 1);    // 1 Voxel Rand: Normalen und Verdeckung der Nachbarn ändern sich mit
    });
    world.on('tileUnloaded', t => { if (this.resident(t)) { this.slotOwner[this.slotOf(t.tx, t.ty)] = -1; } this.dropTile(t); });
    // Brick-Atlas: AW × AW Plätze zu S × S × S Texeln (S Ebenen), nur bei Unterteilung
    if (this.BA) { gl.deleteTexture(this.BA); gl.deleteTexture(this.BB); this.BA = this.BB = null; }
    const S = world.sub;
    if (S > 1) {
      this.AW = Math.floor(512 / S); this.ATW = this.AW * S;   // S = 4: 128² Plätze (16 384 Bricks, 8 MB)
      this.BA = this.texArray(this.ATW, this.ATW, S); this.BB = this.texArray(this.ATW, this.ATW, S);
      this.freeSlots = []; for (let k = this.AW * this.AW - 1; k >= 0; k--) this.freeSlots.push(k);
    }
    // Farbatlas für Block-Partikel (eine Zeile, eine Ebene)
    if (!this.DA) {
      this.DW = 1024; this.DA = this.texArray(this.DW, 1, 1);
      const nb = new Uint8Array(this.DW * 4); for (let k = 0; k < this.DW; k++) nb.set([128, 128, 127, 0], k * 4);   // Normale nach oben, ohne Verdeckung, Schattenbit aus
      for (let k = 0; k < this.DW; k++) nb[k * 4 + 2] = 127 | 128;
      this.DB = this.texArray(this.DW, 1, 1, nb); this.dColors = new Map();
    }
  }
  /** Brick-Plätze einer Kachel freigeben. */
  dropTile(t) {
    if (t.gpu && t.gpu.bricks && this.freeSlots) for (const slot of t.gpu.bricks.values()) this.freeSlots.push(slot);
    t.gpu = null;
  }
  uploadBrick(slot, A, B, off) {
    const gl = this.gl, S = this.world.sub, n = S * S * S * 4, u = (slot % this.AW) * S, v = ((slot / this.AW) | 0) * S;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.BA); gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, u, v, 0, S, S, S, gl.RGBA, gl.UNSIGNED_BYTE, A.subarray(off, off + n));
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.BB); gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, u, v, 0, S, S, S, gl.RGBA, gl.UNSIGNED_BYTE, B.subarray(off, off + n));
  }
  /** Gebackene Bricks einer Kachel hochladen (keys = Blockindizes). Alte Plätze der Kachel werden ersetzt. */
  uploadBricks(t, keys, A, B) {
    if (!this.freeSlots) return;
    const g = t.gpu, S3 = this.world.sub ** 3;
    if (!g.bricks) g.bricks = new Map();
    keys.forEach((i, k) => {
      let slot = g.bricks.get(i);
      if (slot === undefined) { slot = this.freeSlots.pop(); if (slot === undefined) return; g.bricks.set(i, slot); }
      this.uploadBrick(slot, A, B, k * S3 * 4);
    });
  }
  slotOf(tx, ty) { const w = this.win; return (((ty % w) + w) % w) * w + (((tx % w) + w) % w); }
  /** Liegt die Kachel aktuell gebacken auf der GPU? */
  resident(t) { return !!t && !!t.gpu && this.slotOwner[this.slotOf(t.tx, t.ty)] === t.key; }
  /** Speicher auf der GPU in Byte (Welt-Fenster und Höhenkarte). */
  gpuBytes() { return this.WIN * this.WIN * this.world.H * 8 + this.WIN * this.WIN * 2 + (this.ATW ? this.ATW * this.ATW * this.world.sub * 8 : 0); }

  /** Höhen eines Weltrechtecks in den Fensterplatz ihrer Kachel laden (nur für Kacheln, die dort liegen). */
  uploadHeight(x0, y0, w, d) {
    const world = this.world, gl = this.gl, TS = world.TS;
    const x1 = Math.min(world.W - 1, x0 + w - 1), y1 = Math.min(world.D - 1, y0 + d - 1);
    x0 = Math.max(0, x0); y0 = Math.max(0, y0);
    this.heightsChanged = true;
    gl.bindTexture(gl.TEXTURE_2D, this.hTex); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    for (let ty = Math.floor(y0 / TS); ty <= Math.floor(y1 / TS); ty++) for (let tx = Math.floor(x0 / TS); tx <= Math.floor(x1 / TS); tx++) {
      const t = world.tileOf(tx, ty); if (!t || !t.colH || !this.resident(t)) continue;
      const ax = Math.max(x0, tx * TS) - tx * TS, ay = Math.max(y0, ty * TS) - ty * TS, bx = Math.min(x1, tx * TS + TS - 1) - tx * TS, by = Math.min(y1, ty * TS + TS - 1) - ty * TS;
      const ww = bx - ax + 1, dd = by - ay + 1, buf = new Uint8Array(ww * dd * 2), top = t.colTop || t.colH;
      for (let y = 0; y < dd; y++) for (let x = 0; x < ww; x++) { const i = (ay + y) * TS + ax + x, q = (y * ww + x) * 2; buf[q] = t.colH[i]; buf[q + 1] = top[i]; }
      gl.texSubImage2D(gl.TEXTURE_2D, 0, t.gpu.sx + ax, t.gpu.sy + ay, ww, dd, gl.RG, gl.UNSIGNED_BYTE, buf);
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  }

  /** Fertig gebackene Kachel (aus einem Worker) in ihren Platz laden. A wird behalten (Decals). */
  uploadTile(t, A, B, bb, bricks) {
    const world = this.world, gl = this.gl, TS = world.TS, H = world.H;
    const ox = t.tx * TS, oy = t.ty * TS;
    for (const dc of t.decals) this.paintDecal(A, dc.x - ox, dc.y - oy, dc.c, dc.a, TS);
    const s = this.slotOf(t.tx, t.ty), sx = (s % this.win) * TS, sy = ((s / this.win) | 0) * TS;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.TWA); gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, sx, sy, 0, TS, TS, H, gl.RGBA, gl.UNSIGNED_BYTE, A);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.TWB); gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, sx, sy, 0, TS, TS, H, gl.RGBA, gl.UNSIGNED_BYTE, B);
    const prev = this.slotOwner[s];
    if (prev >= 0 && prev !== t.key) { const old = world.tiles.get(prev); if (old) this.dropTile(old); }
    this.slotOwner[s] = t.key;
    const oldBricks = t.gpu && t.gpu.bricks;
    t.gpu = { A, bb, sx, sy, rev: t.rev, bricks: new Map() };
    if (oldBricks && this.freeSlots) for (const slot of oldBricks.values()) this.freeSlots.push(slot);
    if (bricks && bricks.keys.length) this.uploadBricks(t, [...bricks.keys], bricks.A, bricks.B);
    this.uploadHeight(ox, oy, TS, TS);
  }
  /** Ganze Kachel im Haupt-Thread backen (ohne Worker). Nachbarn sollten geladen sein, sonst fehlen Normalen am Rand. */
  bakeTile(t) {
    const world = this.world, TS = world.TS, H = world.H;
    const n = TS * TS * H * 4, A = new Uint8Array(n), B = new Uint8Array(n), ox = t.tx * TS, oy = t.ty * TS;
    bakeBox((x, y, z) => world.getC(x, y, z), (x, y, z) => world.getL(x, y, z), ox, oy, TS, TS, H, true, A, B, this.sun);
    let bricks = null;
    if (t.vol.bricks.size) { const keys = [...t.vol.bricks.keys()]; bricks = { keys, ...this.bakeBricksOf(t, keys) }; }
    this.uploadTile(t, A, B, chunkBounds(t.vol.data, TS, TS, H), bricks);
  }
  bakeBricksOf(t, keys) {
    const w = this.world;
    return bakeBricks((x, y, z) => w.getFine(x, y, z), (x, y, z) => w.getFineLay(x, y, z), (x, y, z) => w.getC(x, y, z), keys, w.TS, t.tx * w.TS, t.ty * w.TS, w.H, w.sub, this.sun);
  }
  /** Rechteck in Weltkoordinaten neu backen, auch über Kachelgrenzen. */
  rebake(x0, y0, x1, y1) {
    const world = this.world, TS = world.TS;
    for (let ty = Math.floor(Math.max(0, y0) / TS); ty <= Math.floor(Math.min(world.D - 1, y1) / TS); ty++)
      for (let tx = Math.floor(Math.max(0, x0) / TS); tx <= Math.floor(Math.min(world.W - 1, x1) / TS); tx++) {
        const t = world.tileOf(tx, ty);
        if (!this.resident(t) || !t.vol) continue;
        const ox = tx * TS, oy = ty * TS;
        this.rebakeIn(t, Math.max(ox, x0), Math.max(oy, y0), Math.min(ox + TS - 1, x1), Math.min(oy + TS - 1, y1));
      }
  }
  rebakeIn(t, x0, y0, x1, y1) {
    const world = this.world, gl = this.gl, TS = world.TS, H = world.H, g = t.gpu;
    const ox = t.tx * TS, oy = t.ty * TS, w = x1 - x0 + 1, d = y1 - y0 + 1;
    const A = new Uint8Array(w * d * H * 4), B = new Uint8Array(w * d * H * 4);
    bakeBox((x, y, z) => world.getC(x, y, z), (x, y, z) => world.getL(x, y, z), x0, y0, w, d, H, true, A, B, this.sun);
    for (let z = 0; z < H; z++) for (let y = 0; y < d; y++)
      g.A.set(A.subarray(((z * d + y) * w) * 4, ((z * d + y) * w + w) * 4), ((z * TS + (y0 - oy + y)) * TS + (x0 - ox)) * 4);
    // Decals im Bereich erneut auftragen (das Backen hat die Albedo überschrieben)
    for (const dc of t.decals) if (dc.x >= x0 && dc.x <= x1 && dc.y >= y0 && dc.y <= y1) {
      this.paintDecal(g.A, dc.x - ox, dc.y - oy, dc.c, dc.a, TS);
      const q = ((dc.y - y0) * w + (dc.x - x0)) * 4, s = ((dc.y - oy) * TS + (dc.x - ox)) * 4;
      A[q] = g.A[s]; A[q + 1] = g.A[s + 1]; A[q + 2] = g.A[s + 2];
    }
    g.bb = chunkBounds(t.vol.data, TS, TS, H);   // Rechtecke können schrumpfen (Zerstörung) oder wachsen
    // Bricks im Bereich neu backen, entfernte freigeben
    if (this.freeSlots) {
      const inR = i => { const x = ox + i % TS, y = oy + ((i / TS) | 0) % TS; return x >= x0 && x <= x1 && y >= y0 && y <= y1; };
      if (!g.bricks) g.bricks = new Map();
      for (const [i, slot] of g.bricks) if (inR(i) && !t.vol.bricks.has(i)) { g.bricks.delete(i); this.freeSlots.push(slot); }
      const keys = []; for (const i of t.vol.bricks.keys()) if (inR(i)) keys.push(i);
      if (keys.length) { const bb = this.bakeBricksOf(t, keys); this.uploadBricks(t, keys, bb.A, bb.B); }
    }
    g.rev = t.rev;
    const tx = g.sx + x0 - ox, ty = g.sy + y0 - oy;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.TWA); gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, tx, ty, 0, w, d, H, gl.RGBA, gl.UNSIGNED_BYTE, A);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.TWB); gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, tx, ty, 0, w, d, H, gl.RGBA, gl.UNSIGNED_BYTE, B);
  }
  paintDecal(A, lx, ly, c, a, TS) {
    if (lx < 0 || ly < 0 || lx >= TS || ly >= TS) return;
    const q = (ly * TS + lx) * 4;
    for (let i = 0; i < 3; i++) A[q + i] = A[q + i] * (1 - a) + c[i] * a;
  }
  /** Farbfleck auf dem Boden (z = 0). Bleibt in der Kachel gespeichert und übersteht Neubacken. */
  decal(x, y, c, a) {
    const world = this.world, gl = this.gl, TS = world.TS;
    x |= 0; y |= 0; if (!world.inside(x, y)) return;
    const t = world.tileAt(x, y); if (!t) return;
    if (t.decals.length < 600) t.decals.push({ x, y, c, a });
    if (!this.resident(t)) return;
    const lx = x % TS, ly = y % TS; this.paintDecal(t.gpu.A, lx, ly, c, a, TS);
    const q = (ly * TS + lx) * 4;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.TWA);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, t.gpu.sx + lx, t.gpu.sy + ly, 0, 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([t.gpu.A[q], t.gpu.A[q + 1], t.gpu.A[q + 2], 255]));
  }

  // ---------------------------------------------------------------- Sprites
  /**
   * Sprite aus mehreren Volumen gleicher Größe (Animationsbilder). Wird ohne Bodenschatten gebacken.
   * Liefert { w, d, h, n, used, A, B }.
   */
  createSprite(vols) {
    const { w, d, h } = vols[0], n = w * d * h * 4;
    const A = new Uint8Array(n * vols.length), B = new Uint8Array(n * vols.length);
    vols.forEach((v, i) => bakeBox((x, y, z) => v.get(x, y, z), (x, y, z) => v.getLay(x, y, z), 0, 0, w, d, h, false,
      A.subarray(i * n, (i + 1) * n), B.subarray(i * n, (i + 1) * n), this.sun));
    const used = vols.map(v => { const u = new Array(h).fill(false); for (let z = 0; z < h; z++) for (let k = z * w * d; k < (z + 1) * w * d; k++) if (v.data[k]) { u[z] = true; break; } return u; });
    return { w, d, h, n: vols.length, used, A: this.texArray(w, d, h * vols.length, A), B: this.texArray(w, d, h * vols.length, B) };
  }

  // ---------------------------------------------------------------- Bild
  begin(camera) {
    const gl = this.gl, W = this.canvas.width, H = this.canvas.height;
    this.cam = camera;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo); gl.viewport(0, 0, W, H);
    this.ALL = [gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2, gl.COLOR_ATTACHMENT3];
    gl.drawBuffers(this.ALL);
    for (let i = 0; i < 4; i++) gl.clearBufferfv(gl.COLOR, i, [0, 0, 0, 0]);
    gl.clearBufferfi(gl.DEPTH_STENCIL, 0, 1, 0);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(true);
    gl.useProgram(this.PG.p); gl.bindVertexArray(this.vao);
    gl.uniform2f(this.PG.u.uScreen, W, H); gl.uniform1f(this.PG.u.uDzu, camera.dzu); gl.uniform1f(this.PG.u.uZMax, this.zMax);
    this.stats.insts = 0; this.stats.calls = 0; this.stats.culled = 0; this.stats.area = 0;
  }
  drawInst(TA, TB, M, tw, td, count, rot, o = {}) {
    if (!count) return;
    const gl = this.gl, u = this.PG.u;
    gl.uniformMatrix3fv(u.uM, false, M.mat3());
    gl.uniform2f(u.uTex, tw, td);
    const c = Math.cos(rot), s = Math.sin(rot);
    gl.uniformMatrix2fv(u.uRot, false, [c, s, -s, c]);
    gl.uniform2f(u.uOv, o.shadow !== undefined ? 1 : 0, o.shadow ?? 0);
    gl.uniform1f(u.uGhost, o.ghost || 0);
    gl.uniform1f(u.uEnt, o.ent || 0);
    const tn = o.tint || [0, 0, 0, 0]; gl.uniform4f(u.uTint, tn[0], tn[1], tn[2], tn[3]);
    const cu = o.cut || [0, 0, 0, 0]; gl.uniform4f(u.uCut, cu[0], cu[1], cu[2], cu[3]);
    gl.uniform1f(u.uHiAll, o.hi || 0);
    const hr = o.rects === true ? this.HIR : o.rects ? o.rects[0] : this.HI0, hz = o.rects === true ? this.HIZ : o.rects ? o.rects[1] : this.HI0;
    gl.uniform4fv(u.uHiR, hr); gl.uniform4fv(u.uHiZ, hz);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D_ARRAY, TA);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D_ARRAY, TB);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ibuf); gl.bufferData(gl.ARRAY_BUFFER, this.INST.subarray(0, count * 8), gl.STREAM_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    this.stats.insts += count; this.stats.calls++;
  }

  /**
   * Alle gebackenen Kacheln im Bild zeichnen.
   * @param {object} [o]
   * @param {number[]} [o.cut]   Rechteck [x0, y0, x1, y1], in dem Dach und obere Wände weggelassen werden
   * @param {{rect:number[], z0:number, z1:number, kind:number}[]} [o.highlights]  bis zu 6 Umrisse (kind 1 gelb, 0.5 rot)
   */
  drawWorld(o = {}) {
    const world = this.world, cam = this.cam, TS = world.TS, H = world.H;
    const W = this.canvas.width, Hc = this.canvas.height;
    const nF = Math.max(1, Math.ceil(cam.dzu)), INST = this.INST;
    this.HIR.fill(0); this.HIZ.fill(0);
    (o.highlights || []).slice(0, 6).forEach((h, i) => { this.HIR.set(h.rect, i * 4); this.HIZ.set([h.z0, h.z1, h.kind, 0], i * 4); });
    const [gx0, gy0, gx1, gy1] = cam.groundBounds(H);
    let c = 0;
    for (let ty = Math.max(0, Math.floor(gy0 / TS)); ty <= Math.min(world.tilesY - 1, Math.floor(gy1 / TS)); ty++)
      for (let tx = Math.max(0, Math.floor(gx0 / TS)); tx <= Math.min(world.tilesX - 1, Math.floor(gx1 / TS)); tx++) {
        const t = world.tileOf(tx, ty); if (!this.resident(t)) continue;
        // Gitter-Culling: jede Kachel in Teilstücke von CHUNK × CHUNK; Teilstücke außerhalb des Bildes fallen weg,
        // und jede Höhe zeichnet nur ihr belegtes Rechteck im Teilstück (weniger verworfene Fragmente)
        const bb = t.gpu.bb, nC = Math.ceil(TS / CHUNK), SB = 1 + 4 * H;
        for (let cy = 0; cy < nC; cy++) for (let cx = 0; cx < nC; cx++) {
          const b = (cy * nC + cx) * SB, top = bb[b]; if (top <= 0) continue;
          const wx0 = tx * TS + cx * CHUNK, wy0 = ty * TS + cy * CHUNK, wx1 = Math.min(wx0 + CHUNK, (tx + 1) * TS), wy1 = Math.min(wy0 + CHUNK, (ty + 1) * TS);
          let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
          for (const [px, py] of [[wx0, wy0], [wx1, wy0], [wx0, wy1], [wx1, wy1]]) {
            const [sx, sy] = cam.project(px, py, 0);
            minX = Math.min(minX, sx); maxX = Math.max(maxX, sx); minY = Math.min(minY, sy - top * cam.dzu); maxY = Math.max(maxY, sy);
          }
          if (maxX < 0 || minX > W || maxY < 0 || minY > Hc) { this.stats.culled++; continue; }
          for (let z = 0; z < top; z++) {
            const k = b + 1 + z * 4; if (bb[k] < 0) continue;
            const x0 = bb[k], y0 = bb[k + 1], w = bb[k + 2] - x0 + 1, h = bb[k + 3] - y0 + 1;
            // Boden (z = 0): unter ihm liegt nichts, nur die oberste Füllkopie ist sichtbar → eine statt nF Kopien
            const j0 = z === 0 ? nF - 1 : 0;
            for (let j = j0; j < nF && c < MAX_INST; j++) { INST.set([z, z + j / nF, tx * TS + x0, ty * TS + y0, w, h, t.gpu.sx + x0, t.gpu.sy + y0], c * 8); c++; }
            this.stats.area += w * h * (nF - j0);
          }
        }
      }
    this.drawInst(this.TWA, this.TWB, cam.M, this.WIN, this.WIN, c, 0, { cut: o.cut, rects: true });   // Welt-Normalen sind schon in Weltkoordinaten
    if (this.freeSlots) this.drawBricks(gx0, gy0, gx1, gy1, o);
  }
  /** Feine Blöcke: im feinen Raum (Matrix · 1/S), jede feine Scheibe ein Quad, Tiefe weiter nur aus z. */
  drawBricks(gx0, gy0, gx1, gy1, o) {
    const world = this.world, cam = this.cam, TS = world.TS, S = world.sub, INST = this.INST;
    const n = Math.max(1, Math.ceil(cam.dzu / S));
    let c = 0;
    for (let ty = Math.max(0, Math.floor(gy0 / TS)); ty <= Math.min(world.tilesY - 1, Math.floor(gy1 / TS)); ty++)
      for (let tx = Math.max(0, Math.floor(gx0 / TS)); tx <= Math.min(world.tilesX - 1, Math.floor(gx1 / TS)); tx++) {
        const t = world.tileOf(tx, ty); if (!this.resident(t) || !t.gpu.bricks || !t.gpu.bricks.size) continue;
        for (const [i, slot] of t.gpu.bricks) {
          const bx = tx * TS + i % TS, by = ty * TS + ((i / TS) | 0) % TS, bz = (i / (TS * TS)) | 0;
          const u = (slot % this.AW) * S, v = ((slot / this.AW) | 0) * S;
          for (let sz = 0; sz < S; sz++) for (let j = 0; j < n && c < MAX_INST; j++) {
            INST.set([sz, bz + sz / S + j / (n * S), bx * S, by * S, S, S, u, v], c * 8); c++;
          }
        }
      }
    if (!c) return;
    const cut = o.cut ? o.cut.map(v => v * S) : null;
    const hr = this.HIR.map((v, k) => (k % 4) < 4 ? v * S : v);
    this.drawInst(this.BA, this.BB, cam.M.scale(1 / S), this.ATW, this.ATW, c, 0, { cut, rects: [hr, this.HIZ] });
  }

  /**
   * Block-Partikel in einem Draw-Call. list: [{ x, y, z, size, color }] (size in Blöcken, ≤ 1; color 0xRRGGBB).
   * Würfel ohne Drehung, oben beleuchtet; Tiefe wie alles andere aus z.
   */
  drawDebris(list) {
    if (!list.length) return;
    const gl = this.gl, cam = this.cam, INST = this.INST;
    let c = 0;
    for (const p of list) {
      if (c >= MAX_INST) break;
      const s = Math.min(1, p.size), ci = this.debrisColor(p.color & 0xffffff);
      const k = Math.max(1, Math.ceil(s * cam.dzu));
      for (let j = 0; j < k && c < MAX_INST; j++) { INST.set([0, p.z + s * j / k, p.x - s / 2, p.y - s / 2, s, s, ci + (1 - s) / 2, (1 - s) / 2], c * 8); c++; }
    }
    this.drawInst(this.DA, this.DB, cam.M, this.DW, 1, c, 0, { shadow: 1 });
  }
  debrisColor(col) {
    let i = this.dColors.get(col);
    if (i !== undefined) return i;
    if (this.dColors.size >= this.DW) this.dColors.clear();
    i = this.dColors.size; this.dColors.set(col, i);
    const gl = this.gl; gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.DA);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, i, 0, 0, 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([(col >> 16) & 255, (col >> 8) & 255, col & 255, 255]));
    return i;
  }

  /**
   * Sprite an Weltposition zeichnen.
   * @param {object} [o]
   * @param {number} [o.dens]   Voxel pro Welteinheit (Figuren 4, Flammen 2)
   * @param {number} [o.z]      Bodenhöhe in Welteinheiten
   * @param {number} [o.shadow] 1 = vom Hauptlicht beleuchtet, 0 = im Schatten (innen)
   * @param {number} [o.ent]    1 = Spielfigur (kein Umriss darüber), 2 = Gegner (außer Sicht fast schwarz)
   * @param {number[]} [o.tint] [r, g, b, Anteil]
   * @param {number} [o.hi]     Umriss: 1 gelb, 0.5 rot
   * @param {boolean} [o.xray]  hinter Wänden als Silhouette durchscheinen
   */
  drawSprite(spr, frame, x, y, rot, o = {}) {
    const gl = this.gl, cam = this.cam, dens = o.dens ?? 4, bz = o.z ?? 1, INST = this.INST;
    const used = spr.used[frame], n = Math.max(1, Math.ceil(cam.dzu / dens));
    let c = 0;
    for (let k = 0; k < spr.h; k++) {
      if (!used[k]) continue;
      for (let j = 0; j < n; j++) { INST.set([frame * spr.h + k, bz + k / dens + j / (n * dens), 0, 0, spr.w, spr.d, 0, 0], c * 8); c++; }
    }
    const M = cam.M.translate(x, y).rotate(rot).scale(1 / dens).translate(-spr.w / 2, -spr.d / 2);
    const r = rot;   // dreht die Sprite-Normalen in Weltkoordinaten
    if (o.xray) {
      gl.drawBuffers([gl.NONE, gl.NONE, gl.NONE, gl.COLOR_ATTACHMENT3]); gl.depthFunc(gl.GREATER); gl.depthMask(false);
      this.drawInst(spr.A, spr.B, M, spr.w, spr.d, c, r, { ...o, ghost: 1 });
      gl.drawBuffers(this.ALL); gl.depthFunc(gl.LESS); gl.depthMask(true);
    }
    this.drawInst(spr.A, spr.B, M, spr.w, spr.d, c, r, o);
  }

  /**
   * Lichtpass.
   * @param {object} p
   * @param {number[]} p.ambient      Umgebungslicht rgb
   * @param {number[]} p.sunColor     Hauptlicht rgb
   * @param {number[]} [p.sunDir]     Richtung zum Hauptlicht; mit Angabe wird der Schatten pro Bild aus der Höhenkarte
   *                                  gerechnet (Tageszeit), sonst gilt der gebackene Schatten der Back-Richtung
   * @param {number[]} p.eye          [x, y, z] für Sichtlinie
   * @param {boolean} [p.los]         Bereiche außer Sicht grau
   * @param {{x,y,z,r,color:number[],shadow?:boolean}[]} p.lights  Punktlichter, bis MAX_LIGHTS; je Bildschirmkachel höchstens PER_TILE
   * @param {object} [p.spot]         { x, y, z, r, color, dir: [dx, dy, dz], cos, shadow } (Taschenlampe)
   * @param {number} [p.maxShadowed]  nur die so vielen dem Auge nächsten Lichter werfen Schatten (Standard 8)
   * @param {number} [p.flash]        Blitz 0…1
   * @param {number} [p.quant]        Farbstufen (0 = aus)
   * @param {number} [p.time]         Sekunden, für Pulsieren
   */
  light(p) {
    const gl = this.gl, cam = this.cam, W = this.canvas.width, H = this.canvas.height, u = this.PL.u, t = p.time || 0;
    // Lichter: Schatten nur für die nächsten, dann auf Kacheln verteilen
    const lights = (p.lights || []).filter(Boolean).slice(0, MAX_LIGHTS);
    const eye = p.eye || [cam.x, cam.y, 9], ms = Math.min(p.maxShadowed ?? 8, 14);
    // Schwellenplätze: 0 = Sicht vom Auge, 1 = Spot, danach die nächsten schattenwerfenden Punktlichter
    const slotList = [];
    const addSlot = (x, y, z, r) => { const S = Math.min(256, 2 * Math.ceil(r) + 4); slotList.push({ x: Math.floor(x) - (S >> 1), y: Math.floor(y) - (S >> 1), S, src: [x, y, z] }); return slotList.length - 1; };
    addSlot(eye[0], eye[1], eye[2], 126);
    const spotSlot = p.spot && p.spot.shadow !== false ? addSlot(p.spot.x, p.spot.y, p.spot.z, p.spot.r) : -1;
    const order = lights.map((L, i) => [Math.hypot(L.x - eye[0], L.y - eye[1]), i]).filter(([, i]) => lights[i].shadow !== false).sort((a, b) => a[0] - b[0]);
    const slotOf = new Map();
    for (const [, i] of order.slice(0, ms)) { const L = lights[i]; slotOf.set(i, addSlot(L.x, L.y, L.z, L.r)); }
    const LD = this.LD; LD.fill(0);
    lights.forEach((L, i) => { LD.set([L.x, L.y, L.z, L.r, L.color[0], L.color[1], L.color[2], slotOf.has(i) ? 2 + slotOf.get(i) : 1], i * 8); });
    this.renderSlots(slotList, p.los || spotSlot >= 0 || slotOf.size);
    if (p.sunDir) this.renderSun(p.sunDir, cam);
    const bins = binLights(lights, cam, W, H, this.zMax, TILE, PER_TILE);
    this.stats.lights = lights.length; this.stats.lightRefs = bins.list.length; this.stats.lightsDropped = bins.dropped;
    gl.bindTexture(gl.TEXTURE_2D, this.tL); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, MAX_LIGHTS * 2, 1, gl.RGBA, gl.FLOAT, LD);
    if (!this.tT || this.tT.w !== bins.cols || this.tT.h !== bins.rows) { if (this.tT) gl.deleteTexture(this.tT); this.tT = this.floatTex(bins.cols, bins.rows, 4); }
    gl.bindTexture(gl.TEXTURE_2D, this.tT); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, bins.cols, bins.rows, gl.RGBA, gl.FLOAT, bins.header);
    const rows = Math.max(1, Math.ceil(bins.list.length / 1024));
    if (rows > this.tIrows) { gl.deleteTexture(this.tI); this.tIrows = rows; this.tI = this.floatTex(1024, rows, 1); }
    const LI = new Float32Array(rows * 1024); LI.set(bins.list);
    gl.bindTexture(gl.TEXTURE_2D, this.tI); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1024, rows, gl.RED, gl.FLOAT, LI);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.PL.p); gl.bindVertexArray(this.vaoL);
    const texs = [...this.gtex, this.hTex, this.tL, this.tT, this.tI, this.tS, this.tSun];
    texs.forEach((tx, i) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, tx); });
    gl.uniform2f(u.uScreen, W, H); gl.uniform2f(u.uWorld, this.WIN, this.WIN);   // Höhenkarte: Fenster, REPEAT
    gl.uniformMatrix3fv(u.uInv, false, cam.Minv.mat3());
    gl.uniform1f(u.uDzu, cam.dzu); gl.uniform1f(u.uZMax, this.zMax); gl.uniform1f(u.uFlash, p.flash || 0);
    gl.uniform1f(u.uGA, 0.5 + 0.12 * Math.sin(t * 5));
    gl.uniform1f(u.uQuant, p.quant ?? 22); gl.uniform1f(u.uLos, p.los ? 1 : 0);
    gl.uniform1f(u.uTile, TILE); gl.uniform1i(u.uPerTile, PER_TILE);
    const a = p.ambient, f = p.flash || 0;
    gl.uniform3f(u.uAmb, a[0] + f * 0.5, a[1] + f * 0.5, a[2] + f * 0.6);
    gl.uniform3fv(u.uSun, p.sunDir || this.sun); gl.uniform1f(u.uSunMode, p.sunDir ? 1 : 0); gl.uniform3fv(u.uSunC, p.sunColor);
    gl.uniform3fv(u.uEye, eye);
    gl.uniform3fv(u.uGhostC, p.ghostColor || [0.45, 0.85, 1.0]);
    const s = p.spot;
    if (s) {
      const [dx, dy, dz] = s.dir, l = Math.hypot(dx, dy, dz) || 1;
      gl.uniform4f(u.uSpot, dx / l, dy / l, dz / l, s.cos); gl.uniform4f(u.uSpP, s.x, s.y, s.z, s.r);
      gl.uniform4f(u.uSpC, s.color[0], s.color[1], s.color[2], spotSlot >= 0 ? 2 + spotSlot : 1);
    } else gl.uniform4f(u.uSpC, 0, 0, 0, 0);
    gl.uniform4fv(u.uSlots, this.slots); gl.uniform1f(u.uAtlas, this.ATL);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  /** Schwellen für Auge, Spot und Lichter in den Atlas rendern (ein Dreieck pro Platz). */
  renderSlots(list, any) {
    const gl = this.gl, u = this.PS.u;
    this.slots.fill(0);
    list.forEach((sl, i) => this.slots.set([sl.x, sl.y, sl.S, 0], i * 4));
    if (!any) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.tS.fbo); gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.PS.p); gl.bindVertexArray(this.vaoL);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.hTex);
    gl.uniform2f(u.uWorld, this.WIN, this.WIN);
    list.forEach((sl, i) => {
      const ox = (i * 256) % this.ATL, oy = Math.floor(i * 256 / this.ATL) * 256;
      gl.viewport(ox, oy, sl.S, sl.S);
      gl.uniform4f(u.uSlot, sl.x, sl.y, sl.S, 0); gl.uniform3f(u.uSrc, sl.src[0], sl.src[1], sl.src[2]); gl.uniform2f(u.uOrigin, ox, oy);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    });
    this.stats.slots = list.length;
  }
  /** Sonnenschwellen über das Fenster, nur wenn sich Richtung, Höhen oder Fenster geändert haben. */
  renderSun(dir, cam) {
    const gl = this.gl, u = this.PSun.u, WIN = this.WIN;
    const ox = Math.floor(cam.x - WIN / 2), oy = Math.floor(cam.y - WIN / 2);
    const key = dir.map(v => v.toFixed(3)).join() + '|' + Math.floor(ox / 16) + ',' + Math.floor(oy / 16);
    if (key === this.sunKey && !this.heightsChanged) return;
    this.sunKey = key; this.heightsChanged = false;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.tSun.fbo); gl.disable(gl.DEPTH_TEST); gl.viewport(0, 0, WIN, WIN);
    gl.useProgram(this.PSun.p); gl.bindVertexArray(this.vaoL);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.hTex);
    gl.uniform2f(u.uWorld, WIN, WIN); gl.uniform3fv(u.uSun, dir); gl.uniform2f(u.uOrigin, ox, oy); gl.uniform1f(u.uZMax, this.zMax);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.stats.sunPasses = (this.stats.sunPasses || 0) + 1;
  }
}
