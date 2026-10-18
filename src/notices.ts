import { Notification } from 'electron';
import { loadConfig, saveConfig } from './config';
import { CleanupResult } from './llm-formatter';

// Calm, rare messages: macOS notifications rather than the pill, which is too
// small for a sentence and must keep showing dictation state.
//  - Once ever: which local model the app picked, after the first cleanup.
//  - Once a day: the cloud couldn't be used and the Mac took over.

function notify(title: string, body: string): void {
  if (!Notification.isSupported()) return;
  new Notification({ title, body, silent: true }).show();
}

// "mlx-community/Qwen2.5-3B-Instruct-4bit" → "Qwen 3B"
function friendlyModelName(modelId: string): string {
  const match = modelId.match(/(Qwen)[\d.]*-(\d+(?:\.\d+)?B)/i);
  return match ? `${match[1]} ${match[2]}` : modelId.split('/').pop() || modelId;
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function noticeAfterCleanup(result: CleanupResult, localModel: string, language?: string): void {
  const notices = loadConfig().notices ?? {};

  if (result.fallback === 'rate-limited' || result.fallback === 'cloud-error') {
    if (notices.fallbackShownOn !== today()) {
      notify(
        result.fallback === 'rate-limited' ? 'Cloud limit reached' : 'Cloud unavailable',
        'Your Mac is handling cleanup now.',
      );
      saveConfig({ notices: { ...notices, fallbackShownOn: today() } });
    }
    return;
  }

  if (result.location === 'local' && result.cleaned && !result.fallback && !notices.modelNoteShown) {
    const scope = language === 'en' ? 'tuned for English' : 'handles every language';
    notify(
      'Cleanup runs on your Mac',
      `Using ${friendlyModelName(localModel)}, ${scope}. Private and unlimited.`,
    );
    saveConfig({ notices: { ...notices, modelNoteShown: true } });
  }
}
