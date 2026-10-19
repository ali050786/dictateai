import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFocus } from '../src/focus-target.ts';

// Facts as getFocusTarget reported them on a real Mac (macOS 26).
test('text fields and editors take text', () => {
  // Safari address bar
  assert.equal(
    classifyFocus({
      focused: true,
      role: 'AXTextField',
      selectedTextSettable: true,
      children: 0,
    }),
    'editable',
  );
  // Terminal: a text area whose selection isn't settable, but typing works
  assert.equal(
    classifyFocus({
      focused: true,
      role: 'AXTextArea',
      selectedTextSettable: false,
      children: 0,
    }),
    'editable',
  );
  // Claude desktop composer once Chromium's tree is awake
  assert.equal(
    classifyFocus({
      focused: true,
      role: 'AXTextArea',
      selectedTextSettable: true,
      editableAncestor: true,
      children: 1,
    }),
    'editable',
  );
  // A contenteditable reported with a generic role
  assert.equal(
    classifyFocus({ focused: true, role: 'AXGroup', editableAncestor: true }),
    'editable',
  );
  assert.equal(
    classifyFocus({
      focused: true,
      role: 'AXGroup',
      selectedTextSettable: true,
    }),
    'editable',
  );
});

test('Finder, controls and a web page with nothing selected take no text', () => {
  // Finder desktop / icon view
  assert.equal(
    classifyFocus({
      focused: true,
      role: 'AXList',
      subrole: 'AXCollectionList',
      children: 1,
    }),
    'none',
  );
  assert.equal(
    classifyFocus({ focused: true, role: 'AXOutline', children: 11 }),
    'none',
  );
  assert.equal(classifyFocus({ focused: true, role: 'AXButton' }), 'none');
  // Chrome with the page body focused (live tree: it has children)
  assert.equal(
    classifyFocus({ focused: true, role: 'AXWebArea', children: 3 }),
    'none',
  );
});

test('anything unclear is left to paste as before', () => {
  // Electron app whose tree is still asleep: a bare web area while typing
  assert.equal(
    classifyFocus({ focused: true, role: 'AXWebArea', children: 0 }),
    'unknown',
  );
  assert.equal(
    classifyFocus({ focused: true, role: 'AXWebArea', children: -1 }),
    'unknown',
  );
  assert.equal(classifyFocus({ focused: true, role: 'AXWebArea' }), 'unknown');
  // VS Code-style app that answers but reports nothing focused
  assert.equal(classifyFocus({ focused: false }), 'unknown');
  // Custom-drawn views, windows, spreadsheets
  assert.equal(classifyFocus({ focused: true, role: 'AXGroup' }), 'unknown');
  assert.equal(classifyFocus({ focused: true, role: 'AXWindow' }), 'unknown');
  assert.equal(classifyFocus({ focused: true, role: 'AXTable' }), 'unknown');
  assert.equal(classifyFocus({ focused: true, role: 'AXCell' }), 'unknown');
  assert.equal(classifyFocus({ focused: true }), 'unknown');
});
