import './index.css';

interface DictateAPI {
  sendAudioChunk: (data: ArrayBuffer) => void;
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
      }

      process(inputs) {
        const input = inputs[0];
        if (!input || !input[0]) return true;

        const samples = input[0];
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

async function startAudioCapture(): Promise<void> {
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
