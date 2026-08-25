#!/usr/bin/env bash
# Compile Doohickey into doohickey/Doohickey.app.
# Needs only the Xcode Command Line Tools — no Xcode project, no Node, no Electron.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$ROOT/Doohickey.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Doohickey</string>
  <key>CFBundleDisplayName</key><string>Doohickey</string>
  <key>CFBundleIdentifier</key><string>local.agentbus.doohickey</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>Doohickey</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <!-- Menu bar only: no Dock tile, no window on launch. -->
  <key>LSUIElement</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
PLIST
echo '</plist>' >> "$APP/Contents/Info.plist"

echo "compiling…"
# Globbed rather than listed: a new file under Sources/ should not need a build edit.
SOURCES=()
while IFS= read -r file; do SOURCES+=("$file"); done < <(find "$ROOT/Sources" -name '*.swift' | sort)
[[ ${#SOURCES[@]} -gt 0 ]] || { echo "no sources found under $ROOT/Sources" >&2; exit 1; }

swiftc -parse-as-library -O -swift-version 5 \
  "${SOURCES[@]}" \
  -o "$APP/Contents/MacOS/Doohickey"

# Ad-hoc signature so macOS runs it and remembers its position in the bar.
codesign --force --sign - "$APP" >/dev/null 2>&1 || true

echo "built $APP ($(du -sh "$APP" | cut -f1))"
echo "run it:  open '$APP'"
