import OpenAI from 'openai';
import { getCorrectionsPrompt } from './dictionary';
import { MLX_BASE_URL, getLocalModel, isLocalLlmRunning, startLocalLlm, defaultLocalModelFor } from './local-llm';
import { checkCleanup } from './cleanup-check';
import { loadConfig, getLlmProvider, getApiKey, hasApiKey } from './config';
import { redact } from './log';

// Where the injected text was cleaned; 'local' also covers raw text, which
// never left the Mac either.
export type CleanupLocation = 'local' | 'cloud';
// Why a cloud request didn't produce the text; rejected results stay quiet.
export type CloudFallback = 'rate-limited' | 'cloud-error' | 'rejected';

export interface CleanupResult {
  text: string;
  location: CleanupLocation;
  // False when the raw transcript was returned unchanged.
  cleaned: boolean;
  fallback?: CloudFallback;
}

// True when the selected provider can take a request right now. A local
// provider that is still loading falls back to raw text, never to the cloud.
export function canFormat(): boolean {
  if (getLlmProvider() === 'local') return isLocalLlmRunning();
  return hasApiKey() || isLocalLlmRunning();
}

export const DEFAULT_CLOUD_MODEL = 'deepseek/deepseek-chat';

export function getCloudModel(): string {
  return loadConfig().model || DEFAULT_CLOUD_MODEL;
}

// After a 429, skip the cloud for a while instead of failing on every
// dictation (e.g. the user's OpenRouter credits ran out).
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
  const apiKey = getApiKey();
  if (!apiKey) return null;

  return new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey,
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
): Promise<CleanupResult> {
  if (mode === 'raw') return { text: rawText, location: 'local', cleaned: false };
  let fallback: CloudFallback | undefined;
  const raw = (): CleanupResult => ({ text: rawText, location: 'local', cleaned: false, fallback });

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
          console.log(`[DictateAI] LLM formatted (${mode}, ${model}): ${redact(formatted)}`);
          return { text: formatted, location: 'cloud', cleaned: true };
        }
        fallback = 'rejected';
        console.log(`[DictateAI] Cloud result rejected (${problem}): ${redact(formatted)}`);
      } catch (err) {
        if (isRateLimited(err)) {
          cloudPausedUntil = Date.now() + CLOUD_PAUSE_MS;
          fallback = 'rate-limited';
          console.log('[DictateAI] Cloud rate-limited — using local LLM for the next 15 minutes');
        } else {
          fallback = 'cloud-error';
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
    return raw();
  }

  try {
    const formatted = await complete(local, getLocalModel(), systemPrompt, rawText);
    const problem = checkCleanup(rawText, formatted);
    if (!problem) {
      console.log(`[DictateAI] LLM formatted (${mode}, local): ${redact(formatted)}`);
      return { text: formatted, location: 'local', cleaned: true, fallback };
    }
    console.log(`[DictateAI] Local result rejected (${problem}): ${redact(formatted)} — returning raw text`);
  } catch (err) {
    console.error('[DictateAI] Local formatting failed:', err);
  }

  return raw();
}
