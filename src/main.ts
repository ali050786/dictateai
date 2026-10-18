import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
} from 'electron';
import {
  injectText,
  undoLastInjection,
  checkAccessibilityPermission,
  startPushToTalk,
  stopPushToTalk,
  setPttKey,
} from './text-injection';
import { transcribe, isModelDownloaded, downloadModel, setLanguage, getLanguage, getModel, startServer, stopServer, isServerRunning, isWhisperKitInstalled, setOnStatusChange } from './whisper-engine';
import { formatText, hasApiKey, saveApiKey, loadConfig, saveConfig, ShortcutConfig } from './llm-formatter';
import { getFocusedElementInfo } from './text-injection';
import { applyReplacements, detectCorrections, addCorrection, getAllCorrections, removeCorrection } from './dictionary';
import started from 'electron-squirrel-startup';

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;
declare const HUB_WINDOW_WEBPACK_ENTRY: string;
declare const HUB_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

if (started) {
  app.quit();
}

let tray: Tray | null = null;
let overlayWindow: BrowserWindow | null = null;
let hubWindow: BrowserWindow | null = null;
let isRecording = false;
let audioChunks: Float32Array[] = [];
let lastInjectedText = '';
let lastPTTDown = 0;
let handsFreeActive = false;
let llmEnabled = false;
let previewTimer: ReturnType<typeof setInterval> | null = null;
let previewInFlight = false;

const dictationHistory: { text: string; app: string; time: string }[] = [];

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

  win.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
  win.setIgnoreMouseEvents(true);
  win.hide();

  return win;
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

  hubWindow.loadURL(HUB_WINDOW_WEBPACK_ENTRY);

  hubWindow.once('ready-to-show', () => {
    app.dock?.show();
    hubWindow?.show();
  });

  hubWindow.on('closed', () => {
    hubWindow = null;
    app.dock?.hide();
  });
}

function createTray(): void {
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAADklEQVQ4jWNgGAWDEwAAAhAAAQmkWEEAAAAASUVORK5CYII=',
  );
  icon.setTemplateImage(true);

  tray = new Tray(icon);
  tray.setTitle('🎙');
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
    { type: 'separator' },
    {
      label: isRecording ? '⏹ Stop Recording' : '🎙 Start Recording',
      click: () => toggleRecording(),
    },
    {
      label: 'Hold Right ⌥ Option to dictate',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Quit DictateAI',
      click: () => app.quit(),
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.setTitle(isRecording ? '🔴' : '🎙');
}

function toggleRecording(): void {
  console.log(
    `[DictateAI] toggleRecording called — isRecording=${isRecording}`,
  );
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
}

function startRecording(): void {
  isRecording = true;
  audioChunks = [];
  updateTrayMenu();
  console.log('[DictateAI] Recording started');

  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('dictation:state', 'recording');
    overlayWindow.showInactive();
  }

  startPreviewTimer();
}

function stopRecording(): void {
  isRecording = false;
  stopPreviewTimer();
  updateTrayMenu();
  console.log(
    `[DictateAI] Recording stopped — ${audioChunks.length} chunks collected`,
  );

  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('dictation:state', 'processing');
  }

  processAudio();
}

function startPreviewTimer(): void {
  stopPreviewTimer();
  previewTimer = setInterval(async () => {
    if (!isRecording || audioChunks.length === 0 || previewInFlight) return;

    const totalLength = audioChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (totalLength / 16000 < 1.0) return;

    const combined = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of audioChunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    previewInFlight = true;
    try {
      const preview = await transcribe(combined);
      if (isRecording && preview && !/^\s*[\[(].*[\])]\s*$/i.test(preview)) {
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.webContents.send('dictation:preview', preview);
        }
      }
    } catch {
      // preview failures are non-critical
    } finally {
      previewInFlight = false;
    }
  }, 2000);
}

function stopPreviewTimer(): void {
  if (previewTimer) {
    clearInterval(previewTimer);
    previewTimer = null;
  }
  previewInFlight = false;
}

async function processAudio(): Promise<void> {
  if (audioChunks.length === 0) {
    console.log('[DictateAI] No audio chunks — skipping');
    finishProcessing('');
    return;
  }

  const totalLength = audioChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const combined = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of audioChunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  const durationSec = combined.length / 16000;
  if (durationSec < 0.3) {
    console.log(`[DictateAI] Recording too short (${durationSec.toFixed(1)}s) — skipping`);
    finishProcessing('');
    return;
  }

  console.log(
    `[DictateAI] Processing ${durationSec.toFixed(1)}s of audio (${combined.length} samples)`,
  );

  try {
    const rawText = await transcribe(combined);
    if (!rawText || /^\s*[\[(].*[\])]\s*$/i.test(rawText) || rawText.trim().length < 2) {
      console.log(`[DictateAI] No usable speech detected: "${rawText}"`);
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('dictation:state', 'empty');
      }
      hideOverlayAfterDelay(1500);
      finishProcessing('');
      return;
    }

    const correctedText = applyReplacements(rawText);
    const context = getFocusedElementInfo();

    if (llmEnabled && hasApiKey()) {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('dictation:state', 'formatting');
      }
      try {
        const formatted = await formatText(correctedText, 'dictation', {
          app: context.app,
          role: context.role,
        });
        finishProcessing(formatted || correctedText, context.app);
      } catch (err) {
        console.error('[DictateAI] LLM formatting failed, using raw:', err);
        finishProcessing(correctedText, context.app);
      }
    } else {
      finishProcessing(correctedText, context.app);
    }
  } catch (err) {
    console.error('[DictateAI] Transcription failed:', err);
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('dictation:state', 'error');
    }
    hideOverlayAfterDelay(2000);
    finishProcessing('');
  }
}

function hideOverlayAfterDelay(ms: number): void {
  setTimeout(() => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('dictation:state', 'idle');
      setTimeout(() => {
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.hide();
        }
      }, 300);
    }
  }, ms);
}

function finishProcessing(text: string, appName?: string): void {
  audioChunks = [];

  if (text) {
    console.log(`[DictateAI] Result: ${text}`);

    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('dictation:state', 'injecting');
    }

    const method = injectText(text);
    console.log(`[DictateAI] Injected via: ${method}`);
    lastInjectedText = text;
    hideOverlayAfterDelay(1200);

    const entry = { text, app: appName || '', time: new Date().toISOString() };
    dictationHistory.unshift(entry);
    if (dictationHistory.length > 100) dictationHistory.pop();

    if (hubWindow && !hubWindow.isDestroyed()) {
      hubWindow.webContents.send('dictation:log', entry);
    }

    setTimeout(() => {
      if (!lastInjectedText) return;
      try {
        const fieldInfo = getFocusedElementInfo();
        console.log(`[DictateAI] Correction check — available: ${fieldInfo.available}, app: ${fieldInfo.app}, role: ${fieldInfo.role}`);
        console.log(`[DictateAI] Correction check — title: "${fieldInfo.title || ''}", value: "${(fieldInfo.value || '').slice(0, 200)}"`);
        console.log(`[DictateAI] Correction check — injected: "${lastInjectedText}"`);
        if (fieldInfo.available && fieldInfo.value) {
          detectCorrections(lastInjectedText, fieldInfo.value);
        } else {
          console.log('[DictateAI] Correction check — no value from focused element');
        }
      } catch (err) {
        console.error('[DictateAI] Correction check error:', err);
      }
      lastInjectedText = '';
    }, 5000);
  }
}

function registerPushToTalk(): void {
  const DOUBLE_TAP_MS = 400;
  const TRIPLE_TAP_MS = 600;
  let tapCount = 0;
  let tapTimer: ReturnType<typeof setTimeout> | null = null;

  const started = startPushToTalk((event) => {
    const now = Date.now();

    if (event === 'down') {
      if (handsFreeActive) {
        console.log('[DictateAI] Hands-free: key down — stop recording');
        handsFreeActive = false;
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

      if (tapCount >= 3 && !isRecording) {
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

      if (tapCount === 2 && !isRecording) {
        tapTimer = setTimeout(() => {
          console.log('[DictateAI] Double-tap confirmed — hands-free mode');
          handsFreeActive = true;
          startRecording();
          if (overlayWindow && !overlayWindow.isDestroyed()) {
            overlayWindow.webContents.send('dictation:handsfree', true);
            overlayWindow.setIgnoreMouseEvents(true, { forward: true });
          }
          tapCount = 0;
        }, TRIPLE_TAP_MS);
        return;
      }

      if (tapCount === 1 && !isRecording) {
        console.log('[DictateAI] PTT key down — start recording');
        startRecording();
      }
    } else if (event === 'up') {
      if (handsFreeActive) return;
      if (isRecording && tapCount <= 1) {
        console.log('[DictateAI] PTT key up — stop recording');
        stopRecording();
      }
    }
  });
  console.log(`[DictateAI] Push-to-talk monitor started: ${started}`);
}

function setupIPC(): void {
  ipcMain.on('audio:chunk', (_event, data: ArrayBuffer) => {
    if (isRecording) {
      audioChunks.push(new Float32Array(data));
    }
  });

  ipcMain.on('overlay:stopRecording', () => {
    if (isRecording) {
      console.log('[DictateAI] Stop recording from overlay close button');
      handsFreeActive = false;
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
    return isRecording ? 'recording' : 'idle';
  });

  ipcMain.handle('config:hasApiKey', () => hasApiKey());
  ipcMain.handle('config:setApiKey', (_event, key: string) => {
    saveApiKey(key);
    return true;
  });
  ipcMain.handle('config:hasAccessibility', () => checkAccessibilityPermission());

  ipcMain.handle('dictionary:add', (_event, from: string, to: string) => {
    addCorrection(from, to);
    return true;
  });
  ipcMain.handle('dictionary:remove', (_event, from: string) => {
    return removeCorrection(from);
  });
  ipcMain.handle('dictionary:list', () => {
    return getAllCorrections();
  });

  ipcMain.handle('history:list', () => {
    return dictationHistory;
  });

  ipcMain.handle('config:getLanguage', () => getLanguage());
  ipcMain.handle('config:setLanguage', async (_event, lang: string) => {
    setLanguage(lang);
    saveConfig({ language: lang });
    if (hubWindow && !hubWindow.isDestroyed()) {
      hubWindow.webContents.send('stt:restarting');
    }
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('dictation:state', 'restarting');
    }
    return true;
  });
  ipcMain.handle('config:getLlmEnabled', () => llmEnabled);
  ipcMain.handle('config:setLlmEnabled', (_event, enabled: boolean) => {
    llmEnabled = enabled;
    saveConfig({ llmEnabled: enabled });
    return true;
  });
  ipcMain.handle('config:sttStatus', () => ({
    installed: isWhisperKitInstalled(),
    running: isServerRunning(),
    engine: 'WhisperKit',
    model: getModel(),
  }));

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
}

app.dock?.hide();

app.whenReady().then(() => {
  createTray();
  overlayWindow = createOverlayWindow();
  registerPushToTalk();
  setupIPC();

  const savedConfig = loadConfig();
  if (savedConfig.language) {
    setLanguage(savedConfig.language);
  }
  if (savedConfig.llmEnabled !== undefined) {
    llmEnabled = savedConfig.llmEnabled;
  }
  if (savedConfig.shortcut) {
    const s = savedConfig.shortcut;
    setPttKey(s.keyCode, s.flagMask, s.isModifier, s.requiredModifiers);
    console.log(`[DictateAI] Restored shortcut: ${s.display}`);
  }

  setOnStatusChange(() => {
    if (hubWindow && !hubWindow.isDestroyed()) {
      hubWindow.webContents.send('stt:status-changed');
    }
  });

  const hasAccess = checkAccessibilityPermission();
  console.log(
    `[DictateAI] Accessibility permission: ${hasAccess ? 'granted' : 'NEEDS GRANT — check System Settings → Privacy → Accessibility'}`,
  );

  if (!isWhisperKitInstalled()) {
    console.error('[DictateAI] WhisperKit CLI not found. Install with: brew install whisperkit-cli');
  } else {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('dictation:state', 'downloading');
    }
    startServer().then((ok) => {
      if (ok) {
        console.log('[DictateAI] WhisperKit server ready.');
      } else {
        console.error('[DictateAI] WhisperKit server failed to start.');
      }
      if (hubWindow && !hubWindow.isDestroyed()) {
        hubWindow.webContents.send('stt:status-changed');
      }
    });
  }

  console.log('[DictateAI] Ready. Hold Right Option key to dictate.');
});

app.on('will-quit', () => {
  stopServer();
  stopPushToTalk();
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  // Don't quit — we're a menu bar app
});
