#!/usr/bin/env bash
set -euo pipefail

PROD_SITE_ID="74f4f122-352c-4a3b-aa6f-5937ab99f8d3"
LAB_PREFIX="vla-lab-enzopanarito-"
LAB_STAGING_BASE_ID="appZhq8nVZ7lZ2k6K"
NETLIFY_TEAM_SLUG="enzopanarito"
AUTH_TOKEN="${NETLIFY_AUTH_TOKEN_PRIMARY:-${NETLIFY_AUTH_TOKEN_FALLBACK:-}}"
STAGE="inicio"
trap 'echo "::error title=VLA LAB provisioning::Etapa ${STAGE} falló en la línea ${LINENO}. No se tocó producción VLA."' ERR

if [ -z "$AUTH_TOKEN" ]; then
  echo '::error title=VLA LAB provisioning::Falta token Netlify; no se creó ni modificó ningún sitio.'
  exit 1
fi
echo "::add-mask::$AUTH_TOKEN"
export NETLIFY_AUTH_TOKEN="$AUTH_TOKEN"

STAGE="resolver-sitio-lab"
echo '=== 1. Resolver o crear sitio LAB independiente ==='
sites_json="$(curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H 'User-Agent: VLA-LAB-GitHub-Actions' \
  'https://api.netlify.com/api/v1/sites?per_page=100')"
lab_record="$(printf '%s' "$sites_json" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const hits=(Array.isArray(j)?j:[]).filter(x=>x&&String(x.name||'').startsWith('vla-lab-enzopanarito-')).sort((a,b)=>Date.parse(b.updated_at||b.created_at||0)-Date.parse(a.updated_at||a.created_at||0));const h=hits[0]||{};process.stdout.write(JSON.stringify({id:h.id||'',name:h.name||'',url:h.ssl_url||h.url||''}))})")"
lab_id="$(printf '%s' "$lab_record" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).id")"
lab_name="$(printf '%s' "$lab_record" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).name")"
lab_url="$(printf '%s' "$lab_record" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).url")"

if [ -z "$lab_id" ]; then
  STAGE="crear-sitio-lab"
  tmp_body="$(mktemp)"
  status="$(curl --silent --show-error \
    -o "$tmp_body" -w '%{http_code}' \
    -X POST \
    -H "Authorization: Bearer $AUTH_TOKEN" \
    -H 'User-Agent: VLA-LAB-GitHub-Actions' \
    -H 'Content-Type: application/json' \
    --data '{}' \
    "https://api.netlify.com/api/v1/${NETLIFY_TEAM_SLUG}/sites")"
  if [ "$status" -lt 200 ] || [ "$status" -ge 300 ]; then
    safe_error="$(node -e "const fs=require('fs');let j={};try{j=JSON.parse(fs.readFileSync(process.argv[1],'utf8'))}catch{};process.stdout.write(String(j.message||j.error||'Netlify rechazó la creación').replace(/[\r\n]+/g,' ').slice(0,240))" "$tmp_body")"
    rm -f "$tmp_body"
    echo "::error title=VLA LAB provisioning::Netlify create site HTTP $status: $safe_error"
    exit 1
  fi
  create_json="$(cat "$tmp_body")"; rm -f "$tmp_body"
  lab_id="$(printf '%s' "$create_json" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.stdout.write(String(j.id||j.site_id||''))})")"
  lab_url="$(printf '%s' "$create_json" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.stdout.write(String(j.ssl_url||j.url||''))})")"
  [ -n "$lab_id" ] || { echo '::error title=VLA LAB provisioning::Netlify creó una respuesta sin Site ID.'; exit 1; }

  STAGE="nombrar-sitio-lab"
  lab_name="${LAB_PREFIX}${lab_id:0:8}"
  patch_body="$(mktemp)"
  patch_status="$(curl --silent --show-error -o "$patch_body" -w '%{http_code}' \
    -X PATCH \
    -H "Authorization: Bearer $AUTH_TOKEN" \
    -H 'User-Agent: VLA-LAB-GitHub-Actions' \
    -H 'Content-Type: application/json' \
    --data "{\"name\":\"$lab_name\",\"force_ssl\":true}" \
    "https://api.netlify.com/api/v1/sites/${lab_id}")"
  if [ "$patch_status" -ge 200 ] && [ "$patch_status" -lt 300 ]; then
    patched_json="$(cat "$patch_body")"
    patched_name="$(printf '%s' "$patched_json" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.stdout.write(String(j.name||''))})")"
    patched_url="$(printf '%s' "$patched_json" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.stdout.write(String(j.ssl_url||j.url||''))})")"
    [ -n "$patched_name" ] && lab_name="$patched_name"
    [ -n "$patched_url" ] && lab_url="$patched_url"
  else
    echo "::warning title=VLA LAB provisioning::El alias amigable no pudo asignarse (HTTP $patch_status); se conservará el URL único generado por Netlify."
  fi
  rm -f "$patch_body"
fi
if [ -z "$lab_id" ]; then
  echo '::error title=VLA LAB provisioning::No se pudo resolver el ID del sitio LAB.'
  exit 1
fi
[ -n "$lab_name" ] || lab_name="site-${lab_id:0:8}"
[ -n "$lab_url" ] || lab_url="https://${lab_name}.netlify.app"
echo "LAB site resuelto: $lab_name ($lab_id)"

STAGE="clonar-secretos"
echo '=== 2. Clonar secretos internamente dentro de Netlify ==='
if ! netlify env:clone --from "$PROD_SITE_ID" --to "$lab_id" --force --auth "$AUTH_TOKEN" >/dev/null 2>&1; then
  echo '::error title=VLA LAB provisioning::Netlify no pudo clonar internamente las variables protegidas. LAB no será desplegado.'
  exit 1
fi
echo 'Variables clonadas internamente sin imprimir valores.'

STAGE="neutralizar-destinos"
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

STAGE="parche-contexto-lab"
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
  echo '::error title=VLA LAB provisioning::El contexto LAB conserva production; despliegue bloqueado.'
  exit 1
fi

STAGE="preflight"
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

STAGE="build-lab"
echo '=== 6. Build exacto LAB ==='
export CONTEXT=production
export PUBLIC_BLOB_CACHE_ENABLED=false
export PUBLIC_BLOB_CACHE_MAX_AGE_MS=120000
npm run build:public

STAGE="deploy-lab"
echo '=== 7. Deploy SOLO al sitio LAB ==='
deploy_json="$(netlify deploy --prod --context production --no-build --dir dist --functions netlify/functions --site "$lab_id" --auth "$AUTH_TOKEN" --skip-functions-cache --message "VLA LAB ${GITHUB_SHA:-manual}" --json)"
deploy_url="$(printf '%s' "$deploy_json" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.stdout.write(String(j.url||j.deploy_url||j.deploy_ssl_url||''))})")"
[ -n "$deploy_url" ] || deploy_url="$lab_url"
echo "LAB deployed: $deploy_url"

STAGE="readiness"
echo '=== 8. Readiness: secretos presentes, staging 15/15 y 6/6 ==='
ready=''
for _ in $(seq 1 24); do
  if ready="$(curl --fail-with-body --silent --show-error "$deploy_url/.netlify/functions/lab-readiness" 2>/dev/null)"; then break; fi
  sleep 5
done
if [ -z "$ready" ]; then
  echo '::error title=VLA LAB provisioning::LAB no respondió readiness.'
  exit 1
fi
printf '%s' "$ready" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const ok=j.ready===true&&j.lab===true&&j.stagingBase===true&&j.airtableTokenAvailable===true&&j.geminiKeyAvailable===true&&j.airtableReachable===true&&j.houses===15&&j.authorizedRecipients===6&&j.externalWritesBlocked===true&&j.productionBaseAccessible===false;if(!ok){console.error(JSON.stringify(j));process.exit(1)}console.log('VLA_LAB_READINESS_OK 15/15 houses · 6/6 recipients · Gemini available · production blocked')})"
html="$(curl --fail-with-body --silent --show-error "$deploy_url/")"
printf '%s' "$html" | grep -q 'VLA LAB' || { echo '::error title=VLA LAB provisioning::Falta banner visible VLA LAB.'; exit 1; }

STAGE="publicar-coordenadas"
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
