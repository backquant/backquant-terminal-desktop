// Crash recovery. When the terminal's page process dies (out of memory on a heavy
// desk, a renderer fault, killed from Task Manager), the window would stay blank
// until the app was quit and reopened. The shell reloads it instead, unless it keeps
// dying: a fourth crash within two minutes stops the reloads and shows a notice with
// a Try again button, so a page that crashes as it loads does not reload forever.

const CRASH_WINDOW_MS = 2 * 60 * 1000;
const MAX_RELOADS = 3;

/**
 * What to do about a page process that just went away: 'ignore' (a normal exit),
 * 'reload' or 'stop'. `recent` holds the times of earlier crashes; the returned
 * list replaces it.
 */
function afterCrash(reason, recent, now) {
  if (reason === 'clean-exit') return { action: 'ignore', recent };
  const kept = recent.filter((t) => now - t < CRASH_WINDOW_MS).concat(now);
  return { action: kept.length > MAX_RELOADS ? 'stop' : 'reload', recent: kept };
}

module.exports = { CRASH_WINDOW_MS, MAX_RELOADS, afterCrash };
