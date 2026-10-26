import './welcome.css';

// The first-run window: permissions, the speech model, then the AI cleanup
// offer. Closing it at any step is fine; the app works from the menu bar.

interface ModelDownload { percent: number; size: string }

interface WelcomeStatus {
  accessibility: boolean;
  microphone: string;
  speech: { installed: boolean; running: boolean; failed: boolean; download: ModelDownload | null; size: string };
  shortcut: string;
  language: string | null;
  locale: string;
  llmEnabled: boolean;
}

interface CleanupPlan {
  model: string;
  size: string;
  downloaded: boolean;
  free: string | null;
  enoughSpace: boolean;
  lowMemory: boolean;
}

interface WelcomeAPI {
  status: () => Promise<WelcomeStatus>;
  openAccessibility: () => Promise<boolean>;
  allowMicrophone: () => Promise<boolean>;
  retrySpeech: () => Promise<boolean>;
  cleanupPlan: (lang: string) => Promise<CleanupPlan>;
  finish: (lang: string, enableCleanup: boolean) => Promise<boolean>;
  close: () => Promise<boolean>;
  onDictationLog: (callback: (entry: { text: string }) => void) => () => void;
  onStatusChanged: (callback: () => void) => () => void;
}

declare global {
  interface Window {
    welcome: WelcomeAPI;
  }
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const steps = ['step-permissions', 'step-ready', 'step-cleanup'].map((id) => $(id));
const dots = document.querySelectorAll<HTMLElement>('.dot');
const btnNext = $<HTMLButtonElement>('btn-next');
const btnBack = $<HTMLButtonElement>('btn-back');
const btnSkip = $<HTMLButtonElement>('btn-skip');
const btnNotNow = $<HTMLButtonElement>('btn-not-now');
const langSelect = $<HTMLSelectElement>('lang-select');
const tryInput = $<HTMLTextAreaElement>('try-input');

let step = 0;
let status: WelcomeStatus | null = null;
let plan: CleanupPlan | null = null;

function showStep(next: number): void {
  step = next;
  steps.forEach((el, i) => el.classList.toggle('active', i === step));
  dots.forEach((el, i) => el.classList.toggle('active', i === step));
  btnSkip.hidden = step !== 0;
  btnBack.hidden = step === 0;
  btnNotNow.hidden = step !== 2;
  if (step === 2) loadPlan();
  render();
  // Keyboard users land on the step's first control.
  const first = steps[step].querySelector<HTMLElement>('button:not([hidden]), select, textarea:not([hidden])');
  if (step === 1 && !$('try-it').hidden) tryInput.focus();
  else if (first && step !== 1) first.focus();
  else btnNext.focus();
}

// --- Step 1: permissions ---
function renderPermissions(s: WelcomeStatus): boolean {
  const micOk = s.microphone === 'granted';
  $('btn-accessibility').hidden = s.accessibility;
  $('perm-accessibility').querySelector<HTMLElement>('.perm-ok')!.hidden = !s.accessibility;
  $('btn-microphone').hidden = micOk;
  $('btn-microphone').textContent = s.microphone === 'denied' ? 'Open Settings' : 'Allow';
  $('perm-microphone').querySelector<HTMLElement>('.perm-ok')!.hidden = !micOk;
  return s.accessibility && micOk;
}

$('btn-accessibility').addEventListener('click', () => window.welcome.openAccessibility());
$('btn-microphone').addEventListener('click', async () => {
  await window.welcome.allowMicrophone();
  refresh();
});

// --- Step 2: speech model ---
// Recent (time, percent) samples, to estimate time left from real throughput.
const samples: { t: number; p: number }[] = [];
let lastAnnounced = -1;

function timeLeft(percent: number): string {
  const now = Date.now();
  samples.push({ t: now, p: percent });
  while (samples.length > 2 && now - samples[0].t > 20_000) samples.shift();
  const first = samples[0];
  const seconds = (now - first.t) / 1000;
  const gained = percent - first.p;
  if (seconds < 5 || gained <= 0) return '';
  const left = ((100 - percent) / gained) * seconds;
  if (left < 45) return ' · less than a minute left';
  if (left < 90) return ' · about a minute left';
  return ` · about ${Math.round(left / 60)} minutes left`;
}

function renderSpeech(s: WelcomeStatus): void {
  const { speech } = s;
  const ready = speech.running;
  const failed = !ready && (speech.failed || !speech.installed);
  const bar = $('speech-bar');
  const text = $('speech-text');

  $('ready-title').textContent = ready ? "You're ready" : 'Getting ready to listen';
  $('speech-size').textContent = `${speech.size}, once. After this, dictation works offline.`;
  $('speech-progress').hidden = ready || failed;
  $('speech-error').hidden = !failed;
  if (!speech.installed) {
    $('speech-error').querySelector('p')!.textContent = 'The speech engine is missing. Reinstall Utter.';
    $('btn-retry-speech').hidden = true;
  }

  const tryIt = $('try-it');
  const wasHidden = tryIt.hidden;
  tryIt.hidden = !ready;
  tryInput.placeholder = `Hold ${s.shortcut} and say something.`;
  if (ready && wasHidden && step === 1) tryInput.focus();

  if (ready || failed) {
    if (ready) announce("You're ready.");
    return;
  }

  if (speech.download) {
    const p = speech.download.percent;
    bar.classList.remove('indeterminate');
    bar.setAttribute('aria-valuenow', String(p));
    $('speech-fill').style.width = `${p}%`;
    text.textContent = `Downloading the speech model — ${p}%${timeLeft(p)}`;
    if (Math.floor(p / 10) > lastAnnounced) {
      lastAnnounced = Math.floor(p / 10);
      announce(`${p}%`);
    }
  } else {
    // Before the download shows up on disk, or while the model loads.
    bar.classList.add('indeterminate');
    bar.removeAttribute('aria-valuenow');
    text.textContent = 'Getting ready…';
  }
}

function announce(message: string): void {
  const live = $('speech-live');
  if (live.textContent !== message) live.textContent = message;
}

$('btn-retry-speech').addEventListener('click', async () => {
  samples.length = 0;
  await window.welcome.retrySpeech();
  refresh();
});

function showTrySuccess(): void {
  if (tryInput.value.trim()) $('try-success').hidden = false;
}
tryInput.addEventListener('input', showTrySuccess);

// Text normally arrives by injection into the focused box. If it didn't land
// (the box lost focus), put it there so the first try still counts.
window.welcome.onDictationLog((entry) => {
  setTimeout(() => {
    if (step === 1 && !$('try-it').hidden && !tryInput.value.includes(entry.text.trim())) {
      tryInput.value = (tryInput.value ? `${tryInput.value} ` : '') + entry.text;
    }
    showTrySuccess();
  }, 1500);
});

// --- Step 3: AI cleanup ---
function initialLanguage(s: WelcomeStatus): string {
  const options = [...langSelect.options].map((o) => o.value);
  if (s.language && options.includes(s.language)) return s.language;
  return options.includes(s.locale) ? s.locale : 'auto';
}

async function loadPlan(): Promise<void> {
  plan = await window.welcome.cleanupPlan(langSelect.value);
  render();
}

langSelect.addEventListener('change', loadPlan);

function renderCleanup(s: WelcomeStatus): void {
  const sizeLine = $('cleanup-size');
  sizeLine.classList.remove('error');
  $('cleanup-memory').hidden = !(plan?.lowMemory && !s.llmEnabled);
  if (s.llmEnabled) {
    sizeLine.textContent = 'AI cleanup is on. Runs on your Mac: private and unlimited.';
    return;
  }
  if (!plan) {
    sizeLine.textContent = '';
    return;
  }
  const english = langSelect.value === 'en';
  if (plan.downloaded) {
    sizeLine.textContent = 'Already downloaded. Runs on your Mac: private and unlimited.';
  } else if (!plan.enoughSpace) {
    sizeLine.textContent = `Needs ${plan.size} free; you have ${plan.free}.`;
    sizeLine.classList.add('error');
  } else if (english) {
    sizeLine.textContent = `Downloads ${plan.size} once, in the background. Runs on your Mac: private and unlimited.`;
  } else {
    sizeLine.textContent = `Downloads ${plan.size} once, in the background. Other languages need a larger model to stay in their own script.`;
  }
}

// --- Footer ---
function render(): void {
  if (!status) return;
  const permissionsDone = renderPermissions(status);
  renderSpeech(status);
  renderCleanup(status);

  if (step === 0) {
    btnNext.textContent = 'Continue';
    btnNext.disabled = !permissionsDone;
  } else if (step === 1) {
    // Never wait on the download: it keeps going in the background.
    btnNext.textContent = 'Continue';
    btnNext.disabled = false;
  } else {
    btnNext.textContent = status.llmEnabled ? 'Done' : 'Turn on AI cleanup';
    btnNext.disabled = !status.llmEnabled && !!plan && !plan.downloaded && !plan.enoughSpace;
  }
}

btnNext.addEventListener('click', () => {
  if (btnNext.disabled) return;
  if (step < 2) showStep(step + 1);
  else window.welcome.finish(langSelect.value, !status?.llmEnabled);
});
btnBack.addEventListener('click', () => showStep(Math.max(0, step - 1)));
btnSkip.addEventListener('click', () => showStep(1));
btnNotNow.addEventListener('click', () => window.welcome.finish(langSelect.value, false));

// Return is the default button, except while typing in the Try-it box. It
// doesn't start the cleanup download: the window opens in front on launch,
// so stray keystrokes meant for another app could otherwise commit to GBs.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.repeat || e.target === tryInput) return;
  if (step === 2 && e.target !== btnNext) return;
  if (e.target instanceof HTMLButtonElement && e.target !== btnNext) return;
  e.preventDefault();
  btnNext.click();
});

async function refresh(): Promise<void> {
  status = await window.welcome.status();
  render();
}

window.welcome.onStatusChanged(refresh);

async function init(): Promise<void> {
  status = await window.welcome.status();
  langSelect.value = initialLanguage(status);
  // Reopened after setup: start where there's something left to do.
  const permissionsDone = renderPermissions(status);
  showStep(permissionsDone ? (status.speech.running ? 2 : 1) : 0);
  // Permissions change in System Settings and the download has no events, so
  // check once a second while the window is open.
  setInterval(refresh, 1000);
}

init();
