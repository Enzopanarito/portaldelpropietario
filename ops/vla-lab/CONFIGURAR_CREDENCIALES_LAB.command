#!/bin/bash
set -euo pipefail

STAGING_BASE="appZhq8nVZ7lZ2k6K"
CONFIG_DIR="$HOME/.config/vla-lab"
SECRETS_FILE="$CONFIG_DIR/secrets.env"
TMP_FILE="$(mktemp /tmp/vla-lab-secrets.XXXXXX)"
trap 'rm -f "$TMP_FILE" 2>/dev/null || true' EXIT

mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"

printf '\n🔐 VLA LAB · CREDENCIALES EXCLUSIVAS DE PRUEBA\n'
printf '%s\n' '------------------------------------------------'
echo 'Estas claves quedan SOLO en esta Mac, fuera del repositorio y fuera de producción.'
echo 'Airtable debe autorizar únicamente la base STAGING de VLA.'
echo

read -r -s -p 'Pega el Personal Access Token de Airtable para STAGING: ' AIRTABLE_PAT
echo
[ -n "$AIRTABLE_PAT" ] || { echo 'ERROR: falta el token Airtable.'; exit 1; }

AIR_STATUS="$(curl -sS -o /tmp/vla-lab-airtable-check.json -w '%{http_code}' \
  -H "Authorization: Bearer $AIRTABLE_PAT" \
  "https://api.airtable.com/v0/${STAGING_BASE}/Propietarios?maxRecords=1" 2>/dev/null || true)"
if [ "$AIR_STATUS" != "200" ]; then
  echo "ERROR: Airtable rechazó el token de LAB (HTTP ${AIR_STATUS:-sin respuesta})."
  echo 'Comprueba que el PAT tenga data.records:read y data.records:write y que el recurso sea SOLO la base staging.'
  rm -f /tmp/vla-lab-airtable-check.json
  exit 1
fi
rm -f /tmp/vla-lab-airtable-check.json

echo 'Airtable STAGING: OK'

read -r -s -p 'Pega la API key de Gemini para pruebas: ' GEMINI_KEY
echo
[ -n "$GEMINI_KEY" ] || { echo 'ERROR: falta la API key de Gemini.'; exit 1; }

GEM_STATUS="$(curl -sS -o /tmp/vla-lab-gemini-check.json -w '%{http_code}' \
  "https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_KEY}" 2>/dev/null || true)"
if [ "$GEM_STATUS" != "200" ]; then
  echo "ERROR: Gemini rechazó la clave de LAB (HTTP ${GEM_STATUS:-sin respuesta})."
  rm -f /tmp/vla-lab-gemini-check.json
  exit 1
fi
rm -f /tmp/vla-lab-gemini-check.json

printf 'export AIRTABLE_API_TOKEN=%q\n' "$AIRTABLE_PAT" > "$TMP_FILE"
printf 'export GEMINI_API_KEY=%q\n' "$GEMINI_KEY" >> "$TMP_FILE"
printf 'export VLA_LAB_CREDENTIALS_VERSION=%q\n' '1' >> "$TMP_FILE"
chmod 600 "$TMP_FILE"
mv "$TMP_FILE" "$SECRETS_FILE"
chmod 600 "$SECRETS_FILE"

echo
echo '✅ Credenciales VLA LAB verificadas y guardadas localmente.'
echo "Archivo local protegido: $SECRETS_FILE"
echo 'No se modificó Netlify producción ni se guardó ninguna clave en GitHub.'
