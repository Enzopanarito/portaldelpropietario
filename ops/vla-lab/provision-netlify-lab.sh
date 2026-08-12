#!/usr/bin/env bash
set -euo pipefail

PROD_SITE_ID="74f4f122-352c-4a3b-aa6f-5937ab99f8d3"
LAB_NAME="vla-lab-enzopanarito-74f4f122"
LAB_STAGING_BASE_ID="appZhq8nVZ7lZ2k6K"
AUTH_TOKEN="${NETLIFY_AUTH_TOKEN_PRIMARY:-${NETLIFY_AUTH_TOKEN_FALLBACK:-}}"

if [ -z "$AUTH_TOKEN" ]; then
  echo 'Falta token Netlify; no se creó ni modificó ningún sitio.'
  exit 1
fi
echo "::add-mask::$AUTH_TOKEN"
export NETLIFY_AUTH_TOKEN="$AUTH_TOKEN"

echo '=== 1. Resolver o crear sitio LAB independiente ==='
search_json="$(netlify sites:search "$LAB_NAME" --json --auth "$AUTH_TOKEN" 2>/dev/null || printf '[]')"
lab_id="$(printf '%s' "$search_json" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{let j=[];try{j=JSON.parse(s)}catch{};if(!Array.isArray(j))j=j.sites||j.items||[];const n='vla-lab-enzopanarito-74f4f122';const hit=j.find(x=>x&&x.name===n);process.stdout.write(String(hit?.id||hit?.site_id||''))})")"
if [ -z "$lab_id" ]; then
  create_json="$(netlify sites:create --name "$LAB_NAME" --account-slug enzopanarito --disable-linking --json --auth "$AUTH_TOKEN")"
  lab_id="$(printf '%s' "$create_json" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.stdout.write(String(j.id||j.site_id||j.site?.id||''))})")"
fi
if [ -z "$lab_id" ]; then
  echo 'No se pudo resolver el ID del sitio LAB.'
  exit 1
fi
lab_url="https://${LAB_NAME}.netlify.app"
echo "LAB site: $LAB_NAME"

echo '=== 2. Clonar secretos internamente dentro de Netlify ==='
if ! netlify env:clone --from "$PROD_SITE_ID" --to "$lab_id" --force --auth "$AUTH_TOKEN" >/dev/null 2>&1; then
  echo 'Netlify no pudo clonar internamente las variables protegidas. LAB no será desplegado.'
  exit 1
fi
echo 'Variables clonadas sin imprimir valores.'

echo '=== 3. Neutralizar destinos externos del LAB ==='
setv(){ netlify env:set "$1" "$2" --context production --site "$lab_id" --auth "$AUTH_TOKEN" --force >/dev/null; }
sets(){ netlify env:set "$1" "$2" --context production --site "$lab_id" --auth "$AUTH_TOKEN" --force --secret >/dev/null; }
setv AIRTABLE_BASE_ID "$LAB_STAGING_BASE_ID"
setv VLA_DATA_ENVIRONMENT staging
setv VLA_LAB_MODE true
setv PUBLIC_BLOB_CACHE_ENABLED false
setv PUBLIC_BLOB_CACHE_MAX_AGE_MS 120000
setv VLA_WHATSAPP_CONTROL_URL 'disabled://vla-lab'
sets VLA_WHATSAPP_CONTROL_SECRET 'VLA_LAB_DISABLED'
setv MKJ_BASE_URL 'http://127.0.0.1:9'
setv MKJ_ORG_ID '0'
setv MKJ_ADMIN_EMAIL 'vla-lab-disabled@invalid.invalid'
sets MKJ_ADMIN_PASSWORD 'VLA_LAB_DISABLED'
setv SMTP_HOST '127.0.0.1'
setv SMTP_PORT '9'
setv SMTP_USER 'vla-lab-disabled@invalid.invalid'
sets SMTP_SECRET 'VLA_LAB_DISABLED'
setv MAIL_FROM 'vla-lab-disabled@invalid.invalid'
echo 'MKJ / WhatsApp / SMTP reales neutralizados.'

echo '=== 4. Convertir SOLO la copia de trabajo del TOML a contexto LAB ==='
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
if grep -A25 '^\[context.production.environment\]' netlify.toml | grep -q 'VLA_DATA_ENVIRONMENT = "production"'; then
  echo 'El contexto LAB conserva production; despliegue bloqueado.'
  exit 1
fi

echo '=== 5. Preflight y gates críticos ==='
export CONTEXT=dev
export VLA_LAB_MODE=true
export VLA_DATA_ENVIRONMENT=staging
export AIRTABLE_BASE_ID="$LAB_STAGING_BASE_ID"
node ops/vla-lab/preflight.js
node tests/payment-recipient-policy-v10.test.js
node tests/payment-duplicate-core.test.js
node tests/payment-prefill-attestation.test.js
node tests/payment-proof-prefill-v10-decision.test.js
node tests/payment-v10-routing-and-lab-guard.test.js

echo '=== 6. Build exacto LAB ==='
export CONTEXT=production
export PUBLIC_BLOB_CACHE_ENABLED=false
export PUBLIC_BLOB_CACHE_MAX_AGE_MS=120000
npm run build:public

echo '=== 7. Deploy SOLO al sitio LAB ==='
deploy_json="$(netlify deploy --prod --context production --no-build --dir dist --functions netlify/functions --site "$lab_id" --auth "$AUTH_TOKEN" --skip-functions-cache --message "VLA LAB ${GITHUB_SHA:-manual}" --json)"
deploy_url="$(printf '%s' "$deploy_json" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.stdout.write(String(j.url||j.deploy_url||j.deploy_ssl_url||''))})")"
[ -n "$deploy_url" ] || deploy_url="$lab_url"
echo "LAB deployed: $deploy_url"

echo '=== 8. Readiness: secretos presentes, staging 15/15 y 6/6 ==='
ready=''
for _ in $(seq 1 24); do
  if ready="$(curl --fail-with-body --silent --show-error "$deploy_url/.netlify/functions/lab-readiness" 2>/dev/null)"; then break; fi
  sleep 5
done
if [ -z "$ready" ]; then
  echo 'LAB no respondió readiness.'
  exit 1
fi
printf '%s' "$ready" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const ok=j.ready===true&&j.lab===true&&j.stagingBase===true&&j.airtableTokenAvailable===true&&j.geminiKeyAvailable===true&&j.airtableReachable===true&&j.houses===15&&j.authorizedRecipients===6&&j.externalWritesBlocked===true&&j.productionBaseAccessible===false;if(!ok){console.error(JSON.stringify(j));process.exit(1)}console.log('VLA_LAB_READINESS_OK 15/15 houses · 6/6 recipients · Gemini available · production blocked')})"
html="$(curl --fail-with-body --silent --show-error "$deploy_url/")"
printf '%s' "$html" | grep -q 'VLA LAB' || { echo 'Falta banner visible VLA LAB.'; exit 1; }

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo '### 🧪 VLA LAB READY'
    echo
    echo "- URL: $deploy_url"
    echo "- Site ID: $lab_id"
    echo '- Data: Airtable STAGING, 15 casas ficticias'
    echo '- Receptores autorizados LAB: 6/6'
    echo '- Gemini: disponible (valor secreto no expuesto)'
    echo '- MKJ / WhatsApp / SMTP reales: bloqueados'
    echo '- Producción VLA: NO desplegada'
  } >> "$GITHUB_STEP_SUMMARY"
fi

echo "VLA_LAB_URL=$deploy_url"
echo "VLA_LAB_SITE_ID=$lab_id"
