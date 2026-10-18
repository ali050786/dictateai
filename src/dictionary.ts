import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const DICT_PATH = path.join(os.homedir(), '.dictateai', 'dictionary.json');

interface DictionaryEntry {
  from: string;
  to: string;
  count: number;
  lastUsed: string;
}

interface Dictionary {
  replacements: DictionaryEntry[];
}

let cached: Dictionary | null = null;

function ensureDir(): void {
  const dir = path.dirname(DICT_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

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
  ensureDir();
  fs.writeFileSync(DICT_PATH, JSON.stringify(dict, null, 2));
}

export function addCorrection(original: string, corrected: string): void {
  if (!original || !corrected || original === corrected) return;

  const dict = load();
  const normalizedFrom = original.toLowerCase().trim();
  const existing = dict.replacements.find(
    (r) => r.from.toLowerCase() === normalizedFrom,
  );

  if (existing) {
    existing.to = corrected.trim();
    existing.count += 1;
    existing.lastUsed = new Date().toISOString();
  } else {
    dict.replacements.push({
      from: original.trim(),
      to: corrected.trim(),
      count: 1,
      lastUsed: new Date().toISOString(),
    });
  }

  save(dict);
  console.log(`[DictateAI] Dictionary: "${original}" → "${corrected}"`);
}

export function applyReplacements(text: string): string {
  const dict = load();
  if (dict.replacements.length === 0) return text;

  let result = text;
  for (const entry of dict.replacements) {
    const pattern = new RegExp(
      `\\b${escapeRegex(entry.from)}\\b`,
      'gi',
    );
    result = result.replace(pattern, entry.to);
  }

  if (result !== text) {
    console.log(`[DictateAI] Dictionary applied: "${text}" → "${result}"`);
  }

  return result;
}

export function getRecentCorrections(limit = 20): DictionaryEntry[] {
  const dict = load();
  return dict.replacements
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

export function getCorrectionsPrompt(): string {
  const corrections = getRecentCorrections(10);
  if (corrections.length === 0) return '';

  const lines = corrections.map((c) => `"${c.from}" → "${c.to}"`);
  return `\nThe user has these preferred spellings and corrections — always apply them:\n${lines.join('\n')}`;
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

export function detectCorrections(
  injectedText: string,
  currentFieldText: string,
): void {
  if (!injectedText || !currentFieldText) return;

  const injectedWords = injectedText.split(/\s+/);
  const currentWords = currentFieldText.split(/\s+/);

  const injectedLower = injectedText.toLowerCase();
  const startIdx = currentFieldText.toLowerCase().indexOf(injectedLower);
  if (startIdx === -1) {
    const correctedRegion = findCorrectedRegion(
      injectedText,
      currentFieldText,
    );
    if (correctedRegion) {
      addCorrection(correctedRegion.original, correctedRegion.corrected);
    }
    return;
  }

  const actualText = currentFieldText.slice(
    startIdx,
    startIdx + injectedText.length,
  );
  if (actualText !== injectedText) {
    const origWords = injectedText.split(/\s+/);
    const newWords = actualText.split(/\s+/);
    for (let i = 0; i < Math.min(origWords.length, newWords.length); i++) {
      if (
        origWords[i] !== newWords[i] &&
        origWords[i].toLowerCase() === newWords[i].toLowerCase()
      ) {
        addCorrection(origWords[i], newWords[i]);
      }
    }
  }
}

function findCorrectedRegion(
  original: string,
  current: string,
): { original: string; corrected: string } | null {
  const origWords = original.split(/\s+/);
  const currWords = current.split(/\s+/);

  for (let i = 0; i < Math.min(origWords.length, currWords.length); i++) {
    if (origWords[i] !== currWords[i]) {
      return { original: origWords[i], corrected: currWords[i] };
    }
  }

  return null;
}
