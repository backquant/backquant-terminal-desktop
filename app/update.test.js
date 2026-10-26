const test = require('node:test');
const assert = require('node:assert');
const { compareVersions, newerRelease, fetchLatest, RELEASES_PAGE } = require('./update');

test('compares dotted versions numerically', () => {
  assert.strictEqual(compareVersions('0.3.10', '0.3.9'), 1);
  assert.strictEqual(compareVersions('v0.4.0', '0.3.9'), 1);
  assert.strictEqual(compareVersions('0.3.0', '0.3.0'), 0);
  assert.strictEqual(compareVersions('0.3', '0.3.1'), -1);
});

test('offers only a newer, published release, preferring the dmg', () => {
  const rel = {
    tag_name: 'v0.4.0',
    html_url: 'https://github.com/backquant/backquant-terminal-desktop/releases/tag/v0.4.0',
    body: 'Faster charts',
    assets: [
      { name: 'BackQuant-Terminal-0.4.0-universal.dmg.blockmap', browser_download_url: 'x.blockmap' },
      { name: 'BackQuant-Terminal-0.4.0-universal.dmg', browser_download_url: 'x.dmg' },
    ],
  };
  assert.deepStrictEqual(newerRelease(rel, '0.3.0'), { version: '0.4.0', url: 'x.dmg', notes: 'Faster charts' });
  assert.strictEqual(newerRelease(rel, '0.4.0'), null);
  assert.strictEqual(newerRelease({ ...rel, draft: true }, '0.3.0'), null);
  assert.strictEqual(newerRelease({ ...rel, prerelease: true }, '0.3.0'), null);
  assert.strictEqual(newerRelease({ ...rel, assets: [], html_url: undefined }, '0.3.0').url, RELEASES_PAGE);
  assert.strictEqual(newerRelease(null, '0.3.0'), null);
});

test('a failed check throws instead of reporting up to date', async () => {
  await assert.rejects(fetchLatest(async () => ({ ok: false, status: 404 })), /HTTP 404/);
});
