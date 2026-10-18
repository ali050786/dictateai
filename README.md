# DictateAI

Voice dictation for macOS that runs on your Mac. Hold a key, speak, and the text appears in whatever field you're typing in, cleaned up by a local AI model. No word limits, and nothing leaves your Mac unless you choose the optional cloud cleanup with your own OpenRouter key.

Apple Silicon only.

## Install

1. Download `DictateAI-<version>-arm64.dmg` from [Releases](https://github.com/ali050786/dictateai/releases), open it and drag **DictateAI** into **Applications**.
2. Open DictateAI. When macOS says it could not verify the app, click **Done**, then go to System Settings → Privacy & Security and click **Open Anyway**. The app is signed ad hoc, not notarized, and since macOS 15 right-click → Open no longer gets past this.
3. It lives in the menu bar (🎙), not the Dock. Allow **Accessibility** when macOS asks (System Settings → Privacy & Security → Accessibility → DictateAI). The dictation key starts working as soon as you allow it.
4. Allow the **Microphone** the first time you dictate.

Nothing else to install: the speech engine (WhisperKit) and the cleanup engine (a standalone Python with mlx-lm) ship inside the app. The first run downloads the models, with progress shown in Settings: about 490 MB for speech, and 1.7 GB (English) or 4.3 GB (other languages) for cleanup.

After rebuilding and reinstalling, macOS may ask for Accessibility again.

## Build

Building needs Homebrew's `whisperkit-cli` (copied into the app) and [uv](https://docs.astral.sh/uv/) (fetches the bundled Python):

```bash
brew install whisperkit-cli
```

```bash
npm install && npm run make
```

`npm run make` runs `scripts/build-engines.sh` and writes `out/make/dmg/arm64/DictateAI-<version>-arm64.dmg`.

## Use

- **Hold** the dictation key (Right ⌥ Option by default; change it in the app) and speak. Release to insert the text.
- **Double-tap** for hands-free; tap again to stop.
- **Triple-tap** to undo the last dictation.

Settings, history and your dictionary are in the app window: click the menu-bar icon → Open DictateAI. Data is kept in `~/.dictateai` (readable only by you).

## Develop

```bash
npm run build:engines && npm start
```

Set `DICTATEAI_DEBUG=1` to log dictated text; by default logs show only its length.

## History

How this version was built, and why: [docs/sessions/2026-10-18-session.md](docs/sessions/2026-10-18-session.md).
