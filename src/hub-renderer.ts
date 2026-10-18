import './hub.css';

interface DictionaryEntry {
  from: string;
  to: string;
  count: number;
  lastUsed: string;
}

interface ShortcutConfig {
  code: string;
  display: string;
  keyCode: number;
  flagMask: number;
  isModifier: boolean;
  requiredModifiers: number;
}

interface HubAPI {
  dictionary: {
    list: () => Promise<DictionaryEntry[]>;
    add: (from: string, to: string) => Promise<boolean>;
    remove: (from: string) => Promise<boolean>;
  };
  config: {
    hasApiKey: () => Promise<boolean>;
    setApiKey: (key: string) => Promise<boolean>;
    removeApiKey: () => Promise<boolean>;
    hasAccessibility: () => Promise<boolean>;
    getLanguage: () => Promise<string>;
    setLanguage: (lang: string) => Promise<boolean>;
    sttStatus: () => Promise<{ installed: boolean; running: boolean; engine: string; model: string }>;
    getLlmEnabled: () => Promise<boolean>;
    setLlmEnabled: (enabled: boolean) => Promise<boolean>;
    getLlmProvider: () => Promise<'local' | 'cloud'>;
    setLlmProvider: (provider: 'local' | 'cloud', tier?: 'free' | 'paid') => Promise<boolean>;
    llmStatus: () => Promise<{
      provider: 'local' | 'cloud';
      mlxInstalled: boolean;
      running: boolean;
      starting: boolean;
      model: string;
      cloudTier: 'free' | 'paid';
      cloudModel: string;
    }>;
    getPaidModel: () => Promise<string>;
    setPaidModel: (model: string) => Promise<boolean>;
    getShortcut: () => Promise<ShortcutConfig | null>;
    setShortcut: (shortcut: ShortcutConfig) => Promise<boolean>;
    getAudioDevice: () => Promise<string>;
    setAudioDevice: (deviceId: string) => Promise<boolean>;
    getPillPosition: () => Promise<string>;
    setPillPosition: (position: string) => Promise<boolean>;
    getMuteWhileSpeaking: () => Promise<boolean>;
    setMuteWhileSpeaking: (enabled: boolean) => Promise<boolean>;
  };
  history: {
    list: () => Promise<HistoryEntry[]>;
  };
  onDictationLog: (callback: (entry: HistoryEntry) => void) => () => void;
  onLlmStatusChanged: (callback: () => void) => () => void;
  onSttRestarting: (callback: () => void) => () => void;
  onSttStatusChanged: (callback: () => void) => () => void;
  openExternal: (url: string) => void;
}

declare global {
  interface Window {
    hub: HubAPI;
  }
}

// --- Navigation ---
const navItems = document.querySelectorAll<HTMLButtonElement>('.nav-item[data-page]');
const pages = document.querySelectorAll<HTMLElement>('.page');

navItems.forEach(item => {
  item.addEventListener('click', () => {
    const page = item.dataset.page;
    if (!page) return;

    navItems.forEach(n => n.classList.remove('active'));
    item.classList.add('active');

    pages.forEach(p => {
      p.classList.toggle('active', p.id === `page-${page}`);
    });

    if (page === 'dictionary') loadDictionary();
    if (page === 'settings') loadSettings();
    if (page === 'dictation') loadHistory();
    if (page === 'shortcuts') loadShortcuts();
  });
});

// --- Dictionary ---
const dictList = document.getElementById('dictionary-list')!;
const dictEmpty = document.getElementById('dict-empty')!;
const dictModal = document.getElementById('dict-modal')!;
const btnAddWord = document.getElementById('btn-add-word')!;
const btnCancel = document.getElementById('btn-cancel')!;
const btnSave = document.getElementById('btn-save')!;
const inputFrom = document.getElementById('dict-from') as HTMLInputElement;
const inputTo = document.getElementById('dict-to') as HTMLInputElement;
const modalTitle = document.getElementById('modal-title')!;

let editingFrom: string | null = null;

async function loadDictionary(): Promise<void> {
  const entries = await window.hub.dictionary.list();
  renderDictionary(entries);
}

function renderDictionary(entries: DictionaryEntry[]): void {
  const existingEntries = dictList.querySelectorAll('.dict-entry');
  existingEntries.forEach(e => e.remove());

  if (entries.length === 0) {
    dictEmpty.style.display = 'flex';
    return;
  }

  dictEmpty.style.display = 'none';

  entries.forEach(entry => {
    const el = document.createElement('div');
    el.className = 'dict-entry';
    el.innerHTML = `
      <div class="dict-entry-text">
        <span class="dict-entry-from">${escapeHtml(entry.from)}</span>
        <span class="dict-entry-arrow">→</span>
        <span class="dict-entry-to">${escapeHtml(entry.to)}</span>
        ${entry.count > 1 ? `<span class="dict-entry-sparkle">✨</span>` : ''}
      </div>
      <div class="dict-entry-actions">
        <button class="btn-icon" data-action="edit" title="Edit">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </button>
        <button class="btn-icon danger" data-action="delete" title="Remove">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>
      </div>
    `;

    const editBtn = el.querySelector('[data-action="edit"]')!;
    const deleteBtn = el.querySelector('[data-action="delete"]')!;

    editBtn.addEventListener('click', () => {
      editingFrom = entry.from;
      modalTitle.textContent = 'Edit word';
      inputFrom.value = entry.from;
      inputTo.value = entry.to;
      dictModal.classList.remove('hidden');
      inputTo.focus();
    });

    deleteBtn.addEventListener('click', async () => {
      await window.hub.dictionary.remove(entry.from);
      loadDictionary();
    });

    dictList.appendChild(el);
  });
}

btnAddWord.addEventListener('click', () => {
  editingFrom = null;
  modalTitle.textContent = 'Add new word';
  inputFrom.value = '';
  inputTo.value = '';
  dictModal.classList.remove('hidden');
  inputFrom.focus();
});

btnCancel.addEventListener('click', () => {
  dictModal.classList.add('hidden');
});

dictModal.querySelector('.modal-backdrop')!.addEventListener('click', () => {
  dictModal.classList.add('hidden');
});

btnSave.addEventListener('click', async () => {
  const from = inputFrom.value.trim();
  const to = inputTo.value.trim();
  if (!from || !to) return;

  if (editingFrom && editingFrom !== from) {
    await window.hub.dictionary.remove(editingFrom);
  }
  await window.hub.dictionary.add(from, to);
  dictModal.classList.add('hidden');
  loadDictionary();
});

inputTo.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnSave.click();
});

inputFrom.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') inputTo.focus();
});

// --- Settings ---
const apiKeyStatus = document.getElementById('api-key-status')!;
const accessibilityStatus = document.getElementById('accessibility-status')!;
const btnChangeKey = document.getElementById('btn-change-key')!;
const btnRemoveKey = document.getElementById('btn-remove-key')!;
const apikeyModal = document.getElementById('apikey-modal')!;
const btnCancelKey = document.getElementById('btn-cancel-key')!;
const btnSaveKey = document.getElementById('btn-save-key')!;
const apiKeyInput = document.getElementById('api-key-input') as HTMLInputElement;
const openrouterLink = document.getElementById('openrouter-link')!;

const languageSelect = document.getElementById('language-select') as HTMLSelectElement;
const llmToggle = document.getElementById('llm-toggle') as HTMLInputElement;
const llmProviderSelect = document.getElementById('llm-provider-select') as HTMLSelectElement;
const llmProviderDesc = document.getElementById('llm-provider-desc')!;
const llmModelName = document.getElementById('llm-model-name')!;
const apiKeyRow = document.getElementById('api-key-row')!;
const paidModelRow = document.getElementById('paid-model-row')!;
const paidModelInput = document.getElementById('paid-model-input') as HTMLInputElement;
const micSelect = document.getElementById('mic-select') as HTMLSelectElement;
const micStatus = document.getElementById('mic-status')!;

async function loadSettings(): Promise<void> {
  const hasKey = await window.hub.config.hasApiKey();
  apiKeyStatus.textContent = hasKey
    ? 'Saved on this Mac ✓'
    : 'Not set. Until you add one, cleanup runs on your Mac.';
  apiKeyStatus.style.color = hasKey ? '#059669' : '#dc2626';
  btnChangeKey.textContent = hasKey ? 'Change' : 'Add key';
  btnRemoveKey.style.display = hasKey ? '' : 'none';

  const hasAccess = await window.hub.config.hasAccessibility();
  accessibilityStatus.textContent = hasAccess ? 'Granted ✓' : 'Not granted — check System Settings → Privacy → Accessibility';
  accessibilityStatus.style.color = hasAccess ? '#059669' : '#dc2626';

  const lang = await window.hub.config.getLanguage();
  languageSelect.value = lang;

  const savedPos = await window.hub.config.getPillPosition();
  const posGrid = document.getElementById('pill-position-grid')!;
  posGrid.querySelectorAll('.pill-pos').forEach(btn => {
    btn.classList.toggle('active', (btn as HTMLElement).dataset.pos === savedPos);
  });

  loadMicDevices();

  const muteToggle = document.getElementById('mute-toggle') as HTMLInputElement;
  muteToggle.checked = await window.hub.config.getMuteWhileSpeaking();
  muteToggle.addEventListener('change', () => {
    window.hub.config.setMuteWhileSpeaking(muteToggle.checked);
  });

  const llmOn = await window.hub.config.getLlmEnabled();
  llmToggle.checked = llmOn;
  await loadLlmStatus();

  const stt = await window.hub.config.sttStatus();
  const sttStatus = document.getElementById('stt-status')!;
  const sttBadge = document.getElementById('stt-badge')!;
  if (!stt.installed) {
    sttStatus.textContent = 'WhisperKit not installed — run: brew install whisperkit-cli';
    sttStatus.style.color = '#dc2626';
    sttBadge.textContent = 'Missing';
    sttBadge.className = 'badge badge-red';
  } else if (stt.running) {
    sttStatus.textContent = `WhisperKit · ${stt.model} model (local)`;
    sttStatus.style.color = '';
    sttBadge.textContent = 'Running';
    sttBadge.className = 'badge badge-green';
  } else {
    sttStatus.textContent = `WhisperKit · ${stt.model} — starting…`;
    sttStatus.style.color = '';
    sttBadge.textContent = 'Starting';
    sttBadge.className = 'badge badge-blue';
  }
}

async function loadMicDevices(): Promise<void> {
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true }).then(s => {
      s.getTracks().forEach(t => t.stop());
    });
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter(d => d.kind === 'audioinput');

    const savedDevice = await window.hub.config.getAudioDevice();

    while (micSelect.options.length > 1) micSelect.remove(1);

    audioInputs.forEach(device => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || `Microphone (${device.deviceId.slice(0, 8)}…)`;
      micSelect.appendChild(option);
    });

    micSelect.value = savedDevice || '';
    const selected = micSelect.selectedOptions[0];
    micStatus.textContent = selected?.textContent || 'System Default';
  } catch {
    micStatus.textContent = 'Microphone access needed';
  }
}

micSelect.addEventListener('change', async () => {
  await window.hub.config.setAudioDevice(micSelect.value);
  const selected = micSelect.selectedOptions[0];
  micStatus.textContent = selected?.textContent || 'System Default';
});

navigator.mediaDevices.addEventListener('devicechange', () => loadMicDevices());

languageSelect.addEventListener('change', async () => {
  await window.hub.config.setLanguage(languageSelect.value);
  languageSelect.disabled = true;
  const sttStatus = document.getElementById('stt-status')!;
  const sttBadge = document.getElementById('stt-badge')!;
  sttStatus.textContent = 'WhisperKit — restarting for new language…';
  sttBadge.textContent = 'Restarting';
  sttBadge.className = 'badge badge-yellow';
});

window.hub.onSttRestarting(() => {
  const sttStatus = document.getElementById('stt-status')!;
  const sttBadge = document.getElementById('stt-badge')!;
  sttStatus.textContent = 'WhisperKit — restarting…';
  sttBadge.textContent = 'Restarting';
  sttBadge.className = 'badge badge-yellow';
  languageSelect.disabled = true;
});

window.hub.onSttStatusChanged(() => {
  languageSelect.disabled = false;
  loadSettings();
});

llmToggle.addEventListener('change', async () => {
  await window.hub.config.setLlmEnabled(llmToggle.checked);
  loadLlmStatus();
});

async function loadLlmStatus(): Promise<void> {
  const status = await window.hub.config.llmStatus();
  const isCloud = status.provider === 'cloud';
  llmProviderSelect.value = isCloud ? `cloud-${status.cloudTier}` : 'local';
  apiKeyRow.style.display = isCloud ? '' : 'none';
  paidModelRow.style.display = isCloud && status.cloudTier === 'paid' ? '' : 'none';
  llmProviderDesc.style.color = '';

  if (isCloud) {
    llmProviderDesc.textContent = status.cloudTier === 'free'
      ? 'Your OpenRouter key. About 50 cleanups a day, then your Mac takes over.'
      : 'Your OpenRouter key, your credits.';
    llmModelName.textContent = status.cloudModel;
    if (status.cloudTier === 'paid' && document.activeElement !== paidModelInput) {
      paidModelInput.value = status.cloudModel;
    }
  } else if (!status.mlxInstalled) {
    llmProviderDesc.textContent = 'mlx-lm not installed — run: uv tool install mlx-lm';
    llmProviderDesc.style.color = '#dc2626';
    llmModelName.textContent = '';
  } else {
    const state = status.running
      ? 'ready'
      : status.starting
        ? 'loading (first run downloads the model)…'
        : llmToggle.checked ? 'stopped' : 'off until AI Text Cleanup is on';
    llmProviderDesc.textContent = `Private, unlimited — ${state}`;
    llmProviderDesc.style.color = status.running ? '#059669' : '';
    llmModelName.textContent = status.model;
  }
}

llmProviderSelect.addEventListener('change', async () => {
  const value = llmProviderSelect.value;
  if (value === 'local') {
    await window.hub.config.setLlmProvider('local');
  } else {
    await window.hub.config.setLlmProvider('cloud', value === 'cloud-paid' ? 'paid' : 'free');
    // Cloud only ever uses the user's own key; ask for it right away.
    if (!(await window.hub.config.hasApiKey())) openKeyModal();
  }
  loadLlmStatus();
});

paidModelInput.addEventListener('change', async () => {
  await window.hub.config.setPaidModel(paidModelInput.value);
  loadLlmStatus();
});

paidModelInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') paidModelInput.blur();
});

window.hub.onLlmStatusChanged(() => {
  loadLlmStatus();
});

function openKeyModal(): void {
  apiKeyInput.value = '';
  apikeyModal.classList.remove('hidden');
  apiKeyInput.focus();
}

btnChangeKey.addEventListener('click', openKeyModal);

btnRemoveKey.addEventListener('click', async () => {
  if (!confirm('Remove your OpenRouter key from this Mac? Cloud cleanup will stop until you add one again.')) return;
  await window.hub.config.removeApiKey();
  loadSettings();
});

btnCancelKey.addEventListener('click', () => {
  apikeyModal.classList.add('hidden');
});

apikeyModal.querySelector('.modal-backdrop')!.addEventListener('click', () => {
  apikeyModal.classList.add('hidden');
});

btnSaveKey.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  if (!key) return;
  await window.hub.config.setApiKey(key);
  apikeyModal.classList.add('hidden');
  loadSettings();
});

apiKeyInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnSaveKey.click();
});

openrouterLink.addEventListener('click', (e) => {
  e.preventDefault();
  window.hub.openExternal('https://openrouter.ai/keys');
});

// --- Dictation History ---
// location: where cleanup ran. Raw text counts as local; it never left the Mac.
interface HistoryEntry { text: string; app: string; time: string; location?: 'local' | 'cloud' }

const historyContainer = document.getElementById('dictation-history')!;
const dictationLog: HistoryEntry[] = [];

async function loadHistory(): Promise<void> {
  const entries = await window.hub.history.list();
  renderHistory(entries);
}

function renderHistory(entries: HistoryEntry[]): void {
  const existing = historyContainer.querySelectorAll('.history-entry');
  existing.forEach(e => e.remove());

  const empty = historyContainer.querySelector('.empty-state') as HTMLElement;

  if (entries.length === 0) {
    if (empty) empty.style.display = 'flex';
    return;
  }

  if (empty) empty.style.display = 'none';

  entries.forEach(entry => {
    const el = document.createElement('div');
    el.className = 'history-entry';

    const date = new Date(entry.time);
    const timeStr = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

    el.innerHTML = `
      <div class="history-time">${timeStr}</div>
      <div class="history-text">${escapeHtml(entry.text)}</div>
      <div class="history-meta">
        <span class="badge ${entry.location === 'cloud' ? 'badge-blue' : 'badge-green'}">${entry.location === 'cloud' ? 'Cloud' : 'Local'}</span>
        ${entry.app ? `<span class="history-app">${escapeHtml(entry.app)}</span>` : ''}
      </div>
    `;
    historyContainer.appendChild(el);
  });
}

window.hub.onDictationLog((entry) => {
  dictationLog.unshift(entry);
  if (document.getElementById('page-dictation')!.classList.contains('active')) {
    renderHistory(dictationLog);
  }
});

// --- Shortcuts ---
const shortcutModal = document.getElementById('shortcut-modal')!;
const shortcutModalTitle = document.getElementById('shortcut-modal-title')!;
const shortcutRecordArea = document.getElementById('shortcut-record-area')!;
const shortcutRecordPrompt = document.getElementById('shortcut-record-prompt')!;
const btnCancelShortcut = document.getElementById('btn-cancel-shortcut')!;
const btnSaveShortcut = document.getElementById('btn-save-shortcut')!;

let editingShortcut: 'ptt' | 'handsfree' | null = null;
let recordedKeyDisplay = '';
let recordedKeyCode = '';
let recordedModifiers = { meta: false, ctrl: false, alt: false, shift: false };

const DEFAULT_KEY = 'Right ⌥ Option';
const DEFAULT_SHORTCUT: ShortcutConfig = {
  code: 'AltRight', display: DEFAULT_KEY,
  keyCode: 0x3D, flagMask: 0x00000040, isModifier: true, requiredModifiers: 0,
};

const MODIFIER_LABELS: Record<string, string> = {
  'AltLeft': 'Left ⌥ Option', 'AltRight': 'Right ⌥ Option',
  'ControlLeft': 'Left ⌃ Control', 'ControlRight': 'Right ⌃ Control',
  'MetaLeft': 'Left ⌘ Command', 'MetaRight': 'Right ⌘ Command',
  'ShiftLeft': 'Left ⇧ Shift', 'ShiftRight': 'Right ⇧ Shift',
};

const MODIFIER_FLAG_MASKS: Record<string, number> = {
  'ShiftLeft': 0x00000002, 'ShiftRight': 0x00000004,
  'ControlLeft': 0x00000001, 'ControlRight': 0x00002000,
  'AltLeft': 0x00000020, 'AltRight': 0x00000040,
  'MetaLeft': 0x00000008, 'MetaRight': 0x00000010,
};

const CODE_TO_MAC_KEYCODE: Record<string, number> = {
  'KeyA': 0x00, 'KeyS': 0x01, 'KeyD': 0x02, 'KeyF': 0x03,
  'KeyH': 0x04, 'KeyG': 0x05, 'KeyZ': 0x06, 'KeyX': 0x07,
  'KeyC': 0x08, 'KeyV': 0x09, 'KeyB': 0x0B, 'KeyQ': 0x0C,
  'KeyW': 0x0D, 'KeyE': 0x0E, 'KeyR': 0x0F, 'KeyY': 0x10,
  'KeyT': 0x11, 'KeyO': 0x1F, 'KeyU': 0x20, 'KeyI': 0x22,
  'KeyP': 0x23, 'KeyL': 0x25, 'KeyJ': 0x26, 'KeyK': 0x28,
  'KeyN': 0x2D, 'KeyM': 0x2E,
  'Digit1': 0x12, 'Digit2': 0x13, 'Digit3': 0x14, 'Digit4': 0x15,
  'Digit5': 0x17, 'Digit6': 0x16, 'Digit7': 0x1A, 'Digit8': 0x1C,
  'Digit9': 0x19, 'Digit0': 0x1D,
  'Space': 0x31, 'Backquote': 0x32, 'Minus': 0x1B, 'Equal': 0x18,
  'BracketLeft': 0x21, 'BracketRight': 0x1E, 'Backslash': 0x2A,
  'Semicolon': 0x29, 'Quote': 0x27, 'Comma': 0x2B, 'Period': 0x2F,
  'Slash': 0x2C, 'Enter': 0x24, 'Tab': 0x30, 'Backspace': 0x33,
  'F1': 0x7A, 'F2': 0x78, 'F3': 0x63, 'F4': 0x76,
  'F5': 0x60, 'F6': 0x61, 'F7': 0x62, 'F8': 0x64,
  'F9': 0x65, 'F10': 0x6D, 'F11': 0x67, 'F12': 0x6F,
  'F13': 0x69, 'F14': 0x6B, 'F15': 0x71, 'F16': 0x6A,
  'ShiftLeft': 0x38, 'ShiftRight': 0x3C,
  'ControlLeft': 0x3B, 'ControlRight': 0x3E,
  'AltLeft': 0x3A, 'AltRight': 0x3D,
  'MetaLeft': 0x37, 'MetaRight': 0x36,
  'CapsLock': 0x39,
};

async function loadShortcuts(): Promise<void> {
  const pttDot = document.getElementById('ptt-status-dot')!;
  const pttText = document.getElementById('ptt-status-text')!;
  const hfDot = document.getElementById('handsfree-status-dot')!;
  const hfText = document.getElementById('handsfree-status-text')!;

  pttDot.classList.remove('inactive');
  pttText.textContent = 'Active';
  hfDot.classList.remove('inactive');
  hfText.textContent = 'Active';

  const saved = await window.hub.config.getShortcut();
  const display = saved?.display || DEFAULT_KEY;
  document.getElementById('ptt-key-display')!.textContent = display;
  document.getElementById('handsfree-key-display')!.textContent = display;
}

function keyEventToLabel(e: KeyboardEvent): string {
  const code = e.code;

  if (code in MODIFIER_LABELS) {
    return MODIFIER_LABELS[code];
  }

  const parts: string[] = [];
  if (e.metaKey) parts.push('⌘');
  if (e.ctrlKey) parts.push('⌃');
  if (e.altKey) parts.push('⌥');
  if (e.shiftKey) parts.push('⇧');

  const key = e.key;
  if (key === ' ') parts.push('Space');
  else if (key === 'ArrowUp') parts.push('↑');
  else if (key === 'ArrowDown') parts.push('↓');
  else if (key === 'ArrowLeft') parts.push('←');
  else if (key === 'ArrowRight') parts.push('→');
  else if (key === 'Enter') parts.push('Return');
  else if (key === 'Backspace') parts.push('⌫');
  else if (key === 'Tab') parts.push('⇥');
  else if (key === 'CapsLock') parts.push('⇪');
  else if (!['Meta', 'Control', 'Alt', 'Shift'].includes(key)) {
    parts.push(key.length === 1 ? key.toUpperCase() : key);
  }

  return parts.join(' + ') || 'Press a key…';
}

function buildShortcutConfig(code: string, modifiers: typeof recordedModifiers, display: string): ShortcutConfig | null {
  const macKeyCode = CODE_TO_MAC_KEYCODE[code];
  if (macKeyCode === undefined) return null;

  if (code in MODIFIER_FLAG_MASKS) {
    return {
      code, display, keyCode: macKeyCode,
      flagMask: MODIFIER_FLAG_MASKS[code],
      isModifier: true, requiredModifiers: 0,
    };
  }

  let reqMods = 0;
  if (modifiers.meta) reqMods |= 0x00100000;
  if (modifiers.ctrl) reqMods |= 0x00040000;
  if (modifiers.alt) reqMods |= 0x00080000;
  if (modifiers.shift) reqMods |= 0x00020000;

  return {
    code, display, keyCode: macKeyCode,
    flagMask: 0, isModifier: false, requiredModifiers: reqMods,
  };
}

function openShortcutRecorder(mode: 'ptt' | 'handsfree'): void {
  editingShortcut = mode;
  recordedKeyDisplay = '';
  recordedKeyCode = '';
  shortcutModalTitle.textContent = mode === 'ptt' ? 'Push to talk shortcut' : 'Hands-free shortcut';
  shortcutRecordPrompt.textContent = 'Press a key or combination…';
  shortcutRecordArea.classList.remove('recorded');
  shortcutRecordArea.classList.add('recording');
  btnSaveShortcut.setAttribute('disabled', '');
  shortcutModal.classList.remove('hidden');
}

function handleKeyRecord(e: KeyboardEvent): void {
  if (!shortcutModal.classList.contains('hidden') && editingShortcut) {
    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      shortcutModal.classList.add('hidden');
      editingShortcut = null;
      return;
    }

    const label = keyEventToLabel(e);
    if (label === 'Press a key…') return;

    recordedKeyDisplay = label;
    recordedKeyCode = e.code;
    recordedModifiers = {
      meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey,
    };

    shortcutRecordPrompt.textContent = label;
    shortcutRecordArea.classList.remove('recording');
    shortcutRecordArea.classList.add('recorded');
    btnSaveShortcut.removeAttribute('disabled');
  }
}

document.addEventListener('keydown', handleKeyRecord);

document.getElementById('btn-edit-ptt')?.addEventListener('click', () => openShortcutRecorder('ptt'));
document.getElementById('btn-edit-handsfree')?.addEventListener('click', () => openShortcutRecorder('handsfree'));

btnCancelShortcut.addEventListener('click', () => {
  shortcutModal.classList.add('hidden');
  editingShortcut = null;
});

shortcutModal.querySelector('.modal-backdrop')!.addEventListener('click', () => {
  shortcutModal.classList.add('hidden');
  editingShortcut = null;
});

btnSaveShortcut.addEventListener('click', async () => {
  if (!editingShortcut || !recordedKeyCode) return;

  const config = buildShortcutConfig(recordedKeyCode, recordedModifiers, recordedKeyDisplay);
  if (!config) {
    shortcutRecordPrompt.textContent = 'Unsupported key — try another';
    shortcutRecordArea.classList.remove('recorded');
    shortcutRecordArea.classList.add('recording');
    btnSaveShortcut.setAttribute('disabled', '');
    return;
  }

  await window.hub.config.setShortcut(config);

  document.getElementById('ptt-key-display')!.textContent = recordedKeyDisplay;
  document.getElementById('handsfree-key-display')!.textContent = recordedKeyDisplay;

  shortcutModal.classList.add('hidden');
  editingShortcut = null;
});

document.getElementById('btn-reset-shortcuts')?.addEventListener('click', async () => {
  await window.hub.config.setShortcut(DEFAULT_SHORTCUT);
  document.getElementById('ptt-key-display')!.textContent = DEFAULT_KEY;
  document.getElementById('handsfree-key-display')!.textContent = DEFAULT_KEY;
});

// --- Pill Position ---
document.getElementById('pill-position-grid')?.addEventListener('click', async (e) => {
  const btn = (e.target as HTMLElement).closest('.pill-pos') as HTMLElement;
  if (!btn || !btn.dataset.pos) return;

  const grid = document.getElementById('pill-position-grid')!;
  grid.querySelectorAll('.pill-pos').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  await window.hub.config.setPillPosition(btn.dataset.pos);
});

// --- Utilities ---
function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- Init ---
loadSettings();
loadDictionary();
