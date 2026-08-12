#!/bin/bash
set -euo pipefail

ROOT="$HOME/n8n"
COMPOSE_BASE="$ROOT/compose.yaml"
COMPOSE_AGENT="$ROOT/docker-compose.whatsapp.yml"
COMPOSE_CONTROL="$ROOT/docker-compose.whatsapp-control.yml"
AGENT_SOURCE="$ROOT/whatsapp-agent/server.js"
STATE="$ROOT/whatsapp-agent-data/state.json"
PROFILE="$ROOT/whatsapp-agent-data/profile"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$ROOT/backups/whatsapp-singleton-autorepair-$STAMP"
TMP_DIR="$(mktemp -d /tmp/vla-singleton.XXXXXX)"
PATCH_REF="89be61f496464696877454e0296e2b5dbd00a00c"
RAW_BASE="https://raw.githubusercontent.com/Enzopanarito/portaldelpropietario/$PATCH_REF/ops/whatsapp-control"
STATE_BEFORE=""
STATE_AFTER=""
APPLIED=0

cleanup() { rm -rf "$TMP_DIR" 2>/dev/null || true; }
trap cleanup EXIT

compose_cmd() {
  docker compose -f "$COMPOSE_BASE" -f "$COMPOSE_AGENT" -f "$COMPOSE_CONTROL" "$@"
}

rollback() {
  code=$?
  if [ "$code" -eq 0 ] || [ "$APPLIED" -ne 1 ]; then return "$code"; fi
  echo
  echo "❌ Falló el hardening. Restaurando archivos anteriores..."
  cp "$BACKUP_DIR/agent-server.js" "$AGENT_SOURCE" 2>/dev/null || true
  cp "$BACKUP_DIR/docker-compose.whatsapp.yml" "$COMPOSE_AGENT" 2>/dev/null || true
  compose_cmd build whatsapp-agent >/dev/null 2>&1 || true
  compose_cmd up -d --no-deps --force-recreate whatsapp-agent >/dev/null 2>&1 || true
  echo "Rollback ejecutado. No continúes con verificaciones hasta revisar el resultado."
  return "$code"
}
trap rollback ERR

for f in "$COMPOSE_BASE" "$COMPOSE_AGENT" "$COMPOSE_CONTROL" "$AGENT_SOURCE" "$STATE"; do
  [ -f "$f" ] || { echo "❌ Falta archivo requerido: $f"; exit 1; }
done
command -v docker >/dev/null 2>&1 || { echo "❌ Docker no está disponible."; exit 1; }
command -v node >/dev/null 2>&1 || { echo "❌ Node no está disponible."; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "❌ curl no está disponible."; exit 1; }

mkdir -p "$BACKUP_DIR"
cp "$AGENT_SOURCE" "$BACKUP_DIR/agent-server.js"
cp "$COMPOSE_AGENT" "$BACKUP_DIR/docker-compose.whatsapp.yml"
cp "$STATE" "$BACKUP_DIR/state.json"
mkdir -p "$BACKUP_DIR/singletons"
for f in "$PROFILE"/SingletonLock "$PROFILE"/SingletonSocket "$PROFILE"/SingletonCookie; do
  if [ -L "$f" ] || [ -e "$f" ]; then cp -a "$f" "$BACKUP_DIR/singletons/"; fi
done
STATE_BEFORE="$(shasum -a 256 "$STATE" | awk '{print $1}')"

echo "============================================================"
echo " VLA · SINGLETON AUTOREPAIR + PLAYWRIGHT INIT"
echo "============================================================"
echo "Backup: $BACKUP_DIR"
echo "state_sha_before=$STATE_BEFORE"
echo "No ejecuta /tick, warmup ni QR."
echo

AGENT_BEFORE="$(curl -fsS http://127.0.0.1:8787/health)"
CONTROLLER_BEFORE="$(curl -fsS http://127.0.0.1:8788/health)"
printf '%s' "$AGENT_BEFORE" | python3 -c '
import json,sys
j=json.load(sys.stdin)
assert j.get("ok") is True
assert j.get("mode")=="real"
assert str(j.get("version","")).startswith("1.3")
assert (j.get("capabilities") or {}).get("relink") is True
print("✅ Agente previo REAL con relink")
'
printf '%s' "$CONTROLLER_BEFORE" | python3 -c '
import json,sys
j=json.load(sys.stdin)
assert j.get("ok") is True
assert j.get("mode")=="automatic"
print("✅ Controller previo AUTOMÁTICO")
'

echo "Descargando patchers inmutables..."
curl -fsSL "$RAW_BASE/patch-agent-singleton-autorepair.cjs" -o "$TMP_DIR/patch-agent-singleton-autorepair.cjs"
curl -fsSL "$RAW_BASE/patch-whatsapp-compose-init.cjs" -o "$TMP_DIR/patch-whatsapp-compose-init.cjs"
node --check "$TMP_DIR/patch-agent-singleton-autorepair.cjs"
node --check "$TMP_DIR/patch-whatsapp-compose-init.cjs"

APPLIED=1
node "$TMP_DIR/patch-agent-singleton-autorepair.cjs" "$AGENT_SOURCE"
node "$TMP_DIR/patch-whatsapp-compose-init.cjs" "$COMPOSE_AGENT"
node --check "$AGENT_SOURCE"
grep -q 'VLA_SINGLETON_AUTOREPAIR_V1' "$AGENT_SOURCE"
grep -q 'VLA_PLAYWRIGHT_INIT_V1' "$COMPOSE_AGENT"
grep -q 'VLA_STARTUP_RECOVERY_OFF_V1' "$COMPOSE_AGENT"

echo "✅ Fuentes y Compose parcheados"

compose_cmd config --format json | python3 -c '
import json,sys
j=json.load(sys.stdin)
s=j["services"]["whatsapp-agent"]
assert s.get("init") is True
env=s.get("environment") or {}
assert str(env.get("WA_STARTUP_RECOVERY","")).lower()=="false"
print("✅ Compose: init=true y WA_STARTUP_RECOVERY=false")
'

echo "Construyendo y recreando SOLO whatsapp-agent..."
cd "$ROOT"
compose_cmd build whatsapp-agent
compose_cmd up -d --no-deps --force-recreate whatsapp-agent
sleep 10

AGENT_AFTER="$(curl -fsS http://127.0.0.1:8787/health)"
printf '%s' "$AGENT_AFTER" | python3 -c '
import json,sys
j=json.load(sys.stdin)
assert j.get("ok") is True
assert j.get("mode")=="real"
assert str(j.get("version","")).startswith("1.3.1")
assert (j.get("capabilities") or {}).get("relink") is True
print("✅ Agente 1.3.1 REAL con relink")
'

docker inspect vla-whatsapp-agent | python3 -c '
import json,sys
j=json.load(sys.stdin)[0]
env=dict(x.split("=",1) for x in j.get("Config",{}).get("Env",[]) if "=" in x)
assert j.get("HostConfig",{}).get("Init") is True
assert str(env.get("WA_STARTUP_RECOVERY","")).lower()=="false"
print("✅ Docker init=true y startup recovery desactivado")
'

docker exec vla-whatsapp-agent sh -lc "grep -q VLA_SINGLETON_AUTOREPAIR_V1 /app/server.js"

STATE_AFTER="$(shasum -a 256 "$STATE" | awk '{print $1}')"
echo "state_sha_after=$STATE_AFTER"
if [ "$STATE_BEFORE" != "$STATE_AFTER" ]; then
  echo "❌ state.json cambió durante el hardening."
  exit 1
fi

if docker logs --since 30s vla-whatsapp-agent 2>&1 | grep -q 'startup-recovery'; then
  echo "❌ Se detectó startup-recovery inesperado."
  exit 1
fi

APPLIED=0
echo
echo "============================================================"
echo " ✅ AUTORREPARACIÓN SINGLETON INSTALADA"
echo "============================================================"
echo "Agente: 1.3.1 REAL · init=true · state.json intacto"
echo "No se abrió Chromium. La próxima verificación reparará solo locks demostrablemente huérfanos."
