import './hub.css';

interface DictionaryEntry {
  from: string;
  to: string;
  count: number;
  lastUsed: string;
  manual?: boolean;
}

interface ShortcutConfig {
  code: string;
  display: string;
  keyCode: number;
  flagMask: number;
  isModifier: boolean;
  requiredModifiers: number;
}

interface ModelDownload { percent: number; size: string }

// The cleanup model a language would use, and what fetching it costs.
interface CleanupPlan {
  model: string;
  size: string;
  downloaded: boolean;
  free: string | null;
  enoughSpace: boolean;
  lowMemory: boolean;
  declined: boolean;
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
    setLanguage: (lang: string, downloadCleanup?: boolean) => Promise<boolean>;
    cleanupPlan: (lang: string) => Promise<CleanupPlan>;
    downloadCleanup: () => Promise<boolean>;
    sttStatus: () => Promise<{ installed: boolean; running: boolean; download: ModelDownload | null; engine: string; model: string }>;
    getLlmEnabled: () => Promise<boolean>;
    setLlmEnabled: (enabled: boolean) => Promise<boolean>;
    getLlmProvider: () => Promise<'local' | 'cloud'>;
    setLlmProvider: (provider: 'local' | 'cloud') => Promise<boolean>;
    llmStatus: () => Promise<{
      provider: 'local' | 'cloud';
      mlxInstalled: boolean;
      running: boolean;
      starting: boolean;
      download: ModelDownload | null;
      failed: boolean;
      model: string;
      cloudModel: string;
      plan: CleanupPlan;
    }>;
    setCloudModel: (model: string) => Promise<boolean>;
    getLocalModelChoice: () => Promise<{ choice: string; options: { id: string; label: string; detail: string }[] }>;
    setLocalModelChoice: (id: string) => Promise<boolean>;
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
    clear: () => Promise<boolean>;
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
        ${!entry.manual && entry.count < 2 ? `<span class="dict-entry-learning" title="Learned from one edit. Applies after you make the same fix again.">learning</span>` : ''}
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
const cloudModelRow = document.getElementById('cloud-model-row')!;
const btnChooseModel = document.getElementById('btn-choose-model')!;
const localModelRow = document.getElementById('local-model-row')!;
const localModelSelect = document.getElementById('local-model-select') as HTMLSelectElement;
const localModelDesc = document.getElementById('local-model-desc')!;
// The picker stays tucked away unless opened or a non-automatic model is set.
let localModelPickerOpen = false;
const cloudModelInput = document.getElementById('cloud-model-input') as HTMLInputElement;
const micSelect = document.getElementById('mic-select') as HTMLSelectElement;
const micStatus = document.getElementById('mic-status')!;

// loadSettings runs again on every status change, so listeners are attached
// once here, never inside it.
const muteToggle = document.getElementById('mute-toggle') as HTMLInputElement;
muteToggle.addEventListener('change', () => {
  window.hub.config.setMuteWhileSpeaking(muteToggle.checked);
});

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

  showPillPosition(await window.hub.config.getPillPosition());

  loadMicDevices();

  muteToggle.checked = await window.hub.config.getMuteWhileSpeaking();

  const llmOn = await window.hub.config.getLlmEnabled();
  llmToggle.checked = llmOn;
  showHeroCleanup(llmOn);
  await loadLlmStatus();

  await loadSttStatus();
}

async function loadSttStatus(): Promise<void> {
  const stt = await window.hub.config.sttStatus();
  const sttStatus = document.getElementById('stt-status')!;
  const sttBadge = document.getElementById('stt-badge')!;
  if (!stt.installed) {
    sttStatus.textContent = 'Speech engine missing — reinstall DictateAI';
    sttStatus.style.color = '#dc2626';
    sttBadge.textContent = 'Missing';
    sttBadge.className = 'badge badge-red';
  } else if (stt.download) {
    sttStatus.textContent = `Downloading the speech model, one time only — ${stt.download.percent}% of ${stt.download.size}`;
    sttStatus.style.color = '';
    sttBadge.textContent = 'Downloading';
    sttBadge.className = 'badge badge-blue';
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

// Spoken name for the confirm line: "Hindi (हिन्दी)" → "Hindi".
function languageName(lang: string): string {
  if (lang === 'auto') return 'Other languages';
  const option = [...languageSelect.options].find(o => o.value === lang);
  return option?.textContent?.replace(/\s*\(.*\)$/, '') || lang;
}

languageSelect.addEventListener('change', async () => {
  const lang = languageSelect.value;
  // A language that needs a cleanup model not on this Mac asks first, with
  // the size, instead of starting a multi-GB download silently.
  const [plan, llm] = await Promise.all([window.hub.config.cleanupPlan(lang), window.hub.config.llmStatus()]);
  const askFirst = llmToggle.checked && llm.provider === 'local' && !plan.downloaded;
  await window.hub.config.setLanguage(lang, !askFirst);
  showLanguageConfirm(askFirst ? { lang, plan } : null);
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
  loadSttStatus();
});

const langConfirm = document.getElementById('lang-confirm')!;
const langConfirmText = document.getElementById('lang-confirm-text')!;
const btnLangDownload = document.getElementById('btn-lang-download') as HTMLButtonElement;

function showLanguageConfirm(pending: { lang: string; plan: CleanupPlan } | null): void {
  langConfirm.hidden = !pending;
  if (!pending) return;
  const { lang, plan } = pending;
  const name = languageName(lang);
  const need = lang === 'en'
    ? `English uses a smaller cleanup model (${plan.size}, once).`
    : `${name} ${lang === 'auto' ? 'need' : 'needs'} the larger cleanup model (${plan.size}, once).`;
  btnLangDownload.disabled = !plan.enoughSpace;
  langConfirmText.textContent = plan.enoughSpace
    ? `${need} Download now?`
    : `${need} You have ${plan.free} free; it needs ${plan.size} plus room to spare.`;
}

btnLangDownload.addEventListener('click', async () => {
  showLanguageConfirm(null);
  await window.hub.config.downloadCleanup();
  loadLlmStatus();
});

// Not now: speech already switched; cleanup waits and dictation is plain text.
document.getElementById('btn-lang-not-now')!.addEventListener('click', () => {
  showLanguageConfirm(null);
  loadLlmStatus();
});

llmToggle.addEventListener('change', async () => {
  await window.hub.config.setLlmEnabled(llmToggle.checked);
  showHeroCleanup(llmToggle.checked);
  if (llmToggle.checked) showLanguageConfirm(null);
  loadLlmStatus();
});

// --- AI Text Cleanup description: size before, progress during, retry after ---
const llmDesc = document.getElementById('llm-desc')!;
const llmProgress = document.getElementById('llm-progress')!;
const llmProgressFill = document.getElementById('llm-progress-fill')!;
const btnLlmAction = document.getElementById('btn-llm-action') as HTMLButtonElement;
let llmAction: (() => Promise<unknown>) | null = null;

function showLlmDesc(
  text: string,
  options: { percent?: number; action?: { label: string; run: () => Promise<unknown> } } = {},
): void {
  llmDesc.textContent = text;
  llmProgress.hidden = options.percent === undefined;
  if (options.percent !== undefined) {
    llmProgressFill.style.width = `${options.percent}%`;
    llmProgress.setAttribute('aria-valuenow', String(options.percent));
  }
  btnLlmAction.hidden = !options.action;
  btnLlmAction.textContent = options.action?.label ?? '';
  llmAction = options.action?.run ?? null;
}

btnLlmAction.addEventListener('click', async () => {
  await llmAction?.();
  loadLlmStatus();
});

type LlmStatus = Awaited<ReturnType<HubAPI['config']['llmStatus']>>;

function renderCleanupDesc(status: LlmStatus): void {
  const { plan } = status;
  const what = 'Removes ums, fixes punctuation.';
  const downloadNow = { label: 'Download', run: () => window.hub.config.downloadCleanup() };
  if (!llmToggle.checked) {
    if (status.provider === 'cloud') showLlmDesc(`${what} Uses your OpenRouter key.`);
    else if (plan.downloaded) showLlmDesc(`${what} Runs on your Mac.`);
    else showLlmDesc(`${what} Downloads ${plan.size} once.`);
    return;
  }
  if (status.provider === 'cloud') {
    showLlmDesc('In the cloud · your OpenRouter key');
  } else if (status.running) {
    showLlmDesc('On your Mac · private and unlimited');
  } else if (status.download) {
    // Cancel keeps the partial files, so turning it on again resumes.
    showLlmDesc(`Downloading — ${status.download.percent}% of ${plan.size}`, {
      percent: status.download.percent,
      action: {
        label: 'Cancel',
        run: async () => {
          llmToggle.checked = false;
          showHeroCleanup(false);
          await window.hub.config.setLlmEnabled(false);
        },
      },
    });
  } else if (status.starting) {
    showLlmDesc(plan.downloaded ? 'Getting ready…' : `Starting the download (${plan.size})…`);
  } else if (status.failed) {
    showLlmDesc('Download stopped. Check your connection.', { action: { label: 'Try again', run: () => window.hub.config.downloadCleanup() } });
  } else if (plan.declined) {
    showLlmDesc(`Needs the ${plan.size} cleanup model. Until then, dictation is plain text.`, { action: downloadNow });
  } else {
    showLlmDesc(`${what} Stopped.`);
  }
}

async function loadLlmStatus(): Promise<void> {
  const status = await window.hub.config.llmStatus();
  renderCleanupDesc(status);
  const isCloud = status.provider === 'cloud';
  llmProviderSelect.value = status.provider;
  apiKeyRow.style.display = isCloud ? '' : 'none';
  cloudModelRow.style.display = isCloud ? '' : 'none';
  await loadLocalModelChoice(isCloud);
  llmProviderDesc.style.color = '';

  if (isCloud) {
    llmProviderDesc.textContent = 'Your OpenRouter key, your credits.';
    llmModelName.textContent = status.cloudModel;
    if (document.activeElement !== cloudModelInput) cloudModelInput.value = status.cloudModel;
  } else if (!status.mlxInstalled) {
    llmProviderDesc.textContent = 'Cleanup engine missing — reinstall DictateAI';
    llmProviderDesc.style.color = '#dc2626';
    llmModelName.textContent = '';
  } else {
    // Download progress shows under the AI Text Cleanup toggle.
    const state = status.running
      ? 'ready'
      : status.starting
        ? 'getting ready…'
        : llmToggle.checked ? 'stopped' : 'off until AI Text Cleanup is on';
    llmProviderDesc.textContent = `Private, unlimited — ${state}`;
    llmProviderDesc.style.color = status.running ? '#059669' : '';
    llmModelName.textContent = status.model;
  }
}

llmProviderSelect.addEventListener('change', async () => {
  if (llmProviderSelect.value === 'local') {
    await window.hub.config.setLlmProvider('local');
  } else {
    await window.hub.config.setLlmProvider('cloud');
    // Cloud only ever uses the user's own key; ask for it right away.
    if (!(await window.hub.config.hasApiKey())) openKeyModal();
  }
  loadLlmStatus();
});

async function loadLocalModelChoice(isCloud: boolean): Promise<void> {
  const { choice, options } = await window.hub.config.getLocalModelChoice();
  if (choice !== 'auto') localModelPickerOpen = true;

  localModelSelect.innerHTML = '';
  for (const option of options) {
    const el = document.createElement('option');
    el.value = option.id;
    el.textContent = option.label;
    localModelSelect.appendChild(el);
  }
  localModelSelect.value = choice;
  localModelDesc.textContent = options.find(o => o.id === choice)?.detail ?? '';

  btnChooseModel.style.display = !isCloud && !localModelPickerOpen ? '' : 'none';
  localModelRow.style.display = !isCloud && localModelPickerOpen ? '' : 'none';
}

btnChooseModel.addEventListener('click', () => {
  localModelPickerOpen = true;
  loadLlmStatus();
});

localModelSelect.addEventListener('change', async () => {
  await window.hub.config.setLocalModelChoice(localModelSelect.value);
  loadLlmStatus();
});

cloudModelInput.addEventListener('change', async () => {
  await window.hub.config.setCloudModel(cloudModelInput.value);
  loadLlmStatus();
});

cloudModelInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') cloudModelInput.blur();
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

// --- Dictation hero: mentions AI only when cleanup is on ---
function showHeroCleanup(on: boolean): void {
  document.getElementById('hero-cleanup-on')!.hidden = !on;
  document.getElementById('btn-hero-cleanup')!.hidden = on;
}

document.getElementById('btn-hero-cleanup')!.addEventListener('click', () => {
  document.querySelector<HTMLButtonElement>('.nav-item[data-page="settings"]')!.click();
  llmToggle.closest('.setting-row')!.scrollIntoView({ block: 'center' });
  llmToggle.focus();
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

document.getElementById('btn-clear-history')!.addEventListener('click', async () => {
  if (!confirm('Clear your dictation history from this Mac?')) return;
  await window.hub.history.clear();
  dictationLog.length = 0;
  renderHistory([]);
});

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
  showShortcut(saved?.display || DEFAULT_KEY);
}

// The shortcut appears on the Shortcuts page and in the Dictation hero.
function showShortcut(display: string): void {
  document.getElementById('ptt-key-display')!.textContent = display;
  document.getElementById('handsfree-key-display')!.textContent = display;
  document.getElementById('hero-key')!.textContent = display;
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

  showShortcut(recordedKeyDisplay);

  shortcutModal.classList.add('hidden');
  editingShortcut = null;
});

document.getElementById('btn-reset-shortcuts')?.addEventListener('click', async () => {
  await window.hub.config.setShortcut(DEFAULT_SHORTCUT);
  showShortcut(DEFAULT_KEY);
});

// --- Pill Position ---
function showPillPosition(pos: string): void {
  const grid = document.getElementById('pill-position-grid')!;
  let label = '';
  grid.querySelectorAll<HTMLElement>('.pill-pos').forEach(btn => {
    const active = btn.dataset.pos === pos;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-checked', String(active));
    if (active) label = btn.getAttribute('aria-label') || '';
  });
  document.getElementById('pill-position-desc')!.textContent = label
    ? `${label} of your screen`
    : 'Where the recording pill appears on your screen';
}

document.getElementById('pill-position-grid')?.addEventListener('click', async (e) => {
  const btn = (e.target as HTMLElement).closest('.pill-pos') as HTMLElement;
  if (!btn || !btn.dataset.pos) return;

  showPillPosition(btn.dataset.pos);
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
loadHistory();
loadShortcuts();
