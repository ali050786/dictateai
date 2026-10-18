import OpenAI from 'openai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getCorrectionsPrompt } from './dictionary';

const CONFIG_PATH = path.join(os.homedir(), '.dictateai', 'config.json');

export interface Config {
  openRouterApiKey?: string;
  model?: string;
  language?: string;
  llmEnabled?: boolean;
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

function getClient(): OpenAI | null {
  const config = loadConfig();
  if (!config.openRouterApiKey) return null;

  return new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: config.openRouterApiKey,
    defaultHeaders: {
      'X-Title': 'DictateAI',
    },
  });
}

const DICTATION_PROMPT = `You clean up voice dictation. Output ONLY the corrected text — no quotes, no notes, no explanations, no commentary, no markdown. Never start with "Here's" or "Note:". Just the text.

Rules:
- Fix transcription errors, punctuation, capitalization
- Remove filler words (um, uh, like, you know, and equivalents in any language)
- Keep the speaker's intent and words intact
- Do NOT rephrase, summarize, or add anything
- IMPORTANT: Keep the SAME language the speaker used. If they spoke Hindi, output Hindi. If French, output French. Never translate to English unless the input is English.
- For languages with scripts (Hindi/Devanagari, Arabic, Chinese, etc.), output in the native script`;

const POLISH_PROMPT = `You polish dictated text. Output ONLY the polished text — no quotes, no notes, no explanations, no commentary, no markdown. Never start with "Here's" or "Note:". Just the text.

Rules:
- Fix grammar and punctuation
- Improve sentence structure for clarity
- Remove filler words and verbal tics
- Keep the speaker's voice and intent
- IMPORTANT: Keep the SAME language the speaker used. Never translate. Output in the native script of that language.`;

export type FormattingMode = 'dictation' | 'polish' | 'raw';

export async function formatText(
  rawText: string,
  mode: FormattingMode = 'dictation',
  context?: { app?: string; role?: string },
): Promise<string> {
  if (mode === 'raw') return rawText;

  const client = getClient();
  if (!client) {
    console.log('[DictateAI] No API key set — returning raw text');
    return rawText;
  }

  const systemPrompt = mode === 'polish' ? POLISH_PROMPT : DICTATION_PROMPT;
  const contextHint = context?.app
    ? `\nTarget application: ${context.app}`
    : '';
  const dictHint = getCorrectionsPrompt();

  try {
    const config = loadConfig();
    const model = config.model || 'deepseek/deepseek-chat';

    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt + contextHint + dictHint },
        { role: 'user', content: rawText },
      ],
      temperature: 0.3,
      max_tokens: 2048,
    });

    const formatted = response.choices[0]?.message?.content?.trim();
    if (formatted) {
      console.log(`[DictateAI] LLM formatted (${mode}): "${formatted}"`);
      return formatted;
    }
  } catch (err) {
    console.error('[DictateAI] LLM formatting failed:', err);
  }

  return rawText;
}
