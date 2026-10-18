import './hub.css';

interface DictionaryEntry {
  from: string;
  to: string;
  count: number;
  lastUsed: string;
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
    hasAccessibility: () => Promise<boolean>;
    getLanguage: () => Promise<string>;
    setLanguage: (lang: string) => Promise<boolean>;
    sttStatus: () => Promise<{ installed: boolean; running: boolean; engine: string; model: string }>;
    getLlmEnabled: () => Promise<boolean>;
    setLlmEnabled: (enabled: boolean) => Promise<boolean>;
  };
  history: {
    list: () => Promise<{ text: string; app: string; time: string }[]>;
  };
  onDictationLog: (callback: (entry: { text: string; app: string; time: string }) => void) => () => void;
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
const apikeyModal = document.getElementById('apikey-modal')!;
const btnCancelKey = document.getElementById('btn-cancel-key')!;
const btnSaveKey = document.getElementById('btn-save-key')!;
const apiKeyInput = document.getElementById('api-key-input') as HTMLInputElement;
const openrouterLink = document.getElementById('openrouter-link')!;

const languageSelect = document.getElementById('language-select') as HTMLSelectElement;
const llmToggle = document.getElementById('llm-toggle') as HTMLInputElement;

async function loadSettings(): Promise<void> {
  const hasKey = await window.hub.config.hasApiKey();
  apiKeyStatus.textContent = hasKey ? 'Configured ✓' : 'Not set';
  apiKeyStatus.style.color = hasKey ? '#059669' : '#dc2626';

  const hasAccess = await window.hub.config.hasAccessibility();
  accessibilityStatus.textContent = hasAccess ? 'Granted ✓' : 'Not granted — check System Settings → Privacy → Accessibility';
  accessibilityStatus.style.color = hasAccess ? '#059669' : '#dc2626';

  const lang = await window.hub.config.getLanguage();
  languageSelect.value = lang;

  const llmOn = await window.hub.config.getLlmEnabled();
  llmToggle.checked = llmOn;

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
});

btnChangeKey.addEventListener('click', () => {
  apiKeyInput.value = '';
  apikeyModal.classList.remove('hidden');
  apiKeyInput.focus();
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
const historyContainer = document.getElementById('dictation-history')!;
const dictationLog: { text: string; app: string; time: string }[] = [];

async function loadHistory(): Promise<void> {
  const entries = await window.hub.history.list();
  renderHistory(entries);
}

function renderHistory(entries: { text: string; app: string; time: string }[]): void {
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
      ${entry.app ? `<div class="history-app">${escapeHtml(entry.app)}</div>` : ''}
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

const DEFAULT_KEY = 'Right ⌥ Option';

function loadShortcuts(): void {
  const pttDot = document.getElementById('ptt-status-dot')!;
  const pttText = document.getElementById('ptt-status-text')!;
  const hfDot = document.getElementById('handsfree-status-dot')!;
  const hfText = document.getElementById('handsfree-status-text')!;

  pttDot.classList.remove('inactive');
  pttText.textContent = 'Active';
  hfDot.classList.remove('inactive');
  hfText.textContent = 'Active';
}

function keyEventToLabel(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.metaKey) parts.push('⌘');
  if (e.ctrlKey) parts.push('⌃');
  if (e.altKey) parts.push('⌥');
  if (e.shiftKey) parts.push('⇧');

  const key = e.key;
  if (!['Meta', 'Control', 'Alt', 'Shift'].includes(key)) {
    if (key === ' ') parts.push('Space');
    else if (key === 'ArrowUp') parts.push('↑');
    else if (key === 'ArrowDown') parts.push('↓');
    else if (key === 'ArrowLeft') parts.push('←');
    else if (key === 'ArrowRight') parts.push('→');
    else if (key === 'Enter') parts.push('Return');
    else if (key === 'Backspace') parts.push('⌫');
    else if (key === 'Escape') parts.push('Esc');
    else if (key === 'Tab') parts.push('⇥');
    else parts.push(key.length === 1 ? key.toUpperCase() : key);
  }

  return parts.join(' + ') || 'Press a key…';
}

function openShortcutRecorder(mode: 'ptt' | 'handsfree'): void {
  editingShortcut = mode;
  recordedKeyDisplay = '';
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

btnSaveShortcut.addEventListener('click', () => {
  if (!editingShortcut || !recordedKeyDisplay) return;

  const displayEl = document.getElementById(
    editingShortcut === 'ptt' ? 'ptt-key-display' : 'handsfree-key-display'
  )!;
  displayEl.textContent = recordedKeyDisplay;

  shortcutModal.classList.add('hidden');
  editingShortcut = null;
});

document.getElementById('btn-reset-shortcuts')?.addEventListener('click', () => {
  document.getElementById('ptt-key-display')!.textContent = DEFAULT_KEY;
  document.getElementById('handsfree-key-display')!.textContent = DEFAULT_KEY;
  loadShortcuts();
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
