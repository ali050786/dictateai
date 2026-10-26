import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canTranscribe, pickSpeechModel, speechModelFor, type SpeechModelKey } from '../src/speech-models.ts';

const onDisk = (...keys: SpeechModelKey[]) => (key: SpeechModelKey) => keys.includes(key);

test('Automatic uses Phonon for English, auto-detect and its other languages', () => {
  assert.equal(speechModelFor('auto', 'en', true), 'phonon2');
  assert.equal(speechModelFor('auto', 'auto', true), 'phonon25');
  assert.equal(speechModelFor('auto', 'de', true), 'phonon25');
  assert.equal(speechModelFor('auto', 'uk', true), 'phonon25');
});

test('Automatic uses Whisper Turbo for languages Phonon does not know', () => {
  for (const lang of ['hi', 'ar', 'ja', 'zh', 'tr', 'ur', 'mr']) {
    assert.equal(speechModelFor('auto', lang, true), 'accurate', lang);
  }
});

test('a Whisper choice applies to every language', () => {
  assert.equal(speechModelFor('fast', 'en', true), 'fast');
  assert.equal(speechModelFor('accurate', 'de', true), 'accurate');
});

test('without the Phonon engine, Automatic picks Whisper as before', () => {
  assert.equal(speechModelFor('auto', 'en', false), 'fast');
  assert.equal(speechModelFor('auto', 'de', false), 'accurate');
  assert.equal(speechModelFor('auto', 'auto', false), 'accurate');
});

test('Phonon-2 is English only; Phonon-2.5 does not hear Hindi', () => {
  assert.equal(canTranscribe('phonon2', 'en'), true);
  assert.equal(canTranscribe('phonon2', 'auto'), false);
  assert.equal(canTranscribe('phonon2', 'de'), false);
  assert.equal(canTranscribe('phonon25', 'auto'), true);
  assert.equal(canTranscribe('phonon25', 'hi'), false);
  assert.equal(canTranscribe('accurate', 'hi'), true);
});

test('runs the wanted model once it is on disk', () => {
  assert.equal(pickSpeechModel('phonon2', 'en', onDisk('phonon2', 'fast')), 'phonon2');
});

test('keeps dictation working on a model that is on disk while the wanted one downloads', () => {
  assert.equal(pickSpeechModel('phonon2', 'en', onDisk('accurate', 'fast')), 'accurate');
  assert.equal(pickSpeechModel('phonon2', 'en', onDisk('phonon25', 'accurate')), 'phonon25');
  assert.equal(pickSpeechModel('phonon25', 'de', onDisk('fast')), 'fast');
});

test('never falls back to a Phonon model that cannot hear the language', () => {
  assert.equal(pickSpeechModel('accurate', 'hi', onDisk('phonon2', 'phonon25')), 'accurate');
  assert.equal(pickSpeechModel('phonon25', 'auto', onDisk('phonon2', 'fast')), 'fast');
});

test('with nothing on disk, the wanted model (the server downloads it)', () => {
  assert.equal(pickSpeechModel('phonon2', 'en', onDisk()), 'phonon2');
});
