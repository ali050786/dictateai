import { globalShortcut } from 'electron';
import {
  acceleratorSymbol,
  bindingProblem,
  DEFAULT_TRANSCRIPT_SHORTCUTS,
  normalizeTranscriptShortcuts,
  TranscriptAction,
  TranscriptShortcuts,
  TRANSCRIPT_ACTIONS,
  withBinding,
  withoutBinding,
} from './accelerator';
import { loadConfig, saveConfig } from './config';
import { listHistory } from './history';
import { redact } from './log';
import { copyText, getModifierFlags, injectText } from './text-injection';

// The last dictation, for when it couldn't be inserted (no text field had
// focus) or is wanted again: global shortcuts paste or copy it. It is the
// newest history entry, so clearing history forgets it too.

export function getLastTranscript(): string | null {
  return listHistory()[0]?.text || null;
}

// Brief feedback in the pill ('copied', 'nothing-yet'); main.ts sets it.
let showFeedback: (state: string) => void = () => {};
export function setLastTranscriptFeedback(show: (state: string) => void): void {
  showFeedback = show;
}

export async function pasteLastTranscript(): Promise<void> {
  const text = getLastTranscript();
  if (!text) {
    showFeedback('nothing-yet');
    return;
  }
  // The shortcut fires while its keys are still held; with ⌃ down, the
  // paste or typed text would turn into control keys.
  await modifiersReleased(1000);
  console.log(`[DictateAI] Paste last transcript: ${redact(text)}`);
  injectText(text);
}

export function copyLastTranscript(): void {
  const text = getLastTranscript();
  if (!text) {
    showFeedback('nothing-yet');
    return;
  }
  copyText(text);
  console.log(`[DictateAI] Copied last transcript: ${redact(text)}`);
  showFeedback('copied');
}

async function modifiersReleased(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (getModifierFlags() !== 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

// --- Global shortcuts ---

export function getTranscriptShortcuts(): TranscriptShortcuts {
  return normalizeTranscriptShortcuts(loadConfig().transcriptShortcuts);
}

// "⌃⌘V", for the "No text field" notice.
export function pasteShortcutSymbol(): string {
  return acceleratorSymbol(getTranscriptShortcuts().paste[0]);
}

const ACTIONS: Record<TranscriptAction, () => void> = {
  paste: () => void pasteLastTranscript(),
  copy: copyLastTranscript,
};

let registered: string[] = [];
// Shortcuts another app already holds, shown as unavailable in Settings.
let unavailable: string[] = [];
let suspended = false;

function register(shortcuts: TranscriptShortcuts): string[] {
  unregisterTranscriptShortcuts();
  const failed: string[] = [];
  for (const action of TRANSCRIPT_ACTIONS) {
    for (const accelerator of shortcuts[action]) {
      let ok = false;
      try {
        ok = globalShortcut.register(accelerator, ACTIONS[action]);
      } catch (err) {
        console.error(`[DictateAI] Shortcut ${accelerator} rejected:`, err);
      }
      if (ok) registered.push(accelerator);
      else failed.push(accelerator);
    }
  }
  return failed;
}

export function registerTranscriptShortcuts(): void {
  suspended = false;
  unavailable = register(getTranscriptShortcuts());
  if (unavailable.length) {
    console.warn(
      `[DictateAI] Shortcuts in use by another app: ${unavailable.join(', ')}`,
    );
  }
}

export function unregisterTranscriptShortcuts(): void {
  for (const accelerator of registered) globalShortcut.unregister(accelerator);
  registered = [];
}

// While Settings records a new shortcut, so pressing the current one there
// records it instead of pasting.
export function suspendTranscriptShortcuts(): void {
  suspended = true;
  unregisterTranscriptShortcuts();
}

export function resumeTranscriptShortcuts(): void {
  if (suspended) registerTranscriptShortcuts();
}

export interface TranscriptShortcutState {
  shortcuts: TranscriptShortcuts;
  unavailable: string[];
  defaults: TranscriptShortcuts;
}

export function transcriptShortcutState(): TranscriptShortcutState {
  return {
    shortcuts: getTranscriptShortcuts(),
    unavailable: [...unavailable],
    defaults: DEFAULT_TRANSCRIPT_SHORTCUTS,
  };
}

type SaveResult =
  | { ok: true; state: TranscriptShortcutState }
  | { ok: false; error: string };

// Saves `next` only if every new shortcut can be registered; otherwise the
// current ones stay in place.
function apply(next: TranscriptShortcuts): SaveResult {
  const before = getTranscriptShortcuts();
  const isNew = (accelerator: string) =>
    !TRANSCRIPT_ACTIONS.some((a) => before[a].includes(accelerator));
  const failed = register(next);
  const taken = failed.find(isNew);
  if (taken) {
    // Settings is still recording: keep them off until it closes.
    if (suspended) unregisterTranscriptShortcuts();
    else unavailable = register(before);
    return {
      ok: false,
      error: `Another app already uses ${acceleratorSymbol(taken)}. Try another.`,
    };
  }
  unavailable = failed;
  suspended = false;
  saveConfig({ transcriptShortcuts: next });
  return { ok: true, state: transcriptShortcutState() };
}

export function setTranscriptShortcut(
  action: TranscriptAction,
  index: number | null,
  accelerator: string,
): SaveResult {
  const current = getTranscriptShortcuts();
  const problem = bindingProblem(current, action, accelerator, index);
  if (problem) return { ok: false, error: problem };
  return apply(withBinding(current, action, accelerator, index));
}

export function removeTranscriptShortcut(
  action: TranscriptAction,
  index: number,
): SaveResult {
  return apply(withoutBinding(getTranscriptShortcuts(), action, index));
}

export function resetTranscriptShortcuts(): SaveResult {
  return apply(DEFAULT_TRANSCRIPT_SHORTCUTS);
}
