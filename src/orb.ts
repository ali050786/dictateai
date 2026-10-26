// The pill's orb, drawn on a canvas: a small sphere in one colour family per
// state, with depth from lighter and deeper shades of that colour (no
// rainbow), a soft pool of light drifting inside, and a white wave of three
// strands that follow the voice's low, middle and high frequencies. Nothing
// here touches Electron, so the look can be previewed in a plain browser page.

export type OrbMood = 'listening' | 'thinking' | 'done' | 'alert' | 'calm';

type RGB = [number, number, number];

// Each state's shades: light (the lit side and the drifting light), base,
// deep (the far edge), and the wave.
interface Shades { light: RGB; base: RGB; deep: RGB; wave: RGB }

// Blue while listening, graphite while working, green when the text is in,
// orange for problems.
// The shades stay close together, so the orb looks softly lit rather than
// glossy.
const SHADES: Record<OrbMood, Shades> = {
  listening: { light: [150, 186, 255], base: [56, 120, 255], deep: [34, 92, 238], wave: [255, 255, 255] },
  thinking: { light: [150, 156, 170], base: [76, 81, 92], deep: [52, 56, 64], wave: [255, 255, 255] },
  done: { light: [226, 255, 216], base: [166, 251, 136], deep: [132, 226, 106], wave: [17, 17, 17] },
  alert: { light: [255, 172, 132], base: [240, 96, 40], deep: [212, 72, 20], wave: [255, 255, 255] },
  calm: { light: [150, 156, 170], base: [76, 81, 92], deep: [52, 56, 64], wave: [255, 255, 255] },
};

// How fast the wave travels, per mood (radians a second at rest).
const SPEED: Record<OrbMood, number> = { listening: 2.5, thinking: 7, done: 2, alert: 1.5, calm: 1.5 };

// Loudness in the voice's low, middle and high frequencies, 0 to 1.
export type Bands = [number, number, number];

// The wave's three strands, drawn back to front: thin and faint ones that
// follow the highs and the middle (consonants), then the main one that
// follows the lows (vowels). Each has its own wavelength and direction, so
// they part as you speak and lie together as one line in silence.
const STRANDS = [
  { band: 2, freq: 7.4, speed: 1.9, width: 0.035, alpha: 0.4, gain: 0.8 },
  { band: 1, freq: 5.2, speed: -1.4, width: 0.05, alpha: 0.6, gain: 0.9 },
  { band: 0, freq: 3.2, speed: 1, width: 0.09, alpha: 1, gain: 1 },
];

const clamp = (v: number) => Math.min(1, Math.max(0, v));
const rgb = ([r, g, b]: RGB, a = 1) => `rgba(${r | 0},${g | 0},${b | 0},${a})`;
const copy = (s: Shades): Shades => ({ light: [...s.light], base: [...s.base], deep: [...s.deep], wave: [...s.wave] });

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
  // Reduced motion: the wave and the light inside move slowly.
  slow = false;
  private readonly ctx: CanvasRenderingContext2D;
  private mood: OrbMood = 'calm';
  private shades: Shades = copy(SHADES.calm);
  private target = 0;
  // The voice level after smoothing: rises fast, falls slowly.
  private level = 0;
  private wavePhase = 0;
  private drift = 0;
  private last = 0;
  private doneAt = 0;
  // The microphone's bands; without them they're made up from the level.
  private bandsIn: Bands | null = null;
  // The bands after smoothing, one per strand.
  private bands: Bands = [0, 0, 0];

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

  // The microphone's low, middle and high bands, or null to make them up.
  setBands(bands: Bands | null): void {
    this.bandsIn = bands;
  }

  // How lively the orb is right now, 0 to 1; its size, light and wave follow it.
  private energy(now: number): number {
    switch (this.mood) {
      case 'listening': return this.level;
      case 'thinking': return 0.3 + 0.08 * Math.sin(now / 260);
      case 'done': return 0.5 * Math.exp(-(now - this.doneAt) / 350);
      default: return 0.06;
    }
  }

  frame(now: number): void {
    const dt = this.last ? Math.min(0.05, (now - this.last) / 1000) : 0;
    this.last = now;
    const rate = this.target > this.level ? 0.45 : 0.1;
    this.level += (this.target - this.level) * rate;
    // Colours change quickly but don't jump.
    const ease = Math.min(1, dt * 10);
    const goal = SHADES[this.mood];
    for (const key of ['light', 'base', 'deep', 'wave'] as const) {
      for (let k = 0; k < 3; k++) this.shades[key][k] += (goal[key][k] - this.shades[key][k]) * ease;
    }
    const e = this.energy(now);
    // Made-up bands each keep their own rhythm, so the strands don't move
    // as one when there's no microphone (or the orb isn't listening).
    const made: Bands = [
      e * (0.85 + 0.15 * Math.sin(now / 330)),
      e * (0.6 + 0.4 * Math.sin(now / 190 + 1)),
      e * (0.45 + 0.55 * Math.sin(now / 120 + 2)),
    ];
    const heard = this.mood === 'listening' && this.bandsIn ? this.bandsIn : made;
    for (let k = 0; k < 3; k++) {
      const goalBand = clamp(heard[k]);
      this.bands[k] += (goalBand - this.bands[k]) * (goalBand > this.bands[k] ? 0.5 : 0.15);
    }
    const pace = this.slow ? 0.25 : 1;
    this.wavePhase += dt * SPEED[this.mood] * (1 + e * 2) * pace;
    this.drift += dt * (0.6 + e * 1.8) * pace;
    this.draw(e);
  }

  private draw(e: number): void {
    const dpr = fit(this.canvas);
    const { ctx } = this;
    const { light, base, deep } = this.shades;
    const size = this.canvas.width;
    const c = size / 2;
    const R = size * 0.31 * (1 + 0.06 * e);
    ctx.clearRect(0, 0, size, size);

    // A faint halo in the orb's own colour, stronger as the voice gets louder.
    const halo = ctx.createRadialGradient(c, c, R * 0.9, c, c, R * 1.55);
    halo.addColorStop(0, rgb(base, 0.16 + 0.24 * e));
    halo.addColorStop(1, rgb(base, 0));
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, size, size);

    // A thin translucent ring that moves out with the voice while listening.
    if (this.mood === 'listening' && !this.slow) {
      ctx.beginPath();
      ctx.arc(c, c, R * (1.08 + 0.22 * e), 0, Math.PI * 2);
      ctx.strokeStyle = rgb(light, 0.18 + 0.4 * e);
      ctx.lineWidth = dpr;
      ctx.stroke();
    }

    ctx.save();
    ctx.beginPath();
    ctx.arc(c, c, R, 0, Math.PI * 2);
    ctx.clip();

    // The sphere, softly lit from above and slightly see-through: matte, with
    // no glossy highlight or hard rim.
    const body = ctx.createRadialGradient(c - R * 0.2, c - R * 0.3, R * 0.1, c, c, R);
    body.addColorStop(0, rgb(light, 0.94));
    body.addColorStop(0.7, rgb(base, 0.92));
    body.addColorStop(1, rgb(deep, 0.92));
    ctx.fillStyle = body;
    ctx.fillRect(0, 0, size, size);

    // A pool of lighter colour drifting inside, brighter as the voice rises.
    const px = c + Math.cos(this.drift) * R * 0.35;
    const py = c + Math.sin(this.drift * 0.8) * R * 0.3;
    const pool = ctx.createRadialGradient(px, py, 0, px, py, R * (0.55 + 0.25 * e));
    pool.addColorStop(0, rgb(light, 0.22 + 0.3 * e));
    pool.addColorStop(1, rgb(light, 0));
    ctx.fillStyle = pool;
    ctx.fillRect(0, 0, size, size);

    this.drawWave(c, R);
    ctx.restore();
  }

  // The strands, each full height in the middle and none at the ends;
  // nearly flat in silence, so the orb still reads as listening.
  private drawWave(c: number, R: number): void {
    const { ctx } = this;
    const x0 = c - R * 0.62;
    const x1 = c + R * 0.62;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    STRANDS.forEach((strand, k) => {
      const amp = R * (0.04 + 0.42 * this.bands[strand.band] * strand.gain);
      const phase = this.wavePhase * strand.speed + k * 1.3;
      ctx.beginPath();
      for (let i = 0; i <= 64; i++) {
        const t = (i / 64) * 4 - 2;
        const envelope = Math.pow(4 / (4 + t ** 4), 2);
        const x = x0 + ((x1 - x0) * i) / 64;
        const y = c - amp * envelope * Math.sin(strand.freq * t + phase);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = rgb(this.shades.wave, strand.alpha);
      ctx.lineWidth = R * strand.width;
      ctx.stroke();
    });
  }
}
