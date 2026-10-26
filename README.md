# BackQuant Terminal for macOS

The [BackQuant Terminal](https://terminal.backquant.com) in its own Mac window, running on
Chromium. The app is a thin shell: the terminal itself loads from the web, so every
update to the terminal reaches the app immediately. Data, accounts and plans all stay
on BackQuant's servers; nothing runs locally.

## What it adds over a browser tab

- **Chromium engine.** Charts, heatmaps and the order book stay smooth on a full desk.
- **Alerts from the menu bar.** Closing the window keeps the app running in the menu bar,
  so Watch alerts still arrive as Mac notifications. It can open at login.
- **Sign in as usual.** Email, Google, GitHub or Discord. Social sign-in opens in your
  default browser and returns to the app.
- **Pop-out panels** open as real windows; **downloads** go to your Downloads folder.
- **Update notice.** When a new version of the app is out, it tells you.

## Install

1. Open `BackQuant-Terminal.dmg` and drag BackQuant Terminal into Applications.
2. Open it. macOS says it cannot verify the developer: click Done.
3. Open System Settings > Privacy & Security, scroll down, click **Open Anyway** next to
   BackQuant Terminal and confirm. It opens normally from then on.

Requires macOS 12 or later, Apple Silicon or Intel.

## Build from source

```
npm install
npm test        # URL and update rules
npm run dist    # release/BackQuant-Terminal.dmg
```

`npm run dist` builds a universal app with electron-builder, then `build/make-dmg.sh`
packs it into the installer, letting Finder lay out the window designed in
`build/dmg-design/background.html` (re-render with `node build/dmg-design/render.mjs`).
The app is ad-hoc signed by `build/adhoc-sign.js`.
