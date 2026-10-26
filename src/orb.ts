// The pill's orb, with the voice wave inside it, drawn on a canvas. Nothing
// here touches Electron, so the look can be previewed in a plain browser page.

export type OrbMood = 'listening' | 'thinking' | 'done' | 'alert' | 'calm';

type RGB = [number, number, number];

// Light swirling inside the orb, Siri-like: cyan, blue, violet, pink.
const PALETTES: Record<OrbMood, RGB[]> = {
  listening: [[64, 200, 255], [70, 110, 255], [160, 90, 255], [255, 80, 190]],
  thinking: [[64, 200, 255], [70, 110, 255], [160, 90, 255], [255, 80, 190]],
  done: [[50, 220, 160], [64, 200, 255], [120, 230, 140], [70, 150, 255]],
  alert: [[255, 160, 60], [255, 90, 80], [255, 200, 90], [235, 70, 110]],
  calm: [[90, 170, 235], [100, 120, 225], [140, 110, 225], [200, 120, 205]],
};

// How fast the light turns, per mood (radians a second at rest).
const SPIN: Record<OrbMood, number> = { listening: 0.9, thinking: 2.6, done: 1.2, alert: 0.5, calm: 0.5 };

const clamp = (v: number) => Math.min(1, Math.max(0, v));

// Sizes a canvas's backing store to its CSS size at the screen's density.
function fit(canvas: HTMLCanvasElement): number {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return dpr;
}

export class Orb {
  // Reduced motion: the light and the wave move slowly.
  slow = false;
  private readonly ctx: CanvasRenderingContext2D;
  private mood: OrbMood = 'calm';
  private colors: RGB[] = PALETTES.calm.map((c) => [...c] as RGB);
  private target = 0;
  // The voice level after smoothing: rises fast, falls slowly.
  private level = 0;
  private spin = 0;
  private wavePhase = 0;
  private last = 0;
  private doneAt = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  setMood(mood: OrbMood): void {
    if (mood === 'done' && this.mood !== 'done') this.doneAt = performance.now();
    this.mood = mood;
  }

  // 0 (silence) to 1 (loud), from the microphone.
  setLevel(level: number): void {
    this.target = clamp(level);
  }

  // How lively the orb is right now, 0 to 1; its size, glow and wave follow it.
  private energy(now: number): number {
    switch (this.mood) {
      case 'listening': return this.level;
      case 'thinking': return 0.3 + 0.12 * Math.sin(now / 260);
      case 'done': return 0.55 * Math.exp(-(now - this.doneAt) / 350);
      default: return 0.08;
    }
  }

  frame(now: number): void {
    const dt = this.last ? Math.min(0.05, (now - this.last) / 1000) : 0;
    this.last = now;
    const rate = this.target > this.level ? 0.45 : 0.1;
    this.level += (this.target - this.level) * rate;
    // Colours ease towards the mood's palette instead of jumping.
    const goal = PALETTES[this.mood];
    this.colors.forEach((c, i) => {
      for (let k = 0; k < 3; k++) c[k] += (goal[i][k] - c[k]) * Math.min(1, dt * 6);
    });
    const e = this.energy(now);
    this.spin += dt * SPIN[this.mood] * (1 + e * 2.5) * (this.slow ? 0.25 : 1);
    this.wavePhase += dt * (2.5 + e * 6) * (this.slow ? 0.25 : 1);
    this.draw(e);
  }

  private draw(e: number): void {
    const dpr = fit(this.canvas);
    const { ctx } = this;
    const size = this.canvas.width;
    const c = size / 2;
    // The canvas leaves room around the orb for its glow and for swelling.
    const R = size * 0.3 * (1 + 0.14 * e);
    ctx.clearRect(0, 0, size, size);

    // Glow, in the colours of the light inside.
    const [r, g, b] = this.mix();
    const glow = ctx.createRadialGradient(c, c, R * 0.7, c, c, size / 2);
    glow.addColorStop(0, `rgba(${r},${g},${b},${0.35 + 0.4 * e})`);
    glow.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, size, size);

    ctx.save();
    ctx.beginPath();
    ctx.arc(c, c, R, 0, Math.PI * 2);
    ctx.clip();

    // Dark glass body.
    const body = ctx.createRadialGradient(c - R * 0.3, c - R * 0.35, R * 0.1, c, c, R);
    body.addColorStop(0, 'rgb(36, 40, 86)');
    body.addColorStop(1, 'rgb(8, 8, 26)');
    ctx.fillStyle = body;
    ctx.fillRect(0, 0, size, size);

    // Swirling light: blobs orbiting in opposite directions, added together.
    ctx.globalCompositeOperation = 'lighter';
    this.colors.forEach(([cr, cg, cb], i) => {
      const angle = this.spin * (0.6 + i * 0.23) * (i % 2 ? -1 : 1) + i * 1.7;
      const orbit = R * (0.3 + 0.14 * Math.sin(this.spin * 0.7 + i * 2.1));
      const x = c + Math.cos(angle) * orbit;
      const y = c + Math.sin(angle) * orbit;
      const radius = R * (0.62 + 0.3 * e + 0.08 * Math.sin(this.spin * 1.3 + i));
      const blob = ctx.createRadialGradient(x, y, 0, x, y, radius);
      blob.addColorStop(0, `rgba(${cr | 0},${cg | 0},${cb | 0},0.72)`);
      blob.addColorStop(0.45, `rgba(${cr | 0},${cg | 0},${cb | 0},0.26)`);
      blob.addColorStop(1, `rgba(${cr | 0},${cg | 0},${cb | 0},0)`);
      ctx.fillStyle = blob;
      ctx.fillRect(0, 0, size, size);
    });

    ctx.globalCompositeOperation = 'source-over';
    this.drawWave(c, R, e);

    // Glass: a soft highlight up top, the edge darkened for depth.
    const hx = c - R * 0.32;
    const hy = c - R * 0.45;
    const shine = ctx.createRadialGradient(hx, hy, 0, hx, hy, R * 0.75);
    shine.addColorStop(0, 'rgba(255,255,255,0.5)');
    shine.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = shine;
    ctx.fillRect(0, 0, size, size);
    const edge = ctx.createRadialGradient(c, c, R * 0.72, c, c, R);
    edge.addColorStop(0, 'rgba(0,0,20,0)');
    edge.addColorStop(1, 'rgba(0,0,20,0.4)');
    ctx.fillStyle = edge;
    ctx.fillRect(0, 0, size, size);
    ctx.restore();

    ctx.beginPath();
    ctx.arc(c, c, R - dpr * 0.5, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = dpr;
    ctx.stroke();
  }

  // The voice: one glowing wave across the orb, as in the app icon. As tall
  // as the voice is loud; nearly flat in silence, so it still reads as
  // listening.
  private drawWave(c: number, R: number, e: number): void {
    const { ctx } = this;
    const x0 = c - R * 0.8;
    const x1 = c + R * 0.8;
    const amp = R * (0.04 + 0.42 * e);
    ctx.beginPath();
    for (let i = 0; i <= 48; i++) {
      const t = (i / 48) * 4 - 2;
      // Full height in the middle, none at the ends.
      const envelope = Math.pow(4 / (4 + t ** 4), 2);
      const x = x0 + ((x1 - x0) * i) / 48;
      const y = c - amp * envelope * Math.sin(3.2 * t + this.wavePhase);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    // Its ends fade into the orb.
    const fade = ctx.createLinearGradient(x0, 0, x1, 0);
    fade.addColorStop(0, 'rgba(255,255,255,0)');
    fade.addColorStop(0.24, '#fff');
    fade.addColorStop(0.76, '#fff');
    fade.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.strokeStyle = fade;
    ctx.lineWidth = R * 0.09;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(255,255,255,0.9)';
    ctx.shadowBlur = R * 0.3;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  private mix(): RGB {
    const sum = this.colors.reduce<RGB>((acc, c) => [acc[0] + c[0], acc[1] + c[1], acc[2] + c[2]], [0, 0, 0]);
    return sum.map((v) => Math.round(v / this.colors.length)) as RGB;
  }
}
