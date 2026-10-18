// Renders every icon DictateAI uses from the SVGs in assets/brand:
//   assets/icon/DictateAI.icns          app, Dock, Finder and DMG icon
//   assets/tray/*Template{,@2x}.png     menu-bar icons (idle and recording)
//   site/favicon.svg, favicon-32.png, apple-touch-icon.png, og.png
// Run with: npm run build:icons
import { Resvg } from '@resvg/resvg-js';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const brand = (name) => readFileSync(join(root, 'assets/brand', name), 'utf8');

function png(svg, width, out) {
  const data = new Resvg(svg, { fitTo: { mode: 'width', value: width }, font: { loadSystemFonts: true } })
    .render()
    .asPng();
  writeFileSync(out, data);
}

// App icon: macOS wants an .iconset of 16–1024 px, then iconutil packs it.
const iconset = join(root, 'assets/icon/DictateAI.iconset');
rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset, { recursive: true });
for (const size of [16, 32, 128, 256, 512]) {
  png(brand('app-icon.svg'), size, join(iconset, `icon_${size}x${size}.png`));
  png(brand('app-icon.svg'), size * 2, join(iconset, `icon_${size}x${size}@2x.png`));
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(root, 'assets/icon/DictateAI.icns')]);
png(brand('app-icon.svg'), 1024, join(root, 'assets/icon/DictateAI-1024.png'));
rmSync(iconset, { recursive: true });

// Menu bar: 18 pt, as template images ("Template" in the name tells macOS).
const tray = join(root, 'assets/tray');
mkdirSync(tray, { recursive: true });
for (const [source, name] of [['tray.svg', 'trayTemplate'], ['tray-recording.svg', 'trayRecordingTemplate']]) {
  png(brand(source), 18, join(tray, `${name}.png`));
  png(brand(source), 36, join(tray, `${name}@2x.png`));
}

// Landing page.
const site = join(root, 'site');
copyFileSync(join(root, 'assets/brand/favicon.svg'), join(site, 'favicon.svg'));
png(brand('favicon.svg'), 32, join(site, 'favicon-32.png'));
png(brand('app-icon.svg'), 180, join(site, 'apple-touch-icon.png'));
png(brand('og.svg'), 1200, join(site, 'og.png'));

console.log('Icons written to assets/icon, assets/tray and site/');
