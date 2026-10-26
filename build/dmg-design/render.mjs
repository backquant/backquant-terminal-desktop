// Renders background.html to ../background.png (720x460) and ../background@2x.png.
// Run: node build/dmg-design/render.mjs (needs playwright-core and a Chromium; set CHROMIUM_PATH).
import { chromium } from 'playwright-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const exe = process.env.CHROMIUM_PATH || `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const b = await chromium.launch({ headless: true, executablePath: exe });
for (const [scale, name] of [[1, 'background.png'], [2, 'background@2x.png']]) {
  const p = await b.newPage({ viewport: { width: 720, height: 460 }, deviceScaleFactor: scale });
  await p.goto('file://' + path.join(here, 'background.html'));
  await p.waitForTimeout(300);
  await p.screenshot({ path: path.join(here, '..', name) });
}
await b.close();
