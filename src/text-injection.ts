import * as path from 'path';
import { app } from 'electron';
import type { FocusFacts } from './focus-target';

declare const __non_webpack_require__: typeof require;

interface TextInjectionAddon {
  injectText(
    text: string,
  ): 'accessibility' | 'keystrokes' | 'clipboard' | 'failed' | 'empty';
  undoLastInjection(): boolean;
  checkAccessibilityPermission(): boolean;
  isAccessibilityTrusted(): boolean;
  getFocusedElementInfo(): {
    available: boolean;
    role?: string;
    title?: string;
    value?: string;
    app?: string;
    bundleId?: string;
  };
  startPushToTalk(callback: (event: 'down' | 'up') => void): boolean;
  stopPushToTalk(): boolean;
  setPttKey(keyCode: number, flagMask: number, isModifier: boolean, requiredModifiers?: number): boolean;
  getTextCursorPosition(): {
    available: boolean;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  };
  getFocusTarget(): FocusFacts & { appError?: number; systemError?: number };
  copyText(text: string): boolean;
  getModifierFlags(): number;
}

let addon: TextInjectionAddon | null = null;

function getAddon(): TextInjectionAddon {
  if (addon) return addon;

  // In dev: __dirname = <project>/.webpack/main → go up 2 to reach project root
  // In prod: forge's extraResource copies the addon into Contents/Resources
  const addonPath = app.isPackaged
    ? path.join(process.resourcesPath, 'text_injection.node')
    : path.join(
        path.resolve(__dirname, '..', '..'),
        'native',
        'text-injection',
        'build',
        'Release',
        'text_injection.node',
      );

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    addon = __non_webpack_require__(addonPath) as TextInjectionAddon;
  } catch (err) {
    console.error(
      '[Utter] Failed to load native text injection addon:',
      err,
    );
    addon = {
      injectText: () => 'failed',
      undoLastInjection: () => false,
      checkAccessibilityPermission: () => false,
      isAccessibilityTrusted: () => false,
      getFocusedElementInfo: () => ({ available: false }),
      startPushToTalk: () => false,
      stopPushToTalk: () => false,
      setPttKey: () => false,
      getTextCursorPosition: () => ({ available: false }),
      getFocusTarget: () => ({ focused: false }),
      copyText: () => false,
      getModifierFlags: () => 0,
    };
  }

  return addon;
}

export function injectText(text: string): string {
  const result = getAddon().injectText(text);
  console.log(`[Utter] Text injection: ${result} (${text.length} chars)`);
  return result;
}

export function undoLastInjection(): boolean {
  const result = getAddon().undoLastInjection();
  console.log(`[Utter] Undo last injection: ${result}`);
  return result;
}

// Shows the macOS "allow Accessibility" prompt if not yet trusted.
export function checkAccessibilityPermission(): boolean {
  return getAddon().checkAccessibilityPermission();
}

// Never prompts; safe to call repeatedly.
export function isAccessibilityTrusted(): boolean {
  return getAddon().isAccessibilityTrusted();
}

export function getFocusedElementInfo() {
  return getAddon().getFocusedElementInfo();
}

export function startPushToTalk(
  callback: (event: 'down' | 'up') => void,
): boolean {
  return getAddon().startPushToTalk(callback);
}

export function stopPushToTalk(): boolean {
  return getAddon().stopPushToTalk();
}

export function setPttKey(keyCode: number, flagMask: number, isModifier: boolean, requiredModifiers?: number): boolean {
  return getAddon().setPttKey(keyCode, flagMask, isModifier, requiredModifiers);
}

export function getTextCursorPosition() {
  return getAddon().getTextCursorPosition();
}

// Facts about the focused element; focus-target.ts decides if it takes text.
export function getFocusTarget() {
  return getAddon().getFocusTarget();
}

// Copies text for the user to paste, hidden from clipboard managers.
export function copyText(text: string): boolean {
  return getAddon().copyText(text);
}

// Modifier keys (⌃ ⌥ ⇧ ⌘) the user is holding down, as CGEventFlags; 0 if none.
export function getModifierFlags(): number {
  return getAddon().getModifierFlags();
}
