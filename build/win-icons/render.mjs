// Renders the Windows icons: build/icon-win.png (512) and app/tray-win*.png (16/24/32).
// Run: node build/win-icons/render.mjs (needs playwright-core and a Chromium; set CHROMIUM_PATH).
import { chromium } from 'playwright-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const exe = process.env.CHROMIUM_PATH || `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const b = await chromium.launch({ headless: true, executablePath: exe });
const out = [
  [512, path.join(root, 'build', 'icon-win.png')],
  [16, path.join(root, 'app', 'tray-win.png')],
  [24, path.join(root, 'app', 'tray-win@1.5x.png')],
  [32, path.join(root, 'app', 'tray-win@2x.png')],
];
for (const [size, file] of out) {
  const p = await b.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await p.goto('file://' + path.join(here, 'icon.html'));
  await p.waitForTimeout(200);
  await p.screenshot({ path: file, omitBackground: true });
}
await b.close();
