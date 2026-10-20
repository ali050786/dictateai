// Timing of the start and stop sounds (assets/sounds, made by
// scripts/build-sounds.mjs). renderer.ts plays them; main.ts orders them
// around muting system audio.

// start.wav lasts 140 ms. Muting waits this long so it doesn't cut it off.
export const START_CUE_MS = 220;

// A press shorter than this is a tap (the first of a double or triple tap).
// It records nothing, so it gets no stop sound.
export const TAP_MS = 250;

// Never drop more than this from the start of a recording, whatever the
// output latency claims, so a quick talker's first word survives.
const MAX_SKIP_MS = 300;

// How many microphone samples to drop when capture starts, so the start
// sound isn't recorded and transcribed: whatever of it is still playing
// (`audibleUntil`, a performance.now() time), plus `marginMs` for the
// microphone's own latency and the room's echo. Measured on a MacBook Air's
// speakers and microphone, the microphone runs 40-80 ms behind what the
// output reports, so smaller margins let the sound's tail through.
export function samplesToSkip(
  audibleUntil: number,
  now: number,
  sampleRate: number,
  marginMs = 100,
): number {
  const remainingMs = audibleUntil + marginMs - now;
  if (!(remainingMs > 0)) return 0;
  return Math.round((Math.min(remainingMs, MAX_SKIP_MS) / 1000) * sampleRate);
}
