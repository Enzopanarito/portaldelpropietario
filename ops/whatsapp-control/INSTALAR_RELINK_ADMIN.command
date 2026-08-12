#!/bin/bash
set -euo pipefail

ROOT="$HOME/n8n"
COMPOSE_BASE="$ROOT/compose.yaml"
COMPOSE_AGENT="$ROOT/docker-compose.whatsapp.yml"
COMPOSE_CONTROL="$ROOT/docker-compose.whatsapp-control.yml"
AGENT_SOURCE="$ROOT/whatsapp-agent/server.js"
CONTROLLER_SOURCE="$ROOT/whatsapp-controller/controller.js"
STATE="$ROOT/whatsapp-agent-data/state.json"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$ROOT/backups/whatsapp-admin-relink-$STAMP"
TMP_DIR="$(mktemp -d /tmp/vla-relink.XXXXXX)"
OVERRIDE="$TMP_DIR/relink-override.yml"
PATCH_REF="a2866ae8a8c786a5b02e3a752d8c7c0c84bbbd45"
RAW_BASE="https://raw.githubusercontent.com/Enzopanarito/portaldelpropietario/$PATCH_REF/ops/whatsapp-control"
STATE_BEFORE=""
STATE_AFTER=""
APPLIED=0

cleanup() { rm -rf "$TMP_DIR" 2>/dev/null || true; }
trap cleanup EXIT

compose_cmd() {
  docker compose \
    -f "$COMPOSE_BASE" \
    -f "$COMPOSE_AGENT" \
    -f "$COMPOSE_CONTROL" \
    -f "$OVERRIDE" "$@"
}

rollback() {
  code=$?
  if [ "$code" -eq 0 ] || [ "$APPLIED" -ne 1 ]; then return "$code"; fi
  echo
  echo "❌ Falló la actualización. Restaurando automáticamente..."
  cp "$BACKUP_DIR/agent-server.js" "$AGENT_SOURCE" 2>/dev/null || true
  cp "$BACKUP_DIR/controller.js" "$CONTROLLER_SOURCE" 2>/dev/null || true
  compose_cmd build whatsapp-agent whatsapp-controller >/dev/null 2>&1 || true
  compose_cmd up -d --no-deps --force-recreate whatsapp-agent whatsapp-controller >/dev/null 2>&1 || true
  echo "Rollback ejecutado. Revisa los logs antes de continuar."
  return "$code"
}
trap rollback ERR

cat > "$OVERRIDE" <<'YAML'
services:
  whatsapp-agent:
    environment:
      WA_STARTUP_RECOVERY: "false"
YAML

echo "============================================================"
echo " VLA · INSTALAR RE-VINCULACIÓN WHATSAPP DESDE ADMIN"
echo "============================================================"
echo "No ejecuta /tick, no ejecuta warmup y no inicia un QR."
echo

for f in "$COMPOSE_BASE" "$COMPOSE_AGENT" "$COMPOSE_CONTROL" "$AGENT_SOURCE" "$CONTROLLER_SOURCE" "$STATE"; do
  if [ ! -f "$f" ]; then echo "❌ Falta archivo requerido: $f"; exit 1; fi
done
command -v docker >/dev/null 2>&1 || { echo "❌ Docker no está disponible."; exit 1; }
command -v node >/dev/null 2>&1 || { echo "❌ Node no está disponible."; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "❌ curl no está disponible."; exit 1; }

mkdir -p "$BACKUP_DIR"
cp "$AGENT_SOURCE" "$BACKUP_DIR/agent-server.js"
cp "$CONTROLLER_SOURCE" "$BACKUP_DIR/controller.js"
cp "$COMPOSE_BASE" "$BACKUP_DIR/compose.yaml"
cp "$COMPOSE_AGENT" "$BACKUP_DIR/docker-compose.whatsapp.yml"
cp "$COMPOSE_CONTROL" "$BACKUP_DIR/docker-compose.whatsapp-control.yml"
cp "$STATE" "$BACKUP_DIR/state.json"
if [ -d "$ROOT/whatsapp-controller-data" ]; then cp -R "$ROOT/whatsapp-controller-data" "$BACKUP_DIR/whatsapp-controller-data"; fi
STATE_BEFORE="$(shasum -a 256 "$STATE" | awk '{print $1}')"
echo "✅ Backup: $BACKUP_DIR"
echo "state_sha_before=$STATE_BEFORE"

AGENT_HEALTH="$(curl -fsS http://127.0.0.1:8787/health)"
CONTROLLER_HEALTH="$(curl -fsS http://127.0.0.1:8788/health)"
printf '%s' "$AGENT_HEALTH" | python3 -c 'import json,sys; j=json.load(sys.stdin); assert j.get("ok") is True; assert j.get("mode")=="real"; print("✅ Agente actual REAL")'
printf '%s' "$CONTROLLER_HEALTH" | python3 -c 'import json,sys; j=json.load(sys.stdin); assert j.get("ok") is True; assert j.get("mode")=="automatic"; print("✅ Controller actual AUTOMÁTICO")'

docker inspect vla-whatsapp-agent | python3 -c '
import json,sys
j=json.load(sys.stdin)[0]
env=dict(x.split("=",1) for x in j.get("Config",{}).get("Env",[]) if "=" in x)
assert str(env.get("WA_STARTUP_RECOVERY","")).lower()=="false"
print("✅ WA_STARTUP_RECOVERY=false antes del cambio")
'

compose_cmd config --format json | python3 -c '
import json,sys
j=json.load(sys.stdin)
env=j["services"]["whatsapp-agent"].get("environment") or {}
assert str(env.get("WA_STARTUP_RECOVERY","")).lower()=="false"
print("✅ Override seguro validado")
'

echo
echo "Descargando patchers inmutables..."
curl -fsSL "$RAW_BASE/patch-agent-relink.cjs" -o "$TMP_DIR/patch-agent-relink.cjs"
curl -fsSL "$RAW_BASE/patch-controller-relink.cjs" -o "$TMP_DIR/patch-controller-relink.cjs"
node --check "$TMP_DIR/patch-agent-relink.cjs"
node --check "$TMP_DIR/patch-controller-relink.cjs"

APPLIED=1
node "$TMP_DIR/patch-agent-relink.cjs" "$AGENT_SOURCE"
node "$TMP_DIR/patch-controller-relink.cjs" "$CONTROLLER_SOURCE"
node --check "$AGENT_SOURCE"
node --check "$CONTROLLER_SOURCE"
grep -q 'VLA_ADMIN_RELINK_V1' "$AGENT_SOURCE"
grep -q 'VLA_CONTROLLER_RELINK_V1' "$CONTROLLER_SOURCE"
echo "✅ Fuentes parcheadas y sintácticamente válidas"

echo
echo "Construyendo SOLO agente y controller..."
cd "$ROOT"
compose_cmd build whatsapp-agent whatsapp-controller
compose_cmd up -d --no-deps --force-recreate whatsapp-agent whatsapp-controller

sleep 12

AGENT_AFTER="$(curl -fsS http://127.0.0.1:8787/health)"
CONTROLLER_AFTER="$(curl -fsS http://127.0.0.1:8788/health)"
printf '%s' "$AGENT_AFTER" | python3 -c '
import json,sys
j=json.load(sys.stdin)
assert j.get("ok") is True
assert j.get("mode")=="real"
assert str(j.get("version","")).startswith("1.3")
assert (j.get("capabilities") or {}).get("relink") is True
print("✅ Agente 1.3 REAL con re-vinculación")
'
printf '%s' "$CONTROLLER_AFTER" | python3 -c '
import json,sys
j=json.load(sys.stdin)
assert j.get("ok") is True
assert j.get("mode")=="automatic"
assert str(j.get("version","")).startswith("1.3")
print("✅ Controller 1.3 AUTOMÁTICO")
'

docker inspect vla-whatsapp-agent | python3 -c '
import json,sys
j=json.load(sys.stdin)[0]
env=dict(x.split("=",1) for x in j.get("Config",{}).get("Env",[]) if "=" in x)
assert str(env.get("WA_STARTUP_RECOVERY","")).lower()=="false"
print("✅ WA_STARTUP_RECOVERY=false después del cambio")
'

docker exec vla-whatsapp-agent sh -lc "grep -q VLA_ADMIN_RELINK_V1 /app/server.js"
docker exec vla-whatsapp-controller sh -lc "grep -q VLA_CONTROLLER_RELINK_V1 /app/controller.js"

STATE_AFTER="$(shasum -a 256 "$STATE" | awk '{print $1}')"
echo "state_sha_after=$STATE_AFTER"
if [ "$STATE_BEFORE" != "$STATE_AFTER" ]; then
  echo "❌ state.json cambió durante la instalación."
  exit 1
fi

if docker logs --since 30s vla-whatsapp-agent 2>&1 | grep -q 'startup-recovery'; then
  echo "❌ Se detectó startup-recovery inesperado."
  exit 1
fi

APPLIED=0
echo
echo "============================================================"
echo " ✅ RE-VINCULACIÓN ADMIN INSTALADA SIN ENVIAR MENSAJES"
echo "============================================================"
echo "Agente: REAL · Controller: AUTOMÁTICO · state.json intacto"
echo "No se inició QR. El QR solo aparecerá cuando el Admin lo solicite."
