import './index.css';
import startCueSrc from '../assets/sounds/start.wav';
import stopCueSrc from '../assets/sounds/stop.wav';
import { samplesToSkip } from './cue-timing';
import { PillView } from './pill-view';

interface DictateAPI {
  sendAudioChunk: (session: number, data: ArrayBuffer, final: boolean) => void;
  onCapture: (callback: (command: 'start' | 'flush', session: number) => void) => () => void;
  getState: () => Promise<string>;
  onStateChange: (callback: (state: string) => void) => () => void;
  onPreview: (callback: (text: string) => void) => () => void;
  onHandsfree: (callback: (active: boolean) => void) => () => void;
  onCue: (callback: (cue: 'start' | 'stop') => void) => () => void;
  getAudioDevice: () => Promise<string>;
  onAudioDeviceChanged: (callback: (deviceId: string) => void) => () => void;
  stopRecording: () => void;
  setClickable: (clickable: boolean) => void;
  onPosition: (callback: (position: string) => void) => () => void;
}

declare global {
  interface Window {
    dictateAI: DictateAPI;
  }
}

let audioContext: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let workletNode: AudioWorkletNode | null = null;
let analyserNode: AnalyserNode | null = null;
let audioReady = false;
let currentState = 'idle';
let selectedDeviceId = '';
// The recording main.ts is capturing for; every chunk carries it.
let captureSession = 0;
// Goes up whenever capture starts or stops. A capture still waiting for the
// microphone checks it, so one that is no longer wanted never connects.
let captureGeneration = 0;

const view = new PillView();
const closeBtn = document.getElementById('close-btn')!;

// --- Start and stop sounds ---
// Played in this window because it's the one that records: when capture
// starts it drops whatever audio arrives while the start sound is still
// playing (samplesToSkip), so the sound is never transcribed. They get
// their own AudioContext at the speakers' rate; capture runs at 16 kHz.
const cues = {
  context: null as AudioContext | null,
  buffers: {} as Partial<Record<'start' | 'stop', AudioBuffer>>,
  // performance.now() time the last sound stops being heard.
  audibleUntil: 0,
  idleTimer: null as ReturnType<typeof setTimeout> | null,
};

async function loadCues(): Promise<void> {
  const context = new AudioContext({ latencyHint: 'interactive' });
  const sources = { start: startCueSrc, stop: stopCueSrc };
  for (const name of ['start', 'stop'] as const) {
    const src = sources[name];
    const bytes = Uint8Array.from(atob(src.slice(src.indexOf(',') + 1)), (c) => c.charCodeAt(0));
    cues.buffers[name] = await context.decodeAudioData(bytes.buffer);
  }
  cues.context = context;
  // Idle until the first dictation; a running context keeps the audio
  // device busy.
  await context.suspend();
}

async function playCue(name: 'start' | 'stop'): Promise<void> {
  const { context } = cues;
  const buffer = cues.buffers[name];
  if (!context || !buffer) return;
  if (cues.idleTimer) {
    clearTimeout(cues.idleTimer);
    cues.idleTimer = null;
  }
  // A guess until it's playing, in case capture starts first. The stop sound
  // counts too: the next recording can start while it plays.
  cues.audibleUntil = Math.max(cues.audibleUntil, performance.now() + buffer.duration * 1000 + 100);
  if (context.state !== 'running') await context.resume();
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.start();
  // outputLatency reads 0 until the device has started; assume 40 ms then.
  const latency = context.baseLatency + (context.outputLatency || 0.04);
  cues.audibleUntil = performance.now() + (buffer.duration + latency) * 1000;
  source.onended = () => {
    if (cues.idleTimer) clearTimeout(cues.idleTimer);
    cues.idleTimer = setTimeout(() => {
      cues.idleTimer = null;
      context.suspend();
    }, 3000);
  };
}

loadCues().catch((err) => console.error('[DictateAI] Could not load sounds:', err));

function updateUI(fullState: string): void {
  const state = view.setState(fullState);
  currentState = state;
  // The microphone closes when transcribing starts and when the pill hides
  // (idle, or a state it doesn't show); notes leave it alone.
  if (state === 'recording') startAudioCapture(true);
  else if (state === 'processing' || state === 'preparing' || !view.shows(state)) stopAudioCapture();
}

// The microphone's loudness for the orb and its wave, 0 to 1: -50 dBFS (room
// noise) and below is 0, -15 dBFS (speaking up close) and above is 1.
const levelSamples = new Float32Array(512);
function micLevel(): number {
  if (!analyserNode) return 0;
  analyserNode.getFloatTimeDomainData(levelSamples);
  let sum = 0;
  for (const s of levelSamples) sum += s * s;
  const rms = Math.sqrt(sum / levelSamples.length);
  const db = 20 * Math.log10(rms || 1e-6);
  return Math.min(1, Math.max(0, (db + 50) / 35));
}

async function ensureAudioContext(): Promise<void> {
  if (audioReady && audioContext && audioContext.state !== 'closed') return;

  audioContext = new AudioContext({ sampleRate: 16000 });

  // 512 samples: the loudness over the last 32 ms.
  analyserNode = audioContext.createAnalyser();
  analyserNode.fftSize = levelSamples.length;

  await audioContext.audioWorklet.addModule(
    'data:text/javascript,' +
      encodeURIComponent(`
    class PCMProcessor extends AudioWorkletProcessor {
      constructor() {
        super();
        this._buffer = [];
        this._bufferSize = 0;
        this._targetSize = 8000; // 0.5s at 16kHz
        // The recording being captured; 0 between recordings, when input
        // is dropped.
        this._session = 0;
        // Samples still to drop at the start of a recording while the start
        // sound is playing.
        this._skip = 0;
        this.port.onmessage = (event) => {
          const { start, flush, skip } = event.data;
          if (start !== undefined && start !== this._session) {
            // A new recording: forget audio left over from the last one.
            this._buffer = [];
            this._bufferSize = 0;
            this._session = start;
            this._skip = 0;
          }
          if (skip !== undefined) this._skip = skip;
          if (flush !== undefined) {
            // The recording stopped: send what's left of it (up to 0.5s) as
            // its last chunk, even if that's nothing.
            if (flush !== this._session) {
              this._buffer = [];
              this._bufferSize = 0;
            }
            this._send(flush, true);
            this._session = 0;
          }
        };
      }

      _send(session, final) {
        const combined = new Float32Array(this._bufferSize);
        let offset = 0;
        for (const chunk of this._buffer) {
          combined.set(chunk, offset);
          offset += chunk.length;
        }
        this.port.postMessage({ session, samples: combined.buffer, final }, [combined.buffer]);
        this._buffer = [];
        this._bufferSize = 0;
      }

      process(inputs) {
        const input = inputs[0];
        if (!input || !input[0] || this._session === 0) return true;

        let samples = input[0];
        if (this._skip > 0) {
          const dropped = Math.min(this._skip, samples.length);
          this._skip -= dropped;
          samples = samples.subarray(dropped);
          if (samples.length === 0) return true;
        }
        this._buffer.push(new Float32Array(samples));
        this._bufferSize += samples.length;

        if (this._bufferSize >= this._targetSize) {
          this._send(this._session, false);
        }

        return true;
      }
    }

    registerProcessor('pcm-processor', PCMProcessor);
  `),
  );

  workletNode = new AudioWorkletNode(audioContext, 'pcm-processor');
  workletNode.port.onmessage = (event: MessageEvent<{ session: number; samples: ArrayBuffer; final: boolean }>) => {
    const { session, samples, final } = event.data;
    window.dictateAI.sendAudioChunk(session, samples, final);
  };
  workletNode.connect(audioContext.destination);

  audioReady = true;
}

// `fresh`: a new recording, rather than recovering the current one.
async function startAudioCapture(fresh: boolean): Promise<void> {
  // Release any earlier stream first, so only one ever feeds the worklet.
  stopAudioCapture();
  const generation = captureGeneration;
  try {
    await ensureAudioContext();
    if (generation !== captureGeneration) return;

    const constraints: MediaStreamConstraints = {
      audio: {
        sampleRate: 16000,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        ...(selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : {}),
      },
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    // The recording ended (a quick tap) or capture restarted while the
    // microphone was opening: close it again instead of recording into nothing.
    if (generation !== captureGeneration) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    mediaStream = stream;

    mediaStream.getAudioTracks().forEach(track => {
      track.addEventListener('ended', () => {
        console.warn('[DictateAI] Audio track ended unexpectedly — attempting recovery');
        if (currentState === 'recording') {
          attemptAudioRecovery();
        }
      });
    });

    sourceNode = audioContext!.createMediaStreamSource(mediaStream);
    // A fresh recording also drops the samples where the start sound plays.
    workletNode!.port.postMessage({
      start: captureSession,
      ...(fresh ? { skip: samplesToSkip(cues.audibleUntil, performance.now(), audioContext!.sampleRate) } : {}),
    });
    sourceNode.connect(analyserNode!);
    sourceNode.connect(workletNode!);

    if (audioContext!.state === 'suspended') {
      await audioContext!.resume();
      if (generation !== captureGeneration) return;
    }

    view.setLevelSource(micLevel);
  } catch (err) {
    console.error('[DictateAI] Audio capture failed:', err);
    if (generation === captureGeneration && currentState === 'recording') {
      attemptAudioRecovery();
    }
  }
}

async function attemptAudioRecovery(): Promise<void> {
  console.log('[DictateAI] Attempting audio recovery…');
  stopAudioCapture();
  const generation = captureGeneration;

  let retries = 3;
  while (retries > 0 && currentState === 'recording') {
    await new Promise(r => setTimeout(r, 500));
    // The recording stopped, or capture started again, while we waited.
    if (generation !== captureGeneration) return;
    try {
      await startAudioCapture(false);
      console.log('[DictateAI] Audio recovered');
      return;
    } catch {
      retries--;
      console.warn(`[DictateAI] Recovery attempt failed, ${retries} left`);
    }
  }

  if (currentState === 'recording') {
    console.error('[DictateAI] Audio recovery failed — stopping recording');
    window.dictateAI.stopRecording();
  }
}

// The recording stopped. Disconnect the microphone first so nothing newer
// reaches the worklet, then have it send the part of a chunk it still holds.
function flushAudioCapture(session: number): void {
  stopAudioCapture();
  if (workletNode) {
    workletNode.port.postMessage({ flush: session });
  } else {
    window.dictateAI.sendAudioChunk(session, new ArrayBuffer(0), true);
  }
}

function stopAudioCapture(): void {
  captureGeneration++;
  view.setLevelSource(null);

  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
}

window.dictateAI.onCapture((command, session) => {
  if (command === 'start') {
    captureSession = session;
  } else {
    flushAudioCapture(session);
  }
});

window.dictateAI.onCue((cue) => {
  playCue(cue).catch((err) => console.error('[DictateAI] Sound failed:', err));
});

window.dictateAI.onStateChange(updateUI);
window.dictateAI.getState().then(updateUI);

window.dictateAI.onPreview((text) => view.setPreview(text));
window.dictateAI.onHandsfree((active) => view.setHandsfree(active));
window.dictateAI.onPosition((position) => view.setPosition(position));

closeBtn.addEventListener('mouseenter', () => {
  window.dictateAI.setClickable(true);
});

closeBtn.addEventListener('mouseleave', () => {
  window.dictateAI.setClickable(false);
});

closeBtn.addEventListener('click', () => {
  window.dictateAI.stopRecording();
});

window.dictateAI.getAudioDevice().then(id => {
  selectedDeviceId = id || '';
});

window.dictateAI.onAudioDeviceChanged((deviceId) => {
  selectedDeviceId = deviceId || '';
  console.log(`[DictateAI] Audio device updated: ${selectedDeviceId || 'system default'}`);
});

navigator.mediaDevices.addEventListener('devicechange', async () => {
  console.log('[DictateAI] Audio devices changed');
  if (currentState === 'recording' && mediaStream) {
    const tracks = mediaStream.getAudioTracks();
    const allEnded = tracks.every(t => t.readyState === 'ended');
    if (allEnded) {
      attemptAudioRecovery();
    }
  }
});
