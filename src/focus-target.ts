// Will the focused element take the dictated text? Decided from the facts the
// native addon reports (getFocusTarget). When unsure it answers 'unknown' and
// the text is pasted as before: many apps that accept typing don't describe
// their text fields to Accessibility (VS Code and other Electron apps until a
// screen reader asks, terminals, games), and a wrong "No text field" there
// would stop dictation from working at all.

export interface FocusFacts {
  // false when the frontmost app reports no focused element, or doesn't answer.
  focused: boolean;
  role?: string;
  subrole?: string;
  selectedTextSettable?: boolean;
  // Inside a contenteditable on a web page (Chromium and WebKit set this).
  editableAncestor?: boolean;
  // Child count of the focused element; -1 when it can't be read.
  children?: number;
  app?: string;
  bundleId?: string;
}

export type FocusVerdict = 'editable' | 'none' | 'unknown';

const TEXT_ROLES = new Set([
  'AXTextField',
  'AXTextArea',
  'AXComboBox',
  'AXSearchField',
]);

// Focus is on something that never takes typed text: Finder's icon view and
// the desktop (AXList), a list or column view, a button, a link, a menu.
// Tables and cells are left out on purpose: typing into a selected
// spreadsheet cell starts editing it.
const NON_TEXT_ROLES = new Set([
  'AXList',
  'AXOutline',
  'AXBrowser',
  'AXButton',
  'AXCheckBox',
  'AXRadioButton',
  'AXPopUpButton',
  'AXMenuButton',
  'AXDisclosureTriangle',
  'AXSlider',
  'AXIncrementor',
  'AXColorWell',
  'AXImage',
  'AXLink',
  'AXMenu',
  'AXMenuBar',
  'AXMenuBarItem',
  'AXMenuItem',
]);

export function classifyFocus(facts: FocusFacts): FocusVerdict {
  if (!facts.focused || !facts.role) return 'unknown';
  if (
    TEXT_ROLES.has(facts.role) ||
    facts.selectedTextSettable ||
    facts.editableAncestor
  )
    return 'editable';
  if (NON_TEXT_ROLES.has(facts.role)) return 'none';
  // A web page with nothing editable focused, but only when its tree is
  // live: an Electron app reports a bare, childless web area as focused
  // while its text box has focus, until Accessibility wakes it up.
  if (facts.role === 'AXWebArea' && (facts.children ?? 0) > 0) return 'none';
  return 'unknown';
}
