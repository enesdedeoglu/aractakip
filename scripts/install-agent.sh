#!/bin/bash
# Yerel ajanı macOS oturum açılışında otomatik başlatır (launchd).
# Kaldırmak için: scripts/install-agent.sh --uninstall
set -euo pipefail
LABEL="com.aractakip.agent"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$HOME/.aractakip"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Ajan kaldırıldı."
  exit 0
fi

NODE="$(command -v node)"
GH_DIR="$(dirname "$(command -v gh 2>/dev/null || echo /usr/local/bin/gh)")"
PATH_VALUE="$(dirname "$NODE"):$GH_DIR:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$DIR/src/agent.js</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$PATH_VALUE</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>$HOME/.aractakip/agent.log</string>
  <key>StandardErrorPath</key><string>$HOME/.aractakip/agent.log</string>
</dict>
</plist>
PL

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Ajan kuruldu ve başlatıldı. Kayıtlar: ~/.aractakip/agent.log"
