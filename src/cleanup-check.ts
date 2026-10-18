// Sanity check for LLM cleanup output. openrouter/free routes each request to
// a random free model, and small local models sometimes translate or answer
// the text instead of cleaning it, so a result that changes too much is
// discarded rather than injected.

// Japanese and Chinese mix these scripts within one sentence, so they count
// as one group.
const SCRIPTS: [string, RegExp][] = [
  ['Latin', /\p{Script=Latin}/gu],
  ['Cyrillic', /\p{Script=Cyrillic}/gu],
  ['Greek', /\p{Script=Greek}/gu],
  ['Arabic', /\p{Script=Arabic}/gu],
  ['Hebrew', /\p{Script=Hebrew}/gu],
  ['Devanagari', /\p{Script=Devanagari}/gu],
  ['Bengali', /\p{Script=Bengali}/gu],
  ['Gurmukhi', /\p{Script=Gurmukhi}/gu],
  ['Gujarati', /\p{Script=Gujarati}/gu],
  ['Tamil', /\p{Script=Tamil}/gu],
  ['Telugu', /\p{Script=Telugu}/gu],
  ['Kannada', /\p{Script=Kannada}/gu],
  ['Malayalam', /\p{Script=Malayalam}/gu],
  ['Thai', /\p{Script=Thai}/gu],
  ['Hangul', /\p{Script=Hangul}/gu],
  ['CJK', /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu],
];

export function dominantScript(text: string): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [name, re] of SCRIPTS) {
    const count = text.match(re)?.length ?? 0;
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

// Returns why the output was rejected, or null when it looks like a cleanup.
export function checkCleanup(input: string, output: string): string | null {
  if (!output.trim()) return 'empty';

  const inScript = dominantScript(input);
  const outScript = dominantScript(output);
  if (inScript && outScript && inScript !== outScript) {
    return `script changed ${inScript} → ${outScript}`;
  }

  // Filler removal can cut a lot, but not more than half of a real sentence.
  // Short inputs ("ok thanks") are exempt from the lower bound.
  if (input.length >= 20 && output.length < input.length * 0.5) {
    return `too short (${input.length} → ${output.length} chars)`;
  }
  // Cleanup never adds much; a long reply means the model answered instead.
  if (output.length > input.length * 1.5 + 20) {
    return `too long (${input.length} → ${output.length} chars)`;
  }

  return null;
}
