// Basic cleanup: instant, no AI, no download. Whisper already punctuates
// and capitalizes, so this only removes what it leaves in: filler sounds
// and accidentally repeated words. It deliberately leaves "like", "you
// know" and "I mean" alone, since those can carry meaning.

// Sounds that are never words. Matched whole, any case, with a comma or
// stretched spelling ("ummm", "uhhh").
const FILLERS = [
  'u+m+', 'u+h+', 'u+h+m+', 'e+r+m+', 'e+r+', 'a+h+', 'h+m+', 'm+h+m+', 'm+m+',
  // Hindi
  'उम+्?म?', 'अं+',
];

// Words people repeat on purpose ("that that", "had had", "is is" in "what
// it is is"), so a doubled one is kept.
const KEEP_DOUBLED = new Set(['that', 'had', 'is', 'very', 'so', 'no', 'bye', 'really', 'go']);

// Letters and marks of any script, so Devanagari words count as words.
const WORD = '[\\p{L}\\p{M}\\p{N}\']+';

const fillerPattern = new RegExp(
  `(^|[\\s,.!?;:])(?:${FILLERS.join('|')})(?=$|[\\s,.!?;:])[,]?`,
  'giu',
);
const doubledPattern = new RegExp(`(?<![\\p{L}\\p{M}])(${WORD})(?:[\\s,]+\\1)+(?![\\p{L}\\p{M}])`, 'giu');

export function basicCleanup(text: string): string {
  let out = text;

  // Repeat until stable: removing one filler can expose another ("um, uh,").
  for (let i = 0; i < 3; i++) {
    const next = out.replace(fillerPattern, '$1');
    if (next === out) break;
    out = next;
  }

  out = out.replace(doubledPattern, (match, word: string) =>
    KEEP_DOUBLED.has(word.toLowerCase()) ? match : word,
  );

  out = out
    .replace(/\s+([,.!?;:।])/g, '$1') // no space before punctuation
    .replace(/([,;:])(?:\s*[,;:])+/g, '$1') // ", ," → ","
    .replace(/,\s*([.!?।])/g, '$1') // ", ." → "."
    .replace(/^[\s,;:]+/, '') // nothing dangling at the start
    .replace(/\s{2,}/g, ' ')
    .trim();

  // A sentence that now starts lowercase ("Um, so I…" → "so I…").
  out = out.replace(/(^|[.!?]\s+)(\p{Ll})/gu, (_m, lead: string, letter: string) => lead + letter.toUpperCase());

  return out;
}
