#!/bin/bash
set -e
cd "$(dirname "$0")"
DIR="$(pwd)"
PLIST="$HOME/Library/LaunchAgents/com.vla.whatsapp-agent.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.vla.whatsapp-agent</string>
<key>ProgramArguments</key><array><string>/bin/bash</string><string>$DIR/ejecutar_agente.sh</string></array>
<key>WorkingDirectory</key><string>$DIR</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>$DIR/agent_stdout.log</string>
<key>StandardErrorPath</key><string>$DIR/agent_stderr.log</string>
</dict></plist>
EOF
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "✅ Agente programado. Revisará órdenes automáticamente."
read -p "Presiona ENTER para cerrar..."
