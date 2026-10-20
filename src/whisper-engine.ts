import { spawn, ChildProcess, execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as http from 'http';
import { redact } from './log';
import { bundledPath, DownloadWatch, formatBytes } from './engines';

const WHISPERKIT_PORT = 50060;
const WHISPERKIT_HOST = 'localhost';
const WHISPERKIT_URL = `http://${WHISPERKIT_HOST}:${WHISPERKIT_PORT}`;
// WhisperKit's default download folder is ~/Documents/huggingface, which
// macOS blocks for apps without Documents access; keep models with our data.
const MODEL_DIR = path.join(os.homedir(), '.dictateai', 'whisperkit');

// Speech models. Small is fast and fine for English. On Hindi, Small
// translated the speech into (wrong) English, while Large v3 Turbo, a
// compressed build only ~160 MB bigger, kept it in Devanagari and nearly
// right: 0.4s vs 1.8s for a sentence, and 0.4s vs 0.7s in English.
export type SpeechModelKey = 'fast' | 'accurate';
export type SpeechChoice = 'auto' | SpeechModelKey;
export const SPEECH_MODELS: Record<SpeechModelKey, { id: string; name: string; bytes: number }> = {
  fast: { id: 'small', name: 'Whisper Small', bytes: 486_500_000 },
  accurate: { id: 'large-v3-v20240930_turbo_632MB', name: 'Whisper Large v3 Turbo', bytes: 646_000_000 },
};

// Automatic: Small for English, Turbo for every other language and for
// auto-detect (which may hear any language).
export function speechModelFor(choice: SpeechChoice, language: string): SpeechModelKey {
  if (choice !== 'auto') return choice;
  return language === 'en' ? 'fast' : 'accurate';
}

function modelFolder(id: string): string {
  return path.join(MODEL_DIR, 'models', 'argmaxinc', 'whisperkit-coreml', `openai_whisper-${id}`);
}

// The downloaded model, if every part of it is there, weights included,
// and no file is still half-downloaded. Starting from this folder skips
// WhisperKit's check with Hugging Face, which fails offline.
function completeModelFolder(id: string): string | null {
  const folder = modelFolder(id);
  const parts = ['config.json'];
  for (const model of ['AudioEncoder', 'MelSpectrogram', 'TextDecoder']) {
    for (const file of ['coremldata.bin', 'model.mil', 'weights/weight.bin']) {
      parts.push(path.join(`${model}.mlmodelc`, file));
    }
  }
  if (!parts.every(part => fs.existsSync(path.join(folder, part)))) return null;
  // Hugging Face's downloader keeps unfinished files here with this suffix.
  const pending = path.join(path.dirname(folder), '.cache', 'huggingface', 'download', path.basename(folder));
  return hasIncompleteFiles(pending) ? null : folder;
}

function hasIncompleteFiles(dir: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some(entry => entry.isDirectory()
    ? hasIncompleteFiles(path.join(dir, entry.name))
    : entry.name.endsWith('.incomplete'));
}

// Models that failed to load this session (a damaged download). They count
// as not on disk until a fresh download loads.
const brokenModels = new Set<string>();

export function isSpeechModelOnDisk(key: SpeechModelKey): boolean {
  const { id } = SPEECH_MODELS[key];
  return !brokenModels.has(id) && completeModelFolder(id) !== null;
}

export function isSpeechModelBroken(key: SpeechModelKey): boolean {
  return brokenModels.has(SPEECH_MODELS[key].id);
}

// The model to run: the wanted one if it's on disk; otherwise one already
// on disk, so a bigger download is never started without asking (Settings
// offers it); with none on disk (first run), the wanted one, downloaded.
export function effectiveSpeechModel(choice: SpeechChoice, language: string): SpeechModelKey {
  const wanted = speechModelFor(choice, language);
  if (isSpeechModelOnDisk(wanted)) return wanted;
  const other: SpeechModelKey = wanted === 'fast' ? 'accurate' : 'fast';
  return isSpeechModelOnDisk(other) ? other : wanted;
}

function keyForId(id: string): SpeechModelKey {
  return id === SPEECH_MODELS.accurate.id ? 'accurate' : 'fast';
}

let serverProcess: ChildProcess | null = null;
let currentLanguage = 'auto';
let currentModel = SPEECH_MODELS.fast.id;
let serverReady = false;
let onStatusChange: (() => void) | null = null;
const notify = () => onStatusChange?.();
// The server's own first-run download, and a model being fetched in the
// background while the current one keeps serving.
let download = new DownloadWatch(MODEL_DIR, SPEECH_MODELS.fast.bytes, notify);
let preparing: { key: SpeechModelKey; watch: DownloadWatch; done: Promise<boolean> } | null = null;
// Whether the last start ended without a running server (shown in Settings).
let lastStartFailed = false;
let onModelReady: ((key: SpeechModelKey) => void) | null = null;

// Called when a background download (or repair) leaves a model ready to use.
export function setOnSpeechModelReady(cb: (key: SpeechModelKey) => void): void {
  onModelReady = cb;
}

export function isServerStarting(): boolean {
  return serverProcess !== null && !serverReady;
}

export function didServerFail(): boolean {
  return lastStartFailed && !serverProcess;
}

export function setOnStatusChange(cb: () => void): void {
  onStatusChange = cb;
}

// The copy bundled in the app first; in dev without engines/, a Homebrew install.
function findWhisperKitCLI(): string | null {
  const bundled = bundledPath('bin', 'whisperkit-cli');
  if (bundled) return bundled;

  const candidates = [
    '/opt/homebrew/bin/whisperkit-cli',
    '/usr/local/bin/whisperkit-cli',
    path.join(os.homedir(), '.local', 'bin', 'whisperkit-cli'),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  try {
    const resolved = execFileSync('which', ['whisperkit-cli'], { encoding: 'utf-8' }).trim();
    if (resolved) return resolved;
  } catch {}

  return null;
}

export function isWhisperKitInstalled(): boolean {
  return findWhisperKitCLI() !== null;
}

// While a speech model downloads: how far along, and how big it is.
export function getModelDownload(): { percent: number; size: string } | null {
  if (download.percent != null) {
    return { percent: download.percent, size: formatBytes(SPEECH_MODELS[keyForId(currentModel)].bytes) };
  }
  if (preparing?.watch.percent != null) {
    return { percent: preparing.watch.percent, size: formatBytes(SPEECH_MODELS[preparing.key].bytes) };
  }
  return null;
}

export function getPreparingSpeechModel(): SpeechModelKey | null {
  return preparing?.key ?? null;
}

// Language and model for the server; restarts it when either changes.
export function configureSpeech(lang: string, key: SpeechModelKey): void {
  const id = SPEECH_MODELS[key].id;
  const changed = currentLanguage !== lang || currentModel !== id;
  currentLanguage = lang;
  currentModel = id;
  if (changed && (serverReady || serverProcess)) {
    restartServer();
  }
}

export function getSpeechModel(): SpeechModelKey {
  return keyForId(currentModel);
}

// Downloads a model (and loads it once, so its first real use is quick)
// with a one-off transcription of silence, while the server keeps running
// on the current model. Resolves true once the model is complete on disk.
export function prepareSpeechModel(key: SpeechModelKey): Promise<boolean> {
  if (isSpeechModelOnDisk(key)) return Promise.resolve(true);
  if (preparing?.key === key) return preparing.done;
  const cliPath = findWhisperKitCLI();
  if (!cliPath) return Promise.resolve(false);

  const { id, bytes } = SPEECH_MODELS[key];
  // WhisperKit keeps a damaged file that's already there, so a model that
  // failed to load is removed first and downloaded whole.
  if (brokenModels.has(id)) {
    const folder = modelFolder(id);
    const pending = path.join(path.dirname(folder), '.cache', 'huggingface', 'download', path.basename(folder));
    console.log(`[DictateAI] Removing damaged speech model ${id} before downloading it again`);
    fs.rmSync(folder, { recursive: true, force: true });
    fs.rmSync(pending, { recursive: true, force: true });
  }
  const silence = path.join(os.tmpdir(), 'dictateai-silence.wav');
  fs.writeFileSync(silence, float32ToWav(new Float32Array(16000), 16000));
  fs.mkdirSync(MODEL_DIR, { recursive: true });

  const watch = new DownloadWatch(MODEL_DIR, bytes, notify);
  watch.begin();
  console.log(`[DictateAI] Downloading speech model ${id} in the background...`);
  const proc = spawn(cliPath, [
    'transcribe',
    '--model', id,
    '--download-model-path', MODEL_DIR,
    '--download-tokenizer-path', MODEL_DIR,
    '--audio-path', silence,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr?.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(`[WhisperKit] ${line}`);
  });

  const done = new Promise<boolean>((resolve) => {
    const finish = (ok: boolean) => {
      watch.end();
      preparing = null;
      console.log(`[DictateAI] Speech model ${id} ${ok ? 'ready' : 'download failed'}`);
      notify();
      if (ok) onModelReady?.(key);
      resolve(ok);
    };
    proc.on('exit', (code) => {
      // Exit 0 means WhisperKit downloaded the model and loaded it.
      if (code === 0) brokenModels.delete(id);
      finish(code === 0 && isSpeechModelOnDisk(key));
    });
    proc.on('error', () => finish(false));
  });
  preparing = { key, watch, done };
  notify();
  return done;
}

export async function restartServer(): Promise<boolean> {
  console.log(`[DictateAI] Restarting WhisperKit server (language: ${currentLanguage})...`);
  stopServer();
  await new Promise(r => setTimeout(r, 1000));
  return startServer();
}

export function getLanguage(): string {
  return currentLanguage;
}

export function getModel(): string {
  return currentModel;
}

export function isModelDownloaded(): boolean {
  return isWhisperKitInstalled();
}

export async function downloadModel(
  onProgress?: (percent: number) => void,
): Promise<void> {
  onProgress?.(100);
}

async function waitForServer(timeoutMs = 60_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // The server exited (a failed download, a bad model): stop waiting.
    if (!serverProcess) return false;
    try {
      const ok = await checkServerHealth();
      if (ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

function checkServerHealth(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`${WHISPERKIT_URL}/v1/audio/transcriptions`, { timeout: 2000 }, (res) => {
      resolve(res.statusCode !== undefined);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

export async function startServer(forceDownload = false): Promise<boolean> {
  if (serverProcess && !serverProcess.killed) {
    const health = await checkServerHealth();
    if (health) {
      serverReady = true;
      return true;
    }
    serverProcess.kill();
    serverProcess = null;
  }

  const cliPath = findWhisperKitCLI();
  if (!cliPath) {
    console.error('[DictateAI] Speech engine not found. Run scripts/build-engines.sh, or: brew install whisperkit-cli');
    return false;
  }

  const localFolder = forceDownload ? null : completeModelFolder(currentModel);
  console.log(`[DictateAI] Starting WhisperKit server (model: ${currentModel}, ${localFolder ? 'on disk' : 'download if needed'})...`);

  const args = [
    'serve',
    ...(localFolder
      ? ['--model-path', localFolder]
      : ['--model', currentModel, '--download-model-path', MODEL_DIR]),
    '--port', String(WHISPERKIT_PORT),
    '--host', WHISPERKIT_HOST,
    '--download-tokenizer-path', MODEL_DIR,
  ];
  fs.mkdirSync(MODEL_DIR, { recursive: true });

  if (currentLanguage !== 'auto') {
    args.push('--language', currentLanguage);
  }

  serverProcess = spawn(cliPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  serverProcess.stdout?.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(`[WhisperKit] ${line}`);
  });

  serverProcess.stderr?.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(`[WhisperKit] ${line}`);
  });

  const proc = serverProcess;
  proc.on('exit', (code) => {
    console.log(`[DictateAI] WhisperKit server exited (code: ${code})`);
    if (serverProcess !== proc) return;
    serverReady = false;
    serverProcess = null;
    notify();
  });

  console.log('[DictateAI] Waiting for WhisperKit server to be ready...');
  // The first start downloads the model, which can take a while on a slow connection.
  download.end();
  download = new DownloadWatch(MODEL_DIR, SPEECH_MODELS[keyForId(currentModel)].bytes, notify);
  download.begin();
  const ready = await waitForServer(30 * 60_000).finally(() => download.end());

  if (ready) {
    serverReady = true;
    lastStartFailed = false;
    console.log('[DictateAI] WhisperKit server is ready.');
  } else {
    console.error('[DictateAI] WhisperKit server failed to start within timeout.');
    stopServer();
    if (localFolder) {
      // The model on disk didn't load (a damaged download). Keep dictation
      // working on the other model if there is one, and fetch this one
      // again in the background; otherwise fetch it again right away.
      brokenModels.add(currentModel);
      const failed = keyForId(currentModel);
      const other: SpeechModelKey = failed === 'fast' ? 'accurate' : 'fast';
      if (isSpeechModelOnDisk(other)) {
        console.log(`[DictateAI] ${SPEECH_MODELS[failed].name} didn't load — using ${SPEECH_MODELS[other].name} while it downloads again`);
        currentModel = SPEECH_MODELS[other].id;
        void prepareSpeechModel(failed);
        return startServer();
      }
      console.log('[DictateAI] Retrying WhisperKit with a fresh model download...');
      return startServer(true);
    }
    lastStartFailed = true;
  }

  onStatusChange?.();
  return ready;
}

export function stopServer(): void {
  if (serverProcess && !serverProcess.killed) {
    console.log('[DictateAI] Stopping WhisperKit server...');
    serverProcess.kill('SIGTERM');
    serverProcess = null;
    serverReady = false;
  }
}

export function isServerRunning(): boolean {
  return serverReady && serverProcess !== null && !serverProcess.killed;
}

// Resolves true once the server is ready, or false if it isn't starting (no
// process) or doesn't become ready in time. Lets a dictation made while the
// model downloads or loads wait instead of failing.
export async function whenServerReady(timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isServerRunning()) return true;
    if (!serverProcess) return false;
    await new Promise(r => setTimeout(r, 250));
  }
  return isServerRunning();
}

function float32ToWav(samples: Float32Array, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = samples.length * (bitsPerSample / 8);
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }

  return buffer;
}

export async function transcribe(audioSamples: Float32Array): Promise<string> {
  if (!serverReady) {
    throw new Error('WhisperKit server is not running. Call startServer() first.');
  }

  const wavBuffer = float32ToWav(audioSamples, 16000);

  const boundary = `----DictateAI${Date.now()}`;
  const bodyParts: Buffer[] = [];

  const addField = (name: string, value: string) => {
    bodyParts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
    ));
  };

  addField('model', currentModel);
  if (currentLanguage !== 'auto') {
    addField('language', currentLanguage);
  }
  addField('response_format', 'json');

  bodyParts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`
  ));
  bodyParts.push(wavBuffer);
  bodyParts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const body = Buffer.concat(bodyParts);

  const result = await new Promise<string>((resolve, reject) => {
    const req = http.request({
      hostname: WHISPERKIT_HOST,
      port: WHISPERKIT_PORT,
      path: '/v1/audio/transcriptions',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
      timeout: 30_000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.text || '');
        } catch {
          console.error('[DictateAI] WhisperKit response parse error:', data);
          reject(new Error('Failed to parse WhisperKit response'));
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('WhisperKit request timeout')); });
    req.write(body);
    req.end();
  });

  console.log(`[DictateAI] WhisperKit transcript: ${redact(result)}`);
  return result;
}
