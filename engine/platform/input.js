// Eingabe: Tastatur, Maus, zwei schwebende Touch-Sticks und Kamera-Gesten.
//   Maus: rechte oder mittlere Taste ziehen = Kamera drehen (waagerecht) und neigen (senkrecht), Rad = Zoom
//   Touch: linke Bildhälfte = linker Stick, rechte = rechter Stick; ein Kamera-Griff (Element) dreht und neigt beim Ziehen
//   Tastatur: Q/E-ähnliche Belegungen macht das Spiel selbst über input.keys

export class Input {
  /**
   * @param {HTMLElement} el   Fläche für Zeiger-Ereignisse (meist eine Leinwand über allem)
   * @param {object} [o]
   * @param {(dyaw:number, dpitch:number, zoomFactor:number) => void} [o.onCamera]
   * @param {HTMLElement} [o.cameraHandle]   Touch-Griff zum Drehen/Neigen
   * @param {() => void} [o.onCameraTap]     kurzes Antippen des Griffs
   * @param {() => void} [o.onFirstInput]    z. B. Audio entsperren
   * @param {number} [o.stickRadius]
   */
  constructor(el, o = {}) {
    this.el = el; this.o = o;
    this.keys = new Set();
    this.mouse = { x: 0, y: 0, down: false, active: false };
    this.sticks = { L: this.stick(), R: this.stick() };
    this.radius = o.stickRadius ?? 55;
    this.touch = matchMedia('(pointer: coarse)').matches;
    this.enabled = true;
    this.camDrag = null;
    const first = () => o.onFirstInput && o.onFirstInput();
    el.addEventListener('pointerdown', e => {
      first();
      if (e.pointerType === 'touch') {
        this.touch = true;
        const s = e.clientX < innerWidth / 2 ? this.sticks.L : this.sticks.R;
        if (s.id !== null || !this.enabled) return;
        try { el.setPointerCapture(e.pointerId); } catch (err) { /* synthetische Zeiger */ }
        Object.assign(s, { id: e.pointerId, bx: e.clientX, by: e.clientY, x: e.clientX, y: e.clientY, dx: 0, dy: 0 });
      } else {
        this.mouse.active = true; this.mouse.x = e.clientX; this.mouse.y = e.clientY;
        if (e.button === 0) this.mouse.down = true;
        if (e.button === 1 || e.button === 2) { this.camDrag = { x: e.clientX, y: e.clientY }; e.preventDefault(); }
      }
    });
    el.addEventListener('pointermove', e => {
      if (e.pointerType === 'touch') { for (const s of [this.sticks.L, this.sticks.R]) if (s.id === e.pointerId) this.moveStick(s, e.clientX, e.clientY); return; }
      this.mouse.x = e.clientX; this.mouse.y = e.clientY; this.mouse.active = true;
      if (this.camDrag) {
        this.cam((e.clientX - this.camDrag.x) * 0.008, -(e.clientY - this.camDrag.y) * 0.006, 1);
        this.camDrag.x = e.clientX; this.camDrag.y = e.clientY;
      }
    });
    const up = e => {
      if (e.pointerType === 'touch') { for (const s of [this.sticks.L, this.sticks.R]) if (s.id === e.pointerId) { s.id = null; s.dx = s.dy = 0; } }
      else { if (e.button === 0) this.mouse.down = false; if (e.button === 1 || e.button === 2) this.camDrag = null; }
    };
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    el.addEventListener('contextmenu', e => e.preventDefault());
    el.addEventListener('wheel', e => { e.preventDefault(); this.cam(0, 0, e.deltaY < 0 ? 1.1 : 0.9); }, { passive: false });
    addEventListener('keydown', e => { first(); if (!e.repeat) this.keys.add(e.key.toLowerCase()); });
    addEventListener('keyup', e => this.keys.delete(e.key.toLowerCase()));
    addEventListener('blur', () => this.reset());
    // Browser-Zoom und Doppeltipp verhindern (außer in Panels/Bildschirmen mit Klasse panel/screen)
    for (const ev of ['touchstart', 'touchmove', 'touchend', 'gesturestart', 'gesturechange', 'dblclick'])
      addEventListener(ev, e => { if (!e.target.closest || !e.target.closest('.panel,.screen')) e.preventDefault(); }, { capture: true, passive: false });
    if (o.cameraHandle) this.bindCameraHandle(o.cameraHandle);
  }
  stick() { return { id: null, bx: 0, by: 0, x: 0, y: 0, dx: 0, dy: 0 }; }
  moveStick(s, x, y) {
    const R = this.radius;
    let vx = x - s.bx, vy = y - s.by, l = Math.hypot(vx, vy);
    if (l > R) { s.bx += vx * (l - R) / l; s.by += vy * (l - R) / l; vx = x - s.bx; vy = y - s.by; }
    s.x = x; s.y = y; s.dx = vx / R; s.dy = vy / R;
  }
  cam(dyaw, dpitch, zf) { if (this.o.onCamera) this.o.onCamera(dyaw, dpitch, zf); }
  bindCameraHandle(h) {
    let st = null;
    h.addEventListener('pointerdown', e => {
      e.preventDefault(); e.stopPropagation();
      try { h.setPointerCapture(e.pointerId); } catch (err) { /* */ }
      st = { id: e.pointerId, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t: performance.now() };
    });
    h.addEventListener('pointermove', e => {
      if (!st || e.pointerId !== st.id) return;
      this.cam((e.clientX - st.x) * 0.01, -(e.clientY - st.y) * 0.008, 1);
      st.x = e.clientX; st.y = e.clientY;
    });
    const end = e => {
      if (!st || e.pointerId !== st.id) return;
      if (Math.hypot(e.clientX - st.x0, e.clientY - st.y0) < 8 && performance.now() - st.t < 350 && this.o.onCameraTap) this.o.onCameraTap();
      st = null;
    };
    h.addEventListener('pointerup', end); h.addEventListener('pointercancel', end);
  }
  reset() {
    this.keys.clear(); this.mouse.down = false; this.camDrag = null;
    for (const s of [this.sticks.L, this.sticks.R]) { s.id = null; s.dx = s.dy = 0; }
  }
  /** Tastenrichtung aus WASD/Pfeilen als [x, y] (Bildschirm), Länge ≤ 1. */
  keyDir() {
    const k = this.keys; let x = 0, y = 0;
    if (k.has('w') || k.has('arrowup')) y -= 1; if (k.has('s') || k.has('arrowdown')) y += 1;
    if (k.has('a') || k.has('arrowleft')) x -= 1; if (k.has('d') || k.has('arrowright')) x += 1;
    const l = Math.hypot(x, y); return l > 1 ? [x / l, y / l] : [x, y];
  }
  /** Sticks auf eine 2D-Leinwand zeichnen (scale = Zeichenpuffer/CSS). */
  drawSticks(ctx, scale = 1, fireThreshold = 0.65) {
    const R = this.radius;
    for (const s of [this.sticks.L, this.sticks.R]) if (s.id !== null) {
      const bx = s.bx / scale, by = s.by / scale;
      ctx.strokeStyle = 'rgba(220,225,235,0.35)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(bx, by, R / scale, 0, 6.283); ctx.stroke();
      ctx.fillStyle = s === this.sticks.R && Math.hypot(s.dx, s.dy) > fireThreshold ? 'rgba(220,80,60,0.6)' : 'rgba(220,225,235,0.45)';
      ctx.beginPath(); ctx.arc(bx + s.dx * R / scale, by + s.dy * R / scale, 18 / scale, 0, 6.283); ctx.fill();
    }
  }
}
