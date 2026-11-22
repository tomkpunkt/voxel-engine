// Freie Kamera für Sprite-Stacking: Drehung (yaw) beliebig, Neigung (pitch) zwischen flach und senkrecht, Zoom.
// DOM-frei. Abbildung Welt → Bildschirm ist affin plus Höhenversatz:
//   (sx, sy) = M · (x, y)  −  (0, z · dzu)
// mit M = T(Mitte) · S(zoom, zoom · sin pitch) · R(yaw) · T(−Ziel) und dzu = zoom · cos pitch.
// Die Tiefe hängt nur von z ab: An derselben Bildschirmstelle hat ein Objekt weiter vorn immer das größere z.

export class Mat2D {
  constructor(a = 1, b = 0, c = 0, d = 1, e = 0, f = 0) { this.a = a; this.b = b; this.c = c; this.d = d; this.e = e; this.f = f; }
  mul(m) {
    return new Mat2D(this.a * m.a + this.c * m.b, this.b * m.a + this.d * m.b, this.a * m.c + this.c * m.d,
      this.b * m.c + this.d * m.d, this.a * m.e + this.c * m.f + this.e, this.b * m.e + this.d * m.f + this.f);
  }
  translate(x, y) { return this.mul(new Mat2D(1, 0, 0, 1, x, y)); }
  scale(sx, sy = sx) { return this.mul(new Mat2D(sx, 0, 0, sy, 0, 0)); }
  rotate(r) { const c = Math.cos(r), s = Math.sin(r); return this.mul(new Mat2D(c, s, -s, c, 0, 0)); }
  inverse() {
    const det = this.a * this.d - this.b * this.c;
    return new Mat2D(this.d / det, -this.b / det, -this.c / det, this.a / det,
      (this.c * this.f - this.d * this.e) / det, (this.b * this.e - this.a * this.f) / det);
  }
  apply(x, y) { return [this.a * x + this.c * y + this.e, this.b * x + this.d * y + this.f]; }
  /** Spaltenweise 3×3 für WebGL. */
  mat3() { return [this.a, this.b, 0, this.c, this.d, 0, this.e, this.f, 1]; }
}

const DEG = Math.PI / 180;

export class Camera {
  constructor(o = {}) {
    this.x = o.x ?? 0; this.y = o.y ?? 0;
    this.yaw = o.yaw ?? Math.PI / 4; this.pitch = o.pitch ?? 52 * DEG; this.zoom = o.zoom ?? 8;
    this.minPitch = o.minPitch ?? 30 * DEG; this.maxPitch = o.maxPitch ?? 88 * DEG;
    this.minZoom = o.minZoom ?? 2; this.maxZoom = o.maxZoom ?? 24;
    this.anchorY = o.anchorY ?? 0.5;       // Ziel liegt bei dieser Bildschirmhöhe
    this.lift = o.lift ?? 5;               // Ziel wird um diese Höhe angehoben (Figurenmitte)
    // Zielwerte, denen die Kamera weich folgt
    this.target = { x: this.x, y: this.y, yaw: this.yaw, pitch: this.pitch, zoom: this.zoom };
    this.shake = { x: 0, y: 0, a: 0, t: 9 };
    this.width = 1; this.height = 1;
    this.update(0);
  }
  setSize(w, h) { this.width = w; this.height = h; this.update(0); }
  rotate(d) { this.target.yaw += d; }
  tilt(d) { this.target.pitch = Math.min(this.maxPitch, Math.max(this.minPitch, this.target.pitch + d)); }
  zoomBy(f) { this.target.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, this.target.zoom * f)); }
  follow(x, y) { this.target.x = x; this.target.y = y; }
  /** Sofort auf das Ziel springen. */
  snap() { Object.assign(this, { x: this.target.x, y: this.target.y, yaw: this.target.yaw, pitch: this.target.pitch, zoom: this.target.zoom }); this.update(0); }
  kick(dx, dy, a) { if (a >= this.shake.a * Math.pow(0.002, this.shake.t)) this.shake = { x: dx, y: dy, a, t: 0 }; }

  /** Weich nachführen und Matrizen neu rechnen. */
  update(dt) {
    const T = this.target;
    if (dt > 0) {
      const f = 1 - Math.pow(0.004, dt), g = 1 - Math.pow(0.0005, dt);
      this.x += (T.x - this.x) * f; this.y += (T.y - this.y) * f;
      this.yaw += (T.yaw - this.yaw) * g; this.pitch += (T.pitch - this.pitch) * g;
      this.zoom *= Math.pow(T.zoom / this.zoom, g);
      this.shake.t += dt;
    }
    const s = this.shake, so = s.a * Math.pow(0.002, s.t) * Math.cos(s.t * 50);
    this.dzu = this.zoom * Math.cos(this.pitch);
    this.M = new Mat2D().translate(this.width / 2 + s.x * so, this.height * this.anchorY + this.lift * this.dzu + s.y * so)
      .scale(this.zoom, this.zoom * Math.sin(this.pitch)).rotate(this.yaw).translate(-this.x, -this.y);
    this.Minv = this.M.inverse();
  }
  /** Weltpunkt → Bildschirm (Pixel des Zeichenpuffers). */
  project(x, y, z = 0) { const [sx, sy] = this.M.apply(x, y); return [sx, sy - z * this.dzu]; }
  /** Bildschirmpunkt → Weltpunkt auf Höhe z. */
  unproject(sx, sy, z = 0) { return this.Minv.apply(sx, sy + z * this.dzu); }
  /** Richtung auf dem Bildschirm (z. B. Stick) → normierte Richtung in der Welt. */
  dirToWorld(dx, dy) {
    const m = this.Minv, wx = m.a * dx + m.c * dy, wy = m.b * dx + m.d * dy, l = Math.hypot(wx, wy) || 1;
    return [wx / l, wy / l];
  }
  onScreen(x, y, margin = 80) {
    const [sx, sy] = this.M.apply(x, y);
    return sx > -margin && sx < this.width + margin && sy > -margin && sy < this.height + margin * 2;
  }
  /** Sichtbares Welt-Rechteck auf Bodenhöhe (achsparallel), um Kacheln auszuwählen. */
  groundBounds(zTop = 32) {
    const pts = [[0, 0], [this.width, 0], [0, this.height], [this.width, this.height]];
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const [sx, sy] of pts) for (const z of [0, zTop]) {
      const [x, y] = this.unproject(sx, sy, z);
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    return [x0, y0, x1, y1];
  }
}
