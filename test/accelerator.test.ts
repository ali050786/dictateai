import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acceleratorFromKeyPress,
  acceleratorKeys,
  acceleratorSymbol,
  bindingProblem,
  canonicalAccelerator,
  DEFAULT_TRANSCRIPT_SHORTCUTS,
  normalizeTranscriptShortcuts,
  parseAccelerator,
  withBinding,
  withoutBinding,
} from '../src/accelerator.ts';

const press = (
  code: string,
  mods: Partial<
    Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>
  > = {},
) => ({
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

test('defaults are ⌃⌘V and ⌃⌘C', () => {
  assert.equal(acceleratorSymbol(DEFAULT_TRANSCRIPT_SHORTCUTS.paste[0]), '⌃⌘V');
  assert.equal(acceleratorSymbol(DEFAULT_TRANSCRIPT_SHORTCUTS.copy[0]), '⌃⌘C');
  assert.deepEqual(acceleratorKeys('Control+Command+V'), [
    '⌃ Ctrl',
    '⌘ Cmd',
    'V',
  ]);
});

test('records a key press as an accelerator in macOS order', () => {
  assert.deepEqual(
    acceleratorFromKeyPress(press('KeyV', { metaKey: true, ctrlKey: true })),
    {
      accelerator: 'Control+Command+V',
    },
  );
  assert.deepEqual(
    acceleratorFromKeyPress(press('Digit1', { altKey: true, shiftKey: true })),
    {
      accelerator: 'Alt+Shift+1',
    },
  );
  assert.deepEqual(acceleratorFromKeyPress(press('Slash', { ctrlKey: true })), {
    accelerator: 'Control+/',
  });
  // Function keys work alone
  assert.deepEqual(acceleratorFromKeyPress(press('F5')), { accelerator: 'F5' });
});

test('waits while only modifiers are held', () => {
  assert.deepEqual(
    acceleratorFromKeyPress(press('ControlLeft', { ctrlKey: true })),
    { pending: '⌃' },
  );
  assert.deepEqual(
    acceleratorFromKeyPress(
      press('MetaRight', { ctrlKey: true, metaKey: true }),
    ),
    { pending: '⌃⌘' },
  );
});

test('refuses shortcuts that would get in the way', () => {
  assert.ok('error' in acceleratorFromKeyPress(press('KeyV')));
  assert.ok(
    'error' in acceleratorFromKeyPress(press('KeyV', { shiftKey: true })),
  );
  assert.ok(
    'error' in acceleratorFromKeyPress(press('KeyV', { metaKey: true })),
  );
  assert.ok(
    'error' in
      acceleratorFromKeyPress(press('Space', { ctrlKey: true, metaKey: true })),
  );
  assert.ok(
    'error' in acceleratorFromKeyPress(press('NumpadEnter', { ctrlKey: true })),
  );
});

test('reads common spellings from a hand-edited config', () => {
  assert.equal(canonicalAccelerator('Cmd+Ctrl+v'), 'Control+Command+V');
  assert.equal(canonicalAccelerator('Option+Shift+K'), 'Alt+Shift+K');
  assert.equal(parseAccelerator('Command+Banana'), null);
  assert.equal(parseAccelerator('Hyper+V'), null);
  assert.equal(parseAccelerator(''), null);
});

test('normalizes saved shortcuts', () => {
  assert.deepEqual(
    normalizeTranscriptShortcuts(undefined),
    DEFAULT_TRANSCRIPT_SHORTCUTS,
  );
  assert.deepEqual(
    normalizeTranscriptShortcuts({ paste: [], copy: 'nonsense' }),
    DEFAULT_TRANSCRIPT_SHORTCUTS,
  );
  assert.deepEqual(
    normalizeTranscriptShortcuts({
      paste: ['Cmd+Ctrl+V', 'Control+Command+V', 'garbage', 'Alt+Command+P'],
    }),
    {
      paste: ['Control+Command+V', 'Alt+Command+P'],
      copy: ['Control+Command+C'],
    },
  );
  const many = normalizeTranscriptShortcuts({
    copy: ['Alt+1', 'Alt+2', 'Alt+3', 'Alt+4'],
  });
  assert.equal(many.copy.length, 3);
});

test('spots clashes between and within actions', () => {
  const shortcuts = {
    paste: ['Control+Command+V'],
    copy: ['Control+Command+C'],
  };
  assert.equal(
    bindingProblem(shortcuts, 'paste', 'Control+Command+C', 0),
    'Already used for Copy last transcript.',
  );
  assert.equal(
    bindingProblem(shortcuts, 'paste', 'Cmd+Ctrl+V', null),
    'You already have this shortcut.',
  );
  // Re-saving the same shortcut in place is fine
  assert.equal(
    bindingProblem(shortcuts, 'paste', 'Control+Command+V', 0),
    null,
  );
  assert.equal(bindingProblem(shortcuts, 'paste', 'Alt+Command+P', null), null);
  const full = { paste: ['Alt+1', 'Alt+2', 'Alt+3'], copy: ['Alt+4'] };
  assert.match(
    bindingProblem(full, 'paste', 'Alt+5', null) ?? '',
    /already has 3/,
  );
});

test('adds, replaces and removes, keeping one per action', () => {
  const start = { paste: ['Control+Command+V'], copy: ['Control+Command+C'] };
  const added = withBinding(start, 'paste', 'cmd+alt+p', null);
  assert.deepEqual(added.paste, ['Control+Command+V', 'Alt+Command+P']);
  assert.deepEqual(withBinding(added, 'paste', 'Alt+Command+O', 1).paste, [
    'Control+Command+V',
    'Alt+Command+O',
  ]);
  assert.deepEqual(withoutBinding(added, 'paste', 0).paste, ['Alt+Command+P']);
  assert.deepEqual(withoutBinding(start, 'copy', 0), start);
  // The original is left alone
  assert.deepEqual(start.paste, ['Control+Command+V']);
});
