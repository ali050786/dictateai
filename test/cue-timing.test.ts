import { test } from 'node:test';
import assert from 'node:assert/strict';
import { samplesToSkip, START_CUE_MS, TAP_MS } from '../src/cue-timing.ts';

test('drops what is left of the start sound plus a margin', () => {
  // Sound audible for another 100 ms, 100 ms margin, 16 kHz → 200 ms of samples
  assert.equal(samplesToSkip(1100, 1000, 16000), 3200);
  assert.equal(samplesToSkip(1100, 1000, 16000, 0), 1600);
});

test('drops nothing once the sound has faded', () => {
  assert.equal(samplesToSkip(1000, 1100, 16000), 0);
  assert.equal(samplesToSkip(1000, 5000, 16000), 0);
  // No sound played yet
  assert.equal(samplesToSkip(0, 1000, 16000), 0);
});

test('never drops more than 300 ms, so the first word survives', () => {
  assert.equal(samplesToSkip(10_000, 1000, 16000), 4800);
});

test('muting waits at least as long as start.wav plays', () => {
  assert.ok(START_CUE_MS >= 140);
  assert.ok(TAP_MS > 0);
});
