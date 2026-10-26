# BackQuant Terminal for macOS and Windows

The [BackQuant Terminal](https://terminal.backquant.com) in its own desktop window, running on
Chromium. The app is a thin shell: the terminal itself loads from the web, so every
update to the terminal reaches the app immediately. Data, accounts and plans all stay
on BackQuant's servers; nothing runs locally.

## What it adds over a browser tab

- **Chromium engine.** Charts, heatmaps and the order book stay smooth on a full desk.
- **Alerts in the background.** Closing the window keeps the app running in the menu bar
  (Mac) or system tray (Windows), so Watch alerts still arrive as notifications. It can
  open at login.
- **Sign in as usual.** Email, Google, GitHub or Discord. Social sign-in opens in your
  default browser and returns to the app.
- **Pop-out panels** open as real windows; **downloads** go to your Downloads folder.
- **Update notice.** When a new version of the app is out, it tells you.

## Install

### macOS

1. Open `BackQuant-Terminal.dmg` and drag BackQuant Terminal into Applications.
2. Open it. macOS says it cannot verify the developer: click Done.
3. Open System Settings > Privacy & Security, scroll down, click **Open Anyway** next to
   BackQuant Terminal and confirm. It opens normally from then on.

Requires macOS 12 or later, Apple Silicon or Intel.

### Windows

1. Run `BackQuant-Terminal-Setup.exe`. It installs for your user only, no admin rights
   needed, and adds Start menu and desktop shortcuts.
2. Windows may show "Windows protected your PC": click **More info**, then **Run anyway**.
   This happens once, because the installer is not code-signed.

Uninstall from Settings > Apps like any other app. Requires Windows 10 or 11 (64-bit).

## Build from source

```
npm install
npm test           # URL and update rules
npm run dist       # on a Mac:     release/BackQuant-Terminal.dmg
npm run dist:win   # on Windows:   release/BackQuant-Terminal-Setup.exe
```

**macOS:** `npm run dist` builds a universal app with electron-builder, then
`build/make-dmg.sh` packs it into the installer, letting Finder lay out the window designed
in `build/dmg-design/background.html` (re-render with `node build/dmg-design/render.mjs`).
The app is ad-hoc signed by `build/after-pack.js`.

**Windows:** build the installer on Windows (the NSIS installer compiler does not run on
Apple Silicon). `build/after-pack.js` stamps the app's icon and version details into
`BackQuant Terminal.exe`. On a Mac you can still build a portable zip of the Windows app:
`npx electron-builder --win zip --x64`.

Icons: `build/icon-win.png` / `build/icon-win.ico` and the tray icons in `app/` come from
`build/win-icons/` (`node build/win-icons/render.mjs`, then `node build/win-icons/make-ico.mjs`).
