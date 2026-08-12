#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
cd "$ROOT"

export VLA_LAB_MODE=true
export VLA_DATA_ENVIRONMENT=staging
export AIRTABLE_BASE_ID=appZhq8nVZ7lZ2k6K
export PUBLIC_BLOB_CACHE_ENABLED=false
export VLA_WHATSAPP_CONTROL_URL='disabled://vla-lab'
export VLA_WHATSAPP_CONTROL_SECRET='VLA_LAB_DISABLED'
export MKJ_BASE_URL='http://127.0.0.1:9'
export MKJ_ADMIN_EMAIL='VLA_LAB_DISABLED'
export MKJ_ADMIN_PASSWORD='VLA_LAB_DISABLED'
export SMTP_HOST=''
export SMTP_USER=''
export SMTP_SECRET=''
export MAIL_FROM=''
export BROWSER=none

node ops/vla-lab/preflight.js

if [ ! -d node_modules ]; then
  npm ci --ignore-scripts --no-audit --no-fund
fi
npm run build:public

if command -v netlify >/dev/null 2>&1; then
  NETLIFY=(netlify)
else
  NETLIFY=(npx --yes netlify-cli)
fi

LOG="/tmp/vla-lab-netlify.log"
PIDFILE="/tmp/vla-lab-netlify.pid"
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  kill "$(cat "$PIDFILE")" 2>/dev/null || true
  sleep 1
fi

"${NETLIFY[@]}" dev --context dev --port 8888 --dir dist --no-open >"$LOG" 2>&1 &
NETLIFY_PID=$!
echo "$NETLIFY_PID" > "$PIDFILE"
cleanup(){ kill "$NETLIFY_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

READY=0
for _ in $(seq 1 40); do
  if curl -fsS http://127.0.0.1:8888/ >/dev/null 2>&1; then READY=1; break; fi
  if ! kill -0 "$NETLIFY_PID" 2>/dev/null; then
    echo "VLA LAB no pudo iniciar. Últimas líneas del log:"
    tail -n 80 "$LOG" || true
    exit 1
  fi
  sleep 1
done
if [ "$READY" -ne 1 ]; then
  echo "VLA LAB no respondió en el puerto 8888."
  tail -n 80 "$LOG" || true
  exit 1
fi

echo
echo "=============================================="
echo "🧪 VLA LAB ESTÁ ACTIVO"
echo "Local: http://127.0.0.1:8888"
echo "Producción NO fue desplegada."
echo "Base de datos: STAGING"
echo "MKJ / WhatsApp / correo real: BLOQUEADOS"
echo "=============================================="
echo

start_ngrok_binary(){ ngrok http http://127.0.0.1:8888; }
start_ngrok_docker(){
  local token="${NGROK_AUTHTOKEN:-}"
  if [ -z "$token" ] && [ -f "$HOME/n8n/.env" ]; then
    token="$(grep -E '^NGROK_AUTHTOKEN=' "$HOME/n8n/.env" | tail -n 1 | cut -d= -f2- | tr -d '\r\n' || true)"
  fi
  if [ -z "$token" ]; then return 1; fi
  docker run --rm -it -e NGROK_AUTHTOKEN="$token" ngrok/ngrok:latest http http://host.docker.internal:8888
}

if command -v ngrok >/dev/null 2>&1; then
  echo "Abriendo túnel HTTPS con ngrok..."
  start_ngrok_binary
elif command -v docker >/dev/null 2>&1; then
  echo "No encontré ngrok instalado como comando; intentaré usar Docker sin mostrar tu token."
  if ! start_ngrok_docker; then
    echo "No encontré NGROK_AUTHTOKEN. El LAB sigue activo localmente en http://127.0.0.1:8888"
    echo "Log Netlify: $LOG"
    wait "$NETLIFY_PID"
  fi
else
  echo "Ngrok no está disponible. El LAB sigue activo localmente en http://127.0.0.1:8888"
  echo "Log Netlify: $LOG"
  wait "$NETLIFY_PID"
fi
