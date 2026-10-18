import * as path from 'path';

declare const __non_webpack_require__: typeof require;

interface TextInjectionAddon {
  injectText(
    text: string,
  ): 'accessibility' | 'keystrokes' | 'clipboard' | 'failed' | 'empty';
  undoLastInjection(): boolean;
  checkAccessibilityPermission(): boolean;
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
}

let addon: TextInjectionAddon | null = null;

function getAddon(): TextInjectionAddon {
  if (addon) return addon;

  // In dev: __dirname = <project>/.webpack/main → go up 2 to reach project root
  // In prod: the addon will be in the app's resources
  const projectRoot = path.resolve(__dirname, '..', '..');
  const addonPath = path.join(
    projectRoot,
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
      '[DictateAI] Failed to load native text injection addon:',
      err,
    );
    addon = {
      injectText: () => 'failed',
      undoLastInjection: () => false,
      checkAccessibilityPermission: () => false,
      getFocusedElementInfo: () => ({ available: false }),
      startPushToTalk: () => false,
      stopPushToTalk: () => false,
    };
  }

  return addon;
}

export function injectText(text: string): string {
  const result = getAddon().injectText(text);
  console.log(`[DictateAI] Text injection: ${result} (${text.length} chars)`);
  return result;
}

export function undoLastInjection(): boolean {
  const result = getAddon().undoLastInjection();
  console.log(`[DictateAI] Undo last injection: ${result}`);
  return result;
}

export function checkAccessibilityPermission(): boolean {
  return getAddon().checkAccessibilityPermission();
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
