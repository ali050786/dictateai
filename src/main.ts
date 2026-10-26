import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
  shell,
  systemPreferences,
} from 'electron';
import * as os from 'os';
import {
  injectText,
  undoLastInjection,
  checkAccessibilityPermission,
  isAccessibilityTrusted,
  startPushToTalk,
  stopPushToTalk,
  setPttKey,
} from './text-injection';
import { transcribe, getLanguage, startServer, stopServer, isServerRunning, isSpeechEngineInstalled, setOnStatusChange, getModelDownload, whenServerReady, configureSpeech, effectiveSpeechModel, speechModelFor, isSpeechModelOnDisk, prepareSpeechModel, getPreparingSpeechModel, getSpeechModel, isServerStarting, didServerFail, isSpeechModelBroken, setOnSpeechModelReady } from './speech-engine';
import { SPEECH_MODELS, SpeechChoice } from './speech-models';
import { basicCleanup } from './basic-cleanup';
import { exec } from 'child_process';
import * as path from 'path';
import { formatText, canFormat, CleanupLocation, getCloudModel, DEFAULT_CLOUD_MODEL } from './llm-formatter';
import { hasApiKey, saveApiKey, removeApiKey, migrateApiKey, loadConfig, saveConfig, ShortcutConfig, PillPosition, normalizePillPosition, getLlmProvider, LlmProvider } from './config';
import { startLocalLlm, stopLocalLlm, isMlxInstalled, isLocalLlmRunning, isLocalLlmStarting, getLocalModel, setOnLocalLlmStatusChange, defaultLocalModelFor, localModelOptions, getLocalModelDownload, didLocalLlmFail, isLocalModelDownloaded, localModelBytes, localModelCacheDir } from './local-llm';
import { formatBytes, freeDiskBytes } from './engines';
import { getFocusedElementInfo } from './text-injection';
import { noticeAfterCleanup, noticeMicrophoneBlocked, noticeCleanupReady } from './notices';
import { addHistory, listHistory, clearHistory } from './history';
import { applyReplacements, detectCorrections, addCorrection, getAllCorrections, removeCorrection, getHotwords } from './dictionary';
import started from 'electron-squirrel-startup';
import { redact } from './log';
import { getFocusTarget } from './text-injection';
import { classifyFocus } from './focus-target';
import { START_CUE_MS, TAP_MS } from './cue-timing';
import { getLoginItemState, setOpenAtLogin, openLoginItemsSettings } from './login-item';
import { acceleratorSymbol, TranscriptAction } from './accelerator';
import {
  pasteLastTranscript,
  copyLastTranscript,
  getTranscriptShortcuts,
  pasteShortcutSymbol,
  setLastTranscriptFeedback,
  registerTranscriptShortcuts,
  suspendTranscriptShortcuts,
  resumeTranscriptShortcuts,
  transcriptShortcutState,
  setTranscriptShortcut,
  removeTranscriptShortcut,
  resetTranscriptShortcuts,
} from './last-transcript';

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;
declare const HUB_WINDOW_WEBPACK_ENTRY: string;
declare const HUB_WINDOW_PRELOAD_WEBPACK_ENTRY: string;
declare const WELCOME_WINDOW_WEBPACK_ENTRY: string;
declare const WELCOME_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

if (started) {
  app.quit();
}

let tray: Tray | null = null;
let overlayWindow: BrowserWindow | null = null;
let hubWindow: BrowserWindow | null = null;
let welcomeWindow: BrowserWindow | null = null;
// The speech engine didn't start (usually the model download stopped).
let speechFailed = false;
// The cleanup model is being fetched for the first time, so tell the user
// once it's ready (notices.ts).
let cleanupReadyNoticePending = false;

// What the dictation pipeline is doing. `session` goes up with every
// recording: async work from an older session still inserts its text, but
// never touches the pill or the audio of the current one.
type Phase = 'idle' | 'recording' | 'processing';
const dictation = {
  phase: 'idle' as Phase,
  session: 0,
  chunks: [] as Float32Array[],
  handsFree: false,
  // When the current recording started (Date.now()), to tell taps from holds.
  startedAt: 0,
  previewTimer: null as ReturnType<typeof setInterval> | null,
  previewInFlight: false,
};
// Recordings are processed one after another, so text is inserted in the
// order it was spoken even when the user starts talking again early.
let processingQueue: Promise<void> = Promise.resolve();
// Recordings that have stopped but whose last audio is still on its way from
// the overlay (collectLastChunk), by session.
const endingRecordings = new Map<number, { chunks: Float32Array[]; done: () => void }>();
// How long a stopped recording waits for its last chunk. It normally takes a
// few milliseconds; this only stops a lost message from holding up the queue.
const LAST_CHUNK_TIMEOUT_MS = 150;

const pillTimers = {
  hide: null as ReturnType<typeof setTimeout> | null,
  transition: null as ReturnType<typeof setTimeout> | null,
};

// True only when we muted system audio ourselves, so we never unmute audio
// the user had muted.
let didMuteAudio = false;
// Muting waits for the start sound to finish (muteSystemAudio).
let muteTimer: ReturnType<typeof setTimeout> | null = null;

function isRecording(): boolean {
  return dictation.phase === 'recording';
}

// Settings are read from config.ts (cached) rather than copied into
// variables here, so there is one source of truth.
function settings(): { llmEnabled: boolean; pillPosition: PillPosition; muteWhileSpeaking: boolean; playSounds: boolean; shortcutLabel: string } {
  const config = loadConfig();
  return {
    llmEnabled: config.llmEnabled ?? false,
    pillPosition: normalizePillPosition(config.pillPosition),
    muteWhileSpeaking: config.muteWhileSpeaking ?? false,
    playSounds: config.playSounds ?? true,
    shortcutLabel: config.shortcut?.display || 'Right ⌥ Option',
  };
}


function createOverlayWindow(): BrowserWindow {
  const display = screen.getPrimaryDisplay();
  const { width: screenW, height: screenH } = display.workAreaSize;
  const winW = 240;
  const winH = 64;

  const win = new BrowserWindow({
    width: winW,
    height: winH,
    x: Math.round((screenW - winW) / 2),
    y: screenH - winH - 16,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
    },
  });

  lockDownWebContents(win);
  win.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
  win.setIgnoreMouseEvents(true);
  win.hide();

  return win;
}

// Our pages never open windows or navigate; refuse both so injected content
// can't load a remote page with the preload's bridge attached.
function lockDownWebContents(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
}

function createHubWindow(): void {
  if (hubWindow && !hubWindow.isDestroyed()) {
    hubWindow.show();
    hubWindow.focus();
    return;
  }

  hubWindow = new BrowserWindow({
    width: 820,
    height: 580,
    minWidth: 640,
    minHeight: 460,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#f7f7f7',
    show: false,
    webPreferences: {
      preload: HUB_WINDOW_PRELOAD_WEBPACK_ENTRY,
    },
  });

  lockDownWebContents(hubWindow);
  hubWindow.loadURL(HUB_WINDOW_WEBPACK_ENTRY);

  hubWindow.once('ready-to-show', () => {
    app.dock?.show();
    hubWindow?.show();
  });

  // Settings pauses the last-transcript shortcuts while it records a new
  // one; never leave them off once the user is elsewhere.
  hubWindow.on('blur', () => resumeTranscriptShortcuts());

  hubWindow.on('closed', () => {
    hubWindow = null;
    resumeTranscriptShortcuts();
    app.dock?.hide();
  });
}

// First launch: permissions, the speech model, and the AI cleanup offer
// (welcome.html). Reopened from the menu bar.
function createWelcomeWindow(): void {
  if (welcomeWindow && !welcomeWindow.isDestroyed()) {
    welcomeWindow.show();
    welcomeWindow.focus();
    return;
  }

  welcomeWindow = new BrowserWindow({
    width: 520,
    height: 440,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#ffffff',
    show: false,
    webPreferences: {
      preload: WELCOME_WINDOW_PRELOAD_WEBPACK_ENTRY,
    },
  });

  lockDownWebContents(welcomeWindow);
  welcomeWindow.loadURL(WELCOME_WINDOW_WEBPACK_ENTRY);

  welcomeWindow.once('ready-to-show', () => {
    // A menu-bar app isn't frontmost when it launches.
    app.focus({ steal: true });
    welcomeWindow?.show();
  });

  welcomeWindow.on('closed', () => {
    welcomeWindow = null;
  });
}

// Pages that show engine status: the hub, and the Welcome window.
function sendToPages(channel: string, ...args: unknown[]): void {
  for (const win of [hubWindow, welcomeWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
  }
}

// Menu-bar icons from assets/tray (scripts/build-icons.mjs). Template images,
// so macOS draws them in the menu bar's own colour; @2x is picked up by name.
function trayIcon(recording: boolean): Electron.NativeImage {
  const dir = app.isPackaged
    ? path.join(process.resourcesPath, 'tray')
    : path.join(path.resolve(__dirname, '..', '..'), 'assets', 'tray');
  const icon = nativeImage.createFromPath(path.join(dir, recording ? 'trayRecordingTemplate.png' : 'trayTemplate.png'));
  icon.setTemplateImage(true);
  return icon;
}

function createTray(): void {
  tray = new Tray(trayIcon(false));
  tray.setToolTip('DictateAI');
  tray.on('click', () => createHubWindow());
  updateTrayMenu();
}

function updateTrayMenu(): void {
  if (!tray) return;

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open DictateAI',
      click: () => createHubWindow(),
    },
    { label: 'Welcome & Setup…', click: () => createWelcomeWindow() },
    { type: 'separator' },
    {
      label: isRecording() ? '⏹ Stop Recording' : '🎙 Start Recording',
      click: () => toggleRecording(),
    },
    {
      label: `Hold ${settings().shortcutLabel} to dictate`,
      enabled: false,
    },
    { type: 'separator' },
    // Shown with their shortcuts; the global shortcuts do the work.
    {
      label: 'Paste last transcript',
      accelerator: getTranscriptShortcuts().paste[0],
      registerAccelerator: false,
      click: () => pasteLastTranscript(),
    },
    {
      label: 'Copy last transcript',
      accelerator: getTranscriptShortcuts().copy[0],
      registerAccelerator: false,
      click: () => copyLastTranscript(),
    },
    { type: 'separator' },
    {
      label: 'Quit DictateAI',
      click: () => app.quit(),
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.setImage(trayIcon(isRecording()));
}

function applyOverlayPosition(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;

  const display = screen.getPrimaryDisplay();
  const { x: dX, y: dY, width: dW, height: dH } = display.workArea;
  const MARGIN = 12;
  const winW = 240;
  const winH = 52;
  overlayWindow.setSize(winW, winH);

  let x: number, y: number;

  switch (settings().pillPosition) {
    case 'top-left':
      x = dX + MARGIN; y = dY + MARGIN; break;
    case 'top-center':
      x = dX + Math.round((dW - winW) / 2); y = dY + MARGIN; break;
    case 'top-right':
      x = dX + dW - winW - MARGIN; y = dY + MARGIN; break;
    case 'bottom-left':
      x = dX + MARGIN; y = dY + dH - winH - MARGIN; break;
    case 'bottom-right':
      x = dX + dW - winW - MARGIN; y = dY + dH - winH - MARGIN; break;
    case 'bottom-center':
    default:
      x = dX + Math.round((dW - winW) / 2); y = dY + dH - winH - MARGIN; break;
  }

  overlayWindow.setPosition(x, y, false);
}

function toggleRecording(): void {
  console.log(`[DictateAI] toggleRecording called — phase=${dictation.phase}`);
  if (isRecording()) {
    stopRecording();
  } else {
    startRecording();
  }
}

// The start and stop sounds. The overlay plays them (renderer.ts): it's the
// window that records, so it can keep the start sound out of the recording.
function playCue(cue: 'start' | 'stop'): void {
  if (!settings().playSounds) return;
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('dictation:cue', cue);
  }
}

function muteSystemAudio(): void {
  if (!settings().muteWhileSpeaking) return;
  const session = dictation.session;
  // Muting straight away would cut off the start sound.
  muteTimer = setTimeout(() => {
    muteTimer = null;
    exec('osascript -e "output muted of (get volume settings)"', (err, stdout) => {
      if (err) {
        console.error('[DictateAI] Failed to check mute state:', err);
        return;
      }
      if (stdout.trim() === 'true') {
        didMuteAudio = false;
        return;
      }
      exec('osascript -e "set volume with output muted"', (err2) => {
        if (err2) {
          console.error('[DictateAI] Failed to mute audio:', err2);
          return;
        }
        didMuteAudio = true;
        console.log('[DictateAI] System audio muted');
        // The recording ended while we were muting (a quick press).
        if (session !== dictation.session || !isRecording()) unmuteSystemAudio();
      });
    });
  }, settings().playSounds ? START_CUE_MS : 0);
}

// `then` runs once audio is back on (straight away if we never muted it).
function unmuteSystemAudio(then?: () => void): void {
  if (muteTimer) {
    clearTimeout(muteTimer);
    muteTimer = null;
  }
  if (!didMuteAudio) {
    then?.();
    return;
  }
  didMuteAudio = false;
  exec('osascript -e "set volume without output muted"', (err) => {
    if (err) {
      console.error('[DictateAI] Failed to unmute audio:', err);
    } else {
      console.log('[DictateAI] System audio unmuted');
    }
    then?.();
  });
}

function startRecording(): void {
  if (isRecording()) return;
  dictation.session++;
  dictation.phase = 'recording';
  dictation.chunks = [];
  dictation.startedAt = Date.now();
  cancelPendingHide();
  // Sent before the 'recording' state, so the overlay starts the sound
  // before it opens the microphone.
  playCue('start');
  muteSystemAudio();
  updateTrayMenu();
  console.log('[DictateAI] Recording started');

  if (overlayWindow && !overlayWindow.isDestroyed()) {
    applyOverlayPosition();
    overlayWindow.webContents.send('audio:capture', 'start', dictation.session);
    overlayWindow.webContents.send('dictation:state', 'recording');
    overlayWindow.showInactive();
  }

  startPreviewTimer();
}

function stopRecording(): void {
  if (!isRecording()) return;
  const session = dictation.session;
  const chunks = dictation.chunks;
  const heldMs = Date.now() - dictation.startedAt;
  dictation.phase = 'processing';
  dictation.chunks = [];
  // The stop sound waits for audio to be unmuted, or nobody would hear it.
  // A tap (the start of a double or triple tap) records nothing: no sound.
  unmuteSystemAudio(() => {
    if (heldMs >= TAP_MS) playCue('stop');
  });
  stopPreviewTimer();
  updateTrayMenu();
  console.log(`[DictateAI] Recording stopped — ${chunks.length} chunks collected`);

  const allChunks = collectLastChunk(session, chunks);
  sendPillState(session, 'processing');
  processingQueue = processingQueue.then(async () => processAudio(session, await allChunks));
}

// The overlay sends audio in 0.5 s chunks, so when a recording stops it still
// holds up to half a second of it: the last words. Ask for that and wait for
// it (see 'audio:chunk'), but never longer than LAST_CHUNK_TIMEOUT_MS.
function collectLastChunk(session: number, chunks: Float32Array[]): Promise<Float32Array[]> {
  return new Promise((resolve) => {
    const asked = Date.now();
    const finish = (arrived: boolean) => {
      clearTimeout(timer);
      endingRecordings.delete(session);
      const samples = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      console.log(
        arrived
          ? `[DictateAI] Last audio chunk arrived after ${Date.now() - asked}ms — ${(samples / 16000).toFixed(2)}s recorded (${samples} samples)`
          : `[DictateAI] Last audio chunk didn't arrive within ${LAST_CHUNK_TIMEOUT_MS}ms — going on with ${(samples / 16000).toFixed(2)}s`,
      );
      resolve(chunks);
    };
    const timer = setTimeout(() => finish(false), LAST_CHUNK_TIMEOUT_MS);
    endingRecordings.set(session, { chunks, done: () => finish(true) });
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('audio:capture', 'flush', session);
    } else {
      finish(false);
    }
  });
}

// Pill updates from a dictation that has since been replaced by a newer
// recording are dropped.
function sendPillState(session: number, state: string): void {
  if (session !== dictation.session) return;
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('dictation:state', state);
  }
}

function hidePillLater(session: number, ms: number): void {
  if (session === dictation.session) hideOverlayAfterDelay(ms);
}

function joinChunks(chunks: Float32Array[]): Float32Array {
  const combined = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return combined;
}

function startPreviewTimer(): void {
  stopPreviewTimer();
  const session = dictation.session;
  // Phonon transcribes in about 0.15s, so the words can follow the voice
  // (audio arrives every 0.5s); Whisper takes up to 2s, so it's asked less.
  const interval = SPEECH_MODELS[getSpeechModel()].engine === 'phonon' ? 600 : 2000;
  dictation.previewTimer = setInterval(async () => {
    if (!isRecording() || dictation.chunks.length === 0 || dictation.previewInFlight) return;

    const combined = joinChunks(dictation.chunks);
    if (combined.length / 16000 < 1.0) return;

    dictation.previewInFlight = true;
    try {
      const preview = await transcribe(combined, getHotwords());
      if (isRecording() && session === dictation.session && preview && !/^\s*[\[(].*[\])]\s*$/i.test(preview)) {
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.webContents.send('dictation:preview', preview);
        }
      }
    } catch {
      // preview failures are non-critical
    } finally {
      dictation.previewInFlight = false;
    }
  }, interval);
}

function stopPreviewTimer(): void {
  if (dictation.previewTimer) {
    clearInterval(dictation.previewTimer);
    dictation.previewTimer = null;
  }
  dictation.previewInFlight = false;
}

async function processAudio(session: number, chunks: Float32Array[]): Promise<void> {
  if (chunks.length === 0) {
    console.log('[DictateAI] No audio chunks — skipping');
    hidePillLater(session, 300);
    finishProcessing(session, '');
    return;
  }

  const combined = joinChunks(chunks);

  // Exact digital silence (every sample 0) means macOS is withholding the
  // microphone; a real quiet room still has noise.
  if (combined.every((sample) => sample === 0)) {
    console.log('[DictateAI] Recording is pure silence — microphone access is blocked');
    sendPillState(session, 'mic-blocked');
    hidePillLater(session, 2500);
    noticeMicrophoneBlocked();
    finishProcessing(session, '');
    return;
  }

  const durationSec = combined.length / 16000;
  if (durationSec < 0.2) {
    console.log(`[DictateAI] Recording too short (${durationSec.toFixed(1)}s) — skipping`);
    hidePillLater(session, 300);
    finishProcessing(session, '');
    return;
  }

  // Pad short recordings with silence so the speech model gets enough
  // context (WhisperKit heard nothing in under ~1.5s)
  const MIN_DURATION = 1.5;
  let audioToTranscribe = combined;
  if (durationSec < MIN_DURATION) {
    const padSamples = Math.ceil(MIN_DURATION * 16000);
    const padded = new Float32Array(padSamples);
    padded.set(combined, 0);
    audioToTranscribe = padded;
    console.log(`[DictateAI] Padded ${durationSec.toFixed(1)}s → ${MIN_DURATION}s`);
  }

  console.log(
    `[DictateAI] Processing ${durationSec.toFixed(1)}s of audio (${combined.length} samples)`,
  );

  // Dictating before the speech model has downloaded or loaded (first run, or
  // just after launch): keep the recording and transcribe it once it's ready.
  if (!isServerRunning()) {
    console.log('[DictateAI] Speech engine still getting ready — holding the recording');
    const showProgress = () => {
      const download = getModelDownload();
      sendPillState(session, download ? `preparing:${download.percent}` : 'preparing');
    };
    showProgress();
    const progressTimer = setInterval(showProgress, 1000);
    const ready = await whenServerReady(10 * 60_000).finally(() => clearInterval(progressTimer));
    if (!ready) {
      console.error('[DictateAI] Speech engine not available — recording dropped');
      sendPillState(session, 'stt-unavailable');
      hidePillLater(session, 3000);
      finishProcessing(session, '');
      return;
    }
    sendPillState(session, 'processing');
  }

  try {
    const sttStart = Date.now();
    const rawText = await transcribe(audioToTranscribe, getHotwords());
    console.log(`[DictateAI] Transcription took ${Date.now() - sttStart}ms`);
    if (!rawText || /^\s*[\[(].*[\])]\s*$/i.test(rawText) || rawText.trim().length < 2) {
      console.log(`[DictateAI] No usable speech detected: ${redact(rawText)}`);
      sendPillState(session, 'empty');
      hidePillLater(session, 1500);
      finishProcessing(session, '');
      return;
    }

    // Basic cleanup (no AI, instant) runs first, so the dictionary and any AI
    // cleanup see the text without fillers.
    const tidied = loadConfig().basicCleanup === false ? rawText : basicCleanup(rawText);
    const correctedText = applyReplacements(tidied);
    const context = getFocusedElementInfo();

    if (settings().llmEnabled && canFormat()) {
      sendPillState(session, 'formatting');
      const llmStart = Date.now();
      try {
        const result = await formatText(correctedText, 'dictation', {
          app: context.app,
          role: context.role,
        });
        console.log(`[DictateAI] LLM cleanup took ${Date.now() - llmStart}ms`);
        finishProcessing(session, result.text || correctedText, context.app, result.location);
        noticeAfterCleanup(result, getLocalModel(), loadConfig().language);
      } catch (err) {
        console.error('[DictateAI] LLM formatting failed, using raw:', err);
        finishProcessing(session, correctedText, context.app);
      }
    } else {
      finishProcessing(session, correctedText, context.app);
    }
  } catch (err) {
    console.error('[DictateAI] Transcription failed:', err);
    sendPillState(session, 'error');
    hidePillLater(session, 2000);
    finishProcessing(session, '');
  }
}

function cancelPendingHide(): void {
  if (pillTimers.hide) { clearTimeout(pillTimers.hide); pillTimers.hide = null; }
  if (pillTimers.transition) { clearTimeout(pillTimers.transition); pillTimers.transition = null; }
}

function hideOverlayAfterDelay(ms: number): void {
  cancelPendingHide();
  pillTimers.hide = setTimeout(() => {
    pillTimers.hide = null;
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('dictation:state', 'idle');
      pillTimers.transition = setTimeout(() => {
        pillTimers.transition = null;
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.hide();
        }
      }, 300);
    }
  }, ms);
}

// Puts the text where the user is typing. If nothing there takes text (the
// desktop, a file list, a web page with no field selected) or inserting
// fails, the text isn't pasted into the void: it stays the last transcript
// (the newest history entry) and the pill says how to paste it.
function insertText(session: number, text: string): boolean {
  const focus = getFocusTarget();
  const verdict = classifyFocus(focus);
  const where = `${focus.role || 'no focused element'} in ${focus.app || 'unknown app'}`;
  if (verdict === 'none') {
    console.log(`[DictateAI] No text field (${where}) — kept for the paste shortcut`);
  } else {
    sendPillState(session, 'injecting');
    const method = injectText(text);
    console.log(`[DictateAI] Injected via: ${method} (focus: ${verdict}, ${where})`);
    if (method !== 'failed') {
      hidePillLater(session, 1200);
      return true;
    }
  }
  sendPillState(session, `no-field:${pasteShortcutSymbol()}`);
  hidePillLater(session, 4000);
  return false;
}

function finishProcessing(session: number, text: string, appName?: string, location: CleanupLocation = 'local'): void {
  if (session === dictation.session && dictation.phase === 'processing') {
    dictation.phase = 'idle';
  }

  if (text) {
    console.log(`[DictateAI] Result: ${redact(text)}`);

    const inserted = insertText(session, text);

    const entry = { text, app: appName || '', time: new Date().toISOString(), location };
    addHistory(entry);

    sendToPages('dictation:log', entry);

    // A few seconds later, compare what's in the field with what we inserted
    // to learn the user's corrections (see dictionary.ts).
    if (inserted) setTimeout(() => {
      try {
        const fieldInfo = getFocusedElementInfo();
        console.log(`[DictateAI] Correction check — available: ${fieldInfo.available}, app: ${fieldInfo.app}, role: ${fieldInfo.role}`);
        console.log(`[DictateAI] Correction check — title: ${redact(fieldInfo.title)}, value: ${redact(fieldInfo.value)}`);
        console.log(`[DictateAI] Correction check — injected: ${redact(text)}`);
        if (fieldInfo.available && fieldInfo.value) {
          detectCorrections(text, fieldInfo.value);
        } else {
          console.log('[DictateAI] Correction check — no value from focused element');
        }
      } catch (err) {
        console.error('[DictateAI] Correction check error:', err);
      }
    }, 5000);
  }
}

function registerPushToTalk(): void {
  const DOUBLE_TAP_MS = 400;
  const TRIPLE_TAP_MS = 600;
  let tapCount = 0;
  let tapTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPTTDown = 0;

  const started = startPushToTalk((event) => {
    const now = Date.now();

    if (event === 'down') {
      if (dictation.handsFree) {
        console.log('[DictateAI] Hands-free: key down — stop recording');
        dictation.handsFree = false;
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.webContents.send('dictation:handsfree', false);
          overlayWindow.setIgnoreMouseEvents(true);
        }
        stopRecording();
        return;
      }

      const gap = now - lastPTTDown;
      lastPTTDown = now;

      if (gap < TRIPLE_TAP_MS) {
        tapCount++;
      } else {
        tapCount = 1;
      }

      if (tapTimer) clearTimeout(tapTimer);

      if (tapCount >= 3 && !isRecording()) {
        console.log('[DictateAI] Triple-tap detected — undo last dictation');
        tapCount = 0;
        undoLastInjection();
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.webContents.send('dictation:state', 'undo');
          overlayWindow.showInactive();
          hideOverlayAfterDelay(1000);
        }
        return;
      }

      if (tapCount === 2 && !isRecording()) {
        tapTimer = setTimeout(() => {
          console.log('[DictateAI] Double-tap confirmed — hands-free mode');
          dictation.handsFree = true;
          startRecording();
          if (overlayWindow && !overlayWindow.isDestroyed()) {
            overlayWindow.webContents.send('dictation:handsfree', true);
            overlayWindow.setIgnoreMouseEvents(true, { forward: true });
          }
          tapCount = 0;
        }, TRIPLE_TAP_MS);
        return;
      }

      if (tapCount === 1 && !isRecording()) {
        console.log('[DictateAI] PTT key down — start recording');
        startRecording();
      }
    } else if (event === 'up') {
      if (dictation.handsFree) return;
      if (isRecording() && tapCount <= 1) {
        console.log('[DictateAI] PTT key up — stop recording');
        stopRecording();
      }
    }
  });
  console.log(`[DictateAI] Push-to-talk monitor started: ${started}`);
}

function setupIPC(): void {
  // Every chunk names the recording it belongs to, so audio from one that
  // has ended never lands in the next.
  ipcMain.on('audio:chunk', (_event, session: number, data: ArrayBuffer, final: boolean) => {
    const samples = new Float32Array(data);
    if (isRecording() && session === dictation.session) {
      dictation.chunks.push(samples);
      return;
    }
    const ending = endingRecordings.get(session);
    if (!ending) return;
    if (samples.length > 0) ending.chunks.push(samples);
    if (final) ending.done();
  });

  ipcMain.on('overlay:stopRecording', () => {
    if (isRecording()) {
      console.log('[DictateAI] Stop recording from overlay close button');
      dictation.handsFree = false;
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('dictation:handsfree', false);
        overlayWindow.setIgnoreMouseEvents(true);
      }
      stopRecording();
    }
  });

  ipcMain.on('overlay:setClickable', (_event, clickable: boolean) => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      if (clickable) {
        overlayWindow.setIgnoreMouseEvents(false);
      } else {
        overlayWindow.setIgnoreMouseEvents(true, { forward: true });
      }
    }
  });

  ipcMain.handle('dictation:getState', () => {
    return isRecording() ? 'recording' : 'idle';
  });

  ipcMain.handle('config:hasApiKey', () => hasApiKey());
  ipcMain.handle('config:setApiKey', (_event, key: string) => {
    saveApiKey(key);
    return true;
  });
  ipcMain.handle('config:removeApiKey', () => {
    removeApiKey();
    return true;
  });
  ipcMain.handle('config:hasAccessibility', () => isAccessibilityTrusted());

  ipcMain.handle('dictionary:add', (_event, from: string, to: string) => {
    addCorrection(from, to, true);
    return true;
  });
  ipcMain.handle('dictionary:remove', (_event, from: string) => {
    return removeCorrection(from);
  });
  ipcMain.handle('dictionary:list', () => {
    return getAllCorrections();
  });

  ipcMain.handle('history:clear', () => {
    clearHistory();
    return true;
  });
  ipcMain.handle('history:list', () => {
    return listHistory();
  });

  ipcMain.handle('config:getLanguage', () => getLanguage());
  // downloadCleanup: false when the user said "Not now" to the cleanup model
  // the new language needs; it then waits until they ask for it.
  ipcMain.handle('config:setLanguage', async (_event, lang: string, downloadCleanup = true) => {
    return applyLanguage(lang, downloadCleanup);
  });
  ipcMain.handle('config:cleanupPlan', (_event, lang: string) => cleanupPlan(lang));
  ipcMain.handle('config:downloadCleanup', () => {
    saveConfig({ cleanupDownloadDeclined: undefined });
    syncLocalLlm();
    return true;
  });
  ipcMain.handle('config:getLlmEnabled', () => settings().llmEnabled);
  ipcMain.handle('config:setLlmEnabled', (_event, enabled: boolean) => {
    // Turning it on is the explicit choice; the size was shown next to it.
    saveConfig(enabled ? { llmEnabled: true, cleanupDownloadDeclined: undefined } : { llmEnabled: false });
    syncLocalLlm();
    return true;
  });
  ipcMain.handle('config:getLlmProvider', () => getLlmProvider());
  ipcMain.handle('config:setLlmProvider', (_event, provider: LlmProvider) => {
    saveConfig({ llmProvider: provider });
    syncLocalLlm();
    return true;
  });
  ipcMain.handle('config:llmStatus', () => ({
    provider: getLlmProvider(),
    mlxInstalled: isMlxInstalled(),
    running: isLocalLlmRunning(),
    starting: isLocalLlmStarting(),
    download: getLocalModelDownload(),
    failed: didLocalLlmFail(),
    model: getLocalModel(),
    cloudModel: getCloudModel(),
    plan: cleanupPlan(getLanguage()),
  }));
  ipcMain.handle('config:getLocalModelChoice', () => ({
    choice: loadConfig().localModel || 'auto',
    options: localModelOptions(),
  }));
  ipcMain.handle('config:setLocalModelChoice', (_event, id: string) => {
    if (!localModelOptions().some(o => o.id === id)) return false;
    saveConfig({ localModel: id === 'auto' ? undefined : id });
    syncLocalLlm();
    return true;
  });
  ipcMain.handle('config:setCloudModel', (_event, model: string) => {
    saveConfig({ model: model.trim() || DEFAULT_CLOUD_MODEL });
    return true;
  });

  ipcMain.handle('config:sttStatus', () => speechStatus());
  ipcMain.handle('config:setSpeechChoice', (_event, choice: SpeechChoice) => {
    if (!['auto', 'fast', 'accurate'].includes(choice)) return false;
    saveConfig({ speechModel: choice === 'auto' ? undefined : choice });
    applySpeech();
    sendToPages('stt:status-changed');
    return true;
  });
  // The user agreed to download the model their choice and language want.
  ipcMain.handle('config:downloadSpeech', () => {
    const lang = loadConfig().language ?? 'auto';
    prepareSpeechModel(speechModelFor(speechChoice(), lang)).then((ok) => {
      if (ok) applySpeech();
      sendToPages('stt:status-changed');
    });
    return true;
  });
  // Settings' "Try again" after the speech engine failed to start.
  ipcMain.handle('config:retrySpeech', async () => {
    applySpeech();
    if (!isServerRunning() && !isServerStarting()) await startServer();
    sendToPages('stt:status-changed');
    return isServerRunning();
  });
  ipcMain.handle('config:getBasicCleanup', () => loadConfig().basicCleanup ?? true);
  ipcMain.handle('config:setBasicCleanup', (_event, enabled: boolean) => {
    saveConfig({ basicCleanup: enabled ? undefined : false });
    return true;
  });

  // --- Welcome window ---
  ipcMain.handle('welcome:status', () => ({
    accessibility: isAccessibilityTrusted(),
    microphone: systemPreferences.getMediaAccessStatus('microphone'),
    speech: {
      installed: isSpeechEngineInstalled(),
      running: isServerRunning(),
      failed: speechFailed,
      download: getModelDownload(),
      size: formatBytes(SPEECH_MODELS[getSpeechModel()].bytes),
    },
    shortcut: settings().shortcutLabel,
    language: loadConfig().language ?? null,
    locale: app.getLocale().split('-')[0].toLowerCase(),
    llmEnabled: settings().llmEnabled,
  }));
  ipcMain.handle('welcome:openAccessibility', () => {
    // Prompting also adds DictateAI to the list in System Settings.
    checkAccessibilityPermission();
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    return true;
  });
  ipcMain.handle('welcome:allowMicrophone', async () => {
    if (systemPreferences.getMediaAccessStatus('microphone') === 'not-determined') {
      return systemPreferences.askForMediaAccess('microphone');
    }
    // Denied once: macOS won't ask again, only System Settings can change it.
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
    return false;
  });
  ipcMain.handle('welcome:retrySpeech', () => {
    startSpeech();
    return true;
  });
  ipcMain.handle('welcome:finish', (_event, lang: string, enableCleanup: boolean) => {
    if (lang && lang !== loadConfig().language) applyLanguage(lang, true);
    if (enableCleanup) {
      saveConfig({ llmEnabled: true, cleanupDownloadDeclined: undefined });
      syncLocalLlm();
    }
    welcomeWindow?.close();
    return true;
  });
  ipcMain.handle('welcome:close', () => {
    welcomeWindow?.close();
    return true;
  });

  ipcMain.handle('config:getAudioDevice', () => {
    const config = loadConfig();
    return config.audioDevice || '';
  });
  ipcMain.handle('config:setAudioDevice', (_event, deviceId: string) => {
    saveConfig({ audioDevice: deviceId });
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('config:audioDeviceChanged', deviceId);
    }
    console.log(`[DictateAI] Audio device changed: ${deviceId || 'system default'}`);
    return true;
  });

  ipcMain.handle('config:getPillPosition', () => {
    return settings().pillPosition;
  });
  ipcMain.handle('config:setPillPosition', (_event, position: string) => {
    saveConfig({ pillPosition: normalizePillPosition(position) });
    console.log(`[DictateAI] Pill position changed to: ${position}`);
    return true;
  });

  ipcMain.handle('config:getMuteWhileSpeaking', () => {
    return settings().muteWhileSpeaking;
  });
  ipcMain.handle('config:setMuteWhileSpeaking', (_event, enabled: boolean) => {
    saveConfig({ muteWhileSpeaking: enabled });
    console.log(`[DictateAI] Mute while speaking: ${enabled}`);
    return true;
  });

  ipcMain.handle('config:getShortcut', () => {
    const config = loadConfig();
    return config.shortcut || null;
  });
  ipcMain.handle('config:setShortcut', (_event, shortcut: ShortcutConfig) => {
    setPttKey(shortcut.keyCode, shortcut.flagMask, shortcut.isModifier, shortcut.requiredModifiers);
    saveConfig({ shortcut });
    console.log(`[DictateAI] Shortcut changed to: ${shortcut.display} (code=${shortcut.code})`);
    return true;
  });

  ipcMain.handle('config:getPlaySounds', () => settings().playSounds);
  ipcMain.handle('config:setPlaySounds', (_event, enabled: boolean) => {
    saveConfig({ playSounds: enabled });
    console.log(`[DictateAI] Play sounds: ${enabled}`);
    return true;
  });

  ipcMain.handle('config:getOpenAtLogin', () => getLoginItemState());
  ipcMain.handle('config:setOpenAtLogin', (_event, enabled: boolean) => setOpenAtLogin(enabled));
  ipcMain.handle('config:openLoginItems', () => {
    openLoginItemsSettings();
    return true;
  });

  // "Paste last transcript" / "Copy last transcript" shortcuts.
  const afterShortcutChange = <T extends { ok: boolean }>(result: T): T => {
    if (result.ok) updateTrayMenu();
    return result;
  };
  ipcMain.handle('shortcuts:get', () => transcriptShortcutState());
  ipcMain.handle('shortcuts:set', (_event, action: TranscriptAction, index: number | null, accelerator: string) =>
    afterShortcutChange(setTranscriptShortcut(action, index, accelerator)),
  );
  ipcMain.handle('shortcuts:remove', (_event, action: TranscriptAction, index: number) =>
    afterShortcutChange(removeTranscriptShortcut(action, index)),
  );
  ipcMain.handle('shortcuts:reset', () => afterShortcutChange(resetTranscriptShortcuts()));
  ipcMain.handle('shortcuts:suspend', () => {
    suspendTranscriptShortcuts();
    return true;
  });
  ipcMain.handle('shortcuts:resume', () => {
    resumeTranscriptShortcuts();
    return true;
  });
}

// Brief notes in the pill after the last-transcript shortcuts, unless it's
// busy showing a dictation.
function showTranscriptFeedback(state: string): void {
  if (dictation.phase !== 'idle' || !overlayWindow || overlayWindow.isDestroyed()) return;
  cancelPendingHide();
  applyOverlayPosition();
  overlayWindow.webContents.send('dictation:state', state);
  overlayWindow.showInactive();
  hideOverlayAfterDelay(1500);
}

app.dock?.hide();

// A second copy would fight the first for the push-to-talk key and the
// speech and MLX ports. Launching again just opens the existing hub.
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
  app.quit();
} else {
  app.on('second-instance', () => createHubWindow());
}

// Without microphone permission macOS doesn't fail the recording, it feeds
// silence, so ask explicitly before the overlay opens its audio stream.
async function ensureMicrophoneAccess(): Promise<void> {
  const status = systemPreferences.getMediaAccessStatus('microphone');
  console.log(`[DictateAI] Microphone access: ${status}`);
  if (status === 'not-determined') {
    const granted = await systemPreferences.askForMediaAccess('microphone');
    console.log(`[DictateAI] Microphone access ${granted ? 'granted' : 'denied'}`);
    if (!granted) noticeMicrophoneBlocked();
  } else if (status !== 'granted') {
    noticeMicrophoneBlocked();
  }
}

app.whenReady().then(async () => {
  if (!isPrimaryInstance) return;

  createTray();
  // On first launch the Welcome window explains each permission before
  // macOS asks for it.
  // Someone updating from an older version with everything already set up
  // has nothing left to do in it.
  const alreadySetUp = settings().llmEnabled && isAccessibilityTrusted()
    && systemPreferences.getMediaAccessStatus('microphone') === 'granted';
  if (!loadConfig().welcomeShown && alreadySetUp) saveConfig({ welcomeShown: true });
  const firstLaunch = !loadConfig().welcomeShown;
  if (!firstLaunch) await ensureMicrophoneAccess();
  overlayWindow = createOverlayWindow();
  registerPushToTalk();
  setupIPC();

  migrateApiKey();
  const savedConfig = loadConfig();
  applySpeech();
  // "Cloud, free" (openrouter/free) was removed for being slow. Move those
  // users to local rather than onto paid credits they never chose.
  if (savedConfig.cloudTier !== undefined) {
    const wasFree = savedConfig.llmProvider === 'cloud' && savedConfig.cloudTier === 'free';
    saveConfig(wasFree ? { llmProvider: 'local', cloudTier: undefined } : { cloudTier: undefined });
    if (wasFree) console.log('[DictateAI] Cloud, free was removed — switched cleanup to local');
  }
  if (savedConfig.shortcut) {
    const s = savedConfig.shortcut;
    setPttKey(s.keyCode, s.flagMask, s.isModifier, s.requiredModifiers);
    console.log(`[DictateAI] Restored shortcut: ${s.display}`);
  }
  setLastTranscriptFeedback(showTranscriptFeedback);
  registerTranscriptShortcuts();
  const { paste, copy } = getTranscriptShortcuts();
  console.log(`[DictateAI] Last transcript: paste ${paste.map(acceleratorSymbol).join(', ')} · copy ${copy.map(acceleratorSymbol).join(', ')}`);
  // Saved middle-row positions (removed) are rewritten to their new spot.
  const pillPosition = settings().pillPosition;
  if (savedConfig.pillPosition && pillPosition !== savedConfig.pillPosition) saveConfig({ pillPosition });
  console.log(`[DictateAI] Pill position: ${pillPosition} · mute while speaking: ${settings().muteWhileSpeaking}`);

  setOnLocalLlmStatusChange(() => {
    if (cleanupReadyNoticePending && isLocalLlmRunning()) {
      cleanupReadyNoticePending = false;
      noticeCleanupReady();
    }
    sendToPages('llm:status-changed');
  });
  syncLocalLlm();

  setOnStatusChange(() => sendToPages('stt:status-changed'));
  // A model finished downloading (or was repaired): use it if it's the one
  // the user's choice and language want.
  setOnSpeechModelReady(() => {
    applySpeech();
    sendToPages('stt:status-changed');
  });

  const hasAccess = firstLaunch ? isAccessibilityTrusted() : checkAccessibilityPermission();
  console.log(
    `[DictateAI] Accessibility permission: ${hasAccess ? 'granted' : 'NEEDS GRANT — check System Settings → Privacy → Accessibility'}`,
  );
  if (!hasAccess) waitForAccessibility();

  if (!isSpeechEngineInstalled()) {
    console.error('[DictateAI] Speech engine not found. Run scripts/build-engines.sh, or: brew install whisperkit-cli');
  } else {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('dictation:state', 'downloading');
    }
    startSpeech();
  }

  if (firstLaunch) {
    saveConfig({ welcomeShown: true });
    createWelcomeWindow();
  }

  console.log(`[DictateAI] Ready. Hold ${settings().shortcutLabel} to dictate.`);
});

function startSpeech(): void {
  speechFailed = false;
  sendToPages('stt:status-changed');
  startServer().then((ok) => {
    speechFailed = !ok;
    if (ok) {
      console.log('[DictateAI] Speech server ready.');
    } else {
      console.error('[DictateAI] Speech server failed to start.');
    }
    sendToPages('stt:status-changed');
  });
}

function speechChoice(): SpeechChoice {
  return loadConfig().speechModel ?? 'auto';
}

// Points the speech server at the model for the current choice and
// language. A model that isn't on disk yet is only used once downloaded,
// except on first run when there is none at all. Phonon's models (about
// 160 MB) download on their own meanwhile; Whisper's wait for Settings.
function applySpeech(): void {
  const lang = loadConfig().language ?? 'auto';
  const wanted = speechModelFor(speechChoice(), lang);
  const model = effectiveSpeechModel(speechChoice(), lang);
  configureSpeech(lang, model);
  if (model !== wanted && SPEECH_MODELS[wanted].engine === 'phonon' && !getPreparingSpeechModel() && hasRoomFor(SPEECH_MODELS[wanted].bytes)) {
    void prepareSpeechModel(wanted).then(() => sendToPages('stt:status-changed'));
  }
}

function hasRoomFor(bytes: number): boolean {
  const freeBytes = freeDiskBytes(path.join(os.homedir(), '.dictateai'));
  return freeBytes == null || freeBytes >= bytes + 1e9;
}

function speechStatus() {
  const lang = loadConfig().language ?? 'auto';
  const choice = speechChoice();
  const wanted = speechModelFor(choice, lang);
  const active = getSpeechModel();
  const bytes = SPEECH_MODELS[wanted].bytes;
  const freeBytes = freeDiskBytes(path.join(os.homedir(), '.dictateai'));
  return {
    installed: isSpeechEngineInstalled(wanted),
    running: isServerRunning(),
    starting: isServerStarting(),
    failed: didServerFail(),
    download: getModelDownload(),
    choice,
    language: lang,
    wanted: { key: wanted, name: SPEECH_MODELS[wanted].name, size: formatBytes(bytes), onDisk: isSpeechModelOnDisk(wanted), broken: isSpeechModelBroken(wanted) },
    active: { key: active, name: SPEECH_MODELS[active].name },
    preparing: getPreparingSpeechModel(),
    free: freeBytes == null ? null : formatBytes(freeBytes),
    enoughSpace: freeBytes == null || freeBytes >= bytes + 1e9,
    sizes: { fast: formatBytes(SPEECH_MODELS.fast.bytes), accurate: formatBytes(SPEECH_MODELS.accurate.bytes) },
  };
}

// Returns whether the speech server restarts for the new language.
function applyLanguage(lang: string, downloadCleanup: boolean): boolean {
  const plan = cleanupPlan(lang);
  saveConfig({
    language: lang,
    cleanupDownloadDeclined: !downloadCleanup && !plan.downloaded ? plan.model : undefined,
  });
  const wasRunning = isServerRunning();
  applySpeech();
  syncLocalLlm();
  // Phonon-2.5 hears all of its languages, so moving between them restarts nothing.
  if (wasRunning && isServerRunning()) {
    sendToPages('stt:status-changed');
    return false;
  }
  sendToPages('stt:restarting');
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('dictation:state', 'restarting');
  }
  return true;
}

// The cleanup model a language would use, and what fetching it costs. The
// size is shown before every download (Welcome, Settings, language change).
function cleanupPlan(lang: string) {
  const model = loadConfig().localModel || defaultLocalModelFor(lang);
  const bytes = localModelBytes(model);
  const downloaded = isLocalModelDownloaded(model);
  const freeBytes = freeDiskBytes(localModelCacheDir());
  return {
    model,
    size: formatBytes(bytes),
    downloaded,
    free: freeBytes == null ? null : formatBytes(freeBytes),
    // Room for the model plus 2 GB, so the download never fills the disk.
    enoughSpace: downloaded || freeBytes == null || freeBytes >= bytes + 2e9,
    // The larger model holds about 4.3 GB of memory while loaded.
    lowMemory: bytes > 3e9 && os.totalmem() < 12 * 1024 ** 3,
    declined: loadConfig().cleanupDownloadDeclined === model && !downloaded,
  };
}

// The push-to-talk key needs Accessibility. On a fresh install it isn't
// granted yet, so watch for the grant and start listening then, without
// asking the user to restart the app.
function waitForAccessibility(): void {
  const timer = setInterval(() => {
    if (!isAccessibilityTrusted()) return;
    clearInterval(timer);
    console.log('[DictateAI] Accessibility granted — starting push-to-talk');
    stopPushToTalk();
    registerPushToTalk();
    const shortcut = loadConfig().shortcut;
    if (shortcut) setPttKey(shortcut.keyCode, shortcut.flagMask, shortcut.isModifier, shortcut.requiredModifiers);
    sendToPages('stt:status-changed');
  }, 2000);
}

// Keep the local model loaded only while it can be used: it holds ~4.5 GB.
function syncLocalLlm(): void {
  if (settings().llmEnabled && getLlmProvider() === 'local') {
    const config = loadConfig();
    const model = config.localModel || defaultLocalModelFor(config.language);
    const downloaded = isLocalModelDownloaded(model);
    // "Not now" to this model's download: dictation stays plain text.
    if (config.cleanupDownloadDeclined === model && !downloaded) {
      stopLocalLlm();
      return;
    }
    if (!downloaded && !config.notices?.cleanupReadyShown) cleanupReadyNoticePending = true;
    startLocalLlm(model);
  } else {
    stopLocalLlm();
  }
}

app.on('will-quit', () => {
  stopServer();
  stopLocalLlm();
  stopPushToTalk();
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  // Don't quit — we're a menu bar app
});
