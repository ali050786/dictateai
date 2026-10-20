// Synthesises the dictation start/stop cues into assets/sounds/*.wav.
// Run: node scripts/build-sounds.mjs
//
// start.wav: a short, bright "ting" that glides up into E6, like a glass tap.
// stop.wav:  softer and lower, gliding down: the dictation is done.
// Both are short so the start cue is over before the user starts speaking,
// and quiet enough not to startle (peaks around -12 and -17 dBFS).
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SAMPLE_RATE = 44100;
const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'assets',
  'sounds',
);

// partials: [frequency multiple, relative level, decay time constant in s]
function tone({ seconds, from, to, glide, peak, attack, partials }) {
  const samples = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  const phases = partials.map(() => 0);
  for (let i = 0; i < samples.length; i++) {
    const t = i / SAMPLE_RATE;
    // Exponential pitch glide over the first `glide` seconds.
    const progress = Math.min(1, t / glide);
    const freq = from * Math.pow(to / from, 1 - Math.pow(1 - progress, 3));
    let value = 0;
    partials.forEach(([multiple, level, decay], p) => {
      phases[p] += (2 * Math.PI * freq * multiple) / SAMPLE_RATE;
      value += level * Math.exp(-t / decay) * Math.sin(phases[p]);
    });
    const fadeIn = Math.min(1, t / attack);
    // Short fade at the very end so the file never ends on a click.
    const fadeOut = Math.min(1, (samples.length - i) / (0.012 * SAMPLE_RATE));
    samples[i] = value * fadeIn * fadeOut;
  }
  const max = samples.reduce((m, s) => Math.max(m, Math.abs(s)), 0);
  return samples.map((s) => (s / max) * peak);
}

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) =>
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), i * 2),
  );
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const start = tone({
  seconds: 0.14,
  from: 1175, // D6
  to: 1319, // E6
  glide: 0.025,
  peak: 0.25,
  attack: 0.003,
  partials: [
    [1, 1, 0.035],
    [2, 0.18, 0.02],
    [3, 0.05, 0.012],
  ],
});

const stop = tone({
  seconds: 0.14,
  from: 880, // A5
  to: 698, // F5
  glide: 0.05,
  peak: 0.14,
  attack: 0.006,
  partials: [
    [1, 1, 0.04],
    [2, 0.1, 0.02],
  ],
});

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'start.wav'), wav(start));
writeFileSync(join(OUT, 'stop.wav'), wav(stop));
console.log(`Wrote ${join(OUT, 'start.wav')} and stop.wav`);
