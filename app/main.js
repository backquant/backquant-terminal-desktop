// BackQuant Terminal for macOS and Windows: a native window around
// https://terminal.backquant.com, running on Chromium (Electron) for smooth charts on a
// full desk.
//
// Everything the terminal does (data, accounts, billing, the paywall) stays on the
// server. This shell only adds the parts a browser tab would otherwise provide:
//   * external links open in the user's default browser, the terminal stays put
//   * OAuth sign-in (Google, GitHub, Discord) runs in the default browser, where the
//     user is usually already signed in (and Google refuses embedded webviews); the
//     resulting code is handed back to this window over a loopback port
//   * pop-out panels open as real windows, downloads land in ~/Downloads
//   * site notifications become native notifications
//   * closing the window keeps the app running in the menu bar / system tray (and optionally at
//     login) so watch alerts, which arrive over the site's WebSocket, keep coming
//   * a page that crashes is reloaded (crash.js); Windows installs updates itself,
//     macOS gets a notice (update.js)

const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  Notification,
  Tray,
  nativeImage,
  powerSaveBlocker,
  session,
  shell,
} = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {
  HOME_URL,
  DOCS_URL,
  LOOPBACK_PORT,
  allowedInApp,
  isOAuthAuthorize,
  rewriteRedirect,
} = require('./urls');
const { afterCrash } = require('./crash');
const { RELEASES_PAGE, compareVersions, fetchLatest, newerRelease, plainNotes } = require('./update');

const APP_NAME = 'BackQuant Terminal';
const IS_WIN = process.platform === 'win32';
// Passed by the login item so a launch at login starts in the menu bar, window hidden.
const HIDDEN_ARG = '--hidden';
const LAUNCH_AGENT = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.backquant.desktop.plist');

app.setName(APP_NAME);
// Windows groups notifications and taskbar entries by this id; it must match the
// installer's shortcut (electron-builder uses build.appId).
if (IS_WIN) app.setAppUserModelId('com.backquant.desktop');

let mainWindow = null;
let tray = null;
let quitting = false;
let loopbackOk = false;
// Original redirect_to of the sign-in in flight (where the code must be delivered).
let pendingRedirect = null;

// ---------------------------------------------------------------------------
// Small persisted state (window bounds, opt-outs)
// ---------------------------------------------------------------------------

function statePath() {
  return path.join(app.getPath('userData'), 'state.json');
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeState(patch) {
  try {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify({ ...readState(), ...patch }));
  } catch (e) {
    console.error('[backquant] could not save state:', e);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openExternal(url) {
  shell.openExternal(url).catch((e) => console.error(`[backquant] could not open ${url}:`, e));
}

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body }).show();
}

function showMain() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ---------------------------------------------------------------------------
// Loopback receiver for the OAuth sign-in callback
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function page(title, body) {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><title>BackQuant Terminal</title><style>' +
    'html,body{margin:0;height:100%;background:#0b0b0c;color:#e8e8ea;' +
    'font:14px/1.5 -apple-system,BlinkMacSystemFont,system-ui,sans-serif}' +
    'main{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px}' +
    'h1{font-size:16px;font-weight:600;margin:0}p{margin:0;color:#8a8a90}' +
    `</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></main></body></html>`
  );
}

function startLoopback() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const send = (status, title, body = '') => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(page(title, body));
      };
      const cb = new URL(req.url || '/', 'http://127.0.0.1');
      if (cb.pathname !== '/callback') return send(404, 'Not found');
      const dest = pendingRedirect;
      pendingRedirect = null;
      if (!dest) return send(200, 'No sign-in in progress', 'Open BackQuant Terminal and sign in again.');
      const err = cb.searchParams.get('error_description') || cb.searchParams.get('error');
      if (err) return send(200, 'Sign-in failed', `${err}. Return to BackQuant Terminal and try again.`);
      if (!cb.searchParams.has('code')) return send(200, 'Sign-in incomplete', 'Return to BackQuant Terminal and try again.');
      const target = new URL(dest);
      for (const [k, v] of cb.searchParams) target.searchParams.append(k, v);
      send(200, 'Signed in', 'You can close this tab and return to BackQuant Terminal.');
      if (mainWindow) mainWindow.loadURL(target.toString());
      showMain();
    });
    server.once('error', (e) => {
      console.error(`[backquant] port ${LOOPBACK_PORT} unavailable, OAuth sign-in stays in-window:`, e.message);
      resolve(false);
    });
    server.listen(LOOPBACK_PORT, '127.0.0.1', () => resolve(true));
  });
}

// ---------------------------------------------------------------------------
// Open at login, starting hidden in the menu bar / tray.
// macOS: a LaunchAgent (Electron's login-item args are Windows-only).
// Windows: the Run key, through Electron's login-item settings.
// ---------------------------------------------------------------------------

/** Login items record the executable path, so only register one from an installed
 *  copy. A run from the dmg or Downloads (App Translocation) would leave a dead path;
 *  on Windows the installer puts the app in a fixed place. */
function installedInApplications() {
  const exe = app.getPath('exe');
  if (IS_WIN) return !/\\Temp\\/i.test(exe);
  return exe.startsWith('/Applications/') || exe.startsWith(path.join(os.homedir(), 'Applications') + '/');
}

function autostartEnabled() {
  if (IS_WIN) return app.getLoginItemSettings({ args: [HIDDEN_ARG] }).openAtLogin;
  return fs.existsSync(LAUNCH_AGENT);
}

function setLoginItem(on) {
  if (IS_WIN) {
    app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args: [HIDDEN_ARG] });
  } else if (on) {
    writeLaunchAgent();
  } else if (fs.existsSync(LAUNCH_AGENT)) {
    fs.unlinkSync(LAUNCH_AGENT);
  }
}

function writeLaunchAgent() {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.backquant.desktop</string>
  <key>ProgramArguments</key>
  <array><string>${escapeHtml(app.getPath('exe'))}</string><string>${HIDDEN_ARG}</string></array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`;
  fs.mkdirSync(path.dirname(LAUNCH_AGENT), { recursive: true });
  fs.writeFileSync(LAUNCH_AGENT, plist);
}

/** Open at Login is ON unless the user turned it off. Re-registering on every
 *  launch keeps the login item pointing at the current copy. */
function syncAutostart() {
  if (readState().autostartOff || !installedInApplications()) return autostartEnabled();
  try {
    setLoginItem(true);
  } catch (e) {
    console.error('[backquant] could not register login item:', e);
  }
  return autostartEnabled();
}

function setAutostart(on) {
  writeState({ autostartOff: !on });
  try {
    setLoginItem(on);
  } catch (e) {
    console.error('[backquant] could not change login item:', e);
  }
  rebuildMenus();
}

// ---------------------------------------------------------------------------
// Updates: Windows installs them, macOS gets a notice (see update.js)
// ---------------------------------------------------------------------------

const UPDATE_CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
// A dialog is open or an update is downloading: no second check meanwhile.
let updateBusy = false;
let winUpdater = null;

function windowsUpdater() {
  if (!winUpdater) {
    winUpdater = require('electron-updater').autoUpdater;
    // Nothing downloads or installs until the user says Update Now.
    winUpdater.autoDownload = false;
    winUpdater.autoInstallOnAppQuit = false;
  }
  return winUpdater;
}

/** The newer version, or null. Throws when the check itself fails. */
async function latestUpdate() {
  if (IS_WIN) {
    const info = (await windowsUpdater().checkForUpdates())?.updateInfo;
    if (!info || compareVersions(info.version, app.getVersion()) <= 0) return null;
    return { version: info.version, url: RELEASES_PAGE, notes: plainNotes(info.releaseNotes) };
  }
  return newerRelease(await fetchLatest(), app.getVersion(), process.platform);
}

/** Windows: download the installer (checked against the release's sha512), run it
 *  silently and restart. A failure offers the download page instead. */
async function installWindowsUpdate(update) {
  const updater = windowsUpdater();
  const progress = (p) => mainWindow?.setProgressBar(Math.min(1, Math.max(0, (p.percent || 0) / 100)));
  notify(`Updating ${APP_NAME}`, `Downloading ${update.version}. The app restarts by itself when it is ready.`);
  updater.on('download-progress', progress);
  try {
    await updater.downloadUpdate();
  } catch (e) {
    console.error('[backquant] update download failed:', e.message);
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      message: 'Could not install the update',
      detail: `Download ${APP_NAME} ${update.version} from the release page and run the installer instead.`,
      buttons: ['Open Download Page', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) openExternal(RELEASES_PAGE);
    return;
  } finally {
    updater.removeListener('download-progress', progress);
    mainWindow?.setProgressBar(-1);
  }
  // Silent install, then start the new version.
  updater.quitAndInstall(true, true);
}

async function checkForUpdates({ manual = false } = {}) {
  if (updateBusy) return;
  updateBusy = true;
  try {
    let update;
    try {
      update = await latestUpdate();
    } catch (e) {
      console.error('[backquant] update check failed:', e.message);
      if (manual) {
        await dialog.showMessageBox({
          type: 'warning',
          message: 'Could not check for updates',
          detail: 'Check your internet connection and try again.',
        });
      }
      return;
    }
    if (!update) {
      if (manual) {
        await dialog.showMessageBox({ type: 'info', message: `You're up to date`, detail: `${APP_NAME} ${app.getVersion()} is the latest version.` });
      }
      return;
    }
    // A skipped version stays quiet until the user checks by hand.
    if (!manual && readState().skippedVersion === update.version) return;
    const notes = update.notes ? `\n\n${update.notes.slice(0, 600)}` : '';
    const { response } = await dialog.showMessageBox({
      type: 'info',
      message: `${APP_NAME} ${update.version} is available`,
      detail:
        `You have ${app.getVersion()}. ` +
        (IS_WIN
          ? 'Update Now downloads it, installs it and restarts the app, in about a minute.'
          : 'Download the new version, then drag it into Applications to replace this one.') +
        notes,
      buttons: [IS_WIN ? 'Update Now' : 'Download', 'Later', 'Skip This Version'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      if (IS_WIN) await installWindowsUpdate(update);
      else openExternal(update.url);
    } else if (response === 2) {
      writeState({ skippedVersion: update.version });
    }
  } finally {
    updateBusy = false;
  }
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

function autostartItem() {
  return {
    label: 'Open at Login',
    type: 'checkbox',
    checked: autostartEnabled(),
    enabled: installedInApplications(),
    click: (item) => setAutostart(item.checked),
  };
}

function rebuildMenus() {
  const nav = (fn) => () => mainWindow && fn(mainWindow.webContents);
  const viewMenu = {
    label: 'View',
    submenu: [
      { label: 'Back', accelerator: 'CmdOrCtrl+[', click: nav((wc) => wc.navigationHistory.goBack()) },
      { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: nav((wc) => wc.navigationHistory.goForward()) },
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: nav((wc) => wc.reload()) },
      { label: 'Terminal Home', accelerator: 'CmdOrCtrl+Shift+H', click: nav((wc) => wc.loadURL(HOME_URL)) },
      { type: 'separator' },
      {
        label: 'Open This Page in Browser',
        click: nav((wc) => {
          const url = wc.getURL();
          if (/^https?:/.test(url)) openExternal(url);
        }),
      },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  };
  const helpMenu = { role: 'help', submenu: [{ label: 'BackQuant Documentation', click: () => openExternal(DOCS_URL) }] };
  // Windows: a plain File menu (the window hides the menu bar; Alt shows it, and the
  // shortcuts work either way). macOS keeps the standard app menu.
  const winTemplate = [
    {
      label: 'File',
      submenu: [
        { label: 'Check for Updates...', click: () => checkForUpdates({ manual: true }) },
        { type: 'separator' },
        autostartItem(),
        { type: 'separator' },
        { label: `Quit ${APP_NAME}`, accelerator: 'Ctrl+Q', click: () => app.quit() },
      ],
    },
    { role: 'editMenu' },
    viewMenu,
    helpMenu,
  ];
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(IS_WIN ? winTemplate : [
      {
        label: APP_NAME,
        submenu: [
          { role: 'about', label: `About ${APP_NAME}` },
          { label: 'Check for Updates...', click: () => checkForUpdates({ manual: true }) },
          { type: 'separator' },
          autostartItem(),
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide', label: `Hide ${APP_NAME}` },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit', label: `Quit ${APP_NAME}` },
        ],
      },
      // The Edit menu is what routes Cmd+C / Cmd+V / Cmd+A into the page on macOS.
      { role: 'editMenu' },
      viewMenu,
      { role: 'windowMenu' },
      helpMenu,
    ]),
  );
  if (tray) {
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Open ${APP_NAME}`, click: showMain },
        { label: 'Check for Updates...', click: () => checkForUpdates({ manual: true }) },
        { type: 'separator' },
        autostartItem(),
        { type: 'separator' },
        { label: `Quit ${APP_NAME}`, click: () => app.quit() },
      ]),
    );
  }
}

function buildTray() {
  if (IS_WIN) {
    // Colour icon: Windows has no template images, and the tray can be light or dark.
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'tray-win.png')));
    // Windows convention: left click opens the app, right click shows the menu.
    tray.on('click', showMain);
  } else {
    const img = nativeImage.createFromPath(path.join(__dirname, 'trayTemplate.png')).resize({ height: 18 });
    img.setTemplateImage(true);
    tray = new Tray(img);
  }
  tray.setToolTip(APP_NAME);
}

// ---------------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------------

/** Closing the window hides it; say so once, so nobody thinks the app quit. */
function hintStillRunning() {
  if (readState().closeHintShown) return;
  writeState({ closeHintShown: true });
  notify(
    IS_WIN ? 'Still running in the system tray' : 'Still running in the menu bar',
    IS_WIN
      ? 'BackQuant Terminal keeps running so your alerts arrive. Quit from the tray icon or with Ctrl+Q.'
      : 'BackQuant Terminal keeps running so your alerts arrive. Quit from the menu bar icon or with Cmd+Q.',
  );
}

function createMainWindow(visible) {
  const saved = readState().bounds;
  const win = new BrowserWindow({
    title: APP_NAME,
    width: saved?.width ?? 1440,
    height: saved?.height ?? 900,
    x: saved?.x,
    y: saved?.y,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0b0c',
    // Windows: no menu bar strip over the terminal (Alt brings it back).
    autoHideMenuBar: IS_WIN,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      // Alerts must keep arriving while the window is hidden.
      backgroundThrottling: false,
    },
  });
  if (saved?.maximized) win.maximize();
  win.once('ready-to-show', () => {
    if (visible) win.show();
  });

  const saveBounds = () => {
    if (!win.isDestroyed() && !win.isMinimized() && !win.isFullScreen()) {
      writeState({ bounds: { ...win.getNormalBounds(), maximized: win.isMaximized() } });
    }
  };
  win.on('resized', saveBounds);
  win.on('moved', saveBounds);

  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    saveBounds();
    if (win.isFullScreen()) {
      win.once('leave-full-screen', () => win.hide());
      win.setFullScreen(false);
    } else {
      win.hide();
    }
    hintStillRunning();
  });

  const wc = win.webContents;

  // Main-frame navigations: OAuth goes to the browser, foreign sites too.
  const guard = (e, url) => {
    if (isOAuthAuthorize(url) && loopbackOk) {
      e.preventDefault();
      const { browserUrl, original } = rewriteRedirect(url);
      pendingRedirect = original ?? HOME_URL;
      openExternal(browserUrl);
      return;
    }
    if (!allowedInApp(url)) {
      e.preventDefault();
      openExternal(url);
    }
  };
  wc.on('will-navigate', guard);
  wc.on('will-redirect', guard);

  // window.open / target=_blank. Pop-out panels open about:blank and render into
  // it, so those need a real window; every other link goes to the browser.
  wc.setWindowOpenHandler(({ url }) => {
    if (!url || url === 'about:blank') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { backgroundColor: '#0b0b0c', webPreferences: { backgroundThrottling: false } },
      };
    }
    openExternal(url);
    return { action: 'deny' };
  });

  // A page process that dies leaves a blank window: reload it (see crash.js).
  let crashes = [];
  wc.on('render-process-gone', (_e, details) => {
    const out = afterCrash(details.reason, crashes, Date.now());
    crashes = out.recent;
    if (out.action === 'ignore' || win.isDestroyed()) return;
    console.error(`[backquant] page process gone (${details.reason}, exit ${details.exitCode}): ${out.action}`);
    if (out.action === 'reload') {
      wc.reload();
      notify(`${APP_NAME} reloaded`, 'The terminal stopped unexpectedly, so the app reloaded it.');
    } else {
      win.loadFile(path.join(__dirname, 'index.html'), { hash: 'crashed' });
      showMain();
    }
  });
  // Pop-out panels are drawn by the main page; once their page process is gone they
  // have nothing left to show.
  wc.on('did-create-window', (child) => {
    child.webContents.on('render-process-gone', (_e, details) => {
      if (details.reason !== 'clean-exit' && !child.isDestroyed()) child.close();
    });
  });

  win.loadFile(path.join(__dirname, 'index.html'));
  return win;
}

// ---------------------------------------------------------------------------
// Session: user agent, permissions, downloads
// ---------------------------------------------------------------------------

function setupSession() {
  const ses = session.defaultSession;

  // Present as plain Chrome (drop the Electron and app-name tokens) plus a product
  // token so server logs can tell desktop sessions apart.
  const ua = ses
    .getUserAgent()
    .replace(/\s?Electron\/\S+/, '')
    .replace(/\s?backquant-terminal-desktop\/\S+/, '')
    .replace(/\s?BackQuant Terminal\/\S+/, '');
  ses.setUserAgent(`${ua} BackQuantDesktop/${app.getVersion()}`);

  const ourOrigin = (url) => {
    try {
      const h = new URL(url).hostname;
      return h === 'backquant.com' || h.endsWith('.backquant.com');
    } catch {
      return false;
    }
  };
  const allowed = new Set(['notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen']);
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    cb(allowed.has(permission) && ourOrigin(details.requestingUrl || wc.getURL()));
  });
  ses.setPermissionCheckHandler((wc, permission, origin) => allowed.has(permission) && ourOrigin(origin));

  ses.on('will-download', (_e, item) => {
    const dir = app.getPath('downloads');
    const { name, ext } = path.parse(item.getFilename() || 'download');
    let target = path.join(dir, name + ext);
    for (let i = 1; fs.existsSync(target); i++) target = path.join(dir, `${name} (${i})${ext}`);
    item.setSavePath(target);
    item.once('done', (_ev, state) => {
      if (state === 'completed') notify('Download complete', `Saved to Downloads: ${path.basename(target)}`);
      else if (state !== 'cancelled') notify('Download failed', 'The file could not be saved.');
    });
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMain);

  app.whenReady().then(async () => {
    // App Nap would stall the hidden page's timers (WebSocket keepalive and
    // reconnect). The Mac can still sleep; this only keeps the app awake-able.
    powerSaveBlocker.start('prevent-app-suspension');

    setupSession();
    loopbackOk = await startLoopback();
    syncAutostart();
    buildTray();
    rebuildMenus();

    const startHidden = process.argv.includes(HIDDEN_ARG);
    mainWindow = createMainWindow(!startHidden);

    setTimeout(() => checkForUpdates(), 15_000);
    setInterval(() => checkForUpdates(), UPDATE_CHECK_EVERY_MS);
  });

  // Dock icon clicked while the window is hidden.
  app.on('activate', showMain);
  app.on('before-quit', () => {
    quitting = true;
  });
  // The window only hides, so this fires only on a real quit.
  app.on('window-all-closed', () => app.quit());
}
