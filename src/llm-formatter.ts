import OpenAI from 'openai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getCorrectionsPrompt } from './dictionary';
import { MLX_BASE_URL, getLocalModel, isLocalLlmRunning, startLocalLlm, defaultLocalModelFor } from './local-llm';
import { checkCleanup } from './cleanup-check';

const CONFIG_PATH = path.join(os.homedir(), '.dictateai', 'config.json');

export interface ShortcutConfig {
  code: string;
  display: string;
  keyCode: number;
  flagMask: number;
  isModifier: boolean;
  requiredModifiers: number;
}

export type PillPosition = 'top-left' | 'top-center' | 'top-right' | 'center-left' | 'center' | 'center-right' | 'bottom-left' | 'bottom-center' | 'bottom-right';

export type LlmProvider = 'local' | 'cloud';
export type CloudTier = 'free' | 'paid';
// Where the injected text was cleaned; 'local' also covers raw text, which
// never left the Mac either.
export type CleanupLocation = 'local' | 'cloud';

export interface Config {
  openRouterApiKey?: string;
  model?: string;
  llmProvider?: LlmProvider;
  cloudTier?: CloudTier;
  localModel?: string;
  language?: string;
  llmEnabled?: boolean;
  shortcut?: ShortcutConfig;
  audioDevice?: string;
  pillPosition?: PillPosition;
  muteWhileSpeaking?: boolean;
}

let cachedConfig: Config | null = null;

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
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  cachedConfig = { ...loadConfig(), ...updates };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cachedConfig, null, 2));
}

export function saveApiKey(key: string): void {
  saveConfig({ openRouterApiKey: key });
}

export function hasApiKey(): boolean {
  return !!loadConfig().openRouterApiKey;
}

export function getLlmProvider(): LlmProvider {
  return loadConfig().llmProvider ?? 'local';
}

// True when the selected provider can take a request right now. A local
// provider that is still loading falls back to raw text, never to the cloud.
export function canFormat(): boolean {
  if (getLlmProvider() === 'local') return isLocalLlmRunning();
  return hasApiKey() || isLocalLlmRunning();
}

export const DEFAULT_PAID_MODEL = 'deepseek/deepseek-chat';
// OpenRouter's Free Models Router: picks a free model at random per request.
const FREE_CLOUD_MODEL = 'openrouter/free';

export function getCloudTier(): CloudTier {
  return loadConfig().cloudTier ?? 'free';
}

export function getCloudModel(): string {
  return getCloudTier() === 'free'
    ? FREE_CLOUD_MODEL
    : loadConfig().model || DEFAULT_PAID_MODEL;
}

// After a 429, skip the cloud for a while instead of failing on every
// dictation. Free OpenRouter models allow 20 requests a minute and 50 a day.
const CLOUD_PAUSE_MS = 15 * 60_000;
let cloudPausedUntil = 0;

function isRateLimited(err: unknown): boolean {
  return (err as { status?: number })?.status === 429;
}

function getLocalClient(): OpenAI | null {
  if (!isLocalLlmRunning()) return null;
  return new OpenAI({ baseURL: MLX_BASE_URL, apiKey: 'local' });
}

function getCloudClient(): OpenAI | null {
  const config = loadConfig();
  if (!config.openRouterApiKey) return null;

  return new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: config.openRouterApiKey,
    // Retrying a 429 only delays the local fallback by several seconds.
    maxRetries: 0,
    defaultHeaders: {
      'X-Title': 'DictateAI',
    },
  });
}

// Small local models follow examples far better than rules alone; the Hindi
// example stops Qwen from translating non-English dictation to English.
const DICTATION_PROMPT = `You clean up voice dictation transcripts. Reply with ONLY the cleaned text — no quotes, notes, explanations or markdown.

Do:
- Add correct punctuation and capitalization (sentences start with a capital letter and end with punctuation).
- Remove filler words: um, uh, like (when used as filler), you know, I mean, so (at the start), and equivalents in any language, plus repeated words ("the the").
- Fix obvious transcription errors and apostrophes (doesnt → doesn't).

Don't:
- Rephrase, summarize, answer, or add anything.
- Translate. Keep the exact language and script the speaker used (Hindi stays in Devanagari, Arabic in Arabic script, and so on), and copy non-English words exactly unless removing a filler.

Example
Input: um so i think we should uh like push the release to monday you know
Output: I think we should push the release to Monday.

Example
Input: उम मैं कल ऑफिस नहीं आ पाऊंगा
Output: मैं कल ऑफिस नहीं आ पाऊंगा।`;

const POLISH_PROMPT = `You polish dictated text. Output ONLY the polished text — no quotes, no notes, no explanations, no commentary, no markdown. Never start with "Here's" or "Note:". Just the text.

Rules:
- Fix grammar and punctuation
- Improve sentence structure for clarity
- Remove filler words and verbal tics
- Keep the speaker's voice and intent
- IMPORTANT: Keep the SAME language the speaker used. Never translate. Output in the native script of that language.`;

export type FormattingMode = 'dictation' | 'polish' | 'raw';

async function complete(client: OpenAI, model: string, system: string, text: string): Promise<string> {
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: text },
    ],
    temperature: 0.3,
    max_tokens: 2048,
  });
  return response.choices[0]?.message?.content?.trim() ?? '';
}

// Cloud users get the local model as a fallback: on a rate limit, an error or
// a result that fails checkCleanup. Local never falls back to the cloud — the
// user's words don't leave the Mac without them choosing it.
export async function formatText(
  rawText: string,
  mode: FormattingMode = 'dictation',
  context?: { app?: string; role?: string },
): Promise<{ text: string; location: CleanupLocation }> {
  const raw = { text: rawText, location: 'local' as const };
  if (mode === 'raw') return raw;

  const config = loadConfig();
  const provider = getLlmProvider();
  const systemPrompt = (mode === 'polish' ? POLISH_PROMPT : DICTATION_PROMPT)
    + (context?.app ? `\nTarget application: ${context.app}` : '')
    + getCorrectionsPrompt();

  if (provider === 'cloud') {
    const cloud = Date.now() >= cloudPausedUntil ? getCloudClient() : null;
    if (cloud) {
      const model = getCloudModel();
      try {
        const formatted = await complete(cloud, model, systemPrompt, rawText);
        const problem = checkCleanup(rawText, formatted);
        if (!problem) {
          console.log(`[DictateAI] LLM formatted (${mode}, ${model}): "${formatted}"`);
          return { text: formatted, location: 'cloud' };
        }
        console.log(`[DictateAI] Cloud result rejected (${problem}): "${formatted}"`);
      } catch (err) {
        if (isRateLimited(err)) {
          cloudPausedUntil = Date.now() + CLOUD_PAUSE_MS;
          console.log('[DictateAI] Cloud rate-limited — using local LLM for the next 15 minutes');
        } else {
          console.error('[DictateAI] Cloud formatting failed:', err);
        }
      }
    }
    // Load the local model for this and later fallbacks; until it's ready,
    // dictations go in raw.
    startLocalLlm(config.localModel || defaultLocalModelFor(config.language));
  }

  const local = getLocalClient();
  if (!local) {
    console.log('[DictateAI] Local LLM not ready — returning raw text');
    return raw;
  }

  try {
    const formatted = await complete(local, getLocalModel(), systemPrompt, rawText);
    const problem = checkCleanup(rawText, formatted);
    if (!problem) {
      console.log(`[DictateAI] LLM formatted (${mode}, local): "${formatted}"`);
      return { text: formatted, location: 'local' };
    }
    console.log(`[DictateAI] Local result rejected (${problem}): "${formatted}" — returning raw text`);
  } catch (err) {
    console.error('[DictateAI] Local formatting failed:', err);
  }

  return raw;
}
