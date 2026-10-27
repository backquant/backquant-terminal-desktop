// Updates. Windows installs them itself through electron-updater (main.js): the
// installer is checked against the sha512 in the release's latest.yml, run silently,
// and the app restarts. An unsigned Mac app cannot update itself (Apple's updater
// only accepts signed bundles), so on macOS the shell checks GitHub for a newer
// release and offers to open its download. Site changes never need either: the
// terminal itself loads from the web on every launch and reload.
//
// Until a release is published GitHub answers 404, which the check treats as a
// failed check and stays quiet.

const RELEASES_API = 'https://api.github.com/repos/backquant/backquant-terminal-desktop/releases/latest';
const RELEASES_PAGE = 'https://github.com/backquant/backquant-terminal-desktop/releases/latest';

/** Compare dotted versions ("0.3.10" > "0.3.9"). A leading "v" is ignored. */
function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** The newer release, or null. Picks this platform's installer (.dmg on macOS,
 *  .exe on Windows) so Download fetches the file directly; otherwise the release
 *  page. */
function newerRelease(release, currentVersion, platform = 'darwin') {
  if (!release || release.draft || release.prerelease || !release.tag_name) return null;
  if (compareVersions(release.tag_name, currentVersion) <= 0) return null;
  const ext = platform === 'win32' ? /\.exe$/i : /\.dmg$/i;
  const installer = (release.assets || []).find((a) => ext.test(a.name || ''));
  return {
    version: String(release.tag_name).replace(/^v/, ''),
    url: installer?.browser_download_url || release.html_url || RELEASES_PAGE,
    notes: String(release.body || '').trim(),
  };
}

async function fetchLatest(fetchImpl = fetch) {
  const res = await fetchImpl(RELEASES_API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'BackQuantDesktop' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub releases: HTTP ${res.status}`);
  return res.json();
}

/** Release notes as plain text for a dialog. electron-updater hands over GitHub's
 *  rendered HTML (or a list of notes per version); the Mac check, markdown. */
function plainNotes(notes) {
  const text = Array.isArray(notes) ? notes.map((n) => n?.note ?? '').join('\n') : String(notes ?? '');
  return text
    .replace(/<\/(p|li|h[1-6]|div)>|<br\s*\/?>/gi, '\n')
    .replace(/<li>/gi, '- ')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { RELEASES_API, RELEASES_PAGE, compareVersions, newerRelease, fetchLatest, plainNotes };
