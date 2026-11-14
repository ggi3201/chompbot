#!/bin/sh
# Installs the Shortcut signer on the user's Mac as a launchd agent, listening on its Tailscale IP.
# Run again to update. Then put the printed URL and the token in Chomp under Settings:
#   SHORTCUT_SIGNER_URL and SHORTCUT_SIGNER_TOKEN. To copy the token: pbcopy < ~/.local/share/shortcut-signer/token
# To remove: launchctl bootout gui/$(id -u)/com.local.shortcut-signer, then delete the plist and the folder.
set -eu

ip=${1:?Usage: install.sh <tailscale-ip> [port]}
port=${2:-8472}
home_dir="$HOME/.local/share/shortcut-signer"
plist="$HOME/Library/LaunchAgents/com.local.shortcut-signer.plist"

mkdir -p "$home_dir"
cp "$(dirname "$0")/server.py" "$home_dir/server.py"
[ -f "$home_dir/token" ] || (umask 077 && openssl rand -hex 32 > "$home_dir/token")

cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.local.shortcut-signer</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>$home_dir/server.py</string>
    <string>$ip</string>
    <string>$port</string>
    <string>$home_dir/token</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/shortcut-signer.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/shortcut-signer.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/com.local.shortcut-signer" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "SHORTCUT_SIGNER_URL=http://$ip:$port"
