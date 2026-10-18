import { spawn, ChildProcess, execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as http from 'http';

// mlx_lm.server exposes an OpenAI-compatible API, so the formatter can reuse
// the same client it uses for OpenRouter.
const MLX_PORT = 50061;
const MLX_HOST = '127.0.0.1';
export const MLX_BASE_URL = `http://${MLX_HOST}:${MLX_PORT}/v1`;
// 3B cleans English in ~0.5s; 7B takes 1–3.5s but is the smallest Qwen that
// kept non-English dictation in its own language (3B translated Hindi to English).
const ENGLISH_MODEL = 'mlx-community/Qwen2.5-3B-Instruct-4bit';
const MULTILINGUAL_MODEL = 'mlx-community/Qwen2.5-7B-Instruct-4bit';
const DEFAULT_LOCAL_MODEL = MULTILINGUAL_MODEL;

// ~8.5 GB of weights: below 32 GB of RAM it pushes the Mac into swap and every
// dictation waits seconds, so it isn't offered there at all.
const LARGE_MODEL = 'mlx-community/Qwen2.5-14B-Instruct-4bit';
const LARGE_MODEL_MIN_RAM_GB = 32;

export function defaultLocalModelFor(language: string | undefined): string {
  return language === 'en' ? ENGLISH_MODEL : MULTILINGUAL_MODEL;
}

export interface LocalModelOption {
  id: string; // 'auto' or an MLX model ID
  label: string;
  detail: string;
}

export function localModelOptions(): LocalModelOption[] {
  const options: LocalModelOption[] = [
    { id: 'auto', label: 'Automatic (recommended)', detail: 'Qwen 3B for English, Qwen 7B for other languages' },
    { id: ENGLISH_MODEL, label: 'Faster', detail: 'Qwen 3B · about 0.5s · best for English' },
    { id: MULTILINGUAL_MODEL, label: 'More accurate', detail: 'Qwen 7B · 1–3s · every language' },
  ];
  if (os.totalmem() / 1024 ** 3 >= LARGE_MODEL_MIN_RAM_GB) {
    options.push({ id: LARGE_MODEL, label: 'Most accurate', detail: 'Qwen 14B · several seconds · downloads about 8 GB' });
  }
  return options;
}

let serverProcess: ChildProcess | null = null;
let serverReady = false;
// Set when another process (a second app instance, or a server left behind by
// a crash) already serves the port; we use it but don't own or kill it.
let usingExternal = false;
let starting: Promise<boolean> | null = null;
let currentModel = DEFAULT_LOCAL_MODEL;
let onStatusChange: (() => void) | null = null;

export function setOnLocalLlmStatusChange(cb: () => void): void {
  onStatusChange = cb;
}

function findMlxServer(): string | null {
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'mlx_lm.server'),
    '/opt/homebrew/bin/mlx_lm.server',
    '/usr/local/bin/mlx_lm.server',
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  try {
    const resolved = execFileSync('which', ['mlx_lm.server'], { encoding: 'utf-8' }).trim();
    if (resolved) return resolved;
  } catch {}

  return null;
}

export function isMlxInstalled(): boolean {
  return findMlxServer() !== null;
}

export function getLocalModel(): string {
  return currentModel;
}

export function isLocalLlmRunning(): boolean {
  return serverReady && (usingExternal || (serverProcess !== null && !serverProcess.killed));
}

export function isLocalLlmStarting(): boolean {
  return starting !== null;
}

function checkServerHealth(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`${MLX_BASE_URL}/models`, { timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function waitForServer(timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!serverProcess) return false;
    if (await checkServerHealth()) return true;
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

// mlx_lm.server loads the weights on the first request, which takes several
// seconds (and downloads them on first use). Send a one-token request at
// startup so the first real dictation doesn't pay for it.
async function warmUp(): Promise<boolean> {
  const body = JSON.stringify({
    model: currentModel,
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 1,
  });
  return new Promise<boolean>((resolve) => {
    const req = http.request(
      `${MLX_BASE_URL}/chat/completions`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 30 * 60_000 },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode === 200)); },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end(body);
  });
}

export function startLocalLlm(model?: string): Promise<boolean> {
  if (model && model !== currentModel) {
    stopLocalLlm();
    currentModel = model;
  }
  if (isLocalLlmRunning()) return Promise.resolve(true);
  if (starting) return starting;

  starting = doStart().finally(() => {
    starting = null;
    onStatusChange?.();
  });
  onStatusChange?.();
  return starting;
}

async function doStart(): Promise<boolean> {
  const cliPath = findMlxServer();
  if (!cliPath) {
    console.error('[DictateAI] mlx_lm.server not found. Install with: uv tool install mlx-lm');
    return false;
  }

  // Spawning onto a busy port fails, and the health check would then be
  // answered by the other server — so detect that case up front and use it.
  if (await checkServerHealth()) {
    console.log(`[DictateAI] Reusing local LLM server already on port ${MLX_PORT}`);
    if (!(await warmUp())) {
      console.error('[DictateAI] Existing local LLM server failed to load the model.');
      return false;
    }
    usingExternal = true;
    serverReady = true;
    console.log('[DictateAI] Local LLM ready.');
    return true;
  }

  console.log(`[DictateAI] Starting local LLM server (model: ${currentModel})...`);

  const proc = spawn(cliPath, [
    '--model', currentModel,
    '--host', MLX_HOST,
    '--port', String(MLX_PORT),
    '--log-level', 'WARNING',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  serverProcess = proc;

  const log = (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(`[MLX] ${line}`);
  };
  proc.stdout?.on('data', log);
  proc.stderr?.on('data', log);

  proc.on('exit', (code) => {
    console.log(`[DictateAI] Local LLM server exited (code: ${code})`);
    if (serverProcess === proc) {
      serverReady = false;
      serverProcess = null;
      onStatusChange?.();
    }
  });

  if (!(await waitForServer(60_000))) {
    console.error('[DictateAI] Local LLM server failed to start within timeout.');
    stopLocalLlm();
    return false;
  }

  console.log('[DictateAI] Local LLM server up — loading model (downloads on first use)...');
  const warmed = await warmUp();
  if (serverProcess !== proc) return false;
  if (!warmed) {
    console.error('[DictateAI] Local LLM failed to load the model.');
    stopLocalLlm();
    return false;
  }

  serverReady = true;
  console.log('[DictateAI] Local LLM ready.');
  return true;
}

export function stopLocalLlm(): void {
  if (serverProcess && !serverProcess.killed) {
    console.log('[DictateAI] Stopping local LLM server...');
    serverProcess.kill('SIGTERM');
  }
  serverProcess = null;
  serverReady = false;
  usingExternal = false;
}
