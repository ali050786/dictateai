import './index.css';

interface DictateAPI {
  sendAudioChunk: (data: ArrayBuffer) => void;
  getState: () => Promise<string>;
  onStateChange: (callback: (state: string) => void) => () => void;
  onPreview: (callback: (text: string) => void) => () => void;
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

const flowBar = document.getElementById('flow-bar')!;
const waveform = document.getElementById('waveform')!;
const label = document.getElementById('label')!;
const preview = document.getElementById('preview')!;
const bars = waveform.querySelectorAll<HTMLDivElement>('.bar');

function updateUI(state: string): void {
  currentState = state;
  const cssClass = ['formatting', 'injecting', 'undo'].includes(state) ? 'processing'
    : ['error', 'empty'].includes(state) ? 'error'
    : state === 'restarting' ? 'downloading'
    : state;
  flowBar.className = `flow-bar ${cssClass}`;
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

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: 16000,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
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
