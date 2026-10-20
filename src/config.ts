import { safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// User settings, persisted to ~/.dictateai/config.json (owner-only).

export const DATA_DIR = path.join(os.homedir(), '.dictateai');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

export interface ShortcutConfig {
  code: string;
  display: string;
  keyCode: number;
  flagMask: number;
  isModifier: boolean;
  requiredModifiers: number;
}

export type PillPosition = 'top-left' | 'top-center' | 'top-right' | 'bottom-left' | 'bottom-center' | 'bottom-right';

const PILL_POSITIONS: PillPosition[] = ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'];

// The middle-row positions were removed; move them to the bottom spot below.
export function normalizePillPosition(pos: string | undefined): PillPosition {
  if (PILL_POSITIONS.includes(pos as PillPosition)) return pos as PillPosition;
  if (pos === 'center-left') return 'bottom-left';
  if (pos === 'center-right') return 'bottom-right';
  return 'bottom-center';
}

export type LlmProvider = 'local' | 'cloud';

export interface Config {
  // The OpenRouter key, encrypted with the macOS Keychain (base64).
  openRouterKeyEncrypted?: string;
  // Legacy plaintext key; migrated to openRouterKeyEncrypted on startup.
  openRouterApiKey?: string;
  model?: string;
  llmProvider?: LlmProvider;
  // Legacy: 'free' meant openrouter/free, removed because it was slow.
  // main.ts moves those users to local on startup.
  cloudTier?: 'free' | 'paid';
  localModel?: string;
  language?: string;
  llmEnabled?: boolean;
  // A short sound when dictation starts and stops. On unless turned off.
  playSounds?: boolean;
  // Global shortcuts for the last dictation, as Electron accelerators
  // (see accelerator.ts). Missing means the defaults.
  transcriptShortcuts?: { paste?: string[]; copy?: string[] };
  shortcut?: ShortcutConfig;
  audioDevice?: string;
  pillPosition?: PillPosition;
  // One-time and once-a-day notices (see notices.ts).
  notices?: { modelNoteShown?: boolean; fallbackShownOn?: string; cleanupReadyShown?: boolean };
  muteWhileSpeaking?: boolean;
  // Set once the Welcome window has opened, so it opens on first launch only.
  welcomeShown?: boolean;
  // A cleanup model the user chose not to download yet (after changing
  // language). It isn't fetched until they ask; dictation stays plain text.
  cleanupDownloadDeclined?: string;
}

let cachedConfig: Config | null = null;

export function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  // Older versions created it world-readable.
  fs.chmodSync(DATA_DIR, 0o700);
}

// Writes a file in DATA_DIR readable only by the user.
export function writePrivateFile(file: string, contents: string): void {
  ensureDataDir();
  fs.writeFileSync(file, contents, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function loadConfig(): Config {
  if (cachedConfig) return cachedConfig;
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      cachedConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      return cachedConfig!;
    }
  } catch {}
  cachedConfig = {};
  return cachedConfig;
}

export function saveConfig(updates: Partial<Config>): void {
  cachedConfig = { ...loadConfig(), ...updates };
  writePrivateFile(CONFIG_PATH, JSON.stringify(cachedConfig, null, 2));
}

export function getLlmProvider(): LlmProvider {
  return loadConfig().llmProvider ?? 'local';
}

// --- OpenRouter key ---
// Stored encrypted with Electron safeStorage (Keychain-backed on macOS), so
// other apps reading config.json don't get a usable key. Call these only
// after the app is ready.

export function saveApiKey(key: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    console.error('[DictateAI] Keychain encryption unavailable — key not saved');
    return;
  }
  saveConfig({
    openRouterKeyEncrypted: safeStorage.encryptString(key).toString('base64'),
    openRouterApiKey: undefined,
  });
}

export function getApiKey(): string | null {
  const config = loadConfig();
  if (config.openRouterKeyEncrypted) {
    try {
      return safeStorage.decryptString(Buffer.from(config.openRouterKeyEncrypted, 'base64'));
    } catch {
      // Encrypted by a different app identity (e.g. the dev build); the user
      // has to enter it again.
      console.error('[DictateAI] Could not decrypt the saved OpenRouter key');
      return null;
    }
  }
  return config.openRouterApiKey || null;
}

export function hasApiKey(): boolean {
  const config = loadConfig();
  return !!(config.openRouterKeyEncrypted || config.openRouterApiKey);
}

// JSON.stringify omits undefined fields, so this drops both forms from disk.
export function removeApiKey(): void {
  saveConfig({ openRouterKeyEncrypted: undefined, openRouterApiKey: undefined });
}

// Encrypts a plaintext key left by an older version.
export function migrateApiKey(): void {
  const plain = loadConfig().openRouterApiKey;
  if (plain && safeStorage.isEncryptionAvailable()) {
    saveApiKey(plain);
    console.log('[DictateAI] Encrypted the saved OpenRouter key');
  }
}
