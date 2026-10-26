#!/bin/bash
# Packs release/mac-universal/BackQuant Terminal.app into release/BackQuant-Terminal.dmg
# with the designed installer window (build/dmg-design/background.html).
#
# Finder lays the window out itself (AppleScript), so the background and icon
# positions are stored in the format the running macOS reads. electron-builder's own
# dmg writer produced a .DS_Store that macOS 26 Finder ignored: the background never
# showed. A Finder window opens briefly during the build; that is expected.
#
# Usage: npm run dist (builds the app, then runs this).
set -euo pipefail
cd "$(dirname "$0")/.."

VOL="BackQuant Terminal"
APP="release/mac-universal/BackQuant Terminal.app"
OUT="release/BackQuant-Terminal.dmg"
RW="release/build-rw.dmg"
MNT="/Volumes/$VOL"

# Must match background.html: window content 720 x 460, icon centres below.
WIN_W=720
WIN_H=460
# Finder's window bounds include the title bar; without it the design's bottom is cut.
TITLEBAR=32
ICON=120
APP_POS="190, 236"
APPS_POS="530, 236"

[ -d "$APP" ] || { echo "No app at $APP; run electron-builder --mac dir --universal first" >&2; exit 1; }
if [ -d "$MNT" ]; then
  echo "A volume named '$VOL' is mounted; eject it and run again" >&2
  exit 1
fi

rm -f "$RW" "$OUT"
# One TIFF holding both resolutions: Finder picks the Retina one on Retina screens.
tiffutil -cathidpicheck build/background.png build/background@2x.png -out release/background.tiff

size_mb=$(( $(du -sm "$APP" | cut -f1) + 80 ))
hdiutil create -quiet -size "${size_mb}m" -fs HFS+ -volname "$VOL" -ov "$RW"
dev=$(hdiutil attach -readwrite -noverify -noautoopen "$RW" | awk '/Apple_HFS/ {print $1}')
cleanup() { [ -n "${dev:-}" ] && hdiutil detach -quiet -force "$dev" 2>/dev/null || true; }
trap cleanup EXIT

ditto "$APP" "$MNT/BackQuant Terminal.app"
ln -s /Applications "$MNT/Applications"
mkdir "$MNT/.background"
cp release/background.tiff "$MNT/.background/background.tiff"
cp build/icon.icns "$MNT/.VolumeIcon.icns"
SetFile -a C "$MNT"

osascript <<EOF
tell application "Finder"
  tell disk "$VOL"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set sidebar width of container window to 0
    set the bounds of container window to {200, 140, 200 + $WIN_W, 140 + $WIN_H + $TITLEBAR}
    set opts to the icon view options of container window
    set arrangement of opts to not arranged
    set icon size of opts to $ICON
    set text size of opts to 13
    set label position of opts to bottom
    set shows item info of opts to false
    set background picture of opts to file ".background:background.tiff"
    set position of item "BackQuant Terminal.app" of container window to {$APP_POS}
    set position of item "Applications" of container window to {$APPS_POS}
    close
    open
    update without registering applications
    delay 2
    close
  end tell
end tell
EOF

# Let Finder finish writing .DS_Store before the image is sealed.
for _ in 1 2 3 4 5; do [ -f "$MNT/.DS_Store" ] && break; sleep 1; done
sync
sleep 2
hdiutil detach -quiet "$dev"
dev=""
hdiutil convert -quiet "$RW" -format UDZO -imagekey zlib-level=9 -o "$OUT"
rm -f "$RW" release/background.tiff
echo "Built $OUT"
