import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR, writePrivateFile } from './config';
import { redact } from './log';

const DICT_PATH = path.join(DATA_DIR, 'dictionary.json');

interface DictionaryEntry {
  from: string;
  to: string;
  count: number;
  lastUsed: string;
  // Added or kept by the user in the Dictionary tab; applies immediately.
  manual?: boolean;
}

// A correction learned from the user's edits applies only once they've made
// the same fix this many times, so a one-off rewrite ("free" → "paid") never
// becomes a rule.
const LEARN_THRESHOLD = 2;

function isActive(entry: DictionaryEntry): boolean {
  return entry.manual === true || entry.count >= LEARN_THRESHOLD;
}

interface Dictionary {
  replacements: DictionaryEntry[];
}

let cached: Dictionary | null = null;

function load(): Dictionary {
  if (cached) return cached;
  try {
    if (fs.existsSync(DICT_PATH)) {
      cached = JSON.parse(fs.readFileSync(DICT_PATH, 'utf-8'));
      return cached!;
    }
  } catch {}
  cached = { replacements: [] };
  return cached;
}

function save(dict: Dictionary): void {
  cached = dict;
  writePrivateFile(DICT_PATH, JSON.stringify(dict, null, 2));
}

export function addCorrection(original: string, corrected: string, manual = false): void {
  if (!original || !corrected || original === corrected) return;

  const dict = load();
  const normalizedFrom = original.toLowerCase().trim();
  const existing = dict.replacements.find(
    (r) => r.from.toLowerCase() === normalizedFrom,
  );

  if (existing) {
    // A different fix for the same word starts counting again.
    existing.count = existing.to === corrected.trim() ? existing.count + 1 : 1;
    existing.to = corrected.trim();
    existing.lastUsed = new Date().toISOString();
    if (manual) existing.manual = true;
  } else {
    dict.replacements.push({
      from: original.trim(),
      to: corrected.trim(),
      count: 1,
      lastUsed: new Date().toISOString(),
      ...(manual ? { manual: true } : {}),
    });
  }

  save(dict);
  console.log(`[Utter] Dictionary learned: ${redact(original)} → ${redact(corrected)}`);
}

export function applyReplacements(text: string): string {
  const dict = load();
  if (dict.replacements.length === 0) return text;

  let result = text;
  for (const entry of dict.replacements.filter(isActive)) {
    const pattern = new RegExp(
      `\\b${escapeRegex(entry.from)}\\b`,
      'gi',
    );
    result = result.replace(pattern, entry.to);
  }

  if (result !== text) {
    console.log(`[Utter] Dictionary applied: ${redact(text)} → ${redact(result)}`);
  }

  return result;
}

export function getRecentCorrections(limit = 20): DictionaryEntry[] {
  const dict = load();
  return dict.replacements
    .filter(isActive)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

export function getCorrectionsPrompt(): string {
  const corrections = getRecentCorrections(10);
  if (corrections.length === 0) return '';

  const lines = corrections.map((c) => `"${c.from}" → "${c.to}"`);
  return `\nThe user has these preferred spellings and corrections — always apply them:\n${lines.join('\n')}`;
}

// Spellings for the speech model to favour while it listens: what active
// entries correct to, the user's own entries first, then the most used.
export function getHotwords(): string[] {
  const entries = load().replacements
    .filter(isActive)
    .sort((a, b) => Number(b.manual === true) - Number(a.manual === true) || b.count - a.count);
  return [...new Set(entries.map((e) => e.to))];
}

export function removeCorrection(from: string): boolean {
  const dict = load();
  const idx = dict.replacements.findIndex(
    (r) => r.from.toLowerCase() === from.toLowerCase(),
  );
  if (idx === -1) return false;

  dict.replacements.splice(idx, 1);
  save(dict);
  return true;
}

export function getAllCorrections(): DictionaryEntry[] {
  return load().replacements;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The word without surrounding punctuation, so "the." and "the" match.
function bareWord(word: string): string {
  return word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

// Learns from a user fixing one word of what was just dictated. The field
// often holds other text too (earlier sentences, a greeting typed before
// dictating), so only the stretch of the field that lines up with the
// dictated text is compared, and only a single changed word counts.
export function detectCorrections(
  injectedText: string,
  currentFieldText: string,
): void {
  if (!injectedText || !currentFieldText) return;
  if (currentFieldText.includes(injectedText)) return;

  const injected = injectedText.split(/\s+/).filter(Boolean);
  const field = currentFieldText.split(/\s+/).filter(Boolean);
  // Too few words to tell where the dictation sits in the field.
  if (injected.length < 3) return;

  let candidate: { from: string; to: string } | null = null;
  for (let start = 0; start + injected.length <= field.length; start++) {
    let changed = -1;
    let changes = 0;
    for (let i = 0; i < injected.length && changes < 2; i++) {
      if (bareWord(injected[i]) !== bareWord(field[start + i])) {
        changed = i;
        changes++;
      }
    }
    if (changes !== 1) continue;

    const from = bareWord(injected[changed]);
    const to = bareWord(field[start + changed]);
    if (!from || !to) continue;
    // Two different places line up: ambiguous, learn nothing.
    if (candidate) return;
    candidate = { from, to };
  }

  if (candidate) addCorrection(candidate.from, candidate.to);
}
