# DictateAI

Voice dictation for macOS that runs on your Mac. Hold a key, speak, and the text appears in whatever field you're typing in, cleaned up by a local AI model. No word limits, and nothing leaves your Mac unless you choose the optional cloud cleanup with your own OpenRouter key.

Apple Silicon only.

## Requirements

DictateAI uses two command-line tools for the speech and AI models:

```bash
brew install whisperkit-cli
```

```bash
uv tool install mlx-lm
```

(`uv` comes from https://docs.astral.sh/uv/.) The first run downloads the models: about 500 MB for speech, and 1.8 GB (English) or 4.3 GB (other languages) for cleanup.

## Install

1. Build the installer:

   ```bash
   npm install && npm run make
   ```

2. Open `out/make/dmg/arm64/DictateAI-<version>-arm64.dmg` and drag **DictateAI** into **Applications**.
3. Open DictateAI from Applications. It lives in the menu bar (🎙), not the Dock.
4. Allow **Accessibility** when macOS asks (System Settings → Privacy & Security → Accessibility → DictateAI). The dictation key starts working as soon as you allow it.
5. Allow the **Microphone** the first time you dictate.

The app is signed ad hoc, not notarized. That's fine for a copy you built yourself; a build downloaded from elsewhere would need right-click → Open the first time. After rebuilding and reinstalling, macOS may ask for Accessibility again.

## Use

- **Hold** the dictation key (Right ⌥ Option by default; change it in the app) and speak. Release to insert the text.
- **Double-tap** for hands-free; tap again to stop.
- **Triple-tap** to undo the last dictation.

Settings, history and your dictionary are in the app window: click the menu-bar icon → Open DictateAI. Data is kept in `~/.dictateai` (readable only by you).

## Develop

```bash
npm start
```

Set `DICTATEAI_DEBUG=1` to log dictated text; by default logs show only its length.

## History

How this version was built, and why: [docs/sessions/2026-10-18-session.md](docs/sessions/2026-10-18-session.md).
