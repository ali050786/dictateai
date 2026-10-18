import { spawn, ChildProcess, execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as http from 'http';
import { redact } from './log';

const WHISPERKIT_PORT = 50060;
const WHISPERKIT_HOST = 'localhost';
const WHISPERKIT_URL = `http://${WHISPERKIT_HOST}:${WHISPERKIT_PORT}`;
const DEFAULT_MODEL = 'small';

let serverProcess: ChildProcess | null = null;
let currentLanguage = 'auto';
let currentModel = DEFAULT_MODEL;
let serverReady = false;
let onStatusChange: (() => void) | null = null;

export function setOnStatusChange(cb: () => void): void {
  onStatusChange = cb;
}

function findWhisperKitCLI(): string | null {
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

export function setLanguage(lang: string): void {
  const changed = currentLanguage !== lang;
  currentLanguage = lang;
  if (changed && serverReady) {
    restartServer();
  }
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

export async function startServer(): Promise<boolean> {
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
    console.error('[DictateAI] WhisperKit CLI not found. Install with: brew install whisperkit-cli');
    return false;
  }

  console.log(`[DictateAI] Starting WhisperKit server (model: ${currentModel})...`);

  const args = [
    'serve',
    '--model', currentModel,
    '--port', String(WHISPERKIT_PORT),
    '--host', WHISPERKIT_HOST,
  ];

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

  serverProcess.on('exit', (code) => {
    console.log(`[DictateAI] WhisperKit server exited (code: ${code})`);
    serverReady = false;
    serverProcess = null;
  });

  console.log('[DictateAI] Waiting for WhisperKit server to be ready...');
  const ready = await waitForServer(300_000);

  if (ready) {
    serverReady = true;
    console.log('[DictateAI] WhisperKit server is ready.');
  } else {
    console.error('[DictateAI] WhisperKit server failed to start within timeout.');
    stopServer();
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
