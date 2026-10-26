import { spawn, ChildProcess, execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as http from 'http';
import * as net from 'net';
import { redact } from './log';
import { bundledPath, DownloadWatch, formatBytes } from './engines';
import { SPEECH_MODELS, SpeechChoice, SpeechEngine, SpeechModelKey, pickSpeechModel, speechModelFor as routeSpeechModel } from './speech-models';

// The speech server: Phonon (fermion-research on MLX, in the bundled Python)
// or WhisperKit, one at a time. speech-models.ts decides which model a
// language uses.

const WHISPERKIT_PORT = 50060;
const WHISPERKIT_HOST = 'localhost';
const WHISPERKIT_URL = `http://${WHISPERKIT_HOST}:${WHISPERKIT_PORT}`;
// WhisperKit's default download folder is ~/Documents/huggingface, which
// macOS blocks for apps without Documents access; keep models with our data.
const WHISPER_DIR = path.join(os.homedir(), '.dictateai', 'whisperkit');

const PHONON_HOST = '127.0.0.1';
// Picked free at each start, so a server left behind by a crash can't hold
// the port and make a good model look broken.
let phononPort = 0;
// Phonon's server answers only requests carrying this key, so a web page can't
// make the Mac transcribe and a server left behind by a crash isn't mistaken
// for ours. A new one every launch.
const PHONON_KEY = randomBytes(16).toString('hex');
// FERMION_CACHE_DIR: the download lands here, then the checksum-verified model
// is unpacked to speech/<org>__<name>/<profile>/ and the download deleted.
const PHONON_DIR = path.join(os.homedir(), '.dictateai', 'phonon');
const PHONON_REPOS: Partial<Record<SpeechModelKey, string>> = {
  phonon2: 'FermionResearch/Phonon-2',
  phonon25: 'FermionResearch/Phonon-2.5',
};
// How hard dictionary words pull the decoder (Phonon's default is 2). On a
// test clip 3 to 6 fixed "Hipriya" to "Hi Priya" and inserted none of six
// unrelated words; 8 also turned "Figma" into "Pigma".
const HOTWORD_LAMBDA = 4;
// Phonon uses the first 25.
const MAX_HOTWORDS = 25;

function engineOf(key: SpeechModelKey): SpeechEngine {
  return SPEECH_MODELS[key].engine;
}

function engineTag(key: SpeechModelKey): string {
  return engineOf(key) === 'phonon' ? '[Phonon]' : '[WhisperKit]';
}

function modelDir(key: SpeechModelKey): string {
  return engineOf(key) === 'phonon' ? PHONON_DIR : WHISPER_DIR;
}

function whisperFolder(id: string): string {
  return path.join(WHISPER_DIR, 'models', 'argmaxinc', 'whisperkit-coreml', `openai_whisper-${id}`);
}

// Hugging Face's downloader keeps unfinished files here with this suffix.
function whisperPendingFolder(id: string): string {
  const folder = whisperFolder(id);
  return path.join(path.dirname(folder), '.cache', 'huggingface', 'download', path.basename(folder));
}

function phononFolder(key: SpeechModelKey): string {
  return path.join(PHONON_DIR, 'speech', PHONON_REPOS[key]!.replace('/', '__'));
}

// The downloaded model, if every part of it is there, weights included.
// Starting from it skips the engines' check with Hugging Face, which fails
// offline.
function completeModelFolder(key: SpeechModelKey): string | null {
  return engineOf(key) === 'phonon' ? completePhononFolder(key) : completeWhisperFolder(SPEECH_MODELS[key].id);
}

// No file may still be half-downloaded either.
function completeWhisperFolder(id: string): string | null {
  const folder = whisperFolder(id);
  const parts = ['config.json'];
  for (const model of ['AudioEncoder', 'MelSpectrogram', 'TextDecoder']) {
    for (const file of ['coremldata.bin', 'model.mil', 'weights/weight.bin']) {
      parts.push(path.join(`${model}.mlmodelc`, file));
    }
  }
  if (!parts.every(part => fs.existsSync(path.join(folder, part)))) return null;
  return hasIncompleteFiles(whisperPendingFolder(id)) ? null : folder;
}

// Phonon unpacks only a download whose checksum matched; config.json and
// packed_manifest.json together mark a finished unpack (fermion's own test).
function completePhononFolder(key: SpeechModelKey): string | null {
  const repoDir = phononFolder(key);
  let profiles: string[];
  try {
    profiles = fs.readdirSync(repoDir);
  } catch {
    return null;
  }
  for (const profile of profiles) {
    const dir = path.join(repoDir, profile);
    if (fs.existsSync(path.join(dir, 'config.json')) && fs.existsSync(path.join(dir, 'packed_manifest.json'))) return dir;
  }
  return null;
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

// Hugging Face's downloader keeps its own copy of each Phonon download in
// blobs/ after fermion has unpacked it, about 150 MB a model that nothing
// reads again. Only called while no Phonon download is running.
function removePhononDownloads(): void {
  fs.rmSync(path.join(PHONON_DIR, 'blobs'), { recursive: true, force: true });
}

// Deletes a model so it's downloaded whole: both engines keep a damaged file
// that's already there.
function removeModel(key: SpeechModelKey): void {
  console.log(`[Utter] Removing damaged speech model ${SPEECH_MODELS[key].name} before downloading it again`);
  const folders = engineOf(key) === 'phonon'
    ? [phononFolder(key), path.join(PHONON_DIR, `models--${PHONON_REPOS[key]!.replace('/', '--')}`)]
    : [whisperFolder(SPEECH_MODELS[key].id), whisperPendingFolder(SPEECH_MODELS[key].id)];
  for (const folder of folders) fs.rmSync(folder, { recursive: true, force: true });
}

// Models that failed to load this session (a damaged download). They count
// as not on disk until a fresh download loads.
const brokenModels = new Set<SpeechModelKey>();

export function isSpeechModelOnDisk(key: SpeechModelKey): boolean {
  return !brokenModels.has(key) && isSpeechEngineInstalled(key) && completeModelFolder(key) !== null;
}

export function isSpeechModelBroken(key: SpeechModelKey): boolean {
  return brokenModels.has(key);
}

// The model the user's choice and language want, given which engines ship.
export function speechModelFor(choice: SpeechChoice, language: string): SpeechModelKey {
  return routeSpeechModel(choice, language, findPhonon() !== null);
}

// The model to run: the wanted one if it's on disk; otherwise one already on
// disk that handles the language, so a download never leaves dictation dead
// (Settings offers Whisper's; main.ts fetches Phonon's, which are small).
export function effectiveSpeechModel(choice: SpeechChoice, language: string): SpeechModelKey {
  return pickSpeechModel(speechModelFor(choice, language), language, isSpeechModelOnDisk);
}

let serverProcess: ChildProcess | null = null;
let currentLanguage = 'auto';
let currentModel: SpeechModelKey = 'fast';
let serverReady = false;
let onStatusChange: (() => void) | null = null;
const notify = () => onStatusChange?.();
// The server's own first-run download, and a model being fetched in the
// background while the current one keeps serving.
let download = new DownloadWatch(WHISPER_DIR, SPEECH_MODELS.fast.bytes, notify);
let preparing: { key: SpeechModelKey; watch: DownloadWatch; done: Promise<boolean> } | null = null;
// Whether the last start ended without a running server (shown in Settings).
let lastStartFailed = false;
let onModelReady: ((key: SpeechModelKey) => void) | null = null;

// Called when a background download (or repair) leaves a model ready to use.
export function setOnSpeechModelReady(cb: (key: SpeechModelKey) => void): void {
  onModelReady = cb;
}

// Set between a crash (or a restart) and the start that follows.
let restartPending = false;
let crashRestarts: number[] = [];
// Above zero while a start is under way, including the switch to another
// model after one fails to load, so a dictation made meanwhile waits.
let starting = 0;

export function isServerStarting(): boolean {
  return (serverProcess !== null && !serverReady) || restartPending || starting > 0;
}

export function didServerFail(): boolean {
  return lastStartFailed && !serverProcess;
}

export function setOnStatusChange(cb: () => void): void {
  onStatusChange = cb;
}

interface Command {
  cmd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
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

// The bundled Python with fermion-research; in dev without it, a `fermion`
// from `uv tool install fermion-research`. Looked up once: it doesn't change
// while the app runs.
let phononCommand: Command | null | undefined;

function findPhonon(): Command | null {
  if (phononCommand !== undefined) return phononCommand;
  phononCommand = null;
  const python = bundledPath('python', 'bin', 'python3');
  const lib = bundledPath('python', 'lib');
  try {
    if (python && lib && fs.readdirSync(lib).some(dir => fs.existsSync(path.join(lib, dir, 'site-packages', 'fermion')))) {
      phononCommand = { cmd: python, args: ['-m', 'fermion.cli'] };
      return phononCommand;
    }
  } catch {}
  try {
    const resolved = execFileSync('which', ['fermion'], { encoding: 'utf-8' }).trim();
    if (resolved) phononCommand = { cmd: resolved, args: [] };
  } catch {}
  return phononCommand;
}

// Phonon's models live with our data. Once one is on disk it starts without
// asking Hugging Face, so it works offline.
function phononEnv(offline: boolean): NodeJS.ProcessEnv {
  return { ...process.env, FERMION_CACHE_DIR: PHONON_DIR, ...(offline ? { HF_HUB_OFFLINE: '1' } : {}) };
}

// With no key, whether any engine is there; with one, that model's engine.
export function isSpeechEngineInstalled(key?: SpeechModelKey): boolean {
  if (!key) return findWhisperKitCLI() !== null || findPhonon() !== null;
  return engineOf(key) === 'phonon' ? findPhonon() !== null : findWhisperKitCLI() !== null;
}

// While a speech model downloads: how far along, and how big it is.
export function getModelDownload(): { percent: number; size: string } | null {
  if (download.percent != null) {
    return { percent: download.percent, size: formatBytes(SPEECH_MODELS[currentModel].bytes) };
  }
  if (preparing?.watch.percent != null) {
    return { percent: preparing.watch.percent, size: formatBytes(SPEECH_MODELS[preparing.key].bytes) };
  }
  return null;
}

export function getPreparingSpeechModel(): SpeechModelKey | null {
  return preparing?.key ?? null;
}

// Language and model for the server; restarts it when the model changes, or
// the language for Whisper (Phonon hears the language from the audio).
export function configureSpeech(lang: string, key: SpeechModelKey): void {
  const changed = currentModel !== key || (engineOf(key) === 'whisper' && currentLanguage !== lang);
  currentLanguage = lang;
  currentModel = key;
  if (changed && (serverReady || serverProcess)) {
    restartServer();
  }
}

export function getSpeechModel(): SpeechModelKey {
  return currentModel;
}

// A one-off transcription of `audio`, which downloads the model and loads it.
function transcribeOnceCommand(key: SpeechModelKey, audio: string): Command | null {
  const { id } = SPEECH_MODELS[key];
  if (engineOf(key) === 'phonon') {
    const phonon = findPhonon();
    return phonon && { cmd: phonon.cmd, args: [...phonon.args, 'transcribe', id, audio], env: phononEnv(false) };
  }
  const cliPath = findWhisperKitCLI();
  if (!cliPath) return null;
  return {
    cmd: cliPath,
    args: [
      'transcribe',
      '--model', id,
      '--download-model-path', WHISPER_DIR,
      '--download-tokenizer-path', WHISPER_DIR,
      '--audio-path', audio,
    ],
  };
}

// Downloads a model (and loads it once, so its first real use is quick)
// with a one-off transcription of silence, while the server keeps running
// on the current model. Resolves true once the model is complete on disk.
export function prepareSpeechModel(key: SpeechModelKey): Promise<boolean> {
  if (isSpeechModelOnDisk(key)) return Promise.resolve(true);
  if (preparing?.key === key) return preparing.done;
  const silence = path.join(os.tmpdir(), 'utter-silence.wav');
  const command = transcribeOnceCommand(key, silence);
  if (!command) return Promise.resolve(false);

  const { name, bytes } = SPEECH_MODELS[key];
  if (brokenModels.has(key)) removeModel(key);
  fs.writeFileSync(silence, float32ToWav(new Float32Array(16000), 16000));
  fs.mkdirSync(modelDir(key), { recursive: true });

  const watch = new DownloadWatch(modelDir(key), bytes, notify);
  watch.begin();
  console.log(`[Utter] Downloading speech model ${name} in the background...`);
  const proc = spawn(command.cmd, command.args, { stdio: ['ignore', 'ignore', 'pipe'], env: command.env });
  proc.stderr?.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(`${engineTag(key)} ${line}`);
  });

  const done = new Promise<boolean>((resolve) => {
    const finish = (ok: boolean) => {
      watch.end();
      preparing = null;
      console.log(`[Utter] Speech model ${name} ${ok ? 'ready' : 'download failed'}`);
      notify();
      if (ok) onModelReady?.(key);
      resolve(ok);
    };
    proc.on('exit', (code) => {
      // Exit 0 means the engine downloaded the model and loaded it.
      if (code === 0) brokenModels.delete(key);
      finish(code === 0 && isSpeechModelOnDisk(key));
    });
    proc.on('error', () => finish(false));
  });
  preparing = { key, watch, done };
  notify();
  return done;
}

export async function restartServer(): Promise<boolean> {
  console.log(`[Utter] Restarting speech server (${SPEECH_MODELS[currentModel].name}, language: ${currentLanguage})...`);
  stopServer();
  // Counts as starting, so a dictation finished meanwhile waits instead of failing.
  restartPending = true;
  await new Promise(r => setTimeout(r, 1000));
  restartPending = false;
  return startServer();
}

export function getLanguage(): string {
  return currentLanguage;
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

// WhisperKit answers any request once it's up. Phonon listens only once its
// model is loaded, and must answer our key with the model we asked for.
function checkServerHealth(): Promise<boolean> {
  const key = currentModel;
  const phonon = engineOf(key) === 'phonon';
  return new Promise((resolve) => {
    const req = phonon
      ? http.get({
        hostname: PHONON_HOST,
        port: phononPort,
        path: '/v1/models',
        headers: { Authorization: `Bearer ${PHONON_KEY}` },
        timeout: 2000,
      }, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            resolve(res.statusCode === 200 && JSON.parse(data).data?.[0]?.id === PHONON_REPOS[key]);
          } catch {
            resolve(false);
          }
        });
      })
      : http.get(`${WHISPERKIT_URL}/v1/audio/transcriptions`, { timeout: 2000 }, (res) => {
        res.resume();
        resolve(res.statusCode !== undefined);
      });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, PHONON_HOST, () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

function serverCommand(key: SpeechModelKey, localFolder: string | null): Command | null {
  if (engineOf(key) === 'phonon') {
    const phonon = findPhonon();
    return phonon && {
      cmd: phonon.cmd,
      args: [
        ...phonon.args,
        'serve', SPEECH_MODELS[key].id,
        '--host', PHONON_HOST,
        '--port', String(phononPort),
        '--api-key', PHONON_KEY,
      ],
      env: phononEnv(localFolder !== null),
    };
  }
  const cliPath = findWhisperKitCLI();
  if (!cliPath) return null;
  const args = [
    'serve',
    ...(localFolder
      ? ['--model-path', localFolder]
      : ['--model', SPEECH_MODELS[key].id, '--download-model-path', WHISPER_DIR]),
    '--port', String(WHISPERKIT_PORT),
    '--host', WHISPERKIT_HOST,
    '--download-tokenizer-path', WHISPER_DIR,
  ];
  if (currentLanguage !== 'auto') {
    args.push('--language', currentLanguage);
  }
  return { cmd: cliPath, args };
}

export async function startServer(forceDownload = false): Promise<boolean> {
  starting++;
  try {
    return await launchServer(forceDownload);
  } finally {
    starting--;
  }
}

async function launchServer(forceDownload: boolean): Promise<boolean> {
  if (serverProcess && !serverProcess.killed) {
    const health = await checkServerHealth();
    if (health) {
      serverReady = true;
      return true;
    }
    serverProcess.kill();
    serverProcess = null;
  }

  const key = currentModel;
  const { name, bytes } = SPEECH_MODELS[key];
  if (forceDownload) removeModel(key);
  const localFolder = completeModelFolder(key);
  if (engineOf(key) === 'phonon') phononPort = await freePort();
  const command = serverCommand(key, localFolder);
  if (!command) {
    console.error(`[Utter] Speech engine for ${name} not found. Run scripts/build-engines.sh`);
    return false;
  }
  console.log(`[Utter] Starting speech server (model: ${name}, ${localFolder ? 'on disk' : 'download if needed'})...`);
  fs.mkdirSync(modelDir(key), { recursive: true });
  if (engineOf(key) === 'phonon' && localFolder && !preparing) removePhononDownloads();

  serverProcess = spawn(command.cmd, command.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    env: command.env,
  });

  const log = (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(`${engineTag(key)} ${line}`);
  };
  serverProcess.stdout?.on('data', log);
  serverProcess.stderr?.on('data', log);

  const proc = serverProcess;
  proc.on('exit', (code) => {
    console.log(`[Utter] Speech server (${name}) exited (code: ${code})`);
    // stopServer() clears serverProcess first, so a deliberate stop ends here.
    if (serverProcess !== proc) return;
    const wasReady = serverReady;
    serverReady = false;
    serverProcess = null;
    // It stopped on its own after working: start it again, a few times at most.
    if (wasReady) {
      const now = Date.now();
      crashRestarts = crashRestarts.filter(t => now - t < 10 * 60_000);
      if (crashRestarts.length < 3) {
        crashRestarts.push(now);
        restartPending = true;
        console.log('[Utter] Speech server stopped unexpectedly — restarting');
        setTimeout(() => {
          restartPending = false;
          if (!serverProcess) void startServer();
        }, 2000);
      } else {
        lastStartFailed = true;
      }
    }
    notify();
  });

  console.log(`[Utter] Waiting for ${name} to be ready...`);
  // The first start downloads the model, which can take a while on a slow connection.
  download.end();
  download = new DownloadWatch(modelDir(key), bytes, notify);
  download.begin();
  const ready = await waitForServer(30 * 60_000).finally(() => download.end());

  if (ready) {
    serverReady = true;
    lastStartFailed = false;
    // The first request after a start is slow (3.8s for Phonon-2, then 0.2s),
    // so spend it on a second of silence rather than on a dictation.
    await transcribe(new Float32Array(16000)).catch(() => {});
    console.log(`[Utter] ${name} is ready.`);
  } else {
    console.error(`[Utter] ${name} failed to start within timeout.`);
    stopServer();
    if (localFolder) {
      // The model on disk didn't load (a damaged download). Keep dictation
      // working on another model that handles the language if there is one,
      // and fetch this one again in the background; otherwise right away.
      brokenModels.add(key);
      const fallback = pickSpeechModel(key, currentLanguage, isSpeechModelOnDisk);
      if (fallback !== key) {
        console.log(`[Utter] ${name} didn't load — using ${SPEECH_MODELS[fallback].name} while it downloads again`);
        currentModel = fallback;
        void prepareSpeechModel(key);
        return launchServer(false);
      }
      console.log(`[Utter] Retrying ${name} with a fresh download...`);
      return launchServer(true);
    }
    lastStartFailed = true;
  }

  onStatusChange?.();
  return ready;
}

export function stopServer(): void {
  if (serverProcess && !serverProcess.killed) {
    console.log('[Utter] Stopping speech server...');
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
    // Not starting, and no restart on the way after a crash.
    if (!serverProcess && !restartPending && starting === 0) return false;
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

// `hotwords`: names and terms (from the dictionary) that Phonon favours when
// the audio is close. Whisper doesn't take them.
export async function transcribe(audioSamples: Float32Array, hotwords: string[] = []): Promise<string> {
  if (!serverReady) {
    throw new Error('The speech server is not running. Call startServer() first.');
  }

  const { engine, id, name } = SPEECH_MODELS[currentModel];
  const phonon = engine === 'phonon';
  const wavBuffer = float32ToWav(audioSamples, 16000);

  const boundary = `----Utter${Date.now()}`;
  const bodyParts: Buffer[] = [];

  const addField = (fieldName: string, value: string) => {
    bodyParts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"\r\n\r\n${value}\r\n`
    ));
  };

  addField('model', id);
  // Phonon hears the language from the audio.
  if (!phonon && currentLanguage !== 'auto') {
    addField('language', currentLanguage);
  }
  addField('response_format', 'json');
  if (phonon && hotwords.length > 0) {
    addField('hotwords', JSON.stringify(hotwords.slice(0, MAX_HOTWORDS)));
    addField('hotword_lambda', String(HOTWORD_LAMBDA));
  }

  bodyParts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`
  ));
  bodyParts.push(wavBuffer);
  bodyParts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const body = Buffer.concat(bodyParts);

  const result = await new Promise<string>((resolve, reject) => {
    const req = http.request({
      hostname: phonon ? PHONON_HOST : WHISPERKIT_HOST,
      port: phonon ? phononPort : WHISPERKIT_PORT,
      path: '/v1/audio/transcriptions',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
        ...(phonon ? { Authorization: `Bearer ${PHONON_KEY}` } : {}),
      },
      timeout: 30_000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          console.error(`[Utter] ${name} answered ${res.statusCode}`);
          reject(new Error(`${name} request failed (${res.statusCode})`));
          return;
        }
        try {
          const json = JSON.parse(data);
          resolve(json.text || '');
        } catch {
          console.error(`[Utter] ${name} response parse error:`, data);
          reject(new Error(`Failed to parse the ${name} response`));
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error(`${name} request timeout`)); });
    req.write(body);
    req.end();
  });

  console.log(`[Utter] ${name} transcript: ${redact(result)}`);
  return result;
}
