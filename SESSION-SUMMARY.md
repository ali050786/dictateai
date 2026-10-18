# DictateAI — Session Summary (2026-10-18)

All changes below are uncommitted, built on top of commit `fd9c565`.

---

## Features Implemented

### 1. Cursor-Following Overlay (attempted → replaced)
- **Goal**: Position the dictation pill near the text cursor, like Wispr Flow.
- **Approach**: Added `GetTextCursorPosition` to the native Obj-C++ addon (`TextInjectionAddon.mm`) using `kAXBoundsForRangeParameterizedAttribute` to query screen coordinates of the focused text field's insertion point.
- **Outcome**: Worked in some native apps but failed reliably across browsers and Electron apps (`kAXErrorCannotComplete` / degenerate rects). The overlay window itself disrupted the AX focus chain. **Replaced by the configurable position picker** (feature #3).
- **Files**: `native/text-injection/TextInjectionAddon.mm`, `src/text-injection.ts` (native code still present but unused)

### 2. Race Condition Fix — Pill Disappearing on Consecutive Dictations
- **Problem**: Pressing the PTT key rapidly (start → stop → start) caused the pill to vanish mid-recording. The previous dictation's `setTimeout` for hiding the overlay fired during the new recording.
- **Fix**: Track timer references (`hideTimer`, `hideTransitionTimer`) and call `cancelPendingHide()` at the start of every new recording to clear stale timers.
- **Files**: `src/main.ts`

### 3. User-Configurable Pill Position (9 positions)
- **What**: A 3×3 grid picker in Settings → General lets the user place the pill at any of 9 screen positions: top-left, top-center, top-right, center-left, center, center-right, bottom-left, bottom-center (default), bottom-right.
- **Vertical orientation**: Side positions (center-left, center-right) display the pill vertically — `flex-direction: column`, `writing-mode: vertical-rl`, separate animation keyframes for vertical waveform bars.
- **Persistence**: Position saved to `~/.dictateai/config.json` and restored on startup.
- **Files**: `src/main.ts` (applyOverlayPosition, isVerticalPosition), `src/hub.html` (grid UI), `src/hub.css` (grid styles), `src/hub-renderer.ts` (load/save), `src/hub-preload.ts` (IPC), `src/preload.ts` (orientation listener), `src/renderer.ts` (vertical body class), `src/index.css` (vertical pill styles), `src/llm-formatter.ts` (PillPosition type)

### 4. Sleeker / Smaller Pill Design
- **What**: Reduced pill dimensions by ~40%.
  - Recording: 140×36px (was 200×48px)
  - Processing: 120×34px (was 160×44px)
  - Waveform bars: 2.5px width, 2px gap (was wider)
  - Font: 11px label, 10px preview (was larger)
  - Close button: 16×16px (was larger)
- **Files**: `src/index.css`

### 5. Short Recording Fix — "No Speech Detected" on 1–2 Word Utterances
- **Problem**: WhisperKit returned empty transcripts for recordings under ~1.5 seconds.
- **Fix**: Pad short audio with silence to reach 1.5s minimum. Also lowered the minimum duration threshold from 0.3s to 0.2s.
  ```typescript
  const padded = new Float32Array(Math.ceil(1.5 * 16000));
  padded.set(combined, 0); // original audio at start, rest is silence
  ```
- **Files**: `src/main.ts` (processAudio)

### 6. Mute Audio While Speaking
- **What**: Automatically mutes system audio when dictation starts, unmutes when it stops. Controlled by a toggle in Settings → General.
- **Smart restore**: Checks if audio was already muted before dictating — won't unmute something the user intentionally muted.
- **Implementation**: Uses `osascript` (AppleScript) via async `exec` (not `execSync`, which blocks Electron's main thread and freezes the app).
  ```
  osascript -e "output muted of (get volume settings)"  // check
  osascript -e "set volume with output muted"            // mute
  osascript -e "set volume without output muted"         // unmute
  ```
- **Files**: `src/main.ts` (muteSystemAudio, unmuteSystemAudio, IPC handlers), `src/hub.html` (toggle UI), `src/hub-renderer.ts` (toggle wiring), `src/hub-preload.ts` (IPC bridge), `src/llm-formatter.ts` (muteWhileSpeaking config field)

---

## Files Changed (11 files, +553 / -50 lines)

| File | Changes |
|---|---|
| `native/text-injection/TextInjectionAddon.mm` | Added `GetTextCursorPosition` N-API function (unused but present) |
| `src/main.ts` | Position picker, race condition fix, audio padding, mute while speaking, IPC handlers |
| `src/index.css` | Sleeker pill, vertical orientation styles, animations |
| `src/hub.html` | Position grid UI, mute toggle |
| `src/hub.css` | Position grid styles |
| `src/hub-renderer.ts` | Position picker + mute toggle load/save logic |
| `src/hub-preload.ts` | IPC bridges for position + mute |
| `src/preload.ts` | Orientation IPC listener |
| `src/renderer.ts` | Vertical body class toggle |
| `src/text-injection.ts` | Exported `getTextCursorPosition` (unused) |
| `src/llm-formatter.ts` | `PillPosition` type, `muteWhileSpeaking` config field |

---

## Bugs Fixed During Development

| Bug | Cause | Fix |
|---|---|---|
| EPIPE crash on launch | Parent shell pipe broke when Electron outlived it | Redirect output to log file with `&` and `disown` |
| WhisperKit port conflict (errno 48) | Old server holding port 50060 | Kill stale processes before restart |
| Pill disappears on consecutive dictations | Stale `setTimeout` from previous recording | Track and cancel timer references |
| "No speech detected" on short recordings | WhisperKit needs ~1.5s audio context | Pad short audio with silence |
| App freezes when mute toggle enabled | `execSync` blocks Electron main thread | Switch to async `exec` |

---

## Pending / Not Yet Done

- **Local LLM inference**: Currently uses DeepSeek via OpenRouter (cloud) for text cleanup. Plan to replace with local MLX inference using a Qwen model — `mlx-lm` needs to be installed.
- **Commit**: None of these changes are committed yet.
- **Native addon in packaged app**: The `.node` binary isn't bundled into the asar — text injection works in dev mode but not in the packaged build.
- **Accessibility permission**: The packaged app (`out/DictateAI-darwin-arm64/`) needs a fresh Accessibility grant in System Settings since it's a different binary from the dev Electron.
