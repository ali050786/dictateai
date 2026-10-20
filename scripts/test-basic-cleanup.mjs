// Checks src/basic-cleanup.ts. Run with: npm run test:cleanup
import assert from 'node:assert/strict';
import { basicCleanup } from '../src/basic-cleanup.ts';

const cases = [
  // fillers
  ['Um, so I think we should ship it on Friday.', 'So I think we should ship it on Friday.'],
  ['I think, uh, we should ship it.', 'I think, we should ship it.'],
  ['So, um, uh, the build is ready.', 'So, the build is ready.'],
  ['Ummm, okay.', 'Okay.'],
  ['The deck is ready. Uh, can you review it?', 'The deck is ready. Can you review it?'],
  ['Hmm, let me check.', 'Let me check.'],
  // repeated words
  ['Send me the the deck.', 'Send me the deck.'],
  ['I I think so.', 'I think so.'],
  ['We need to to fix it.', 'We need to fix it.'],
  // repeats people mean
  ['I know that that is true.', 'I know that that is true.'],
  ['What it is is a bug.', 'What it is is a bug.'],
  ['No no, that is fine.', 'No no, that is fine.'],
  // words that look like fillers but aren't
  ['The umbrella is here.', 'The umbrella is here.'],
  ['Ahmed and Erma will join.', 'Ahmed and Erma will join.'],
  ['I like it, you know.', 'I like it, you know.'],
  // Hindi
  ['उम, मैं कल ऑफिस नहीं आ पाऊंगा।', 'मैं कल ऑफिस नहीं आ पाऊंगा।'],
  ['मुझे मुझे लगता है।', 'मुझे लगता है।'],
  // already clean, unchanged
  ['Let\'s meet on Thursday at three.', 'Let\'s meet on Thursday at three.'],
  ['', ''],
];

let failed = 0;
for (const [input, expected] of cases) {
  const actual = basicCleanup(input);
  try {
    assert.equal(actual, expected);
  } catch {
    failed++;
    console.log(`FAIL\n  in:   ${JSON.stringify(input)}\n  want: ${JSON.stringify(expected)}\n  got:  ${JSON.stringify(actual)}`);
  }
}
console.log(`${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
