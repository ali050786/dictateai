// Speech models, and which one each language uses. Nothing here touches
// Electron or the disk, so the routing is unit-tested.

export type SpeechEngine = 'phonon' | 'whisper';
export type SpeechModelKey = 'phonon2' | 'phonon25' | 'fast' | 'accurate';
// Settings: Automatic, or one of the Whisper models for every language.
export type SpeechChoice = 'auto' | 'fast' | 'accurate';

// Phonon (Fermion Research, compressed from NVIDIA's Parakeet TDT 0.6B v3)
// is smaller, faster and more accurate than Whisper in its languages: 5.21 %
// average word error on the Open ASR Leaderboard's English sets against 6.58 %
// for Whisper Large v3 Turbo, and 7.6 s of speech in about 0.2 s here.
// Whisper covers every other language. Small was fine for English, but on
// Hindi it translated into (wrong) English, while Large v3 Turbo kept it in
// Devanagari and nearly right: 0.4s vs 1.8s for a sentence.
export const SPEECH_MODELS: Record<SpeechModelKey, { engine: SpeechEngine; id: string; name: string; bytes: number }> = {
  phonon2: { engine: 'phonon', id: 'phonon-2', name: 'Phonon-2', bytes: 158_127_742 },
  phonon25: { engine: 'phonon', id: 'phonon-2.5', name: 'Phonon-2.5', bytes: 156_181_652 },
  fast: { engine: 'whisper', id: 'small', name: 'Whisper Small', bytes: 486_500_000 },
  accurate: { engine: 'whisper', id: 'large-v3-v20240930_turbo_632MB', name: 'Whisper Large v3 Turbo', bytes: 646_000_000 },
};

// Phonon-2.5's 25 languages. Phonon-2 is English only.
export const PHONON_LANGUAGES = new Set([
  'bg', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fi', 'fr', 'hr', 'hu', 'it',
  'lt', 'lv', 'mt', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'uk',
]);

// Whether a model can transcribe a language ('auto' is auto-detect, which
// Phonon-2.5 does among its own languages).
export function canTranscribe(key: SpeechModelKey, language: string): boolean {
  if (key === 'phonon2') return language === 'en';
  if (key === 'phonon25') return language === 'auto' || PHONON_LANGUAGES.has(language);
  return true;
}

// Automatic: Phonon-2 for English, Phonon-2.5 for auto-detect and its other
// languages, Whisper Large v3 Turbo for the rest (Hindi, Arabic, Japanese…).
// Without the Phonon engine, Whisper: Small for English, Turbo otherwise.
export function speechModelFor(choice: SpeechChoice, language: string, phonon: boolean): SpeechModelKey {
  if (choice !== 'auto') return choice;
  if (phonon && language === 'en') return 'phonon2';
  if (phonon && canTranscribe('phonon25', language)) return 'phonon25';
  return language === 'en' ? 'fast' : 'accurate';
}

const FALLBACKS: SpeechModelKey[] = ['phonon2', 'phonon25', 'accurate', 'fast'];

// The model to run: the wanted one if it's usable (on disk, engine present);
// otherwise a usable one that handles the language, so dictation keeps working
// while the wanted one downloads; with none (first run), the wanted one,
// which the server downloads.
export function pickSpeechModel(wanted: SpeechModelKey, language: string, usable: (key: SpeechModelKey) => boolean): SpeechModelKey {
  if (usable(wanted)) return wanted;
  return FALLBACKS.find(key => canTranscribe(key, language) && usable(key)) ?? wanted;
}
