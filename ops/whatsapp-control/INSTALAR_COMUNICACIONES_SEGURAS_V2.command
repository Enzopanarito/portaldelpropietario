#!/bin/bash
set -euo pipefail

VLA_ROOT="$HOME/n8n"
COMPOSE_BASE="$VLA_ROOT/compose.yaml"
COMPOSE_AGENT="$VLA_ROOT/docker-compose.whatsapp.yml"
COMPOSE_CONTROL="$VLA_ROOT/docker-compose.whatsapp-control.yml"
AGENT_SOURCE="$VLA_ROOT/whatsapp-agent/server.js"
AGENT_BROADCAST="$VLA_ROOT/whatsapp-agent/lib/broadcast.js"
AGENT_MESSAGE="$VLA_ROOT/whatsapp-agent/lib/message.js"
CONTROLLER_SOURCE="$VLA_ROOT/whatsapp-controller/controller.js"
AGENT_STATE="$VLA_ROOT/whatsapp-agent-data/state.json"
CONTROLLER_DATA="$VLA_ROOT/whatsapp-controller-data"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$VLA_ROOT/backups/communications-preinstall-$STAMP"
TMP_DIR="$(mktemp -d /tmp/vla-communications.XXXXXX)"
RAW_REF="feature/vla-comunicaciones-seguras-20260906"
RAW_BASE="https://raw.githubusercontent.com/Enzopanarito/portaldelpropietario/$RAW_REF"

OLD_AGENT_SHA="7a6bd6a1d0bd6af1244ae57ab017101b114ca7183017aebf2fb3345925c7f050"
OLD_CONTROLLER_SHA="ce6fa2a322f9decdc2d533caec87ddb73082b97241ed5da6e0e8afcac22e9a42"
NEW_AGENT_SHA="fd2ffd692eb15a6f2329406461b16016fb94ff7d6f0ca92dd10bbc8d89abbc18"
NEW_BROADCAST_SHA="008c74342d2c8d796d88bb7d8dbfae7c29ebcdb2ec996998ae58db73c21b8201"
NEW_CONTROLLER_SHA="80265db7ffbe6c1338c9e95df921beeef940f340abb4428671d83f0ed0288a25"
PRESERVED_MESSAGE_SHA="021ecea597b23ecacace73baedb08d1171f4b318fae721dce486cb2762867f38"
APPLIED=0

cleanup() {
  case "$TMP_DIR" in /tmp/vla-communications.*) rm -rf "$TMP_DIR" ;; esac
}
trap cleanup EXIT

sha_file() { shasum -a 256 "$1" | awk '{print $1}'; }
sha_or_absent() { if [ -f "$1" ]; then sha_file "$1"; else printf '%s' ABSENT; fi; }
compose_cmd() {
  docker compose -f "$COMPOSE_BASE" -f "$COMPOSE_AGENT" -f "$COMPOSE_CONTROL" "$@"
}

rollback_on_error() {
  code=$?
  if [ "$code" -eq 0 ] || [ "$APPLIED" -ne 1 ]; then return "$code"; fi
  echo
  echo "❌ La verificación falló. Ejecutando restauración automática..."
  bash "$BACKUP_DIR/RESTAURAR_COMUNICACIONES.command" --automatic || true
  echo "La actualización quedó rechazada y se intentó restaurar el runtime anterior."
  return "$code"
}
trap rollback_on_error ERR

echo "============================================================"
echo " VLA · COMUNICACIONES MANUALES · INSTALACIÓN FAIL-CLOSED"
echo "============================================================"
echo "No ejecuta disparos manuales (/tick, warmup o QR)."
echo "Al finalizar, el modo automático continúa con sus horarios ya configurados."
echo "No modifica Compose, variables, perfil de WhatsApp ni credenciales."
echo

for file in "$COMPOSE_BASE" "$COMPOSE_AGENT" "$COMPOSE_CONTROL" "$AGENT_SOURCE" "$AGENT_MESSAGE" "$CONTROLLER_SOURCE" "$AGENT_STATE"; do
  [ -f "$file" ] || { echo "❌ Falta archivo requerido: $file"; exit 1; }
done
for command_name in docker curl node python3 shasum; do
  command -v "$command_name" >/dev/null 2>&1 || { echo "❌ Falta el comando: $command_name"; exit 1; }
done

AGENT_BEFORE_SHA="$(sha_file "$AGENT_SOURCE")"
CONTROLLER_BEFORE_SHA="$(sha_file "$CONTROLLER_SOURCE")"
MESSAGE_BEFORE_SHA="$(sha_file "$AGENT_MESSAGE")"
if [ "$MESSAGE_BEFORE_SHA" != "$PRESERVED_MESSAGE_SHA" ]; then
  echo "❌ La plantilla financiera automática no coincide con la versión preservada."
  echo "message_sha=$MESSAGE_BEFORE_SHA"
  echo "Se detiene sin modificar nada."
  exit 1
fi
if [ "$AGENT_BEFORE_SHA" = "$NEW_AGENT_SHA" ] && [ "$CONTROLLER_BEFORE_SHA" = "$NEW_CONTROLLER_SHA" ] && [ -f "$AGENT_BROADCAST" ] && [ "$(sha_file "$AGENT_BROADCAST")" = "$NEW_BROADCAST_SHA" ]; then
  echo "✅ Las fuentes 1.4.1 ya están instaladas. No se realizó ningún cambio."
  exit 0
fi
if [ "$AGENT_BEFORE_SHA" != "$OLD_AGENT_SHA" ] || [ "$CONTROLLER_BEFORE_SHA" != "$OLD_CONTROLLER_SHA" ]; then
  echo "❌ El runtime local no coincide con la versión certificada de partida."
  echo "agent_sha=$AGENT_BEFORE_SHA"
  echo "controller_sha=$CONTROLLER_BEFORE_SHA"
  echo "Se detiene sin modificar nada."
  exit 1
fi

AGENT_HEALTH="$(curl -fsS http://127.0.0.1:8787/health)"
CONTROLLER_HEALTH="$(curl -fsS http://127.0.0.1:8788/health)"
printf '%s' "$AGENT_HEALTH" | python3 -c '
import json,sys
j=json.load(sys.stdin)
assert j.get("ok") is True and j.get("mode")=="real" and j.get("version")=="1.3.6"
assert (j.get("capabilities") or {}).get("financialRevisionV136") is True
print("✅ Agente de partida: 1.3.6 REAL · revisión financiera preservada")
'
printf '%s' "$CONTROLLER_HEALTH" | python3 -c '
import json,sys
j=json.load(sys.stdin)
assert j.get("ok") is True and j.get("mode")=="automatic" and j.get("version")=="1.3.5"
print("✅ Controller de partida: 1.3.5 AUTOMÁTICO")
'

mkdir -p "$BACKUP_DIR/controller-data"
cp -p "$AGENT_SOURCE" "$BACKUP_DIR/agent-server.js"
cp -p "$AGENT_MESSAGE" "$BACKUP_DIR/agent-message.js"
cp -p "$CONTROLLER_SOURCE" "$BACKUP_DIR/controller.js"
cp -p "$AGENT_STATE" "$BACKUP_DIR/agent-state.json"
if [ -f "$AGENT_BROADCAST" ]; then cp -p "$AGENT_BROADCAST" "$BACKUP_DIR/broadcast.js"; else touch "$BACKUP_DIR/broadcast-was-absent"; fi
for name in control.json runtime.json audit.ndjson; do
  if [ -f "$CONTROLLER_DATA/$name" ]; then cp -p "$CONTROLLER_DATA/$name" "$BACKUP_DIR/controller-data/$name"; else touch "$BACKUP_DIR/controller-data/$name.was-absent"; fi
done
cp -p "$COMPOSE_BASE" "$BACKUP_DIR/compose.yaml"
cp -p "$COMPOSE_AGENT" "$BACKUP_DIR/docker-compose.whatsapp.yml"
cp -p "$COMPOSE_CONTROL" "$BACKUP_DIR/docker-compose.whatsapp-control.yml"

cat > "$BACKUP_DIR/RESTAURAR_COMUNICACIONES.command" <<'ROLLBACK'
#!/bin/bash
set -euo pipefail
BACKUP_DIR="$(cd "$(dirname "$0")" && pwd)"
VLA_ROOT="$HOME/n8n"
COMPOSE_BASE="$VLA_ROOT/compose.yaml"
COMPOSE_AGENT="$VLA_ROOT/docker-compose.whatsapp.yml"
COMPOSE_CONTROL="$VLA_ROOT/docker-compose.whatsapp-control.yml"
compose_cmd() { docker compose -f "$COMPOSE_BASE" -f "$COMPOSE_AGENT" -f "$COMPOSE_CONTROL" "$@"; }
sha_file() { shasum -a 256 "$1" | awk '{print $1}'; }
if [ "${1:-}" != "--automatic" ]; then
  echo "Restaurará exclusivamente Agent, Controller y sus estados desde:"
  echo "$BACKUP_DIR"
  read -r -p "Escriba RESTAURAR para continuar: " answer
  [ "$answer" = "RESTAURAR" ] || { echo "Cancelado."; exit 1; }
fi
python3 - "$BACKUP_DIR" <<'PY'
import hashlib,pathlib,sys
root=pathlib.Path(sys.argv[1]).resolve()
manifest=root/'SHA256SUMS.txt'
assert manifest.is_file(), 'Falta SHA256SUMS.txt'
for line in manifest.read_text(encoding='utf-8').splitlines():
    digest, rel = line.split('  ', 1)
    path=(root/rel).resolve()
    assert root == path.parent or root in path.parents, f'Ruta inválida: {rel}'
    assert path.is_file(), f'Falta respaldo: {rel}'
    assert hashlib.sha256(path.read_bytes()).hexdigest() == digest, f'Firma inválida: {rel}'
print('✅ Integridad del respaldo verificada antes de restaurar')
PY
compose_cmd stop whatsapp-agent whatsapp-controller
cp -p "$BACKUP_DIR/agent-server.js" "$VLA_ROOT/whatsapp-agent/server.js"
cp -p "$BACKUP_DIR/agent-message.js" "$VLA_ROOT/whatsapp-agent/lib/message.js"
cp -p "$BACKUP_DIR/controller.js" "$VLA_ROOT/whatsapp-controller/controller.js"
cp -p "$BACKUP_DIR/agent-state.json" "$VLA_ROOT/whatsapp-agent-data/state.json"
if [ -f "$BACKUP_DIR/broadcast-was-absent" ]; then rm -f "$VLA_ROOT/whatsapp-agent/lib/broadcast.js"; else cp -p "$BACKUP_DIR/broadcast.js" "$VLA_ROOT/whatsapp-agent/lib/broadcast.js"; fi
for name in control.json runtime.json audit.ndjson; do
  if [ -f "$BACKUP_DIR/controller-data/$name.was-absent" ]; then rm -f "$VLA_ROOT/whatsapp-controller-data/$name"; else cp -p "$BACKUP_DIR/controller-data/$name" "$VLA_ROOT/whatsapp-controller-data/$name"; fi
done
compose_cmd build whatsapp-agent whatsapp-controller
compose_cmd up -d --no-deps --force-recreate whatsapp-agent whatsapp-controller
for attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8787/health >/dev/null 2>&1 && curl -fsS http://127.0.0.1:8788/health >/dev/null 2>&1; then break; fi
  sleep 2
done
[ "$(sha_file "$VLA_ROOT/whatsapp-agent/server.js")" = "$(sha_file "$BACKUP_DIR/agent-server.js")" ]
[ "$(sha_file "$VLA_ROOT/whatsapp-agent/lib/message.js")" = "$(sha_file "$BACKUP_DIR/agent-message.js")" ]
[ "$(sha_file "$VLA_ROOT/whatsapp-controller/controller.js")" = "$(sha_file "$BACKUP_DIR/controller.js")" ]
curl -fsS http://127.0.0.1:8787/health | python3 -c 'import json,sys; j=json.load(sys.stdin); assert j.get("ok") is True and j.get("mode")=="real" and j.get("version")=="1.3.6"'
curl -fsS http://127.0.0.1:8788/health | python3 -c 'import json,sys; j=json.load(sys.stdin); assert j.get("ok") is True and j.get("mode")=="automatic" and j.get("version")=="1.3.5"'
echo "✅ Runtime 1.3.6/1.3.5 y estados anteriores restaurados y verificados."
ROLLBACK
chmod 700 "$BACKUP_DIR/RESTAURAR_COMUNICACIONES.command"

python3 - "$BACKUP_DIR" <<'PY'
import hashlib,pathlib,sys
root=pathlib.Path(sys.argv[1])
lines=[]
for path in sorted(p for p in root.rglob('*') if p.is_file() and p.name!='SHA256SUMS.txt'):
    lines.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.relative_to(root)}")
(root/'SHA256SUMS.txt').write_text('\n'.join(lines)+'\n', encoding='utf-8')
PY
python3 - "$BACKUP_DIR" <<'PY'
import hashlib,pathlib,sys
root=pathlib.Path(sys.argv[1]).resolve()
for line in (root/'SHA256SUMS.txt').read_text(encoding='utf-8').splitlines():
    digest, rel = line.split('  ', 1)
    path=(root/rel).resolve()
    assert root == path.parent or root in path.parents, f'Ruta inválida: {rel}'
    assert path.is_file(), f'Falta respaldo: {rel}'
    assert hashlib.sha256(path.read_bytes()).hexdigest() == digest, f'Firma inválida: {rel}'
print('✅ Respaldo funcional creado y verificado byte por byte')
PY
echo "Ubicación del respaldo: $BACKUP_DIR"

curl -fsSL "$RAW_BASE/ops/whatsapp-runtime/agent/server.js" -o "$TMP_DIR/server.js"
curl -fsSL "$RAW_BASE/ops/whatsapp-runtime/agent/lib/broadcast.js" -o "$TMP_DIR/broadcast.js"
curl -fsSL "$RAW_BASE/ops/whatsapp-control/controller.js" -o "$TMP_DIR/controller.js"
[ "$(sha_file "$TMP_DIR/server.js")" = "$NEW_AGENT_SHA" ] || { echo "❌ Hash incorrecto para Agent."; exit 1; }
[ "$(sha_file "$TMP_DIR/broadcast.js")" = "$NEW_BROADCAST_SHA" ] || { echo "❌ Hash incorrecto para Broadcast."; exit 1; }
[ "$(sha_file "$TMP_DIR/controller.js")" = "$NEW_CONTROLLER_SHA" ] || { echo "❌ Hash incorrecto para Controller."; exit 1; }
node --check "$TMP_DIR/server.js"
node --check "$TMP_DIR/broadcast.js"
node --check "$TMP_DIR/controller.js"

STATE_BEFORE_SHA="$(sha_file "$AGENT_STATE")"
CONTROL_BEFORE_SHA="$(sha_or_absent "$CONTROLLER_DATA/control.json")"
APPLIED=1
mkdir -p "$(dirname "$AGENT_BROADCAST")"
cp -p "$TMP_DIR/server.js" "$AGENT_SOURCE"
cp -p "$TMP_DIR/broadcast.js" "$AGENT_BROADCAST"
cp -p "$TMP_DIR/controller.js" "$CONTROLLER_SOURCE"

cd "$VLA_ROOT"
compose_cmd build whatsapp-agent whatsapp-controller
compose_cmd up -d --no-deps --force-recreate whatsapp-agent whatsapp-controller
sleep 12

AGENT_AFTER="$(curl -fsS http://127.0.0.1:8787/health)"
CONTROLLER_AFTER="$(curl -fsS http://127.0.0.1:8788/health)"
printf '%s' "$AGENT_AFTER" | python3 -c '
import json,sys
j=json.load(sys.stdin)
assert j.get("ok") is True and j.get("mode")=="real" and j.get("version")=="1.4.1"
assert (j.get("capabilities") or {}).get("informationalBroadcastV1") is True
assert (j.get("capabilities") or {}).get("financialRevisionV136") is True
print("✅ Agente 1.4.1 REAL; canal informativo y revisión financiera disponibles")
'
printf '%s' "$CONTROLLER_AFTER" | python3 -c '
import json,sys
j=json.load(sys.stdin)
assert j.get("ok") is True and j.get("mode")=="automatic" and j.get("version")=="1.4.1"
print("✅ Controller 1.4.1 AUTOMÁTICO")
'
python3 - "$CONTROLLER_DATA/runtime.json" <<'PY'
import json,sys
j=json.load(open(sys.argv[1], encoding='utf-8'))
assert j.get('broadcastInProgress') is False
assert not j.get('broadcastJobId')
print('✅ Ninguna difusión fue iniciada durante la instalación')
PY

[ "$(sha_file "$AGENT_STATE")" = "$STATE_BEFORE_SHA" ] || { echo "❌ state.json cambió durante la instalación."; exit 1; }
[ "$(sha_or_absent "$CONTROLLER_DATA/control.json")" = "$CONTROL_BEFORE_SHA" ] || { echo "❌ control.json cambió durante la instalación."; exit 1; }
[ "$(sha_file "$AGENT_MESSAGE")" = "$MESSAGE_BEFORE_SHA" ] || { echo "❌ La plantilla financiera automática cambió durante la instalación."; exit 1; }
if docker logs --since 40s vla-whatsapp-agent 2>&1 | grep -q 'startup-recovery'; then
  echo "❌ Se detectó startup-recovery inesperado."
  exit 1
fi

APPLIED=0
echo
echo "============================================================"
echo " ✅ COMUNICACIONES 1.4.1 INSTALADAS SIN DISPAROS MANUALES"
echo "============================================================"
echo "Automatización: AUTOMÁTICA · estado financiero: intacto"
echo "Respaldo y restaurador: $BACKUP_DIR"
