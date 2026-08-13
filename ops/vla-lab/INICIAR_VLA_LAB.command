#!/bin/bash
set -euo pipefail

SITE_ID="74f4f122-352c-4a3b-aa6f-5937ab99f8d3"
STAGING_BASE="appZhq8nVZ7lZ2k6K"
LAB_BRANCH="agent/vla-payment-validation-lab-v10"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
cd "$ROOT"

LOG="/tmp/vla-lab-netlify.log"
PIDFILE="/tmp/vla-lab-netlify.pid"
READINESS_FILE="/tmp/vla-lab-readiness.json"
TOML_BACKUP="$(mktemp /tmp/vla-lab-netlify.toml.XXXXXX)"
NETLIFY_PID=""
NGROK_CONTAINER=""
RESTORED=0

restore_toml(){
  if [ "$RESTORED" -eq 0 ] && [ -f "$TOML_BACKUP" ]; then
    cp "$TOML_BACKUP" "$ROOT/netlify.toml" 2>/dev/null || true
    rm -f "$TOML_BACKUP" 2>/dev/null || true
    RESTORED=1
  fi
}
cleanup(){
  if [ -n "$NGROK_CONTAINER" ]; then docker rm -f "$NGROK_CONTAINER" >/dev/null 2>&1 || true; fi
  if [ -n "$NETLIFY_PID" ]; then kill "$NETLIFY_PID" 2>/dev/null || true; fi
  rm -f "$PIDFILE" "$READINESS_FILE" 2>/dev/null || true
  restore_toml
}
trap cleanup EXIT INT TERM HUP

cp netlify.toml "$TOML_BACKUP"

printf '\n🧪 VLA LAB · ARRANQUE SEGURO\n'
printf '%s\n' '----------------------------------------------'

if ! command -v git >/dev/null 2>&1; then
  echo "ERROR: Git no está disponible en esta Mac."
  exit 1
fi

CURRENT_BRANCH="$(git branch --show-current 2>/dev/null || true)"
if [ "$CURRENT_BRANCH" != "$LAB_BRANCH" ]; then
  echo "ERROR: este clon no está en la rama aislada del LAB."
  echo "Actual: ${CURRENT_BRANCH:-desconocida}"
  echo "Esperada: $LAB_BRANCH"
  exit 1
fi

if [ -n "$(git status --porcelain --untracked-files=no 2>/dev/null || true)" ]; then
  echo "ERROR: hay cambios locales en archivos versionados. El LAB no arrancará sobre una copia modificada."
  exit 1
fi

export VLA_LAB_MODE=true
export VLA_DATA_ENVIRONMENT=staging
export AIRTABLE_BASE_ID="$STAGING_BASE"
export PUBLIC_BLOB_CACHE_ENABLED=false
export PUBLIC_BLOB_CACHE_MAX_AGE_MS=120000
export VLA_WHATSAPP_CONTROL_URL='disabled://vla-lab'
export VLA_WHATSAPP_CONTROL_SECRET='VLA_LAB_DISABLED'
export MKJ_BASE_URL='http://127.0.0.1:9'
export MKJ_ORG_ID='0'
export MKJ_ADMIN_EMAIL='vla-lab-disabled@invalid.invalid'
export MKJ_ADMIN_PASSWORD='VLA_LAB_DISABLED'
export SMTP_HOST='127.0.0.1'
export SMTP_PORT='9'
export SMTP_USER='vla-lab-disabled@invalid.invalid'
export SMTP_SECRET='VLA_LAB_DISABLED'
export MAIL_FROM='vla-lab-disabled@invalid.invalid'
export BROWSER=none

node <<'NODE'
const fs=require('fs');
const file='netlify.toml';
let text=fs.readFileSync(file,'utf8');
const replacement=`[context.production.environment]
  PUBLIC_BLOB_CACHE_ENABLED = "false"
  PUBLIC_BLOB_CACHE_MAX_AGE_MS = "120000"
  VLA_DATA_ENVIRONMENT = "staging"
  VLA_LAB_MODE = "true"
  AIRTABLE_BASE_ID = "appZhq8nVZ7lZ2k6K"
  VLA_WHATSAPP_CONTROL_URL = "disabled://vla-lab"
  VLA_WHATSAPP_CONTROL_SECRET = "VLA_LAB_DISABLED"
  MKJ_BASE_URL = "http://127.0.0.1:9"
  MKJ_ORG_ID = "0"
  MKJ_ADMIN_EMAIL = "vla-lab-disabled@invalid.invalid"
  MKJ_ADMIN_PASSWORD = "VLA_LAB_DISABLED"
  SMTP_HOST = "127.0.0.1"
  SMTP_PORT = "9"
  SMTP_USER = "vla-lab-disabled@invalid.invalid"
  SMTP_SECRET = "VLA_LAB_DISABLED"
  MAIL_FROM = "vla-lab-disabled@invalid.invalid"
`;
const re=/\[context\.production\.environment\][\s\S]*?(?=\n\[context\.|\n\[functions|\n#|$)/;
if(!re.test(text))throw new Error('No se encontró context.production.environment.');
text=text.replace(re,replacement.trimEnd());
fs.writeFileSync(file,text);
NODE

if grep -A28 '^\[context.production.environment\]' netlify.toml | grep -q 'VLA_DATA_ENVIRONMENT = "production"'; then
  echo "ERROR: el contexto temporal del LAB todavía apunta a production. Abortado."
  exit 1
fi
if grep -A28 '^\[context.production.environment\]' netlify.toml | grep -q 'app4nE4ReGRi2SuP2'; then
  echo "ERROR: la base productiva apareció en el contexto temporal del LAB. Abortado."
  exit 1
fi

node ops/vla-lab/preflight.js

if [ ! -d node_modules ]; then
  echo "Instalando dependencias del clon LAB..."
  npm ci --ignore-scripts --no-audit --no-fund
fi

if command -v netlify >/dev/null 2>&1; then
  NETLIFY=(netlify)
else
  NETLIFY=(npx --yes netlify-cli@27.0.0)
fi

LOCAL_SITE=""
if [ -f .netlify/state.json ]; then
  LOCAL_SITE="$(node -e "try{const j=require('./.netlify/state.json');process.stdout.write(String(j.siteId||''))}catch{}" 2>/dev/null || true)"
fi
if [ "$LOCAL_SITE" != "$SITE_ID" ]; then
  echo "Enlazando el clon LAB a las variables protegidas de VLA (sin deploy)..."
  "${NETLIFY[@]}" link --id "$SITE_ID"
fi

if grep -A28 '^\[context.production.environment\]' netlify.toml | grep -q 'VLA_DATA_ENVIRONMENT = "production"'; then
  echo "ERROR: netlify link alteró el aislamiento del LAB. Abortado."
  exit 1
fi

npm run build:public

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  kill "$(cat "$PIDFILE")" 2>/dev/null || true
  sleep 1
fi

"${NETLIFY[@]}" dev --context production --port 8888 --dir dist --no-open >"$LOG" 2>&1 &
NETLIFY_PID=$!
echo "$NETLIFY_PID" > "$PIDFILE"

echo "Esperando readiness real del VLA LAB..."
READY_JSON=""
LAST_READINESS=""
for attempt in $(seq 1 60); do
  if ! kill -0 "$NETLIFY_PID" 2>/dev/null; then
    echo "ERROR: VLA LAB se detuvo al iniciar."
    tail -n 100 "$LOG" || true
    exit 1
  fi

  HTTP_STATUS="$(curl -sS -o "$READINESS_FILE" -w '%{http_code}' http://127.0.0.1:8888/.netlify/functions/lab-readiness 2>/dev/null || true)"
  if [ -s "$READINESS_FILE" ]; then LAST_READINESS="$(cat "$READINESS_FILE")"; fi

  if [ "$HTTP_STATUS" = "200" ] && [ -n "$LAST_READINESS" ]; then
    if printf '%s' "$LAST_READINESS" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.exit(j.ready===true&&j.lab===true&&j.stagingBase===true&&j.airtableTokenAvailable===true&&j.geminiKeyAvailable===true&&j.airtableReachable===true&&j.houses===15&&j.authorizedRecipients===6&&j.externalWritesBlocked===true&&j.productionBaseAccessible===false?0:1)}catch{process.exit(1)}})"; then
      READY_JSON="$LAST_READINESS"
      break
    fi
  fi

  if [ "$HTTP_STATUS" = "503" ] && [ -n "$LAST_READINESS" ]; then
    FATAL="$(printf '%s' "$LAST_READINESS" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(JSON.parse(s).fatal===true?'true':'false')}catch{process.stdout.write('false')}})" 2>/dev/null || echo false)"
    if [ "$FATAL" = "true" ]; then
      break
    fi
  fi

  if [ $((attempt % 10)) -eq 0 ]; then
    echo "  ...LAB todavía iniciando (${attempt}s); no se ha abierto ningún enlace externo."
  fi
  sleep 1
done

if [ -z "$READY_JSON" ]; then
  echo "ERROR: el LAB NO superó el readiness de aislamiento."
  echo "No se abrirá ningún enlace externo."
  if [ -n "$LAST_READINESS" ]; then
    echo
    echo "Diagnóstico seguro del readiness:"
    printf '%s' "$LAST_READINESS" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const out={blocker:j.blocker||null,reason:j.reason||null,airtableStatus:j.airtableStatus||null,airtableTable:j.airtableTable||null,stagingBase:j.stagingBase,airtableTokenAvailable:j.airtableTokenAvailable,geminiKeyAvailable:j.geminiKeyAvailable,airtableReachable:j.airtableReachable,houses:j.houses,authorizedRecipients:j.authorizedRecipients,externalWritesBlocked:j.externalWritesBlocked,externalWriteChecks:j.externalWriteChecks};console.log(JSON.stringify(out,null,2))}catch{console.log('No se pudo interpretar el diagnóstico JSON.')}})"
  fi
  echo
  echo "Últimas líneas de Netlify Dev:"
  tail -n 80 "$LOG" || true
  exit 1
fi

LOCAL_URL="http://127.0.0.1:8888"

printf '\n%s\n' '============================================================'
echo "🧪 VLA LAB VALIDADO Y ACTIVO"
echo "Commit: $(git rev-parse --short HEAD)"
echo "Local Mac mini: $LOCAL_URL"
echo "Readiness: 15/15 casas · 6/6 receptores · Gemini OK"
echo "Base: STAGING"
echo "Producción VLA: NO desplegada"
echo "MKJ / WhatsApp / correo real: BLOQUEADOS"
printf '%s\n\n' '============================================================'

NGROK_TOKEN="${NGROK_AUTHTOKEN:-}"
if [ -z "$NGROK_TOKEN" ] && [ -f "$HOME/n8n/.env" ]; then
  NGROK_TOKEN="$(grep -E '^NGROK_AUTHTOKEN=' "$HOME/n8n/.env" | tail -n 1 | cut -d= -f2- | tr -d '\r\n' || true)"
fi

if command -v docker >/dev/null 2>&1 && [ -n "$NGROK_TOKEN" ]; then
  NGROK_CONTAINER="vla-lab-ngrok-$$"
  docker rm -f "$NGROK_CONTAINER" >/dev/null 2>&1 || true
  if docker run --rm -d --name "$NGROK_CONTAINER" -p 4041:4040 -e NGROK_AUTHTOKEN="$NGROK_TOKEN" ngrok/ngrok:latest http http://host.docker.internal:8888 >/dev/null 2>&1; then
    PUBLIC_URL=""
    for _ in $(seq 1 20); do
      PUBLIC_URL="$(curl -fsS http://127.0.0.1:4041/api/tunnels 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const t=(j.tunnels||[]).find(x=>String(x.public_url||'').startsWith('https://'));process.stdout.write(String(t?.public_url||''))}catch{}})" || true)"
      [ -n "$PUBLIC_URL" ] && break
      sleep 1
    done
    if [ -n "$PUBLIC_URL" ]; then
      echo "🌐 LINK HTTPS VLA LAB: $PUBLIC_URL"
      echo "Ábrelo desde tu iPhone o cualquier navegador mientras esta ventana siga abierta."
    else
      echo "Ngrok arrancó pero no entregó URL externa. Revisa: http://127.0.0.1:4041"
    fi
  else
    NGROK_CONTAINER=""
    echo "No se pudo abrir un segundo túnel ngrok. El LAB sigue activo localmente en $LOCAL_URL"
  fi
else
  echo "No hay ngrok disponible para este LAB. Sigue activo localmente en $LOCAL_URL"
fi

printf '\n%s\n' 'Mantén esta ventana abierta mientras pruebas. Ctrl+C apaga el LAB y restaura el netlify.toml local.'
while kill -0 "$NETLIFY_PID" 2>/dev/null; do sleep 2; done
