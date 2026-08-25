#!/usr/bin/env bash
# Install Doohickey to /Applications and keep it running across logins.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="/Applications/Doohickey.app"
PLIST="$HOME/Library/LaunchAgents/local.agentbus.doohickey.plist"

[[ -d "$ROOT/Doohickey.app" ]] || { echo "build it first: $ROOT/build.sh" >&2; exit 1; }

pkill -f "Doohickey.app/Contents/MacOS/Doohickey" 2>/dev/null || true
rm -rf "$APP"
cp -R "$ROOT/Doohickey.app" "$APP"
codesign --force --sign - "$APP" >/dev/null 2>&1 || true

mkdir -p "$(dirname "$PLIST")"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>local.agentbus.doohickey</string>
  <key>ProgramArguments</key>
  <array><string>$APP/Contents/MacOS/Doohickey</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
PLISTEOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "installed $APP and loaded the LaunchAgent"
echo "remove with: launchctl unload '$PLIST' && rm '$PLIST'"
