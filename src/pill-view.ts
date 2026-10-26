import { Bands, Orb, OrbMood } from './orb';

// What the pill shows: the orb, with the voice wave inside it, and a caption
// with the live transcript or a short status. renderer.ts drives it from
// main.ts's states; it has no Electron of its own, so it also runs in a
// preview page.

interface Look {
  cls: 'recording' | 'thinking' | 'done' | 'alert' | 'notice';
  mood: OrbMood;
  label: (detail: string) => string;
}

const LOOKS: Record<string, Look> = {
  recording: { cls: 'recording', mood: 'listening', label: () => '' },
  processing: { cls: 'thinking', mood: 'thinking', label: () => 'Transcribing' },
  formatting: { cls: 'thinking', mood: 'thinking', label: () => 'Formatting' },
  downloading: { cls: 'thinking', mood: 'thinking', label: () => 'Downloading model' },
  preparing: { cls: 'thinking', mood: 'thinking', label: (d) => (d ? `Getting ready · ${d}%` : 'Getting ready…') },
  restarting: { cls: 'thinking', mood: 'thinking', label: () => 'Switching language…' },
  injecting: { cls: 'done', mood: 'done', label: () => 'Done' },
  undo: { cls: 'notice', mood: 'calm', label: () => 'Undone ↩' },
  copied: { cls: 'notice', mood: 'calm', label: () => 'Copied' },
  'nothing-yet': { cls: 'notice', mood: 'calm', label: () => 'Nothing dictated yet' },
  'no-field': {
    cls: 'notice',
    mood: 'calm',
    label: (d) => (d ? `No text field. Press ${d} to paste it.` : 'No text field. Saved in History.'),
  },
  empty: { cls: 'alert', mood: 'alert', label: () => 'No speech detected' },
  error: { cls: 'alert', mood: 'alert', label: () => 'Something went wrong' },
  'mic-blocked': { cls: 'alert', mood: 'alert', label: () => 'Microphone blocked' },
  'stt-unavailable': { cls: 'alert', mood: 'alert', label: () => "Speech engine didn't start" },
};

export class PillView {
  private readonly pill = document.getElementById('pill')!;
  private readonly clip = document.getElementById('caption-clip')!;
  private readonly text = document.getElementById('caption-text')!;
  private readonly orb = new Orb(document.getElementById('orb') as HTMLCanvasElement);
  private state = 'idle';
  // The live transcript of the current dictation; it stays, shimmering,
  // while the dictation is transcribed and formatted.
  private transcript = '';
  private handsfree = false;
  private levelSource: (() => number) | null = null;
  private bandsSource: (() => Bands) | null = null;
  private frameId: number | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Slower for people who asked for less motion.
    this.orb.slow = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  // 'preparing:42' carries a download percent, 'no-field:⌃⌘V' the paste
  // shortcut. Returns the state without its detail.
  setState(fullState: string): string {
    const separator = fullState.indexOf(':');
    const state = separator < 0 ? fullState : fullState.slice(0, separator);
    const detail = separator < 0 ? '' : fullState.slice(separator + 1);
    const look = this.shows(state) ? LOOKS[state] : undefined;
    if (state === 'recording' && this.state !== 'recording') this.transcript = '';
    if (!look || (look.cls !== 'recording' && look.cls !== 'thinking')) this.transcript = '';
    this.state = state;

    if (!look) {
      this.pill.className = 'pill idle';
      // Stop drawing once the fade-out has finished.
      if (this.hideTimer) clearTimeout(this.hideTimer);
      this.hideTimer = setTimeout(() => this.stop(), 400);
      return state;
    }
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    this.pill.className = `pill ${look.cls}`;
    this.pill.classList.toggle('handsfree', this.handsfree && state === 'recording');
    this.orb.setMood(look.mood);
    if (look.mood !== 'listening') this.orb.setLevel(0);
    this.showCaption(this.transcript || look.label(detail), !!this.transcript);
    this.start();
    return state;
  }

  // Whether the pill has a look for this state; anything else hides it.
  shows(state: string): boolean {
    return Object.hasOwn(LOOKS, state);
  }

  setPreview(text: string): void {
    if (this.state !== 'recording' || !text) return;
    this.transcript = text;
    this.showCaption(text, true);
  }

  setHandsfree(active: boolean): void {
    this.handsfree = active;
    this.pill.classList.toggle('handsfree', active && this.state === 'recording');
  }

  // The microphone level (0 to 1) and, if known, its low, middle and high
  // bands while recording; null when not capturing.
  setLevelSource(source: (() => number) | null, bands: (() => Bands) | null = null): void {
    this.levelSource = source;
    this.bandsSource = source ? bands : null;
    if (!source) {
      this.orb.setLevel(0);
      this.orb.setBands(null);
    }
  }

  setPosition(position: string): void {
    document.body.dataset.position = position;
  }

  private showCaption(value: string, isTranscript: boolean): void {
    this.text.textContent = value;
    this.pill.classList.toggle('has-caption', value !== '');
    this.pill.classList.toggle('has-transcript', isTranscript && value !== '');
    // Long dictations show their newest words after an ellipsis: the fewest
    // words dropped from the start that make the rest fit.
    const fits = () => this.clip.scrollWidth <= this.clip.clientWidth;
    if (fits()) return;
    const words = value.split(' ');
    let lo = 1;
    let hi = words.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      this.text.textContent = `… ${words.slice(mid).join(' ')}`;
      if (fits()) hi = mid;
      else lo = mid + 1;
    }
    this.text.textContent = `… ${words.slice(lo).join(' ')}`;
  }

  private start(): void {
    if (this.frameId === null) this.frameId = requestAnimationFrame(this.tick);
  }

  private stop(): void {
    if (this.frameId !== null) cancelAnimationFrame(this.frameId);
    this.frameId = null;
  }

  private readonly tick = (now: number): void => {
    if (this.levelSource) this.orb.setLevel(this.levelSource());
    if (this.bandsSource) this.orb.setBands(this.bandsSource());
    this.orb.frame(now);
    this.frameId = requestAnimationFrame(this.tick);
  };
}
