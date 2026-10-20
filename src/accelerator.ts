// Global shortcuts for the last dictation ("Paste last transcript" and "Copy
// last transcript"), stored as Electron accelerators such as
// "Control+Command+V". Used by the main process, which registers them, and by
// the hub, which records and shows them.

export type TranscriptAction = 'paste' | 'copy';
export type TranscriptShortcuts = Record<TranscriptAction, string[]>;

export const TRANSCRIPT_ACTIONS: TranscriptAction[] = ['paste', 'copy'];

export const TRANSCRIPT_ACTION_LABELS: Record<TranscriptAction, string> = {
  paste: 'Paste last transcript',
  copy: 'Copy last transcript',
};

export const DEFAULT_TRANSCRIPT_SHORTCUTS: TranscriptShortcuts = {
  paste: ['Control+Command+V'],
  copy: ['Control+Command+C'],
};

// Each action can have a few shortcuts (the + button), and always keeps one.
export const MAX_BINDINGS = 3;

// In macOS menu order: ⌃ ⌥ ⇧ ⌘.
const MODIFIERS = ['Control', 'Alt', 'Shift', 'Command'] as const;
type Modifier = (typeof MODIFIERS)[number];

const MODIFIER_ALIASES: Record<string, Modifier> = {
  control: 'Control',
  ctrl: 'Control',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  command: 'Command',
  cmd: 'Command',
  commandorcontrol: 'Command',
  cmdorctrl: 'Command',
};

const MODIFIER_LABELS: Record<Modifier, { symbol: string; name: string }> = {
  Control: { symbol: '⌃', name: 'Ctrl' },
  Alt: { symbol: '⌥', name: 'Option' },
  Shift: { symbol: '⇧', name: 'Shift' },
  Command: { symbol: '⌘', name: 'Cmd' },
};

// KeyboardEvent.code → accelerator key. Physical keys, the way the system
// registers global shortcuts.
const NAMED_KEYS: Record<string, string> = {
  Space: 'Space',
  Enter: 'Return',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
};

const KEY_LABELS: Record<string, string> = {
  Return: '↩',
  Tab: '⇥',
  Backspace: '⌫',
  Delete: '⌦',
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  PageUp: '⇞',
  PageDown: '⇟',
};

const MODIFIER_CODES = new Set([
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'ShiftLeft',
  'ShiftRight',
  'MetaLeft',
  'MetaRight',
  'CapsLock',
  'Fn',
]);

// Shortcuts macOS or nearly every app already uses.
const RESERVED = new Set([
  'Command+A',
  'Command+C',
  'Command+Q',
  'Command+V',
  'Command+W',
  'Command+X',
  'Command+Z',
  'Command+Tab',
  'Command+Space',
  'Control+Space',
  'Control+Command+Space',
  'Control+Command+F',
  'Control+Command+Q',
  'Shift+Command+3',
  'Shift+Command+4',
  'Shift+Command+5',
]);

const VALID_KEYS = new Set([
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  ...Object.values(NAMED_KEYS),
]);

function isFunctionKey(key: string): boolean {
  return /^F\d+$/.test(key);
}

function codeToKey(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return digit[1];
  if (isFunctionKey(code) && VALID_KEYS.has(code)) return code;
  return NAMED_KEYS[code] ?? null;
}

interface ParsedAccelerator {
  modifiers: Modifier[];
  key: string;
}

// Accepts what this app writes plus common spellings (Ctrl, Cmd, Option),
// so a hand-edited config.json still works. null when it isn't a shortcut.
export function parseAccelerator(
  accelerator: string,
): ParsedAccelerator | null {
  // '+' separates the parts, so a trailing "++" would be the plus key; not supported.
  const parts = accelerator.split('+').map((part) => part.trim());
  const rawKey = parts.pop();
  if (!rawKey) return null;
  const key = rawKey.length === 1 ? rawKey.toUpperCase() : rawKey;
  if (!VALID_KEYS.has(key)) return null;
  const modifiers = new Set<Modifier>();
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part.toLowerCase()];
    if (!modifier) return null;
    modifiers.add(modifier);
  }
  return { modifiers: MODIFIERS.filter((m) => modifiers.has(m)), key };
}

// The same shortcut always gets the same string, for comparing.
export function canonicalAccelerator(accelerator: string): string | null {
  const parsed = parseAccelerator(accelerator);
  return parsed ? [...parsed.modifiers, parsed.key].join('+') : null;
}

// "Control+Command+V" → ['⌃ Ctrl', '⌘ Cmd', 'V'], the key caps in Settings.
export function acceleratorKeys(accelerator: string): string[] {
  const parsed = parseAccelerator(accelerator);
  if (!parsed) return [accelerator];
  return [
    ...parsed.modifiers.map(
      (m) => `${MODIFIER_LABELS[m].symbol} ${MODIFIER_LABELS[m].name}`,
    ),
    KEY_LABELS[parsed.key] ?? parsed.key,
  ];
}

// "Control+Command+V" → "⌃⌘V", for the pill and menus.
export function acceleratorSymbol(accelerator: string): string {
  const parsed = parseAccelerator(accelerator);
  if (!parsed) return accelerator;
  const key = KEY_LABELS[parsed.key] ?? parsed.key;
  return parsed.modifiers.map((m) => MODIFIER_LABELS[m].symbol).join('') + key;
}

export interface KeyPress {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export type KeyPressResult =
  | { accelerator: string }
  | { error: string }
  // Only modifier keys so far: keep listening.
  | { pending: string };

// Turns a key press in the shortcut recorder into an accelerator.
export function acceleratorFromKeyPress(press: KeyPress): KeyPressResult {
  const modifiers: Modifier[] = [];
  if (press.ctrlKey) modifiers.push('Control');
  if (press.altKey) modifiers.push('Alt');
  if (press.shiftKey) modifiers.push('Shift');
  if (press.metaKey) modifiers.push('Command');

  if (MODIFIER_CODES.has(press.code)) {
    return {
      pending: modifiers.map((m) => MODIFIER_LABELS[m].symbol).join(''),
    };
  }
  const key = codeToKey(press.code);
  if (!key)
    return {
      error: "That key can't be part of a shortcut. Try a letter or number.",
    };
  // Without ⌃, ⌥ or ⌘ the shortcut would fire while the user types.
  if (!isFunctionKey(key) && !modifiers.some((m) => m !== 'Shift')) {
    return { error: 'Hold ⌃, ⌥ or ⌘ with the key.' };
  }
  const accelerator = [...modifiers, key].join('+');
  if (RESERVED.has(accelerator)) {
    return {
      error: `${acceleratorSymbol(accelerator)} is a standard Mac shortcut. Try another.`,
    };
  }
  return { accelerator };
}

// Saved shortcuts, cleaned up: unreadable entries and repeats dropped, and
// an action left with none gets its default back.
export function normalizeTranscriptShortcuts(
  saved?: Partial<Record<TranscriptAction, unknown>>,
): TranscriptShortcuts {
  const result = {} as TranscriptShortcuts;
  for (const action of TRANSCRIPT_ACTIONS) {
    const list = Array.isArray(saved?.[action])
      ? (saved[action] as unknown[])
      : [];
    const seen = new Set<string>();
    const clean: string[] = [];
    for (const entry of list) {
      const canonical =
        typeof entry === 'string' ? canonicalAccelerator(entry) : null;
      if (canonical && !seen.has(canonical)) {
        seen.add(canonical);
        clean.push(canonical);
      }
    }
    result[action] = clean.length
      ? clean.slice(0, MAX_BINDINGS)
      : [...DEFAULT_TRANSCRIPT_SHORTCUTS[action]];
  }
  return result;
}

// Why `accelerator` can't be used for `action` (replacing the shortcut at
// `index`, or added when index is null), or null when it can.
export function bindingProblem(
  shortcuts: TranscriptShortcuts,
  action: TranscriptAction,
  accelerator: string,
  index: number | null,
): string | null {
  const target = canonicalAccelerator(accelerator);
  if (!target) return "That isn't a shortcut DictateAI can use.";
  if (index === null && shortcuts[action].length >= MAX_BINDINGS) {
    return `${TRANSCRIPT_ACTION_LABELS[action]} already has ${MAX_BINDINGS} shortcuts.`;
  }
  for (const other of TRANSCRIPT_ACTIONS) {
    const clash = shortcuts[other].some(
      (existing, i) =>
        !(other === action && i === index) &&
        canonicalAccelerator(existing) === target,
    );
    if (clash) {
      return other === action
        ? 'You already have this shortcut.'
        : `Already used for ${TRANSCRIPT_ACTION_LABELS[other]}.`;
    }
  }
  return null;
}

export function withBinding(
  shortcuts: TranscriptShortcuts,
  action: TranscriptAction,
  accelerator: string,
  index: number | null,
): TranscriptShortcuts {
  const canonical = canonicalAccelerator(accelerator) ?? accelerator;
  const list = [...shortcuts[action]];
  if (index === null || index >= list.length) list.push(canonical);
  else list[index] = canonical;
  return { ...shortcuts, [action]: list };
}

// Removes one shortcut, but never an action's last one.
export function withoutBinding(
  shortcuts: TranscriptShortcuts,
  action: TranscriptAction,
  index: number,
): TranscriptShortcuts {
  if (shortcuts[action].length <= 1) return shortcuts;
  return {
    ...shortcuts,
    [action]: shortcuts[action].filter((_, i) => i !== index),
  };
}
