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
import { VS_G, FS_G, VS_L, FS_L } from './shaders.js';
import { bakeBox, sliceBounds, DEFAULT_SUN } from './bake.js';
import { MAX_LIGHTS } from '../light/light.js';

const MAX_INST = 30000;

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
    gl.useProgram(this.PL.p); ['tA', 'tN', 'tX', 'tG', 'tH'].forEach((k, i) => gl.uniform1i(this.PL.u[k], i));
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
    this.LP = new Float32Array(4 * MAX_LIGHTS); this.LC = new Float32Array(4 * MAX_LIGHTS);
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
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, this.WIN, this.WIN);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.REPEAT], [gl.TEXTURE_WRAP_T, gl.REPEAT]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.WIN, this.WIN, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(this.WIN * this.WIN));
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    world.on('regionChanged', (x0, y0, x1, y1) => {
      this.uploadHeight(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
      this.rebake(x0 - 1, y0 - 1, x1 + 1, y1 + 1);    // 1 Voxel Rand: Normalen und Verdeckung der Nachbarn ändern sich mit
    });
    world.on('tileUnloaded', t => { if (this.resident(t)) { this.slotOwner[this.slotOf(t.tx, t.ty)] = -1; } t.gpu = null; });
  }
  slotOf(tx, ty) { const w = this.win; return (((ty % w) + w) % w) * w + (((tx % w) + w) % w); }
  /** Liegt die Kachel aktuell gebacken auf der GPU? */
  resident(t) { return !!t && !!t.gpu && this.slotOwner[this.slotOf(t.tx, t.ty)] === t.key; }
  /** Speicher auf der GPU in Byte (Welt-Fenster und Höhenkarte). */
  gpuBytes() { return this.WIN * this.WIN * this.world.H * 8 + this.WIN * this.WIN; }

  /** Höhen eines Weltrechtecks in den Fensterplatz ihrer Kachel laden (nur für Kacheln, die dort liegen). */
  uploadHeight(x0, y0, w, d) {
    const world = this.world, gl = this.gl, TS = world.TS;
    const x1 = Math.min(world.W - 1, x0 + w - 1), y1 = Math.min(world.D - 1, y0 + d - 1);
    x0 = Math.max(0, x0); y0 = Math.max(0, y0);
    gl.bindTexture(gl.TEXTURE_2D, this.hTex); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    for (let ty = Math.floor(y0 / TS); ty <= Math.floor(y1 / TS); ty++) for (let tx = Math.floor(x0 / TS); tx <= Math.floor(x1 / TS); tx++) {
      const t = world.tileOf(tx, ty); if (!t || !t.colH || !this.resident(t)) continue;
      const ax = Math.max(x0, tx * TS) - tx * TS, ay = Math.max(y0, ty * TS) - ty * TS, bx = Math.min(x1, tx * TS + TS - 1) - tx * TS, by = Math.min(y1, ty * TS + TS - 1) - ty * TS;
      const ww = bx - ax + 1, dd = by - ay + 1, buf = new Uint8Array(ww * dd);
      for (let y = 0; y < dd; y++) buf.set(t.colH.subarray((ay + y) * TS + ax, (ay + y) * TS + ax + ww), y * ww);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, t.gpu.sx + ax, t.gpu.sy + ay, ww, dd, gl.RED, gl.UNSIGNED_BYTE, buf);
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  }

  /** Fertig gebackene Kachel (aus einem Worker) in ihren Platz laden. A wird behalten (Decals). */
  uploadTile(t, A, B, bb) {
    const world = this.world, gl = this.gl, TS = world.TS, H = world.H;
    const ox = t.tx * TS, oy = t.ty * TS;
    for (const dc of t.decals) this.paintDecal(A, dc.x - ox, dc.y - oy, dc.c, dc.a, TS);
    const s = this.slotOf(t.tx, t.ty), sx = (s % this.win) * TS, sy = ((s / this.win) | 0) * TS;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.TWA); gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, sx, sy, 0, TS, TS, H, gl.RGBA, gl.UNSIGNED_BYTE, A);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.TWB); gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, sx, sy, 0, TS, TS, H, gl.RGBA, gl.UNSIGNED_BYTE, B);
    const prev = this.slotOwner[s];
    if (prev >= 0 && prev !== t.key) { const old = world.tiles.get(prev); if (old) old.gpu = null; }
    this.slotOwner[s] = t.key;
    t.gpu = { A, bb, sx, sy, rev: t.rev };
    this.uploadHeight(ox, oy, TS, TS);
  }
  /** Ganze Kachel im Haupt-Thread backen (ohne Worker). Nachbarn sollten geladen sein, sonst fehlen Normalen am Rand. */
  bakeTile(t) {
    const world = this.world, TS = world.TS, H = world.H;
    const n = TS * TS * H * 4, A = new Uint8Array(n), B = new Uint8Array(n), ox = t.tx * TS, oy = t.ty * TS;
    bakeBox((x, y, z) => world.getC(x, y, z), (x, y, z) => world.getL(x, y, z), ox, oy, TS, TS, H, true, A, B, this.sun);
    this.uploadTile(t, A, B, sliceBounds(t.vol.data, TS, TS, H));
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
    g.bb = sliceBounds(t.vol.data, TS, TS, H);   // Rechtecke können schrumpfen (Zerstörung) oder wachsen
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
    this.stats.insts = 0; this.stats.calls = 0;
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
    gl.uniform4fv(u.uHiR, o.rects ? this.HIR : this.HI0); gl.uniform4fv(u.uHiZ, o.rects ? this.HIZ : this.HI0);
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
        let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
        for (const [px, py] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const [sx, sy] = cam.project((tx + px) * TS, (ty + py) * TS, 0);
          minX = Math.min(minX, sx); maxX = Math.max(maxX, sx); minY = Math.min(minY, sy - H * cam.dzu); maxY = Math.max(maxY, sy);
        }
        if (maxX < 0 || minX > W || maxY < 0 || minY > Hc) continue;
        const bb = t.gpu.bb;
        for (let z = 0; z < H; z++) {
          const k = z * 4; if (bb[k] < 0) continue;
          const x0 = bb[k], y0 = bb[k + 1], w = bb[k + 2] - x0 + 1, h = bb[k + 3] - y0 + 1;
          for (let j = 0; j < nF && c < MAX_INST; j++) { INST.set([z, z + j / nF, tx * TS + x0, ty * TS + y0, w, h, t.gpu.sx + x0, t.gpu.sy + y0], c * 8); c++; }
        }
      }
    this.drawInst(this.TWA, this.TWB, cam.M, this.WIN, this.WIN, c, 0, { cut: o.cut, rects: true });   // Welt-Normalen sind schon in Weltkoordinaten
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
   * @param {number[]} p.sunColor     Hauptlicht rgb (Richtung = Back-Richtung)
   * @param {number[]} p.eye          [x, y, z] für Sichtlinie
   * @param {boolean} [p.los]         Bereiche außer Sicht grau
   * @param {{x,y,z,r,color:number[],shadow?:boolean}[]} p.lights  höchstens 8; Licht 0 kann Spot sein
   * @param {number[]} [p.spot]       [dx, dy, dz, cos] für Licht 0, oder weglassen
   * @param {number} [p.flash]        Blitz 0…1
   * @param {number} [p.quant]        Farbstufen (0 = aus)
   * @param {number} [p.time]         Sekunden, für Pulsieren
   */
  light(p) {
    const gl = this.gl, cam = this.cam, W = this.canvas.width, H = this.canvas.height, u = this.PL.u, t = p.time || 0;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.PL.p); gl.bindVertexArray(this.vaoL);
    for (let i = 0; i < 4; i++) { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, this.gtex[i]); }
    gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, this.hTex);
    gl.uniform2f(u.uScreen, W, H); gl.uniform2f(u.uWorld, this.WIN, this.WIN);   // Höhenkarte: Fenster, REPEAT
    gl.uniformMatrix3fv(u.uInv, false, cam.Minv.mat3());
    gl.uniform1f(u.uDzu, cam.dzu); gl.uniform1f(u.uZMax, this.zMax); gl.uniform1f(u.uFlash, p.flash || 0);
    gl.uniform1f(u.uGA, 0.5 + 0.12 * Math.sin(t * 5));
    gl.uniform1f(u.uQuant, p.quant ?? 22); gl.uniform1f(u.uLos, p.los ? 1 : 0);
    const a = p.ambient, f = p.flash || 0;
    gl.uniform3f(u.uAmb, a[0] + f * 0.5, a[1] + f * 0.5, a[2] + f * 0.6);
    gl.uniform3fv(u.uSun, this.sun); gl.uniform3fv(u.uSunC, p.sunColor);
    gl.uniform3fv(u.uEye, p.eye || [0, 0, 9]);
    gl.uniform3fv(u.uGhostC, p.ghostColor || [0.45, 0.85, 1.0]);
    this.LP.fill(0); this.LC.fill(0);
    (p.lights || []).slice(0, MAX_LIGHTS).forEach((L, i) => {
      if (!L) return;
      this.LP.set([L.x, L.y, L.z, L.r], i * 4); this.LC.set([L.color[0], L.color[1], L.color[2], L.shadow === false ? 1 : 2], i * 4);
    });
    const s = p.spot; gl.uniform4f(u.uSpot, s ? s[0] : 0, s ? s[1] : 0, s ? s[2] : 0, s ? s[3] : -2);
    gl.uniform4fv(u.uLP, this.LP); gl.uniform4fv(u.uLC, this.LC);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
