import './index.css';

interface DictateAPI {
  sendAudioChunk: (session: number, data: ArrayBuffer, final: boolean) => void;
  onCapture: (callback: (command: 'start' | 'flush', session: number) => void) => () => void;
  getState: () => Promise<string>;
  onStateChange: (callback: (state: string) => void) => () => void;
  onPreview: (callback: (text: string) => void) => () => void;
  onHandsfree: (callback: (active: boolean) => void) => () => void;
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
// The recording main.ts is capturing for; every chunk carries it.
let captureSession = 0;
// Goes up whenever capture starts or stops. A capture still waiting for the
// microphone checks it, so one that is no longer wanted never connects.
let captureGeneration = 0;

const flowBar = document.getElementById('flow-bar')!;
const waveform = document.getElementById('waveform')!;
const label = document.getElementById('label')!;
const preview = document.getElementById('preview')!;
const closeBtn = document.getElementById('close-btn')!;
const bars = waveform.querySelectorAll<HTMLDivElement>('.bar');

function updateUI(fullState: string): void {
  // 'preparing:42' carries the speech model's download percent.
  const [state, detail] = fullState.split(':');
  currentState = state;
  const cssClass = ['formatting', 'injecting', 'undo'].includes(state) ? 'processing'
    : ['error', 'empty', 'mic-blocked', 'stt-unavailable'].includes(state) ? 'error'
    : ['restarting', 'preparing'].includes(state) ? 'downloading'
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
      startAudioCapture();
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
        // The recording being captured; 0 between recordings, when input
        // is dropped.
        this._session = 0;
        this.port.onmessage = (event) => {
          const { start, flush } = event.data;
          if (start !== undefined && start !== this._session) {
            // A new recording: forget audio left over from the last one.
            this._buffer = [];
            this._bufferSize = 0;
            this._session = start;
          }
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

        const samples = input[0];
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

async function startAudioCapture(): Promise<void> {
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
    workletNode!.port.postMessage({ start: captureSession });
    sourceNode.connect(analyserNode!);
    sourceNode.connect(workletNode!);

    if (audioContext!.state === 'suspended') {
      await audioContext!.resume();
      if (generation !== captureGeneration) return;
    }

    animateWaveform();
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
      await startAudioCapture();
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

window.dictateAI.onCapture((command, session) => {
  if (command === 'start') {
    captureSession = session;
  } else {
    flushAudioCapture(session);
  }
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
