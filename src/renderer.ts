import './index.css';
import startCueSrc from '../assets/sounds/start.wav';
import stopCueSrc from '../assets/sounds/stop.wav';
import { samplesToSkip } from './cue-timing';

interface DictateAPI {
  sendAudioChunk: (data: ArrayBuffer) => void;
  getState: () => Promise<string>;
  onStateChange: (callback: (state: string) => void) => () => void;
  onPreview: (callback: (text: string) => void) => () => void;
  onHandsfree: (callback: (active: boolean) => void) => () => void;
  onCue: (callback: (cue: 'start' | 'stop') => void) => () => void;
  getAudioDevice: () => Promise<string>;
  onAudioDeviceChanged: (callback: (deviceId: string) => void) => () => void;
  stopRecording: () => void;
  setClickable: (clickable: boolean) => void;
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
let animFrameId: number | null = null;
let isHandsfree = false;
let selectedDeviceId = '';

const flowBar = document.getElementById('flow-bar')!;
const waveform = document.getElementById('waveform')!;
const label = document.getElementById('label')!;
const preview = document.getElementById('preview')!;
const closeBtn = document.getElementById('close-btn')!;
const bars = waveform.querySelectorAll<HTMLDivElement>('.bar');

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
  // 'preparing:42' carries the speech model's download percent, and
  // 'no-field:⌃⌘V' the paste shortcut.
  const separator = fullState.indexOf(':');
  const state = separator < 0 ? fullState : fullState.slice(0, separator);
  const detail = separator < 0 ? '' : fullState.slice(separator + 1);
  currentState = state;
  const cssClass = ['formatting', 'injecting', 'undo'].includes(state) ? 'processing'
    : ['error', 'empty', 'mic-blocked', 'stt-unavailable'].includes(state) ? 'error'
    : ['restarting', 'preparing'].includes(state) ? 'downloading'
    : ['no-field', 'copied', 'nothing-yet'].includes(state) ? 'notice'
    : state;
  flowBar.className = `flow-bar ${cssClass}`;
  if (isHandsfree && state === 'recording') {
    flowBar.classList.add('handsfree');
  }
  flowBar.classList.remove('has-audio');
  flowBar.classList.remove('has-preview');
  if (state !== 'recording') {
    preview.textContent = '';
  }

  switch (state) {
    case 'recording':
      label.textContent = '';
      startAudioCapture(true);
      break;
    case 'no-field':
      label.textContent = detail ? `No text field. Press ${detail} to paste it.` : 'No text field. Saved in History.';
      break;
    case 'copied':
      label.textContent = 'Copied';
      break;
    case 'nothing-yet':
      label.textContent = 'Nothing dictated yet';
      break;
    case 'processing':
      label.textContent = 'Transcribing';
      stopAudioCapture();
      break;
    case 'formatting':
      label.textContent = 'Formatting';
      break;
    case 'downloading':
      label.textContent = 'Downloading model';
      break;
    case 'preparing':
      label.textContent = detail ? `Getting ready · ${detail}%` : 'Getting ready…';
      stopAudioCapture();
      break;
    case 'stt-unavailable':
      label.textContent = "Speech engine didn't start";
      break;
    case 'injecting':
      label.textContent = 'Done';
      break;
    case 'restarting':
      label.textContent = 'Restarting STT…';
      break;
    case 'undo':
      label.textContent = 'Undone ↩';
      break;
    case 'empty':
      label.textContent = 'No speech detected';
      break;
    case 'error':
      label.textContent = 'Something went wrong';
      break;
    case 'mic-blocked':
      label.textContent = 'Microphone blocked';
      break;
    case 'idle':
    default:
      label.textContent = '';
      stopAudioCapture();
      break;
  }
}

function animateWaveform(): void {
  if (!analyserNode || currentState !== 'recording') {
    if (animFrameId) cancelAnimationFrame(animFrameId);
    animFrameId = null;
    return;
  }

  const data = new Uint8Array(analyserNode.frequencyBinCount);
  analyserNode.getByteFrequencyData(data);

  const binCount = Math.floor(data.length / bars.length);
  let hasSignal = false;

  bars.forEach((bar, i) => {
    let sum = 0;
    for (let j = i * binCount; j < (i + 1) * binCount; j++) {
      sum += data[j];
    }
    const avg = sum / binCount / 255;
    const height = Math.max(4, avg * 28);
    bar.style.height = `${height}px`;
    if (avg > 0.05) hasSignal = true;
  });

  if (hasSignal) {
    flowBar.classList.add('has-audio');
  } else {
    flowBar.classList.remove('has-audio');
  }

  animFrameId = requestAnimationFrame(animateWaveform);
}

async function ensureAudioContext(): Promise<void> {
  if (audioReady && audioContext && audioContext.state !== 'closed') return;

  audioContext = new AudioContext({ sampleRate: 16000 });

  analyserNode = audioContext.createAnalyser();
  analyserNode.fftSize = 64;
  analyserNode.smoothingTimeConstant = 0.6;

  await audioContext.audioWorklet.addModule(
    'data:text/javascript,' +
      encodeURIComponent(`
    class PCMProcessor extends AudioWorkletProcessor {
      constructor() {
        super();
        this._buffer = [];
        this._bufferSize = 0;
        this._targetSize = 8000; // 0.5s at 16kHz
        this._skip = 0;
        // A new recording: forget audio left over from the last one, and
        // drop the first samples while the start sound is still playing.
        this.port.onmessage = (event) => {
          this._buffer = [];
          this._bufferSize = 0;
          this._skip = event.data.skip || 0;
        };
      }

      process(inputs) {
        const input = inputs[0];
        if (!input || !input[0]) return true;

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
          const combined = new Float32Array(this._bufferSize);
          let offset = 0;
          for (const chunk of this._buffer) {
            combined.set(chunk, offset);
            offset += chunk.length;
          }
          this.port.postMessage(combined.buffer, [combined.buffer]);
          this._buffer = [];
          this._bufferSize = 0;
        }

        return true;
      }
    }

    registerProcessor('pcm-processor', PCMProcessor);
  `),
  );

  workletNode = new AudioWorkletNode(audioContext, 'pcm-processor');
  workletNode.port.onmessage = (event: MessageEvent) => {
    if (currentState === 'recording') {
      window.dictateAI.sendAudioChunk(event.data);
    }
  };
  workletNode.connect(audioContext.destination);

  audioReady = true;
}

// `fresh`: a new recording, rather than recovering the current one.
async function startAudioCapture(fresh: boolean): Promise<void> {
  try {
    await ensureAudioContext();

    const constraints: MediaStreamConstraints = {
      audio: {
        sampleRate: 16000,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        ...(selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : {}),
      },
    };

    mediaStream = await navigator.mediaDevices.getUserMedia(constraints);

    mediaStream.getAudioTracks().forEach(track => {
      track.addEventListener('ended', () => {
        console.warn('[DictateAI] Audio track ended unexpectedly — attempting recovery');
        if (currentState === 'recording') {
          attemptAudioRecovery();
        }
      });
    });

    sourceNode = audioContext!.createMediaStreamSource(mediaStream);
    if (fresh) {
      workletNode!.port.postMessage({ skip: samplesToSkip(cues.audibleUntil, performance.now(), audioContext!.sampleRate) });
    }
    sourceNode.connect(analyserNode!);
    sourceNode.connect(workletNode!);

    if (audioContext!.state === 'suspended') {
      await audioContext!.resume();
    }

    animateWaveform();
  } catch (err) {
    console.error('[DictateAI] Audio capture failed:', err);
    if (currentState === 'recording') {
      attemptAudioRecovery();
    }
  }
}

async function attemptAudioRecovery(): Promise<void> {
  console.log('[DictateAI] Attempting audio recovery…');
  stopAudioCapture();

  let retries = 3;
  while (retries > 0 && currentState === 'recording') {
    await new Promise(r => setTimeout(r, 500));
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

function stopAudioCapture(): void {
  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }

  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }

  bars.forEach((bar) => {
    bar.style.height = '';
  });
}

window.dictateAI.onCue((cue) => {
  playCue(cue).catch((err) => console.error('[DictateAI] Sound failed:', err));
});

window.dictateAI.onStateChange(updateUI);
window.dictateAI.getState().then(updateUI);

window.dictateAI.onPreview((text) => {
  if (currentState === 'recording' && text) {
    preview.textContent = text;
    flowBar.classList.add('has-preview');
  }
});

window.dictateAI.onHandsfree((active) => {
  isHandsfree = active;
  if (active && currentState === 'recording') {
    flowBar.classList.add('handsfree');
  } else {
    flowBar.classList.remove('handsfree');
  }
});

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
