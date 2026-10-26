// Builds build/icon-win.ico from build/icon-win.png: PNG-compressed entries at the
// sizes Windows asks for (taskbar, Start, Explorer, high-DPI). Uses macOS `sips` to
// resize, so run it on a Mac: node build/win-icons/make-ico.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = path.join(root, 'build', 'icon-win.png');
const out = path.join(root, 'build', 'icon-win.ico');
const sizes = [16, 24, 32, 48, 64, 128, 256];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bqico-'));

const images = sizes.map((s) => {
  const f = path.join(tmp, `${s}.png`);
  execFileSync('sips', ['-z', String(s), String(s), src, '--out', f], { stdio: 'ignore' });
  return { size: s, data: fs.readFileSync(f) };
});

// ICONDIR (6 bytes) + one ICONDIRENTRY (16 bytes) per image, then the PNG data.
const header = Buffer.alloc(6 + 16 * images.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);
let offset = header.length;
images.forEach(({ size, data }, i) => {
  const e = 6 + 16 * i;
  header.writeUInt8(size >= 256 ? 0 : size, e);
  header.writeUInt8(size >= 256 ? 0 : size, e + 1);
  header.writeUInt8(0, e + 2);
  header.writeUInt8(0, e + 3);
  header.writeUInt16LE(1, e + 4);
  header.writeUInt16LE(32, e + 6);
  header.writeUInt32LE(data.length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += data.length;
});
fs.writeFileSync(out, Buffer.concat([header, ...images.map((i) => i.data)]));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`wrote ${out}`);
