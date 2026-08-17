#!/bin/bash
set -euo pipefail

ROOT="$HOME/n8n"
AGENT_DIR="$ROOT/whatsapp-agent"
CTRL_DIR="$ROOT/whatsapp-controller"
AGENT_DATA="$ROOT/whatsapp-agent-data"
CTRL_DATA="$ROOT/whatsapp-controller-data"

AGENT_SERVER="$AGENT_DIR/server.js"
AGENT_MESSAGE="$AGENT_DIR/lib/message.js"
CTRL_SERVER="$CTRL_DIR/controller.js"
STATE="$AGENT_DATA/state.json"
CONTROL="$CTRL_DATA/control.json"
RUNTIME="$CTRL_DATA/runtime.json"
COMPOSE_BASE="$ROOT/compose.yaml"
COMPOSE_AGENT="$ROOT/docker-compose.whatsapp.yml"
COMPOSE_CTRL="$ROOT/docker-compose.whatsapp-control.yml"
PUBLIC_URL="https://villalosapamates.netlify.app/api/vla/public-data?force=1"

STAMP="$(date +%Y%m%d-%H%M%S)"
OUTROOT="$HOME/Desktop"
[ -d "$OUTROOT" ] || OUTROOT="$HOME"
CAPTURE="$OUTROOT/VLA_WHATSAPP_RUNTIME_CAPTURE_$STAMP"
BUNDLE="$CAPTURE.tar.gz"
TMP="$(mktemp -d /tmp/vla-wa-runtime.XXXXXX)"

cleanup() { rm -rf "$TMP" 2>/dev/null || true; }
trap cleanup EXIT

sha256_file() { shasum -a 256 "$1" | awk '{print $1}'; }

redact_yaml() {
  python3 - "$1" "$2" <<'PY'
import re,sys
src,dst=sys.argv[1:3]
sensitive=re.compile(r'(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE.?KEY|API.?KEY|AUTH|COOKIE|SESSION)',re.I)
out=[]
for raw in open(src,encoding='utf-8',errors='replace'):
    line=raw.rstrip('\n')
    # YAML mapping: SECRET_NAME: value
    m=re.match(r'^(\s*)([^:#][^:]*?):(.*)$',line)
    if m and sensitive.search(m.group(2)):
        line=f'{m.group(1)}{m.group(2)}: "<REDACTED>"'
    # YAML/list/env: - SECRET_NAME=value
    m2=re.match(r'^(\s*-\s*)([^=\s]+)=(.*)$',line)
    if m2 and sensitive.search(m2.group(2)):
        line=f'{m2.group(1)}{m2.group(2)}=<REDACTED>'
    out.append(line)
open(dst,'w',encoding='utf-8').write('\n'.join(out)+'\n')
PY
}

echo "============================================================"
echo " VLA · AUDITAR RUNTIME WHATSAPP · SOLO LECTURA"
echo " CERO EJECUCIONES · CERO WARMUP · CERO MENSAJES · CERO RELINK"
echo "============================================================"
echo

for f in "$AGENT_SERVER" "$AGENT_MESSAGE" "$CTRL_SERVER" "$STATE" "$CONTROL" "$RUNTIME" "$COMPOSE_BASE" "$COMPOSE_AGENT" "$COMPOSE_CTRL"; do
  if [ ! -f "$f" ]; then
    echo "❌ Falta archivo requerido: $f"
    exit 1
  fi
done
for cmd in docker curl python3 shasum tar; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "❌ Falta comando requerido: $cmd"; exit 1; }
done

echo "1/9 · Gate estricto: Controller pausado y runtime inmóvil"
curl -fsS http://127.0.0.1:8788/health > "$TMP/controller-health.json"
curl -fsS http://127.0.0.1:8787/health > "$TMP/agent-health.json"
python3 - "$TMP/controller-health.json" "$TMP/agent-health.json" "$RUNTIME" <<'PY'
import json,sys
c=json.load(open(sys.argv[1])); a=json.load(open(sys.argv[2])); r=json.load(open(sys.argv[3]))
print('controller =',c.get('version'),c.get('mode'))
print('agent =',a.get('version'),a.get('mode'))
print('runInProgress =',bool(r.get('runInProgress')))
print('warmupInProgress =',bool(r.get('warmupInProgress')))
print('linkInProgress =',bool(r.get('linkInProgress')))
assert c.get('ok') is True,c
assert c.get('mode')=='paused','ABORTADO: Controller debe estar PAUSADO.'
assert a.get('ok') is True,a
assert a.get('mode')=='real','ABORTADO: Agent debe estar REAL.'
assert not r.get('runInProgress'),'ABORTADO: hay ejecución en curso.'
assert not r.get('warmupInProgress'),'ABORTADO: hay warmup en curso.'
assert not r.get('linkInProgress'),'ABORTADO: hay relink en curso.'
print('✅ Gate seguro')
PY

state_sha_before="$(sha256_file "$STATE")"
control_sha_before="$(sha256_file "$CONTROL")"
runtime_sha_before="$(sha256_file "$RUNTIME")"
echo "state_sha_before=$state_sha_before"
echo "control_sha_before=$control_sha_before"
echo "runtime_sha_before=$runtime_sha_before"

echo
echo "2/9 · Baseline financiero read-only"
curl -fsS "$PUBLIC_URL" > "$TMP/public-before.json"
python3 - "$TMP/public-before.json" > "$TMP/financial-before.txt" <<'PY'
import hashlib,json,sys
from decimal import Decimal
j=json.load(open(sys.argv[1])); owners=j.get('propietarios') or []
assert len(owners)==15,len(owners)
fields=['saldoUsd','saldoBsRef','totalPagadero','saldoNetoReferencial','saldoFavorUsd','saldoFavorBs','deudaVencidaUsd','deudaVencidaBs','mesCorrienteUsd','mesCorrienteBs']
rows=[]
for o in sorted(owners,key=lambda x:int(x['Casa'])):
    rows.append([int(o['Casa'])]+[str(Decimal(str(o.get(f) or 0))) for f in fields])
blob=json.dumps(rows,separators=(',',':'),ensure_ascii=False).encode()
print('houses=15')
print('financial_fields=150')
print('financial_sha256='+hashlib.sha256(blob).hexdigest())
PY
cat "$TMP/financial-before.txt"

echo
echo "3/9 · Capturar fuentes exactas sin secretos de estado"
mkdir -p "$CAPTURE/source" "$CAPTURE/metadata" "$CAPTURE/compose"
chmod 700 "$CAPTURE"
cp -p "$AGENT_SERVER" "$CAPTURE/source/agent-server.js"
cp -p "$AGENT_MESSAGE" "$CAPTURE/source/agent-message.js"
cp -p "$CTRL_SERVER" "$CAPTURE/source/controller.js"
[ -f "$AGENT_DIR/package.json" ] && cp -p "$AGENT_DIR/package.json" "$CAPTURE/source/agent-package.json" || true
[ -f "$CTRL_DIR/package.json" ] && cp -p "$CTRL_DIR/package.json" "$CAPTURE/source/controller-package.json" || true

{
  echo "agent-server.js $(sha256_file "$AGENT_SERVER")"
  echo "agent-message.js $(sha256_file "$AGENT_MESSAGE")"
  echo "controller.js $(sha256_file "$CTRL_SERVER")"
  [ -f "$AGENT_DIR/package.json" ] && echo "agent-package.json $(sha256_file "$AGENT_DIR/package.json")"
  [ -f "$CTRL_DIR/package.json" ] && echo "controller-package.json $(sha256_file "$CTRL_DIR/package.json")"
} > "$CAPTURE/metadata/source-sha256.txt"
cat "$CAPTURE/metadata/source-sha256.txt"

echo
echo "4/9 · Capturar Compose sanitizado"
redact_yaml "$COMPOSE_BASE" "$CAPTURE/compose/compose.base.redacted.yml"
redact_yaml "$COMPOSE_AGENT" "$CAPTURE/compose/compose.agent.redacted.yml"
redact_yaml "$COMPOSE_CTRL" "$CAPTURE/compose/compose.controller.redacted.yml"

RAW_EFFECTIVE="$TMP/effective-compose.raw.yml"
chmod 600 "$TMP"
(
  cd "$ROOT"
  docker compose -f "$COMPOSE_BASE" -f "$COMPOSE_AGENT" -f "$COMPOSE_CTRL" config > "$RAW_EFFECTIVE"
)
redact_yaml "$RAW_EFFECTIVE" "$CAPTURE/compose/effective-compose.redacted.yml"
rm -f "$RAW_EFFECTIVE"
sha256_file "$CAPTURE/compose/effective-compose.redacted.yml" > "$CAPTURE/metadata/effective-compose-redacted.sha256"

echo
echo "5/9 · Metadatos Docker y dependencias, sin valores de entorno"
python3 - "$CAPTURE/metadata/container-metadata.json" <<'PY'
import json,subprocess,sys
names=['vla-whatsapp-agent','vla-whatsapp-controller','n8n']
out={}
for name in names:
    try:
        raw=subprocess.check_output(['docker','inspect',name],text=True)
        item=json.loads(raw)[0]
        env=item.get('Config',{}).get('Env',[]) or []
        out[name]={
          'imageId':item.get('Image'),
          'imageName':item.get('Config',{}).get('Image'),
          'status':item.get('State',{}).get('Status'),
          'running':item.get('State',{}).get('Running'),
          'restartCount':item.get('RestartCount'),
          'startedAt':item.get('State',{}).get('StartedAt'),
          'envKeys':sorted({x.split('=',1)[0] for x in env if '=' in x})
        }
    except Exception as e:
        out[name]={'available':False,'errorType':type(e).__name__}
open(sys.argv[1],'w').write(json.dumps(out,indent=2,ensure_ascii=False)+'\n')
PY

{
  echo "agent_node=$(docker exec vla-whatsapp-agent node -p 'process.version' 2>/dev/null || echo unavailable)"
  echo "controller_node=$(docker exec vla-whatsapp-controller node -p 'process.version' 2>/dev/null || echo unavailable)"
  echo "playwright=$(docker exec vla-whatsapp-agent node -e \"try{console.log(require('playwright/package.json').version)}catch(e){console.log('unavailable')}\" 2>/dev/null || echo unavailable)"
  echo "agent_health=$(cat "$TMP/agent-health.json")"
  echo "controller_health=$(cat "$TMP/controller-health.json")"
} > "$CAPTURE/metadata/runtime-versions.txt"

docker exec vla-whatsapp-agent sh -lc 'find /ms-playwright -maxdepth 2 -mindepth 1 -type d -print 2>/dev/null | sort | head -n 100' \
  > "$CAPTURE/metadata/playwright-browsers.txt" 2>/dev/null || true

echo
echo "6/9 · Resumen sanitizado de estado persistente"
python3 - "$STATE" "$CONTROL" "$RUNTIME" "$CAPTURE/metadata/state-summary.json" <<'PY'
import json,sys
state=json.load(open(sys.argv[1])); control=json.load(open(sys.argv[2])); runtime=json.load(open(sys.argv[3]))
cycles=[]
for cid,c in sorted((state.get('cycles') or {}).items()):
    statuses={}
    for rec in (c.get('recipients') or {}).values():
        st=str(rec.get('status') or 'UNKNOWN')
        statuses[st]=statuses.get(st,0)+1
    cycles.append({
      'cycleId':cid,
      'recipientCount':len(c.get('recipients') or {}),
      'statuses':statuses,
      'completed':bool(c.get('completedAt')),
      'blocked':bool(c.get('blockedAt')),
      'superseded':bool(c.get('supersededAt'))
    })
out={
  'agentState':{'cycleCount':len(cycles),'cycles':cycles[-12:]},
  'control':{
    'version':control.get('version'),
    'mode':control.get('mode'),
    'schedules':control.get('schedules'),
    'warmupMinutes':control.get('warmupMinutes'),
    'updatedBy':control.get('updatedBy')
  },
  'runtime':{
    'lastWarmupAt':runtime.get('lastWarmupAt'),
    'lastRunAt':runtime.get('lastRunAt'),
    'lastResult':runtime.get('lastResult'),
    'runInProgress':bool(runtime.get('runInProgress')),
    'warmupInProgress':bool(runtime.get('warmupInProgress')),
    'linkInProgress':bool(runtime.get('linkInProgress')),
    'ledgerStatuses':{}
  }
}
for row in (runtime.get('ledger') or {}).values():
    if isinstance(row,dict):
        st=str(row.get('status') or 'UNKNOWN')
        out['runtime']['ledgerStatuses'][st]=out['runtime']['ledgerStatuses'].get(st,0)+1
open(sys.argv[4],'w').write(json.dumps(out,indent=2,ensure_ascii=False)+'\n')
PY

{
  echo "state.json $state_sha_before"
  echo "control.json $control_sha_before"
  echo "runtime.json $runtime_sha_before"
} > "$CAPTURE/metadata/persistent-state-sha256.txt"

echo
echo "7/9 · Certificar que la captura no movió el runtime"
state_sha_after="$(sha256_file "$STATE")"
control_sha_after="$(sha256_file "$CONTROL")"
runtime_sha_after="$(sha256_file "$RUNTIME")"
echo "state_sha_after=$state_sha_after"
echo "control_sha_after=$control_sha_after"
echo "runtime_sha_after=$runtime_sha_after"
test "$state_sha_before" = "$state_sha_after"
test "$control_sha_before" = "$control_sha_after"
test "$runtime_sha_before" = "$runtime_sha_after"

echo
echo "8/9 · Finanzas AFTER"
curl -fsS "$PUBLIC_URL" > "$TMP/public-after.json"
python3 - "$TMP/public-before.json" "$TMP/public-after.json" "$CAPTURE/metadata/financial-certification.txt" <<'PY'
import hashlib,json,sys
from decimal import Decimal
fields=['saldoUsd','saldoBsRef','totalPagadero','saldoNetoReferencial','saldoFavorUsd','saldoFavorBs','deudaVencidaUsd','deudaVencidaBs','mesCorrienteUsd','mesCorrienteBs']
def canon(path):
    j=json.load(open(path)); owners=j.get('propietarios') or []
    assert len(owners)==15,len(owners)
    rows=[]
    for o in sorted(owners,key=lambda x:int(x['Casa'])):
        rows.append([int(o['Casa'])]+[str(Decimal(str(o.get(f) or 0))) for f in fields])
    return rows
b=canon(sys.argv[1]); a=canon(sys.argv[2])
diff=[]
for br,ar in zip(b,a):
    if br!=ar: diff.append((br[0],br,ar))
assert not diff,diff[:3]
blob=json.dumps(a,separators=(',',':'),ensure_ascii=False).encode()
text='houses=15\nfinancial_fields=150\nfinancial_differences=0\nFINANCIAL_DELTA=$0.00\nfinancial_sha256='+hashlib.sha256(blob).hexdigest()+'\n'
open(sys.argv[3],'w').write(text)
print(text,end='')
PY

echo
echo "9/9 · Empaquetar evidencia"
cat > "$CAPTURE/README.txt" <<EOF
VLA WhatsApp Runtime Capture
Fecha UTC: $(date -u +%Y-%m-%dT%H:%M:%SZ)
Propósito: reconciliar GitHub con el runtime real del Mac mini.
Modo de captura: SOLO LECTURA.
No contiene state.json/control.json/runtime.json completos, perfil de WhatsApp, cookies, QR ni valores de secretos.
Controller requerido: PAUSADO.
Agent requerido: REAL.
EOF

tar -czf "$BUNDLE" -C "$(dirname "$CAPTURE")" "$(basename "$CAPTURE")"
BUNDLE_SHA="$(sha256_file "$BUNDLE")"
echo "$BUNDLE_SHA  $(basename "$BUNDLE")" > "$BUNDLE.sha256"

trap - EXIT
cleanup

echo
echo "============================================================"
echo " ✅ CAPTURA TERMINADA · RUNTIME INTACTO"
echo "============================================================"
echo "state/control/runtime: SIN CAMBIOS"
echo "finanzas: 150/150 · delta \$0.00"
echo "bundle: $BUNDLE"
echo "sha256: $BUNDLE_SHA"
echo
echo "Sube únicamente el archivo .tar.gz a ChatGPT para reconciliar las fuentes exactas."
