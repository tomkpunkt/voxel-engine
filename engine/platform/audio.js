// Synthetische Töne über Web Audio: gefiltertes Rauschen und Oszillator-Sweeps. Keine Audiodateien nötig.

export class Synth {
  constructor(volume = 0.55) { this.ctx = null; this.master = null; this.volume = volume; }
  /** Muss nach einer Nutzereingabe aufgerufen werden (Autoplay-Regeln). */
  init() {
    if (this.ctx) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain(); this.master.gain.value = this.volume; this.master.connect(this.ctx.destination);
    } catch (e) { this.ctx = null; }
  }
  noise(dur, f, q, g, type = 'lowpass', when = 0) {
    const A = this.ctx; if (!A || g < 0.01) return;
    const t = A.currentTime + when, len = Math.ceil(A.sampleRate * dur), buf = A.createBuffer(1, len, A.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
    const src = A.createBufferSource(); src.buffer = buf;
    const fl = A.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q;
    const gn = A.createGain(); gn.gain.setValueAtTime(g, t); gn.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(fl).connect(gn).connect(this.master); src.start(t);
  }
  tone(f0, f1, dur, type, g, when = 0, lp = 0) {
    const A = this.ctx; if (!A || g < 0.01) return;
    const t = A.currentTime + when, o = A.createOscillator(), gn = A.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    gn.gain.setValueAtTime(g, t); gn.gain.exponentialRampToValueAtTime(0.001, t + dur);
    let node = o.connect(gn);
    if (lp) { const fl = A.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = lp; node = gn.connect(fl); }
    node.connect(this.master); o.start(t); o.stop(t + dur + 0.05);
  }
}
