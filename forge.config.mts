import type { ForgeConfig } from '@electron-forge/shared-types';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { WebpackPlugin } from '@electron-forge/plugin-webpack';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

import { mainConfig } from './webpack.main.config';
import { rendererConfig } from './webpack.renderer.config';

const BUNDLE_ID = 'io.github.ali050786.dictateai';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    // The text-injection addon is loaded with a plain require at runtime, so
    // webpack never sees it. Copy it next to app.asar (Contents/Resources).
    // The speech and cleanup engines (scripts/build-engines.sh) land in
    // Contents/Resources/bin and Contents/Resources/python.
    extraResource: ['native/text-injection/build/Release/text_injection.node', 'engines/bin', 'engines/python'],
    // macOS keys Accessibility, Microphone and Keychain access to this ID.
    appBundleId: BUNDLE_ID,
    appCategoryType: 'public.app-category.productivity',
    extendInfo: {
      // Menu-bar app: no Dock icon, not even briefly at launch.
      LSUIElement: true,
      NSMicrophoneUsageDescription:
        'DictateAI listens only while you hold your dictation key, and turns your speech into text on this Mac.',
    },
  },
  rebuildConfig: {},
  hooks: {
    // The app is only signed ad hoc, and that signature carries Electron's
    // identifier (com.github.Electron). macOS privacy permissions
    // (Microphone, Accessibility) key on the signature, so re-sign the bundle
    // with our own identifier. Packaging also edits the helper apps'
    // Info.plists, which invalidates their signatures, so sign those too.
    postPackage: async (_config, { platform, outputPaths }) => {
      if (platform !== 'darwin') return;
      for (const dir of outputPaths) {
        for (const entry of readdirSync(dir).filter((name) => name.endsWith('.app'))) {
          const app = join(dir, entry);
          // Nested helpers first (each keeps its own identifier), then the app.
          execFileSync('codesign', ['--force', '--deep', '--sign', '-', app]);
          execFileSync('codesign', ['--force', '--sign', '-', '--identifier', BUNDLE_ID, app]);
        }
      }
    },
  },
  makers: [
    new MakerSquirrel({}),
    new MakerZIP({}, ['darwin']),
    // Drag-to-Applications installer: out/make/DictateAI-<version>-arm64.dmg
    new MakerDMG({ format: 'ULFO' }, ['darwin']),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new WebpackPlugin({
      mainConfig,
      renderer: {
        config: rendererConfig,
        entryPoints: [
          {
            html: './src/index.html',
            js: './src/renderer.ts',
            name: 'main_window',
            preload: {
              js: './src/preload.ts',
            },
          },
          {
            html: './src/hub.html',
            js: './src/hub-renderer.ts',
            name: 'hub_window',
            preload: {
              js: './src/hub-preload.ts',
            },
          },
          {
            html: './src/welcome.html',
            js: './src/welcome-renderer.ts',
            name: 'welcome_window',
            preload: {
              js: './src/welcome-preload.ts',
            },
          },
        ],
      },
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
